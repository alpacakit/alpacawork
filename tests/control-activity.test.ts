/** A running Run's activity reaches the tree and the index without a Run database commit. */
import { createFixtureRun } from './helpers/run-fixture.ts';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, openSync, closeSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { AGENTS_TEMPLATE } from '@alpacawork/backend/test-dist/agents-settings.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { runFolder } from '@alpacawork/contract/run';
import { tryLock, unlock } from '@alpacawork/core';
import { openIndexStream } from './index-stream.ts';

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-activity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); writer.save('config.yaml', null, Buffer.from(AGENTS_TEMPLATE)); }
  finally { writer.close(); }
  const task = (await new ControlTaskCommands(root, { kind: 'human' }).create({ parentId: project, userRequested: null,
    tasks: [{ title: 'Owner task' }] })).tasks[0];
  const placements = new PlacementStore(root);
  const agent = placements.createAgent();
  const placement = placements.place({ taskId: task.id, agentId: agent.id, profileKey: 'codex', responsible: true });
  placements.close();
  const store = new RunStore(root, { busyTimeoutMs: 0 });
  const run = store.write(tx => {
    const created = createFixtureRun(store, tx, { task: task.id, placementId: placement.id, requestId: globalThis.crypto.randomUUID(),
      agent: 'codex', role: 'owner', resumes: null, continues: false, session: null,
      caller: null, cwd: root, launch: { adapter: 'codex', env: [], argv: ['unused'], path: '/bin', values: { model: 'gpt-6-sol' }} }, 'prompt');
    tx.update({ ...created, state: 'running', started_at: new Date().toISOString() });
    return created;
  });
  store.prepareFolder(run.id);
  store.close();
  return { root, task, run, placement };
}

test('a live activity change reaches the SSE index without a Run database commit', async t => {
  const h = await setup(t);
  const fd = openSync(join(runFolder(h.root, h.run.id), 'manager.lock'), constants.O_RDWR | constants.O_CREAT);
  assert.equal(tryLock(fd), true);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    server = await startServer(h.root, 0);
    const stream = await openIndexStream(new URL('/api/events', server.url), controller.signal);
    await stream.index();
    writeFileSync(join(runFolder(h.root, h.run.id), 'activity.json'), JSON.stringify({
      at: '2026-10-05T03:43:14.000Z', kind: 'tool_start', toolName: 'Bash', doing: null, note: null }));
    const changed = await Promise.race([
      (async () => {
        for (;;) {
          const index = await stream.index();
          if (index.runs.find(run => run.id === h.run.id)?.activity?.toolName === 'Bash') return index;
        }
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('activity SSE timed out')), 3500); }),
    ]);
    assert.equal(changed.runs.find(run => run.id === h.run.id)?.activity?.toolName, 'Bash');
    assert.equal(changed.placements.find(item => item.id === h.placement.id)?.runtime.toolName, 'Bash');
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await server?.close();
    unlock(fd); closeSync(fd);
  }
});
