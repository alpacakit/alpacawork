import { agentUsageSchema, type AgentUsage } from '@alpacawork/contract/agent-bridge';
import { limitWindow, resetTime, type LimitWindow } from '@alpacawork/contract/agent-limits';
import { RUN_RESULT_LIMIT } from '@alpacawork/contract/run';
import type { RunFailure } from '@alpacawork/contract/run-failure';
import { claudeActivity, ToolResults } from './activity.js';
import { diagnosticFailure } from '@alpacawork/contract/agent-diagnostics';
import { object, scanOutput } from './output.js';
import { catalogContext } from './skills.js';
import type { AgentAdapter, InputProtocol, LimitsProbe } from './types.js';
import type { CompactionOutcome } from '@alpacawork/contract/run-protocol';

/**
 * What Claude said of the `/compact` command `id`: a compact boundary or a successful compact status proves it;
 * the command ending without either fails it with Claude's own words ("No messages to compact"). Null until it ended.
 */
class ClaudeCompaction {
  outcome: CompactionOutcome | null = null;
  private open = false;
  private said: string | null = null;
  constructor(private readonly id: string | null) {}
  observe(row: Record<string, unknown>, session: string | null): void {
    if (this.id === null || row.parent_tool_use_id != null || row.session_id != null && row.session_id !== session) return;
    if (row.type === 'command_lifecycle' && row.command_uuid === this.id) {
      if (row.state === 'started') this.open = true;
      else if (this.open && row.state === 'completed') {
        this.open = false;
        this.outcome ??= { state: 'failed', message: (this.said ?? 'Claude did not compact the conversation').slice(0, 2000) };
      }
      return;
    }
    if (!this.open) return;
    if (row.type === 'system' && (row.subtype === 'compact_boundary' || row.subtype === 'status' && row.compact_result === 'success'))
      this.outcome = { state: 'compacted', message: null };
    else if (row.type === 'system' && row.subtype === 'status' && row.compact_result === 'failed')
      this.outcome = { state: 'failed', message: typeof row.compact_error === 'string' ? row.compact_error.slice(0, 2000) : null };
    else if (row.type === 'assistant') {
      const content = object(row.message).content;
      const text = Array.isArray(content) ? content.filter(part => object(part).type === 'text').map(part => object(part).text).join('\n') : '';
      if (text) this.said = text;
    }
  }
}

const ownSession = (row: Record<string, unknown>, session: string | null) =>
  row.parent_tool_use_id == null && session !== null && row.session_id === session;
