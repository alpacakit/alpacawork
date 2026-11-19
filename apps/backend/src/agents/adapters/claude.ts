import { agentUsageSchema, type AgentUsage } from '@alpacawork/contract/agent-bridge';
import { RUN_RESULT_LIMIT } from '@alpacawork/contract/run';
import type { RunFailure } from '@alpacawork/contract/run-failure';
import { claudeActivity } from './activity.js';
import { diagnosticFailure } from '@alpacawork/contract/agent-diagnostics';
import { object, scanOutput } from './output.js';
import { catalogContext } from './skills.js';
import type { AgentAdapter, InputProtocol } from './types.js';

const ownSession = (row: Record<string, unknown>, session: string | null) =>
  row.parent_tool_use_id == null && session !== null && row.session_id === session;
export const claudeInput: InputProtocol = {
  encode: (id, text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: id }),
  receipt(value, session) {
    const row = object(value);
    if (row.type !== 'command_lifecycle' || row.state !== 'started' || typeof row.command_uuid !== 'string' ||
      row.parent_tool_use_id != null || row.session_id != null && row.session_id !== session) return null;
    return { id: row.command_uuid, outcome: 'taken' };
  },
  turnEnded: (value, session) => { const row = object(value); return row.type === 'result' && ownSession(row, session); },
};
/** Native modelUsage is a conversation total of four disjoint classes, summed across models. */
export function claudeUsage(value: unknown): AgentUsage | null {
  const models = Object.values(object(value)).map(object);
  if (!models.length) return null;
  const sum = (key: string): number | null => {
    const counts = models.map(model => model[key]);
    return counts.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
      ? (counts as number[]).reduce((a, b) => a + b, 0) : null;
  };
  const parsed = agentUsageSchema.safeParse({ scope: 'conversation', counters: {
    input: sum('inputTokens'), cacheRead: sum('cacheReadInputTokens'),
    cacheWrite: sum('cacheCreationInputTokens'), output: sum('outputTokens'),
  } });
  return parsed.success ? parsed.data : null;
}
export const claudeAdapter: AgentAdapter = {
  input: claudeInput, activity: claudeActivity,
  earlySession: invocation => invocation.session,
  skillCatalogContext: input => catalogContext('claude', input),
  read(invocation, folder, exit) {
    let completion: { result: string; is_error: boolean } | null = null;
    let usage: AgentUsage | null = null, failure: RunFailure | undefined;
    const { rejection, outcomeRejection } = scanOutput(folder, value => {
      const row = object(value);
      if (row.type === 'command_lifecycle' && row.state === 'started' && row.parent_tool_use_id == null &&
        (row.session_id == null || row.session_id === invocation.session)) {
        completion = null; usage = null; failure = undefined;
      }
      if (!ownSession(row, invocation.session)) return;
      if (row.type === 'system' && row.subtype === 'init') { completion = null; usage = null; failure = undefined; }
      if (row.type === 'assistant' && row.is_api_error_message === true) {
        completion = null;
        const content = object(row.message).content;
        failure = diagnosticFailure(Array.isArray(content) ? content.filter(part => object(part).type === 'text')
          .map(part => object(part).text).join('\n') : undefined);
      }
      if (row.type !== 'result') return;
      usage = claudeUsage(row.modelUsage);
      if (typeof row.result === 'string' && typeof row.is_error === 'boolean') {
        completion = { result: row.result, is_error: row.is_error };
        failure = row.is_error ? diagnosticFailure(row.result) ?? failure : undefined;
        return true;
      }
    });
    const result = completion as { result: string; is_error: boolean } | null;
    const base = { session: invocation.session, usage, ...(!rejection && failure ? { failure } : {}) };
    const text = result?.result;
    const tooLarge = text !== undefined && Buffer.byteLength(text) > RUN_RESULT_LIMIT;
    if (exit.code !== 0 || exit.signal !== null) return { ...base, outcome: { state: 'failed', reason: 'exit',
      ...(text !== undefined && !tooLarge ? { result: text } : {}) } };
    if (outcomeRejection || tooLarge || !invocation.session || !result) return { ...base, outcome: { state: 'failed', reason: 'output',
      ...(outcomeRejection || tooLarge ? { resultState: tooLarge ? 'too_large' : outcomeRejection! } : {}) } };
    return { ...base, outcome: result.is_error ? { state: 'failed', reason: 'output', result: result.result }
      : { state: 'succeeded', session: invocation.session, result: result.result } };
  },
};
