/** Stable closing returns and bounded Task reads through the actual owners. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { taskFlow, DECIDE } from './task-flow.fixture.ts';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { readTaskListView, readTaskView } from '@alpacawork/backend/test-dist/control/task-views.js';
import { seatFactsOf, seatSourceOf } from '@alpacawork/backend/test-dist/control/wake.js';

const transaction = <T>(root: string, work: (db: DatabaseSync, store: RunStore) => T): T => {
  const control = new ControlStore(root);
  try { return control.write(db => {
    const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
    try { return work(db, store); } finally { store.close(); }
  }); } finally { control.close(); }
};

test('archive, route a close, then restore never reopens the child Request or its wait cycle', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), parentRun = await f.work(parent);
  const child = await f.task('Child', { parentId: parent.id, values: DECIDE });
  const childRun = await f.work(child, parentRun);
  await f.ask(childRun); f.end(childRun); f.end(parentRun);
  const requestId = f.run(childRun).requestId;
  await f.commands.lifecycle({ id: child.id, action: 'archive', expectedTaskHash: (await f.get(child.id)).hash });
  const reconcile = () => transaction(f.root, (db, store) => store.write(tx => {
    const tasks = new TaskRepository(f.root, db).snapshot(f.project).tasks;
    const lifecycle = new ReturnLifecycle(db, tx, tasks, f.project);
    lifecycle.reconcile();
    return { open: lifecycle.openRequests(parent.id), rows: tx.returns(f.project).filter(row => row.requestId === requestId),
      cycles: db.prepare('SELECT id,closed_at FROM wait_cycles WHERE task_id=?').all(parent.id) };
  }));
  const closed = reconcile();
  assert.deepEqual(closed.open, []);
  assert.equal(closed.rows.length, 1);
  assert.equal(closed.rows[0]!.outcome, 'closed');
  assert.ok(closed.cycles[0]!.closed_at);
  await f.commands.lifecycle({ id: child.id, action: 'restore', expectedTaskHash: (await f.get(child.id)).hash });
  const restored = reconcile();
  assert.deepEqual(restored.open, [], 'a committed closing return outranks current availability');
  assert.deepEqual(restored.rows, closed.rows, 'no replacement or second close');
  assert.deepEqual(restored.cycles, closed.cycles, 'the closed cycle stays closed');
  transaction(f.root, (db, store) => {
    const tasks = new TaskRepository(f.root, db).snapshot(f.project).tasks;
    const source = seatSourceOf(tasks, store.snapshot(f.project), { profiles: new Set(['fake']), automaticLimit: 2000 });
    assert.equal(seatFactsOf(source, parent.id).openRequests, 0, 'wake and ball use the same stable closure');
  });
});

test('a leaf write reads its branch and request seats without unrelated sibling history', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent');
  const [leaf, unrelated] = await Promise.all([f.plan('Leaf', { parentId: parent.id }), f.plan('Unrelated')]);
  transaction(f.root, db => {
    const snapshot = new TaskRepository(f.root, db).related(leaf);
    assert.ok(snapshot.tasks.some(task => task.id === leaf));
    assert.ok(snapshot.tasks.some(task => task.id === parent.id));
    assert.ok(snapshot.tasks.some(task => task.id === f.project));
    assert.ok(!snapshot.tasks.some(task => task.id === unrelated));
  });
  const readLogs: string[] = [], original = DatabaseSync.prototype.prepare;
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    if (sql.includes('SELECT l.task_id,') && sql.includes('FROM task_log l')) readLogs.push(sql);
    return original.call(this, sql);
  });
  try { await f.commands.update({ id: leaf, title: 'Updated leaf', expectedTaskHash: (await f.get(leaf)).hash }); }
  finally { hook.mock.restore(); }
  assert.ok(readLogs.length > 0);
  assert.ok(readLogs.every(sql => sql.includes('json_each(?)')), 'every bulk history read has explicit Task IDs');
});

test('task list reads no Run snapshot, and direct task get stays in its project', async t => {
  const f = await taskFlow(t), own = await f.plan('Own');
  const otherProject = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: f.project, userRequested: false,
    tasks: [{ title: 'Other project' }] })).tasks[0]!;
  const other = await f.plan('Other', { parentId: otherProject.id });
  const original = RunStore.prototype.snapshot;
  const scopes: (string | undefined)[] = [];
  const hook = t.mock.method(RunStore.prototype, 'snapshot', function(this: RunStore, project?: string) {
    scopes.push(project); return original.call(this, project);
  });
  try {
    const list = await readTaskListView(f.root, {}, null);
    assert.ok(list.tasks.some(task => task.id === other));
    assert.equal(scopes.length, 0);
    assert.equal((await readTaskView(f.root, own, {}, null)).task.id, own);
    assert.deepEqual(scopes, [f.project]);
  } finally { hook.mock.restore(); }
});

test('Requests to two siblings keep the sender\'s existing open cycle', async t => {
  const f = await taskFlow(t), parent = await f.task('Parent'), caller = await f.work(parent);
  const first = await f.task('First', { parentId: parent.id }), second = await f.task('Second', { parentId: parent.id });
  const a = await f.request(first, caller), b = await f.request(second, caller);
  f.store(store => {
    const requests = store.readRequests(f.project);
    const one = requests.find(request => request.id === f.run(a).requestId)!;
    const two = requests.find(request => request.id === f.run(b).requestId)!;
    assert.ok(one.waitCycleId);
    assert.equal(two.waitCycleId, one.waitCycleId, 'the first sibling is still open at the second admission');
    assert.equal(store.connection.prepare('SELECT count(*) AS n FROM wait_cycles WHERE task_id=?').get(parent.id)!.n, 1);
  });
});

test('indexed estimate candidates match full scoring across offsets and project scopes', async t => {
  const f = await taskFlow(t);
  const otherProject = (await f.commands.create({ kind: 'project', color: '#39659b', parentId: f.project, userRequested: false,
    tasks: [{ title: 'Other' }] })).tasks[0]!;
  const handoffs = ['2027-01-01T09:10:00+09:00', '2027-01-01T00:12:00Z',
    '2027-01-01T09:11:00+09:00', '2027-01-01T00:13:00Z', '2027-01-01T09:09:00+09:00',
    '2027-01-01T00:13:00.0006Z', '2027-01-01T00:13:00.0014Z', '2027-01-01T00:13:00.0012Z'];
  for (const [index, at] of handoffs.entries()) {
    const task = await f.task(`Sample ${index}`, { parentId: index === 3 ? otherProject.id : f.project, values: { notes: 'x'.repeat(700) } });
    const run = await f.work(task);
    transaction(f.root, db => {
      const row = db.prepare('SELECT id FROM tasks WHERE external_id=?').get(task.id)!;
      const ordinal = Number(db.prepare('SELECT count(*) AS n FROM task_log WHERE task_id=?').get(String(row.id))!.n);
      const common = { title: null, description: null, actor: { kind: 'placement', placementId: task.placementId },
        runId: run.runId, fromState: 'doing' };
      const entries = [{ ...common, id: `EST${index}`, kind: 'reported',
        at: '2027-01-01T00:00:00Z', toState: 'doing', estimateMinutes: index + 1 },
      { ...common, id: `DONE${index}`, kind: 'reported', at, toState: 'done' }];
      entries.forEach((entry, i) => db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)')
        .run(entry.id, String(row.id), ordinal + i, JSON.stringify(entry)));
    });
  }
  const { databaseEstimateExamples, estimateExamples } = await import('@alpacawork/backend/test-dist/control/estimate-examples.js');
  const { readControlSource } = await import('@alpacawork/backend/test-dist/control/task-views.js');
  const condition = { agent: 'fake', values: { model: null, effort: null } };
  const full = await readControlSource(f.root);
  transaction(f.root, db => {
    assert.deepEqual(databaseEstimateExamples(f.root, db, condition), estimateExamples(full, condition));
    const scope = new Set(new TaskRepository(f.root, db).snapshot(f.project).tasks.map(task => task.id));
    assert.deepEqual(databaseEstimateExamples(f.root, db, condition, f.project),
      estimateExamples({ tasks: full.tasks.filter(task => scope.has(task.id)),
        runRecords: full.runRecords.filter(run => scope.has(run.task)), errors: [] }, condition));
  });
  const sample = full.tasks.find(task => task.title === 'Sample 0')!;
  assert.deepEqual((await readTaskView(f.root, sample.id, { include: ['estimateExamples'] }, null)).estimateExamples,
    estimateExamples(full, condition), 'a direct connection keeps workspace-wide reference outcomes');
  const projectUsage = await readTaskView(f.root, f.project, { include: ['usage'] as const }, null);
  assert.equal(projectUsage.usage!.subtree.runs, full.runRecords.length, 'nested project Runs remain in subtree usage');
  const prepare = DatabaseSync.prototype.prepare, fetchedBodies: number[] = [];
  const hook = t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    for (const method of ['all', 'get'] as const) {
      const execute = statement[method].bind(statement);
      statement[method] = ((...args: Parameters<typeof statement.all>) => {
        const result = execute(...args);
        for (const row of (Array.isArray(result) ? result : result ? [result] : []))
          if (typeof row.body === 'string') fetchedBodies.push(Buffer.byteLength(row.body));
        return result;
      }) as typeof statement[typeof method];
    }
    return statement;
  });
  try { transaction(f.root, db => assert.deepEqual(databaseEstimateExamples(f.root, db, condition), estimateExamples(full, condition))); }
  finally { hook.mock.restore(); }
  assert.ok(fetchedBodies.every(bytes => bytes === 0), `estimate scoring does not consume Task bodies: ${fetchedBodies}`);
});

test('a leaf boundary keeps historical callers of a moved request endpoint without reading their Task history', async t => {
  const f = await taskFlow(t);
  const a = await f.task('Current parent'), b = await f.task('Historical parent'), c = await f.task('Later parent');
  const aRun = await f.work(a), bRun = await f.work(b);
  const endpoint = await f.task('Moved endpoint', { parentId: b.id });
  const first = await f.work(endpoint, bRun);
  f.end(first);
  const move = async (parentId: string) => f.commands.move({ id: endpoint.id, parentId,
    expectedTaskHash: (await f.get(endpoint.id)).hash });
  await move(a.id);
  const second = await f.work(endpoint, aRun);
  f.end(second);
  await move(c.id);
  const leaf = await f.task('Leaf', { parentId: a.id }), leafRun = await f.work(leaf, aRun);
  const historical = f.run(first).requestId;
  transaction(f.root, (db, store) => store.write(tx => {
    const selected = new TaskRepository(f.root, db).related(leaf.id).tasks;
    const ids = selected.map(task => task.id);
    assert.ok(ids.includes(endpoint.id), 'the parent historically requested this endpoint');
    assert.ok(!ids.includes(b.id), 'the endpoint\'s earlier parent needs no Task document or history');
    assert.ok(!tx.all(f.project, ids).some(run => run.id === bRun.runId));
    assert.ok(tx.returnRuns(f.project, ids).some(run => run.id === bRun.runId), 'the historical caller remains a required Run fact');
    assert.ok(!tx.returns(f.project, ids).some(row => row.requestId === historical),
      'the moves closed the historical Request, and no pass has written its closing return yet');
    const endedAt = new Date().toISOString();
    const truncated = { ...tx, returnRuns: (project?: string, taskIds?: readonly string[]) => tx.all(project, taskIds) };
    assert.throws(() => new ReturnLifecycle(db, truncated, selected, f.project).awaiting(leaf.id, leafRun.runId, endedAt),
      /has no caller seat/, 'removing dependency closure reproduces the original failure');
    assert.equal(new ReturnLifecycle(db, tx, selected, f.project).awaiting(leaf.id, leafRun.runId, endedAt), false);
    new ReturnLifecycle(db, tx, selected, f.project).reconcile();
    assert.equal(tx.returns(f.project, ids).find(row => row.requestId === historical)?.toTaskId, b.id,
      'the closing return goes to the seat that sent the Request, read from the leaf\'s selection');
    assert.equal(new ReturnLifecycle(db, truncated, selected, f.project).awaiting(leaf.id, leafRun.runId, endedAt), false,
      'once written, the closing return is read by its Request and its seat is not derived again');
  }));
  f.end(leafRun);
  assert.equal(await f.state(leaf.id), 'error', 'the actual boundary service applies the ordinary unreported-end rule');
});
