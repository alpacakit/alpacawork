/** A title is current presentation; Task, question and review identities survive its change. */
import { currentTaskLog } from './helpers/control-fixture.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskFlow } from './task-flow.fixture.ts';
import { setupReview } from './review.fixture.ts';
import { call } from './helpers/cli-session.ts';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

test('a responsible retitles through CLI: persistence, history, conflicts, question and review identity', async t => {
  const f = await taskFlow(t);
  const target = await f.task('Design only', { userRequested: true });
  const owner = await f.work(target);
  // Disable scheduler passes: these are authenticated fixture Runs, with no agent process to reconcile.
  const interval = globalThis.setInterval;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) =>
    interval(callback, ms === POLL_INTERVAL_MS ? 3_600_000 : ms, ...args)) as typeof setInterval;
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer(f.root, 0); } finally { globalThis.setInterval = interval; }
  t.after(() => server.close());
  const env = { ALPACAWORK_RUN: owner.runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(f.root, owner.runId) };
  const current = () => call(server.url, ['task', 'get', '--task', target.id]);
  const update = (title: string, hash: string, extra: string[] = [], as = env) =>
    call(server.url, ['task', 'update', '--task', target.id, '--title', title, '--expected-task-hash', hash, ...extra], as);
  const before = await current();
  const renamed = await update('Implementation and isolated prototype', before.task.hash);
  assert.equal(renamed.task.title, 'Implementation and isolated prototype');
  assert.equal(renamed.task.id, target.id);
  assert.equal(renamed.task.userRequested, true);
  assert.equal(renamed.task.state, before.task.state);
  const record = currentTaskLog(f.root, target.id).at(-1)!;
  assert.deepEqual(record.actor, { kind: 'placement', placementId: owner.placementId });
  assert.equal(record.kind, 'retitled');
  assert.equal((await current()).task.title, renamed.task.title);
  const tree = await call(server.url, ['task', 'list']);
  assert.ok(JSON.stringify(tree).includes('Implementation and isolated prototype'));
  await assert.rejects(update('Stale overwrite', before.task.hash), { code: 'conflict' });
  await assert.rejects(update('Mixed forbidden update', renamed.task.hash, ['--no-from-user']), { code: 'forbidden' });
  assert.equal((await current()).task.hash, renamed.task.hash, 'a denied mixed update writes nothing');
  // The old question, including its frozen full text and recipient, survives a new title.
  const question = await f.ask(owner, 'user');
  const readQuestion = () => call(server.url, ['task', 'get', '--task', target.id, '--question', question]);
  const asked = await readQuestion();
  await update('Implemented, waiting on the same question', (await current()).task.hash);
  const afterQuestion = await readQuestion();
  assert.ok(asked.question, 'the full frozen question was actually read');
  assert.deepEqual(afterQuestion.question, asked.question);
  assert.deepEqual(afterQuestion.questions, asked.questions);
  const answer = await call(server.url, ['task', 'request', '--task', target.id, '--answers', question,
    '--instruction-file', '-'], {}, 'Use the approved scope');
  assert.equal(answer.outcome.kind, 'answered');
});

test('retitling a review preserves its Run and the person confirms that Run through CLI', async t => {
  const h = await setupReview(t, { userRequested: true });
  const server = await h.start();
  const renamed = await call(server.url, ['task', 'update', '--task', h.task.id, '--title', 'Implemented, review pending',
    '--expected-task-hash', h.expectedTaskHash]);
  const review = await call(server.url, ['task', 'get', '--task', h.task.id]);
  assert.equal(review.reviewRun, h.reviewRun);
  assert.equal(review.task.state, 'waiting');
  const confirmed = await call(server.url, ['task', 'report', '--task', h.task.id, '--state', 'done',
    '--about-run', h.reviewRun, '--expected-task-hash', renamed.task.hash,
    '--expected-placement-revision', String(h.expectedPlacementRevision)]);
  assert.equal(confirmed.task.state, 'done');
});
