/** Filesystem notifications are demand to reread, never authoritative workspace facts. */
import { watch, type FSWatcher } from 'node:fs';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';

type DirectoryWatch = Pick<FSWatcher, 'on' | 'close'>;
type Listener = (event: string, filename: string | null) => void;
type Options = {
  watchDirectory?: (path: string, listener: Listener) => DirectoryWatch;
  /** Whether a directory below the root is watched at all; one left out spends no watch, and neither does anything below it. */
  covers?: (path: string) => boolean;
  retryDelays?: readonly number[];
  diagnostic?: (entry: Record<string, unknown>) => void;
};
type Directory = { watch: DirectoryWatch; identity: string; children: Set<string> };
const absent = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** One watch per real directory; regular file count consumes no watch resources. */
export class WorkspaceWatch {
  /** First registration attempt finished, successfully or degraded; retries do not delay server startup. */
  readonly initialized: Promise<void>;
  private readonly root: string;
  private readonly directories = new Map<string, Directory>();
  private readonly pending = new Set<string>();
  private pumping?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private stopped = false;
  private failures = 0;
  private complete = false;
  private repairNeeded = false;
  private readonly watchDirectory: NonNullable<Options['watchDirectory']>;
  private readonly covers: NonNullable<Options['covers']>;
  private readonly retryDelays: readonly number[];
  private readonly diagnostic: NonNullable<Options['diagnostic']>;

  constructor(root: string, private readonly changed: (path?: string) => void, options: Options = {}) {
    this.root = resolve(root);
    this.watchDirectory = options.watchDirectory ?? ((path, listener) => watch(path, { recursive: false }, listener));
    this.covers = options.covers ?? (() => true);
    this.retryDelays = options.retryDelays ?? [5_000, 30_000, 60_000, 300_000];
    this.diagnostic = options.diagnostic ?? (entry => console.error(JSON.stringify({ workspaceWatch: entry })));
    this.enqueue('');
    this.initialized = this.pumping!;
  }

  get healthy() { return this.complete; }
  get watchCount() { return this.directories.size; }

  private enqueue(path: string) {
    if (this.stopped || this.retryTimer) return;
    this.pending.add(path);
    if (!this.pumping) {
      this.pumping = this.pump(this.epoch).finally(() => {
        this.pumping = undefined;
        if (this.pending.size && !this.stopped && !this.retryTimer) this.enqueue(this.pending.values().next().value!);
      });
    }
  }

  private remove(path: string) {
    const removed = [path];
    while (removed.length) {
      const name = removed.pop()!;
      const directory = this.directories.get(name);
      if (!directory) continue;
      removed.push(...directory.children);
      directory.watch.close();
      this.directories.delete(name);
      this.repairNeeded = true;
    }
    for (const name of this.pending)
      if (name === path || name.startsWith(path ? `${path}/` : '')) this.pending.delete(name);
  }

  private async pump(epoch: number) {
    // Always give the caller its instance before notifications or faults can arrive.
    await yieldTurn();
    try {
      while (this.pending.size && epoch === this.epoch && !this.stopped) {
        const path = this.pending.values().next().value!;
        this.pending.delete(path);
        await this.reconcile(path, epoch);
        await yieldTurn();
      }
      if (epoch !== this.epoch || this.stopped || this.complete && !this.repairNeeded) return;
      this.complete = true;
      this.repairNeeded = false;
      if (this.failures) this.diagnostic({ state: 'recovered', attempts: this.failures, directories: this.directories.size });
      this.failures = 0;
      this.changed(); // Repair everything that happened before registration completed.
    } catch (error) {
      if (epoch === this.epoch && !this.stopped) this.failed(error);
    }
  }

  private async reconcile(path: string, epoch: number) {
    try { await this.readDirectory(path, epoch); }
    catch (error) { if (path && absent(error)) { this.remove(path); return; } throw error; }
  }

