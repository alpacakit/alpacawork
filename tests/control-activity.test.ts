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
import { recordReportedContext } from '@alpacawork/backend/test-dist/agents/context-reported.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { runFolder } from '@alpacawork/contract/run';
import { mcpReadTool } from '@alpacawork/contract/mcp';
import { tryLock, unlock } from '@alpacawork/core';
import { cliRun } from './helpers/http-cli.ts';
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

test('live steps reach the SSE index while CLI and MCP keep the activity summary', async t => {
  const h = await setup(t);
  const fd = openSync(join(runFolder(h.root, h.run.id), 'manager.lock'), constants.O_RDWR | constants.O_CREAT);
  assert.equal(tryLock(fd), true);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    server = await startServer(h.root, 0, { mcp: true });
    const stream = await openIndexStream(new URL('/api/events', server.url), controller.signal);
    await stream.index();
    const at = '2026-10-05T03:43:14.000Z';
    const step = { id: 'read', at, tool: 'Bash', kind: 'command', text: 'sed -n 1p catalog.txt', more: 0,
      about: 'Read the catalog', state: 'running', result: null };
    const context = { observedAt: at, usedTokens: 1234, compacted: false };
    recordReportedContext(h.root, 'codex', 'gpt-6-sol', { windowTokens: 200_000 });
    const summary = { at, kind: 'tool_start', toolName: 'Bash',
      doing: { at, toolName: 'Bash', command: null }, note: { at, text: 'Checking the catalog' }, context };
    const resolved = { ...summary, context: { ...context, windowTokens: 200_000, windowFrom: 'reported' } };
    writeFileSync(join(runFolder(h.root, h.run.id), 'activity.json'), JSON.stringify({ ...summary, steps: [step] }));
    const changed = await Promise.race([
      (async () => {
        for (;;) {
          const index = await stream.index();
          if (index.runs.find(run => run.id === h.run.id)?.activity?.toolName === 'Bash') return index;
        }
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('activity SSE timed out')), 3500); }),
    ]);
    assert.deepEqual(changed.runs.find(run => run.id === h.run.id)?.activity, { ...resolved, steps: [step] });
    assert.equal(changed.placements.find(item => item.id === h.placement.id)?.runtime.toolName, 'Bash');

    const cli = await cliRun(server.url, ['task', 'get', '--task', h.task.id, '--runs', '1']);
    assert.equal(cli.code, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).runs[0].activity, resolved);
    const mcp = await fetch(new URL('/mcp', server.url), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: mcpReadTool, arguments: { command: 'task get', input: { task: h.task.id, runs: 1 } },
      } }),
    });
    const reply = await mcp.json();
    assert.equal(mcp.status, 200, JSON.stringify(reply));
    assert.deepEqual(JSON.parse(reply.result.content[0].text).runs[0].activity, resolved);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await server?.close();
    unlock(fd); closeSync(fd);
  }
});
