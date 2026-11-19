import { createFixtureRun } from './helpers/run-fixture.ts';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RunStore } from '@alpacawork/runs';

/** Two tasks of the fixture's project: `first` and `second`. */
async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-placement-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const first = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'First' }] })).tasks[0].id;
  const second = (await commands.create({ parentId: project, userRequested: false, tasks: [{ title: 'Second' }] })).tasks[0].id;
  const store = new PlacementStore(root);
  t.after(() => store.close());
  return { root, project, commands, store, first, second };
}

test('different people may share one profile while each placement has its own interval', async t => {
  const { root, store, first: task } = await setup(t);
  const first = store.createAgent(), second = store.createAgent();
  const owner = store.place({ taskId: task, agentId: first.id, profileKey: 'codex', responsible: true });
  const member = store.place({ taskId: task, agentId: second.id, profileKey: 'codex', responsible: false });
  assert.notEqual(first.id, second.id);
  assert.notEqual(owner.id, member.id);
  assert.equal(owner.profileKey, member.profileKey);
  assert.equal(store.placements(task).length, 2);
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  try { assert.deepEqual(runs.getPlacement(owner.id),
    store.placements(task).find(placement => placement.id === owner.id)); }
  finally { runs.close(); }
});

test('responsibility is unique in both commands and the SQLite index', async t => {
  const { root, store, first: task } = await setup(t);
  const first = store.createAgent(), second = store.createAgent();
  const owner = store.place({ taskId: task, agentId: first.id, profileKey: 'codex', responsible: true });
  assert.throws(() => store.place({ taskId: task, agentId: second.id, profileKey: 'codex', responsible: true }), /responsible/);
  const member = store.place({ taskId: task, agentId: second.id, profileKey: 'codex', responsible: false });
  const db = new DatabaseSync(join(root, '.alpacawork', 'alpacawork.sqlite'));
  try { assert.throws(() => db.prepare('UPDATE placements SET responsible = 1 WHERE id = ?').run(member.id), /UNIQUE/); }
  finally { db.close(); }
  const next = store.setResponsible(member.id, member.revision);
  assert.equal(next.placement.responsible, true);
  assert.equal(next.previousPlacement?.id, owner.id);
  assert.equal(store.placements(task).filter(item => item.active && item.responsible).length, 1);
  assert.equal(store.placements(task).find(item => item.id === owner.id)?.active, false);
  assert.throws(() => store.setResponsible(owner.id, owner.revision), /inactive/);
});

test('SQLite rejects missing profiles and preserves responsibility as ended history', async t => {
  const { root, store, first: task } = await setup(t);
  const agent = store.createAgent();
  const member = store.place({ taskId: task, agentId: agent.id, profileKey: 'codex', responsible: false });
  const db = new DatabaseSync(join(root, '.alpacawork', 'alpacawork.sqlite'));
  try {
    assert.throws(() => db.prepare('UPDATE placements SET profile_key = NULL WHERE id = ?').run(member.id), /NOT NULL/);
    store.release(member.id, member.revision);
    db.prepare('UPDATE placements SET responsible = 1 WHERE id = ?').run(member.id);
    assert.equal(store.placements(task)[0]?.responsible, true);
    assert.equal(store.placements(task)[0]?.active, false);
  } finally { db.close(); }
});

test('release ends one placement and permits a new interval for the same person', async t => {
  const { store, first: task } = await setup(t);
  const agent = store.createAgent();
  const first = store.place({ taskId: task, agentId: agent.id, profileKey: 'codex', responsible: true });
  assert.throws(() => store.place({ taskId: task, agentId: agent.id, profileKey: 'codex', responsible: false }), /already active/);
  const ended = store.release(first.id, first.revision);
  assert.equal(ended.active, false);
  assert.ok(ended.endedAt);
  const next = store.place({ taskId: task, agentId: agent.id, profileKey: 'codex', responsible: true });
  assert.notEqual(next.id, first.id);
});

