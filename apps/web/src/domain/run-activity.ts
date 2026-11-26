import type { RunStep } from '@alpacawork/contract/run';

/** A quiet output is an observation about stdout, never evidence that a Run has stopped. */
const QUIET_OUTPUT_MS = 10 * 60_000;
export const outputIsQuiet = (lastOutput: number | null, now: number): lastOutput is number =>
  lastOutput !== null && now - lastOutput >= QUIET_OUTPUT_MS;

/** Commands that only set up or tidy around what is waited on: the program the agent waits on is another one. */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'unset', 'mkdir', 'rm', 'cp', 'mv', 'ln', 'touch',
  'chmod', 'echo', 'printf', 'ls', 'true', 'false', ':', '[', '[[', 'test', 'trap', 'local', 'declare', 'done', 'fi', 'esac', '}', ')']);
/** Words that open a command without being it: wrappers and the shell's own words before a command. */
const OPENERS = new Set(['sudo', 'env', 'nohup', 'time', 'exec', 'command', 'nice', 'stdbuf', 'until', 'while', 'if', 'then',
  'do', 'else', 'elif', '!', '{', '(']);
/** Parts that are a loop's or a choice's head, whose words are not a command. */
const HEADS = new Set(['for', 'select', 'case']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

/**
 * The program a command line runs, as a person would name it: the first one that is not setting up or tidying
 * (`cd x && rm -rf y; gh run watch 1` is `gh`), past variables, wrappers and the shell's own words (`until gh run view
 * 1; do sleep 30; done` is `gh`), inside `bash -c '…'`, without its folder; else the first program there is. Only a
 * name to show; empty when the line names none.
 */
export function programOf(line: string): string {
  const shell = /^\s*(?:\S*\/)?(\w+)\s+-[a-z]*c\s+(['"])([\s\S]*?)\2?\s*$/.exec(line);
  if (shell && SHELLS.has(shell[1]!)) return programOf(shell[3]!);
  let first = '';
  for (const part of line.split(/&&|\|\||;|\n/).map(each => each.split('|')[0]!.trim()).filter(Boolean)) {
    const words = part.split(/\s+/);
    if (HEADS.has(words[0]!)) continue;
    let at = 0;
    while (at < words.length) {
      const word = words[at]!;
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(word) || OPENERS.has(word) || word.startsWith('-') && at > 0) at++;
      else if (word === 'timeout') { at++; while (at < words.length && /^-|^\d/.test(words[at]!)) at++; }
      else break;
    }
    const program = (words[at] ?? '').replace(/^['"(]+|['");]+$/g, '').split('/').pop() ?? '';
    if (!program) continue;
    if (!SETUP.has(program)) return program;
    first ||= program;
  }
  return first;
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
