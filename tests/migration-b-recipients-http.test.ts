import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { start } from '../e2e/server.ts';
import { startFakeCoordinator } from '../e2e/coordinator-fixture.ts';
import { patchTask } from '../e2e/fixture/task-state.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';

test('recipients: a retained done Task receives the dialogue and the viewed Task receives no history', async () => {
  const runtime = await start(undefined, startFakeCoordinator);
  try {
    const post = async (path: string, body: object) => {
      const response = await fetch(`${runtime.origin}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
    };
    const project = (await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Recipients check' })).task.id;
    const requested = async (title: string) => {
      const { task } = await post('commands/task/new', { parent: project, title });
      await post('commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
      return task.id;
    };
    const first = await requested('Retained first'), second = await requested('Retained second');
    patchTask(runtime.root, first, { state: 'done' });
    const conversation = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
    const id = crypto.randomUUID();
    await post('coordinator/messages', { conversationId: conversation.id, id, text: `${first}（Retained first） Keep my saved draft`, tasks: [first], attachments: [] });
    const until = Date.now() + 30_000;
    let turn;
    do {
      const conversation = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
      turn = conversation.turns.find((turn: any) => turn.id === id);
      if (turn?.status === 'succeeded' || turn?.status === 'failed') break;
      await delay(50);
    } while (Date.now() < until);
    assert.equal(turn?.status, 'succeeded');
    const db = new DatabaseSync(join(runtime.root, '.alpacawork', 'alpacawork.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(db.prepare('SELECT k.external_id AS id FROM task_dialogues d JOIN tasks k ON k.id=d.task_uuid').all().map(row => row.id).sort(), [first]);
    } finally { db.close(); }
    const history = async (task: string) => (await (await fetch(`${runtime.origin}/api/task/history?task=${task}&limit=80`)).json()).events.filter((event: any) => event.kind === 'dialogue');
    assert.equal((await history(first)).length, 1);
    assert.equal((await history(second)).length, 0);
  } finally { await runtime.stop(); }
});

test('recipients: note.txt is uploaded with Note bytes and removed before any message', async () => {
  const runtime = await start();
  try {
    const conversation = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
    const requestId = crypto.randomUUID();
    const path = `${runtime.origin}/api/coordinator/attachments?conversationId=${conversation.id}&requestId=${requestId}&name=note.txt`;
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-alpacawork-op-id': crypto.randomUUID() }, body: Buffer.from('Note') });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.path.split('/').at(-1), 'note.txt'); assert.equal(saved.size, 4);
    const file = `${runtime.origin}/api/coordinator/file?requestId=${requestId}&name=note.txt`;
    const bytes = await fetch(file); assert.equal(bytes.status, 200); assert.equal(await bytes.text(), 'Note');
    const removed = await fetch(path, { method: 'DELETE', headers: { 'x-alpacawork-op-id': crypto.randomUUID() } });
    assert.equal(removed.status, 200, await removed.text());
    assert.equal((await fetch(file)).status, 404);
  } finally { await runtime.stop(); }
});
