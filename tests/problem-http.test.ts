import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { problemSchema } from '@alpacawork/contract/problem';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { root, start, stop, request } from './helpers/platform-http.ts';
import { assignResponsible } from './helpers/control-fixture.ts';

test('current HTTP errors keep their status and retry advice', async () => {
  // The synthetic root is the project P1. Depth 33 is refused by the real Task command; a task with a child has a
  // responsible, so each one gets one before its child is created.
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  let parent = 'P1';
  for (let depth = 2; depth <= 32; depth++) {
    const task = (await commands.create({ parentId: parent, userRequested: false, tasks: [{ title: `Depth ${depth}` }] })).tasks[0];
    if (depth < 32) await assignResponsible(root, task, 'claude');
    parent = task.id;
  }

  await assert.rejects(commands.create({ parentId: parent, userRequested: false, tasks: [{ title: 'One level too far' }] }),
    { code: 'too_deep' });
  const app = await start();
  try {
    async function expectProblem(path: string, input: unknown, code: string, status: number, retry: string) {
      const answer = await request(app, path, input);
      const { error } = problemSchema.parse(answer.body);
      assert.equal(answer.status, status, `${code}: ${JSON.stringify(error)}`);
      assert.equal(error.code, code);
      assert.equal(error.retry, retry);
    }

    await expectProblem('task/update', { task: 'T999', title: 'Missing', expectedTaskHash: '0'.repeat(64) },
      'not_found', 404, 'fix');
    await expectProblem('task/new', { title: 'Oversized body', parent: 'P1', body: 'x'.repeat(7 * 1024 * 1024) },
      'too_large', 413, 'fix');
    await expectProblem('task/new', { title: 'One level too far', parent },
      'forbidden', 403, 'fix');
    const invalidInput = await request(app, 'settings/set', { key: 4, value: 'x', expectedRevision: 'r' });
    assert.equal(invalidInput.status, 400);
    const invalidBody = problemSchema.parse(invalidInput.body).error;
    assert.equal(invalidBody.code, 'invalid_input');
    assert.equal(invalidBody.retry, 'fix');
    assert.deepEqual(invalidBody.issues?.map(issue => issue.path), ['key']);

    // Hold the control database write lock until the HTTP writer times out.
    const writer = new DatabaseSync(controlDatabasePath(root));
    try {
      writer.exec('BEGIN IMMEDIATE');
      await expectProblem('task/new', { title: 'While locked', parent: 'P1' },
        'busy', 409, 'later');
      writer.exec('ROLLBACK');
    } finally { writer.close(); }
  } finally { await stop(app); }
});
