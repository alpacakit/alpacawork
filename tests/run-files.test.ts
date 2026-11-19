import { reconcileCompletedRunFiles } from '@alpacawork/backend/test-dist/runs/gc.js';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';
/** HTTP and CLI run-file reads use seeded records and never launch an agent. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tryLock } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { controlRunFilesSchema } from '@alpacawork/contract/control';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { PushStore } from '@alpacawork/backend/test-dist/receiver/push.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readRunFiles } from '@alpacawork/backend/test-dist/runs/view.js';
import { RESULT_LIMIT, openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';

async function setup(t: TestContext, seed = true, seedResult?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-b6-')));
  let store: RunStore | undefined;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await app?.close(); store?.close(); rmSync(root, { recursive: true, force: true }); });
  const writer = new FileWriter(root);
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  const taskId = (await new ControlTaskCommands(root, { kind: 'human' })
    .create({ parentId: project, userRequested: false, tasks: [{ title: 'Run files' }] })).tasks[0].id;
  let id = 'R1';
  if (seed) {
    store = new RunStore(root, { busyTimeoutMs: 0 });
    id = store.write(tx => {
      const run = createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: taskId, placementId: 'Ptest', agent: 'fake', role: 'owner', resumes: null, continues: false,
        session: null, caller: null, cwd: root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {}} }, 'Original prompt');
      if (seedResult === undefined)
        tx.update({ ...run, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() });
      else {
        tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
        tx.finish({ ...tx.get(run.id)!, state: 'succeeded', ended_at: new Date().toISOString() },
          { state: 'present', text: seedResult });
      }
      return run.id;
    });
  }
  const folder = join(root, '.alpacawork', 'runs', id);
  if (seed) mkdirSync(folder, { recursive: true });
  async function http(run = id, kind?: string) {
    app ??= await startServer(root, 0);
    const query = new URLSearchParams({ run });
    if (kind) query.set('kind', kind);
    const response = await fetch(new URL(`/api/run/get?${query}`, app.url));
    return { status: response.status, body: await response.json() };
  }
  async function cli(...args: string[]) {
    app ??= await startServer(root, 0);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/cli/dist/cli.js', import.meta.url)),
      '--server', app.url, ...args], { env: cleanCliEnv() });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { code, stdout, stderr };
  }
  async function screenIndex() {
    app ??= await startServer(root, 0);
    return JSON.parse(app.feed()!.index());
  }
  async function screenView() {
    app ??= await startServer(root, 0);
    return app.feed()!.view(taskId);
  }
  return { root, folder, id, taskId, http, cli, screenIndex, screenView };
}

test('HTTP and CLI return the result by default and the prompt only when asked', async t => {
  const h = await setup(t, true, 'Final reply');
  const reply = await h.http(); assert.equal(reply.status, 200);
  const files = controlRunFilesSchema.parse(reply.body);
  assert.equal(files.taskId, h.taskId, 'the caller can locate its own Task without reading prompt text');
  assert.deepEqual(files.files, [
    { kind: 'result', state: 'present', source: 'alpacawork.sqlite', bytes: 11, text: 'Final reply' },
  ]);
  const cli = await h.cli('run', 'get', '--run', h.id);
  assert.equal(cli.code, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), files);
  const prompt = { kind: 'prompt', state: 'present', source: 'alpacawork.sqlite', bytes: 15, text: 'Original prompt' };
  assert.deepEqual((await h.http(h.id, 'prompt')).body.files, [prompt]);
  assert.deepEqual(JSON.parse((await h.cli('run', 'get', '--run', h.id, '--kind', 'prompt')).stdout).files, [prompt]);
});

test('ended missing result is missing, queued missing result is pending', async t => {
  const h = await setup(t);
  assert.equal((await h.http()).body.files[0].state, 'missing');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const queued = store.write(tx => createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: h.taskId, placementId: 'Ptest', agent: 'fake', role: 'worker', resumes: null, continues: false,
      session: null, caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {}} }, 'Queued prompt'));
    assert.equal(readRunFiles(h.root, queued.id, 'result').files[0]?.state, 'pending');
  } finally { store.close(); }
});

test('run-files bounds database text and reports stored result failure states', async t => {
  const h = await setup(t, true, 'r'.repeat(RESULT_LIMIT));
  const db = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'));
  try { db.prepare('UPDATE runs SET prompt = ? WHERE id = 1').run('p'.repeat(256 * 1024)); }
  finally { db.close(); }
  const files = [...(await h.http(h.id, 'prompt')).body.files, ...(await h.http()).body.files];
  assert.deepEqual(files.map((file: {state: string}) => file.state), ['present', 'present']);
  assert.equal(files[0].bytes, 256 * 1024);
  const update = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'));
  try { update.exec("UPDATE runs SET result = NULL, result_state = 'too_large' WHERE id = 1"); }
  finally { update.close(); }
  assert.equal((await h.http()).body.files[0].state, 'too_large');
});

test('strict control DB refuses non-text Run content and preserves readable files', async t => {
  const h = await setup(t, true, 'reply');
  const db = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'));
  try { assert.throws(() => db.exec("UPDATE runs SET prompt = X'FF', result = X'FE' WHERE id = 1"), /BLOB value in TEXT column/); }
  finally { db.close(); }
  assert.equal((await h.http(h.id, 'prompt')).body.files[0].state, 'present');
  assert.equal((await h.http()).body.files[0].state, 'present');
});
test('Run store refuses oversized success without ending the Run', async t => {
  const h = await setup(t);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const run = store.write(tx => createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: h.taskId, placementId: 'Ptest', agent: 'fake', role: 'owner', resumes: null, continues: false,
      session: null, caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {} } }, 'prompt'));
    store.write(tx => tx.update({ ...run, state: 'running', started_at: new Date().toISOString() }));
    assert.throws(() => store.write(tx => tx.finish({ ...tx.get(run.id)!, state: 'succeeded', ended_at: new Date().toISOString() },
      { state: 'present', text: 'x'.repeat(RESULT_LIMIT + 1) })), /too large/);
    assert.equal(store.get(run.id)?.state, 'running');
    assert.equal(store.getText(run.id)?.resultState, 'pending');
  } finally { store.close(); }
});

test('a missing Run is explicit', async t => {
  const h = await setup(t, false);
  assert.equal((await h.http()).body.error.code, 'not_found');
});

test('run-files validates ID and allowed kind before file access', async t => {
  const h = await setup(t);
  assert.equal((await h.http('../outside')).body.error.code, 'invalid_input');
  assert.equal((await h.http(h.id, 'stdout')).body.error.code, 'invalid_input');
});

test('an invalid stored Run fails closed without affecting another Run file', async t => {
  const h = await setup(t);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { store.write(tx => createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: h.taskId, placementId: 'Ptest', agent: 'fake', role: 'worker', resumes: null, continues: false,
    session: null, caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {} } }, 'Other prompt')); }
  finally { store.close(); }
  const db = new DatabaseSync(join(h.root, '.alpacawork/alpacawork.sqlite'));
  try { db.exec("UPDATE runs SET record = json_set(record, '$.state', 'invalid') WHERE id = 2"); } finally { db.close(); }
  assert.equal((await h.http(h.id, 'prompt')).body.files[0].state, 'present');
  assert.equal((await h.http('R2')).body.error.code, 'runs_unavailable');
});

test('serve recovery removes only temporary files matching a completed Run in DB', async t => {
  const h = await setup(t, true, 'final reply');
  writeFileSync(join(h.folder, 'prompt.tmp'), 'Original prompt');
  writeFileSync(join(h.folder, 'result.tmp'), 'final reply');
  assert.equal((await h.http()).body.files[0].text, 'final reply');
  assert.equal(existsSync(join(h.folder, 'prompt.tmp')), false);
  assert.equal(existsSync(join(h.folder, 'result.tmp')), false);
});

test('serve starts with conflicting temporary output, preserves evidence and reports review alongside a healthy Run', async t => {
  let observations = 0, deliveries = 0;
  const observe = PushStore.prototype.observe, tick = PushStore.prototype.tick;
  t.mock.method(PushStore.prototype, 'observe', function (this: PushStore, ...args: Parameters<PushStore['observe']>) {
    observations++; return observe.apply(this, args);
  });
  t.mock.method(PushStore.prototype, 'tick', function (this: PushStore, ...args: Parameters<PushStore['tick']>) {
    deliveries++; return tick.apply(this, args);
  });
  const h = await setup(t, true, 'final reply');
  writeFileSync(join(h.folder, 'prompt.tmp'), 'Original prompt');
  writeFileSync(join(h.folder, 'result.tmp'), 'uncommitted different reply');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  let other: string;
  try {
    other = store.write(tx => {
      const run = createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: h.taskId, placementId: 'Pother', agent: 'fake', role: 'worker', resumes: null, continues: false,
        session: null, caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {} } }, 'Healthy prompt');
      tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
      tx.finish({ ...tx.get(run.id)!, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'Healthy reply' });
      return run.id;
    });
    mkdirSync(store.folder(other), { recursive: true });
    writeFileSync(join(store.folder(other), 'result.tmp'), 'Healthy reply');
  } finally { store.close(); }
  const response = await h.http();
  assert.equal(response.status, 200);
  assert.equal(response.body.files[0].text, 'final reply');
  assert.equal((await h.http(other)).body.files[0].text, 'Healthy reply');
  assert.equal(existsSync(join(h.root, '.alpacawork/runs', other, 'result.tmp')), false,
    'review of one Run does not prevent cleanup of the next Run');
  const index = await h.screenIndex();
  const reviews = index.errors.filter((error: { path: string }) => error.path === `.alpacawork/runs/${h.id}/result.tmp`);
  assert.equal(reviews.length, 1, 'the screen receives one rebuildable review issue');
  assert.match(JSON.stringify(reviews[0].reason), /requires review.*retained.*differs/i);
  assert.equal(index.writable, true, 'file review does not disable workspace writes');
  const view = await h.screenView();
  assert.deepEqual(view.userQuestions, [], 'a Run diagnostic does not make human questions unknown');
  assert.deepEqual(view.userReviews, [], 'a Run diagnostic does not make human reviews unknown');
  const deadline = Date.now() + 4000;
  while ((!observations || !deliveries) && Date.now() < deadline) await delay(20);
  assert.ok(observations > 0 && deliveries > 0, 'healthy Task reads still reach both Push observation and delivery');
  const records = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.equal(records.get(h.id)?.state, 'succeeded');
    assert.equal(records.getText(h.id)?.result, 'final reply');
  } finally { records.close(); }
  assert.equal(existsSync(join(h.folder, 'prompt.tmp')), true);
  assert.equal(existsSync(join(h.folder, 'result.tmp')), true);
  assert.equal(readRunFiles(h.root, h.id, 'result').files[0]?.text, 'final reply');
});


test('serve retains a late result for an ended Run whose committed result is missing', async t => {
  const h = await setup(t);
  writeFileSync(join(h.folder, 'prompt.tmp'), 'Original prompt');
  writeFileSync(join(h.folder, 'result.tmp'), 'Agent result after manager loss');
  const response = await h.http();
  assert.equal(response.status, 200);
  assert.equal(response.body.files[0].state, 'missing');
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.equal(store.get(h.id)?.state, 'cancelled');
    assert.equal(store.getText(h.id)?.result, null);
  } finally { store.close(); }
  assert.equal(readFileSync(join(h.folder, 'prompt.tmp'), 'utf8'), 'Original prompt');
  assert.equal(readFileSync(join(h.folder, 'result.tmp'), 'utf8'), 'Agent result after manager loss');
  assert.equal((await h.screenIndex()).errors.filter((error: { path: string }) =>
    error.path === `.alpacawork/runs/${h.id}/result.tmp`).length, 1);
});


test('startup recovery leaves exchange cleanup to a manager holding its lock', async t => {
  const h = await setup(t, true, 'final reply');
  const lock = openRunFile(h.folder, 'manager.lock', constants.O_RDWR | constants.O_CREAT);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    assert.equal(tryLock(lock), true);
    writeFileSync(join(h.folder, 'result.tmp'), 'in-flight file');
    assert.equal(reconcileCompletedRunFiles(store, store.get(h.id)!).state, 'skipped');
    assert.equal(existsSync(join(h.folder, 'result.tmp')), true);
  } finally { closeSync(lock); store.close(); }
});

for (const scenario of ['mismatch', 'oversized', 'invalid UTF-8', 'symlink', 'non-regular file', 'read error'] as const) {
  test(`cleanup isolates ${scenario}, retaining every temporary file and committed text`, async t => {
    if (scenario === 'read error' && process.getuid?.() === 0) { t.skip('root can read mode-000 files'); return; }
    const h = await setup(t, true, 'final reply');
    const prompt = join(h.folder, 'prompt.tmp'), result = join(h.folder, 'result.tmp');
    writeFileSync(prompt, 'Original prompt');
    const outside = join(h.root, 'outside-result');
    if (scenario === 'symlink') { writeFileSync(outside, 'outside evidence'); symlinkSync(outside, result); }
    else if (scenario === 'non-regular file') mkdirSync(result);
    else writeFileSync(result, scenario === 'mismatch' ? 'late different reply'
      : scenario === 'oversized' ? Buffer.alloc(RESULT_LIMIT + 1, 120) : Buffer.from([0xff, 0xfe]));
    if (scenario === 'read error') chmodSync(result, 0);
    const store = new RunStore(h.root, { busyTimeoutMs: 0 });
    try {
      const result = reconcileCompletedRunFiles(store, store.get(h.id)!);
      assert.equal(result.state, 'review');
      assert.equal(result.issues.length, 1);
      assert.equal(result.issues[0].runId, h.id);
      assert.equal(result.issues[0].path, `.alpacawork/runs/${h.id}/result.tmp`);
      assert.match(result.issues[0].message, /requires review.*retained/);
      if (scenario === 'mismatch' || scenario === 'invalid UTF-8') {
        assert.match(result.issues[0].sha256!, /^[0-9a-f]{64}$/);
        assert.ok(result.issues[0].bytes! > 0);
      }
      if (scenario === 'oversized') assert.equal(result.issues[0].bytes, RESULT_LIMIT + 1);
      assert.equal(store.getText(h.id)?.prompt, 'Original prompt');
      assert.equal(store.getText(h.id)?.result, 'final reply');
      assert.equal(store.get(h.id)?.state, 'succeeded');
    } finally { store.close(); }
    assert.equal(readFileSync(prompt, 'utf8'), 'Original prompt');
    assert.equal(existsSync(result), true);
    if (scenario === 'symlink') assert.equal(readFileSync(outside, 'utf8'), 'outside evidence');
  });
}

test('a failed Run without a reply tells its reader the agent\'s own error', async t => {
  const h = await setup(t, false);
  const store = new RunStore(h.root, { busyTimeoutMs: 0 });
  let id: string;
  try {
    const run = store.write(tx => createFixtureRun(store, tx, { requestId: globalThis.crypto.randomUUID(), task: h.taskId, placementId: 'Ptest', agent: 'codex', role: 'worker', resumes: null, continues: false,
      session: { provider: 'codex', id: 'synthetic-session' }, caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {} } }, 'prompt'));
    store.write(tx => tx.update({ ...tx.get(run.id)!, state: 'running', started_at: new Date().toISOString() }));
    store.write(tx => tx.finish({ ...tx.get(run.id)!, state: 'failed', reason: 'exit', ended_at: new Date().toISOString() },
      { state: 'missing', text: null }));
    id = run.id;
  } finally { store.close(); }
  const folder = join(h.root, '.alpacawork', 'runs', id); mkdirSync(folder, { recursive: true });
  const message = 'This content was flagged for possible cybersecurity risk.';
  writeFileSync(join(folder, 'stdout.log'), [{ type: 'thread.started', thread_id: 'synthetic-session' },
    { type: 'turn.started' }, { type: 'error', message }, { type: 'turn.failed', error: { message } }]
    .map(row => JSON.stringify(row)).join('\n') + '\n');
  const reply = controlRunFilesSchema.parse((await h.http(id)).body);
  assert.equal(reply.files[0]!.state, 'missing');
  assert.deepEqual(reply.failure, { message });
  assert.equal((await h.http(id, 'prompt')).body.failure, undefined, 'the prompt read stays the prompt alone');
});
