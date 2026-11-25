/** Translate native Claude and common bridge stdout events for the activity projection. */
import { ITEM_READABLE, bridgeToolEventSchema, clippedUnder, fileChangesText, headingsShown } from '@alpacawork/contract/agent-bridge';
import { RUN_NOTE_LIMIT, inputDocument, previewRunLine, previewToolInput, toolInputDocument, toolResultText, type RunStepText } from '@alpacawork/contract/run';
import type { ActivityEvent, StepCall } from '../../runs/activity-events.js';
import { commandOf } from '../../runs/shell-command.js';
import { object } from './output.js';

const bridgeTools = new Set(['command_execution', 'file_change', 'web_search', 'mcp_tool_call', 'dynamic_tool_call',
  'collab_agent_tool_call', 'image_view']);
const eventAt = (row: Record<string, unknown>, received: string) => {
  const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const iso = Number.isFinite(time) ? new Date(time).toISOString() : received;
  return iso.length === 24 ? iso : received;
};
/** Track outstanding tool results without the display projection's resets on errors. */
export class ToolResults {
  private readonly pending = new Set<string>();
  private unknown = false;

  observe(events: readonly Pick<ActivityEvent, 'id' | 'kind'>[]): void {
    for (const { id, kind } of events) {
      if (kind === 'tool_start') {
        if (typeof id !== 'string' || this.pending.has(id)) this.unknown = true;
        else this.pending.add(id);
      } else if (kind === 'tool_end' && typeof id === 'string') this.pending.delete(id);
    }
  }

  get complete(): boolean { return !this.unknown && this.pending.size === 0; }
}

const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value !== '');
/**
 * Codex wraps every command in one login shell; the script inside is what the agent wrote. The wrapper is taken off in
 * two cases only, without reading the shell's grammar: (a) the command is the wrapper's opening quote, the script and a
 * closing quote that is the command's last character, every other quote inside being the escaped quote Codex writes;
 * (b) the bridge cut the command short (`cut`), so its closing quote is gone. Any other command is shown as written.
 */
