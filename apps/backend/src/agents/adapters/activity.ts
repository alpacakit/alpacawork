/** Native and common-boundary activity translation. Storage, bounds and timestamps stay in runs/activity. */
import type { ActivityEvent } from '../../runs/activity-events.js';
import { commandOf } from '../../runs/shell-command.js';
import { object } from './output.js';
const codexTools = new Set(['command_execution', 'file_change', 'web_search', 'mcp_tool_call', 'collab_tool_call']);
const eventAt = (row: Record<string, unknown>, received: string) => {
  const date = typeof row.timestamp === 'string' ? new Date(row.timestamp) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : received;
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

/** What a Claude tool was given, in the one field that says it; any other tool shows its input as written. */
function claudeDetail(tool: unknown, input: Record<string, unknown>): { detail: unknown; about?: unknown } {
  const first = (...keys: string[]) => keys.map(key => input[key]).find(value => typeof value === 'string' && value);
  switch (tool) {
    case 'Bash': return { detail: input.command, about: input.description };
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return { detail: first('file_path', 'notebook_path') };
    case 'Grep': return { detail: [input.pattern, first('path', 'glob')].filter(value => typeof value === 'string' && value).join('  ') };
    case 'Glob': return { detail: [input.pattern, input.path].filter(value => typeof value === 'string' && value).join('  ') };
    case 'WebSearch': case 'ToolSearch': return { detail: input.query };
    case 'WebFetch': return { detail: input.url };
    case 'Agent': case 'Task': return { detail: first('description', 'prompt') };
    case 'Skill': return { detail: [input.skill, input.args].filter(value => typeof value === 'string' && value).join(' ') };
    default: return { detail: Object.keys(input).length ? JSON.stringify(input) : '' };
  }
}
/** The text of a tool result, whose content is a string or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : []).map(value => { const block = object(value); return block.type === 'text' && typeof block.text === 'string' ? block.text : ''; }).join('\n');
}
/** Codex wraps every command in one login shell; the script inside is what the agent wrote. */
function shellScript(command: unknown): unknown {
  if (typeof command !== 'string') return command;
  const wrapped = /^(?:\/bin\/|\/usr\/bin\/)?(?:bash|sh) -l?c (['"])([\s\S]*)\1$/.exec(command);
  if (!wrapped) return command;
  return wrapped[1] === "'" ? wrapped[2]!.replaceAll(`'\\''`, "'").replaceAll(`'"'"'`, "'") : wrapped[2]!.replace(/\\(["\\$`])/g, '$1');
}
function bridgeDetail(item: Record<string, unknown>): unknown {
  switch (item.type) {
    case 'command_execution': return shellScript(item.command);
    case 'web_search': return item.query;
    case 'file_change': return (Array.isArray(item.changes) ? item.changes : []).map(value => object(value).path).filter(path => typeof path === 'string').join('  ');
    case 'mcp_tool_call': return [item.server, item.tool ?? item.name].filter(value => typeof value === 'string' && value).join('.');
    default: return '';
  }
}

export function claudeActivity(value: unknown, received: string): ActivityEvent[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const row = object(value), at = eventAt(row, received);
  if (row.type === 'result') return [{ at, kind: row.is_error === true ? 'error' : 'result' }];
  if (row.type === 'error') return [{ at, kind: 'error' }];
  if (row.type === 'assistant' || row.type === 'user') {
    const content = object(row.message).content;
    const events = (Array.isArray(content) ? content : []).flatMap((value): ActivityEvent[] => {
      const block = object(value);
      if (row.type === 'assistant' && block.type === 'tool_use') return [{ at, kind: 'tool_start',
        toolName: block.name, id: block.id, ...claudeDetail(block.name, object(block.input)),
        command: row.parent_tool_use_id === null && block.name === 'Bash' ? commandOf(object(block.input).command) : null }];
      if (row.type === 'user' && block.type === 'tool_result') return [{ at, kind: 'tool_end', id: block.tool_use_id,
        outcome: { text: resultText(block.content), failed: block.is_error === true } }];
      if (row.type === 'assistant' && row.parent_tool_use_id === null && block.type === 'text')
        return [{ at, kind: 'message', text: block.text }];
      // Between tool calls the agent's passing words come as the summary of its thinking; an empty one says nothing.
      if (row.type === 'assistant' && row.parent_tool_use_id === null && block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim())
        return [{ at, kind: 'message', text: block.thinking }];
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
  if (typeof item.type === 'string' && codexTools.has(item.type)) {
    if (row.type === 'item.started') return [{ at, kind: 'tool_start', toolName: item.type, id: item.id, detail: bridgeDetail(item),
      command: item.type === 'command_execution' ? commandOf(item.command) : null }];
    // A search names its query only once it is done.
    if (row.type === 'item.completed') return [{ at, kind: 'tool_end', toolName: item.type, id: item.id, detail: bridgeDetail(item),
      outcome: { text: item.aggregatedOutput ?? item.aggregated_output, failed: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) } }];
  }
  if (item.type === 'agent_message') return [{ at, kind: 'message', text: item.text }];
  return [{ at, kind: 'output' }];
}
