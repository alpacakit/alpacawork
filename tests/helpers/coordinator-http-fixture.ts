import { parse, stringify } from 'yaml';
import { fixtureAgentSetting, installAgentStub } from './agent-stub.ts';
/** Shared setup only; each case owns its root, server and cleanup. */
import { coordinatorMessageResponseSchema, coordinatorSnapshotSchema, type CoordinatorConversation } from "@alpacawork/contract/coordinator";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileWriter } from "@alpacawork/backend/test-dist/raw/storage.js";
import { startServer } from "@alpacawork/backend/test-dist/receiver/server.js";
import { RunStore } from "@alpacawork/runs";
import { initializeControlFixture } from "./control-fixture.ts";
import { attemptOf } from "@alpacawork/backend/test-dist/runs/execution-control.js";

export const fake = new URL('../fixtures/fake-coordinator-agent.mjs', import.meta.url).pathname;

export const messagePart = (prompt: string) => prompt.split(/^Request ID of this input: [^\n]+\n/m).at(-1)!;

export type Turn = { id: string; status: string; ask: string; intent?: unknown; answers?: unknown; answer: string | null; error: string | null };

export type View = CoordinatorConversation;

export async function eventually<T>(check: () => T | null | undefined | false | Promise<T | null | undefined | false>,
  message: string, timeout = 20_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(50);
  }
}

export function records(root: string, conversationId: string) {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
  assert.ok(store);
  try {
    const db = store.connection;
    return db.prepare('SELECT id, body, delivery_state FROM requests WHERE conversation_id = ? ORDER BY submitted_at, rowid')
      .all(conversationId).map(row => {
        const id = String(row.id), number = db.prepare('SELECT id FROM runs WHERE request_id = ?').get(id);
        const run = number ? store.runtimeGet(`R${number.id}`) : null, text = run ? store.getText(run.id) : null;
        return { id, body: String(row.body), deliveryState: String(row.delivery_state), run, prompt: text?.prompt ?? null, result: text?.result ?? null, launch: run ? attemptOf(store, run.id) : null };
      });
  } finally { store.close(); }
}

/** A published input mark is sufficient while the asynchronous Run identity is still unknown. */
export function assertInputMarker(started: { pid: number; session: string },
  run: { session: { id: string } | null; pids: { agent: number | null } }): void {
  assert.ok(typeof started.session === 'string' && started.session.length > 0, 'input readiness has a session');
  if (run.session !== null) assert.equal(started.session, run.session.id, 'input readiness belongs to this invocation');
  assert.ok(Number.isSafeInteger(started.pid) && started.pid > 0);
  if (run.pids.agent !== null) assert.equal(started.pid, run.pids.agent);
}

