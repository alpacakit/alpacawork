import { isDeepStrictEqual } from 'node:util';
import { directionWording, isNotice, reviewInvalidatedBy, isReviewMark } from '@alpacawork/contract';
import { carrierOf, compareRunIds, type ReadRunRecord } from '@alpacawork/contract/run';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { PLACED_AS, TAKEN, TRIGGERS, isRequestLog, type ActionReason, type ControlTask, type PlacedReason,
  type TakenReason, type TaskActor, type TaskLog, type TaskValues, type TriggerReason } from '@alpacawork/raw';
import type { RunTransaction } from '@alpacawork/runs';
import type { DatabaseSync } from 'node:sqlite';
import { awaitsClosure, closureOf, returnFacts, returnIdOf } from './return-rules.js';
import { readFieldCatalog } from './task-values-store.js';

export type DecisionOptions = { taken?: TakenReason['code']; cause?: NonNullable<TakenReason['cause']>;
  aspects?: TakenReason['aspects']; causeNote?: string };
export type PlacementOptions = { placedAs?: PlacedReason['code']; placedNote?: string };
export type DirectionOptions = { trigger?: TriggerReason['code']; triggerNote?: string };

function required(option: string, choices: readonly string[], subject?: { request: string; run: string }): never {
  const flag = option.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
  const message = `Choose --${flag} ${choices.join('|')}` + (subject ? ` for request ${subject.request} (Run ${subject.run})` : '');
  throw new Problem(PROBLEM_CODE.invalidInput, message, subject,
    { reason: { kind: 'reason_required', flag: `--${flag}`, choices: choices.join('|') }, issues: [{ path: option, code: 'required', message }] });
}

const requiresActionReason = (actor: TaskActor) => actor.kind !== 'human';

/** Whether a write gives its launch values with `--ai-stack` or `--selected`; without either they come from the configured AI order. */
export const givesLaunchValues = (input: { selected?: unknown; aiStack?: unknown }) =>
  input.selected !== undefined || input.aiStack !== undefined;

/**
 * Why an AI actor launches the AI it does: `default` when the write gives no launch values, any other code when it gives
 * them. `given` is left out where the write carries no launch values to match (a handover keeps the placement's AI);
 * `asked` says whether an AI actor must say why.
 */
export function placementReason(input: PlacementOptions, actor: TaskActor, { given, asked }: { given?: boolean; asked: boolean }):
  PlacedReason | undefined {
  if (asked && requiresActionReason(actor) && input.placedAs === undefined) required('placedAs', PLACED_AS);
  if (input.placedAs === undefined) return undefined;
  if (input.placedAs === 'default' && given === true)
    throw new Problem(PROBLEM_CODE.invalidInput, '--placed-as default goes with neither --ai-stack nor --selected', undefined,
      { reason: { kind: 'placement_default_names_an_ai' } });
  if (input.placedAs !== 'default' && given === false)
    throw new Problem(PROBLEM_CODE.invalidInput,
      `--placed-as ${input.placedAs} describes a model or effort given with --ai-stack or --selected`, undefined,
      { reason: { kind: 'placement_reason_needs_selection' } });
  return { code: input.placedAs, ...(input.placedNote === undefined ? {} : { note: input.placedNote }) };
}

/** One definition of a direction rewrite, for deciding at the write and reading recorded value versions. */
export function directionChanged(field: { id: string; direction?: boolean }, before: unknown, after: unknown): boolean {
  return !!field.direction && before != null &&
    !isDeepStrictEqual(directionWording(field.id, before), directionWording(field.id, after));
}

export function directionReason(db: DatabaseSync, task: ControlTask, next: TaskValues | undefined,
  input: DirectionOptions, actor: TaskActor): TriggerReason | undefined {
  const fields = next === undefined ? [] : [...readFieldCatalog(db).values()]
    .filter(field => directionChanged(field, task.values[field.id], next[field.id])).map(field => field.id);
  if (!fields.length) return undefined;
  const code = actor.kind === 'main' && actor.quote ? 'instruction' : input.trigger;
  if (code === undefined && requiresActionReason(actor)) required('trigger', TRIGGERS);
  return code === undefined ? undefined : { code, fields, ...(input.triggerNote === undefined ? {} : { note: input.triggerNote }) };
}

