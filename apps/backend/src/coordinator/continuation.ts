import type { DatabaseSync } from 'node:sqlite';
import { compileAgentSetting, coordinatorDefaultAgent, coordinatorStartValues, selectionOffer, type AiRow } from '@alpacawork/contract';
import { contextPercent, type ContextView } from '@alpacawork/contract/agent-context';
import { type CoordinatorResetReason } from '@alpacawork/contract/coordinator';
import { compareRunIds, coordinatorRunRecordSchema, type CoordinatorRunRecord } from '@alpacawork/contract/run';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { compareRequestOrder, currentRequestRun } from '@alpacawork/runs';
import { coordinatorLaunchSnapshot, type AgentsSettings } from '../agents-settings.js';
import { aiLaunchIdentity, distinctAiRows, sameAiLaunch } from '../ai-stack.js';
import { z } from 'zod';
import { languageLine, savedReplyLanguage } from '../receiver/person-state.js';
import { coordinatorBoundary, pendingCoordinatorReset } from './resets.js';

const UNKNOWN_LIMIT_MS = 60 * 60 * 1000;
const HANDOVER_BYTES = 8 * 1024;

function coordinatorRows(config: AgentsSettings): readonly AiRow[] {
  if (config.coordinatorAiStack !== undefined) return config.coordinatorAiStack;
  const first = coordinatorDefaultAgent(config.agents, config.aiStack);
  if (!first) return [];
  const [agent, setting] = first;
  const offer = selectionOffer(compileAgentSetting(agent, setting));
  return [{ agent, values: coordinatorStartValues(offer) }];
}

const rowOf = (run: CoordinatorRunRecord): AiRow => ({ agent: run.agent, values: run.launch.values });
function blockedUntil(run: CoordinatorRunRecord): number {
  if (run.state !== 'failed' || !run.availability) return 0;
  return run.availability.resetsAt ? Date.parse(run.availability.resetsAt) :
    Date.parse(run.ended_at ?? run.started_at ?? '') + UNKNOWN_LIMIT_MS;
}

function resetReason(config: AgentsSettings, rows: readonly AiRow[], head: CoordinatorRunRecord,
  selected: AiRow, same: boolean): CoordinatorResetReason {
  const from = rowOf(head), to = selected;
  if (same) return { kind: 'unresumable', from, to };
  const previous = aiLaunchIdentity(config, from);
  const previousIndex = rows.findIndex(row => row.agent === from.agent &&
    compileAgentSetting(row.agent, config.agents[row.agent]).adapter === head.launch.adapter &&
    sameAiLaunch(previous, aiLaunchIdentity(config, row)));
  const selectedIndex = rows.indexOf(selected);
  if (previousIndex === 0 && selectedIndex > 0) return { kind: 'fallback', from, to };
  if (previousIndex > 0 && selectedIndex === 0) return { kind: 'recovered', from, to };
  return { kind: 'another_ai', from, to };
}

/** The only decision about which coordinator invocation can take the next input. */
export function coordinatorNextLaunch(config: AgentsSettings, runs: readonly CoordinatorRunRecord[],
  path = process.env.PATH ?? '', options: { now?: number; reset?: CoordinatorResetReason | null; rows?: readonly AiRow[];
    head?: CoordinatorRunRecord | null } = {}) {
  const now = options.now ?? Date.now();
  const rows = distinctAiRows(config, options.rows ?? coordinatorRows(config));
  const head = options.head === undefined ? runs.filter(run => run.state !== 'joined' && run.state !== 'cancelled')
    .sort(compareRequestOrder).at(-1) ?? null : options.head;
  const executed = runs.filter(run => run.started_at !== null && run.state !== 'joined')
    .sort((a, b) => b.started_at!.localeCompare(a.started_at!) || compareRunIds(b, a));
  const available = rows.filter(row => {
    const identity = aiLaunchIdentity(config, row);
    const adapter = compileAgentSetting(row.agent, config.agents[row.agent]).adapter;
    const latest = executed.find(run => run.launch.adapter === adapter && sameAiLaunch(aiLaunchIdentity(config, rowOf(run)), identity));
    return !latest || !(blockedUntil(latest) > now);
  });
  const candidates = available.length ? available : rows;
  let refusal: Problem | undefined;
  for (const [index, row] of candidates.entries()) {
    try {
      const start = coordinatorLaunchSnapshot(config, row.agent, 'start', path, row.values);
      if (!start.ok) continue;
      const following = candidates.slice(index + 1);
      const same = head?.agent === row.agent && head.launch.adapter === start.launch.adapter &&
        head.launch.values.model === start.launch.values.model;
      if (!options.reset && same && head.session && (head.state === 'running' || head.state === 'succeeded' || head.reason === 'conversation_busy' && head.resumes)) {
        try {
          const resume = coordinatorLaunchSnapshot(config, row.agent, 'resume', path, row.values, head.launch);
          if (resume.ok) return { kind: 'resume' as const, row, launch: resume.launch,
            appliedValues: resume.appliedValues, continued: head, following };
        } catch (error) {
          if (!(error instanceof Problem) ||
            (error.reason?.kind !== 'selection_required' && error.reason?.kind !== 'new_conversation_required')) throw error;
        }
      }
      const reset = options.reset ?? (head && resetReason(config, rows, head, row, same));
      return { kind: 'start' as const, row, launch: start.launch,
        appliedValues: start.appliedValues, continued: null, following, reset };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      refusal ??= error;
    }
  }
  return { kind: 'unavailable' as const, row: null, error: refusal ?? new Problem(PROBLEM_CODE.invalidSettings,
    'Configure an AI for the coordinator in Settings → AI', undefined, { reason: { kind: 'no_configured_agents' } }) };
}

