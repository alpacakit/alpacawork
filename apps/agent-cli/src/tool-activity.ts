import type { BridgeToolEvent } from '@alpacawork/contract/agent-bridge';
import { RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, clipRunText, fullRunText, previewRunLine, previewToolInput, toolInputDocument } from '@alpacawork/contract/run';
import type { RuntimeIO } from './run.js';

function identity(tool: BridgeToolEvent['tool'], id: unknown, name: unknown) {
  if (typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) return null;
  return { id, tool, name: typeof name === 'string' ? clipRunText(name, RUN_TOOL_NAME_LIMIT) || null : null };
}

export function emitToolStart(io: Pick<RuntimeIO, 'emit'>, tool: BridgeToolEvent['tool'], id: unknown, name: unknown, args: unknown): void {
  const key = identity(tool, id, name);
  if (!key) return;
  // The whole input goes with its preview, bounded as a step's opened text is, so opening the step reads all of it.
  const input = toolInputDocument(name, args);
  io.emit({ type: 'tool.started', ...key, ...previewToolInput(name, args), ...input === undefined ? {} : { input: fullRunText(input) } });
}

export function emitToolEnd(io: Pick<RuntimeIO, 'emit'>, tool: BridgeToolEvent['tool'], id: unknown, name: unknown, result: unknown, failed: boolean): void {
  const key = identity(tool, id, name);
  if (key) io.emit({ type: 'tool.completed', ...key, result: previewRunLine(result), failed,
    ...typeof result === 'string' ? { output: fullRunText(result) } : {} });
}
