import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, realpath } from 'node:fs/promises';
import { readdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceWatch } from '@alpacawork/backend/test-dist/receiver/workspace-watch.js';

async function until(check: () => boolean, message: string) {
  const end = Date.now() + 5_000;
  while (!check() && Date.now() < end) await delay(10);
  assert(check(), message);
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await mkdtemp(join(tmpdir(), 'workspace-watch-'));
  const root = join(base, 'root'); await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base: await realpath(base), root: await realpath(root) };
}
function watches() {
  let count = 0;
  for (const fd of readdirSync('/proc/self/fdinfo')) {
    try { count += readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').split('\n').filter(line => line.startsWith('inotify wd:')).length; }
    catch { /* An unrelated descriptor can disappear during the observation. */ }
  }
  return count;
}
class FakeWatch extends EventEmitter {
  closed = false;
  readonly notify: (event: string, filename: string | null) => void;
  constructor(notify: (event: string, filename: string | null) => void) { super(); this.notify = notify; }
  close() { this.closed = true; }
}

test('initialization includes the whole initial directory graph and its repair demand', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'child', 'grandchild'), { recursive: true });
  const handles: FakeWatch[] = [], changed: (string | undefined)[] = [];
  const watcher = new WorkspaceWatch(root, path => changed.push(path), {
    watchDirectory: (_path, listener) => { const handle = new FakeWatch(listener); handles.push(handle); return handle; },
  });
  t.after(() => watcher.close());
  assert.equal(handles.length, 0, 'registration yields instead of blocking the constructor');
  assert.equal(watcher.healthy, false);
  await watcher.initialized;
  assert.equal(handles.length, 3);
  assert.equal(watcher.healthy, true);
  assert.equal(changed.at(-1), undefined, 'repair precedes initialization completion');
  const before = [...changed];
  await delay(20);
  assert.deepEqual(changed, before, 'the initial traversal has no late repair after its barrier');
});

test('initialization ends at the first failed attempt while close cancels its pending retry', { timeout: 5_000 }, async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'child'));
  const handles: FakeWatch[] = [], diagnostics: Record<string, unknown>[] = [];
  let attempts = 0;
  const watcher = new WorkspaceWatch(root, () => {}, {
    retryDelays: [60_000], diagnostic: entry => diagnostics.push(entry),
    watchDirectory: (_path, listener) => {
      if (++attempts === 2) throw Object.assign(new Error('initial budget exhausted'), { code: 'ENOSPC' });
      const handle = new FakeWatch(listener); handles.push(handle); return handle;
    },
  });
  t.after(() => watcher.close());
  await watcher.initialized;
  assert.equal(attempts, 2);
  assert.equal(watcher.healthy, false, 'initialized is not a healthy guarantee');
  assert.equal(watcher.watchCount, 0);
  assert(handles.every(handle => handle.closed));
  assert.equal(diagnostics[0]?.retryMs, 60_000, 'the future retry has not held up initialization');
  await watcher.close();
  assert.equal(attempts, 2);
  const closing = new WorkspaceWatch(root, () => {});
  await closing.close(); await closing.initialized;
  assert.equal(closing.watchCount, 0, 'closing before registration also releases initialization');
});

test('directory watches deliver file content, atomic saves, populated new directories and replacement; symlinks stay outside', async t => {
  const { base, root } = await fixture(t), task = join(root, 'tasks', 'T1');
  await mkdir(task, { recursive: true });
  await writeFile(join(task, 'a.txt'), 'before');
  const changed: (string | undefined)[] = [], faults: unknown[] = [];
  const watcher = new WorkspaceWatch(root, path => changed.push(path), { diagnostic: entry => faults.push(entry) });
  t.after(() => watcher.close());
  await until(() => watcher.healthy, 'initial directory graph registers');
  assert.equal(watcher.watchCount, 3);
  const nativeBefore = process.platform === 'linux' ? watches() : 0;
  for (let n = 0; n < 200; n++) await writeFile(join(task, `file-${n}`), 'x');
  await delay(50);
  assert.equal(watcher.watchCount, 3, 'regular files create no additional subscriptions');
  if (process.platform === 'linux') assert.equal(watches(), nativeBefore, 'kernel watch resources also stay constant');

  changed.length = 0; await writeFile(join(task, 'a.txt'), 'changed');
  await until(() => changed.includes('tasks/T1/a.txt'), 'in-place file content reaches the caller');
  changed.length = 0; await writeFile(join(task, 'temp'), 'atomic'); await rename(join(task, 'temp'), join(task, 'a.txt'));
  await until(() => changed.includes('tasks/T1/a.txt'), 'atomic replacement reaches the caller');

  const staged = join(base, 'staged'); await mkdir(join(staged, 'deep'), { recursive: true });
  await writeFile(join(staged, 'deep', 'existing.txt'), 'before registration');
  changed.length = 0; await rename(staged, join(task, 'moved'));
  await until(() => watcher.watchCount === 5 && changed.includes('tasks/T1/moved/deep') && changed.includes(undefined), 'populated directories get subscriptions and a repair notification');
  changed.length = 0; await writeFile(join(task, 'moved', 'deep', 'existing.txt'), 'after registration');
  await until(() => changed.includes('tasks/T1/moved/deep/existing.txt'), 'new nested file content remains observable');
  await rename(join(task, 'moved'), join(base, 'removed'));
  await until(() => watcher.watchCount === 3, 'moved-out directories close their subscriptions');
  await mkdir(join(task, 'moved')); await writeFile(join(task, 'moved', 'new.txt'), 'replacement');
  await until(() => watcher.watchCount === 4, 'same name gets a new directory subscription');
  changed.length = 0; await writeFile(join(task, 'moved', 'new.txt'), 'second');
  await until(() => changed.includes('tasks/T1/moved/new.txt'), 'replacement inode remains observable');

  const outside = join(base, 'outside'); await mkdir(join(outside, 'nested'), { recursive: true });
  await symlink(outside, join(task, 'link')); await delay(100);
  assert.equal(watcher.watchCount, 4, 'a directory symlink is not traversed');
  changed.length = 0; await writeFile(join(outside, 'nested', 'secret.txt'), 'outside'); await delay(100);
  assert.deepEqual(changed, [], 'outside writes are not reported through a symlink');
  assert.deepEqual(faults, []);
  await watcher.close(); assert.equal(watcher.watchCount, 0); assert.equal(watcher.healthy, false);
});

