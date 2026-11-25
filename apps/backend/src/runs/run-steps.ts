/**
 * Every step of one Run, read from its stdout through the same adapter events as the activity projection (which keeps
 * only the latest few, each on one line), when someone opens them.
 *
 * The output is read once, front to back, into an index of steps: each step's one line, its state, and where in the
 * file the lines that started and ended it are. A list is a range of that index; what one step ran and got back is
 * read again from its own lines when it is opened. Output only grows, so a later read goes on from where the last one
 * stopped. Nothing but the index is held.
 *
 * Every change to a step (it starts, ends, or is settled) takes the next number of the index's version, so a list
 * already shown asks only for what changed after the version it holds, wherever in the Run those steps are.
 *
 * A line that cannot be read (not JSON, or too long to read) may hold the end of any step running when it came: such a
 * step ends `unknown` unless a later line says how it ended.
 */
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RUN_FILES, RUN_STEPS_PAGE_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, clipRunText, fullRunText,
  type RunStepDetail, type RunStepEntry, type RunStepLine, type RunStepText, type RunStepsPage } from '@alpacawork/contract/run';
import type { AgentAdapter } from '../agents/adapters/types.js';
import type { ActivityEvent } from './activity-events.js';
import { runStepKind } from './recent-work.js';
import { STEP_LINE_LIMIT } from './readers/jsonl.js';
import { callOmitted, hiddenFiles, joinStepCalls, stepInputDocument } from '../agents/adapters/activity.js';
import { readStepJournalFrom } from './step-journal.js';
import { RunStore } from '@alpacawork/runs';
import { isRunMoving, runFolder } from '@alpacawork/contract/run';
import { runtimeAdapter } from '../agents/registry.js';

/**
 * The longest output line read as one row: the live activity's (STEP_LINE_LIMIT), so the steps listed are the steps it
 * counts. A longer one is passed over as any row that is not JSON is: a step it would have started is missed in both.
 */
export const RUN_STEPS_LINE_LIMIT = STEP_LINE_LIMIT;
const CHUNK = 1024 * 1024;
type Settled = 'done' | 'failed';
type Step = Omit<RunStepEntry, 'n' | Timed | 'subagentSteps'> & { start: number; end: number | null;
  /** The number (from 0) of the output line that started it: with its ID, how the step journal names it. */ line: number;
  /** A line that could not be read came while it ran. */ unsure: boolean };
/** What of a step only its Run's step journal knows. */
type Timed = 'startedAt' | 'startSource' | 'endedAt' | 'endSource' | 'fingerprint' | 'output';
const untimed: Pick<RunStepEntry, Timed> = { startedAt: null, startSource: null, endedAt: null, endSource: null, fingerprint: null, output: null };

const name = (value: unknown) => typeof value === 'string' ? clipRunText(value, RUN_TOOL_NAME_LIMIT) || null : null;
const parse = (line: Buffer): unknown => {
  try { return JSON.parse(line.toString('utf8')); } catch { return undefined; }
};

/**
 * A generation no reading has had in this server, nor (counted on from when it started) in one before it: an index
 * read again from the start, because its output was replaced or because it was let go and read anew, never answers
 * with a generation a list of the earlier reading holds.
 */
let generations = Date.now();
const nextGeneration = () => ++generations;

/** One Run's index of steps, read on from where it stopped each time it is asked. */
export class RunStepIndex {
  private readonly steps: Step[] = [];
  /** The step a tool call's ID names now: an ID used again after its step ended starts another. */
  private readonly byId = new Map<string, number>();
  /** How many steps each sub-agent's step (by its tool call ID) took. */
  private readonly inside = new Map<string, number>();
  /** The step journal's times, by the line and ID that name each step, as last read. */
  private times = new Map<string, Pick<RunStepEntry, Timed>>();
  /** Where the next read of the step journal starts. */
  private journalOffset = 0;
  private offset = 0;
  /** The number of the output line that starts at `offset`. */
  private lines = 0;
  private file: string | null = null;
  private version = 0;
  /** Which reading of the output from its start this is (nextGeneration): a list of another is not this one's. */
  private generation = 0;
  /** How the Run ended, once it has: what its output left running is settled so, and its last line is whole. */
  private ended: Settled | null = null;

