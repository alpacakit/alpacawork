import type { DatabaseSync } from 'node:sqlite';
import { compileAgentSetting, coordinatorDefaultAgent, coordinatorStartValues, selectionOffer, type AiRow } from '@alpacawork/contract';
import { contextPercent, type ContextView } from '@alpacawork/contract/agent-context';
import { type CoordinatorResetReason } from '@alpacawork/contract/coordinator';
import { compareRunIds, coordinatorRunRecordSchema, type CoordinatorRunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { conversationInUse, currentRequestRun, type RunTransaction } from '@alpacawork/runs';
import { assignedSession, coordinatorLaunchSnapshot, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { aiLaunchIdentity, distinctAiRows, sameAiLaunch } from '../ai-stack.js';
import { z } from 'zod';
import { languageLine, savedReplyLanguage } from '../receiver/person-state.js';
import { coordinatorBoundary, pendingCoordinatorReset, reserveCoordinatorReset, startCoordinatorReset } from './resets.js';
import { readRunActivityView } from '../agents/context-limits.js';
import { assertSkillInvocations } from './skills.js';
import { visible } from './requests.js';

const HANDOVER_BYTES = 8 * 1024;

function coordinatorRows(config: AgentsSettings): readonly AiRow[] {
  if (config.coordinatorAiStack !== undefined) return config.coordinatorAiStack;
  const first = coordinatorDefaultAgent(config.agents, config.aiStack);
  if (!first) return [];
  const [agent, setting] = first;
  const offer = selectionOffer(compileAgentSetting(agent, setting));
  return [{ agent, values: coordinatorStartValues(offer) }];
}

type CoordinatorAi = { agent: string; launch: Pick<CoordinatorRunRecord['launch'], 'adapter' | 'values'> };
const rowOf = (run: CoordinatorAi): AiRow => ({ agent: run.agent, values: run.launch.values });

function sameCoordinatorAi(config: AgentsSettings, left: CoordinatorAi, right: CoordinatorAi): boolean {
  return left.launch.adapter === right.launch.adapter &&
    sameAiLaunch(aiLaunchIdentity(config, rowOf(left)), aiLaunchIdentity(config, rowOf(right)));
}

/** A resume command can change invocation options, but a different model owns a new session. */
function sameCoordinatorSessionAi(left: CoordinatorAi, right: CoordinatorAi): boolean {
  return left.launch.adapter === right.launch.adapter && sameAiLaunch(
    { agent: left.agent, effective: { model: left.launch.values.model ?? null } },
    { agent: right.agent, effective: { model: right.launch.values.model ?? null } });
}

function configuredAi(config: AgentsSettings, row: AiRow): CoordinatorAi {
  return { agent: row.agent, launch: { adapter: compileAgentSetting(row.agent, config.agents[row.agent]).adapter, values: row.values } };
}

function resetReason(config: AgentsSettings, rows: readonly AiRow[], head: CoordinatorRunRecord,
  selected: AiRow, same: boolean): CoordinatorResetReason {
  const from = rowOf(head), to = selected;
  if (same) return { kind: 'unresumable', from, to };
  const previousIndex = rows.findIndex(row => sameCoordinatorAi(config, head, configuredAi(config, row)));
  const selectedIndex = rows.indexOf(selected);
  if (previousIndex === 0 && selectedIndex > 0) return { kind: 'fallback', from, to };
  if (previousIndex > 0 && selectedIndex === 0) return { kind: 'recovered', from, to };
  return { kind: 'another_ai', from, to };
}

/** The only decision about which coordinator invocation can take the next input. */
function coordinatorNextLaunch(config: AgentsSettings, head: CoordinatorRunRecord | null,
  limitHistory: readonly CoordinatorRunRecord[], reset: CoordinatorResetReason | null, path: string) {
  const rows = distinctAiRows(config, coordinatorRows(config));
  const available = rows.filter(row => {
    const ai = configuredAi(config, row);
    return limitHistory.find(run => sameCoordinatorAi(config, run, ai))?.state !== 'failed';
  });
  const candidates = available.length ? available : rows;
  let refusal: Problem | undefined;
  for (const [index, row] of candidates.entries()) {
    try {
      const start = coordinatorLaunchSnapshot(config, row.agent, 'start', path, row.values);
      if (!start.ok) continue;
      const following = candidates.slice(index + 1);
      const same = head !== null && sameCoordinatorSessionAi(head, { agent: row.agent, launch: start.launch });
      if (!reset && head && same && head.session && (head.state === 'running' || head.state === 'succeeded' || head.reason === 'conversation_busy' && head.resumes)) {
        try {
          const resume = coordinatorLaunchSnapshot(config, row.agent, 'resume', path, row.values, head.launch);
          if (resume.ok) return { kind: 'resume' as const, row, launch: resume.launch,
            appliedValues: resume.appliedValues, continued: head, following };
        } catch (error) {
          if (!(error instanceof Problem) ||
            (error.reason?.kind !== 'selection_required' && error.reason?.kind !== 'new_conversation_required')) throw error;
        }
      }
      return { kind: 'start' as const, row, launch: start.launch, appliedValues: start.appliedValues, continued: null, following,
        reset: reset ?? (head && resetReason(config, rows, head, row, same)) };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      refusal ??= error;
    }
  }
  return { kind: 'unavailable' as const, row: null, error: refusal ?? new Problem(PROBLEM_CODE.invalidSettings,
    'Configure an AI for the coordinator in Settings → AI', undefined, { reason: { kind: 'no_configured_agents' } }) };
}

const records = (rows: { record?: unknown }[]) => rows.map(row => coordinatorRunRecordSchema.parse(JSON.parse(String(row.record))));

/** Only successes at or after the earliest outstanding failure can lift a limit. */
function coordinatorLimitHistory(db: DatabaseSync, conversation: string, now: number): CoordinatorRunRecord[] {
  const failures = records(db.prepare(`SELECT r.record FROM runs r INDEXED BY coordinator_rate_limit_runs
    WHERE r.conversation_id=? AND r.conversation_id IS NOT NULL AND r.state='failed'
      AND json_extract(r.record,'$.availability') IS NOT NULL AND json_extract(r.record,'$.started_at') IS NOT NULL
      AND coalesce(unixepoch(json_extract(r.record,'$.availability.resetsAt'),'subsec'),
        unixepoch(json_extract(r.record,'$.ended_at'),'subsec')+3600)>?`).all(conversation, now / 1000));
  if (!failures.length) return [];
  const started = (run: CoordinatorRunRecord) => Date.parse(run.started_at!);
  const earliest = failures.reduce((at, run) => Math.min(at, started(run)), Infinity);
  const successes = records(db.prepare(`SELECT r.record FROM runs r INDEXED BY coordinator_successful_runs
    WHERE r.conversation_id=? AND r.conversation_id IS NOT NULL AND r.state='succeeded'
      AND unixepoch(json_extract(r.record,'$.started_at'),'subsec')>=?`).all(conversation, earliest / 1000));
  return [...failures, ...successes].sort((a, b) => started(b) - started(a) || compareRunIds(b, a));
}

/** Only the last non-queued invocation in the current reset segment can be a resume predecessor. */
export function coordinatorLaunchFor(db: DatabaseSync, config: AgentsSettings, conversation: string, before: number | null = null,
  path = process.env.PATH ?? '', now = Date.now()) {
  const pending = pendingCoordinatorReset(db, conversation);
  const boundary = coordinatorBoundary(db, conversation);
  const head = records(db.prepare(`SELECT r.record FROM requests q JOIN runs r ON r.id=(${currentRequestRun('q.id')})
    WHERE q.conversation_id=? AND ${visible}
      AND q.coordinator_turn_no>=? AND q.coordinator_turn_no<?
      AND r.state NOT IN ('joined','queued','cancelled') ORDER BY q.coordinator_turn_no DESC LIMIT 1`)
    .all(conversation, boundary, before ?? Number.MAX_SAFE_INTEGER))[0] ?? null;
  return coordinatorNextLaunch(config, head, coordinatorLimitHistory(db, conversation, now), pending?.reason ?? null, path);
}

/** A live invocation cannot change its choices, even when a later resume command could. */
export function coordinatorInputSession(db: DatabaseSync, config: AgentsSettings, working: CoordinatorRunRecord, pending: CoordinatorRunRecord) {
  if (!sameCoordinatorSessionAi(working, pending) || !sameCoordinatorAi(config, working, pending)) return null;
  const next = coordinatorLaunchFor(db, config, working.conversationId, coordinatorTurnNumber(db, pending.requestId), pending.launch.path);
  if (next.kind !== 'resume' || next.continued.id !== working.id ||
      !sameCoordinatorAi(config, working, { agent: next.row.agent, launch: next.launch })) return null;
  return working.session;
}

export function coordinatorTurnNumber(db: DatabaseSync, request: string): number {
  const row = db.prepare('SELECT coordinator_turn_no FROM requests WHERE id=?').get(request);
  if (typeof row?.coordinator_turn_no !== 'number') throw new Error('Coordinator Request has no turn number');
  return row.coordinator_turn_no;
}

/** The captured input can also be delivered to an existing invocation or included in a fallback once. */
const capturedInput = z.object({ text: z.string(), language: z.string() }).strict();
type CapturedInput = z.infer<typeof capturedInput>;
export function coordinatorInput(db: DatabaseSync, request: string): CapturedInput {
  const row = db.prepare('SELECT coordinator_input FROM requests WHERE id=?').get(request);
  if (typeof row?.coordinator_input !== 'string') throw new Error('Coordinator Request has no captured input');
  return capturedInput.parse(JSON.parse(row.coordinator_input));
}

export function coordinatorInputText(input: CapturedInput): string {
  return [input.language, input.text].filter(Boolean).join('\n');
}

export function coordinatorReplyLanguage(root: string): string {
  const language = savedReplyLanguage(root);
  return language === null ? '' : languageLine(language).trimEnd();
}

export function prepareCoordinatorStart(db: DatabaseSync, conversation: string, before: number,
  inputs: readonly [CapturedInput, ...CapturedInput[]], recovery?: { run: string; cause: string }): string | undefined {
  const memo = db.prepare('SELECT memo_text,memo_through_turn_no FROM coordinator_conversations WHERE id=?').get(conversation);
  const quote = (text: string) => JSON.stringify(text).replaceAll('<', '\\u003c');
  const intro = [inputs[0].language, 'You are the workspace coordinator.',
    'Read the alpacawork skill and its coordinator reference before handling the current input.',
    ...(memo?.memo_text ? ['The coordinator memo gives background.', '<coordinator-memo>', quote(String(memo.memo_text)), '</coordinator-memo>'] : []),
    ...(recovery ? [`The previous Run ${recovery.run} stopped because of ${recovery.cause}.`,
      'Check recorded progress before continuing. Do not repeat completed operations or retry operations whose results are unknown.'] : []),
  ].filter(Boolean).join('\n');
  const current = inputs.map(input => input.text).join('\n\n');
  const remaining = PROTOCOL_LIMITS.prompt - Buffer.byteLength(intro + '\n\n' + current);
  if (remaining < 0) return undefined;
  const tail: string[] = [];
  const opening = 'Earlier user messages are quoted for background.\n<earlier-user-messages>';
  const closing = '</earlier-user-messages>\n\n';
  let budget = Math.min(remaining, HANDOVER_BYTES) - Buffer.byteLength(opening + closing) - 2;
  if (budget > 0) {
    for (const row of db.prepare(`SELECT q.body FROM requests q WHERE q.conversation_id=?
      AND ${visible}
      AND q.coordinator_turn_no>? AND q.coordinator_turn_no<?
      ORDER BY q.coordinator_turn_no DESC LIMIT 8`).all(conversation, Number(memo?.memo_through_turn_no ?? 0), before)) {
      const text = quote(String(row.body)), bytes = Buffer.byteLength(text) + 1;
      if (bytes <= budget) { tail.unshift(text); budget -= bytes; }
    }
  }
  const history = tail.length ? [opening, ...tail, closing.trimEnd()].join('\n') : '';
  return [intro, history, current].filter(Boolean).join('\n\n');
}

export function automaticCoordinatorReset(context: ContextView | null, limits: Pick<AgentsSettings['limits'],
  'coordinator_reset_tokens' | 'coordinator_reset_percent'>): CoordinatorResetReason | null {
  if (!context || context.usedTokens === null) return null;
  const { coordinator_reset_tokens: tokens, coordinator_reset_percent: percent } = limits;
  if (tokens > 0 && context.usedTokens >= tokens) return { kind: 'context', over: { tokens: context.usedTokens } };
  const used = contextPercent(context);
  return percent > 0 && used !== null && used >= percent ? { kind: 'context', over: { percent: used } } : null;
}


/** Rebind an admitted turn at launch, including any reset it starts in the same transaction. */
export function bindCoordinatorLaunch(db: DatabaseSync, tx: RunTransaction, config: AgentsSettings, run: CoordinatorRunRecord,
  runs: readonly RuntimeRunRecord[]) {
  const turn = coordinatorTurnNumber(db, run.requestId);
  const next = coordinatorLaunchFor(db, config, run.conversationId, turn, run.launch.path);
  if (next.kind === 'unavailable') return { kind: 'skipped' as const, reason: next.error.message };
  const session = next.continued ? next.continued.session : assignedSession(next.launch, next.row.agent);
  if (session && conversationInUse(runs, session.id)) return { kind: 'waiting' as const };
  const current = coordinatorInput(db, run.requestId);
  const prompt = next.kind === 'start' ? prepareCoordinatorStart(db, run.conversationId, turn, [current]) : coordinatorInputText(current);
  if (prompt === undefined) return { kind: 'failed' as const };
  if (run.message.skills?.length) {
    const row = db.prepare('SELECT body FROM requests WHERE id=?').get(run.requestId);
    try { assertSkillInvocations(next.launch.adapter, String(row?.body), run.message.skills); }
    catch (error) {
      if (!(error instanceof Problem)) throw error;
      return { kind: 'failed' as const };
    }
  }
  const bound = { ...run, agent: next.row.agent, launch: next.launch, resumes: next.continued?.id ?? null, session };
  tx.rebindQueued(bound, { aiStack: [next.row, ...next.following], prompt });
  if (next.kind === 'start' && next.reset) {
    const reset = reserveCoordinatorReset(db, run.conversationId, next.reset, new Date().toISOString());
    startCoordinatorReset(db, reset, bound);
  }
  return { kind: 'bound' as const, run: bound };
}

export function reserveAutomaticCoordinatorReset(db: DatabaseSync, root: string, run: CoordinatorRunRecord, at: string): void {
  if (!db.prepare('SELECT 1 FROM coordinator_conversations WHERE id=? AND cleared_at IS NULL').get(run.conversationId)) return;
  const settings = readAgentsSettings(root);
  if (!settings.ok) return;
  const reason = automaticCoordinatorReset(readRunActivityView(root, run)?.context ?? null, settings.config.limits);
  if (reason) reserveCoordinatorReset(db, run.conversationId, reason, at);
}
