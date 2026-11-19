/** Replays must certify durability, rather than treating a visible file as a successful receipt. */
import assert from 'node:assert/strict';
import fs, { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ImmutableConflict, ImmutableSaveUnconfirmed, CleanupFailure, hasCode, publishImmutable, publishImmutableJson,
  readImmutable, readImmutableFd } from '@alpacawork/core';

function fixture(t: { after(work: () => void): unknown }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'immutable-durability-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function fault() { return Object.assign(new Error('synthetic durability I/O'), { code: 'EIO' }); }
function inject<T>(patch: Partial<typeof fs>, work: () => T): T {
  const originals: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) { originals[key] = (fs as any)[key]; (fs as any)[key] = value; }
  syncBuiltinESMExports();
  try { return work(); } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
}
const descriptorIs = (fd: number, path: string) => { const a = fs.fstatSync(fd), b = fs.statSync(path); return a.dev === b.dev && a.ino === b.ino; };
const unconfirmed = (error: unknown) => error instanceof Error && error.constructor.name === 'ImmutableSaveUnconfirmed';

test('JSON equivalence keeps original bytes/inode; byte API remains byte exact and borrowed fd reads preserve offsets', t => {
  const root = fixture(t), path = join(root, 'one.json');
  writeFileSync(path, ' { "b": 2, "a": 1 } \n', { mode: 0o600 }); const before = readFileSync(path), info = statSync(path);
  publishImmutableJson(root, 'one.json', { a: 1, b: 2 }, 1024);
  assert.deepEqual(readFileSync(path), before); assert.equal(statSync(path).ino, info.ino);
  assert.throws(() => publishImmutableJson(root, 'one.json', { a: 2, b: 2 }, 1024), ImmutableConflict);
  assert.throws(() => publishImmutable(root, 'one.json', '{"a":1,"b":2}'), ImmutableConflict);
  const fd = openSync(path, 'r');
  try { assert.deepEqual(readImmutableFd(fd, 1024), before); assert.deepEqual(readImmutableFd(fd, 1024), before); }
  finally { closeSync(fd); }
});

function continuousDirectoryFault(root: string, publish = publishImmutableJson) {
  const directory = join(root, 'records'); mkdirSync(directory, { mode: 0o700 });
  const sync = fs.fsyncSync; let faults = 0, successes = 0;
  inject({ fsyncSync(fd) { if (descriptorIs(fd, directory)) { faults++; throw fault(); } return sync(fd); } }, () => {
    for (let i = 0; i < 2; i++) {
      try { publish(directory, 'intent.json', { a: 1 }, 1024); successes++; } catch (error) { assert.ok(unconfirmed(error)); }
    }
  });
  assert.equal(faults, 2); assert.equal(successes, 0); assert.ok(fs.existsSync(join(directory, 'intent.json')));
  const ino = statSync(join(directory, 'intent.json')).ino;
  publish(directory, 'intent.json', { a: 1 }, 1024);
  assert.equal(statSync(join(directory, 'intent.json')).ino, ino);
}
test('publication and identical replay both fail while destination directory fsync fails; only recovered replay succeeds', t => continuousDirectoryFault(fixture(t)));

function continuousParentFault(root: string, publish = publishImmutableJson) {
  const directory = join(root, 'new-records'), sync = fs.fsyncSync; let faults = 0;
  inject({ fsyncSync(fd) { if (descriptorIs(fd, root)) { faults++; throw fault(); } return sync(fd); } }, () => {
    for (let i = 0; i < 2; i++) assert.throws(() => publish(directory, 'one.json', { a: 1 }, 1024), unconfirmed);
  });
  assert.equal(faults, 2); assert.ok(fs.existsSync(directory)); assert.equal(fs.existsSync(join(directory, 'one.json')), false);
  publish(directory, 'one.json', { a: 1 }, 1024);
}
test('an existing mkdir entry is resynced on every replay after a parent fsync failure', t => continuousParentFault(fixture(t)));

function renamedDirectoryFault(root: string, moveBack: boolean, publish = publishImmutableJson) {
  const first = join(root, 'first'), second = join(root, 'second');
  mkdirSync(first, { mode: 0o700 }); mkdirSync(second, { mode: 0o700 });
  const original = join(first, 'records'), moved = join(second, 'records');
  publish(original, 'one.json', { a: 1 }, 1024);
  const ino = statSync(original).ino;
  renameSync(original, moved);
  if (moveBack) renameSync(moved, original);
  const directory = moveBack ? original : moved, parent = moveBack ? first : second;
  assert.equal(statSync(directory).ino, ino, 'rename retains the inode, but its new link is unconfirmed');
  const sync = fs.fsyncSync; let faults = 0;
  inject({ fsyncSync(fd) { if (descriptorIs(fd, parent)) { faults++; throw fault(); } return sync(fd); } }, () => {
    for (let i = 0; i < 2; i++) assert.throws(() => publish(directory, 'two.json', { a: 2 }, 1024), unconfirmed);
  });
  assert.equal(faults, 2); assert.equal(fs.existsSync(join(directory, 'two.json')), false);
  publish(directory, 'two.json', { a: 2 }, 1024);
  assert.equal(statSync(directory).ino, ino);
}
for (const moveBack of [false, true]) test(`a previously synced inode needs its parent resynced after rename${moveBack ? ' away and back' : ' to another parent'}`,
  t => renamedDirectoryFault(fixture(t), moveBack));

test('destination file fsync, bounded readback and close failures remain distinct; missing files stay explicit', t => {
  const root = fixture(t), path = join(root, 'one.json'); publishImmutableJson(root, 'one.json', { a: 1 }, 1024);
  const sync = fs.fsyncSync, read = fs.readSync, close = fs.closeSync;
  inject({ fsyncSync(fd) { if (descriptorIs(fd, path)) throw fault(); return sync(fd); } }, () => {
    for (let i = 0; i < 2; i++) assert.throws(() => publishImmutableJson(root, 'one.json', { a: 1 }, 1024), unconfirmed);
  });
  inject({ readSync: ((fd: number, ...args: any[]) => { if (descriptorIs(fd, path)) throw fault(); return (read as any)(fd, ...args); }) as typeof fs.readSync,
    closeSync(fd) { const fail = descriptorIs(fd, path); close(fd); if (fail) throw new Error('synthetic close fault'); } }, () => {
    assert.throws(() => publishImmutableJson(root, 'one.json', { a: 1 }, 1024), error => {
      assert.ok(error instanceof ImmutableSaveUnconfirmed); assert.ok(error.cause instanceof CleanupFailure);
      assert.equal(error.errors.length >= 2, true); return true;
    });
  });
  assert.throws(() => readImmutable(root, 'absent.json', 1024), error => hasCode(error, 'ENOENT'));
  publishImmutableJson(root, 'one.json', { a: 1 }, 1024);
});

test('removing replay directory or existing-parent fsync makes the original durability assertions fail', async t => {
  const production = resolve('packages/core/dist/immutable-files.js'), source = readFileSync(production, 'utf8');
  for (const [name, marker, check] of [
    ['directory', 'fsyncSync(dir);', continuousDirectoryFault],
    ['parent', 'fsyncSync(parent);', continuousParentFault],
  ] as const) {
    assert.ok(source.includes(marker), marker);
    const file = join(dirname(production), `immutable-${name}-${process.pid}.js`); t.after(() => rmSync(file, { force: true }));
    writeFileSync(file, source.replace(marker, ''));
    const mutant = await import(pathToFileURL(file).href);
    assert.throws(() => check(fixture(t), mutant.publishImmutableJson), assert.AssertionError);
  }
});
