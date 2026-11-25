import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { grantFixtureRequest } from './helpers/control-fixture.ts';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ControlStore, openControlDatabase, packagedMigrations } from '../packages/db/dist/index.js';
import { RunStore, type RunTransaction } from '../packages/runs/dist/index.js';
import { initializeWorkspace } from '../apps/backend/test-dist/control/initialize.js';
import { ControlTaskCommands } from '../apps/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '../apps/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '../apps/backend/test-dist/control/placement-commands.js';
import { TaskRequestService } from '../apps/backend/test-dist/control/task-request.js';
import { RequestService } from '../apps/backend/test-dist/control/requests.js';
import { PlacementStore } from '../apps/backend/test-dist/control/placements.js';
import { launchSnapshot, readAgentsSettings } from '../apps/backend/test-dist/agents-settings.js';
import { closeLaunches, settle, settleTransaction } from '../apps/backend/test-dist/runs/scheduler.js';
import { stringify } from 'yaml';
import { record } from './runs-fixtures.ts';

async function fixture(run: (root: string) => Promise<void> | void) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'alpacawork-control-'));
  const previousPath = process.env.PATH;
  try {
    await initializeWorkspace(root);
    process.env.PATH = installAgentStub(root, 'claude');
    writeFileSync(join(root, 'config.yaml'), stringify({ agents: { codex: fixtureAgentSetting('codex') } }));
    await run(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
}

test('one database owns Task, placement, request and Run; hash is derived', async () => fixture(async root => {
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const created = (await commands.create({ parentId: 'P1', userRequested: null, tasks: [{ title: 'One' }] })).tasks[0];
  // The workspace starts with its root project P1; one number sequence names the task below it T2.
  assert.equal(created.id, 'T2');
  assert.equal(created.version, 1);
  assert.equal(existsSync(join(root, 'tasks', created.id, 'index.md')), false);
  assert.equal(existsSync(join(root, '.alpacawork/runs.sqlite')), false);
  const control = new ControlStore(root);
  try {
    assert.deepEqual(control.connection.prepare('SELECT external_id, kind FROM tasks ORDER BY number').all().map(row => ({ ...row })),
      [{ external_id: 'P1', kind: 'project' }, { external_id: 'T2', kind: 'task' }]);
    assert.equal(control.connection.prepare("SELECT count(*) AS n FROM pragma_table_xinfo('tasks') WHERE name='hash'").get()!.n, 0);
  } finally { control.close(); }
  const placement = (await new PlacementCommands(root).placeNewResponsible({ taskId: created.id, profileKey: 'codex',
    expectedTaskHash: created.hash }, { kind: 'human' })).placement;
  const current = await new ControlTaskStore(root).get(created.id);
  assert.notEqual(current.hash, created.hash);
  const opId = randomUUID();
  const requested = await new TaskRequestService(root).request({ task: created.id,
    body: 'Do it', opId, expectedTaskHash: current.hash, expectedPlacementRevision: placement.revision },
  { kind: 'human' }, { kind: 'human' });
  assert.equal(requested.outcome.kind, 'request_accepted');
  const db = new ControlStore(root);
  try {
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM task_log WHERE id=?').get(opId)!.n, 1);
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM requests WHERE id=?').get(opId)!.n, 1);
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM runs WHERE request_id=?').get(opId)!.n, 1);
    assert.equal(db.connection.prepare('PRAGMA foreign_key_check').get(), undefined);
    assert.equal(db.connection.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  } finally { db.close(); }
  const runs = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const run = runs.read()[0]!;
    assert.equal(run.id, 'R1');
    assert.equal(run.continues, false);
    assert.equal(run.exit, null);
    assert.equal(runs.getText(run.id)!.prompt?.includes('Do it'), true);
    assert.equal(existsSync(join(root, '.alpacawork/runs', run.id)), false);
    assert.equal(existsSync(runs.prepareFolder(run.id)), true);
  } finally { runs.close(); }
  const updated = (await commands.update({ id: created.id, values: { notes: 'new notes' }, expectedTaskHash: requested.task.hash })).task;
  assert.equal(updated.version, requested.task.version + 1);
  assert.notEqual(updated.hash, requested.task.hash);
  await assert.rejects(commands.update({ id: created.id, values: { notes: 'stale' }, expectedTaskHash: requested.task.hash }),
    { code: 'conflict' });
}));

test('HTTP operation shares one connection and caught nested failure rolls back its savepoint', async () => fixture(async root => {
  const control = new ControlStore(root);
  try {
    let checks = 0;
    const receipt = await control.writeOperationAsync({ opId: 'one', operation: 'task/new', fingerprint: 'same' },
      async () => {
        const created = await new ControlTaskCommands(root, { kind: 'human' })
          .create({ parentId: 'P1', userRequested: null, tasks: [{ title: 'Kept' }] });
        const nested = new ControlStore(root);
        try {
          assert.throws(() => nested.write(db => {
            db.prepare("UPDATE tasks SET title='Lost' WHERE external_id='T2'").run();
            throw new Error('nested failure');
          }), /nested failure/);
        } finally { nested.close(); }
        return { status: 200, body: created };
      }, () => { checks++; });
    assert.equal(receipt.replayed, false);
    assert.equal(control.connection.prepare("SELECT title FROM tasks WHERE external_id='T2'").get()!.title, 'Kept');
    assert.equal(control.connection.prepare("SELECT count(*) AS n FROM cli_operations WHERE op_id='one'").get()!.n, 1);
    const replay = await control.writeOperationAsync({ opId: 'one', operation: 'task/new', fingerprint: 'same' },
      () => { throw new Error('replay must not execute'); }, () => { checks++; });
    assert.equal(replay.replayed, true);
    assert.equal(checks, 2);
    assert.deepEqual(replay.body, JSON.parse(JSON.stringify(receipt.body)));
  } finally { control.close(); }
}));

test('instruction callback failure leaves no Request, Run, Task log or consumed Run number', async () => fixture(async root => {
  const created = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: null,
    tasks: [{ title: 'One' }] })).tasks[0];
  const placement = (await new PlacementCommands(root).placeNewResponsible({ taskId: created.id,
    profileKey: 'codex', expectedTaskHash: created.hash }, { kind: 'human' })).placement;
  const task = await new ControlTaskStore(root).get(created.id);
  const opId = randomUUID();
  await assert.rejects(new RequestService(root).request({ taskId: task.id, requestId: opId, body: 'hello',
    expectedTaskHash: task.hash, expectedPlacementRevision: placement.revision },
  { purpose: 'instruction', actor: { kind: 'human' }, onAdmitted: () => { throw new Error('fault after Run insert'); } }),
  /fault after Run insert/);
  const control = new ControlStore(root);
  try {
    assert.equal(control.connection.prepare('SELECT count(*) AS n FROM requests').get()!.n, 0);
    assert.equal(control.connection.prepare('SELECT count(*) AS n FROM runs').get()!.n, 0);
    assert.equal(control.connection.prepare('SELECT next_number FROM run_sequence').get()!.next_number, 1);
    assert.equal(control.connection.prepare('SELECT count(*) AS n FROM task_log WHERE id=?').get(opId)!.n, 0);
    assert.equal((await new ControlTaskStore(root).get(task.id)).hash, task.hash);
  } finally { control.close(); }
}));

