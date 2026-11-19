import { constants } from 'node:fs';
import { stat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_LOG_BYTES } from './protocol.ts';

/** One serial writer, bounded admission, no retry after a storage fault. */
export function performanceWriter(directory: string, warn: (message: string) => void) {
  let tail = Promise.resolve(), pending = 0, failed = false;
  const current = join(directory, 'current.jsonl'), previous = join(directory, 'previous.jsonl');
  async function fileSize(path: string) {
    try { return (await stat(path)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  }
  return {
    get failed() { return failed; },
    write(value: unknown): Promise<boolean> | undefined {
      if (failed) return Promise.resolve(false);
      if (pending >= 8) return undefined;
      const line = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(line) > MAX_LOG_BYTES) return Promise.resolve(false);
      pending++;
      const saved = tail.then(async () => {
        if (failed) return false;
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const size = await fileSize(current);
          await fileSize(previous);
          if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
            await unlink(previous).catch(error => { if (error.code !== 'ENOENT') throw error; });
            await rename(current, previous);
          }
          const fd = await open(current, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
          try {
            await fd.writeFile(line);
          } finally { await fd.close(); }
          return true;
        } catch {
          failed = true;
          warn('[performance] log write failed; recording stopped for this server');
          return false;
        }
      }).finally(() => { pending--; });
      tail = saved.then(() => {});
      return saved;
    },
    async close() { await tail; },
  };
}
