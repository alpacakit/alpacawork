/**
 * When each tool call of one agent conversation started and ended, as read afterwards from the agent's own record of the
 * conversation. Each agent keeps that record in a form it does not publish and changes between versions, so each has its
 * own reader beside this file (claude.ts, codex.ts); what they give back is this alone.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

/** One run of a call: its start and its end (ms since the epoch), null where the record does not say. */
export type CallTime = { startedAt: number | null; endedAt: number | null };
/**
 * What one conversation's record says of its calls: each call ID with every run of it, in the order the record says
 * them (an ID used again, or a record that copies earlier messages, says it more than once). `missing`: no record of
 * it on this PC (it was never here, or the agent removed it after its retention period). `unreadable`: there is one,
 * but it cannot be read through, or no line of it reads as this reader expects.
 */
export type ConversationCalls =
  | { state: 'read'; files: string[]; calls: Map<string, CallTime[]> }
  | { state: 'missing' }
  | { state: 'unreadable'; files: string[] };

/** A time from a record's own field (ms), or null when it is not one. */
export const recordTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Collects each call's runs, each start paired with the end that follows it. */
export class CallBook {
  readonly calls = new Map<string, CallTime[]>();
  /** Lines that read as a record entry with a time, whether or not they named a call. */
  entries = 0;
  private runs(id: unknown): CallTime[] | null {
    if (typeof id !== 'string' || !id) return null;
    let runs = this.calls.get(id);
    if (!runs) this.calls.set(id, runs = []);
    return runs;
  }
  /** A call started; a start said again (a copy of the same message) is the same run. */
  started(id: unknown, at: number): void {
    const runs = this.runs(id);
    if (runs && !runs.some(run => run.startedAt === at)) runs.push({ startedAt: at, endedAt: null });
  }
  /** A call ended: the end of its latest run still open that started by then, else a run said only by its end (once). */
  ended(id: unknown, at: number): void {
    const runs = this.runs(id);
    if (!runs) return;
    const open = [...runs].reverse().find(run => run.endedAt === null && run.startedAt !== null && run.startedAt <= at);
    if (open) open.endedAt = at;
    else if (!runs.some(run => run.endedAt === at)) runs.push({ startedAt: null, endedAt: at });
  }
  /** A run said whole, its start null where the record gives only its end; the same run said again is one. */
  ran(id: unknown, startedAt: number | null, endedAt: number): void {
    const runs = this.runs(id);
    if (runs && !runs.some(run => run.startedAt === startedAt && run.endedAt === endedAt)) runs.push({ startedAt, endedAt });
  }
}

/**
 * Reads a conversation's record with `read`. A record that cannot be read through (a broken compressed file, a file
 * gone since it was listed) is unreadable, as is one with no line this reader expects.
 */
export async function readRecord(files: string[], read: (book: CallBook) => Promise<void>): Promise<ConversationCalls> {
  if (!files.length) return { state: 'missing' };
  const book = new CallBook();
  try { await read(book); } catch { return { state: 'unreadable', files }; }
  return book.entries ? { state: 'read', files, calls: book.calls } : { state: 'unreadable', files };
}

/** Each line of a record parsed as JSON (lines that are not are passed over); a `.zst` file is read through zstd. */
export async function* recordLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const raw = createReadStream(file);
  const input = file.endsWith('.zst') ? raw.pipe(createZstdDecompress()) : raw;
  // A failure to open or read the file ends the reading with it.
  if (input !== raw) raw.once('error', error => input.destroy(error));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>;
    }
  } finally {
    // However the reading ends, the file is closed.
    lines.close(); input.destroy(); raw.destroy();
  }
}