test('failed shared write rolls back Task, Request, Run number and receipt', async () => fixture(async root => {
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: null,
    tasks: [{ title: 'One' }] })).tasks[0];
  const control = new ControlStore(root);
  try {
    const initial = Number(control.connection.prepare('SELECT next_number FROM run_sequence').get()!.next_number);
    assert.throws(() => control.writeOperation({ opId: 'retry', operation: 'test', fingerprint: 'same' }, db => {
      db.prepare('UPDATE tasks SET title=?,revision=revision+1 WHERE external_id=?').run('bad', task.id);
      db.prepare('UPDATE run_sequence SET next_number=next_number+1').run();
      throw new Error('before receipt');
    }), /before receipt/);
    assert.equal(control.connection.prepare('SELECT title FROM tasks WHERE external_id=?').get(task.id)!.title, 'One');
    assert.equal(control.connection.prepare('SELECT next_number FROM run_sequence').get()!.next_number, initial);
    assert.equal(control.operationGet('retry'), null);
    const first = control.writeOperation({ opId: 'retry', operation: 'test', fingerprint: 'same' }, () =>
      ({ status: 201, body: { accepted: true } }));
    const replay = control.writeOperation({ opId: 'retry', operation: 'test', fingerprint: 'same' }, () => {
      throw new Error('replay must not execute');
    });
    assert.deepEqual(replay, { ...first, replayed: true });
    assert.throws(() => control.writeOperation({ opId: 'retry', operation: 'test', fingerprint: 'other' }, () =>
      ({ status: 201, body: {} })), { code: 'idempotency_conflict' });
  } finally { control.close(); }
}));

test('Run witness update cannot move a Run to another Task placement or request', async () => fixture(async root => {
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  for (const title of ['First', 'Second']) {
    const created = (await commands.create({ parentId: 'P1', userRequested: null, tasks: [{ title }] })).tasks[0];
    const placement = (await new PlacementCommands(root).placeNewResponsible({ taskId: created.id,
      profileKey: 'codex', expectedTaskHash: created.hash }, { kind: 'human' })).placement;
    const current = await new ControlTaskStore(root).get(created.id);
    await new TaskRequestService(root).request({ task: created.id,
      body: 'Start', opId: randomUUID(), expectedTaskHash: current.hash,
      expectedPlacementRevision: placement.revision }, { kind: 'human' }, { kind: 'human' });
  }
  const control = new ControlStore(root);
  try {
    const db = control.connection;
    const [first, second] = db.prepare('SELECT id, record, placement_id, request_id FROM runs ORDER BY id').all();
    assert.ok(first && second);
    const original = JSON.parse(String(first.record));
    assert.throws(() => db.prepare("UPDATE runs SET id=99999,record=json_set(record,'$.id','R99999') WHERE id=?").run(first.id),
      /run ownership is immutable/);
    const placementChange = JSON.stringify({ ...original, placementId: second.placement_id });
    assert.throws(() => db.prepare('UPDATE runs SET record=? WHERE id=?')
      .run(placementChange, first.id), /run ownership is immutable/);
    const requestChange = JSON.stringify({ ...original, requestId: second.request_id });
    assert.throws(() => db.prepare('UPDATE runs SET record=? WHERE id=?')
      .run(requestChange, first.id), /run ownership is immutable/);
    assert.equal(db.prepare('SELECT record FROM runs WHERE id=?').get(first.id)!.record, first.record);
    db.prepare("UPDATE runs SET record=json_set(record,'$.state','running') WHERE id=?").run(first.id);
    assert.equal(db.prepare('SELECT state FROM runs WHERE id=?').get(first.id)!.state, 'running');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { control.close(); }
}));

test('replacing and releasing a responsible placement retains its ended responsibility', async () => fixture(async root => {
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: null,
    tasks: [{ title: 'One' }] })).tasks[0];
  const commands = new PlacementCommands(root);
  const first = (await commands.placeNewResponsible({ taskId: task.id, profileKey: 'codex',
    expectedTaskHash: task.hash }, { kind: 'human' })).placement;
  const afterFirst = await new ControlTaskStore(root).get(task.id);
  const replaced = await commands.placeNewResponsible({ taskId: task.id, profileKey: 'codex',
    expectedTaskHash: afterFirst.hash, replacePlacementId: first.id, expectedPlacementRevision: first.revision },
  { kind: 'human' });
  assert.equal(replaced.previousPlacement.responsible, true);
  assert.equal(replaced.previousPlacement.active, false);
  const afterReplace = await new ControlTaskStore(root).get(task.id);
  const released = await commands.release({ taskId: task.id, placementId: replaced.placement.id,
    expectedTaskHash: afterReplace.hash, expectedPlacementRevision: replaced.placement.revision }, { kind: 'human' });
  assert.equal(released.placement.responsible, true);
  assert.equal(released.placement.active, false);
  const control = new ControlStore(root);
  try {
    const db = control.connection;
    const history = db.prepare('SELECT responsible, ended_at FROM placements WHERE task_id=? ORDER BY started_at,id').all(task.id);
    assert.equal(history.length, 2);
    assert.ok(history.every(row => row.responsible === 1 && row.ended_at !== null));
    const person = new PlacementStore(root, false, db);
    person.createAndPlace({ taskId: task.id, profileKey: 'codex', responsible: true });
    assert.throws(() => db.prepare('UPDATE placements SET ended_at=NULL WHERE id=?').run(first.id));
    assert.equal(db.prepare('SELECT count(*) AS n FROM placements WHERE task_id=? AND responsible=1 AND ended_at IS NULL')
      .get(task.id)!.n, 1);
  } finally { control.close(); }
}));