export async function fixture(t: { name?: string; after: (fn: () => void | Promise<void>) => void }, choices = false, limits = '', adapter: 'claude' | 'codex' = 'claude') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-coordinator-')));
  const setting = fixtureAgentSetting(adapter);
  setting.params.model = choices ? ['opus', 'fable'] : [];
  setting.params.effort = choices ? ['high', 'max'] : [];
  if (adapter === 'codex') setting.params.fast = [];
  const config = stringify({ ...parse(limits), agents: { fake: setting } });
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(config)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  process.env.PATH = installAgentStub(root, adapter === 'claude' ? 'claude' : 'alpacawork-agent', [process.execPath, fake, ...(adapter === 'codex' ? ['--fixture-bridge'] : [])]);
  let server = await startServer(root);
  t.after(async () => {
    await server.close();
    if (process.env.COORDINATOR_HTTP_EVIDENCE_DIR) {
      const evidence = join(process.env.COORDINATOR_HTTP_EVIDENCE_DIR, root.split('/').at(-1)!);
      mkdirSync(evidence, { recursive: true });
      const begin = new Date().toISOString(); cpSync(root, join(evidence, 'fixture'), { recursive: true, preserveTimestamps: true });
      writeFileSync(join(evidence, 'capture.json'), JSON.stringify({ test: t.name, root, begin, end: new Date().toISOString(), boundary: 'after server.close, before fixture removal' }));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const get = async () => (coordinatorSnapshotSchema.parse(await (await fetch(new URL('/api/coordinator', server.url))).json()).conversation as View);
  const post = async (path: string, data: unknown) => {
    const response = await fetch(new URL(path, server.url), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    await response.clone().arrayBuffer();
    return response;
  };
  const done = (id: string) => eventually(async () => {
    const turn = (await get()).turns.find(item => item.id === id);
    return turn && !['queued', 'sending', 'running'].includes(turn.status) && turn;
  // Completion is fixture setup for the conversation assertions; keep the separate startup deadlines unchanged.
  }, `Coordinator did not finish ${id}`, 60_000);
  /** The real agent has read this input; importing its started receipt is a separate step. */
  const agentOf = (conversationId: string, id: string) => eventually(() => {
    const run = records(root, conversationId).find(record => record.id === id)?.run;
    if (run?.state !== 'running') return false;
    let started: { pid: number; session: string };
    try { started = JSON.parse(readFileSync(join(root, '.alpacawork/coordinator', 'agent-' + encodeURIComponent(id) + '.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    assertInputMarker(started, { session: run.session ?? null, pids: { agent: run.pids.agent ?? null } });
    try { process.kill(started.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
    return started.pid;
  }, `Agent of ${id} started`);
  return { root, project, config, get, post, done, agentOf, records: (conversationId: string) => records(root, conversationId),
    app: () => server, url: () => server.url, stop: () => server.close(),
    restart: async (between?: () => void) => { await server.close(); between?.(); server = await startServer(root); } };
}

export function boundaryEvidence(root: string, task: string, conversationId: string) {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 })!;
  try {
    const db = store.connection;
    return {
      canonical: db.prepare('SELECT entry FROM task_log WHERE task_id=(SELECT id FROM tasks WHERE external_id=?) ORDER BY ordinal').all(task).map(row => JSON.parse(String(row.entry))),
      requests: db.prepare('SELECT id,body,delivery_state,reply_to FROM requests WHERE conversation_id=? ORDER BY rowid').all(conversationId),
      runs: db.prepare('SELECT id,request_id,record FROM runs WHERE conversation_id=? ORDER BY id').all(conversationId).map(row => ({ ...row, record: JSON.parse(String(row.record)) })),
    };
  } finally { store.close(); }
}

export async function assertQuestionContext(h: Awaited<ReturnType<typeof fixture>>, task: string,
  input: { conversationId: string; id: string; text: string; tasks: string[]; attachments: string[]; answers: { task: string; question: string }[] }) {
  const before = boundaryEvidence(h.root, task, input.conversationId);
  const previous = h.records(input.conversationId).map(row => ({ id: row.id, run: row.run?.id }));
  const response = await h.post('/api/coordinator/messages', input);
  assert.equal(response.status, 200, await response.clone().text());
  const received = coordinatorMessageResponseSchema.parse(await response.json());
  assert.deepEqual(received.conversation.turns.find(turn => turn.id === input.id)?.answers, input.answers,
    'the HTTP receipt retains the exact Task and question identity');
  assert.deepEqual(boundaryEvidence(h.root, task, input.conversationId).canonical, before.canonical,
    'HTTP admission must not write an answer or otherwise edit the referenced Task log');
  const records = h.records(input.conversationId), stored = records.find(row => row.id === input.id)!;
  assert.equal(records.filter(row => row.id === input.id).length, 1);
  assert.deepEqual(records.filter(row => row.id !== input.id).map(row => ({ id: row.id, run: row.run?.id })), previous);
  assert.equal(stored.body, input.text);
  assert.equal(stored.run?.role, 'coordinator');
  assert.deepEqual(stored.run?.message.answers, input.answers, 'the durable Run retains the same context references');
  const completed = await h.done(input.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(messagePart(JSON.parse(completed.answer!).prompt), `${input.text}\nQuestions being answered: ${JSON.stringify(input.answers)}`,
    'the actual agent receives the original reference, without turning it into a Task operation');
  assert.deepEqual((await h.get()).turns.find(turn => turn.id === input.id)?.answers, input.answers);
  const after = boundaryEvidence(h.root, task, input.conversationId);
  assert.deepEqual(after.canonical, before.canonical, 'receiving and completing the context message do not answer the Task');
  return { before, after };
}
