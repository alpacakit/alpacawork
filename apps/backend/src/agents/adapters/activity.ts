/** Translate native Claude and common bridge stdout events for the activity projection. */
import { bridgeToolEventSchema } from '@alpacawork/contract/agent-bridge';
import { RUN_NOTE_LIMIT, previewRunLine, previewToolInput, toolInputDocument, toolResultText, type RunStepText } from '@alpacawork/contract/run';
import type { ActivityEvent } from '../../runs/activity-events.js';
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
/** Codex wraps every command in one login shell; the script inside is what the agent wrote. */
function shellScript(command: unknown): unknown {
  if (typeof command !== 'string') return command;
  const wrapped = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh) -l?c (['"])([\s\S]*)\1$/.exec(command);
  if (!wrapped) return command;
  return wrapped[1] === "'" ? wrapped[2]!.replaceAll(`'\\''`, "'").replaceAll(`'"'"'`, "'") : wrapped[2]!.replace(/\\(["\\$`])/g, '$1');
}
/** All of a text as the output holds it: the step's opened view bounds it. */
const whole = (text: string): RunStepText => ({ text, omitted: 0 });
/** A step's input as a preview and as written (absent when it is no text). */
const written = (value: unknown, all: unknown = value): Pick<ActivityEvent, 'detail' | 'input'> =>
  ({ detail: previewRunLine(value), ...typeof all === 'string' ? { input: whole(all) } : {} });
/** A named tool's call: its preview, the agent's words for it, and its whole input as written. */
function toolCall(tool: unknown, raw: unknown): Pick<ActivityEvent, 'detail' | 'about' | 'input'> {
  const document = toolInputDocument(tool, raw);
  return { ...previewToolInput(tool, raw), ...document === undefined ? {} : { input: whole(document) } };
}
function bridgeInput(item: Record<string, unknown>): Pick<ActivityEvent, 'detail' | 'about' | 'input'> {
  switch (item.type) {
    case 'command_execution': return written(shellScript(item.command));
    case 'web_search': return written(firstText(item.query, object(item.action).url));
    case 'file_change': {
      const changes = (Array.isArray(item.changes) ? item.changes : []).map(object).filter(change => typeof change.path === 'string');
      return written(changes.map(change => change.path).join('  '),
        changes.map(change => typeof change.kind === 'string' ? `${change.kind}: ${change.path}` : String(change.path)).join('\n'));
    }
    case 'collab_agent_tool_call': return written(item.prompt);
    case 'image_view': return written(item.path);
    default: return toolCall(item.tool ?? item.name, item.arguments);
  }
}

function bridgeOutcome(item: Record<string, unknown>): NonNullable<ActivityEvent['outcome']> {
  const result = object(item.result);
  const output = firstText(item.aggregatedOutput, toolResultText(item.result), toolResultText(result.content),
    toolResultText(item.contentItems), object(item.error).message);
  return {
    result: previewRunLine(output), ...output === undefined ? {} : { output: whole(output) },
    failed: item.status === 'failed' || item.status === 'declined' || item.success === false ||
      result.isError === true || (typeof item.exitCode === 'number' && item.exitCode !== 0),
  };
}

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
      ...(row.type === 'item.completed' ? { outcome: bridgeOutcome(item) } : {}) }];
  }
  if (item.type === 'agent_message') return [{ at, kind: 'message', text: item.text }];
  return [{ at, kind: 'output' }];
}