async function schedulerFixture(root: string) {
  writeFileSync(join(root, 'config.yaml'), stringify({ limits: { parallel: 2, run_minutes: 1 },
    agents: { plain: fixtureAgentSetting('codex') } }));
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: 'P1', userRequested: null,
    tasks: [{ title: 'Run start' }] })).tasks[0];
  const placements = new PlacementStore(root);
  const owner = placements.createAndPlace({ taskId: task.id, profileKey: 'plain', responsible: true }).placement;
  const worker = placements.createAndPlace({ taskId: task.id, profileKey: 'plain', responsible: false }).placement;
  placements.close();
  const settings = readAgentsSettings(root);
  assert.equal(settings.ok, true);
  if (!settings.ok) throw settings.error;
  const path = installAgentStub(root, 'alpacawork-agent', [process.execPath,
    new URL('./fixtures/fake-run-agent.mjs', import.meta.url).pathname, '--root', root, '--format', 'codex']);
  const launchPlan = launchSnapshot(settings.config, 'plain', 'start', path).launch;
  const add = (store: RunStore, tx: RunTransaction, placement = owner) => {
    const requestId = randomUUID();
    tx.insertRequest({ id: requestId, taskId: task.id, placementId: placement.id,
      placementRevision: placement.revision, taskHash: task.hash, waitCycleId: null, headRunId: null, mode: 'new',
      body: 'Start', purpose: 'instruction', author: { kind: 'human' }, submittedAt: new Date().toISOString(),
      deliveryState: 'queued' });
    grantFixtureRequest(store, tx, requestId);
    return tx.create({ task: task.id, placementId: placement.id, requestId, agent: 'plain',
      role: placement.responsible ? 'owner' : 'worker', resumes: null, continues: false,
      session: null, caller: null, cwd: root, launch: launchPlan }, 'Start');
  };
  return { owner, worker, settings, add };
}

test('committed queued Run prepares its folder and launches after reopening the database', async () => fixture(async root => {
  const { add } = await schedulerFixture(root);
  const original = new RunStore(root, { busyTimeoutMs: 1000 });
  const run = original.write(tx => add(original, tx));
  assert.equal(existsSync(original.folder(run.id)), false);
  original.close();
  const reopened = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const result = await settle(reopened);
    assert.deepEqual(result.launched, [run.id]);
    assert.equal(existsSync(reopened.folder(run.id)), true);
    for (let i = 0; reopened.get(run.id)!.state !== 'succeeded' && i < 300; i++) {
      new RunEventImporter(reopened).pass();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const completed = reopened.get(run.id)!;
    assert.equal(completed.state, 'succeeded');
    assert.equal(reopened.getText(run.id)!.result?.includes('fake result'), true);
    assert.ok(completed.pids.manager);
    for (let i = 0; i < 300; i++) {
      try { process.kill(completed.pids.manager, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { reopened.close(); }
}));

test('new queued Run from settle callback waits for commit before folder preparation', async () => fixture(async root => {
  const { settings, add } = await schedulerFixture(root);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    let id = '';
    const decision = await settleTransaction(store, settings, tx => {
      const run = add(store, tx); id = run.id;
      assert.equal(existsSync(store.folder(run.id)), false);
      assert.equal(store.connection.isTransaction, true);
    });
    try {
      assert.deepEqual(decision.launches.map(item => item.id), [id]);
      assert.equal(existsSync(store.folder(id)), true);
      assert.equal(store.get(id)!.state, 'running');
    } finally { closeLaunches(decision.launches); }
  } finally { store.close(); }
}));

test('unpreparable queued folder stays queued without blocking another Run', async () => fixture(async root => {
  const { settings, add, worker } = await schedulerFixture(root);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  try {
    const blocked = store.write(tx => add(store, tx));
    const other = store.write(tx => add(store, tx, worker));
    mkdirSync(join(root, '.alpacawork', 'runs'), { recursive: true });
    writeFileSync(store.folder(blocked.id), 'obstruction');
    const decision = await settleTransaction(store, settings);
    try {
      assert.deepEqual(decision.launches.map(item => item.id), [other.id]);
      assert.deepEqual(decision.summary.skipped.map(item => item.run), [blocked.id]);
      assert.equal(store.get(blocked.id)!.state, 'queued');
      assert.equal(store.get(other.id)!.state, 'running');
      rmSync(store.folder(blocked.id));
      const retry = await settleTransaction(store, settings);
      try {
        assert.deepEqual(retry.launches.map(item => item.id), [blocked.id]);
        assert.equal(existsSync(store.folder(blocked.id)), true);
      } finally { closeLaunches(retry.launches); }
    } finally { closeLaunches(decision.launches); }
  } finally { store.close(); }
}));

// The schema's own constraints: the database refuses these rows whoever writes them, so they are written here as SQL.
// The shape refusals the project commands also make (a task moved under another project, a project that moves or sits
// under a task, a placement on a project) are projects.test.ts's.
const at = '2026-10-19T00:00:00.000Z';
/** A Task row: its ID (T42), its row ID, and the project it belongs to (null for a project). */
type Row = { id: string; uuid: string; project: string | null };

function schema(t: TestContext): DatabaseSync {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-control-schema-')));
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 }, false, true);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return db;
}
/** A project or a task below `parent`; `project` overrides the project it belongs to (by default its parent's). */
function insertTask(db: DatabaseSync, kind: string, parent: Row | null, columns: { project?: string | null; state?: string;
  userRequested?: number; settings?: string } = {}): Row {
  const uuid = randomUUID(), number = Number(db.prepare('SELECT coalesce(max(number), 0) + 1 AS n FROM tasks').get()!.n);
  const project = columns.project !== undefined ? columns.project
    : kind === 'project' || parent === null ? null : parent.project ?? parent.uuid;
  db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,
    created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?,?,1,?,?)`).run(uuid, kind, number, parent?.uuid ?? null, project,
    `Task ${number}`, columns.state === 'held' ? 'doing' : columns.state ?? 'todo', columns.state === 'held' ? 1 : 0, columns.userRequested ?? 0, columns.settings ?? null, at, at);
  return { id: `${kind === 'project' ? 'P' : 'T'}${number}`, uuid, project };
}
function insertLog(db: DatabaseSync, task: Row, entry: Record<string, unknown>): string {
  const id = `L${randomUUID()}`;
  const ordinal = Number(db.prepare('SELECT count(*) AS n FROM task_log WHERE task_id = ?').get(task.uuid)!.n) + 1;
  db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)')
    .run(id, task.uuid, ordinal, JSON.stringify({ id, at, ...entry }));
  return id;
}
function insertPlacement(db: DatabaseSync, task: Row): string {
  const agent = `A${randomUUID()}`, id = `P${randomUUID()}`;
  db.prepare('INSERT INTO agents(id,created_at) VALUES (?,?)').run(agent, at);
  db.prepare(`INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
    VALUES (?,?,?,'codex',1,1,?)`).run(id, task.id, agent, at);
  return id;
}
/** A Request to a Task's placement or to a coordinator conversation; one in a wait cycle is a placement's by default. */
function insertRequest(db: DatabaseSync, columns: { task?: Row; placement?: string; conversation?: string; cycle?: string;
  authorKind?: string; head?: string; authorPlacement?: string }): string {
  const id = randomUUID(), placed = columns.placement !== undefined;
  let sender = columns.authorPlacement;
  if (columns.cycle !== undefined && sender === undefined) {
    const cycleTask = String(db.prepare('SELECT task_id FROM wait_cycles WHERE id=?').get(columns.cycle)!.task_id);
    const row = db.prepare('SELECT id FROM placements WHERE task_id=? LIMIT 1').get(cycleTask);
    const task = db.prepare('SELECT id,project_task_id FROM tasks WHERE external_id=?').get(cycleTask)!;
    sender = row ? String(row.id) : insertPlacement(db, { id: cycleTask, uuid: String(task.id), project: String(task.project_task_id) });
  }
  db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,conversation_id,wait_cycle_id,head_run_id,
    mode,body,purpose,author,submitted_at,delivery_state) VALUES (?,?,?,?,?,?,?,?,'new','work',?,?,?,'queued')`)
    .run(id, columns.task?.id ?? null, columns.placement ?? null, placed ? 1 : null, placed ? '0'.repeat(64) : null,
      columns.conversation ?? null, columns.cycle ?? null, columns.head ?? null,
      'instruction',
      JSON.stringify({ kind: columns.authorKind ?? (columns.cycle === undefined ? 'human' : 'placement'),
        ...(sender === undefined ? {} : { placementId: sender }) }), at);
  return id;
}
/** A Run answering `request`: a Task's (owner) at a placement, or the coordinator's in `conversation`. */
function insertRun(db: DatabaseSync, columns: { task?: Row; placement?: string; request: string; conversation?: string;
  role?: string; resumes?: string; caller?: string }): string {
  const n = Number(db.prepare('SELECT coalesce(max(id), 0) + 1 AS n FROM runs').get()!.n);
  const coordinator = columns.conversation !== undefined;
  const fields = { ...record(`R${n}`), task: columns.task?.id ?? null, placementId: columns.placement ?? null,
    requestId: columns.request, caller: columns.caller === undefined ? null : { run: columns.caller }, role: columns.role ?? (coordinator ? 'coordinator' : 'owner'), resumes: columns.resumes ?? null,
    ...(coordinator ? { conversationId: columns.conversation } : {}) };
  db.prepare('INSERT INTO runs(id,record) VALUES (?,?)').run(n, JSON.stringify(fields));
  return `R${n}`;
}
const CHECK = /CHECK constraint failed/;
const UNIQUE = /UNIQUE constraint failed/;

