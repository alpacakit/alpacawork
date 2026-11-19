import { closeSync, readSync } from 'node:fs';
import { RUN_FILES } from '@alpacawork/contract/run';
import { openRunFile } from '../files.js';
import { constants } from 'node:fs';

const CHUNK = 64 * 1024;
export const MAX_LINE = 2 * 1024 * 1024;
type OnValue = (value: unknown, line: number) => void;

/** Reads complete lines only. A reader can resume at its previous byte offset. Each line is bounded, the file is not. */
export class JsonlReader {
  constructor(private readonly rejected: () => void = () => {}) {}
  private offset = 0;
  private line = 0;
  private pending = Buffer.alloc(0);
  private dropping = false;
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
    try {
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
          if (!this.dropping && this.pending.length + part.length <= MAX_LINE) {
            const line = Buffer.concat([this.pending, part]);
            this.parse(line, onValue);
          } else {
            this.reject('too_large');
          }
          this.pending = Buffer.alloc(0);
          this.dropping = false;
          this.line++;
          start = end + 1;
        }
        const rest = bytes.subarray(start);
        if (!this.dropping) {
          if (this.pending.length + rest.length > MAX_LINE) {
            this.pending = Buffer.alloc(0);
            this.dropping = true;
            this.reject('too_large');
          } else this.pending = Buffer.concat([this.pending, rest]);
        }
      }
    } finally { closeSync(fd); }
  }

  finish(onValue: OnValue): void {
    if (this.dropping || !this.pending.length) return;
    this.parse(this.pending, onValue);
  }
}
