/** Owner handoffs: the one decision about a prepared snapshot, its supplied versions and its next conversation. */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { digest, type ChildVersions, type ConversationCheckpoint, type ControlTask, type TaskValues } from '@alpacawork/raw';
import { canonicalValues } from '@alpacawork/contract';
import { hasContinuableSession, runNumber, type RunRecord } from '@alpacawork/contract/run';
import { inputUnsettled } from '@alpacawork/contract/run-protocol';
import { isUnfinished } from '@alpacawork/runs';
import { endedOwnWork } from './return-rules.js';
import type { ControlTx } from './task-transition.js';
import { assertCompactable } from '../runs/compactions.js';

/** The checkpoint's mark of a Task's values (kept as `bodyHash`): the digest of their canonical JSON. */
export const valuesHash = (values: TaskValues) => digest(Buffer.from(canonicalValues(values)));

/**
 * The latest complete explanation proved received in the current conversation. Resume/into edges exclude other
 * conversations at this placement. An unproved newer input stops the search; a taken short input can refer back to
 * a prior full supply but never certifies a new one itself.
 */
export function suppliedSnapshotForRequest(tx: ControlTx, head: RunRecord, runs: readonly RunRecord[]): string | undefined {
  if (head.state === 'queued') return undefined;
  const byId = new Map(runs.map(run => [run.id, run]));
  const connected = new Set<string>();
  let current: RunRecord | undefined = head;
  while (current) {
    if (current.placementId !== head.placementId || connected.has(current.id)) return undefined;
    connected.add(current.id);
    if (!current.resumes) break;
    current = byId.get(current.resumes);
    if (!current) return undefined;
  }
  for (const run of runs) if (run.state === 'joined' && run.into && connected.has(run.into) &&
      run.placementId === head.placementId) connected.add(run.id);
  const receipts = new Map<number, unknown[]>();
  for (const input of tx.store.connection.prepare(`SELECT instruction_run_no,state FROM run_inputs
    WHERE instruction_run_no IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...connected].map(runNumber)))) {
    const id = Number(input.instruction_run_no), states = receipts.get(id) ?? [];
    states.push(input.state); receipts.set(id, states);
  }
  for (const run of [...runs].reverse()) {
    if (!connected.has(run.id)) continue;
    const inputs = receipts.get(runNumber(run.id)) ?? [];
    if (run.state === 'queued' || !inputs.some(state => state === 'taken') ||
        inputs.some(state => inputUnsettled(state))) return undefined;
    if (run.context?.suppliedSnapshot) return run.context.suppliedSnapshot;
  }
  return undefined;
}

/** A report asserts that the supplied versions, rather than arbitrary extra reads, are reflected in its values. */
export function checkpointForReport(tx: ControlTx, task: ControlTask, runId: string, values: TaskValues,
  nextConversation?: 'new' | 'compact', compactFocus?: string): ConversationCheckpoint {
  const run = tx.runs.get(runId), placement = run && tx.runs.getPlacement(run.placementId);
  if (!run || run.task !== task.id || run.role !== 'owner' || run.state !== 'running' ||
      !placement?.active || !placement.responsible)
    throw new Problem(PROBLEM_CODE.forbidden, 'Only the running responsible saves its conversation handoff', undefined,
      { reason: { kind: 'checkpoint_requires_running_responsible' } });
  const runs = tx.runs.conversationRuns(run.placementId);
  const received = runs.filter(each => each.id === run.id || each.state === 'joined' && each.into === run.id);
  const inputHead = received.at(-1)?.id ?? run.id;
  if (nextConversation && runs.at(-1)?.id !== inputHead)
    throw new Problem(PROBLEM_CODE.handoffPending, 'A queued instruction must be handled before preparing a handoff', undefined,
      { reason: { kind: 'checkpoint_has_queued_instruction' } });
  const base = task.meta.log.find(each => each.id === run.context?.snapshotFrom)?.checkpoint;
  const children: ChildVersions = { ...base?.children };
  // Fold only facts delivered to this Run, including explicit removals. An unchanged joined input is not a reset.
  for (const each of received) for (const [id, version] of Object.entries(each.context?.children ?? {})) {
    if (version === null) delete children[id];
    else children[id] = version;
  }
  // A compacted next conversation is the same agent's: refuse one it cannot compact now rather than drop it later.
  if (nextConversation === 'compact') assertCompactable(run.launch, compactFocus ?? null);
  return { bodyHash: valuesHash(values), inputHead, children,
    ...(nextConversation ? { nextConversation } : {}), ...(compactFocus ? { compactFocus } : {}) };
}

type RotationReceipt = 'active' | 'taken' | 'not_sent' | 'resolved' | 'unknown';
type Rotation = { run: RunRecord; receipt: RotationReceipt; unknown: boolean };
/** Read the reserved invocations themselves, including aborted Requests; later inputs never replace this evidence. */
export function rotationForRequest(tx: ControlTx, taskId: string, placementId: string): Rotation | null {
  const reserved = tx.runs.runsOfTask(taskId).filter(run => run.placementId === placementId && run.context?.rotationFrom);
  const ended = reserved.filter(run => endedOwnWork(run.state));
  const initialInputs = new Map<number, unknown[]>();
  if (ended.length) for (const input of tx.store.connection.prepare(`SELECT a.run_no,i.state FROM run_attempts a
    LEFT JOIN run_inputs i ON i.attempt_id=a.attempt_id AND i.initial=1
    WHERE a.run_no IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ended.map(run => runNumber(run.id))))) {
    const id = Number(input.run_no), states = initialInputs.get(id) ?? [];
    states.push(input.state); initialInputs.set(id, states);
  }
  const receipts = reserved.map(run => {
    let receipt: RotationReceipt = 'active';
    if (endedOwnWork(run.state)) {
      const inputs = initialInputs.get(runNumber(run.id)) ?? [];
      if (inputs.some(state => state === 'taken')) receipt = 'taken';
      else if (inputs.length && inputs.every(state => state === 'resolved' || state === 'not_sent'))
        receipt = inputs.some(state => state === 'resolved') ? 'resolved' : 'not_sent';
      else if (!inputs.length && (run.started_at === null || run.reason === 'launch')) receipt = 'not_sent';
      else receipt = 'unknown';
    }
    return { run, receipt };
  });
  const last = receipts.at(-1);
  return last ? { ...last, unknown: receipts.some(each => each.receipt === 'unknown') } : null;
}