test('a task belongs to its nearest project for good; a project to none, and it neither works nor is the user\'s request', t => {
  const db = schema(t);
  const root = insertTask(db, 'project', null), nested = insertTask(db, 'project', root);
  const task = insertTask(db, 'task', root), child = insertTask(db, 'task', task), nestedTask = insertTask(db, 'task', nested);
  const projectOfRow = (row: Row) => db.prepare('SELECT project_task_id AS p FROM tasks WHERE id = ?').get(row.uuid)!.p;
  assert.deepEqual([projectOfRow(root), projectOfRow(nested), projectOfRow(child), projectOfRow(nestedTask)],
    [null, null, root.uuid, nested.uuid]);
  const refused: [string, () => unknown, RegExp][] = [
    ['an unknown kind', () => insertTask(db, 'folder', root, { project: root.uuid }), CHECK],
    ['a project that belongs to a project', () => insertTask(db, 'project', root, { project: root.uuid }), CHECK],
    ['a project at work', () => insertTask(db, 'project', root, { state: 'doing' }), CHECK],
    ['a project as the user\'s request', () => insertTask(db, 'project', root, { userRequested: 1 }), CHECK],
    ['a task with project settings', () => insertTask(db, 'task', root, { settings: '{}' }), CHECK],
    ['a task with no parent', () => insertTask(db, 'task', null, { project: root.uuid }),
      /task parent must be its project or a task of that project/],
    ['a task under a task of another project', () => insertTask(db, 'task', nestedTask, { project: root.uuid }),
      /task parent must be its project or a task of that project/],
    ['a task that becomes a project', () => db.prepare("UPDATE tasks SET kind = 'project', project_task_id = NULL WHERE id = ?")
      .run(child.uuid), /task kind and project are immutable/],
  ];
  for (const [name, write, refusal] of refused) assert.throws(write, refusal, name);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get()!.n, 5);
});

test('only a task the user requested waits for the user', t => {
  const db = schema(t);
  const root = insertTask(db, 'project', null);
  assert.throws(() => insertTask(db, 'task', root, { state: 'waiting' }), CHECK);
  const requested = insertTask(db, 'task', root, { state: 'waiting', userRequested: 1 });
  assert.throws(() => db.prepare('UPDATE tasks SET user_requested = 0 WHERE id = ?').run(requested.uuid), CHECK);
  db.prepare("UPDATE tasks SET base_state = 'doing' WHERE id = ?").run(requested.uuid);
  db.prepare('UPDATE tasks SET user_requested = 0 WHERE id = ?').run(requested.uuid);
});

