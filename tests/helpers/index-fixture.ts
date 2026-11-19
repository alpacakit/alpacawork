import { fixtureAgentSetting } from './agent-stub.ts';
import { stringify } from 'yaml';
import { fixtureWorkingTree } from './working-tree.ts';
import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ControlTreeDTO } from '@alpacawork/contract/control';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { screenTree, readScreenEnvironment } from './screen-tree.ts';
import { assignResponsible, initializeControlFixture } from './control-fixture.ts';
import { materializeIndexFacts } from './index-facts.ts';
import { tryLock, unlock } from '@alpacawork/core';
import { runFolder } from '@alpacawork/contract/run';

/** The facts a synthetic HTTP read takes from its authorities: the server derives its balls, home rows, history and counts. */
type Authorities = Pick<ControlTreeDTO, 'tasks' | 'runs' | 'requests'>;

export async function setupIndexFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-index-')));
  const controller = new AbortController();
  const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];
  const runLocks = new Map<string, number>();
  t.after(async () => {
    controller.abort();
    const closed = await Promise.allSettled(servers.map(server => server.close()));
    for (const fd of runLocks.values()) { unlock(fd); closeSync(fd); }
    rmSync(root, { recursive: true, force: true });
    const failed = closed.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  const writer = new FileWriter(root);
  let projectId: string;
  try { projectId = initializeControlFixture(root); } finally { writer.close(); }
  // A responsible needs a launch profile; this one is never launched.
  writeFileSync(join(root, 'config.yaml'),
    stringify({ agents: { "fake": fixtureAgentSetting('codex') } }));
  const tasks = new ControlTaskCommands(root, { kind: 'human' });
  const parent = (await tasks.create({ parentId: projectId, userRequested: null, tasks: [{ title: 'Parent' }] })).tasks[0];
  // A task with a child keeps its responsible, so Parent has one before Child is created below it.
  await assignResponsible(root, parent, 'fake');
  const child = (await tasks.create({ parentId: parent.id, userRequested: false, tasks: [{ title: 'Child' }] })).tasks[0];
  return { root, projectId, tasks, parent, child, signal: controller.signal,
    /**
     * The projection's input as the test states it, its balls included, for an IndexFeed to take: the fixture
     * project's screen tree. Its home rows, counts.closed and history are the feed's; nothing is derived here.
     */
    screen(tree: ControlTreeDTO) {
      return screenTree(readScreenEnvironment(root), [{ project: projectId, tree: fixtureWorkingTree(tree) }]);
    },
    /** Serves `facts` to the running servers' reads, which derive the rest from them as from the store. */
    async project(facts: Authorities) {
      for (const run of facts.runs) assert.equal(run.continues, false, 'paging fixtures use the current new-Run protocol');
      // A real manager holds this lock. Keep synthetic running/queued facts inert during server reconciliation.
      for (const run of facts.runs) if ((run.state === 'running' || run.state === 'queued') && !runLocks.has(run.id)) {
        const folder = runFolder(root, run.id);
        mkdirSync(folder, { recursive: true });
        const fd = openSync(join(folder, 'manager.lock'), constants.O_CREAT | constants.O_RDWR, 0o600);
        if (!tryLock(fd)) { closeSync(fd); throw new Error(`Fixture Run lock is busy: ${run.id}`); }
        runLocks.set(run.id, fd);
      }
      materializeIndexFacts(root, facts);
      for (const server of servers) {
        server.context.changed!();
        const response = await fetch(new URL('/api/workspace/live', server.url));
        if (response.status !== 200) throw new Error(await response.text());
        await response.arrayBuffer();
      }
    }, async start(options: Parameters<typeof startServer>[2] = {}) {
    const server = await startServer(root, 0, options);
    servers.push(server);
    return server;
  } };
}
