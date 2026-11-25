/**
 * A Run's step journal (RUN_FILES.steps): when each step started and ended, kept as it happens by the Run's manager,
 * which reads the agent's output while it runs. The index of steps (run-steps.ts) reads the output again whenever
 * someone opens it, and can say what a step was but not when; the journal is the one record of when.
 *
 * Each start and end is appended once. A step is named by the number of the output line that started it and its tool
 * call ID, so reading the output again from its start (a new manager for the same output) appends only what the journal
 * does not hold yet: a time written once is never replaced.
 */
import { appendFileSync, closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RUN_FILES, RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, clipRunText, stepJournalEntrySchema,
  type StepFingerprint, type StepJournalEntry, type StepOutput, type StepTimeSource } from '@alpacawork/contract/run';
import { hasCode } from '@alpacawork/core';
import type { ActivityEvent } from './activity-events.js';
import { stepInputDocument } from '../agents/adapters/activity.js';

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Text with what changes from one run of the same thing to the next replaced; numbers too unless `numbers` keeps them. */
const replaced = (text: string, numbers = false) => replacedIds(text).replace(/\b\d+\b/g, number => numbers ? number : '<n>');
const replacedIds = (text: string) => text
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  .replace(/(^|[\s"'=:(])(?:~|\$\w+|\$\{\w+\})?\/[^\s"';|&)]*/gm, '$1<path>')
  .replace(/\b[0-9a-f]{7,64}\b/gi, hex => /[a-f]/i.test(hex) && /\d/.test(hex) ? '<hash>' : hex)
  .replace(/\b[TRPAQ]\d+\b/g, '<id>');

/**
 * What a step ran, with what changes from one run of the same thing to the next replaced, so the same command run
 * again reads as the same: absolute paths (where it ran included), UUIDs, long hex digests, task, Run and project IDs,
 * and numbers. `bodyDigest` is a digest of the whole input so replaced (numbers kept below the first line), when it has more than its first line (a heredoc's
 * text, a script), so two runs of the same first line with different bodies stay apart.
 */
export function stepFingerprint(input: string): StepFingerprint | null {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  const newline = text.indexOf('\n'), first = newline === -1 ? text : text.slice(0, newline);
  return { line: clipRunText(replaced(first), RUN_STEP_TEXT_LIMIT), bodyDigest: newline === -1 ? null : short(`${replaced(first)}\n${replaced(text.slice(newline + 1), true)}`) };
}

/** What came back, as a size and a digest; `whole` false when the agent cut it, so the digest covers its start only. */
function stepOutput(output: { text: string; omitted: number } | undefined): StepOutput | null {
  if (!output || (!output.text && !output.omitted)) return null;
  return { chars: output.text.length + output.omitted, digest: short(output.text), whole: output.omitted === 0 };
}

/** One journal line as written, or null for a line that cannot be read (a torn line after a crash). */
const entryOf = (line: string): StepJournalEntry | null => {
  if (!line) return null;
  try { const parsed = stepJournalEntrySchema.safeParse(JSON.parse(line)); return parsed.success ? parsed.data : null; }
  catch { return null; }
};

/**
 * The journal's entries as written, skipping lines that cannot be read, and with them a last line a crash left whole
 * but without its line end (the next append closes it, so it stands as written).
 */
export function readStepJournal(folder: string): StepJournalEntry[] {
  const read = readStepJournalFrom(folder, 0);
  return read.last ? [...read.entries, read.last] : read.entries;
}

/**
 * The whole lines the journal gained from byte `offset` on, and where the next read starts. The journal only grows; one
 * shorter than `offset` was replaced and is read from its start (`restarted`).
 */
export function readStepJournalFrom(folder: string, offset: number): { entries: StepJournalEntry[]; offset: number; restarted: boolean;
  /** The entry of a last line without its line end, when it reads whole. */ last: StepJournalEntry | null } {
  let fd: number;
  try { fd = openSync(`${folder}/${RUN_FILES.steps}`, constants.O_RDONLY); }
  catch (error) { if (hasCode(error, 'ENOENT')) return { entries: [], offset: 0, restarted: offset > 0, last: null }; throw error; }
  try {
    const size = fstatSync(fd).size, restarted = size < offset, from = restarted ? 0 : offset;
    const bytes = Buffer.alloc(size - from);
    let read = 0;
    while (read < bytes.length) { const count = readSync(fd, bytes, read, bytes.length - read, from + read); if (!count) break; read += count; }
    const end = bytes.subarray(0, read).lastIndexOf(10) + 1;
    const entries = bytes.subarray(0, end).toString('utf8').split('\n').flatMap(line => { const entry = entryOf(line); return entry ? [entry] : []; });
    return { entries, offset: from + end, restarted, last: end < read ? entryOf(bytes.subarray(end, read).toString('utf8')) : null };
  } finally { closeSync(fd); }
}

/** When a step started or ended, and where that time came from. */
export type StepTime = { at: string; source: StepTimeSource };

/** The time to write for the start or end of the step that output line `line` started with call `id`, or null for none. */
export type StepTimeOf = (event: StepJournalEntry['event'], line: number, id: string) => StepTime | null;

/** The time of an event the Run's manager read at `read` (ISO): the agent's own when its output said one. */
export const liveStepTime = (event: ActivityEvent, read: string): StepTimeOf => () =>
  ({ at: event.at, source: event.at === read ? 'observed' : 'reported' });

const key = (event: StepJournalEntry['event'], line: number, id: string) => `${event}\0${line}\0${id}`;

/** Appends to one Run's journal what the output says of its steps, each start and end once. */
export class StepJournal {
  /** The step a tool call's ID names now, by the line that started it: an ID used again after its end starts another. */
  private readonly open = new Map<string, number>();
  /** Steps a turn's end or an error notice settled without their own end, by call ID: a later end is theirs. */
  private readonly settled = new Map<string, number>();
  /** Settled steps whose call ID a new step took before their end came: they end when the Run does. */
  private readonly unended: [string, number][] = [];
  /** The line of the last step each call ID named, once it ended. */
  private readonly closed = new Map<string, number>();
  private held: Map<string, StepTime> | null = null;
  private failed = false;
  /** Entries this journal appended (or, when it does not write, would have). */
  added = 0;

  /** `write` false: count what would be appended, writing nothing (a trial of an import). */
  constructor(private readonly folder: string, private readonly write = true) {}

  /**
   * One adapter event read from output line `line`. `timeOf` gives the time to write for the start or end of the step
   * (named by the line that started it and its ID); null follows the step without writing that time. Gives the line
   * that names the step, or null for no step.
   */
  observe(event: ActivityEvent, line: number, timeOf: StepTimeOf): number | null {
    if (this.failed) return null;
    const { kind, id } = event;
    // A turn's end or an error notice settles what is open, as the index of steps reads it: the same ID starts a new
    // step after it, while an end said later is still the settled step's. Its time is written when that end comes, or
    // when the Run ends.
    if (kind === 'result' || kind === 'error') {
      for (const [open, at] of this.open) this.settled.set(open, at);
      this.open.clear();
      return null;
    }
    if ((kind !== 'tool_start' && kind !== 'tool_end') || typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) return null;
    if (kind === 'tool_start' && this.open.has(id)) return this.open.get(id)!;
    // A start without a tool name starts no step (the index of steps does not list one), and leaves the step before it as it was.
    if (kind === 'tool_start' && (typeof event.toolName !== 'string' || !event.toolName)) return null;
    if (kind === 'tool_start' && this.settled.has(id)) { this.unended.push([id, this.settled.get(id)!]); this.settled.delete(id); }
    if (kind === 'tool_end' && !this.open.has(id) && this.settled.has(id)) { this.open.set(id, this.settled.get(id)!); this.settled.delete(id); }
    // An end said again for a step already ended is that step's, as the index of steps reads it.
    if (kind === 'tool_end' && !this.open.has(id) && this.closed.has(id)) return this.closed.get(id)!;
    if (kind === 'tool_start' || !this.open.has(id)) {
      // A step is one the index of steps lists: it has a tool name.
      if (typeof event.toolName !== 'string' || !event.toolName) return null;
      this.open.set(id, line);
      const document = event.call ? stepInputDocument(event.call) : undefined;
      const at = timeOf('start', line, id);
      if (at) this.append({ event: 'start', line, id, ...at,
        fingerprint: stepFingerprint(document ?? event.input?.text ?? event.detail?.text ?? ''),
        parentId: typeof event.parent === 'string' && event.parent && event.parent.length <= RUN_TOOL_ID_LIMIT ? event.parent : null });
      if (kind === 'tool_start') return line;
    }
    const opened = this.open.get(id)!;
    this.open.delete(id); this.closed.set(id, opened);
    const at = timeOf('end', opened, id);
    if (at) this.append({ event: 'end', line: opened, id, ...at,
      state: event.outcome?.unknown ? 'unknown' : event.outcome?.failed ? 'failed' : 'done',
      output: stepOutput(event.outcome?.output ?? (event.outcome?.result.text ? { text: event.outcome.result.text, omitted: 0 } : undefined)) });
    return opened;
  }

  /** The journal could not be written: what was observed after that was not kept. */
  get broken(): boolean { return this.failed; }

  /**
   * Whether the journal holds a time the Run's manager kept as it happened (not one imported from a conversation
   * record) for the start or end of the step that output line `line` started with call `id`.
   */
  keptLive(line: number, id: string): boolean {
    return (['start', 'end'] as const).some(event => { const source = this.heldTime(event, line, id)?.source; return source !== undefined && source !== 'transcript'; });
  }

  /** The time the journal holds for the start or end of the step that output line `line` started with call `id`. */
  heldTime(event: StepJournalEntry['event'], line: number, id: string): StepTime | undefined {
    return this.heldNames().get(key(event, line, id));
  }

  /**
   * The steps still without an end when the Run ended end with it (`state`), each at the time `timeOf` gives (not
   * written where it gives none).
   */
  settle(state: 'done' | 'failed' | 'unknown', timeOf: StepTimeOf): void {
    for (const [id, line] of [...this.open, ...this.settled, ...this.unended]) {
      const at = timeOf('end', line, id);
      if (at) this.append({ event: 'end', line, id, ...at, state, output: null });
      this.closed.set(id, line);
    }
    this.open.clear(); this.settled.clear(); this.unended.length = 0;
  }

  /** What the journal holds, by entry, with where its time came from (the first written stands). */
  private heldNames(): Map<string, StepTime> {
    if (!this.held) {
      this.held = new Map();
      for (const entry of readStepJournal(this.folder))
        if (!this.held.has(key(entry.event, entry.line, entry.id))) this.held.set(key(entry.event, entry.line, entry.id), { at: entry.at, source: entry.source });
    }
    return this.held;
  }

  private append(entry: StepJournalEntry): void {
    const held = this.heldNames(), name = key(entry.event, entry.line, entry.id);
    if (held.has(name)) return;
    if (!this.write) { held.set(name, { at: entry.at, source: entry.source }); this.added++; return; }
    try {
      const fd = openSync(`${this.folder}/${RUN_FILES.steps}`, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 0o600);
      try {
        // A line torn by a crash is closed first, so this entry is a line of its own.
        const size = fstatSync(fd).size, last = Buffer.alloc(1);
        const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
        appendFileSync(fd, (torn ? '\n' : '') + JSON.stringify(entry) + '\n');
      } finally { closeSync(fd); }
      held.set(name, { at: entry.at, source: entry.source }); this.added++;
    } catch (error) {
      // The journal is a record beside the Run, not part of it: a Run goes on without it, and says so once.
      this.failed = true;
      console.error('Step journal could not be written', error);
    }
  }
}