const records = (rows: { record?: unknown }[]) => rows.map(row => coordinatorRunRecordSchema.parse(JSON.parse(String(row.record))));

export function activeCoordinatorRuns(db: DatabaseSync, conversation: string): CoordinatorRunRecord[] {
  return db.prepare(`SELECT r.record FROM runs r INDEXED BY coordinator_active_runs JOIN requests q ON q.id=r.request_id
    WHERE r.conversation_id=? AND r.conversation_id IS NOT NULL AND r.state IN ('queued','running','needs_review')
    AND q.coordinator_turn_no IS NOT NULL AND q.delivery_state <> 'aborted' ORDER BY r.id`)
    .all(conversation).map(row => coordinatorRunRecordSchema.parse(JSON.parse(String(row.record))));
}

/** Seeks the current segment's predecessor and the few failures still relevant to plan limits. */
export function coordinatorLaunchFor(db: DatabaseSync, config: AgentsSettings, conversation: string, before: number | null = null,
  path = process.env.PATH ?? '') {
  const pending = pendingCoordinatorReset(db, conversation);
  const boundary = coordinatorBoundary(db, conversation);
  const head = records(db.prepare(`SELECT r.record FROM requests q JOIN runs r ON r.id=(${currentRequestRun('q.id')})
    WHERE q.conversation_id=? AND q.coordinator_turn_no IS NOT NULL AND q.delivery_state <> 'aborted'
      AND q.coordinator_turn_no>=? AND q.coordinator_turn_no<?
      AND r.state NOT IN ('joined','queued','cancelled') ORDER BY q.coordinator_turn_no DESC LIMIT 1`)
    .all(conversation, boundary, before ?? Number.MAX_SAFE_INTEGER))[0] ?? null;
  const now = Date.now();
  const failures = records(db.prepare(`SELECT r.record FROM runs r INDEXED BY coordinator_rate_limit_runs
    WHERE r.conversation_id=? AND r.conversation_id IS NOT NULL AND r.state='failed'
      AND json_extract(r.record,'$.availability') IS NOT NULL
      AND coalesce(unixepoch(json_extract(r.record,'$.availability.resetsAt'),'subsec'),
        unixepoch(json_extract(r.record,'$.ended_at'),'subsec')+3600)>?
      AND NOT EXISTS (SELECT 1 FROM runs newer WHERE newer.conversation_id=r.conversation_id
        AND (json_extract(newer.record,'$.started_at'),newer.id) > (json_extract(r.record,'$.started_at'),r.id)
        AND newer.state='succeeded' AND json_extract(newer.record,'$.agent')=json_extract(r.record,'$.agent')
        AND json_extract(newer.record,'$.launch.adapter')=json_extract(r.record,'$.launch.adapter')
        AND json_extract(newer.record,'$.launch.values')=json_extract(r.record,'$.launch.values'))`).all(conversation, now / 1000));
  return coordinatorNextLaunch(config, head ? [...failures, head] : failures, path, { head, reset: pending?.reason, now });
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
      AND q.coordinator_turn_no IS NOT NULL AND q.delivery_state <> 'aborted'
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
