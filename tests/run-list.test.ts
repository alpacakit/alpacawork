/** run list: unfinished Runs only, whatever their Task's state, within the caller's read scope, a page at a time. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLock, unlock } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { RUN_FILES, runFolder, type RunRecord } from '@alpacawork/contract/run';
import { commandCatalog } from '@alpacawork/contract/commands';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { taskCommands } from '@alpacawork/backend/test-dist/entries.js';
import { inspectExecution } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { initializeControlFixture, seedFixtureTask } from './helpers/control-fixture.ts';
import { createFixtureRun } from './helpers/run-fixture.ts';
import { cleanCliEnv } from './helpers/http-cli.ts';

const human = { kind: 'human' } as const;
const spec = commandCatalog.commands.find(command => command.id === 'run/list')!;
type Seed = { task: string; state: RunRecord['state']; reason?: RunRecord['reason']; caller?: string; role?: 'owner' | 'worker'; placementId?: string };

async function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-list-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'config.yaml'), 'agents: {}\n');
  const project = initializeControlFixture(root);
  const commands = new ControlTaskCommands(root, human);
  const create = async (parentId: string, title: string, kind?: 'project') => kind
    ? (await commands.create({ parentId, userRequested: false, kind, color: '#39659b', tasks: [{ title }] } as never)).tasks[0]!.id
    : seedFixtureTask(root, parentId, title).id;
  /** Seeds Runs as their records stand, in order; a running one optionally with its manager alive (`live`). */
  const seed = (runs: Seed[]) => {
    const store = new RunStore(root, { busyTimeoutMs: 1_000 });
    try {
      return runs.map(({ task, state, reason = null, caller, role = 'owner', placementId = `P-${task}-${role}` }) => store.write(tx => {
        const run = createFixtureRun(store, tx, { requestId: crypto.randomUUID(), task, placementId, agent: 'claude', role,
          resumes: null, continues: false, session: null, caller: caller ? { run: caller as RunRecord['id'] } : null, cwd: root,
          launch: { adapter: 'codex', env: [], argv: ['NEVER-EXECUTE'], path: '/bin', values: {} } }, 'Prompt');
        const at = new Date().toISOString();
        if (state !== 'queued') tx.update({ ...run, state: 'running', started_at: at });
        if (state !== 'queued' && state !== 'running') tx.update({ ...tx.get(run.id)!, state, reason, ended_at: state === 'needs_review' ? null : at });
        return run.id;
      }));
    } finally { store.close(); }
  };
  return { root, project, create, seed };
}

const list = (root: string, input: Record<string, unknown>, caller: object = human) =>
  taskCommands['run/list'].run(root, spec.schema.parse(input), { caller: () => caller } as never) as Promise<{
    observedAt: string; scope: { project: string | null; under: string | null; coordinatorRuns: boolean };
    runs: { id: string; task: string | null; project: string | null; state: string; reason: string | null; parentRun: string | null }[];
    errors: unknown[]; omitted?: number; cursor?: string }>;

test('run list returns every unfinished Run, whatever its Task state, with its parent Run, and the update sees the same Runs', async t => {
  const w = await workspace(t);
  const todo = await w.create(w.project, 'Never started'), parent = await w.create(w.project, 'Parent');
  const child = await w.create(parent, 'Child'), review = await w.create(w.project, 'Review'), done = await w.create(w.project, 'Done');
  const [queued, running] = w.seed([{ task: todo, state: 'queued' }, { task: parent, state: 'running' }]);
  const [below, needsReview, ended] = w.seed([{ task: child, state: 'running', caller: running }, { task: review, state: 'needs_review', reason: 'manager_lost' },
    { task: done, state: 'cancelled', reason: 'stopped' }, { task: child, state: 'running', role: 'worker' }]);

  const all = await list(w.root, {});
  assert.deepEqual(all.scope, { project: null, under: null, coordinatorRuns: true });
  assert.deepEqual(all.errors, []);
  assert.equal(all.runs.some(run => run.id === ended), false, 'an ended Run is not listed');
  assert.deepEqual(all.runs.slice(0, 4).map(run => [run.id, run.task, run.state]),
    [[queued, todo, 'queued'], [running, parent, 'running'], [below, child, 'running'], [needsReview, review, 'needs_review']]);
  assert.equal(all.runs[3]!.reason, 'manager_lost');
  assert.equal(all.runs.length, 5, 'a member Run beside the owner Run is listed too');
  assert.ok(all.runs.every(run => run.project === w.project));
  const store = new RunStore(w.root, { busyTimeoutMs: 1_000 });
  try { assert.deepEqual(inspectExecution(store).unfinishedRuns, all.runs.map(run => run.id), 'the update waits for exactly these Runs'); }
  finally { store.close(); }

  const subtree = await list(w.root, { under: parent });
  assert.deepEqual(subtree.scope, { project: null, under: parent, coordinatorRuns: false });
  assert.deepEqual(subtree.runs.map(run => [run.id, run.parentRun]).slice(0, 2), [[running, null], [below, running]]);
  assert.equal(subtree.runs.length, 3);
});

