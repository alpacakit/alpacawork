/**
 * Codex's record of a conversation (a thread): `<home>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<thread>.jsonl`, possibly
 * compressed (`.jsonl.zst`). A thread resumed from the person's own Codex may have its start under their home
 * (~/.codex) and the rest under alpacawork's (~/.codex-alpacawork), so every home given is looked in.
 *
 * A line `{"type":"event_msg","payload":{"type":"item_completed","item":{...}}}` says, at its `timestamp`, that an item
 * ended; its `id` is the one the Run's output names the step with. A command's item says how long it took (`duration`),
 * so its start is that much before its end; other items (a file change, a viewed image) say only their end.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CallBook, recordLines, recordTime, type ConversationCalls } from './calls.js';

const ROLLOUT = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/** A `{ secs, nanos }` duration in milliseconds, or null when it is not one. */
const millis = (value: unknown): number | null => {
  if (!value || typeof value !== 'object') return null;
  const { secs, nanos } = value as { secs?: unknown; nanos?: unknown };
  return typeof secs === 'number' && typeof nanos === 'number' && secs >= 0 && nanos >= 0 ? secs * 1000 + nanos / 1e6 : null;
};

export class CodexTranscripts {
  private threads: Map<string, string[]> | null = null;
  private readonly read = new Map<string, Promise<ConversationCalls>>();

  /** `homes`: the Codex homes to look in (CODEX_HOME, else ~/.codex-alpacawork and ~/.codex). */
  constructor(private readonly homes: readonly string[]) {}

  /** Thread `thread`'s calls, read once however many Runs share it. */
  calls(thread: string): Promise<ConversationCalls> {
    let held = this.read.get(thread.toLowerCase());
    if (!held) this.read.set(thread.toLowerCase(), held = this.readThread(thread.toLowerCase()));
    return held;
  }

  /** Every rollout file under the homes, by thread, listed once. */
  private files(thread: string): string[] {
    if (!this.threads) {
      this.threads = new Map();
      for (const home of this.homes) {
        const sessions = join(home, 'sessions');
        if (!existsSync(sessions)) continue;
        for (const path of readdirSync(sessions, { recursive: true }).map(String).sort()) {
          const id = ROLLOUT.exec(path)?.[1]?.toLowerCase();
          if (id) this.threads.set(id, [...this.threads.get(id) ?? [], join(sessions, path)]);
        }
      }
    }
    return this.threads.get(thread) ?? [];
  }

  private async readThread(thread: string): Promise<ConversationCalls> {
    const files = this.files(thread);
    if (!files.length) return { state: 'missing' };
    const book = new CallBook();
    for (const file of files) for await (const line of recordLines(file)) {
      const at = recordTime(line.timestamp);
      if (!at) continue;
      book.entries++;
      const payload = line.payload as { type?: unknown; item?: { id?: unknown; duration?: unknown } } | undefined;
      if (line.type !== 'event_msg' || payload?.type !== 'item_completed' || !payload.item) continue;
      book.note(payload.item.id, 'endedAt', at);
      const took = millis(payload.item.duration);
      if (took !== null) book.note(payload.item.id, 'startedAt', new Date(Date.parse(at) - took).toISOString());
    }
    return book.result(files);
  }
}