function shellScript(command: unknown, cut = false): unknown {
  if (typeof command !== 'string') return command;
  const head = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh) -l?c (['"])/.exec(command);
  if (!head) return command;
  const quote = head[1]!, rest = command.slice(head[0].length);
  const closed = rest.endsWith(quote) && rest.length > 0;
  const body = closed && !cut ? rest.slice(0, -1) : cut ? rest : null;
  if (body === null) return command;
  if (quote === "'") {
    const escaped = [`'\\''`, `'"'"'`];
    if (!cut && escaped.reduce((text, each) => text.replaceAll(each, ''), body).includes("'")) return command;
    return escaped.reduce((text, each) => text.replaceAll(each, "'"), body);
  }
  if (!cut && /(^|[^\\])(\\\\)*"/.test(body)) return command;
  return body.replace(/\\(["\\$`])/g, '$1');
}
/** All of a text as the output holds it: the step's opened view bounds it. */
const whole = (text: string): RunStepText => ({ text, omitted: 0 });
/** A tool call's input as given: the tool's name and its fields, as written in the record. */
const toolCall = (tool: unknown, raw: unknown): Pick<ActivityEvent, 'detail' | 'about' | 'call'> =>
  ({ ...previewToolInput(tool, raw), call: { tool: typeof tool === 'string' ? tool : '', input: raw } });
/** The fields of a Codex item that say what it asked, by its type (what it got back and its state are not its input). */
const ITEM_INPUT: Record<string, readonly string[]> = {
  command_execution: ['command', 'cwd'], web_search: ['query', 'action'], file_change: ['changes', 'changesText', 'changesShown', 'changeCount'],
  collab_agent_tool_call: ['prompt', 'tool', 'model', 'receiverThreadIds'], image_view: ['path'],
};
const changedPaths = (changes: unknown) => (Array.isArray(changes) ? changes : []).map(object).filter(change => typeof change.path === 'string');
/** A Codex item's input as given: its type and the fields of it the record holds. */
function bridgeInput(item: Record<string, unknown>): Pick<ActivityEvent, 'detail' | 'about' | 'call'> {
  const fields = ITEM_INPUT[String(item.type)];
  if (!fields) {
    const call = toolCall(item.tool ?? item.name, item.arguments);
    return { ...call, call: { ...call.call!, clipped: clippedBy(item, 'arguments') } };
  }
  const input = Object.fromEntries(fields.filter(key => key in item).map(key => [key, item[key]]));
  const line = item.type === 'command_execution' ? shellScript(item.command, clippedUnder(item, ['command']) > 0) : item.type === 'web_search' ? firstText(item.query, object(item.action).url)
    : item.type === 'file_change' ? changedPaths(item.changes).map(change => change.path).join('  ') : item.type === 'image_view' ? item.path : item.prompt;
  return { detail: previewRunLine(line), call: { tool: `codex:${String(item.type)}`, input,
    clipped: Object.fromEntries(fields.map(key => [key, clippedUnder(item, [key])])) } };
}
/**
 * A step's input to read in full, from its call as given (the start's and end's put together field by field): the main
 * argument as written, then every other field by name. One rule for every agent: a Codex item's fields are said as its
 * type says them, any other tool's as toolInputDocument does.
 */
export function stepInputDocument(call: StepCall): string | undefined {
  const input = object(call.input);
  switch (call.tool) {
    case 'codex:command_execution': {
      const script = shellScript(input.command, (call.clipped?.command ?? 0) > 0);
      return inputDocument({ ...typeof script === 'string' ? { main: script } : {}, fields: 'cwd' in input ? { cwd: input.cwd } : {} });
    }
    case 'codex:web_search': {
      const query = firstText(input.query, object(input.action).url);
      return inputDocument({ ...query === undefined ? {} : { main: query }, fields: Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'query')) });
    }
    // As the bridge said it when its line was too long (changesText), else from the change list (the same text).
    case 'codex:file_change': return typeof input.changesText === 'string' ? input.changesText : ITEM_READABLE.changes!(input.changes);
    case 'codex:collab_agent_tool_call': {
      const { prompt, ...fields } = input;
      return inputDocument({ ...typeof prompt === 'string' ? { main: prompt } : {}, fields });
    }
    case 'codex:image_view': return typeof input.path === 'string' ? input.path : undefined;
    default: return toolInputDocument(call.tool, call.input);
  }
}
/** The fields that say one edit together: taken from one record, never mixed from two. */
const EDIT_FIELDS = ['changes', 'changesText', 'changesShown', 'changeCount'] as const;
/** What the bridge cut under one field of an item, by the field below it there ("" for the field cut whole). */
function clippedBy(item: Record<string, unknown>, field: string): Record<string, number> {
  const clipped = object(item.clipped), by: Record<string, number> = {};
  for (const [path, count] of Object.entries(clipped)) {
    const [head, below = ''] = path.split('.');
    if (head === field && typeof count === 'number') by[below] = (by[below] ?? 0) + count;
  }
  return by;
}
/**
 * One call from the records of a step's start and end, field by field: a field the end gives is the end's, even
 * empty; any other the start's. What the bridge cut is counted from the record each field was taken from. A call whose
 * input is not fields (a string) is the end's whole.
 */
export function joinStepCalls(start: StepCall | undefined, end: StepCall | undefined): StepCall | undefined {
  if (!start || !end) return end ?? start;
  const fields = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!fields(start.input) || !fields(end.input)) return end.input === undefined ? start : end;
  const input = { ...start.input as Record<string, unknown> }, clipped: Record<string, number> = { ...start.clipped };
  // An edit (its change list, that list's text, the files left out of it) is taken whole from one record: the end's
  // when it gives a change list, none of the start's mixed in.
  const ended = end.input as Record<string, unknown>;
  if (EDIT_FIELDS.some(key => ended[key] !== undefined)) for (const key of EDIT_FIELDS) { delete input[key]; delete clipped[key]; }
  for (const [key, value] of Object.entries(ended)) if (value !== undefined) {
    input[key] = value;
    clipped[key] = end.clipped?.[key] ?? 0;
  }
  return { tool: end.tool || start.tool, input, clipped };
}
/**
 * How many files of an edit the text opened does not show: all the edit's files (changeCount, else its change list)
 * less the headings that text shows whole. Those are counted as the text is built (fileChangesText's heading ends, or
 * the bridge's changesShown for a text it cut), never searched for in it, so a diff that reads like a heading is not one.
 * The one count, whether or not the bridge cut the line.
 */
export function hiddenFiles(call: StepCall, text: string): number {
  if (call.tool !== 'codex:file_change') return 0;
  const input = object(call.input), changes = Array.isArray(input.changes) ? input.changes : [];
  const total = typeof input.changeCount === 'number' ? input.changeCount : changes.length;
  // A text the bridge cut is shown as it came (it is within what a step shows), so its own count is the one shown.
  const shown = typeof input.changesText === 'string' ? (typeof input.changesShown === 'number' ? input.changesShown : 0)
    : headingsShown(fileChangesText(changes).headingEnds, text.length);
  return Math.max(0, total - shown);
}
/** How many characters the bridge cut from a call's input as it stands. */
export const callOmitted = (call: StepCall): number => Object.values(call.clipped ?? {}).reduce((sum, count) => sum + count, 0);

/** Where what a step got back is read, in order: the first that says something is shown, its own cut count with it. */
const OUTPUT_FIELDS = ['aggregatedOutput', 'result', 'contentItems', 'error'] as const;
function bridgeOutcome(item: Record<string, unknown>): NonNullable<ActivityEvent['outcome']> {
  const result = object(item.result);
  const said = OUTPUT_FIELDS.map(field => ({ field, text: item[field] === undefined || item[field] === null ? '' : ITEM_READABLE[field]!(item[field]) }))
    .find(each => each.text !== '');
  return {
    result: previewRunLine(said?.text),
    ...said ? { output: { text: said.text, omitted: clippedUnder(item, [said.field]) } } : {},
    failed: item.status === 'failed' || item.status === 'declined' || item.success === false ||
      result.isError === true || item.resultIsError === true || (typeof item.exitCode === 'number' && item.exitCode !== 0),
    // Its details dropped with nothing left that says how it went, whether it went well is not known.
    ...item.detailsDropped === true && STATE_FIELDS.every(field => item[field] === undefined) ? { unknown: true as const } : {},
  };
}
/** The fields of an item that say how its step went. */
const STATE_FIELDS = ['status', 'exitCode', 'success', 'resultIsError'] as const;

export function claudeActivity(value: unknown, received: string): ActivityEvent[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = object(value), at = eventAt(row, received);
  if (row.type === 'result') return [{ at, kind: row.is_error === true ? 'error' : 'result' }];
  if (row.type === 'error') return [{ at, kind: 'error' }];
  if (row.type === 'assistant' || row.type === 'user') {
    const content = object(row.message).content;
    const blocks = (Array.isArray(content) ? content : []).map(object);
    const rootAssistant = row.type === 'assistant' && row.parent_tool_use_id === null;
    const hasWords = rootAssistant && blocks.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim());
    const events = blocks.flatMap((block): ActivityEvent[] => {
      if (row.type === 'assistant' && block.type === 'tool_use') return [{ at, kind: 'tool_start',
        toolName: block.name, id: block.id, ...toolCall(block.name, block.input),
        ...typeof row.parent_tool_use_id === 'string' ? { parent: row.parent_tool_use_id } : {},
        command: rootAssistant && block.name === 'Bash' ? commandOf(object(block.input).command) : null }];
      if (row.type === 'user' && block.type === 'tool_result') {
        const output = toolResultText(block.content);
        return [{ at, kind: 'tool_end', id: block.tool_use_id,
          outcome: { result: previewRunLine(output), failed: block.is_error === true, ...output === undefined ? {} : { output: whole(output) } } }];
      }
      if (rootAssistant && block.type === 'text') return [{ at, kind: 'message', text: block.text }];
      // Claude can emit progress updates in thinking blocks. Only short, top-level notes serve as progress text.
      if (rootAssistant && !hasWords && block.type === 'thinking' && typeof block.thinking === 'string') {
        const summary = block.thinking.trim();
        if (summary && summary.length <= RUN_NOTE_LIMIT) return [{ at, kind: 'message', text: summary }];
      }
      return [];
    });
    return events.length ? events : [{ at, kind: 'output' }];
  }
  return [{ at, kind: 'output' }];
}

export function bridgeActivity(value: unknown, received: string): ActivityEvent[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = object(value), at = eventAt(row, received);
  // How full the conversation is says nothing of the work: the step shown stays (runs/activity keeps the fill apart).
  if (row.type === 'context.updated') return [];
  if (row.type === 'error' || row.type === 'turn.failed') return [{ at, kind: 'error' }];
  if (row.type === 'turn.completed') return [{ at, kind: 'result' }];
  if (row.type === 'tool.started' || row.type === 'tool.completed') {
    const parsed = bridgeToolEventSchema.safeParse(row);
    if (!parsed.success) return [];
    const event = parsed.data;
    const identity = { at, id: event.id, toolName: event.tool, stepTool: event.name };
    return event.type === 'tool.started'
      ? [{ ...identity, kind: 'tool_start', detail: event.detail, about: event.about, ...event.input ? { input: event.input } : {} }]
      : [{ ...identity, kind: 'tool_end', outcome: { result: event.result, failed: event.failed, ...event.output ? { output: event.output } : {} } }];
  }
  const item = object(row.item);
  if (row.type === 'item.completed' && item.type === 'agent_configuration' && typeof item.model === 'string' &&
    typeof item.effective_effort === 'string' && (item.requested_effort === null || typeof item.requested_effort === 'string'))
    return [{ at, kind: 'message', text: `Model: ${item.model}; effort: ${item.effective_effort} (requested: ${item.requested_effort ?? 'unspecified'})` }];
  if (item.type === 'error') return [{ at, kind: 'error' }];
  if (typeof item.type === 'string' && bridgeTools.has(item.type) &&
      (row.type === 'item.started' || row.type === 'item.completed')) {
    const toolName = item.type === 'collab_agent_tool_call' ? 'collab_tool_call' : item.type;
    const stepTool = item.type === 'mcp_tool_call' || item.type === 'dynamic_tool_call'
      ? [item.server ?? item.namespace, item.tool ?? item.name].filter(value => typeof value === 'string').join('.')
      : item.name;
    return [{ at, kind: row.type === 'item.started' ? 'tool_start' : 'tool_end', toolName, stepTool, id: item.id,
      ...bridgeInput(item), command: row.type === 'item.started' && item.type === 'command_execution' ? commandOf(item.command) : null,
      ...(row.type === 'item.completed' ? { outcome: bridgeOutcome(item) } : {}), ...item.detailsDropped === true ? { dropped: true as const } : {} }];
  }
  if (item.type === 'agent_message') return [{ at, kind: 'message', text: item.text }];
  return [{ at, kind: 'output' }];
}
