import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { alive, cli, cliEntry, http, setup, until } from './harness.ts';
import { connectionPath, readConnection } from '@alpacawork/contract/connection';
import { DEFAULT_SERVER_PORT } from '@alpacawork/contract/default-server';

test('a spawned agent CLI uses the origin actually listening on a nondefault port', async t => {
  const h = await setup(t);
  const app = await h.server();
  assert.notEqual(new URL(app.url).port, String(DEFAULT_SERVER_PORT));
  assert.equal(readConnection(connectionPath(h.root)).url.origin, new URL(app.url).origin);
  const run = h.seed({}, 'queued', { cliTaskGet: h.task!.id, cliPath: cliEntry });
  const prior = process.env.ALPACAWORK_SERVER;
  process.env.ALPACAWORK_SERVER = 'http://127.0.0.1:1';
  try { await h.tick(); }
  finally { if (prior === undefined) delete process.env.ALPACAWORK_SERVER;
    else process.env.ALPACAWORK_SERVER = prior; }
  await h.waitState(run.id, 'succeeded');
  const output = JSON.parse(h.getStore().getText(run.id)!.result!);
  assert.equal(output.code, 0, JSON.stringify(output));
  assert.equal(output.server, new URL(app.url).origin);
  assert.equal(JSON.parse(output.body).task.id, h.task!.id);
});

test('CLI stop receipt failure leaves a lost agent alive and same op-id can be reconciled', async t => {
  const h = await setup(t);
  const app = await h.server();
  const run = h.seed({}, 'queued', { group: true, stubborn: true });
  await h.tick();
  const running = await h.ready(run.id);
  assert.ok(running.pids.manager && running.pids.agent);
  process.kill(running.pids.manager, 'SIGKILL');
  await until(() => !alive(running.pids.manager!), 'manager exits');
  await h.tick();
  assert.equal(h.getStore().get(run.id)?.state, 'needs_review');
  const opId = randomUUID();
  h.sql(db => db.exec("CREATE TRIGGER fail_stop_receipt BEFORE INSERT ON cli_operations BEGIN SELECT RAISE(ABORT, 'receipt failure'); END"));
  try {
    const failed = await cli(h.root, 'run stop', { run: run.id, 'op-id': opId });
    assert.notEqual(failed.code, 0);
    assert.equal(h.getStore().get(run.id)?.stop_requested, false);
    assert.equal(alive(running.pids.agent!, true), true);
    assert.equal((await http(app.url, `operation/get?opId=${opId}`)).body.state, 'not_found');
  } finally { h.sql(db => db.exec('DROP TRIGGER fail_stop_receipt')); }
  const stopped = await cli(h.root, 'run stop', { run: run.id, 'op-id': opId });
  assert.equal(stopped.code, 0, stopped.stderr);
  const receipt = await http(app.url, `operation/get?opId=${opId}`);
  assert.equal(receipt.body.state, 'committed');
  assert.deepEqual(receipt.body.body, stopped.body);
  await h.waitState(run.id, 'cancelled');
  assert.equal(alive(running.pids.agent!, true), false);
  const replayed = await cli(h.root, 'run stop', { run: run.id, 'op-id': opId });
  assert.deepEqual(replayed.body, stopped.body);
});

test('ordinary HTTP stop acknowledges publication, then recovery terminates its identified lost agent', async t => {
  const h = await setup(t);
  const app = await h.server();
  const run = h.seed({}, 'queued', { group: true });
  await h.tick();
  const running = await h.ready(run.id);
  process.kill(running.pids.manager!, 'SIGKILL');
  await until(() => !alive(running.pids.manager!), 'manager exits');
  await h.tick();
  const stopped = await http(app.url, 'run/stop', { run: run.id });
  assert.equal(stopped.status, 200);
  assert.deepEqual(stopped.body.cancelled, []);
  assert.deepEqual(stopped.body.stop_requested, [run.id]);
  await h.waitState(run.id,'cancelled');
  assert.equal(h.getStore().get(run.id)?.state, 'cancelled');
  assert.equal(alive(running.pids.agent!, true), false);
});

test('a replayed task new answers its first receipt, and Task folders are URLs', async t => {
  const h = await setup(t);
  const app = await h.server();
  const args = { title: 'Remote folder', parent: h.project, 'op-id': randomUUID() };
  const first = await cli(h.root, 'task new', args);
  assert.equal(first.code, 0, first.stderr);
  const repeated = await cli(h.root, 'task new', args);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.deepEqual(repeated.body, first.body);
  const task = first.body.task;
  const fetched = await cli(h.root, 'task get', { task: task.id });
  assert.equal(fetched.code, 0, fetched.stderr);
  assert.equal(fetched.body.task.folder, `${new URL(app.url).origin}/api/tasks/${task.id}/file?path=`,
    JSON.stringify(fetched.body));
  const upload = h.gate('remote-upload.md');
  writeFileSync(upload, 'Remote bytes');
  const savedFile = await cli(h.root, 'task file put', { task: task.id, path: 'remote-upload.md', file: upload,
    'op-id': randomUUID() });
  assert.equal(savedFile.code, 0, savedFile.stderr);
  const withFiles = await cli(h.root, 'task get', { task: task.id, files: '' });
  assert.equal(withFiles.code, 0, withFiles.stderr);
  assert.equal(withFiles.body.task.files[0].path,
    `${new URL(app.url).origin}/api/tasks/${task.id}/file?path=remote-upload.md`);
  const downloaded = await fetch(withFiles.body.task.files[0].path);
  assert.equal(await downloaded.text(), 'Remote bytes');
  const rejected = await cli(h.root, 'task new', { title: 'Invalid token', parent: h.project, 'op-id': randomUUID() },
    { env: { ALPACAWORK_RUN: 'R999', ALPACAWORK_RUN_TOKEN: 'a'.repeat(64) } });
  assert.notEqual(rejected.code, 0);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'forbidden');
});
