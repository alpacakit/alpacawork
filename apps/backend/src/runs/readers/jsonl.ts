import { closeSync, readSync } from 'node:fs';
import { RUN_FILES } from '@alpacawork/contract/run';
import { openRunFile } from '../files.js';
import { constants } from 'node:fs';

const CHUNK = 64 * 1024;
export const MAX_LINE = 2 * 1024 * 1024;
/**
 * The longest line read as a row where a Run's steps are read: the live activity that counts them and the index that
 * lists them read the same lines, so a step counted can be listed and one listed was counted. A Run's outcome keeps
 * MAX_LINE.
 */
export const STEP_LINE_LIMIT = 64 * 1024 * 1024;
type OnValue = (value: unknown, line: number) => void;

/** Reads complete lines only. A reader can resume at its previous byte offset. Each line is bounded, the file is not. */
export class JsonlReader {
  constructor(private readonly rejected: () => void = () => {}, private readonly maxLine = MAX_LINE) {}
  private offset = 0;
  private line = 0;
  /** The unfinished line's parts, joined once it ends: a long line is not copied again with every chunk. */
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private dropping = false;
  private clear(): void { this.pending = []; this.pendingLength = 0; }
  rejection: 'too_large' | 'unreadable' | null = null;
  private reject(reason: NonNullable<JsonlReader['rejection']>): void { this.rejection = reason; this.rejected(); }

  private parse(line: Buffer, onValue: OnValue): void {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(line)); }
    catch { this.reject('unreadable'); return; }
    onValue(value, this.line);
  }

  read(folder: string, onValue: OnValue, maxBytes = Number.POSITIVE_INFINITY): void {
    const fd = openRunFile(folder, RUN_FILES.stdout, constants.O_RDONLY);
    try { this.readFd(fd, onValue, maxBytes); } finally { closeSync(fd); }
  }

  /** The caller may provide an already verified regular file. It owns the descriptor. */
  readFd(fd: number, onValue: OnValue, maxBytes = Number.POSITIVE_INFINITY): void {
    const chunk = Buffer.alloc(CHUNK);
    let remaining = maxBytes;
    while (remaining > 0) {
      const count = readSync(fd, chunk, 0, Math.min(CHUNK, remaining), this.offset);
      if (!count) break;
      this.offset += count;
      remaining -= count;
      const bytes = chunk.subarray(0, count);
      let start = 0;
      for (let end = bytes.indexOf(10, start); end !== -1; end = bytes.indexOf(10, start)) {
        const part = bytes.subarray(start, end);
        if (!this.dropping && this.pendingLength + part.length <= this.maxLine) {
          const line = Buffer.concat([...this.pending, part]);
          this.parse(line, onValue);
        } else {
          this.reject('too_large');
        }
        this.clear();
        this.dropping = false;
        this.line++;
        start = end + 1;
      }
      const rest = bytes.subarray(start);
      if (!this.dropping) {
        if (this.pendingLength + rest.length > this.maxLine) {
          this.clear();
          this.dropping = true;
          this.reject('too_large');
        } else if (rest.length) { this.pending.push(Buffer.from(rest)); this.pendingLength += rest.length; }
      }
    }
  }

  finish(onValue: OnValue): void {
    if (this.dropping || !this.pendingLength) return;
    const line = Buffer.concat(this.pending);
    this.clear();
    this.parse(line, onValue);
  }
}