test('a responsible is released alone only where its task needs none: no child and no work under way', async t => {
  const h = await setup(t);
  const owner = h.store.place({ taskId: h.first, agentId: h.store.createAgent().id, profileKey: 'codex', responsible: true });
  // A task with a child keeps its responsible (uncoveredTasks): a handover or a replacement changes it instead.
  const child = (await h.commands.create({ parentId: h.first, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0];
  assert.throws(() => h.store.release(owner.id, owner.revision),
    { code: 'handover_required', detail: { task: h.first, hasChildren: true, state: 'todo' } });
  assert.equal(h.store.placements(h.first).find(item => item.id === owner.id)?.active, true, 'the refusal rolls back');
  // So does a task at work: its Run started, so it is doing.
  const worker = h.store.place({ taskId: h.second, agentId: h.store.createAgent().id, profileKey: 'codex', responsible: true });
  const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const run = runs.write(tx => createFixtureRun(runs, tx, { task: h.second, placementId: worker.id,
      requestId: globalThis.crypto.randomUUID(), agent: 'codex', role: 'owner', resumes: null, continues: false,
      session: null, caller: null, cwd: h.root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'],
         path: '/bin', values: {} } }, 'Work'));
    runs.write(tx => tx.update({ ...tx.get(run.id)!, state: 'running', started_at: new Date().toISOString() }));
    reconcileLinks(h.root, h.project);
    runs.write(tx => tx.finish({ ...tx.get(run.id)!, state: 'failed', reason: 'exit', ended_at: new Date().toISOString() },
      { state: 'missing', text: null }));
  } finally { runs.close(); }
  reconcileLinks(h.root, h.project);
  assert.equal((await new ControlTaskStore(h.root).get(h.second)).meta.state, 'error');
  assert.throws(() => h.store.release(worker.id, worker.revision),
    { code: 'handover_required', detail: { task: h.second, hasChildren: false, state: 'error' } });
  // A member leaves whatever its task is doing, and the last responsible of an idle childless task leaves too.
  const member = h.store.place({ taskId: h.second, agentId: h.store.createAgent().id, profileKey: 'codex', responsible: false });
  assert.equal(h.store.release(member.id, member.revision).active, false);
  await h.commands.lifecycle({ id: child.id, action: 'delete', expectedTaskHash: child.hash });
  assert.equal(h.store.release(owner.id, owner.revision).active, false);
  assert.deepEqual(h.store.uncoveredTasks([h.first]), []);
});

test('transfer and release preserve responsibility while a linked Run is unfinished', async t => {
  const { root, store, first: task } = await setup(t);
  const first = store.createAgent(), second = store.createAgent();
  const owner = store.place({ taskId: task, agentId: first.id, profileKey: 'codex', responsible: true });
  const member = store.place({ taskId: task, agentId: second.id, profileKey: 'claude', responsible: false });
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  try { runs.write(tx => createFixtureRun(runs, tx, { task, placementId: owner.id, requestId: globalThis.crypto.randomUUID(),
    agent: 'codex', role: 'owner', resumes: null, continues: false, session: null, caller: null,
    cwd: root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {}} }, 'Queued only')); }
  finally { runs.close(); }
  assert.throws(() => store.setResponsible(member.id, member.revision), /unfinished runs/);
  assert.throws(() => store.release(owner.id, owner.revision), /unfinished runs/);
  assert.equal(store.placements(task).find(item => item.id === owner.id)?.responsible, true);
});

function createRun(root: string, placementId: string, task: string, role: 'owner' | 'worker' = 'owner') {
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  try { return runs.write(tx => createFixtureRun(runs, tx, { task, placementId, requestId: globalThis.crypto.randomUUID(),
    agent: 'codex', role, resumes: null, continues: false, session: null, caller: null,
    cwd: root, launch: { adapter: 'codex', env: [], argv: ['unused-fake'], path: '/bin', values: {}} }, 'Fake run')); }
  finally { runs.close(); }
}
function moveRun(root: string, id: string, state: 'running' | 'needs_review') {
  const runs = new RunStore(root, { busyTimeoutMs: 0 });
  try { runs.write(tx => { const run = tx.get(id)!;
    tx.update({ ...run, state, reason: state === 'needs_review' ? 'manager_lost' : null,
      started_at: run.started_at ?? new Date().toISOString() }); }); }
  finally { runs.close(); }
}

test('a Run waiting for review still holds its placement', async t => {
  const { root, store, first: task } = await setup(t);
  const owner = store.place({ taskId: task, agentId: store.createAgent().id, profileKey: 'codex', responsible: true });
  const run = createRun(root, owner.id, task);
  moveRun(root, run.id, 'running');
  moveRun(root, run.id, 'needs_review');
  assert.throws(() => store.release(owner.id, owner.revision), /unfinished runs/);
});