  constructor(private readonly folder: string, private readonly adapter: AgentAdapter) {}

  private observe(event: ActivityEvent, at: number, line: number): void {
    const { kind, id } = event;
    if (kind === 'result' || kind === 'error') { this.settle(kind === 'result' ? 'done' : 'failed'); return; }
    if ((kind !== 'tool_start' && kind !== 'tool_end') || typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) return;
    const index = this.byId.get(id);
    let step = index === undefined ? undefined : this.steps[index];
    if (!step || kind === 'tool_start' && step.state !== 'running') {
      const toolName = name(event.toolName);
      if (!toolName) return;
      const tool = name(event.stepTool) ?? toolName;
      const parent = typeof event.parent === 'string' && event.parent ? event.parent : null;
      step = { id, tool, kind: runStepKind(tool, toolName, event.command ?? null), ...(event.detail ?? { text: '', more: 0 }),
        about: event.about ?? null, state: 'running', start: at, end: null, line, parent, changed: 0, unsure: false };
      this.byId.set(id, this.steps.push(step) - 1);
      if (parent !== null) {
        this.inside.set(parent, (this.inside.get(parent) ?? 0) + 1);
        // The parent's count of steps inside it changed: a list holding it takes it again.
        const above = this.byId.get(parent);
        if (above !== undefined) this.steps[above]!.changed = ++this.version;
      }
    } else if (event.detail?.text) Object.assign(step, event.detail);
    if (kind === 'tool_end') {
      step.state = event.outcome?.unknown ? 'unknown' : event.outcome?.failed ? 'failed' : 'done'; step.end = at; step.unsure = false;
    }
    step.changed = ++this.version;
  }

  /** What is still running when the agent's turn ended ended with it, or ended unknown when its end may be unread. */
  private settle(state: Settled): void {
    for (const step of this.steps) if (step.state === 'running') {
      step.state = step.unsure ? 'unknown' : state;
      step.changed = ++this.version;
    }
  }

  /** A line that could not be read: any step running now may have ended in it. */
  private unreadable(): void {
    for (const step of this.steps) if (step.state === 'running') step.unsure = true;
  }

  private accept(line: Buffer, at: number, number: number): void {
    const value = parse(line);
    if (value === undefined) { this.unreadable(); return; }
    for (const event of this.adapter.activity(value, new Date().toISOString())) this.observe(event, at, number);
  }

