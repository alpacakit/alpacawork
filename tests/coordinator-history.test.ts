import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { stringify } from 'yaml';
import { RunStore } from '@alpacawork/runs';
import { coordinatorMessageStatusSchema, coordinatorSnapshotSchema, coordinatorTurnsPageSchema } from '@alpacawork/contract/coordinator';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';

test('coordinator HTTP bounds a thousand turns and acknowledges an answer pushed out of the window', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'coordinator-history-'));
  const original = createOriginal({ ...profiles.small, seed: 'coordinator-history-api' }, join(sandbox, 'cache'));
  const copy = copyWorkspace(original.root, join(sandbox, 'workspace'));
  const root = copy.root;
  try {
    writeFileSync(join(root, 'config.yaml'), stringify({
      agents: { synthetic: { ...fixtureAgentSetting('claude'), params: {}, command: '/usr/bin/false' } },
    }));
    const owner = new CoordinatorConversation(root), conversationId = owner.read().id;
    await owner.seedSeen();
    const ids = Array.from({ length: 1000 }, () => crypto.randomUUID());
    owner.ask({ conversationId, id: ids[0]!, text: 'Seed synthetic turn', attachments: [] });
    const store = new RunStore(root, { busyTimeoutMs: 1000 });
    try {
      const { agent, launch, cwd, message } = store.coordinatorHead(conversationId)!;
      const at = '2026-11-01T00:00:00.000Z';
      const endedAt = '2026-11-01T00:00:01.000Z';
      store.write(tx => {
        for (const [index, id] of ids.entries()) {
          if (index > 0) tx.insertConversationRequest({
            id, conversationId, headRunId: null, mode: 'new', body: `Synthetic turn ${index}`,
            submittedAt: at, deliveryState: 'queued',
          });
          const run = index === 0 ? tx.coordinatorHead(conversationId)! : tx.createCoordinatorRun({
            conversationId, requestId: id, agent, launch, cwd, message, resumes: null, session: null,
          }, 'Synthetic turn');
          tx.update({ ...run, state: 'running', started_at: at });
          tx.finish({ ...run, state: 'succeeded', started_at: at, ended_at: endedAt },
            { state: 'present', text: `Synthetic answer ${index}` });
        }
      });
    } finally { store.close(); }
    const withdrawn = crypto.randomUUID();
    owner.withdraw(conversationId, withdrawn);
    const server = await startServer(root, 0);
    try {
      const get = async (path: string) => {
        const response = await fetch(new URL(path, server.url));
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const first = coordinatorSnapshotSchema.parse(await get('/api/coordinator')).conversation;
      assert.deepEqual(first.turns.map(turn => turn.id), ids.slice(-20));
      assert.deepEqual(first.earlier, { count: 980, before: ids[980] });
      const page = async (query: string) => coordinatorTurnsPageSchema.parse(await get(`/api/coordinator/turns?conversationId=${conversationId}&${query}`));
      const older = await page(`before=${first.earlier!.before}`);
      assert.deepEqual(older.turns.map(turn => turn.id), ids.slice(930, 980));
      const previous = await page(`before=${older.more}`);
      assert.deepEqual(previous.turns.map(turn => turn.id), ids.slice(880, 930));
      const around = await page(`around=${ids[3]}`);
      assert.deepEqual(around.turns.map(turn => turn.id), ids.slice(0, 4));
      assert.equal(around.more, null);
      for (const [id, status] of [[ids[0]!, 'succeeded'], [withdrawn, 'withdrawn'], [crypto.randomUUID(), 'missing']]) {
        assert.deepEqual(coordinatorMessageStatusSchema.parse(await get(`/api/coordinator/messages/${id}/status`)), { id, status });
      }
      const sendRead = (seen: string[]) => fetch(new URL('/api/coordinator/read', server.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, seen }),
      });
      const confirmed = await sendRead([ids[0]!, ids.at(-1)!]);
      assert.equal(confirmed.status, 200);
      assert.deepEqual(new Set((await confirmed.json()).seen), new Set([ids[0], ids.at(-1)]));
      const changed = coordinatorSnapshotSchema.parse(await get('/api/coordinator')).conversation;
      assert.equal(changed.turns.at(-1)!.seen, true);
      assert.equal((await page(`around=${ids[0]}`)).turns[0]!.seen, false);
      assert.equal((await sendRead([withdrawn])).status, 400);
    } finally { await server.close(); }
  } finally {
    removeWorkspace(root);
    removeWorkspace(original.root);
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('the stopped migration keeps old requests and runs while numbering only real coordinator turns', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const root = new URL('../packages/db/drizzle/control/', import.meta.url);
    const names = readdirSync(root).sort();
    const candidate = names.find(name => name.endsWith('_coordinator_reset'))!;
    db.exec('PRAGMA foreign_keys=OFF');
    db.function('alpacawork_data_migration', () => 0); // The old schema is empty until the coordinator fixtures below.
    for (const name of names.filter(name => name < candidate))
      db.exec(readFileSync(new URL(`${name}/migration.sql`, root), 'utf8'));
    db.exec('PRAGMA foreign_keys=ON');
    const conversationId = crypto.randomUUID(), warm = crypto.randomUUID(), first = crypto.randomUUID(), second = crypto.randomUUID();
    const cancelled = crypto.randomUUID();
    const at = '2026-11-01T00:00:00.000Z';
    db.prepare('INSERT INTO coordinator_conversations(id,started_at) VALUES (?,?)').run(conversationId, at);
    const request = db.prepare(`INSERT INTO requests(id,conversation_id,mode,body,purpose,author,submitted_at,delivery_state)
      VALUES (?,?,'new',?,'instruction','{"kind":"human"}',?,?)`);
    request.run(second, conversationId, 'Second', at, 'queued');
    request.run(warm, conversationId, 'Historical background prompt', at, 'queued');
    request.run(first, conversationId, 'First', at, 'queued');
    request.run(cancelled, conversationId, '', at, 'aborted');
    const run = db.prepare("INSERT INTO runs(id,record,result,result_state) VALUES (?,?,'reply','present')");
    for (const [number, requestId] of [[1, warm], [2, first], [3, second]] as const) {
      run.run(number, JSON.stringify({ id: `R${number}`, conversationId, requestId, role: 'coordinator', state: 'succeeded',
        restartArgv: null, ended_at: at }));
    }
    db.prepare('UPDATE coordinator_conversations SET warm_request_id=? WHERE id=?').run(warm, conversationId);
    db.exec(readFileSync(new URL(`${candidate}/migration.sql`, root), 'utf8'));
    const number = db.prepare('SELECT coordinator_turn_no AS n FROM requests WHERE id=?');
    assert.equal(number.get(warm)!.n, null);
    assert.equal(number.get(cancelled)!.n, null);
    assert.equal(number.get(first)!.n, 1);
    assert.equal(number.get(second)!.n, 2);
    assert.equal(db.prepare('SELECT visible_turns AS n FROM coordinator_conversations WHERE id=?').get(conversationId)!.n, 2);
    assert.deepEqual(db.prepare("SELECT id,result FROM runs WHERE json_type(record,'$.restartArgv') IS NULL ORDER BY id").all()
      .map(row => ({ ...row })), [1, 2, 3].map(id => ({ id, result: 'reply' })));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