type LastResult = { request: string; run: string; outcome: NonNullable<ReturnType<typeof closureOf>>['outcome'] };
/** Find the latest closed instruction from the same requesting task or user. A handover changes the holder, not the seat. */
export function priorResult(runs: Pick<RunTransaction, 'get' | 'getRequest' | 'getReturn' | 'conversationRuns'>, task: ControlTask,
  placementId: string, actor: TaskActor, requesterTask: string | null, reviewRun?: string | null): LastResult | undefined {
  const history = runs.conversationRuns(placementId).sort((a, b) => compareRunIds(b, a));
  const facts = returnFacts([{ ...task.meta, responsible: true }], history);
  const judged = new Set(task.meta.log.flatMap(entry => entry.reason?.taken?.of ? [entry.reason.taken.of] : []));
  const reviewed = reviewRun ? runs.get(reviewRun) : null;
  const seen = new Set<string>();
  for (const run of history) {
    if (seen.has(run.requestId) || reviewed && compareRunIds(run, reviewed) > 0) continue;
    seen.add(run.requestId);
    const request = runs.getRequest(run.requestId);
    if (!request || !awaitsClosure(request) || request.answersQuestion) continue;
    const caller = run.caller === null ? null : runs.get(run.caller.run);
    if (actor.kind === 'placement'
      ? request.author.kind !== 'placement' || !caller || caller.task !== requesterTask
      : request.author.kind === 'placement') continue;
    const stored = runs.getReturn(returnIdOf({ requestId: request.id }));
    const outcome = reviewed ? 'succeeded' : stored && !isNotice(stored.outcome) ? stored.outcome : closureOf(request, facts)?.outcome;
    if (outcome) return judged.has(request.id) ? undefined : { request: request.id, run: run.id, outcome };
  }
  return undefined;
}

export function resultDecision(input: DecisionOptions, actor: TaskActor, result?: LastResult, mustDecide = true): TakenReason | undefined {
  if (input.taken === undefined) {
    if (mustDecide && requiresActionReason(actor) && (result?.outcome === 'succeeded' || result?.outcome === 'needs_review'))
      required('taken', TAKEN, { request: result.request, run: result.run });
    return undefined;
  }
  if (!result) return undefined;
  return { code: input.taken, cause: input.cause ?? null, aspects: input.aspects ?? [],
    of: result.request, ...(input.causeNote === undefined ? {} : { note: input.causeNote }) };
}

/** Approvals and their subject Runs, as recorded or identified by the submission they confirm. */
export function reviewAdoptions(log: readonly TaskLog[]): Map<string, { run: string | null }> {
  let submission: TaskLog | undefined;
  const approved = new Map<string, { run: string | null }>();
  for (const entry of log) {
    if (entry.kind === 'review_approved') {
      if (entry.runId !== undefined || submission && (entry.fromState === 'waiting' || entry.fromState === 'held'))
        approved.set(entry.id, { run: entry.runId ?? submission?.runId ?? null });
      submission = undefined;
    } else if (isReviewMark(entry)) submission = entry;
    else if (reviewInvalidatedBy(entry)) submission = undefined;
  }
  return approved;
}

export const adoptedReview = (request: string | null): TakenReason =>
  ({ code: 'adopted', cause: null, aspects: [], of: request });

export function taskReasons(log: readonly TaskLog[], runs: readonly ReadRunRecord[]) {
  const byId = new Map(runs.map(run => [run.id, run]));
  const requestRun = new Map(runs.map(run => [run.requestId, carrierOf(run, id => byId.get(id))?.id ?? null]));
  const approvals = reviewAdoptions(log);
  return log.flatMap(entry => {
    const approval = approvals.get(entry.id);
    const subject = approval?.run ? byId.get(approval.run) : undefined;
    const reason: ActionReason | undefined = entry.reason ?? (approval ? { taken: adoptedReview(subject?.requestId ?? null) } : undefined);
    if (reason === undefined) return [];
    const { taken, ...rest } = reason;
    const request = isRequestLog(entry.kind);
    return [{ log: entry.id, at: entry.at, by: entry.actor.kind,
      on: entry.kind === 'review_approved' ? 'review' : request ? 'request' : entry.placementEffect ? 'placement'
        : entry.stage?.action === 'stop' ? 'stop' : 'values',
      ...rest, ...(request && { request: entry.id }), ...(taken && { taken: { ...taken, of: taken.of === null ? null :
        { request: taken.of, run: requestRun.get(taken.of) ?? null } } }) }];
  });
}
