import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { aiStackPrefixSchema, type AiRow, type Selection } from '@alpacawork/contract';
import type { RequestInput } from '@alpacawork/contract/control';
import type { RunRecord } from '@alpacawork/contract/run';
import type { StoredPlacement } from '@alpacawork/runs';
import { launchSnapshot, type AgentsSettings } from '../agents-settings.js';
import { aiRows, standingAiRows } from '../ai-stack.js';
import { appliedConversationValues } from '../runs/session-continuation.js';

/** The starting AI, its values and the remaining fallback order are resolved together for each Task Request. */
export function requestAiPlan(db: DatabaseSync, config: AgentsSettings, placement: StoredPlacement,
  input: Pick<RequestInput, 'aiStack' | 'mode' | 'selected'>, head: RunRecord | null, runs: readonly RunRecord[]) {
  const storedPrefix = db.prepare('SELECT ai_prefix FROM placements WHERE id=?').get(placement.id)?.ai_prefix;
  const placementPrefix = typeof storedPrefix === 'string' ? aiStackPrefixSchema.parse(JSON.parse(storedPrefix)) : undefined;
  const rows = aiRows(config, input.aiStack, placementPrefix);
  const requestedRow = input.aiStack?.[0] && input.aiStack[0] !== 'stop' ? rows[0] : undefined;
  // A request's stop cuts off the fallback order. The standing rows still govern which launch values carry forward.
  const standing = !input.aiStack ? rows : requestedRow ? [] : standingAiRows(config, placementPrefix);
  const placedRow = !requestedRow && placementPrefix?.[0] && placementPrefix[0] !== 'stop' &&
    standing[0]?.agent === placement.profileKey ? standing[0] : undefined;
  const matchesHead = (row: AiRow) => !!head && row.agent === head.agent && isDeepStrictEqual(row.values, head.launch.values);
  const standingPosition = standing.findIndex(matchesHead);
  const headRequest = head ? db.prepare('SELECT ai_explicit,ai_prefix FROM requests WHERE id=?').get(head.requestId) : undefined;
  const requestScopedHead = !!head && standingPosition < 0 &&
    (typeof headRequest?.ai_prefix === 'string' || head.attempt !== undefined ||
      headRequest?.ai_explicit === 1 && config.aiStack !== undefined);
  const carriesFallback = standingPosition >= 0 && runs.some(run => run.attempt !== undefined &&
    matchesHead({ agent: run.agent, values: run.launch.values }) && (run.id === head?.id || run.started_at !== null));
  const standingAgent = placedRow?.agent ?? placement.profileKey;
  // Compare against the AI a continuation would use, even when the sender explicitly asks to start fresh.
  const continuationAgent = requestedRow?.agent ?? (requestScopedHead ? standingAgent : head?.agent ?? standingAgent);
  const agent = input.mode === 'new' && !carriesFallback ? requestedRow?.agent ?? standingAgent : continuationAgent;
  const standingValues = (placedRow?.agent === agent ? placedRow.values : undefined) ??
    config.aiStack?.find(row => row.agent === agent)?.values;

  return {
    agent, continuationAgent,
    returnsToConfiguredValues: requestScopedHead && !requestedRow,
    following: carriesFallback && !input.aiStack ? rows.slice(standingPosition + 1) : rows,
    snapshot(mode: 'new' | 'continue', path: string, initialValues: () => Selection | undefined) {
      if (mode === 'continue') {
        const selectionBase = requestedRow?.values ?? (requestScopedHead ? standingValues ?? {} : undefined);
        const previous = head ? { ...head.launch, selectionBase, applied: appliedConversationValues(head, runs) } : undefined;
        return launchSnapshot(config, agent, 'resume', path, input.selected, previous);
      }
      const values = requestedRow?.values ?? (carriesFallback ? head?.launch.values : standingValues);
      return launchSnapshot(config, agent, 'start', path, input.selected,
        { values: { ...values, ...(requestedRow ? undefined : initialValues()) } });
    },
  };
}
