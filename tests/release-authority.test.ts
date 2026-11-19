import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
/** Who may release from the local CLI: a person, or the responsible Run of a Task (decided on its own Task); never a worker. */
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Problem } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { requireAdmin, requireLocal } from '@alpacawork/backend/test-dist/entries.js';

const human = { kind: 'human' } as const;

function runningRun(root: string, taskId: string, placementId: string, role: 'owner' | 'worker') {
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    return store.write(tx => {
      const created = createFixtureRun(store, tx, { task: taskId, placementId, requestId: randomUUID(),
        agent: 'zeta', role, resumes: null, continues: false, session: null, caller: null, cwd: root,
        launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: {} } }, 'prompt');
      tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
      return created;
    });
  } finally { store.close(); }
}

/** A Task with its responsible's Run and a worker's Run, both running. */
async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-release-authority-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { "zeta": fixtureAgentSetting('codex') } }));
  const task = (await new ControlTaskCommands(root, human).create({ parentId: project, userRequested: true,
    tasks: [{ title: 'Release' }] })).tasks[0]!;
  const current = async () => new ControlTaskStore(root).get(task.id);
  const placements = new PlacementCommands(root);
  const owner = (await placements.placeNewResponsible({ taskId: task.id, profileKey: 'zeta',
    expectedTaskHash: (await current()).hash }, human)).placement;
  const worker = (await placements.placeMember({ taskId: task.id, profileKey: 'zeta',
    expectedTaskHash: (await current()).hash, expectedResponsibleRevision: owner.revision }, human)).placement;
  const ownerRun = runningRun(root, task.id, owner.id, 'owner'), workerRun = runningRun(root, task.id, worker.id, 'worker');
  /** The local CLI's context, as the backend executable gives it, with a Run's credential in its environment. */
  const as = (runId: string | null, token = runId === null ? '' : issueRunCredential(root, runId)) => ({ root,
    cli: { cwd: root, env: runId === null ? {} : { ALPACAWORK_RUN: runId, ALPACAWORK_RUN_TOKEN: token } } });
  return { root, task, current, ownerRun, workerRun, as };
}
const refused = (call: () => void, reason: string) => assert.throws(call, (error: unknown) =>
  error instanceof Problem && error.code === 'forbidden' && (error.reason as { kind: string }).kind === reason);
const release = { name: 'release' } as const;

test('a person and the Task responsible\'s Run release; the worker\'s Run and a forged credential are refused', async t => {
  const h = await setup(t);
  requireLocal(h.as(null), release, () => { throw new Error('a person\'s release reads no workspace'); });
  requireLocal(h.as(h.ownerRun.id), release, () => h.root);
  refused(() => requireLocal(h.as(h.workerRun.id), release, () => h.root), 'authorization_required');
  refused(() => requireLocal(h.as(h.ownerRun.id, '0'.repeat(64)), release, () => h.root), 'run_credential_missing_or_invalid');
  refused(() => requireLocal(h.as(h.ownerRun.id, ''), release, () => h.root), 'run_credential_missing_or_invalid');
});

test('administration stays a person\'s: the responsible\'s Run is refused without reading its Task', async t => {
  const h = await setup(t);
  requireAdmin(h.as(null), () => h.root);
  refused(() => requireAdmin(h.as(h.ownerRun.id), () => h.root), 'run_not_current_placement');
  refused(() => requireAdmin(h.as(h.workerRun.id), () => h.root), 'run_not_current_placement');
});

test('the responsible\'s Run does not release while the user holds its Task', async t => {
  const h = await setup(t);
  await new TaskReportService(h.root).report({ task: h.task.id, state: 'held', opId: randomUUID(),
    expectedTaskHash: (await h.current()).hash }, human, human);
  refused(() => requireLocal(h.as(h.ownerRun.id), release, () => h.root), 'not_for_run_while_own_task_held');
});
