/** Bounded, read-only input boundary. */
import { open, opendir, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
export type CatalogReason = 'launch' | 'managed' | 'plugins' | 'settings' | 'unreadable' | 'limit' | 'system';
export class CatalogUnavailable extends Error { constructor(readonly reason: CatalogReason) { super(reason); } }
const READ_BYTES = 256 * 1024;
/** What the system refuses (permissions, a file gone since it was seen) is a path that cannot be read. */
async function unreadable<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) { throw error instanceof CatalogUnavailable ? error : new CatalogUnavailable('unreadable'); }
}
export class Files {
  private count = 0;
  private bytes = 0;
  private step() { if (++this.count > 4096) throw new CatalogUnavailable('limit'); }
  async kind(path: string): Promise<'file' | 'directory' | null> {
    this.step();
    try {
      const info = await stat(path);
      if (!info.isFile() && !info.isDirectory()) throw new CatalogUnavailable('unreadable');
      return info.isFile() ? 'file' : 'directory';
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // A dangling declared source is unreadable, not absent.
        try { await lstat(path); } catch (e: any) { if (e.code === 'ENOENT') return null; throw new CatalogUnavailable('unreadable'); }
      }
      throw error instanceof CatalogUnavailable ? error : new CatalogUnavailable('unreadable');
    }
  }
  /** A whole small file, as settings are read. */
  text(path: string, optional = true) { return this.read(path, optional, true); }
  /** The start of a file of any size: what a definition's header needs. */
  async head(path: string) { return (await this.read(path, false, false))!; }
  private async read(path: string, optional: boolean, whole: boolean): Promise<string | null> {
    const kind = await this.kind(path);
    if (kind === null && optional) return null;
    if (kind !== 'file') throw new CatalogUnavailable('unreadable');
    const handle = await unreadable(() => open(path, constants.O_RDONLY));
    try {
      const info = await handle.stat();
      if (!info.isFile() || whole && info.size > READ_BYTES) throw new CatalogUnavailable('unreadable');
      const size = Math.min(Number(info.size), READ_BYTES);
      if (this.bytes + size > 8 * 1024 * 1024) throw new CatalogUnavailable('limit');
      // One byte past a whole file tells a file that grew while it was read.
      const buffer = Buffer.alloc(size + (whole ? 1 : 0));
      let bytesRead = 0;
      while (bytesRead < buffer.length) { const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead); if (!chunk.bytesRead) break; bytesRead += chunk.bytesRead; }
      if (bytesRead !== size || (await handle.stat()).mtimeMs !== info.mtimeMs) throw new CatalogUnavailable('unreadable');
      this.bytes += bytesRead; return buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await handle.close(); }
  }
  async children(path: string): Promise<string[]> {
    const kind = await this.kind(path);
    if (kind === null) return [];
    if (kind !== 'directory') throw new CatalogUnavailable('unreadable');
    const names: string[] = [];
    await unreadable(async () => { for await (const entry of await opendir(path)) { this.step(); names.push(entry.name); } });
    return names.sort();
  }
  async canonical(path: string) { await this.kind(path); return unreadable(() => realpath(path)); }
}