test('run list pages in Run-number order and refuses a cursor from another scope', async t => {
  const w = await workspace(t);
  const task = await w.create(w.project, 'Work'), other = await w.create(w.project, 'Other');
  const ids = w.seed([{ task, state: 'queued' }, { task: other, state: 'running' }, { task, state: 'needs_review' }]);
  const first = await list(w.root, { limit: 2 });
  assert.deepEqual(first.runs.map(run => run.id), ids.slice(0, 2));
  assert.equal(first.omitted, 1);
  const next = await list(w.root, { limit: 2, cursor: first.cursor });
  assert.deepEqual(next.runs.map(run => run.id), ids.slice(2));
  assert.equal(next.cursor, undefined);
  await assert.rejects(list(w.root, { under: task, cursor: first.cursor }), { code: 'invalid_input' });
});

test('a Run lists only its own project, and an unreadable Run is an error rather than an empty list', async t => {
  const w = await workspace(t);
  const mine = await w.create(w.project, 'Mine');
  const elsewhere = await w.create('P1', 'Elsewhere', 'project'), theirs = await w.create(elsewhere, 'Theirs');
  const [own, foreign] = w.seed([{ task: mine, state: 'running' }, { task: theirs, state: 'running' }]);
  const caller = { kind: 'run', runId: own, placementId: `P-${mine}-owner`, taskId: mine, role: 'owner', responsible: true };
  const scoped = await list(w.root, {}, caller);
  assert.deepEqual(scoped.scope, { project: w.project, under: null, coordinatorRuns: false });
  assert.deepEqual(scoped.runs.map(run => run.id), [own]);
  assert.equal((await list(w.root, {})).runs.some(run => run.id === foreign), true);
  await assert.rejects(list(w.root, { under: theirs }, caller), { code: 'not_found' });

  const store = new RunStore(w.root, { busyTimeoutMs: 1_000 });
  try { store.connection.prepare("UPDATE runs SET record = json_set(record, '$.launch', NULL) WHERE id = ?").run(Number(foreign!.slice(1))); }
  finally { store.close(); }
  await assert.rejects(list(w.root, {}), { code: 'runs_unavailable' });
});

test('the CLI reads run list from the server, as a person and as a Run', async t => {
  const w = await workspace(t);
  const task = await w.create(w.project, 'Work');
  const people = new PlacementStore(w.root);
  const { placement } = people.createAndPlace({ taskId: task, profileKey: 'claude', responsible: true });
  people.close();
  const [run] = w.seed([{ task, state: 'running', placementId: placement.id }]);
  mkdirSync(runFolder(w.root, run!), { recursive: true, mode: 0o700 });
  const lock = openSync(join(runFolder(w.root, run!), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
  assert.equal(tryLock(lock), true);
  const server = await startServer(w.root, 0);
  const cli = async (env: Record<string, string>) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../apps/cli/dist/cli.js', import.meta.url)), '--server', server.url, 'run', 'list'],
      { env: { ...cleanCliEnv(), ...env } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, stderr);
    return spec.output.parse(JSON.parse(stdout)) as Awaited<ReturnType<typeof list>>;
  };
  const person = await cli({});
  assert.deepEqual(person.runs.map(item => item.id), [run]);
  const asRun = await cli({ ALPACAWORK_RUN: run!, ALPACAWORK_RUN_TOKEN: issueRunCredential(w.root, run!) });
  assert.equal(asRun.scope.project, w.project);
  await server.close(); unlock(lock); closeSync(lock);
});
