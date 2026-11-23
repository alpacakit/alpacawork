import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { commandFetch as fetch } from './helpers/command-fetch.ts';
import { assignResponsible, currentTaskHash, currentTaskLog, initializeControlFixture } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLock, unlock } from '@alpacawork/core';
import { runFolder } from '@alpacawork/contract/run';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { readControlTree } from './helpers/control-tree.ts';
import { RunStore } from '@alpacawork/runs';
import { cleanCliEnv, startCliFixtureServer } from './helpers/http-cli.ts';

const servers = new Map<string, string>();
const human = { kind: 'human' } as const;

/**
 * A task of the fixture's project whose responsible's Run runs: a person asked it to work and its start is applied.
 * The test holds the Run's manager lock, as its manager does, so the server's passes leave it running.
 */
async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-estimate-')));
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'),
    stringify({ agents: { "fake": fixtureAgentSetting('codex') } }));
  const tasks = new ControlTaskStore(root);
  const created = (await new ControlTaskCommands(root, human).create({ parentId: project, userRequested: false,
    tasks: [{ title: 'Estimate' }] })).tasks[0];
  const owner = await assignResponsible(root, await tasks.get(created.id), 'fake');
  const { outcome: { request } } = await new TaskRequestService(root).request({ task: created.id, body: 'Estimate the work',
    opId: globalThis.crypto.randomUUID(), expectedTaskHash: (await tasks.get(created.id)).hash,
    expectedPlacementRevision: owner.revision }, human, human);
  const run: string = request.runId;
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  try {
    store.prepareFolder(run);
    store.write(tx => tx.update({ ...tx.get(run)!, state: 'running', started_at: new Date().toISOString() }));
  } finally { store.close(); }
  const lock = openSync(join(runFolder(root, run), 'manager.lock'), constants.O_RDWR | constants.O_CREAT);
  assert.equal(tryLock(lock), true);
  reconcileLinks(root, project);
  const server = await startCliFixtureServer(root);
  servers.set(root, server.url);
  t.after(async () => {
    servers.delete(root);
    await server.stop();
    unlock(lock); closeSync(lock);
    rmSync(root, { recursive: true, force: true });
  });
  const task = await tasks.get(created.id);
  assert.equal(task.meta.state, 'doing');
  return { root, task, run, env: { ALPACAWORK_RUN: run, ALPACAWORK_RUN_TOKEN: issueRunCredential(root, run) } };
}

/** The CLI against the fixture's server, as a person, or as the Run `env` names. */
function cli(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('../apps/cli/dist/cli.js', import.meta.url)),
    '--server', servers.get(root)!, ...args], { env: cleanCliEnv(env), encoding: 'utf8' });
}

test('the responsible Run saves the same bounded estimate by CLI and HTTP without another Request', async t => {
  const h = await fixture(t);
  const descriptionFile = join(h.root, 'estimate-description.md');
  writeFileSync(descriptionFile, 'The estimate is based on the remaining work.');
  const command = cli(h.root, ['task', 'report', '--task', h.task.id, '--estimate-minutes', '30', '--state', 'doing',
    '--title', 'First estimate', '--description-file', descriptionFile, '--expected-task-hash', h.task.hash,
    '--op-id', globalThis.crypto.randomUUID()], h.env);
  assert.equal(command.status, 0, command.stderr);
  const first = JSON.parse(command.stdout).task;
  assert.equal(currentTaskLog(h.root, h.task.id).at(-1)!.estimateMinutes, 30);
  const response = await fetch(new URL('/api/commands/task/report', servers.get(h.root)!), {
    method: 'POST', headers: { 'content-type': 'application/json',
      authorization: `Alpacawork-Run ${h.run}:${h.env.ALPACAWORK_RUN_TOKEN}` },
    body: JSON.stringify({ task: h.task.id, state: 'doing', estimateMinutes: 20, opId: globalThis.crypto.randomUUID(),
      title: 'Revised', description: 'The remaining work is smaller.', expectedTaskHash: first.hash }),
  });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const second = (await response.json()).task;
  const estimates = currentTaskLog(h.root, h.task.id).slice(-2);
  assert.equal(second.hash, currentTaskHash(h.root, h.task.id));
  assert.deepEqual(estimates.map(entry => entry.estimateMinutes), [30, 20]);
  assert.deepEqual(estimates.map(entry => entry.runId), [h.run, h.run]);
  // Only the person's instruction made a Request and its Run.
  const store = new RunStore(h.root, { busyTimeoutMs: 0 }, true);
  try { assert.deepEqual([store.read().length, store.readRequests().length], [1, 1]); }
  finally { store.close(); }
});

test('CLI and HTTP reject each invalid estimate, and an estimate with an instruction', async t => {
  const h = await fixture(t);
  const server = servers.get(h.root)!;
  for (const value of ['0', '-1', '1.5', '10081']) {
    const command = cli(h.root, ['task', 'report', '--task', h.task.id, '--state', 'doing', '--estimate-minutes', value,
      '--expected-task-hash', h.task.hash, '--op-id', globalThis.crypto.randomUUID()], h.env);
    assert.equal(command.status, 2, `${value}: ${command.stdout} ${command.stderr}`);
    const response = await fetch(new URL('/api/commands/task/report', server), {
      method: 'POST', headers: { 'content-type': 'application/json',
        authorization: `Alpacawork-Run ${h.run}:${h.env.ALPACAWORK_RUN_TOKEN}` },
      body: JSON.stringify({ task: h.task.id, state: 'doing', estimateMinutes: Number(value),
        opId: globalThis.crypto.randomUUID(), expectedTaskHash: h.task.hash }),
    });
    assert.equal(response.status, 400, value);
  }
  // An instruction is task request's, which takes no estimate.
  const bodyFile = join(h.root, 'instruction.txt');
  writeFileSync(bodyFile, 'Instruction');
  const command = cli(h.root, ['task', 'request', '--task', h.task.id, '--estimate-minutes', '30', '--instruction-file', bodyFile,
    '--expected-task-hash', h.task.hash, '--expected-placement-revision', '1', '--op-id', globalThis.crypto.randomUUID()]);
  assert.equal(command.status, 2, command.stderr);
  const response = await fetch(new URL('/api/commands/task/request', server), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: h.task.id, estimateMinutes: 30, instruction: 'Instruction', opId: globalThis.crypto.randomUUID(),
      expectedTaskHash: h.task.hash, expectedPlacementRevision: 1 }),
  });
  assert.equal(response.status, 400);
  const after = (await readControlTree(h.root)).tasks.find(task => task.id === h.task.id);
  assert.equal(after?.hash, h.task.hash);
});
