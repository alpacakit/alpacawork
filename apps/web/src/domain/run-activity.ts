import type { RunStep } from '@alpacawork/contract/run';

/** A quiet output is an observation about stdout, never evidence that a Run has stopped. */
const QUIET_OUTPUT_MS = 10 * 60_000;
export const outputIsQuiet = (lastOutput: number | null, now: number): lastOutput is number =>
  lastOutput !== null && now - lastOutput >= QUIET_OUTPUT_MS;

/** Codex names its items by their type; said as the tool names other agents give. Any other tool keeps its own name. */
const ITEM_NAMES: Record<string, string> = { command_execution: 'Bash', file_change: 'Edit', web_search: 'WebSearch', mcp_tool_call: 'MCP', collab_tool_call: 'Agent' };
export const toolName = (tool: string): string => ITEM_NAMES[tool] ?? tool;

/**
 * The step a Run is waiting on: its latest one still running. A Run with none is not waiting on a step, so its silence
 * is its own.
 */
export function awaitedStep(steps: readonly RunStep[] | undefined): RunStep | null {
  return (steps ?? []).filter(each => each.state === 'running').at(-1) ?? null;
}
