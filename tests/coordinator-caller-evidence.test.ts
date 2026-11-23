/** A failed real caller fixture must be captured before its cleanup removes the workspace. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanCliEnv } from './helpers/http-cli.ts';

test('caller cleanup preserves a failed real CLI case, its API and copied database; a missing capture is an error', t => {
  const base = process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR ?? resolve('.local/test-failures');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'caller-capture-contract-')), captures = join(root, 'captures');
  const child = join(root, 'subject.test.mts');
  const fixture = new URL('./coordinator-caller.fixture.ts', import.meta.url).href;
  writeFileSync(child, `import {test} from 'node:test';
import {callerWorkspace,call} from ${JSON.stringify(fixture)};
test('intentional caller failure',async t=>{
 const w=callerWorkspace(t),url=await w.start();
 const task=(await call(url,['task','new','--no-from-user','--parent',w.project,'--title','Evidence subject'])).task;
 await call(url,['task','get','--task',task.id]);
 throw new Error('intentional capture subject failure');
});`);
  t.after(() => {
    // A broken capture check keeps its own files at the permanent test-evidence path.
    if ((t as typeof t & { passed: boolean }).passed) rmSync(root, { recursive: true, force: true });
    else t.diagnostic(`Caller capture contract evidence: ${root}`);
  });
  const childEnv = cleanCliEnv({ ALPACAWORK_FAILURE_EVIDENCE_DIR: captures });
  delete childEnv.NODE_TEST_CONTEXT; // A fresh child runner, as in the existing fixture capture checks.
  const result = spawnSync(process.execPath, ['--test', child], { encoding: 'utf8', timeout: 30_000, env: childEnv });
  writeFileSync(join(root, 'child.stdout'), result.stdout ?? '');
  writeFileSync(join(root, 'child.stderr'), result.stderr ?? '');
  assert.ifError(result.error);
  assert.equal(result.status, 1, 'the child deliberately fails; this is not a product failure');
  assert.match(result.stdout, /tests 1/, 'the capture subject actually ran');
  const saved = existsSync(captures) ? readdirSync(captures) : [];
  assert.equal(saved.length, 1, 'the failed caller must be captured before cleanup, even without evidenceTest');
  const at = join(captures, saved[0]!);
  const manifest = JSON.parse(readFileSync(join(at, 'failure.json'), 'utf8'));
  assert.equal(manifest.originalError.message, 'intentional capture subject failure');
  assert.ok(manifest.outcomes.every((outcome: { error?: unknown }) => !outcome.error), 'capture faults stay explicit');
  assert.equal(existsSync(manifest.root), false, 'the fixture also completed its cleanup');
  const { calls } = JSON.parse(readFileSync(join(at, 'diagnostics.json'), 'utf8'));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--op-id'), 'record the exact CLI operation sent');
  assert.equal(calls[0].result.code, 0); assert.equal(calls[1].result.code, 0);
  const task = JSON.parse(calls[0].result.stdout).task;
  assert.equal(JSON.parse(calls[1].result.stdout).task.id, task.id);
  for (const name of ['live', 'host'])
    assert.equal(JSON.parse(readFileSync(join(at, name + '.json'), 'utf8')).status, 200);
  assert.ok(existsSync(join(at, 'runtime-raw/.alpacawork/alpacawork.sqlite')));
  // Inspection opens the backup of the disposable raw copy, never the original workspace database.
  const db = new DatabaseSync(join(at, 'control-backup.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(db.prepare('SELECT title FROM tasks WHERE external_id=?').get(task.id)!.title, 'Evidence subject');
  } finally { db.close(); }
});
