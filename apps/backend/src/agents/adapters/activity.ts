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
        toolName: block.name, id: block.id,
        command: row.parent_tool_use_id === null && block.name === 'Bash' ? commandOf(object(block.input).command) : null }];
      if (row.type === 'user' && block.type === 'tool_result') return [{ at, kind: 'tool_end', id: block.tool_use_id }];
      if (row.type === 'assistant' && row.parent_tool_use_id === null && block.type === 'text')
        return [{ at, kind: 'message', text: block.text }];
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
    if (row.type === 'item.started') return [{ at, kind: 'tool_start', toolName: item.type, id: item.id,
      command: item.type === 'command_execution' ? commandOf(item.command) : null }];
    if (row.type === 'item.completed') return [{ at, kind: 'tool_end', toolName: item.type, id: item.id }];
  }
  if (item.type === 'agent_message') return [{ at, kind: 'message', text: item.text }];
  return [{ at, kind: 'output' }];
}
