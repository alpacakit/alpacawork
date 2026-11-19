import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFolder } from '@alpacawork/contract/run';
import { callerWorkspace } from './coordinator-caller.fixture.ts';
import { openIndexStream } from './index-stream.ts';

test('recent work travels through real index/delta without changing the conversation revision, and clears on Run end', async t => {
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
  const file = join(runFolder(w.root, run.id), 'recent-work.json');
  const write = (name: 'task.new' | 'task.update') => writeFileSync(file, JSON.stringify({ name, count: 1 }));
  write('task.new');
  let current = await stream.index();
  for (let i = 0; i < 15 && current.coordinatorWork?.name !== 'task.new'; i++) current = await stream.index();
  assert.deepEqual(current.coordinatorWork, { conversation: run.conversation, turn: run.requestId, name: 'task.new', count: 1 });
  assert.deepEqual(current.person.coordinator, revision, 'activity is independent of conversation read markers');
  write('task.update');
  do { current = await stream.index(); } while (current.coordinatorWork?.name !== 'task.update');
  assert.deepEqual(current.person.coordinator, revision);
  // The activity projection intentionally stays non-null: Run state is authoritative at the server boundary.
  w.end(run);
  do { current = await stream.index(); } while (current.coordinatorWork !== null);
  assert.equal(current.coordinatorWork, null);
});