const userLine = (id: string, text: string) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, uuid: id });
export const claudeInput: InputProtocol = {
  // `/compact` is Claude's own command, taken in order before the instruction; its uuid is the compaction's ID.
  encode: (id, text, compaction) => [...compaction ? [userLine(compaction.id,
    compaction.instructions === null ? '/compact' : `/compact ${compaction.instructions}`)] : [], userLine(id, text)],
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
/** `/usage`'s windows: the 5-hour session, the week, and a week per model (Fable, Opus…). Utilization is 0-100 here. */
export function claudeLimitWindows(value: unknown): LimitWindow[] {
  const limits = object(value);
  const named: [string, number, string | null][] = [['five_hour', 300, null], ['seven_day', 10_080, null],
    ['seven_day_opus', 10_080, 'Opus'], ['seven_day_sonnet', 10_080, 'Sonnet']];
  const windows = named.flatMap(([key, minutes, model]) => {
    const entry = limits[key];
    return entry == null ? [] : [limitWindow({ minutes, model, usedPercent: object(entry).utilization, resetsAt: object(entry).resets_at })];
  });
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped.map(object) : [];
  for (const entry of scoped) {
    const model = typeof entry.display_name === 'string' ? entry.display_name : null;
    if (model && !windows.some(window => window?.model === model))
      windows.push(limitWindow({ minutes: 10_080, model, usedPercent: entry.utilization, resetsAt: entry.resets_at }));
  }
  return windows.filter(window => window !== null);
}
const control = (id: string, subtype: string, fields: object = {}) =>
  `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...fields } })}\n`;
/** Two control requests answered without a conversation or a model call (who is signed in, then `/usage`); the process
 * ends when its stdin does. */
export const claudeLimits: LimitsProbe = {
  args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
  input: control('account', 'initialize') + control('limits', 'get_usage', { skip_behaviors: true }),
  read(stdout) {
    const answers = new Map<unknown, Record<string, unknown>>();
    for (const line of stdout.split('\n')) {
      let row: Record<string, unknown>;
      try { row = object(JSON.parse(line)); } catch { continue; }
      const response = object(row.response);
      if (row.type === 'control_response' && response.subtype === 'success') answers.set(response.request_id, object(response.response));
    }
    const usage = answers.get('limits'), email = object(answers.get('account')?.account).email;
    if (!usage) return null;
    // An API key has no plan, so no limits: an answer, not a failure.
    return { windows: usage.rate_limits_available === true ? claudeLimitWindows(usage.rate_limits) : [],
      account: typeof email === 'string' && email ? email : null };
  },
};
export const claudeAdapter: AgentAdapter = {
  input: claudeInput, activity: claudeActivity, limits: claudeLimits,
  earlySession: invocation => invocation.session,
  skillCatalogContext: input => catalogContext('claude', input),
  read(invocation, folder, exit) {
    let completion: { result: string; is_error: boolean } | null = null;
    let usage: AgentUsage | null = null, failure: RunFailure | undefined;
    // When the limit that refused the turn lifts: its own event comes just before the error words.
    let resetsAt: string | undefined;
    // The API error said in the turn now open; a turn's result ends it.
    let said: RunFailure | undefined;
    const tools = new ToolResults(), compaction = new ClaudeCompaction(invocation.compaction);
    const { rejection, outcomeRejection } = scanOutput(folder, value => {
      const row = object(value);
      compaction.observe(row, invocation.session);
      if (row.type === 'command_lifecycle' && row.state === 'started' && row.parent_tool_use_id == null &&
        (row.session_id == null || row.session_id === invocation.session)) {
        completion = null; usage = null; failure = undefined; resetsAt = undefined; said = undefined;
      }
      if (invocation.session !== null && (row.session_id == null || row.session_id === invocation.session))
        tools.observe(claudeActivity(row, ''));
      if (!ownSession(row, invocation.session)) return;
      if (row.type === 'system' && row.subtype === 'init') { completion = null; usage = null; failure = undefined; resetsAt = undefined; said = undefined; }
      if (row.type === 'rate_limit_event' && object(row.rate_limit_info).status === 'rejected') resetsAt = resetTime(object(row.rate_limit_info).resetsAt) ?? undefined;
      if (row.type === 'assistant' && row.is_api_error_message === true) {
        completion = null;
        const content = object(row.message).content;
        failure = said = diagnosticFailure(Array.isArray(content) ? content.filter(part => object(part).type === 'text')
          .map(part => object(part).text).join('\n') : undefined, resetsAt);
      }
      if (row.type !== 'result') return;
      usage = claudeUsage(row.modelUsage);
      if (typeof row.result === 'string' && typeof row.is_error === 'boolean') {
        completion = { result: row.result, is_error: row.is_error };
        // A general terminal ("Request failed.") does not hide the recognized error its own turn already said.
        const read = row.is_error ? diagnosticFailure(row.result, resetsAt) ?? failure : undefined;
        failure = read && !read.cause && said?.cause ? said : read;
        said = undefined;
        return true;
      }
    });
    const result = completion as { result: string; is_error: boolean } | null;
    const base = { session: invocation.session, usage, compaction: compaction.outcome,
      ...(!rejection && failure ? { failure, toolsSettled: tools.complete } : {}) };
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
