/**
 * When each tool call of one agent conversation started and ended, as read afterwards from the agent's own record of the
 * conversation. Each agent keeps that record in a form it does not publish and changes between versions, so each has its
 * own reader beside this file (claude.ts, codex.ts); what they give back is this alone.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

/**
 * One call's times (ISO), each as often as the record says it: a record that copies earlier messages (a resumed or
 * forked conversation) may say a call again, and which of them is a Run's is decided by the Run's own time.
 */
export type CallTimes = { started: string[]; ended: string[] };
/**
 * What one conversation's record says of its calls, by the call ID the Run's output names them with. `missing`: no
 * record of it on this PC (it was never here, or the agent removed it after its retention period). `unreadable`: there
 * is one, but no line of it reads as this reader expects.
 */
export type ConversationCalls =
  | { state: 'read'; files: string[]; calls: Map<string, CallTimes> }
  | { state: 'missing' }
  | { state: 'unreadable'; files: string[] };

/** An ISO time from a record's own field, or null when it is not one. */
export const recordTime = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

/** Collects each call's times. */
export class CallBook {
  readonly calls = new Map<string, CallTimes>();
  /** Lines that read as a record entry with a time, whether or not they named a call. */
  entries = 0;
  note(id: unknown, event: keyof CallTimes, at: string | null): void {
    if (typeof id !== 'string' || !id || !at) return;
    const held = this.calls.get(id) ?? { started: [], ended: [] };
    if (!held[event].includes(at)) held[event].push(at);
    this.calls.set(id, held);
  }
  result(files: string[]): ConversationCalls {
    return this.entries ? { state: 'read', files, calls: this.calls } : { state: 'unreadable', files };
  }
}

/** Reads a conversation's record with `read`; a record that cannot be read through (a broken compressed file) is unreadable. */
export async function readRecord(files: string[], read: (book: CallBook) => Promise<void>): Promise<ConversationCalls> {
  if (!files.length) return { state: 'missing' };
  const book = new CallBook();
  try { await read(book); } catch { return { state: 'unreadable', files }; }
  return book.result(files);
}

/** Each line of a record parsed as JSON (lines that are not are passed over); a `.zst` file is read through zstd. */
export async function* recordLines(file: string): AsyncGenerator<Record<string, unknown>> {
  const raw = createReadStream(file);
  const lines = createInterface({ input: file.endsWith('.zst') ? raw.pipe(createZstdDecompress()) : raw, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (value && typeof value === 'object' && !Array.isArray(value)) yield value as Record<string, unknown>;
  }
}
