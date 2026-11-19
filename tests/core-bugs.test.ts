import { insertReturnFact } from './helpers/return-facts.ts';
import { initializeControlFixture, currentTaskHash } from './helpers/control-fixture.ts';
/** B1 and B5: exercise the real read and credential boundaries without agents. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, existsSync, readdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskRepository, taskFolder } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { readControlTree } from './helpers/control-tree.ts';
import { issueRunCredential, verifyRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { RunStore } from '@alpacawork/runs';

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-core-bugs-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  try { writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE));  }
  finally { writer.close(); }
  const project = initializeControlFixture(root);
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null,
    tasks: [{ title: 'Synthetic core regression' }] })).tasks[0];
  mkdirSync(join(root, taskFolder(task.id)), { recursive: true });
  return { root, task };
}
/**
 * Commits `write` from another connection once, right after the first SELECT of a read on `db`: the rest of that
 * read must still see the point its first SELECT read at. Returns whether the commit happened.
 */
function commitAfterFirstSelect(t: TestContext, db: DatabaseSync, write: () => void): () => boolean {
  const prepare = db.prepare.bind(db);
  let committed = false;
  t.mock.method(db, 'prepare', (sql: string) => {
    const stmt = prepare(sql);
    const all = stmt.all.bind(stmt);
    t.mock.method(stmt, 'all', (...args: Parameters<typeof all>) => {
      const rows = all(...args);
      if (!committed) { committed = true; write(); }
      return rows;
    });
    return stmt;
  });
  return () => committed;
}
async function requested(t: TestContext) {
  const h = await setup(t), people = new PlacementStore(h.root);
  const placement = people.createAndPlace({ taskId: h.task.id, profileKey: 'claude', responsible: true }).placement;
  people.close();
  const service = new RequestService(h.root);
  const first = await service.request({ taskId: h.task.id, mode: 'new', body: 'First', requestId: 'Q1',
    expectedTaskHash: h.task.hash, expectedPlacementRevision: placement.revision }, { purpose: 'instruction', actor: { kind: 'human' } });
  return { ...h, placement, service, first };
}

test('B1 Task, Run and policy facts retain one SQLite read point across a concurrent commit', async t => {
  const h = await requested(t), writer = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => writer.close());
  const original = TaskRepository.prototype.snapshot; let injected = false;
  t.mock.method(TaskRepository.prototype, 'snapshot', function(this: TaskRepository, ...args: Parameters<typeof original>) {
    const result = original.apply(this, args);
    if (!injected) { injected = true; writer.write(tx => {
      writer.connection.prepare("UPDATE tasks SET title='Concurrent title' WHERE external_id=?").run(h.task.id);
      tx.update({ ...tx.get(h.first.runId)!, state: 'running', started_at: new Date().toISOString() });
    }); }
    return result;
  });
  const tree = await readControlTree(h.root);
  assert.equal(injected, true); assert.deepEqual(tree.errors, []);
  assert.equal(tree.tasks.find(task => task.id === h.task.id)!.title, h.task.title);
  assert.equal(tree.runs[0]!.state, 'queued');
  const after = await readControlTree(h.root);
  assert.equal(after.tasks.find(task => task.id === h.task.id)!.title, 'Concurrent title');
  assert.equal(after.runs[0]!.state, 'running');
});

test('B1 a commit between SQLite SELECTs cannot split Runs, Requests, head or result state', async t => {
  const h = await requested(t), writer = new RunStore(h.root, { busyTimeoutMs: 0 });
  const reader = new RunStore(h.root, { busyTimeoutMs: 0 }, true);
  t.after(() => { reader.close(); writer.close(); });
  const initial = writer.get(h.first.runId)!;
  const request = writer.getRequest('Q1')!;
  const injected = commitAfterFirstSelect(t, reader.connection, () => writer.write(tx => {
    tx.insertRequest({ ...request, id: 'Q2', body: 'Second', headRunId: initial.id, mode: 'continue' });
    tx.create({ ...initial, requestId: 'Q2', resumes: initial.id, continues: false }, 'Second');
    tx.update({ ...initial, state: 'running', started_at: new Date().toISOString() });
    tx.finish({ ...tx.get(initial.id)!, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'Finished during read' });
  }));
  const tree = await readControlTree(h.root, { source: () => reader });
  assert.equal(injected(), true, 'commit crossed the actual SQLite read boundary');
  assert.deepEqual(tree.errors, []);
  assert.equal(tree.runs.length, tree.requests.length);
  assert.ok(tree.runs.some(run => run.id === tree.placements[0]!.headRunId));
  assert.equal(tree.replies[h.task.id]?.state, undefined, 'the pre-commit queued Run has no final result');
  const after = await readControlTree(h.root);
  assert.equal(after.runs.length, 2);
});

