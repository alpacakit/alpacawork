/** The caller's SQLite busy policy covers the first snapshot, not only later SQL. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { RunStore } from '@alpacawork/runs';
import { controlDatabasePath, openControlDatabase, openDatabase, readControlWorkspaceIdentity } from '@alpacawork/db';

function root(t: TestContext) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-busy-')));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function initialize(path: string) {
  // Keep validation uncached in the process under test.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {openControlDatabase} from '@alpacawork/db'; openControlDatabase(process.argv[1],{busyTimeoutMs:3000},false,true).close();", path],
  { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
}

test('both database openers reject the same invalid timeout range with their existing messages', t => {
  const path = root(t);
  for (const busyTimeoutMs of [-1, 0.5, 2_147_483_648, Number.NaN]) {
    assert.throws(() => openControlDatabase(path, { busyTimeoutMs }, false, true),
      { code: 'invalid_input', message: 'Invalid busy timeout' });
    assert.throws(() => openDatabase(join(path, 'host.sqlite'), 'host', { busyTimeoutMs }),
      { code: 'invalid_input', message: 'Busy timeout must be a nonnegative 32-bit integer' });
    assert.throws(() => readControlWorkspaceIdentity(path, { busyTimeoutMs }),
      { code: 'invalid_input', message: 'Invalid busy timeout', reason: { kind: 'invalid_busy_timeout' } });
  }
});

for (const readOnly of [false, true]) for (const busyTimeoutMs of [0, 50, 3000]) {
  test(`first ${readOnly ? 'reader' : 'writer'} snapshot honors busyTimeoutMs=${busyTimeoutMs}`, async t => {
    const path = root(t); initialize(path);
    // Hold SQLite's shared-lock byte range, including during last-close checkpoint.
    // The delay is a fault fixture; the implementation uses only SQLite's busy handler.
    const locker = spawn(process.execPath, [new URL('./fixtures/database-range-lock.ts', import.meta.url).pathname, controlDatabasePath(path), busyTimeoutMs === 3000 ? 'release' : 'hold'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const done = new Promise<number | null>((resolve, reject) => {
      locker.once('close', resolve); locker.once('error', reject);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        locker.stdout.once('data', () => resolve()); locker.once('error', reject);
      });
      const start = performance.now();
      const open = () => readOnly ? RunStore.openReadable(path, { busyTimeoutMs })! : new RunStore(path, { busyTimeoutMs });
      if (busyTimeoutMs === 3000) {
        const store = open();
        try {
          assert.deepEqual(store.read(), []);
          assert.equal(store.connection.prepare('PRAGMA busy_timeout').get()!.timeout, busyTimeoutMs);
        } finally { store.close(); }
      } else {
        assert.throws(open, (error: { code?: string; cause?: { errcode?: number } }) =>
          error.code === 'busy' && error.cause?.errcode === 5);
        const elapsed = performance.now() - start;
        assert.ok(elapsed < 1000, `must honor the short budget while the lock remains held: ${elapsed}ms`);
        if (busyTimeoutMs > 0) assert.ok(elapsed >= 30, `nonzero budget must reach validation: ${elapsed}ms`);
      }
      if (busyTimeoutMs !== 3000) locker.stdin.end('release\n');
      assert.equal(await done, 0);
    } finally {
      if (locker.exitCode === null && locker.signalCode === null) locker.kill('SIGKILL');
      await done;
    }
  });
}

test('competing writer processes are rejected without losing committed rows', async t => {
  const path = root(t);
  initialize(path);
  const writers = Array.from({ length: 8 }, (_, i) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      "import {RunStore} from '@alpacawork/runs'; const s=new RunStore(process.argv[1],{busyTimeoutMs:3000}); s.connection.prepare('INSERT INTO agents(id,created_at) VALUES(?,?)').run(process.argv[2],'2026'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000); s.close();",
      path, `A${i}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      child.once('close', code => resolve({ code, stderr })); child.once('error', reject);
    });
    return { child, done };
  });
  try {
    const results = await Promise.all(writers.map(writer => writer.done));
    const successful = results.filter(result => result.code === 0).length;
    assert.ok(successful >= 1 && successful < writers.length);
    for (const result of results) if (result.code !== 0) assert.match(result.stderr, /Another serve writer/);
    const store = RunStore.openReadable(path, { busyTimeoutMs: 0 })!;
    try {
      assert.equal(store.connection.prepare('SELECT count(*) n FROM agents').get()!.n, successful);
      assert.equal(store.connection.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    } finally { store.close(); }
  } finally {
    for (const { child } of writers) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.all(writers.map(writer => writer.done));
  }
});
