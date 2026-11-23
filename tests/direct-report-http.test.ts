import { commandFetch as fetch, commandBody } from './helpers/command-fetch.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupReview } from './review.fixture.ts';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { Agent, request } from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

/** The browser's exact boundary: no Run credential, conversation claim, quote, or coordinator message. */
test('human HTTP reports confirm a Run, hold, restore and stop; stale hashes preserve the actual Problem', async t => {
  const h = await setupReview(t, { userRequested: true });
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { "claude": fixtureAgentSetting('claude') } }));
  const server = await h.start();
  const evidence: unknown[] = [];
  const post = async (state: string, fields: Record<string, unknown> = {}) => {
    const task = await new ControlTaskStore(h.root).get(h.task.id), opId = randomUUID();
    const input = { task: task.id, state, expectedTaskHash: task.hash, opId, ...fields };
    const response = await fetch(new URL('/api/commands/task/report', server.url), { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': opId }, body: JSON.stringify(input) });
    const output = await response.json(); evidence.push({ input, status: response.status, output });
    return { response, output };
  };
  const held = await post('held'); assert.equal(held.response.status, 200); assert.equal(held.output.task.state, 'held');
  const restored = await post('waiting'); assert.equal(restored.response.status, 200); assert.equal(restored.output.task.state, 'waiting');
  const stale = await post('done', { expectedTaskHash: '0'.repeat(64), aboutRun: h.reviewRun, expectedPlacementRevision: h.expectedPlacementRevision });
  assert.equal(stale.response.status, 409); assert.equal(stale.output.error.code, 'conflict');
  assert.equal(stale.output.error.message, 'Task changed; reload before review');
  assert.equal(stale.output.error.reason.kind, 'task_changed_reload_before_review');
  const done = await post('done', { aboutRun: h.reviewRun, expectedPlacementRevision: h.expectedPlacementRevision });
  assert.equal(done.response.status, 200); assert.equal(done.output.task.state, 'done');
  const other = (await h.commands.create({ parentId: h.project, userRequested: true, tasks: [{ title: 'Stop this task' }] })).tasks[0]!;
  const stopped = await post('stopped', { task: other.id, expectedTaskHash: other.hash }); assert.equal(stopped.response.status, 200); assert.equal(stopped.output.task.state, 'stopped');
  const written = new Set(evidence.flatMap((item: any) => item.status === 200 ? [item.input.opId] : []));
  const records = [...(await new ControlTaskStore(h.root).get(h.task.id)).meta.log, ...(await new ControlTaskStore(h.root).get(other.id)).meta.log]
    .filter(entry => written.has(entry.id));
  assert.ok(records.length > 0);
  for (const entry of records) assert.equal(entry.actor.kind, 'human');
  if (process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE) writeFileSync(join(process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE, 'http-check.md'),
    `# HTTP check\n\nWorkspace: ${h.root} (test fixture, removed on completion).\nNo credentials or conversation headers.\n\nAll assertions passed: hold, restore, stale hash refusal, Run confirmation, stop, human History.\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`);
});

test('an idle proxy connection still carries human review reports after the backend default keep-alive expiry', { timeout: 20_000 }, async t => {
  const h = await setupReview(t, { userRequested: true }), server = await h.start();
  const other = (await h.commands.create({ parentId: h.project, userRequested: true,
    tasks: [{ title: 'Stop this task' }] })).tasks[0]!;
  // A reverse proxy can retain an idle connection beyond Node's advertised timeout. Do not let the
  // Node test client's own Keep-Alive hint handling close it first and hide the server's expiry.
  class ProxyPool extends Agent {
    override keepSocketAlive(socket: Socket) {
      socket.setKeepAlive(true, 1000); socket.setTimeout(90_000); socket.unref(); return true;
    }
  }
  const agent = new ProxyPool({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const send = (input?: Record<string, unknown>) => new Promise<{ status: number; body: any; socket: Socket; reused: boolean }>((resolve, reject) => {
    const req = request(new URL(input ? '/api/commands/task/report' : '/api/runtime/readiness', server.url), {
      agent, method: input ? 'POST' : 'GET', signal: AbortSignal.timeout(10_000),
      headers: input ? { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': String(input.opId) } : {},
    }, res => {
      const socket = req.socket!, chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), socket, reused: req.reusedSocket }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.end(input ? JSON.stringify(commandBody(input)) : undefined);
  });
  const warm = await send(); assert.equal(warm.status, 200);
  // Node 24's default is 5 seconds plus its 1 second buffer. Waiting past it makes the old
  // server's failure deterministic; the real expiry/reuse race also loses POSTs with ECONNRESET.
  await delay(6500);
  assert.equal(warm.socket.destroyed, false, 'The backend must leave an idle proxy connection available for its next report');
  for (const state of ['held', 'waiting', 'done', 'stopped']) {
    const task = await new ControlTaskStore(h.root).get(state === 'stopped' ? other.id : h.task.id);
    const input = { task: task.id, state, expectedTaskHash: task.hash, opId: randomUUID(),
      ...state === 'done' ? { aboutRun: h.reviewRun, expectedPlacementRevision: h.expectedPlacementRevision } : {} };
    const result = await send(input);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.task.state, state);
    assert.equal(result.reused, true); assert.equal(result.socket, warm.socket);
    assert.equal((await new ControlTaskStore(h.root).get(task.id)).meta.state, state);
  }
});
