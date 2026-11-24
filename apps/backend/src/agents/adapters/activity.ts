/** Translate native Claude and common bridge stdout events for the activity projection. */
import { RUN_NOTE_LIMIT } from '@alpacawork/contract/run';
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
const inputText = (input: unknown) => input == null ? undefined : typeof input === 'string' ? input : JSON.stringify(input);

/** Pick the human-readable argument when the tool gives it a named field. */
function toolInput(tool: unknown, raw: unknown): { detail: unknown; about?: unknown } {
  const input = object(raw);
  switch (tool) {
    case 'Bash': return { detail: input.command, about: input.description };
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return { detail: firstText(input.file_path, input.path, input.notebook_path) };
    case 'Grep': return { detail: [input.pattern, firstText(input.path, input.glob)].filter(value => typeof value === 'string').join('  ') };
    case 'Glob': return { detail: [input.pattern, input.path].filter(value => typeof value === 'string').join('  ') };
    case 'WebSearch': case 'ToolSearch': return { detail: input.query };
    case 'WebFetch': return { detail: input.url };
    case 'Agent': case 'Task': return { detail: firstText(input.description, input.prompt) };
    case 'Skill': return { detail: [input.skill, input.args].filter(value => typeof value === 'string').join(' ') };
    default:
      if (typeof input.command === 'string') return { detail: input.command, about: input.description };
      return { detail: firstText(input.file_path, input.path, input.query, input.url) ?? inputText(raw) };
  }
}

/** Take only text from a tool result's content blocks. */
function resultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map(object).filter(block => block.type === 'text' || block.type === 'inputText')
    .flatMap(block => typeof block.text === 'string' ? [block.text] : []).join('\n');
}

/** Codex wraps every command in one login shell; the script inside is what the agent wrote. */
function shellScript(command: unknown): unknown {
  if (typeof command !== 'string') return command;
  const wrapped = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh) -l?c (['"])([\s\S]*)\1$/.exec(command);
  if (!wrapped) return command;
  return wrapped[1] === "'" ? wrapped[2]!.replaceAll(`'\\''`, "'").replaceAll(`'"'"'`, "'") : wrapped[2]!.replace(/\\(["\\$`])/g, '$1');
}
function bridgeInput(item: Record<string, unknown>): ReturnType<typeof toolInput> {
  switch (item.type) {
    case 'command_execution': {
      const input = toolInput(item.name, item.arguments);
      return { ...input, detail: shellScript(item.command) ?? input.detail };
    }
    case 'web_search': return { detail: firstText(item.query, object(item.action).url) };
    case 'file_change': return { detail: (Array.isArray(item.changes) ? item.changes : [])
      .map(value => object(value).path).filter(path => typeof path === 'string').join('  ') };
    case 'collab_agent_tool_call': return { detail: item.prompt };
    case 'image_view': return { detail: item.path };
    default: return toolInput(item.name ?? item.tool, item.arguments);
  }
}

function bridgeOutcome(item: Record<string, unknown>): NonNullable<ActivityEvent['outcome']> {
  const result = object(item.result);
  return {
    text: firstText(item.aggregatedOutput, resultText(item.result), resultText(result.content), resultText(item.contentItems),
      object(item.error).message),
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
        toolName: block.name, id: block.id, ...toolInput(block.name, block.input),
        command: rootAssistant && block.name === 'Bash' ? commandOf(object(block.input).command) : null }];
      if (row.type === 'user' && block.type === 'tool_result') return [{ at, kind: 'tool_end', id: block.tool_use_id,
        outcome: { text: resultText(block.content), failed: block.is_error === true } }];
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
  if (row.type === 'error' || row.type === 'turn.failed') return [{ at, kind: 'error' }];
  if (row.type === 'turn.completed') return [{ at, kind: 'result' }];
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