test('a coordinator conversation\'s Requests and Runs have no Task, and a Task\'s are of no conversation', t => {
  const db = schema(t);
  const root = insertTask(db, 'project', null), task = insertTask(db, 'task', root), placement = insertPlacement(db, task);
  const [open, cleared] = [randomUUID(), randomUUID()];
  db.prepare('INSERT INTO coordinator_conversations(id,started_at,cleared_at) VALUES (?,?,?),(?,?,?)')
    .run(cleared, at, at, open, at, null);
  const taskRequest = () => insertRequest(db, { task, placement });
  const message = () => insertRequest(db, { conversation: open });
  const taskRun = insertRun(db, { task, placement, request: taskRequest() });
  const coordinatorRun = insertRun(db, { request: message(), conversation: open });
  const refused: [string, () => unknown, RegExp][] = [
    ['a Request to both', () => insertRequest(db, { task, placement, conversation: open }), CHECK],
    ['a Request to neither', () => insertRequest(db, {}), CHECK],
    ['a message that is not the person\'s', () => insertRequest(db, { conversation: open, authorKind: 'main' }), CHECK],
    ['a Task\'s Request with no placement', () => insertRequest(db, { task }), CHECK],
    ['a message after a Task\'s Run', () => insertRequest(db, { conversation: open, head: taskRun }), /request head mismatch/],
    ['a coordinator Run of a Task', () => insertRun(db, { task, placement, request: taskRequest(), role: 'coordinator' }), CHECK],
    ['a Task\'s Run in the conversation', () => insertRun(db, { request: message(), conversation: open, role: 'owner' }), CHECK],
    ['a coordinator Run at a placement', () => insertRun(db, { placement, request: message(), conversation: open }),
      /run placement witness mismatch/],
    ['a coordinator Run answering a Task\'s Request', () => insertRun(db, { request: taskRequest(), conversation: open }),
      /run request witness mismatch/],
    ['a coordinator Run answering another conversation', () => insertRun(db, {
      request: insertRequest(db, { conversation: cleared }), conversation: open }), /run conversation witness mismatch/],
    ['a Task\'s Run resuming the coordinator', () => insertRun(db, { task, placement, request: taskRequest(), resumes: coordinatorRun }),
      /run resume witness mismatch/],
    ['a message moved to another conversation', () => db.prepare('UPDATE requests SET conversation_id = ? WHERE conversation_id = ?')
      .run(cleared, open), /request ownership is immutable/],
    ['a coordinator Run moved to another conversation', () => db.prepare(`UPDATE runs SET record = json_set(record, '$.conversationId', ?)
      WHERE id = ?`).run(cleared, Number(coordinatorRun.slice(1))), /run ownership is immutable/],
  ];
  for (const [name, write, refusal] of refused) assert.throws(write, refusal, name);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a seat has one open wait cycle, which closes once, and a placement\'s Request joins it only while it is open', t => {
  const db = schema(t);
  const root = insertTask(db, 'project', null), seat = insertTask(db, 'task', root);
  const child = insertTask(db, 'task', seat), sibling = insertTask(db, 'task', root);
  const [childPlacement, siblingPlacement] = [insertPlacement(db, child), insertPlacement(db, sibling)];
  const cycle = (task: Row, closedAt: string | null = null) => {
    const id = randomUUID();
    db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at,closed_at) VALUES (?,?,?,?)').run(id, task.id, at, closedAt);
    return id;
  };
  const first = cycle(seat);
  insertRequest(db, { task: child, placement: childPlacement, cycle: first });
  const refused: [string, () => unknown, RegExp][] = [
    ['a second open cycle', () => cycle(seat), UNIQUE],
    ['a project\'s cycle', () => cycle(root), /a wait cycle belongs to a task/],
    ['a cycle closed before it opened', () => cycle(child, '2026-10-18T00:00:00.000Z'), CHECK],
    ['a Request whose author is not its cycle seat', () => insertRequest(db, { task: sibling, placement: siblingPlacement, cycle: first, authorPlacement: siblingPlacement }),
      /request wait cycle mismatch/],
    ['a placement\'s Request outside a cycle',
      () => insertRequest(db, { task: child, placement: childPlacement, authorKind: 'placement' }), CHECK],
    ['a person\'s Request in a cycle',
      () => insertRequest(db, { task: child, placement: childPlacement, cycle: first, authorKind: 'human' }), CHECK],
    ['a Request moved out of its cycle', () => db.prepare('UPDATE requests SET wait_cycle_id = NULL WHERE wait_cycle_id = ?').run(first),
      /request ownership is immutable/],
    ['a cycle opened at another time', () => db.prepare("UPDATE wait_cycles SET opened_at = '2026-10-20T00:00:00.000Z' WHERE id = ?")
      .run(first), /a wait cycle only closes, and only once/],
  ];
  for (const [name, write, refusal] of refused) assert.throws(write, refusal, name);
  const close = (id: string, closedAt: string | null) => db.prepare('UPDATE wait_cycles SET closed_at = ? WHERE id = ?').run(closedAt, id);
  close(first, '2026-10-20T00:00:00.000Z');
  for (const closedAt of ['2026-10-21T00:00:00.000Z', null])
    assert.throws(() => close(first, closedAt), /a wait cycle only closes, and only once/, String(closedAt));
  assert.throws(() => insertRequest(db, { task: child, placement: childPlacement, cycle: first }), /request wait cycle mismatch/);
  insertRequest(db, { task: child, placement: childPlacement, cycle: cycle(seat) });
});