test('missing/unsafe filenames demand a directory reread, without accepting an escaping path', async t => {
  const { root } = await fixture(t), active: FakeWatch[] = [], changed: (string | undefined)[] = [];
  const watcher = new WorkspaceWatch(root, path => changed.push(path), {
    watchDirectory: (_path, listener) => { const value = new FakeWatch(listener); active.push(value); return value; },
  });
  t.after(() => watcher.close()); await until(() => watcher.healthy, 'watcher ready'); changed.length = 0;
  active[0]!.notify('change', null); active[0]!.notify('rename', '../escape');
  assert.deepEqual(changed, [undefined, undefined]);
  await watcher.close();
});

test('partial registration faults close every handle and bounded retry repairs the notification gap', async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'child'));
  const handles: FakeWatch[] = [], diagnostics: Record<string, unknown>[] = [], changed: (string | undefined)[] = [];
  let attempts = 0;
  const watcher = new WorkspaceWatch(root, path => changed.push(path), {
    retryDelays: [15], diagnostic: entry => diagnostics.push(entry),
    watchDirectory: (_path, listener) => {
      if (++attempts === 2) throw Object.assign(new Error('watch budget exhausted'), { code: 'ENOSPC' });
      const handle = new FakeWatch(listener); handles.push(handle); return handle;
    },
  });
  t.after(() => watcher.close());
  await until(() => diagnostics.some(entry => entry.state === 'degraded'), 'fault is observable');
  assert.equal(handles[0]!.closed, true); assert.equal(watcher.healthy, false); assert.equal(watcher.watchCount, 0);
  await until(() => watcher.healthy, 'bounded retry rebuilds the entire graph');
  assert.equal(watcher.watchCount, 2);
  assert(diagnostics.some(entry => entry.state === 'recovered'));
  assert(changed.filter(path => path === undefined).length >= 2, 'failure and recovery both invalidate missed facts');
  handles[0]!.emit('error', Object.assign(new Error('late error from a retired generation'), { code: 'ENOSPC' }));
  assert.equal(watcher.healthy, true, 'retired callbacks cannot discard the recovered generation');
  handles.at(-1)!.emit('error', Object.assign(new Error('access revoked'), { code: 'EACCES' }));
  assert.equal(watcher.watchCount, 0); assert(handles.every(handle => handle.closed));
  const calls = attempts; await delay(60); assert.equal(attempts, calls, 'permanent faults are not retried');
});

