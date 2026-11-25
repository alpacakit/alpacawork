/**
 * Every step of one Run, read from its stdout when someone opens them, through the same adapter events as the activity
 * projection (which keeps only the latest few, each on one line). Nothing is kept: each read is taken again.
 */
import { closeSync, fstatSync, readSync } from 'node:fs';
import { constants } from 'node:fs';
import { RUN_FILES, RUN_STEPS_READ_LIMIT, RUN_STEP_FULL_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, clipRunText,
  type RunFullStep, type RunStepText, type RunStepsRead } from '@alpacawork/contract/run';
import type { AgentAdapter } from '../agents/adapters/types.js';
import type { ActivityEvent } from './activity-events.js';
import { openRunFile } from './files.js';
import { runStepKind } from './recent-work.js';

/** How much of the end of stdout is read: the activity projection's own bound for one poll. */
export const RUN_STEPS_TAIL = 8 * 1024 * 1024;
type Settled = Exclude<RunFullStep['state'], 'running'>;

const shown = (value: string): RunStepText => {
  const text = clipRunText(value, RUN_STEP_FULL_TEXT_LIMIT);
  return { text, cut: text.length < value.length };
};
const name = (value: unknown) => typeof value === 'string' ? clipRunText(value, RUN_TOOL_NAME_LIMIT) || null : null;

/** The end of stdout as text, from its first whole line; `unread` when there was more before it. */
function tail(folder: string, limit: number): { text: string; unread: boolean } {
  let fd: number;
  try { fd = openRunFile(folder, RUN_FILES.stdout, constants.O_RDONLY); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', unread: false };
    throw error;
  }
  try {
    const size = fstatSync(fd).size, length = Math.min(size, limit), bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, bytes, read, length - read, size - length + read);
      if (!count) break;
      read += count;
    }
    const kept = bytes.subarray(0, read);
    if (length === size) return { text: kept.toString('utf8'), unread: false };
    const start = kept.indexOf(10);
    return { text: start === -1 ? '' : kept.subarray(start + 1).toString('utf8'), unread: true };
  } finally { closeSync(fd); }
}

/** Folds adapter events into steps by tool call: started running, ended done or failed, as the projection decides them. */
export class StepFold {
  private readonly steps = new Map<string, RunFullStep>();

  observe(event: ActivityEvent): void {
    const { kind, id } = event;
    if (kind === 'result' || kind === 'error') { this.settle(kind === 'result' ? 'done' : 'failed'); return; }
    if ((kind !== 'tool_start' && kind !== 'tool_end') || typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) return;
    const known = this.steps.get(id);
    const input = event.input ?? event.detail?.text;
    if (kind === 'tool_start' || !known) {
      const toolName = name(event.toolName);
      if (!toolName) return;
      const tool = name(event.stepTool) ?? toolName;
      this.steps.set(id, { id, tool, kind: runStepKind(tool, toolName, event.command ?? null), about: event.about ?? null,
        state: 'running', input: shown(input ?? ''), output: null });
    } else if (input && !known.input.text) known.input = shown(input);
    if (kind === 'tool_end') {
      const step = this.steps.get(id)!, output = event.outcome?.output ?? event.outcome?.result.text;
      step.state = event.outcome?.failed ? 'failed' : 'done';
      step.output = output ? shown(output) : null;
    }
  }

  /** What is still running when the agent's turn ended (or the Run did) ended with it. */
  settle(state: Settled): void {
    for (const step of this.steps.values()) if (step.state === 'running') step.state = state;
  }

  read(unread: boolean): RunStepsRead {
    const all = [...this.steps.values()];
    return { steps: all.slice(-RUN_STEPS_READ_LIMIT), older: Math.max(0, all.length - RUN_STEPS_READ_LIMIT), unread };
  }
}

/**
 * Every step in the Run's stdout, oldest first, the latest `RUN_STEPS_READ_LIMIT` of them. A line that is not JSON is
 * passed over; no stdout reads as no steps. `ended`: how the Run ended, for steps its output left running; null while
 * it runs.
 */
export function readRunSteps(folder: string, adapter: AgentAdapter, ended: Settled | null, limit = RUN_STEPS_TAIL): RunStepsRead {
  const { text, unread } = tail(folder, limit);
  const fold = new StepFold(), received = new Date().toISOString();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    for (const event of adapter.activity(value, received)) fold.observe(event);
  }
  if (ended) fold.settle(ended);
  return fold.read(unread);
}
