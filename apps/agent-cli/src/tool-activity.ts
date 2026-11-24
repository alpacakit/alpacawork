import type { BridgeToolEvent } from '@alpacawork/contract/agent-bridge';
import { RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, clipRunText, previewRunLine, previewToolInput } from '@alpacawork/contract/run';
import type { RuntimeIO } from './run.js';

function identity(tool: BridgeToolEvent['tool'], id: unknown, name: unknown) {
  if (typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) return null;
  return { id, tool, name: typeof name === 'string' ? clipRunText(name, RUN_TOOL_NAME_LIMIT) || null : null };
}

export function emitToolStart(io: RuntimeIO, tool: BridgeToolEvent['tool'], id: unknown, name: unknown, args: unknown): void {
  const key = identity(tool, id, name);
  if (key) io.emit({ type: 'tool.started', ...key, ...previewToolInput(name, args) });
}

export function emitToolEnd(io: RuntimeIO, tool: BridgeToolEvent['tool'], id: unknown, name: unknown, result: unknown, failed: boolean): void {
  const key = identity(tool, id, name);
  if (key) io.emit({ type: 'tool.completed', ...key, result: previewRunLine(result), failed });
}
