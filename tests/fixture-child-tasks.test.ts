/** The browser fixtures seed valid internal children, and a user question changes no request mark. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideValues, seedValues } from './helpers/task-values.ts';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { seedTask } from '../e2e/fixture/tasks.ts';
import { seedQuestion } from '../e2e/fixture/task-state.ts';

test('fixture tasks and questions keep children internal', async t => {
  const root = mkdtempSync(join(tmpdir(), 'alpacawork-e2e-task-seed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = initializeControlFixture(root), top = seedTask(root, project, 'Top');
  const child = seedTask(root, top.id, 'Child', { decide: [{ decide_question: 'Which way?', decide_note: 'A or B' }] });
  const people = new PlacementStore(root);
  try {
    for (const task of [top, child]) people.createAndPlace({ taskId: task.id, profileKey: 'fake', responsible: true });
  } finally { people.close(); }
  const store = new ControlTaskStore(root);
  assert.equal((await store.get(top.id)).meta.userRequested, true);
  assert.equal((await store.get(child.id)).meta.userRequested, false);
  const question = seedQuestion(root, child.id, { to: 'user' });
  const asking = await store.get(child.id);
  assert.equal(asking.meta.userRequested, false);
  assert.equal(asking.meta.log.find(log => log.id === question)?.askedTo, null);
  assert.ok(!asking.meta.log.some(log => log.kind === 'user_request_changed'));
});