  /**
   * Reads what the output gained since the last read; a file that was replaced is read again from its start, as the
   * next generation. While the Run goes on, a last line with no line end may still be written and waits; once the Run
   * has ended (`ended`), it is whole and read as the others are.
   */
  async update(ended: Settled | null = null): Promise<void> {
    this.ended ??= ended;
    let handle: FileHandle;
    try { handle = await open(join(this.folder, RUN_FILES.stdout), 'r'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    try {
      const stat = await handle.stat(), file = `${stat.dev}:${stat.ino}`;
      if (file !== this.file || stat.size < this.offset) {
        // Read again from the start, its versions going on, so a list holding the old ones takes every step again.
        this.steps.length = 0; this.byId.clear(); this.inside.clear(); this.offset = 0; this.lines = 0; this.file = file;
        this.generation = nextGeneration();
      }
      const chunk = Buffer.alloc(CHUNK);
      let pending: Buffer[] = [], pendingLength = 0, lineStart = this.offset, position = this.offset, dropping = false, lines = this.lines;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
        if (!bytesRead) break;
        const bytes = chunk.subarray(0, bytesRead);
        let from = 0;
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, from)) {
          const part = bytes.subarray(from, end);
          if (!dropping && pendingLength + part.length <= RUN_STEPS_LINE_LIMIT) this.accept(Buffer.concat([...pending, part]), lineStart, lines);
          else this.unreadable();
          pending = []; pendingLength = 0; dropping = false; lines++;
          lineStart = position + end + 1; from = end + 1;
        }
        const rest = bytes.subarray(from);
        if (!dropping && pendingLength + rest.length <= RUN_STEPS_LINE_LIMIT) { pending.push(Buffer.from(rest)); pendingLength += rest.length; }
        else { pending = []; pendingLength = 0; dropping = true; }
        position += bytesRead;
      }
      if (this.ended && (pendingLength || dropping)) {
        if (dropping) this.unreadable(); else this.accept(Buffer.concat(pending), lineStart, lines);
        lineStart = position; lines++;
      }
      // While the Run goes on, an unfinished last line is read again next time, once it is whole.
      this.offset = lineStart; this.lines = lines;
    } finally { await handle.close(); }
    if (this.ended) this.settle(this.ended);
    this.readTimes();
  }

  /**
   * The step journal's times, by the line and ID that name each step, read on from where the last read stopped. The
   * manager may write a time after this index read the step's line: a step whose times changed takes the next version,
   * as any other change of it does.
   */
  private readTimes(): void {
    const read = readStepJournalFrom(this.folder, this.journalOffset);
    if (read.restarted) this.times = new Map();
    this.journalOffset = read.offset;
    const changed = new Set<string>();
    // A last line without its line end is read too, and again once it is closed: the first time read stands.
    for (const entry of read.last ? [...read.entries, read.last] : read.entries) {
      const name = `${entry.line}\0${entry.id}`, held = { ...this.times.get(name) ?? untimed };
      // A time once written stands: a second line of the same event (written after a crash) changes nothing.
      if (entry.event === 'start' ? held.startedAt !== null : held.endedAt !== null) continue;
      if (entry.event === 'start') Object.assign(held, { startedAt: entry.at, startSource: entry.source, fingerprint: entry.fingerprint });
      else Object.assign(held, { endedAt: entry.at, endSource: entry.source, output: entry.output });
      this.times.set(name, held); changed.add(name);
    }
    if (changed.size || read.restarted) for (const step of this.steps)
      if (read.restarted || changed.has(`${step.line}\0${step.id}`)) step.changed = ++this.version;
  }

  get total(): number { return this.steps.length; }

  private entry = (step: Step, n: number): RunStepEntry => {
    const { start: _start, end: _end, unsure: _unsure, line, ...rest } = step;
    return { n, ...rest, ...this.times.get(`${line}\0${step.id}`) ?? untimed, subagentSteps: this.inside.get(step.id) ?? 0 };
  };

  /** Steps `from` on, at most `limit` (the latest `limit` when `from` is not given). */
  range(from: number | undefined, limit: number): RunStepsPage {
    const count = Math.max(1, Math.min(limit, RUN_STEPS_PAGE_LIMIT)), total = this.steps.length;
    const start = Math.min(total, from ?? Math.max(0, total - count));
    const steps = this.steps.slice(start, start + count).map((step, at) => this.entry(step, start + at));
    return { steps, total, version: this.version, complete: true, generation: this.generation };
  }

  /** The steps that changed after version `since`, the earliest changes first, at most a page of them. */
  since(since: number): RunStepsPage {
    const changed = this.steps.map((step, n) => ({ step, n })).filter(({ step }) => step.changed > since)
      .sort((a, b) => a.step.changed - b.step.changed);
    const page = changed.slice(0, RUN_STEPS_PAGE_LIMIT), complete = page.length === changed.length;
    // The next read starts after the latest change this page holds, taken in the order of change before the page is
    // put in the Run's order.
    const version = complete ? this.version : page.at(-1)!.step.changed;
    return { steps: [...page].sort((a, b) => a.n - b.n).map(({ step, n }) => this.entry(step, n)), total: this.steps.length,
      version, complete, generation: this.generation };
  }

  /** What step `n` ran and got back, read again from its own lines; null when there is no such step. */
  async detail(n: number): Promise<RunStepDetail | null> {
    const step = this.steps[n];
    if (!step) return null;
    const handle = await open(join(this.folder, RUN_FILES.stdout), 'r');
    try {
      const events = async (at: number | null) => {
        if (at === null) return [];
        const value = parse(await lineAt(handle, at));
        return value === undefined ? [] : this.adapter.activity(value, new Date().toISOString()).filter(event => event.id === step.id);
      };
      const started = await events(step.start), ended = step.end === step.start ? started : await events(step.end);
      // The input is taken from the end's record where it says it (it may hold more, as a Codex edit's diff), else the start's.
      // The input from the records of its start and end, field by field (joinStepCalls); a bridge's, already one text,
      // is the end's where it says it.
      const said = [...ended, ...started];
      const call = joinStepCalls(started.map(event => event.call).find(Boolean), ended.map(event => event.call).find(Boolean));
      const document = call && stepInputDocument(call);
      const input = document !== undefined ? { text: document, omitted: callOmitted(call!) }
        : said.map(event => event.input).find(text => !!text && (text.text !== '' || text.omitted > 0))
        ?? ({ text: said.map(event => event.detail?.text).find(Boolean) ?? '', omitted: 0 } satisfies RunStepText);
      const outcome = ended.map(event => event.outcome).find(Boolean);
      const output = outcome?.output ?? (outcome?.result.text ? lineText(outcome.result) : null);
      // How many files the edit's text hides is counted once, from the text as it is shown.
      const shown = fullRunText(input.text, input.omitted), files = call ? hiddenFiles(call, shown.text) : 0;
      return { input: { ...shown, ...files ? { omittedFiles: files } : {} }, output: output && (output.text || output.omitted) ? fullRunText(output.text, output.omitted) : null,
        changed: step.changed, generation: this.generation, ...said.some(event => event.dropped) ? { detailsDropped: true as const } : {} };
    } finally { await handle.close(); }
  }
}
/** A preview said as the text it stands for, when nothing more was written. */
const lineText = (line: RunStepLine): RunStepText => ({ text: line.text, omitted: 0 });

