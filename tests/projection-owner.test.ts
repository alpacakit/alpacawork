/** Arrival floors, immutable publication and bounded-log recovery are the projection's observable contract. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { ChangeLog, openControlDatabase, type ChangeSeq } from '@alpacawork/db';
import type { PublishedFrame, RoutingWorkSet } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { ProjectionOwner } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';
import { deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ProjectedHistory, projectedView } from '@alpacawork/backend/test-dist/receiver/task-reads.js';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

test('reads bypass batching, preserve old frames and recover every resource after journal overflow', async t => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'projection-owner-')));
  const original = createOriginal({ tasks: 160, logs: 320, runs: 7, seed: 'projection-owner' }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }), log = new ChangeLog(2);
  const frames: PublishedFrame[] = [];
  let failPersonal = false, changeDuringPersonal = false, personalRevision: string | null = null;
  const owner = new ProjectionOwner({ root, generation: 'synthetic-generation', log, locations: () => ({}),
    personal: async () => { if (failPersonal) throw new Error('Synthetic personal read failed');
      const heldRevision = personalRevision;
      if (changeDuringPersonal) { changeDuringPersonal = false; personalRevision = 'a'.repeat(64); title('Synthetic concurrent personal change'); }
      return {
      notices: null, person: { settings: heldRevision, notices: null, coordinator: null }, presence: { state: 'away', until: null }, host: null, coordinatorWork: null, launchMemory: { agent: null, values: {} },
    }; }, published: frame => { frames.push(frame); } });
  t.after(async () => { await owner.close(); db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  await owner.start();
  const first = owner.current!, other = first.records.bundle('T14'), originalTitle = first.records.bundle('T5')!.task.meta.title;
  function title(value: string) {
    db.prepare("UPDATE tasks SET title=?,revision=revision+1 WHERE external_id='T5'").run(value);
    return log.append([{ kind: 'task', id: 'T5' }]);
  }
  const floor = title('Synthetic newer title');
  const updated = await owner.read(floor);
  assert.ok(updated.applied >= floor);
  assert.equal(updated.records.bundle('T5')!.task.meta.title, 'Synthetic newer title');
  assert.equal(first.records.bundle('T5')!.task.meta.title, originalTitle);
  assert.equal(updated.records.bundle('T14'), other, 'an unrelated bundle is shared');
  assert.ok(updated.requiredPv.view.T5! > (first.requiredPv.view.T5 ?? 0));
  assert.equal(updated.requiredPv.view.T14, first.requiredPv.view.T14);
  assert.equal(updated.patch?.tasks.upsert.find(row => row.id === 'T5')?.title, 'Synthetic newer title');

  const held = owner.current!;
  const faultFloor = title('Synthetic unread publication'); failPersonal = true;
  const retained = await owner.read(faultFloor);
  assert.equal(retained.records, held.records, 'a failed assembly never publishes part of its new facts');
  assert.equal(retained.applied, held.applied);
  assert.equal(retained.pv, held.pv);
  assert.equal(retained.requiredPv, held.requiredPv);
  assert.ok(JSON.parse(owner.index()).staleIds.includes('T5'));
  assert.match(JSON.parse(owner.index()).errors[0].message, /Synthetic personal/);
  failPersonal = false;
  await owner.catchUp(true);
  await owner.read(faultFloor);

  // Exceed the bounded journal before yielding to the projection's fixed 25 ms batch timer.
  title('Synthetic overflow one'); title('Synthetic overflow two'); const resyncFloor = title('Synthetic at R');
  const building = owner.catchUp();
  let during: PublishedFrame | undefined;
  const mutation = turn().then(() => {
    during = owner.current;
    title('Synthetic after R');
  });
  await Promise.all([building, mutation]);
  const resync = frames.find(frame => frame.applied === resyncFloor)!;
  assert.ok(resync, 'the full rebuild publishes at its captured boundary');
  assert.notEqual(during, resync, 'publication waits for the complete assembly');
  assert.equal(resync.records.bundle('T5')!.task.meta.title, 'Synthetic at R');
  assert.equal(resync.patch, null, 'recovery requires a complete index');
  assert.ok(resync.requiredPv.view.T14! > (held.requiredPv.view.T14 ?? 0), 'recovery raises unchanged resources too');
  const final = await owner.read(log.latest);
  assert.equal(final.records.bundle('T5')!.task.meta.title, 'Synthetic after R');
  assert.equal(resync.records.bundle('T5')!.task.meta.title, 'Synthetic at R');
  assert.equal(JSON.parse(owner.index()).sourcePv, final.pv);
  changeDuringPersonal = true;
  const personalFloor = title('Synthetic before asynchronous personal read');
  await owner.read(personalFloor);
  assert.equal(JSON.parse(owner.index()).person.settings, personalRevision,
    'metadata prepared before an intervening commit cannot claim its later arrival floor');
});

function workspace(t: TestContext, seed: string) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'projection-failure-')));
  const original = createOriginal({ tasks: 16, logs: 32, runs: 2, seed }, join(area, 'originals'));
  const root = copyWorkspace(original.root, join(area, 'working')).root;
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }), log = new ChangeLog(100);
  const owners: ProjectionOwner[] = [];
  t.after(async () => {
    const closed = await Promise.allSettled(owners.map(owner => owner.close()));
    db.close(); removeWorkspace(root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true });
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  const title = (id: string, value: string) => {
    db.prepare('UPDATE tasks SET title=?,revision=revision+1 WHERE external_id=?').run(value, id);
    return log.append([{ kind: 'task', id }]);
  };
  const personal = async () => ({ notices: null, person: { settings: null, notices: null, coordinator: null },
    presence: { state: 'away' as const, until: null }, host: null, coordinatorWork: null, launchMemory: { agent: null, values: {} } });
  return { root, db, log, title, personal, own: (owner: ProjectionOwner) => { owners.push(owner); return owner; } };
}

test('failed acquisition serves explicitly stale old facts and retries with backoff instead of spinning on reads', async t => {
  const h = workspace(t, 'projection-acquisition-backoff');
  let failed = false, attempts = 0, reported = 0, now = Date.now();
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'failure-generation', locations: () => ({}), published: () => {},
    personal: async () => { attempts++; if (failed) throw new Error('Synthetic acquisition failure'); return h.personal(); },
    fault: () => { reported++; } }));
  await owner.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => now);
  const first = owner.current!;
  failed = true;
  const floor = h.title('T5', 'Not acquired yet');
  const stale = await owner.read(floor);
  assert.equal(stale.records, first.records);
  assert.equal(stale.applied, first.applied);
  assert.equal(stale.requiredPv, first.requiredPv);
  assert.equal(stale.pv, first.pv);
  assert.ok(stale.applied < floor);
  const index = JSON.parse(owner.index());
  assert.ok(index.staleIds.includes('T5'));
  assert.match(index.errors[0].message, /acquisition failure/);
  for (let i = 0; i < 10; i++) assert.equal(await owner.read(floor), stale);
  assert.equal(attempts, 2, 'current reads reuse the marked old frame throughout backoff');
  const advance = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await turn(); };
  await advance(249); assert.equal(attempts, 2);
  await advance(1); assert.equal(attempts, 3);
  assert.equal(reported, 1, 'the same fault is reported once while its diagnostic remains published');
  await advance(499); assert.equal(attempts, 3);
  failed = false;
  await advance(1);
  const current = await owner.read(floor);
  assert.ok(current.applied >= floor);
  assert.equal(current.records.bundle('T5')!.task.meta.title, 'Not acquired yet');
  assert.deepEqual(JSON.parse(owner.index()).staleIds, []);
  assert.deepEqual(JSON.parse(owner.index()).errors, []);
});

test('one failed derivation retains only that Task and its contribution while fresh records and other Tasks publish', async t => {
  const h = workspace(t, 'projection-task-isolation');
  let failed = false;
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'derive-generation', locations: () => ({}), published: () => {},
    derive: (records, id) => { if (failed && id === 'T5') throw new Error('Synthetic Task derivation failure'); return deriveTask(records, id); } }));
  await owner.start();
  const first = owner.current!, old = first.derived('T5'), untouched = first.derived('T6');
  failed = true;
  h.title('T5', 'Failed derived title'); const floor = h.title('T14', 'Independent fresh title');
  const current = await owner.read(floor);
  assert.equal(current.applied, floor, 'the records were successfully acquired at this boundary');
  assert.equal(owner.current!.records.bundle('T5')!.task.meta.title, 'Failed derived title');
  assert.equal(current.derived('T5'), old);
  assert.equal(current.derived('T14')!.row.title, 'Independent fresh title');
  assert.equal(current.derived('T6'), untouched);
  assert.equal(current.requiredPv.view.T5, current.pv, 'the old derived value does not suppress the invalidation');
  const index = JSON.parse(owner.index());
  assert.deepEqual(index.staleIds, ['T5']);
  assert.ok(index.errors.some(error => error.path === 'tasks/T5' && error.message.includes('derivation failure')));
  failed = false;
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 250);
  await owner.catchUp();
  assert.equal(owner.current!.derived('T5')!.row.title, 'Failed derived title');
  assert.deepEqual(JSON.parse(owner.index()).staleIds, []);
  assert.deepEqual(JSON.parse(owner.index()).errors, []);
});

test('a Task the index cannot send never precedes a shown home row, at startup or after its project leaves the list', async t => {
  const h = workspace(t, 'projection-unsent-predecessor');
  const tasks = new ControlTaskCommands(h.root, { kind: 'human' });
  const nested = (await tasks.create({ kind: 'project', color: '#39659b', parentId: 'P1', userRequested: null, tasks: [{ title: 'Nested' }] })).tasks[0]!;
  const make = async (parentId: string, title: string) => (await tasks.create({ parentId, userRequested: false, tasks: [{ title }] })).tasks[0]!;
  // The failing Task sorts first (Error before Not started), so a stale order would name it before the healthy one.
  const failing = await make(nested.id, 'Fails to read'); await make('P1', 'Healthy');
  h.db.prepare("UPDATE tasks SET base_state='error' WHERE external_id=?").run(failing.id);
  let fail = true;
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'unsent-predecessor', locations: () => ({}), published: () => {},
    derive: (records, id) => { if (fail && id === failing.id) throw new Error('Synthetic derivation failure'); return deriveTask(records, id); } }));
  const shownFollowShown = (label: string) => {
    const ids = new Set<string>(JSON.parse(owner.index()).home.map((row: { taskId: string }) => row.taskId));
    for (const id of ids) { const after = owner.current!.aggregate.homeAfter(id); assert.ok(after === null || ids.has(after!), `${label}: ${id} follows unsent ${after}`); }
  };
  await owner.start();
  shownFollowShown('first read failed');
  fail = false;
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 250);
  await owner.catchUp();
  fail = true;
  h.db.prepare("UPDATE tasks SET lifecycle='archived',revision=revision+1 WHERE external_id=?").run(nested.id);
  await owner.read(h.log.append([{ kind: 'task', id: nested.id }]));
  shownFollowShown('project left the list while the Task kept its last read');
});

test('a missing parent retains the last usable Task across publications while independent Tasks stay current', async t => {
  const h = workspace(t, 'projection-missing-parent');
  h.db.prepare("UPDATE tasks SET base_state='doing',hold=0 WHERE external_id='T5'").run();
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'missing-parent-generation', locations: () => ({}), published: () => {} }));
  await owner.start();
  const first = owner.current!, old = first.derived('T5');
  const parent = h.db.prepare("SELECT parent_id FROM tasks WHERE external_id='T5'").get()!.parent_id;
  // Ordinary writes cannot create this state. Bypass the synthetic database's guards only to inject storage corruption.
  const guard = String(h.db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='tasks_shape_update'").get()!.sql);
  h.db.exec('DROP TRIGGER tasks_shape_update');
  h.db.exec('PRAGMA foreign_keys=OFF');
  try { h.db.prepare("UPDATE tasks SET parent_id='missing-synthetic-parent',title='Temporarily orphaned Task',revision=revision+1 WHERE external_id='T5'").run(); }
  finally { h.db.exec('PRAGMA foreign_keys=ON'); h.db.exec(guard); }
  h.log.append([{ kind: 'task', id: 'T5' }]);
  const floor = h.title('T14', 'Independent facts after missing parent');
  const current = await owner.read(floor);
  assert.equal(current.applied, floor);
  assert.equal(current.derived('T5'), old);
  assert.equal(owner.current!.records.bundle('T5')!.task.meta.title, 'Temporarily orphaned Task');
  assert.equal(current.derived('T14')!.row.title, 'Independent facts after missing parent');
  assert.equal(projectedView(current, 'T5').task.title, old!.row.title);
  assert.doesNotThrow(() => new ProjectedHistory().read(current, 'T5'));
  let index = JSON.parse(owner.index());
  assert.ok(index.staleIds.includes('T5'));
  assert.equal(index.tasks.find((row: { id: string }) => row.id === 'T5').title, old!.row.title);
  assert.ok(index.errors.some((error: { path: string }) => error.path === 'tasks/T5'));

  // The next frame's records already contain the orphan. Recovery facts must survive beyond the first held frame.
  const nextFloor = h.title('T15', 'Another independent publication');
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 250);
  const next = await owner.read(nextFloor);
  assert.equal(next.applied, nextFloor);
  assert.equal(next.derived('T5'), old);
  assert.equal(next.derived('T15')!.row.title, 'Another independent publication');
  index = JSON.parse(owner.index());
  assert.ok(index.staleIds.includes('T5'));

  h.db.prepare("UPDATE tasks SET parent_id=?,revision=revision+1 WHERE external_id='T5'").run(parent);
  h.log.append([{ kind: 'task', id: 'T5' }]);
  await owner.catchUp(true);
  assert.equal(owner.current!.derived('T5')!.row.title, 'Temporarily orphaned Task');
  assert.deepEqual(JSON.parse(owner.index()).staleIds, []);
});

test('Run readability changes preserve reconciliation for Tasks whose own facts changed', async t => {
  const h = workspace(t, 'projection-readability-reconciliation');
  let work: RoutingWorkSet | undefined;
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'readability-generation', locations: () => ({}),
    published: (_frame, _previous, next) => { work = next; } }));
  await owner.start();
  const row = h.db.prepare('SELECT record FROM runs WHERE id=1').get()!;
  h.db.prepare("UPDATE runs SET record=json_set(record,'$.agent','Not An Agent') WHERE id=1").run();
  h.log.append([{ kind: 'run', id: 'R1' }]);
  const floor = h.title('T5', 'Fresh facts during degraded execution');
  const degraded = await owner.read(floor);
  assert.equal(degraded.derived('T5')!.row.title, 'Fresh facts during degraded execution');
  assert.ok(JSON.parse(owner.index()).errors.some((error: { code: string }) => error.code === 'runs_unavailable'));
  assert.ok(work!.tasks.has('T5'), 'degraded execution does not discard the Task mutation from reconciliation');
  h.db.prepare('UPDATE runs SET record=? WHERE id=1').run(row.record);
  const recovered = await owner.read(h.log.append([{ kind: 'run', id: 'R1' }]));
  assert.equal(recovered.applied, h.log.latest);
  assert.deepEqual(JSON.parse(owner.index()).errors, []);
  assert.ok(work!.tasks.has('T2'), 'the recovered Run owner remains eligible for reconciliation');
});

test('quiesce stops reservations, applies the final committed range once outside admission, then stays stopped', async t => {
  const h = workspace(t, 'projection-final-drain');
  let admitted = true, admissions = 0, publications = 0;
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'drain-generation', locations: () => ({}),
    published: () => { publications++; }, run: async work => { admissions++; assert.equal(admitted, true); await work(); } }));
  await owner.start();
  owner.pause(); admitted = false;
  const floor = h.title('T5', 'Committed during quiesce');
  await owner.drain();
  assert.equal(owner.current!.applied, floor);
  assert.equal(owner.current!.derived('T5')!.row.title, 'Committed during quiesce');
  assert.equal(admissions, 1, 'the final assembly is owned by quiesce, outside ordinary admission');
  const held = publications;
  h.title('T5', 'Too late');
  await owner.drain(); await turn();
  assert.equal(publications, held, 'drain cannot run twice or reserve another assembly');
  await assert.rejects(owner.read(h.log.latest), /closed/);
});


test('startup isolates a failed parent derivation while its healthy children retain their tree and counts', async t => {
  const h = workspace(t, 'projection-startup-failed-parent');
  h.db.prepare("UPDATE tasks SET parent_id=(SELECT id FROM tasks WHERE external_id='T5'),base_state='todo',hold=0 WHERE external_id IN ('T14','T15')").run();
  let failed = true;
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'startup-failure-generation', locations: () => ({}), published: () => {},
    derive: (records, id) => { if (failed && id === 'T5') throw new Error('Synthetic parent derivation failure'); return deriveTask(records, id); } }));
  await owner.start();
  const first = await owner.read(), index = JSON.parse(owner.index());
  assert.deepEqual(index.staleIds, ['T5']);
  assert.ok(index.errors.some((error: { path: string; message: string }) => error.path === 'tasks/T5'
    && error.message.includes('parent derivation failure')));
  for (const id of ['T14', 'T15']) {
    assert.ok(index.tasks.some((task: { id: string }) => task.id === id));
    assert.equal(first.derived(id)!.contribution.parentId, 'T5');
    assert.equal(projectedView(first, id).task.parentId, 'T5');
  }
  const children = first.aggregate.children('T5');
  assert.ok(children && children.live + children.finished >= 2);
  assert.ok(index.tasks.some((task: { id: string }) => task.id === 'T6'));
  failed = false;
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 250);
  await owner.catchUp();
  assert.ok(owner.current!.derived('T5'));
  assert.deepEqual(owner.current!.aggregate.children('T5')?.live, first.aggregate.children('T5')?.live,
    'recovery replaces the structural node while retaining each child exactly once');
  assert.deepEqual(owner.current!.aggregate.counts().tasks, first.aggregate.counts().tasks,
    'recovery does not count the failed Task twice');
  assert.deepEqual(JSON.parse(owner.index()).staleIds, []);
  assert.deepEqual(first.aggregate.children('T5'), children, 'the held startup snapshot remains readable after recovery');
});

test('a failed Task backs off its own retries while independent writes immediately reach their arrival floors', async t => {
  const h = workspace(t, 'projection-independent-retry-backoff');
  let failed = false, attempts = 0, now = Date.now();
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'independent-retry-generation', locations: () => ({}), published: () => {},
    derive: (records, id) => {
      if (id === 'T5') { attempts++; if (failed) throw new Error('Synthetic persistent Task failure'); }
      return deriveTask(records, id);
    } }));
  await owner.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Date, 'now', () => now);
  failed = true;
  await owner.read(h.title('T5', 'Retained until derivation recovers'));
  assert.equal(attempts, 2);
  const independent = async (title: string) => {
    const floor = h.title('T14', title), current = await owner.read(floor);
    assert.ok(current.applied >= floor);
    assert.equal(current.derived('T14')!.row.title, title);
    assert.deepEqual(JSON.parse(owner.index()).staleIds, ['T5']);
  };
  await independent('Healthy write during first retry delay');
  assert.equal(attempts, 2, 'unrelated changes do not retry the failed derivation');
  const advance = async (ms: number) => { now += ms; t.mock.timers.tick(ms); await turn(); };
  const scheduledFloor = h.title('T14', 'A new change advances the waiting timer');
  await advance(25);
  assert.ok(owner.current!.applied >= scheduledFloor, 'publication does not wait for the failed Task retry');
  assert.equal(owner.current!.derived('T14')!.row.title, 'A new change advances the waiting timer');
  await advance(224); assert.equal(attempts, 2);
  await advance(1); assert.equal(attempts, 3);
  await independent('Healthy write during longer retry delay');
  assert.equal(attempts, 3);
  await advance(499); assert.equal(attempts, 3);
  await advance(1); assert.equal(attempts, 4);
  await independent('Healthy write while failure keeps backing off');
  assert.equal(attempts, 4);
  failed = false;
  const repaired = await owner.read(h.title('T5', 'Changed failed Task can recover immediately'));
  assert.equal(repaired.derived('T5')!.row.title, 'Changed failed Task can recover immediately');
  assert.deepEqual(JSON.parse(owner.index()).staleIds, []);
});

test('stopped admission avoids ordinary catch-up diagnostics until the one final drain', async t => {
  const h = workspace(t, 'projection-admission-stop');
  let accepting = true, admissions = 0, faults = 0;
  const owner = h.own(new ProjectionOwner({ ...h, generation: 'admission-stop-generation', locations: () => ({}), published: () => {},
    accepting: () => accepting, fault: () => { faults++; },
    run: async work => { admissions++; assert.equal(accepting, true); await work(); } }));
  await owner.start();
  const held = owner.current!;
  const floor = h.title('T5', 'Final committed value');
  const reserved = owner.catchUp();
  accepting = false;
  await reserved;
  const stopping = await owner.read(floor);
  assert.equal(stopping, held);
  assert.equal(admissions, 1);
  assert.equal(faults, 0);
  await owner.drain();
  assert.equal(owner.current!.applied, floor);
  assert.equal(owner.current!.derived('T5')!.row.title, 'Final committed value');
  assert.equal(admissions, 1);
  assert.equal(faults, 0);
});