  private async readDirectory(path: string, epoch: number) {
    const absolute = join(this.root, path);
    const stat = await lstat(absolute, { bigint: true });
    if (epoch !== this.epoch || this.stopped) return;
    // Skip stable symlinks. Path replacement can race these checks and opendir;
    // the post-check discards that traversal before descendants are registered.
    // Authoritative file access remains with its separate no-follow Owner.
    if (!stat.isDirectory() || await realpath(absolute) !== absolute) {
      if (!path) throw new Error('Workspace watch root must be a real directory');
      this.remove(path); return;
    }
    if (epoch !== this.epoch || this.stopped) return;
    const identity = `${stat.dev}:${stat.ino}`;
    const previous = this.directories.get(path);
    if (previous && previous.identity !== identity) this.remove(path);
    const added = !this.directories.has(path);
    if (added) {
      const watcher = this.watchDirectory(absolute, (event, filename) => {
        if (epoch !== this.epoch || this.stopped || this.directories.get(path)?.watch !== watcher) return;
        const safe = filename !== null && filename !== '' && filename !== '.' && filename !== '..' && !/[\/\\\0]/.test(filename);
        this.changed(safe ? (path ? `${path}/${filename}` : filename) : undefined);
        if (event === 'rename' || !safe) this.enqueue(path);
      });
      this.directories.set(path, { watch: watcher, identity, children: new Set() });
      this.repairNeeded = true;
      watcher.on('error', error => {
        if (epoch === this.epoch && !this.stopped && this.directories.get(path)?.watch === watcher) this.failed(error);
      });
    }
    const directory = await opendir(absolute);
    const children = new Set<string>();
    let visited = 0;
    for await (const entry of directory) {
      if (epoch !== this.epoch || this.stopped) return;
      if (entry.isDirectory()) {
        const child = path ? `${path}/${entry.name}` : entry.name;
        if (this.covers(child)) children.add(child);
      }
      if (++visited % 128 === 0) await yieldTurn();
    }
    if (epoch !== this.epoch || this.stopped) return;
    // The parent may have been replaced while its old inode was being enumerated.
    const current = await lstat(absolute, { bigint: true });
    if (`${current.dev}:${current.ino}` !== identity || !current.isDirectory() || await realpath(absolute) !== absolute) {
      this.remove(path); this.enqueue(path); return;
    }
    if (epoch !== this.epoch || this.stopped) return;
    const registered = this.directories.get(path)!;
    for (const child of registered.children) if (!children.has(child)) this.remove(child);
    registered.children = children;
    for (const child of children) {
      if (epoch !== this.epoch || this.stopped) return;
      const known = this.directories.get(child);
      if (!known) this.pending.add(child);
      else {
        let info;
        try { info = await lstat(join(this.root, child), { bigint: true }); }
        catch (error) { if (absent(error)) { this.remove(child); continue; } throw error; }
        if (epoch !== this.epoch || this.stopped) return;
        if (!info.isDirectory() || `${info.dev}:${info.ino}` !== known.identity) this.pending.add(child);
      }
    }
    if (added && path) this.changed(path);
  }

  private failed(error: unknown) {
    this.complete = false;
    this.epoch++;
    this.pending.clear();
    this.remove('');
    const fault = error as NodeJS.ErrnoException;
    const retryable = ['ENOSPC', 'EMFILE', 'ENFILE', 'EAGAIN', 'EINTR', 'EBUSY'].includes(fault.code ?? '');
    // Another process can give the budget back at any time: the last delay repeats, so a watch never stays given up.
    const delay = retryable ? this.retryDelays[Math.min(this.failures, this.retryDelays.length - 1)] : undefined;
    this.failures++;
    this.diagnostic({ state: 'degraded', code: fault.code ?? null, message: fault.message, retryMs: delay ?? null });
    this.changed();
    if (delay !== undefined) this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.enqueue('');
    }, delay);
  }

  async close() {
    this.stopped = true;
    this.complete = false;
    this.epoch++;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.pending.clear();
    this.remove('');
    await this.pumping;
  }
}