test('close leaves no registration or retry work running, and a fault no retry can help ends it', async t => {
  const { root } = await fixture(t); const faults: Record<string, unknown>[] = []; let attempts = 0;
  const watcher = new WorkspaceWatch(root, () => {}, {
    retryDelays: [5, 5], diagnostic: entry => faults.push(entry),
    watchDirectory: () => { attempts++; throw Object.assign(new Error('no resources'), { code: 'EMFILE' }); },
  });
  t.after(() => watcher.close()); await until(() => faults.length >= 3, 'retries go on');
  await watcher.close(); await watcher.close(); assert.equal(watcher.watchCount, 0);
  const closedAt = attempts; await delay(30); assert.equal(attempts, closedAt, 'close cancels the pending retry');
  const denied: Record<string, unknown>[] = []; let tries = 0;
  const refused = new WorkspaceWatch(root, () => {}, {
    retryDelays: [5], diagnostic: entry => denied.push(entry),
    watchDirectory: () => { tries++; throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
  });
  t.after(() => refused.close()); await until(() => denied.length === 1, 'the fault is reported');
  assert.equal(denied[0]!.retryMs, null); await delay(30); assert.equal(tries, 1, 'no retry helps a refusal');
  let registrations = 0;
  const closing = new WorkspaceWatch(root, () => {}, {
    watchDirectory: (_path, listener) => { registrations++; return new FakeWatch(listener); },
  });
  await closing.close(); await delay(30); assert.equal(registrations, 0, 'close cancels registration before its first turn');
});


test('close during partial registration and a pending retry closes resources and cancels continuation', async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'child'));
  const handles: FakeWatch[] = []; let closing: WorkspaceWatch, closed: Promise<void> | undefined;
  closing = new WorkspaceWatch(root, () => {}, {
    watchDirectory: (_path, listener) => {
      const handle = new FakeWatch(listener); handles.push(handle);
      queueMicrotask(() => { closed = closing.close(); }); return handle;
    },
  });
  await until(() => closed !== undefined, 'close starts after the first registration'); await closed;
  assert.equal(handles.length, 1); assert(handles.every(handle => handle.closed)); assert.equal(closing.watchCount, 0);
  let attempts = 0;
  const retrying = new WorkspaceWatch(root, () => {}, {
    retryDelays: [50], diagnostic: () => {},
    watchDirectory: () => { attempts++; throw Object.assign(new Error('full'), { code: 'ENOSPC' }); },
  });
  await until(() => attempts === 1, 'retry is pending'); await retrying.close(); await delay(80);
  assert.equal(attempts, 1, 'close cancels the retry timer');
});


test('a symlink substituted after pre-checks is discarded before subscribing to outside descendants', async t => {
  const { base, root } = await fixture(t), child = join(root, 'child'), outside = join(base, 'outside');
  await mkdir(child); await mkdir(join(outside, 'grandchild'), { recursive: true });
  await writeFile(join(outside, 'grandchild', 'private.txt'), 'generated test content');
  const registrations: { path: string; watch: FakeWatch }[] = [], faults: unknown[] = [];
  let replaced = false;
  const watcher = new WorkspaceWatch(root, () => {}, {
    diagnostic: entry => faults.push(entry),
    watchDirectory: (path, listener) => {
      if (path === child && !replaced) {
        // This boundary follows lstat/realpath but precedes the path-based opendir.
        replaced = true; renameSync(child, join(base, 'original')); symlinkSync(outside, child);
      }
      const watch = new FakeWatch(listener); registrations.push({ path, watch }); return watch;
    },
  });
  try {
    await until(() => watcher.healthy, 'the post-check finishes discarding the replaced path');
    assert.equal(replaced, true);
    assert.deepEqual(registrations.map(entry => entry.path), [root, child], 'outside grandchildren never become watch targets');
    assert.equal(registrations.find(entry => entry.path === child)!.watch.closed, true, 'the raced subscription is closed');
    assert.equal(watcher.watchCount, 1, 'only the valid root subscription remains');
    assert.deepEqual(faults, [], 'ordinary replacement is repaired without a permanent watch fault');
  } finally { await watcher.close(); }
  assert(registrations.every(entry => entry.watch.closed), 'shutdown also releases the valid subscription');
});

test('a directory left out spends no watch, and nothing below it does', async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, 'kept', 'below'), { recursive: true });
  await mkdir(join(root, 'left', 'below'), { recursive: true });
  const watched: string[] = [];
  const watcher = new WorkspaceWatch(root, () => {}, {
    covers: path => path !== 'left',
    watchDirectory: (path, listener) => { watched.push(path); return new FakeWatch(listener); },
  });
  t.after(() => watcher.close());
  await watcher.initialized;
  assert.equal(watcher.healthy, true);
  assert.deepEqual(watched.map(path => path.slice(root.length)).sort(), ['', '/kept', '/kept/below']);
});

test('an exhausted budget is tried again for as long as it stays exhausted', async t => {
  const { root } = await fixture(t);
  let attempts = 0, exhausted = true;
  const retries: unknown[] = [];
  const watcher = new WorkspaceWatch(root, () => {}, {
    retryDelays: [5], diagnostic: entry => { if (entry.state === 'degraded') retries.push(entry.retryMs); },
    watchDirectory: (_path, listener) => {
      attempts++;
      if (exhausted) throw Object.assign(new Error('budget exhausted'), { code: 'ENOSPC' });
      return new FakeWatch(listener);
    },
  });
  t.after(() => watcher.close());
  await until(() => attempts >= 4, 'it keeps trying after the last delay');
  assert(retries.every(delay => delay === 5), 'the last delay repeats');
  exhausted = false;
  await until(() => watcher.healthy, 'it recovers once the budget is back');
});