/** The whole line that starts at `at`, up to the longest line read as a row. */
async function lineAt(handle: FileHandle, at: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let length = 0, position = at;
  for (;;) {
    const chunk = Buffer.alloc(CHUNK), { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
    if (!bytesRead) break;
    const end = chunk.subarray(0, bytesRead).indexOf(10);
    parts.push(chunk.subarray(0, end === -1 ? bytesRead : end));
    length += end === -1 ? bytesRead : end;
    if (end !== -1 || length > RUN_STEPS_LINE_LIMIT) break;
    position += bytesRead;
  }
  return Buffer.concat(parts);
}

/** The indexes read lately, by Run folder and agent, so opening again or reading the next page goes on from there. */
const indexes = new Map<string, { index: RunStepIndex; reading: Promise<unknown> }>();
const INDEX_LIMIT = 16;
/** One Run's index brought up to date, its reads one after another. */
export function runStepIndex(folder: string, adapterId: string, adapter: AgentAdapter, ended: Settled | null): Promise<RunStepIndex> {
  const key = `${folder}\0${adapterId}`;
  let held = indexes.get(key);
  if (held) indexes.delete(key);
  else held = { index: new RunStepIndex(folder, adapter), reading: Promise.resolve() };
  indexes.set(key, held);
  if (indexes.size > INDEX_LIMIT) indexes.delete(indexes.keys().next().value!);
  const index = held.index;
  const read = held.reading.catch(() => undefined).then(() => index.update(ended)).then(() => index);
  held.reading = read;
  return read;
}

/** Task Run `run`'s index of steps brought up to date (null for a Run whose agent this server cannot read), as its record says it went. */
export async function readRunStepIndex(root: string, run: string): Promise<RunStepIndex | null> {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  let record;
  try { record = store?.runtimeGet(run); } finally { store?.close(); }
  if (!record || record.role === 'coordinator') throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', { run }, { reason: { kind: 'run_does_not_exist' } });
  const adapter = runtimeAdapter(record.launch.adapter);
  if (!adapter) return null;
  return runStepIndex(runFolder(root, record.id), record.launch.adapter, adapter,
    isRunMoving(record.state) ? null : record.state === 'succeeded' ? 'done' : 'failed');
}
