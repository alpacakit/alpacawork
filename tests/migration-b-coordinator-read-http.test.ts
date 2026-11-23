import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../e2e/server.ts';

test('task suggestions: all fourteen created tasks are returned through the live index', async () => {
  const runtime = await start();
  try {
    const { commandFetch } = await import('./helpers/command-fetch.ts');
    const ids: string[] = [];
    for (let n = 1; n <= 14; n++) {
      const response = await commandFetch(`${runtime.origin}/api/commands/task/new`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `List extension item ${n}` }) });
      assert.equal(response.status, 200, await response.clone().text());
      ids.push((await response.json()).task.id);
    }
    const response = await fetch(`${runtime.origin}/api/workspace/live`); assert.equal(response.status, 200);
    const index = await response.json();
    assert.equal(index.errors.length, 0);
    assert.equal(index.tasks.filter((task: any) => ids.includes(task.id)).length, 14);
    for (let n = 1; n <= 14; n++) assert.equal(index.tasks.find((task: any) => task.id === ids[n - 1]).title, `List extension item ${n}`);
  } finally { await runtime.stop(); }
});