test('B5 a competing creator sees only a completed key and cannot replace it', async t => {
  const h = await setup(t), original = fs.writeSync;
  let second = '', injected = false;
  fs.writeSync = function(...args: Parameters<typeof original>) {
    if (!injected) { injected = true; second = issueRunCredential(h.root, 'R2'); }
    return Reflect.apply(original, fs, args);
  } as typeof original;
  syncBuiltinESMExports();
  let first: string;
  try { first = issueRunCredential(h.root, 'R1'); }
  finally { fs.writeSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  assert.equal(verifyRunCredential(h.root, 'R1', first!), true);
  assert.equal(verifyRunCredential(h.root, 'R2', second), true);
  const path = join(h.root, '.alpacawork', 'run-credential.key'), key = readFileSync(path);
  assert.equal(key.length, 32);
  assert.equal(issueRunCredential(h.root, 'R1'), first!);
  assert.deepEqual(readFileSync(path), key);
  assert.deepEqual(readdirSync(join(h.root, '.alpacawork')).filter(name => name.includes('run-credential')), ['run-credential.key']);
});

test('B5 interrupted key writing publishes nothing and next creation succeeds', async t => {
  const h = await setup(t), original = fs.writeSync;
  fs.writeSync = (() => { throw new Error('Interrupted key write'); }) as typeof original;
  syncBuiltinESMExports();
  try { assert.throws(() => issueRunCredential(h.root, 'R1'), /Interrupted key write/); }
  finally { fs.writeSync = original; syncBuiltinESMExports(); }
  assert.equal(existsSync(join(h.root, '.alpacawork', 'run-credential.key')), false);
  const token = issueRunCredential(h.root, 'R1');
  assert.equal(verifyRunCredential(h.root, 'R1', token), true);
});

test('B5 a colliding dangling entry leaves the credential key unavailable', async t => {
  const h = await setup(t), path = join(h.root, '.alpacawork', 'run-credential.key');
  const original = fs.writeSync;
  let injected = false;
  fs.writeSync = function(...args: Parameters<typeof original>) {
    if (!injected) {
      injected = true;
      symlinkSync('run-credential.key.target', path);
    }
    return Reflect.apply(original, fs, args);
  } as typeof original;
  syncBuiltinESMExports();
  try {
    assert.throws(() => issueRunCredential(h.root, 'R1'), { code: 'forbidden' });
  } finally { fs.writeSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
});

test('B5 rejects an existing credential key with an invalid length', async t => {
  const h = await setup(t), path = join(h.root, '.alpacawork', 'run-credential.key');
  writeFileSync(path, Buffer.alloc(0), { mode: 0o600 });
  assert.throws(() => issueRunCredential(h.root, 'R1'), { code: 'forbidden' });
  assert.equal(verifyRunCredential(h.root, 'R1', 'a'.repeat(64)), false);
});

test('B1 RunStore snapshot retains placement, return and result metadata from its read point', async t => {
  const h = await requested(t), store = new RunStore(h.root, { busyTimeoutMs: 0 });
  t.after(() => store.close());
  // The return closes a Request the seat sent: the first Run's Request to a member, as admission records one.
  const people = new PlacementStore(h.root);
  let memberId: string;
  try { memberId = people.createAndPlace({ taskId: h.task.id, profileKey: 'claude', responsible: false }).placement.id; }
  finally { people.close(); }
  const asked = store.write(tx => {
    const tasks = new TaskRepository(h.root, store.connection), requestId = randomUUID(), first = tx.get(h.first.runId)!;
    const waitCycleId = new ReturnLifecycle(store.connection, tx, tasks.related(h.task.id).tasks, tasks.projectFor(h.task.id))
      .cycleFor(h.task.id);
    tx.insertRequest({ id: requestId, taskId: h.task.id, placementId: memberId, placementRevision: 1, taskHash: h.task.hash,
      waitCycleId, headRunId: null, mode: 'new', body: 'Member work', purpose: 'instruction',
      author: { kind: 'placement', placementId: h.placement.id }, submittedAt: new Date().toISOString(), deliveryState: 'queued' });
    return tx.create({ task: h.task.id, agent: first.agent, role: 'worker', placementId: memberId, requestId, resumes: null,
      continues: false, session: null, caller: { run: first.id }, cwd: first.cwd, launch: first.launch }, 'Member work');
  });
  const before = store.snapshot();
  const injected = commitAfterFirstSelect(t, store.connection, () => {
    const writer = new RunStore(h.root, { busyTimeoutMs: 0 });
    try { writer.write(tx => {
      for (const id of [h.first.runId, asked.id]) {
        tx.update({ ...tx.get(id)!, state: 'running', started_at: new Date().toISOString() });
        tx.finish({ ...tx.get(id)!, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'New reply' });
      }
      insertReturnFact(writer.connection, { id: `RET-${asked.id}`, requestId: asked.requestId, boundaryRunId: asked.id, outcome: 'succeeded', toTaskId: h.task.id, causeLogId: null, createdAt: new Date().toISOString() });
      writer.connection.prepare('UPDATE agents SET created_at = ? WHERE id = ?').run('2026-10-07T00:00:00.000Z', h.placement.agentId);
      writer.connection.prepare('UPDATE placements SET revision = revision + 1 WHERE id = ?').run(h.placement.id);
    }); } finally { writer.close(); }
  });
  assert.deepEqual(store.snapshot(), before, 'all six groups must describe the pre-commit read point');
  assert.equal(injected(), true);
  const after = store.snapshot();
  assert.equal(after.resultStates.get(h.first.runId), 'present');
  assert.equal(after.returns.length, 1);
  assert.equal(after.agents.find(agent => agent.id === h.placement.agentId)?.createdAt, '2026-10-07T00:00:00.000Z');
  assert.equal(after.placements.find(placement => placement.id === h.placement.id)?.revision, 2);
});

for (const zero of [false, true]) test(`B5 short key writes are completed before publication (zero=${zero})`, async t => {
  const h = await setup(t), original = fs.writeSync;
  fs.writeSync = ((fd: number, data: Buffer, offset: number) =>
    zero ? 0 : original(fd, data, offset, Math.min(3, data.length - offset))) as typeof original;
  syncBuiltinESMExports();
  try {
    if (zero) assert.throws(() => issueRunCredential(h.root, 'R1'), /made no progress/);
    else {
      const token = issueRunCredential(h.root, 'R1');
      assert.equal(verifyRunCredential(h.root, 'R1', token), true);
    }
  } finally { fs.writeSync = original; syncBuiltinESMExports(); }
  assert.equal(existsSync(join(h.root, '.alpacawork', 'run-credential.key')), !zero);
});
