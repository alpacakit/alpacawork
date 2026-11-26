import type { RunStep } from '@alpacawork/contract/run';

/** A quiet output is an observation about stdout, never evidence that a Run has stopped. */
const QUIET_OUTPUT_MS = 10 * 60_000;
export const outputIsQuiet = (lastOutput: number | null, now: number): lastOutput is number =>
  lastOutput !== null && now - lastOutput >= QUIET_OUTPUT_MS;

/** Words before a command that only set it up or wrap it: the program the agent waits on comes after them. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'unset', 'mkdir']);
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'nice', 'stdbuf']);

/**
 * The program a command line runs, as a person would name it: its first part that is not setting up (`cd x && gh run
 * watch 1` is `gh`), past variables and wrappers (`FOO=1 timeout 60 ffmpeg` is `ffmpeg`), without its folder. Only a
 * name to show; empty when the line does not start with one.
 */
export function programOf(line: string): string {
  const parts = line.split(/&&|\|\||;/).map(part => part.split('|')[0]!.trim()).filter(Boolean);
  for (const part of parts) {
    const words = part.split(/\s+/);
    let at = 0;
    while (at < words.length) {
      const word = words[at]!;
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(word) || WRAPPERS.has(word) || word.startsWith('-') && at > 0) at++;
      else if (word === 'timeout') { at++; while (at < words.length && /^-|^\d/.test(words[at]!)) at++; }
      else break;
    }
    const program = (words[at] ?? '').replace(/^['"(]+|['")]+$/g, '').split('/').pop() ?? '';
    if (program && !SETUP.has(program)) return program;
  }
  return '';
}

/** Codex names its items by their type; said as the tool names other agents give. Any other tool keeps its own name. */
const ITEM_NAMES: Record<string, string> = { command_execution: 'Bash', file_change: 'Edit', web_search: 'WebSearch', mcp_tool_call: 'MCP', collab_tool_call: 'Agent' };
export const toolName = (tool: string): string => ITEM_NAMES[tool] ?? tool;

/** A step a Run is still waiting on, with the short name a list shows for it. */
export type AwaitedStep = { name: string; step: RunStep };

/**
 * The step a Run is waiting on: its latest one still running, named by the program a command runs or else by its
 * tool. A Run with none is not waiting on a step, so its silence is its own.
 */
export function awaitedStep(steps: readonly RunStep[] | undefined): AwaitedStep | null {
  const step = (steps ?? []).filter(each => each.state === 'running').at(-1);
  if (!step) return null;
  return { name: (step.kind === 'command' ? programOf(step.text) : '') || toolName(step.tool), step };
}
