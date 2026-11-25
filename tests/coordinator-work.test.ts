import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFolder } from '@alpacawork/contract/run';
import { callerWorkspace } from './coordinator-caller.fixture.ts';
import { openIndexStream } from './index-stream.ts';

test('coordinator steps and words survive quiet in the index and clear on Run end', { timeout: 10_000 }, async t => {
  const w = callerWorkspace(t);
  const run = w.screenRun({ words: 'Watch the work', session: 'work-session' });
  const url = await w.start();
  await w.startScreenRun(url, run);
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await openIndexStream(new URL('/api/events', url), abort.signal);
  const first = await stream.index();
  assert.equal(first.coordinatorWork, null);
  const revision = first.person.coordinator;
  const folder = runFolder(w.root, run.id);
  const file = join(folder, 'recent-work.json');
  const write = (name: 'task.new' | 'task.update') => writeFileSync(file, JSON.stringify({ name, count: 1 }));
  write('task.new');
  let current = await stream.index();
  for (let i = 0; i < 15 && current.coordinatorWork?.name !== 'task.new'; i++) current = await stream.index();
  const identity = { conversation: run.conversation, turn: run.requestId, run: run.id };
  assert.deepEqual(current.coordinatorWork, { ...identity, name: 'task.new', count: 1, steps: [], stepEvents: 0, words: null });
  assert.deepEqual(current.person.coordinator, revision, 'activity is independent of conversation read markers');
  write('task.update');
  do { current = await stream.index(); } while (current.coordinatorWork?.name !== 'task.update');
  assert.deepEqual(current.person.coordinator, revision);
  const at = '2026-11-24T01:00:00.000Z';
  const steps = [{ id: 'check', at, tool: 'Bash', kind: 'command', text: 'cat catalog.txt', more: 0, about: null, state: 'done', result: null }];
  const words = 'The catalog is ready.';
  writeFileSync(join(folder, 'activity.json'), JSON.stringify({
    at, kind: 'tool_end', toolName: 'Bash', doing: null, note: { at, text: words }, context: null, steps, stepEvents: 7,
  }));
  do { current = await stream.index(); } while (current.coordinatorWork?.words !== words);
  // Every step's start and end is counted with the work, so an opened list knows when any of them changed.
  assert.deepEqual(current.coordinatorWork, { ...identity, name: 'task.update', count: 1, steps, stepEvents: 7, words });
  writeFileSync(file, 'null');
  do { current = await stream.index(); } while (current.coordinatorWork?.name !== null);
  assert.deepEqual(current.coordinatorWork, { ...identity, name: null, count: 0, steps, stepEvents: 7, words });
  assert.deepEqual(current.person.coordinator, revision);
  w.end(run);
  do { current = await stream.index(); } while (current.coordinatorWork !== null);
  assert.equal(current.coordinatorWork, null);
});
