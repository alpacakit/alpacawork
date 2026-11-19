import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../e2e/server.ts';
import { patchTask, seedReview } from '../e2e/fixture/task-state.ts';
import { SAMPLE_PROJECT } from '../e2e/fixture/sample.ts';
import { readTaskLog } from '../e2e/task-history.ts';
import { commandFetch as fetch } from './helpers/command-fetch.ts';

test('direct state reports: every state holds, repeats hold and restores as the person', async t => {
  const runtime = await start();
  try {
    const post = async (path: string, body: object) => {
      const response = await fetch(`${runtime.origin}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await response.text(); assert.equal(response.status, 200, text); return JSON.parse(text);
    };
    for (const origin of ['todo', 'doing', 'error', 'waiting', 'done', 'stopped'] as const) await t.test(origin, async () => {
      const { task } = await post('task/new', { parent: SAMPLE_PROJECT.id, title: `Hold ${origin}` });
      await post('agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
      const id = task.id;
      if (origin === 'waiting') seedReview(runtime.root, id, { title: 'Review', description: 'Review later' });
      else if (origin !== 'todo') patchTask(runtime.root, id, { state: origin, logs: [{ id: crypto.randomUUID(), kind: 'linked',
        at: new Date().toISOString(), title: null, description: null, actor: { kind: 'human' }, fromState: 'todo', toState: origin }] });
      const view = async () => (await (await fetch(`${runtime.origin}/api/task/view?task=${id}`)).json()).task;
      // Finished Tasks leave the live projection; their scoped Task read still owns their placement facts.
      const current = await (await fetch(`${runtime.origin}/api/task/get?task=${id}`)).json();
      const responsible = current.agents.find((placement: any) => placement.active && placement.responsible);
      assert.ok(responsible);
      const conversation = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
      const report = async (state: string, title: string, description: string) => {
        const opId = crypto.randomUUID();
        await post('task/report', { task: id, state, opId, title, description,
          expectedTaskHash: (await view()).hash, expectedPlacementRevision: responsible.revision });
        assert.equal((await view()).state, state);
        return opId;
      };
      await report('held', 'Hold any state', 'Review later');
      await report('held', 'Still held', 'Later');
      const opId = await report(origin, 'Restore original state', 'Ready now');
      const restored = (await readTaskLog(runtime.origin, id)).filter(entry => entry.fromState === 'held' && entry.toState === origin);
      assert.equal(restored.length, 1);
      assert.deepEqual(restored[0].actor, { kind: 'human' });
      assert.equal(restored[0].id, opId);
      assert.equal(restored[0].title, 'Restore original state');
      assert.equal(restored[0].description, 'Ready now');
      const after = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
      assert.deepEqual(after.turns, conversation.turns);
    });
  } finally { await runtime.stop(); }
});