test('a notice goes where the log that caused it says, once; a placement\'s Request closes once', t => {
  const db = schema(t);
  const root = insertTask(db, 'project', null), parent = insertTask(db, 'task', root);
  const child = insertTask(db, 'task', parent), other = insertTask(db, 'task', root);
  const asked = insertLog(db, child, { kind: 'asked', askedTo: parent.id });
  const answered = insertLog(db, child, { kind: 'answered', questionId: asked });
  const urgent = insertLog(db, child, { kind: 'reported', urgentReason: 'The disk is full' });
  const plain = insertLog(db, child, { kind: 'reported' });
  const created = insertLog(db, child, { kind: 'created' });
  const handover = insertLog(db, parent, { kind: 'responsible_changed' });
  const placement = insertPlacement(db, child), cycle = randomUUID();
  db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES (?,?,?)').run(cycle, parent.id, at);
  const placed = insertRequest(db, { task: child, placement, cycle });
  const returned = (outcome: string, to: Row, cause: string | null, request: string | null = null) =>
    db.prepare('INSERT INTO returns(id,request_id,to_task_id,outcome,cause_log_id,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), request, to.id, outcome, cause, at);
  for (const [outcome, to, cause] of [['question', parent, asked], ['answer', child, answered], ['urgent', parent, urgent],
    ['handover', parent, handover], ['child_added', parent, created]] as const) returned(outcome, to, cause);
  returned('succeeded', parent, null, placed);
  const refused: [string, () => unknown, RegExp][] = [
    ['a question to another Task than it asks', () => returned('question', other, asked), /question return destination mismatch/],
    ['an answer to another Task than the asker', () => returned('answer', parent, answered), /answer return destination mismatch/],
    ['an urgent notice without a reason', () => returned('urgent', parent, plain), /urgent return has no urgent reason/],
    ['a handover to another Task', () => returned('handover', child, handover), /handover return destination mismatch/],
    ['a new child to another Task than its parent', () => returned('child_added', child, created), /child return destination mismatch/],
    ['the same notice twice', () => returned('question', parent, asked), UNIQUE],
    ['a notice that closes a Request', () => returned('question', parent, asked, insertRequest(db, { task: child, placement, cycle })),
      CHECK],
    ['a second close of the Request', () => returned('failed', parent, null, placed), UNIQUE],
    ['a close of no Request', () => returned('succeeded', parent, null), CHECK],
    ['a close of a person\'s Request', () => returned('succeeded', parent, null, insertRequest(db, { task: child, placement })),
      /return closes no placement request/],
  ];
  for (const [name, write, refusal] of refused) assert.throws(write, refusal, name);
  assert.equal(db.prepare('SELECT count(*) AS n FROM returns').get()!.n, 6);
});

test('a question closes once, by its first answer or withdrawal; only an answer keeps a text, fixed when written', t => {
  const db = schema(t);
  const root = insertTask(db, 'project', null), parent = insertTask(db, 'task', root);
  const child = insertTask(db, 'task', parent), other = insertTask(db, 'task', root);
  const first = insertLog(db, child, { kind: 'asked', askedTo: parent.id });
  const second = insertLog(db, child, { kind: 'asked', askedTo: null });
  const answered = insertLog(db, child, { kind: 'answered', questionId: first });
  const withdrawn = insertLog(db, child, { kind: 'question_withdrawn', questionId: first });
  const elsewhere = insertLog(db, other, { kind: 'answered', questionId: first });
  const long = insertLog(db, other, { kind: 'answered', questionId: second });
  const reported = insertLog(db, child, { kind: 'reported' });
  const close = (log: string, question: string) =>
    db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES (?,?)').run(log, question);
  close(answered, first);
  const fix = (log: string, text: string) => db.prepare('INSERT INTO log_texts(log_id,text) VALUES (?,?)').run(log, text);
  fix(answered, 'Blue');
  fix(long, 'x'.repeat(1024 * 1024));
  const refused: [string, () => unknown, RegExp][] = [
    ['a withdrawal after the answer', () => close(withdrawn, first), UNIQUE],
    ['an answer on another Task', () => close(elsewhere, first), /question closing mismatch/],
    ['an answer to another question', () => close(answered, second), /question closing mismatch/],
    ['a report as the close', () => close(reported, second), /question closing mismatch/],
    // A question's words are in its own record (its `decide`), so no text is kept beside it.
    ['a text kept for a question', () => fix(first, 'Which colour?'), /only an answer keeps its text/],
    ['a text kept for a report', () => fix(reported, 'Done'), /only an answer keeps its text/],
    ['a text kept for a withdrawal', () => fix(withdrawn, 'Never mind'), /only an answer keeps its text/],
    ['an empty text', () => fix(elsewhere, ''), CHECK],
    ['a text over 1 MiB', () => fix(elsewhere, 'x'.repeat(1024 * 1024 + 1)), CHECK],
    ['a rewritten text', () => db.prepare("UPDATE log_texts SET text = 'Red' WHERE log_id = ?").run(answered), /log text is immutable/],
    ['a removed text', () => db.prepare('DELETE FROM log_texts WHERE log_id = ?').run(answered), /log text is immutable/],
  ];
  for (const [name, write, refusal] of refused) assert.throws(write, refusal, name);
  const withdrawal = insertLog(db, child, { kind: 'question_withdrawn', questionId: second });
  close(withdrawal, second);
  assert.deepEqual(db.prepare('SELECT log_id, question_log_id FROM task_log_question ORDER BY rowid').all().map(row => ({ ...row })),
    [{ log_id: answered, question_log_id: first }, { log_id: withdrawal, question_log_id: second }]);
  assert.deepEqual(db.prepare('SELECT log_id FROM log_texts ORDER BY rowid').all().map(row => row.log_id), [answered, long]);
});

test('the question structure migration moves each old question\'s title and fixed text into its record and keeps only answers\' texts', () => {
  const QUESTION_STRUCTURE = '20261111000000_question_structure';
  const sql = (name: string) => readFileSync(`packages/db/drizzle/control/${name}/migration.sql`, 'utf8')
    .replaceAll(/SELECT alpacawork_data_migration\('[^']*'\);/g, '');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const item of packagedMigrations('control').filter(item => item.name < QUESTION_STRUCTURE)) db.exec(sql(item.name));
    db.prepare(`INSERT INTO tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,settings,revision,created_at,updated_at)
      VALUES('p','project',1,NULL,NULL,'Synthetic','active','todo',0,'{"color":"#39659b"}',1,?,?),
            ('t','task',2,'p','p','Synthetic','active','doing',0,NULL,1,?,?)`).run(at, at, at, at);
    const log = (id: string, ordinal: number, entry: Record<string, unknown>) => db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES (?,?,?,?)')
      .run(id, 't', ordinal, JSON.stringify({ id, at, ...entry }));
    const fix = (id: string, text: string) => db.prepare('INSERT INTO log_texts(log_id,text) VALUES (?,?)').run(id, text);
    const fixed = '### 1 Which colour?\n#### Red → 中止\nStands out\n#### Blue\nCalm\n\nおすすめ: Blue — "Calm"';
    log('Lcreated', 1, { kind: 'created', title: null, description: null });
    log('Lasked', 2, { kind: 'asked', askedTo: null, title: 'Colour', description: 'Pick one', runId: null });
    log('Lanswered', 3, { kind: 'answered', questionId: 'Lasked', title: null });
    log('Lbare', 4, { kind: 'asked', askedTo: 'T2', title: null, description: 'No text was kept' });
    fix('Lasked', fixed); fix('Lanswered', '1-Blue');
    db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES (?,?)').run('Lanswered', 'Lasked');
    const entries = () => Object.fromEntries(db.prepare('SELECT id, entry FROM task_log ORDER BY ordinal').all()
      .map(row => [String(row.id), JSON.parse(String(row.entry))]));
    const before = entries();
    db.exec(sql(QUESTION_STRUCTURE));
    const after = entries();
    // An old question keeps all of its words as one item: its title as what to decide, its whole fixed text as the note.
    assert.deepEqual(after.Lasked, { ...before.Lasked, decide: [{ decide_kind: 'choose', decide_question: 'Colour', decide_note: fixed }] });
    assert.deepEqual(after.Lbare, { ...before.Lbare, decide: [{ decide_kind: 'choose', decide_question: '', decide_note: '' }] });
    // No other record changes, and the question's text leaves while the answer's stays.
    assert.deepEqual([after.Lcreated, after.Lanswered], [before.Lcreated, before.Lanswered]);
    assert.deepEqual(db.prepare('SELECT log_id, text FROM log_texts').all().map(row => ({ ...row })), [{ log_id: 'Lanswered', text: '1-Blue' }]);
    assert.deepEqual(db.prepare('SELECT log_id, question_log_id FROM task_log_question').all().map(row => ({ ...row })),
      [{ log_id: 'Lanswered', question_log_id: 'Lasked' }]);
    // The guards lifted for the rewrite are back, and from now on only an answer keeps a text.
    assert.throws(() => db.prepare("UPDATE task_log SET entry=json_set(entry,'$.title','Changed') WHERE id='Lasked'").run(), /task log is immutable/);
    assert.throws(() => db.prepare("DELETE FROM log_texts WHERE log_id='Lanswered'").run(), /log text is immutable/);
    assert.throws(() => db.prepare("UPDATE log_texts SET text='2' WHERE log_id='Lanswered'").run(), /log text is immutable/);
    assert.throws(() => fix('Lasked', fixed), /only an answer keeps its text/);
    assert.throws(() => fix('Lbare', 'Late'), /only an answer keeps its text/);
    log('Lagain', 5, { kind: 'answered', questionId: 'Lbare', title: null });
    fix('Lagain', 'Proceed');
  } finally { db.close(); }
});


test('task logs are append-only and their embedded references are checked without duplicate tables', t => {
  const db = schema(t), project = insertTask(db, 'project', null), task = insertTask(db, 'task', project);
  const log = insertLog(db, task, { kind: 'created' });
  assert.throws(() => db.prepare("UPDATE task_log SET entry=json_set(entry,'$.kind','reported') WHERE id=?").run(log),
    /task log is immutable/);
  assert.throws(() => db.prepare('DELETE FROM task_log WHERE id=?').run(log), /task log is immutable/);
  assert.throws(() => insertLog(db, task, { kind: 'run_stop_requested', runIds: ['R99999'] }), /log run must be a Task Run/);
  assert.throws(() => insertLog(db, task, { kind: 'moved', formerAncestors: ['T99999'] }), /log former ancestor missing/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('task_log_run','task_log_former_ancestor')").get()!.n, 0);
});

test('a request keeps every acceptance snapshot immutable while delivery progresses', t => {
  const db = schema(t), project = insertTask(db, 'project', null), task = insertTask(db, 'task', project);
  const placement = insertPlacement(db, task), request = insertRequest(db, { task, placement });
  for (const [column, value] of [['id', 'different'], ['placement_revision', 2], ['task_hash', 'different'],
    ['head_run_id', 'R99999'], ['mode', 'continue'], ['body', 'different'], ['purpose', 'review_send_back'],
    ['author', '{"kind":"main"}'], ['submitted_at', '2026-10-20T00:00:00.000Z']] as const)
    assert.throws(() => db.prepare(`UPDATE requests SET ${column}=? WHERE id=?`).run(value, request),
      /request ownership is immutable/, column);
  db.prepare("UPDATE requests SET delivery_state='aborted' WHERE id=?").run(request);
  assert.equal(db.prepare('SELECT delivery_state FROM requests WHERE id=?').get(request)!.delivery_state, 'aborted');
});

test('generated Run references reject a mismatched placement and a closing return names its cycle seat', t => {
  const db = schema(t), project = insertTask(db, 'project', null), seat = insertTask(db, 'task', project);
  const task = insertTask(db, 'task', seat), placement = insertPlacement(db, task), other = insertPlacement(db, seat);
  const cycle = randomUUID();
  db.prepare('INSERT INTO wait_cycles(id,task_id,opened_at) VALUES (?,?,?)').run(cycle, seat.id, at);
  const request = insertRequest(db, { task, placement, cycle });
  const senderRequest = insertRequest(db, { task: seat, placement: other });
  const caller = insertRun(db, { task: seat, placement: other, request: senderRequest });
  assert.throws(() => insertRun(db, { task, placement: other, request }), /run placement witness mismatch/);
  db.prepare('UPDATE placements SET responsible=0 WHERE id=?').run(placement);
  const alternate = insertPlacement(db, task);
  assert.throws(() => insertRun(db, { task, placement: alternate, request }), /run request placement mismatch/);
  assert.throws(() => insertRun(db, { task, placement, request }), /run requester seat mismatch/);
  const run = insertRun(db, { task, placement, request, caller });
  assert.throws(() => db.prepare('INSERT INTO runs(id,record) VALUES (?,?)')
    .run(99999, JSON.stringify({ id: 'R99999', role: 'owner', task: 'T99999' })), /FOREIGN KEY constraint failed/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM pragma_table_xinfo('runs') WHERE name IN ('uuid','task_uuid','placement_uuid','request_uuid')").get()!.n, 0);
  const close = (to: string) => db.prepare(`INSERT INTO returns(id,request_id,to_task_id,outcome,boundary_run_id,created_at)
    VALUES (?,?,?,'succeeded',?,?)`).run(randomUUID(), request, to, run, at);
  assert.throws(() => close(task.id), /return requester seat mismatch/);
  close(seat.id);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('both command write boundaries exclude a file operation reserved under that operation ID', async () => fixture(async root => {
  const store = new ControlStore(root);
  try {
    store.write(db => db.prepare(`INSERT INTO file_operations(id,op_id,kind,fingerprint,state,result_json)
      VALUES ('reserved','reserved-op','put','file-fingerprint','prepared','{}')`).run());
    const input = { opId: 'reserved-op', operation: 'task.report', fingerprint: 'command-fingerprint' };
    let called = false;
    assert.throws(() => store.writeOperation(input, () => { called = true; return { status: 200, body: {} }; }),
      { code: 'idempotency_conflict' });
    await assert.rejects(store.writeOperationAsync(input, () => { called = true; return { status: 200, body: {} }; }),
      { code: 'idempotency_conflict' });
    assert.equal(called, false);
    assert.equal(store.connection.prepare("SELECT count(*) AS n FROM cli_operations WHERE op_id='reserved-op'").get()!.n, 0);
  } finally { store.close(); }
}));

for (const firstMode of ['sync', 'async'] as const) {
  test(`${firstMode} receipt replays across both boundaries without changing persisted bytes`, async () => fixture(async root => {
    const input = { opId: 'cross-boundary', operation: 'test', fingerprint: 'original' };
    const body = { ordered: ['日本語', null], date: new Date('2026-01-01T00:00:00Z'), omitted: undefined, nan: NaN };
    let calls = 0;
    let store = new ControlStore(root);
    try {
      const callback = () => { calls++; return { status: 202, body }; };
      const first = firstMode === 'sync' ? store.writeOperation(input, callback)
        : await store.writeOperationAsync(input, async () => { await Promise.resolve(); return callback(); });
      assert.equal(first.body, body, 'first response retains the original callback body');
      assert.equal(first.replayed, false);
      const saved = store.connection.prepare('SELECT * FROM cli_operations WHERE op_id=?').get(input.opId)!;
      assert.ok(saved, 'the callback result must have a durable receipt');
      assert.equal(saved.response_json, JSON.stringify(body));
      store.close();
      store = new ControlStore(root);
      const mustNotRun = () => { calls++; throw new Error('replay callback ran'); };
      for (const replay of [store.writeOperation(input, mustNotRun), await store.writeOperationAsync(input, mustNotRun)])
        assert.deepEqual(replay, { status: 202, body: JSON.parse(JSON.stringify(body)), replayed: true });
      for (const different of [{ ...input, fingerprint: 'other' }, { ...input, operation: 'other' }]) {
        assert.throws(() => store.writeOperation(different, mustNotRun), { code: 'idempotency_conflict' });
        await assert.rejects(store.writeOperationAsync(different, mustNotRun), { code: 'idempotency_conflict' });
      }
      assert.equal(calls, 1);
      assert.deepEqual(store.connection.prepare('SELECT * FROM cli_operations WHERE op_id=?').get(input.opId), saved);
    } finally { store.close(); }
  }));

  test(`${firstMode} receipt failures roll back domain writes and allow the same ID to retry`, async () => fixture(async root => {
    const store = new ControlStore(root);
    try {
      const db = store.connection;
      const initial = db.prepare('SELECT next_number FROM run_sequence').get()!.next_number;
      const circular: { self?: unknown } = {}; circular.self = circular;
      const cases = [
        { name: 'callback', body: {}, error: /callback failed/ },
        { name: 'undefined', body: undefined, error: { code: 'invalid_input' } },
        { name: 'bigint', body: 1n, error: TypeError },
        { name: 'circular', body: circular, error: TypeError },
        { name: 'insert', body: {}, error: /receipt failed/ },
      ];
      db.exec(`CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON cli_operations
        WHEN NEW.op_id='failure-insert' BEGIN SELECT RAISE(ABORT,'receipt failed'); END`);
      for (const entry of cases) {
        const input = { opId: `failure-${entry.name}`, operation: 'test', fingerprint: 'same' };
        let calls = 0;
        const callback = () => {
          calls++;
          assert.equal(db.isTransaction, true);
          db.prepare('UPDATE run_sequence SET next_number=next_number+1').run();
          if (entry.name === 'callback') throw new Error('callback failed');
          return { status: 201, body: entry.body };
        };
        await assert.rejects(async () => firstMode === 'sync' ? store.writeOperation(input, callback)
          : await store.writeOperationAsync(input, async () => { await Promise.resolve(); return callback(); }), entry.error);
        assert.equal(calls, 1);
        assert.equal(db.isTransaction, false);
        assert.equal(db.prepare('SELECT next_number FROM run_sequence').get()!.next_number, initial);
        assert.equal(store.operationGet(input.opId), null);
      }
      db.exec('DROP TRIGGER reject_receipt');
      for (const entry of cases) {
        const input = { opId: `failure-${entry.name}`, operation: 'test', fingerprint: 'same' };
        const callback = () => ({ status: 201, body: { retried: entry.name } });
        const result = firstMode === 'sync' ? store.writeOperation(input, callback)
          : await store.writeOperationAsync(input, callback);
        assert.equal(result.replayed, false);
        assert.deepEqual(store.operationGet(input.opId), { status: 201, body: result.body });
      }
    } finally { store.close(); }
  }));
}

test('async authorization rejects before matching, conflicting or absent receipt lookup', async () => fixture(async root => {
  const store = new ControlStore(root);
  try {
    const input = { opId: 'authorized', operation: 'test', fingerprint: 'same' };
    store.writeOperation(input, () => ({ status: 200, body: { secret: true } }));
    const before = store.connection.prepare('SELECT * FROM cli_operations').all();
    const denied = new Error('authorization denied');
    let checks = 0, calls = 0;
    for (const attempt of [input, { ...input, fingerprint: 'other' }, { ...input, opId: 'absent' }]) {
      await assert.rejects(store.writeOperationAsync(attempt,
        () => { calls++; return { status: 200, body: {} }; }, () => { checks++; throw denied; }), error => error === denied);
      assert.equal(store.connection.isTransaction, false);
    }
    assert.equal(checks, 3);
    assert.equal(calls, 0);
    assert.deepEqual(store.connection.prepare('SELECT * FROM cli_operations').all(), before);
  } finally { store.close(); }
}));

test('dialogues and refusal snapshots require a screen Request and never accept a Task Run request', t => {
  const db = schema(t), root = insertTask(db, 'project', null), task = insertTask(db, 'task', root);
  const placement = insertPlacement(db, task), taskRequest = insertRequest(db, { task, placement });
  const conversation = randomUUID();
  db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES (?,?)').run(conversation, at);
  const message = insertRequest(db, { conversation });
  const dialogue = (request: string) => db.prepare('INSERT INTO task_dialogues(task_uuid,request_id) VALUES (?,?)').run(task.uuid, request);
  const snapshot = JSON.stringify({ code: 'forbidden', message: 'Actual refusal', retry: 'fix', reason: { kind: 'authorization_required' } });
  const refusal = (request: string, problem: string | null = snapshot) =>
    db.prepare('INSERT INTO coordinator_refusals(request_id,task_uuid,refused_at,problem_json) VALUES (?,?,?,?)')
      .run(request, task.uuid, at, problem);
  dialogue(message); refusal(message);
  assert.throws(() => dialogue(taskRequest), /dialogue requires a screen Request/);
  assert.throws(() => refusal(taskRequest), /refusal requires a screen Request/);
  assert.throws(() => refusal(message, null), /CHECK constraint failed/);
  db.prepare('INSERT INTO coordinator_refusals(request_id,task_uuid,refused_at,problem_json,code_only) VALUES (?,?,?,?,?)').run(message, task.uuid, at, null, 'historical_code');
  assert.equal(db.prepare('SELECT count(*) n FROM coordinator_refusals WHERE problem_json IS NULL AND code_only=?').get('historical_code')!.n,1);
  assert.throws(() => refusal(message, '{invalid'), /CHECK constraint failed/);
  assert.equal(db.prepare('SELECT problem_json FROM coordinator_refusals').get()!.problem_json, snapshot);
  assert.throws(() => db.prepare('UPDATE task_dialogues SET request_id=? WHERE request_id=?').run(taskRequest, message),
    /dialogue requires a screen Request/);
  assert.throws(() => db.prepare('UPDATE coordinator_refusals SET request_id=? WHERE request_id=?').run(taskRequest, message),
    /refusal requires a screen Request/);
});