/** An unknown receipt is resolved only on the user's behalf, by a Request that does not itself start a new conversation. */
export function assertRotationResolved(rotation: Rotation | null, resolvesUnknown: boolean, explicit: 'new' | 'continue' | undefined): void {
  if (rotation?.unknown && (!resolvesUnknown || explicit === 'new'))
    throw new Problem(PROBLEM_CODE.handoffPending, 'The new conversation receipt is unknown; resolve it before retrying', undefined,
      { reason: { kind: 'checkpoint_rotation_receipt_unknown' } });
}

/** `rotate`: the next conversation starts anew; `compact`: it continues, compacted first (with this focus). */
type Handoff = { id: string; checkpoint: ConversationCheckpoint; rotate: boolean; compact: { focus: string | null } | null };
/** Snapshot freshness alone decides whether a successful report prepares how the next conversation starts. */
export function handoffForRequest(tx: ControlTx, task: ControlTask, placementId: string,
  runs: readonly RunRecord[]): Handoff | null {
  const head = runs.at(-1);
  const entry = [...task.meta.log].reverse().find(each => each.checkpoint && each.runId &&
    each.actor.kind === 'placement' && each.actor.placementId === placementId);
  if (!entry?.checkpoint || !entry.runId || entry.checkpoint.bodyHash !== valuesHash(task.values) ||
      !['running', 'succeeded'].includes(tx.runs.get(entry.runId)?.state ?? '')) return null;
  const checkpoint = entry.checkpoint;
  const latestReport = [...task.meta.log].reverse().find(each => each.runId &&
    (each.kind === 'reported' || each.kind === 'asked') &&
    each.actor.kind === 'placement' && each.actor.placementId === placementId);
  const prepared = tx.runs.get(entry.runId)?.state === 'succeeded' && head?.id === checkpoint.inputHead && latestReport?.id === entry.id;
  return { id: entry.id, checkpoint, rotate: prepared && checkpoint.nextConversation === 'new',
    compact: prepared && checkpoint.nextConversation === 'compact' ? { focus: checkpoint.compactFocus ?? null } : null };
}

/**
 * Which conversation a Request goes in, and the handoff a new one comes from. An unsent new conversation is sent again
 * as new; an explicit mode (the CLI and automatic routes) keeps its meaning; a handoff the seat prepared starts a new
 * one. Otherwise there must be a conversation to continue: a direct instruction keeps it when it can resume, and a
 * finished head without a session or a resume command requires a new one.
 */
/** A queued/running Run may still acquire its session; an ended one without it cannot resume. */
export function continuationSessionUnavailable(head: Pick<RunRecord, 'state' | 'session'>): boolean {
  return head.session === null && head.state !== 'queued' && head.state !== 'running';
}
export function conversationForRequest(facts: { rotation: Rotation | null; handoff: Handoff | null; resolvesUnknown: boolean;
  explicit: 'new' | 'continue' | undefined; head: RunRecord | null; direct: boolean; resumable: boolean }):
  { mode: 'new' | 'continue'; rotationFrom: string | undefined; unsentNew: boolean } {
  const { rotation, handoff, head } = facts;
  const unsentNew = rotation?.receipt === 'not_sent', rotates = !!handoff?.rotate && !rotation?.unknown;
  const mode = unsentNew ? 'new' : facts.explicit ? facts.explicit : rotates || !head ? 'new'
    : facts.direct && (!hasContinuableSession(head) || !isUnfinished(head) && !facts.resumable) ? 'new' : 'continue';
  if (mode !== 'new') return { mode, rotationFrom: undefined, unsentNew };
  const rotationFrom = unsentNew || (rotation?.unknown && facts.resolvesUnknown) ? rotation?.run.context?.rotationFrom
    : rotates ? handoff.id : undefined;
  return { mode, rotationFrom, unsentNew };
}
