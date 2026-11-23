import { CLI_CONTRACT, CONTRACT_HEADER } from '@alpacawork/contract/client-contract';
import { currentTaskLog } from './helpers/control-fixture.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
/**
 * Projects are project-type Tasks (design chapter 2): one Task number sequence and one folder per Task, a tree whose
 * shape the database keeps, a Task created without a parent put under the project whose code location holds the
 * caller's cwd, a Run kept in its own project, settings inherited item by item with '' turning a code location off,
 * a project's policy saved whole however long, and each project's facts read again only when they moved.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { RUN_FILES, runFolder } from '@alpacawork/contract/run';
import { taskFileRoute } from '@alpacawork/contract/cli-commands';
import { tryLock, unlock } from '@alpacawork/core';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RequestService } from '@alpacawork/backend/test-dist/control/requests.js';
import { FileJournal } from '@alpacawork/backend/test-dist/control/file-journal.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { launchCwd, projectLocations, writeProjectLocation } from '@alpacawork/backend/test-dist/control/project-settings.js';
import { initializeWorkspace } from '@alpacawork/backend/test-dist/control/initialize.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { cliCommand } from './helpers/cli-session.ts';

const MUTATIONS = new Set(['new', 'update', 'archive', 'restore', 'report', 'move', 'assign', 'put']);

/** The root project P1 and the fixture's project below it (`project`), with this PC's code folders beside the data. */
function workspace(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-projects-')));
  const servers: { close(): Promise<void> }[] = [];
  t.after(async () => { for (const server of servers) await server.close(); rmSync(base, { recursive: true, force: true }); });
  const root = join(base, 'data');
  mkdirSync(root);
  for (const code of ['code-a/inner/deeper', 'code-b', 'outside']) mkdirSync(join(base, code), { recursive: true });
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE)); }
  finally { writer.close(); }
  return { base, root, project, servers };
}
async function served(t: TestContext) {
  const { base, root, project, servers } = workspace(t);
  const server = await startServer(root, 0);
  servers.push(server);
  /** A person's CLI, run from a folder no project's code location holds unless the test names one. */
  const cli = async (args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) => {
    const verb = args.find(arg => MUTATIONS.has(arg));
    const argv = verb && !args.includes('--op-id') ? [...args, '--op-id', randomUUID()] : args;
    const { code, stdout, stderr } = await cliCommand(server.url, argv, options.env, '', options.cwd ?? join(base, 'outside'));
    // Commander prints its own line before the JSON refusal.
    return { code, body: JSON.parse((stdout.trim() ? stdout : stderr).trim().split('\n').at(-1)!) };
  };
  const ok = async (args: string[], options?: Parameters<typeof cli>[1]) => {
    const result = await cli(args, options);
    assert.equal(result.code, 0, JSON.stringify(result.body));
    return result.body;
  };
  /** A project Task below `parent`, with its own code location on this PC when `cwd` is given. */
  const newProject = async (title: string, parent: string, cwd?: string) => (await ok(['task', 'new', '--kind', 'project', '--color', '#39659b',
    '--title', title, '--parent', parent, ...(cwd === undefined ? [] : ['--cwd', cwd])])).task;
  const hash = async (id: string): Promise<string> => (await ok(['task', 'get', '--task', id])).task.hash;
  return { base, root, project, server, cli, ok, newProject, hash };
}
function place(root: string, taskId: string) {
  const placements = new PlacementStore(root);
  try { return placements.place({ taskId, agentId: placements.createAgent().id, profileKey: 'codex', responsible: true }); }
  finally { placements.close(); }
}
/** A running Run `id` on `task`, kept alive for serve by its manager's lock, taken before the Run runs. */
function startRun(t: TestContext, root: string, id: string, task: string, placementId: string, role: 'owner' | 'worker') {
  mkdirSync(runFolder(root, id), { recursive: true, mode: 0o700 });
  const lock = openSync(join(runFolder(root, id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(lock), true);
  t.after(() => { unlock(lock); closeSync(lock); });
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    const run = store.write(tx => {
      const record = createFixtureRun(store, tx, { task, placementId, requestId: randomUUID(), agent: 'codex', role,
        resumes: null, continues: false, session: null, caller: null, cwd: root,
        launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'prompt');
      tx.update({ ...record, state: 'running', started_at: new Date().toISOString() });
      return record;
    });
    assert.equal(run.id, id);
    return run;
  } finally { store.close(); }
}

test('Task numbers are one sequence across projects, and each Task keeps its files in tasks/<T>', async t => {
  const h = await served(t);
  const mobile = await h.newProject('Mobile', 'P1');
  const first = (await h.ok(['task', 'new', '--title', 'In the test project', '--parent', h.project])).task;
  const second = (await h.ok(['task', 'new', '--title', 'In Mobile', '--parent', mobile.id])).task;
  assert.deepEqual([h.project, mobile.id, first.id, second.id], ['P2', 'P3', 'T4', 'T5']);
  assert.deepEqual([first.path, second.path], ['tasks/T4', 'tasks/T5']);
  const file = join(h.base, 'note.txt');
  writeFileSync(file, 'mobile note');
  await h.ok(['task', 'file', 'put', '--task', second.id, '--path', 'note.txt', '--file', file]);
  assert.equal(readFileSync(join(h.root, 'tasks', second.id, 'note.txt'), 'utf8'), 'mobile note');
  const got = (await h.ok(['task', 'get', '--task', second.id, '--files'])).task;
  assert.deepEqual([got.kind, got.projectId], ['task', mobile.id]);
  assert.equal(got.folder, new URL(taskFileRoute(second.id), h.server.url).href);
  assert.equal(await (await fetch(got.files[0].path)).text(), 'mobile note');
});

test('the tree keeps its shape: a project under a project or at the top, a task under its own project or its Tasks', async t => {
  const h = await served(t);
  const mobile = await h.newProject('Mobile', 'P1');
  const work = (await h.ok(['task', 'new', '--title', 'Work', '--parent', h.project])).task;
  const other = (await h.ok(['task', 'new', '--title', 'Other', '--parent', mobile.id])).task;
  // The commands refuse what the shape forbids, saying why.
  const refused = async (args: string[]) => {
    const result = await h.cli(args);
    assert.equal(result.code, 2, JSON.stringify(result.body));
    return result.body.error;
  };
  assert.match((await refused(['task', 'new', '--kind', 'project', '--color', '#39659b', '--title', 'Under a task', '--parent', work.id])).message,
    /A project's parent is a project/);
  assert.deepEqual((await refused(['task', 'new', '--title', 'A top task', '--parent', 'none'])).issues
    .map((issue: { path: string; code: string }) => [issue.path, issue.code]), [['parent', 'project_only']]);
  assert.match((await refused(['task', 'move', '--task', work.id, '--parent', other.id,
    '--expected-task-hash', work.hash])).message, new RegExp(`moves only within its project ${h.project}`));
  assert.match((await refused(['task', 'move', '--task', mobile.id, '--parent', h.project,
    '--expected-task-hash', mobile.hash])).message, /a project does not move/);
  // The database refuses the same, whoever writes.
  const reader = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true);
  let uuid: Record<string, string>;
  try {
    uuid = reader.read(db => Object.fromEntries(db.prepare('SELECT external_id, id FROM tasks').all()
      .map(row => [String(row.external_id), String(row.id)])));
  } finally { reader.close(); }
  const at = new Date().toISOString(), agent = `A${randomUUID()}`;
  const store = new ControlStore(h.root);
  try {
    store.write(db => db.prepare('INSERT INTO agents(id,created_at) VALUES (?,?)').run(agent, at));
    const attempts: Array<[string, string, string[], RegExp]> = [
      ['a task under another project\'s task', 'UPDATE tasks SET parent_id=? WHERE id=?', [uuid[other.id], uuid[work.id]],
        /task parent must be its project or a task of that project/],
      ['a task under another project', 'UPDATE tasks SET parent_id=? WHERE id=?', [uuid[mobile.id], uuid[work.id]],
        /task parent must be its project or a task of that project/],
      ['a task moving to another project', 'UPDATE tasks SET project_task_id=? WHERE id=?', [uuid[mobile.id], uuid[work.id]],
        /task kind and project are immutable/],
      ['a project that moves', 'UPDATE tasks SET parent_id=? WHERE id=?', [uuid[h.project], uuid[mobile.id]],
        /project parent is immutable/],
      ['a project under a task', `INSERT INTO tasks(id,kind,number,parent_id,title,lifecycle,base_state,hold,revision,created_at,updated_at)
        VALUES (?,'project',999,?,'Under a task','active','todo',0,1,?,?)`, [randomUUID(), uuid[work.id], at, at],
        /project parent must be a project/],
      ['a task without a project', `INSERT INTO tasks(id,kind,number,parent_id,title,lifecycle,base_state,hold,revision,created_at,updated_at)
        VALUES (?,'task',999,?,'Projectless','active','todo',0,1,?,?)`, [randomUUID(), uuid[work.id], at, at],
        /task project must be a project/],
      ['a placement on a project', `INSERT INTO placements(id,task_id,agent_id,profile_key,responsible,revision,started_at)
        VALUES (?,?,?,'codex',1,1,?)`, [`P${randomUUID()}`, mobile.id, agent, at], /a project has no placements/],
    ];
    for (const [name, sql, values, refusal] of attempts)
      assert.throws(() => store.write(db => db.prepare(sql).run(...values)), refusal, name);
  } finally { store.close(); }
});

test('a Task created without a parent goes under the project whose own code location holds cwd, the deepest; a tie or none asks for --parent', async t => {
  const h = await served(t);
  const codeA = join(h.base, 'code-a'), codeB = join(h.base, 'code-b');
  await h.ok(['task', 'update', '--task', h.project, '--cwd', codeA, '--expected-task-hash', await h.hash(h.project)]);
  const inner = await h.newProject('Inner', h.project, join(codeA, 'inner'));
  // A project below Inner that turns the location off claims nothing.
  await h.newProject('Off', inner.id, '');
  const parentFrom = async (cwd: string) => (await h.ok(['task', 'new', '--title', `From ${cwd}`], { cwd })).task.parentId;
  assert.equal(await parentFrom(join(codeA, 'inner', 'deeper')), inner.id, 'the deepest code location holding cwd wins');
  assert.equal(await parentFrom(codeA), h.project);
  // Several active projects and no code location holding cwd: nothing is guessed.
  const unclaimed = await h.cli(['task', 'new', '--title', 'Nowhere']);
  assert.deepEqual([unclaimed.code, unclaimed.body.error.code], [2, 'invalid_input']);
  assert.match(unclaimed.body.error.message, /--parent/);
  const twinA = await h.newProject('Twin A', 'P1', codeB), twinB = await h.newProject('Twin B', 'P1', codeB);
  const tie = await h.cli(['task', 'new', '--title', 'Twin'], { cwd: codeB });
  assert.equal(tie.code, 2);
  assert.match(tie.body.error.message, /share this code location/);
  for (const twin of [twinA, twinB]) assert.match(tie.body.error.message, new RegExp(`\\b${twin.id}\\b`));
});

test('with one active project, a Task created without a parent goes under it', async t => {
  const h = await served(t);
  await h.ok(['task', 'archive', '--task', h.project, '--expected-task-hash', await h.hash(h.project)]);
  assert.equal((await h.ok(['task', 'new', '--title', 'Anywhere'])).task.parentId, 'P1');
});

test('a Run works in its own project: it reads and lists that project\'s Tasks, and another project\'s are refused', async t => {
  const h = await served(t);
  const mobile = await h.newProject('Mobile', 'P1');
  const local = (await h.ok(['task', 'new', '--title', 'Test project work', '--parent', h.project])).task;
  const task = (await h.ok(['task', 'new', '--title', 'Mobile work', '--parent', mobile.id])).task;
  const run = startRun(t, h.root, 'R1', task.id, place(h.root, task.id).id, 'owner');
  const env = { ALPACAWORK_RUN: run.id, ALPACAWORK_RUN_TOKEN: issueRunCredential(h.root, run.id) };
  assert.equal((await h.ok(['task', 'get', '--task', task.id], { env })).task.title, 'Mobile work');
  const refused = await h.cli(['task', 'get', '--task', local.id], { env });
  assert.deepEqual([refused.code, refused.body.error.code], [2, 'forbidden']);
  const listed = (await h.ok(['task', 'list'], { env })).tasks.map((item: { id: string }) => item.id);
  assert.equal(listed.includes(task.id), true);
  assert.equal(listed.includes(local.id), false, 'a Run lists its own project alone');
  const project = await h.cli(['task', 'new', '--kind', 'project', '--color', '#39659b', '--title', 'From a Run', '--parent', 'P1'], { env });
  assert.deepEqual([project.code, project.body.error.code], [2, 'forbidden'], 'a Run creates no project');
});

test('task list --kind project lists the project Tasks; --kind task keeps the projects above each Task as its path', async t => {
  const h = await served(t);
  const mobile = await h.newProject('Mobile', 'P1'), nested = await h.newProject('Nested', mobile.id);
  const work = (await h.ok(['task', 'new', '--title', 'Work', '--parent', nested.id])).task;
  const rows = async (kind: string) => (await h.ok(['task', 'list', '--kind', kind])).tasks
    .map((task: { id: string; kind: string; parentId: string | null }) => [task.id, task.kind, task.parentId]);
  assert.deepEqual(await rows('project'), [['P1', 'project', null], [h.project, 'project', 'P1'], [mobile.id, 'project', 'P1'],
    [nested.id, 'project', mobile.id]]);
  assert.deepEqual(await rows('task'), [['P1', 'project', null], [mobile.id, 'project', 'P1'], [nested.id, 'project', mobile.id],
    [work.id, 'task', nested.id]]);
});

test('task list includes a summary on the project that owns it, in both project and mixed lists', async t => {
  const h = await served(t);
  const summary = 'Issues and releases for the mobile apps.';
  const file = join(h.base, 'summary.json');
  writeFileSync(file, JSON.stringify({ project_summary: summary }));
  const mobile = (await h.ok(['task', 'new', '--kind', 'project', '--title', 'Mobile', '--parent', 'P1',
    '--color', '#39659b', '--values-file', file])).task;
  const work = (await h.ok(['task', 'new', '--title', 'Work', '--parent', mobile.id])).task;
  for (const args of [[], ['--kind', 'project'], ['--kind', 'task']]) {
    const { tasks } = await h.ok(['task', 'list', ...args]);
    assert.deepEqual(tasks.filter((row: object) => Object.hasOwn(row, 'summary'))
      .map((row: { id: string; summary: string }) => [row.id, row.summary]), [[mobile.id, summary]]);
    if (!args.length) assert.ok(tasks.some((row: { id: string }) => row.id === work.id));
  }
});

test('a folder\'s folders are listed by name for choosing a project\'s code location: no files, hidden ones on request', async t => {
  const h = await served(t);
  const code = join(h.base, 'code');
  for (const name of ['web', 'api', '.cache', 'app-10', 'app-9']) mkdirSync(join(code, name), { recursive: true });
  writeFileSync(join(code, 'README.md'), 'not listed');
  const list = async (query: string) => {
    const response = await fetch(new URL(`/api/workspace/folders?${query}`, h.server.url));
    return { status: response.status, body: await response.json() };
  };
  const listed = (await list(`path=${encodeURIComponent(code)}`)).body;
  assert.deepEqual([listed.path, listed.parent, listed.folders, listed.truncated], [code, h.base, ['api', 'app-9', 'app-10', 'web'], false]);
  assert.deepEqual((await list(`path=${encodeURIComponent(code)}&hidden=true`)).body.folders, ['.cache', 'api', 'app-9', 'app-10', 'web']);
  assert.equal((await list('path=%2F')).body.parent, null);
  // Left out, it starts where the newest active project's own code location is kept.
  await h.newProject('Web', 'P1', join(code, 'web'));
  assert.equal((await list('')).body.path, realpathSync(code));
  const reason = async (query: string) => (await list(query)).body.error.issues.map((issue: { path: string; code: string }) => [issue.path, issue.code]);
  assert.deepEqual(await reason('path=code'), [['path', 'absolute_path']]);
  assert.deepEqual(await reason(`path=${encodeURIComponent(join(code, 'none'))}`), [['path', 'missing_directory']]);
  assert.deepEqual(await reason(`path=${encodeURIComponent(join(code, 'README.md'))}`), [['path', 'not_directory']]);
  // ~ is home; a link to a folder is a folder, a link to a file or to nothing is not.
  assert.equal((await list('path=~')).body.path, homedir());
  assert.equal((await list('path=~%2F')).body.path, homedir());
  symlinkSync(join(code, 'web'), join(code, 'linked'));
  symlinkSync(join(code, 'README.md'), join(code, 'to-file'));
  symlinkSync(join(code, 'gone'), join(code, 'broken'));
  assert.deepEqual((await list(`path=${encodeURIComponent(code)}`)).body.folders, ['api', 'app-9', 'app-10', 'linked', 'web']);
  // A typed start narrows before the cut, so a name past the first 500 is found.
  const many = join(h.base, 'many');
  for (let at = 0; at < 510; at++) mkdirSync(join(many, `d${String(at).padStart(3, '0')}`), { recursive: true });
  const all = (await list(`path=${encodeURIComponent(many)}`)).body;
  assert.deepEqual([all.folders.length, all.truncated, all.folders.includes('d505')], [500, true, false]);
  assert.deepEqual((await list(`path=${encodeURIComponent(many)}&prefix=D50`)).body.folders,
    ['d500', 'd501', 'd502', 'd503', 'd504', 'd505', 'd506', 'd507', 'd508', 'd509']);
  // The newest active project's folder is where looking starts; an archived project's is not.
  const newest = await h.newProject('Many', 'P1', join(many, 'd000'));
  assert.equal((await list('')).body.path, realpathSync(many));
  await h.ok(['task', 'archive', '--task', newest.id, '--expected-task-hash', newest.hash]);
  assert.equal((await list('')).body.path, realpathSync(code));
  if (process.getuid?.() !== 0) {
    mkdirSync(join(code, 'closed'));
    chmodSync(join(code, 'closed'), 0o000);
    try { assert.deepEqual(await reason(`path=${encodeURIComponent(join(code, 'closed'))}`), [['path', 'unreadable_directory']]); }
    finally { chmodSync(join(code, 'closed'), 0o755); }
  }
});

test('with no project\'s code location on this PC, looking for a folder starts at home', async t => {
  const h = await served(t);
  assert.equal((await (await fetch(new URL('/api/workspace/folders', h.server.url))).json()).path, homedir());
});

test('a project\'s code location is saved trimmed and real, spaces alone turn it off, and a wrong one is named at cwd and leaves no project', async t => {
  const h = await served(t);
  mkdirSync(join(h.base, 'code'));
  const location = async (cwd: string) => {
    const { id } = await h.newProject('Located', 'P1', cwd);
    return projectLocations(h.root)[id];
  };
  assert.equal(await location(` ${join(h.base, 'code')} `), realpathSync(join(h.base, 'code')));
  assert.equal(await location('  '), '');
  // ~ is home, as the screen's folder field writes it.
  assert.equal(await location('~'), realpathSync(homedir()));
  const projects = async () => (await h.ok(['task', 'list', '--kind', 'project'])).tasks.length;
  const before = await projects();
  const issues = async (...args: string[]) => (await h.cli(['task', 'new', '--title', 'Code', ...args])).body.error.issues
    .map((issue: { path: string; code: string }) => [issue.path, issue.code]);
  const project = ['--kind', 'project', '--color', '#39659b', '--parent', 'P1'];
  assert.deepEqual(await issues(...project, '--cwd', 'code'), [['cwd', 'absolute_path']]);
  assert.deepEqual(await issues(...project, '--cwd', '/no/such/folder'), [['cwd', 'missing_directory']]);
  writeFileSync(join(h.base, 'a-file'), '');
  assert.deepEqual(await issues(...project, '--cwd', join(h.base, 'a-file')), [['cwd', 'not_directory']]);
  mkdirSync(join(h.root, 'inside'));
  assert.deepEqual(await issues(...project, '--cwd', join(h.root, 'inside')), [['cwd', 'inside_workspace']]);
  assert.equal(await projects(), before, 'a refused code location leaves no project');
  assert.deepEqual(await issues('--parent', h.project, '--cwd', join(h.base, 'code')), [['cwd', 'project_only']]);
});

test('a code location saved alone stays out of the project Task\'s revision: config.yaml holds it, the last save wins', async t => {
  const h = await served(t);
  const codeA = join(h.base, 'code-a'), codeB = join(h.base, 'code-b');
  const before = await h.hash(h.project);
  const saved = (await h.ok(['task', 'update', '--task', h.project, '--cwd', codeA, '--expected-task-hash', before])).task;
  assert.deepEqual([saved.version, saved.hash], [1, before], 'no record is written, so the Task\'s revision stays');
  assert.equal(projectLocations(h.root)[h.project], codeA);
  // The Task's hash still holds; config.yaml checks its own bytes when it is written, so the later save replaces it.
  const again = await h.ok(['task', 'update', '--task', h.project, '--cwd', codeB, '--expected-task-hash', before]);
  assert.equal(again.task.hash, before);
  assert.equal(projectLocations(h.root)[h.project], codeB);
});

test('a project\'s code location that config.yaml cannot take leaves neither the project nor a committed receipt', async t => {
  const h = await served(t);
  writeFileSync(join(h.root, 'config.yaml'), 'bad: [');
  const opId = randomUUID();
  const refused = await h.cli(['task', 'new', '--kind', 'project', '--color', '#39659b', '--title', 'Mobile', '--parent', 'P1',
    '--cwd', join(h.base, 'code-b'), '--op-id', opId]);
  assert.notEqual(refused.code, 0);
  const receipt = await (await fetch(new URL(`/api/operation/get?opId=${opId}`, h.server.url),
    { headers: { 'X-Alpacawork-Client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT) } })).json();
  assert.deepEqual(receipt, { state: 'not_found' });
  const store = new ControlStore(h.root, { busyTimeoutMs: 1000 }, true);
  try { assert.equal(store.read(db => db.prepare("SELECT count(*) AS n FROM tasks WHERE title='Mobile'").get()!.n), 0); }
  finally { store.close(); }
});

// The only writer of config.yaml's projects section, at each durable publication boundary.
for (const phase of ['staged', 'reserved', 'renamed', 'receipted'] as const) {
  test(`a project's code location recovers an interruption at ${phase} with one exact receipt`, async t => {
    const { base, root, project } = workspace(t);
    const code = join(base, 'code-b'), opId = randomUUID(), journal = new FileJournal(root);
    const putConfig = FileJournal.prototype.putConfig;
    const interrupted = t.mock.method(FileJournal.prototype, 'putConfig', function (this: { root: string }, input: unknown) {
      return putConfig.call(new FileJournal(this.root, (at: string) => {
        if (at === phase) throw new Error('simulated interruption');
      }), input);
    });
    await assert.rejects(writeProjectLocation(root, project, code, opId), /simulated interruption/);
    interrupted.mock.restore();
    const committed = phase === 'receipted', prepared = phase === 'reserved' || phase === 'renamed';
    assert.equal(journal.operationGet(opId).state, committed ? 'committed' : prepared ? 'pending' : 'not_found');
    if (prepared) {
      await assert.rejects(writeProjectLocation(root, project, code, opId), { code: 'publication_pending' });
      await assert.rejects(writeProjectLocation(root, project, '', randomUUID()), { code: 'busy' });
      const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
      try { assert.throws(() => store.read(db => launchCwd(root, db, project)), { code: 'busy' }); }
      finally { store.close(); }
    }
    assert.deepEqual(journal.recover(), { published: prepared ? 1 : 0, needsReview: 0 });
    const saved = await writeProjectLocation(root, project, code, opId);
    assert.deepEqual(saved, { task: project, cwd: code });
    assert.deepEqual(journal.operationGet(opId), { state: 'committed', status: 200, body: saved });
    await writeProjectLocation(root, project, '', randomUUID());
    assert.deepEqual(await writeProjectLocation(root, project, code, opId), saved, 'replay returns the accepted receipt after later edits');
    assert.equal(projectLocations(root)[project], '');
  });
}

test('the CLI reads a code location\'s operation as pending until it is published, then as its one receipt', async t => {
  const { base, root, project, servers } = workspace(t);
  const server = await startServer(root, 0);
  servers.push(server);
  const code = join(base, 'code-b'), opId = randomUUID();
  const putConfig = FileJournal.prototype.putConfig;
  const interrupted = t.mock.method(FileJournal.prototype, 'putConfig', function (this: { root: string }, input: unknown) {
    return putConfig.call(new FileJournal(this.root, (at: string) => {
      if (at === 'reserved') throw new Error('simulated interruption');
    }), input);
  });
  await assert.rejects(writeProjectLocation(root, project, code, opId), /simulated interruption/);
  interrupted.mock.restore();
  const get = async () => {
    const response = await fetch(new URL(`/api/operation/get?opId=${opId}`, server.url),
      { headers: { 'X-Alpacawork-Client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT), 'X-Alpacawork-Cwd': encodeURIComponent(code) } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  assert.deepEqual(await get(), { state: 'pending' });
  assert.equal(new FileJournal(root).recover().published, 1);
  const saved = await writeProjectLocation(root, project, code, opId);
  assert.deepEqual(await get(), { state: 'committed', status: 200, body: saved });
});

test('a new conversation starts at --cwd, else the code location its project inherits on this PC, else the data directory; \'\' turns it off', async t => {
  const { base, root, project } = workspace(t);
  const codeA = join(base, 'code-a'), codeB = join(base, 'code-b');
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const projectBelow = async (title: string, parentId: string): Promise<string> =>
    (await commands.create({ kind: 'project', color: '#39659b', parentId, userRequested: null, tasks: [{ title }] })).tasks[0].id;
  const mobile = await projectBelow('Mobile', 'P1');
  const nested = await projectBelow('Nested', mobile), off = await projectBelow('Off', mobile);
  await writeProjectLocation(root, mobile, codeB, randomUUID());
  await writeProjectLocation(root, off, '', randomUUID());
  const start = async (parentId: string, cwd?: string) => {
    const task = (await commands.create({ parentId, userRequested: false, tasks: [{ title: `Work in ${parentId}` }] })).tasks[0];
    const receipt = await new RequestService(root).request({ taskId: task.id, body: 'Start', requestId: randomUUID(),
      expectedTaskHash: task.hash, expectedPlacementRevision: place(root, task.id).revision, ...(cwd ? { cwd } : {}) },
    { purpose: 'instruction', actor: { kind: 'human' } });
    const store = new RunStore(root, { busyTimeoutMs: 0 });
    try { return store.get(receipt.runId)!.cwd; } finally { store.close(); }
  };
  assert.equal(await start(mobile), codeB);
  assert.equal(await start(nested), codeB, 'a project without its own location inherits its parent project\'s');
  assert.equal(await start(off), root, '\'\' turns the inherited location off: the data directory');
  assert.equal(await start(project), root, 'no project above sets one');
  assert.equal(await start(mobile, codeA), codeA);
  rmSync(codeB, { recursive: true });
  await assert.rejects(start(nested), new RegExp(`config.yaml projects.${mobile}.cwd|existing directory`));
});

test('an accepted request replays after its project\'s code location changes', async t => {
  const { base, root, project } = workspace(t);
  const codeA = join(base, 'code-a'), codeB = join(base, 'code-b');
  await writeProjectLocation(root, project, codeA, randomUUID());
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: false, tasks: [{ title: 'Work' }] })).tasks[0];
  const service = new RequestService(root), human = { purpose: 'instruction', actor: { kind: 'human' } } as const;
  const input = { taskId: task.id, body: 'Start', requestId: randomUUID(), expectedTaskHash: task.hash,
    expectedPlacementRevision: place(root, task.id).revision };
  const accepted = await service.request(input, human);
  assert.deepEqual(await service.request(input, human), accepted);
  await writeProjectLocation(root, project, codeB, randomUUID());
  assert.deepEqual(await service.request(input, human), accepted);
  await assert.rejects(service.request({ ...input, cwd: codeB }, human), { code: 'idempotency_conflict' });
  await writeProjectLocation(root, project, '', randomUUID());
  rmSync(codeA, { recursive: true });
  assert.deepEqual(await service.request(input, human), accepted);
});

test('a project\'s policy is saved whole over the CLI however long, under projects that have their own', async t => {
  const h = await served(t);
  const save = async (id: string, policy: string) => {
    const file = join(h.base, `${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ project_policy: policy }));
    return h.cli(['task', 'update', '--task', id, '--values-file', file, '--expected-task-hash', await h.hash(id)]);
  };
  const mobile = await h.newProject('Mobile', 'P1'), nested = await h.newProject('Nested', mobile.id);
  const long = `## Purpose\n${'Keep the books right. '.repeat(1000)}`;
  assert.equal((await save(nested.id, 'Nested rules')).code, 0);
  assert.equal((await save(mobile.id, long)).code, 0);
  assert.deepEqual((await h.ok(['task', 'get', '--task', mobile.id])).task.values, { project_policy: long.trim() });
});

test('archiving a project keeps everything below it, and is refused while anything below is at work', async t => {
  const h = await served(t);
  const codeB = join(h.base, 'code-b');
  const mobile = await h.newProject('Mobile', 'P1', codeB);
  const kept = (await h.ok(['task', 'new', '--title', 'Kept', '--parent', mobile.id])).task;
  const busy = (await h.ok(['task', 'new', '--title', 'Busy', '--parent', h.project])).task;
  startRun(t, h.root, 'R1', busy.id, `P${randomUUID()}`, 'worker');
  const refused = await h.cli(['task', 'archive', '--task', h.project, '--expected-task-hash', await h.hash(h.project)]);
  assert.deepEqual([refused.code, refused.body.error.code], [2, 'conflict']);
  const archived = (await h.ok(['task', 'archive', '--task', mobile.id, '--expected-task-hash', await h.hash(mobile.id)])).task;
  assert.equal(archived.lifecycle, 'archived');
  const below = (await h.ok(['task', 'get', '--task', kept.id])).task;
  assert.deepEqual([below.lifecycle, below.projectId], ['active', mobile.id]);
  // An archived project's code location places no Task; restored, it does again.
  assert.equal((await h.cli(['task', 'new', '--title', 'Here'], { cwd: codeB })).code, 2);
  await h.ok(['task', 'restore', '--task', mobile.id, '--expected-task-hash', await h.hash(mobile.id)]);
  assert.equal((await h.ok(['task', 'new', '--title', 'Here'], { cwd: codeB })).task.parentId, mobile.id);
});

test('project color is mandatory lowercase #rrggbb in CLI/API; tasks reject color', async t => {
  const h = await served(t);
  const base = ['task', 'new', '--kind', 'project', '--title', 'Color contract', '--parent', 'P1'];
  const missing = await h.cli(base);
  assert.notEqual(missing.code, 0);
  assert.match(JSON.stringify(missing.body), /color/);
  // The CLI and HTTP share one entry rule (entries.ts), so the values go over HTTP below.
  const badColor = await h.cli([...base, '--color', '#ABCDEF']);
  assert.notEqual(badColor.code, 0);
  assert.match(JSON.stringify(badColor.body), /#rrggbb/);
  const request = async (path: string, body: unknown) => fetch(new URL(`/api/${path}`, h.server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Client': 'cli', [CONTRACT_HEADER]: String(CLI_CONTRACT) }, body: JSON.stringify(body) });
  for (const color of [undefined, null, '#ABCDEF', '#abc', 'navy', '#12345g', '#1234567', ' #123456']) {
    const response = await request('task/new', { kind: 'project', title: 'API color', parent: 'P1', color });
    assert.equal(response.status, 400, await response.clone().text());
  }
  const made = await h.ok([...base, '--color', '#000000']);
  assert.deepEqual(made.task.settings, { color: '#000000' });
  const task = (await h.ok(['task', 'new', '--title', 'Work', '--parent', h.project])).task;
  assert.equal('settings' in task, false);
  for (const args of [
    ['task', 'new', '--title', 'Wrong color', '--parent', h.project, '--color', '#123456'],
    ['task', 'update', '--task', task.id, '--expected-task-hash', task.hash, '--color', '#123456'],
  ]) {
    const result = await h.cli(args);
    assert.notEqual(result.code, 0);
    assert.match(JSON.stringify(result.body), /[Oo]nly a project/);
  }
  const invalidUpdate = await request('task/update', { task: made.task.id, expectedTaskHash: made.task.hash, color: '#ABCDEF' });
  assert.equal(invalidUpdate.status, 400);
  assert.match(await invalidUpdate.text(), /#rrggbb/);
});

test('project field updates preserve color; one Task save plus local cwd refreshes the index', async t => {
  const h = await served(t);
  const parent = await h.newProject('Color parent', 'P1', join(h.base, 'code-a'));
  const child = await h.newProject('Color child', parent.id);
  const get = async (id: string) => (await h.ok(['task', 'get', '--task', id, '--log', '100'])).task;
  const index = async () => {
    const response = await fetch(new URL('/api/workspace/live', h.server.url));
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await index();
  assert.deepEqual(initial.projects.find((p: { id: string }) => p.id === child.id).cwd, null, 'own cwd only, no inherited location');
  const before = await get(parent.id);
  const valuesPath = join(h.base, 'project-values.json');
  writeFileSync(valuesPath, JSON.stringify({ project_policy: 'Color survives every update' }));
  const updated = (await h.ok(['task', 'update', '--task', parent.id, '--expected-task-hash', before.hash,
    '--title', 'Changed together', '--values-file', valuesPath, '--cwd', join(h.base, 'code-b'),
    '--color', '#abcdef'])).task;
  assert.equal(updated.version, parent.version + 1, 'title, values and settings advance one revision');
  assert.deepEqual(updated.settings, { color: '#abcdef' });
  assert.deepEqual(currentTaskLog(h.root,parent.id).at(-1).changedFields, ['values', 'color']);
  const after = await index();
  assert.ok(after.rev > initial.rev);
  assert.deepEqual(after.projects.find((p: { id: string }) => p.id === parent.id), {
    ...initial.projects.find((p: { id: string }) => p.id === parent.id), title: 'Changed together', color: '#abcdef', cwd: join(h.base, 'code-b') });
  assert.equal(after.projects.find((p: { id: string }) => p.id === child.id).color, '#39659b', 'nested projects own their color');
  const commands = new ControlTaskCommands(h.root, { kind: 'human' });
  const update = async (id: string, fields: { title?: string; color?: string; values?: object }) => commands.update({ ...fields, id, expectedTaskHash: await h.hash(id) });
  await update(child.id, { values: { project_policy: 'Child goal' } });
  assert.deepEqual((await get(child.id)).settings, { color: '#39659b' }, 'a values write keeps the color');
  await update(parent.id, { color: '#ffffff' });
  assert.deepEqual((await get(parent.id)).values, { project_policy: 'Color survives every update' }, 'color-only update keeps the values');
  await update(parent.id, { title: 'Title only' });
  assert.deepEqual((await get(parent.id)).settings, { color: '#ffffff' });
  const located = await index(), hash = await h.hash(parent.id);
  await h.ok(['task', 'update', '--task', parent.id, '--expected-task-hash', hash, '--cwd', join(h.base, 'code-a')]);
  const relocated = await index();
  assert.equal(await h.hash(parent.id), hash, 'cwd-only write leaves Task revision alone');
  assert.ok(relocated.rev > located.rev, 'config.yaml changed the index read marker');
  assert.equal(relocated.projects.find((p: { id: string }) => p.id === parent.id).cwd, join(h.base, 'code-a'));
});


test('workspace init persists the first project color #39659b', async t => {
  const { base } = workspace(t);
  const root = join(base, 'new-workspace');
  mkdirSync(root, { mode: 0o700 });
  const initialized = await initializeWorkspace(root);
  assert.equal(initialized.initializedProject.id, 'P1');
  assert.deepEqual((await new ControlTaskStore(root).get('P1')).settings, { color: '#39659b' });
});
