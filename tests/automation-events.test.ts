import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { readTaskEventReference, readTaskEvents, recentTaskEvents } from '@alpacawork/backend/test-dist/automations/events.js';
import { bundleTaskMatch, programTaskEvent } from '@alpacawork/backend/test-dist/automations/bundle-events.js';
import type { AutomationConfig } from '@alpacawork/contract/automation-program';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { comment } from '@alpacawork/backend/test-dist/control/task-questions.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { withControlWrite } from '@alpacawork/backend/test-dist/control/task-transition.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { taskFlow } from './task-flow.fixture.ts';

const human = { kind: 'human' } as const;
const matches = (db: Parameters<typeof bundleTaskMatch>[0], on: AutomationConfig['on'],
  event: Parameters<typeof programTaskEvent>[1]) => bundleTaskMatch(db, { on, limits: { perDay: 1 } },
    programTaskEvent(db, event), event, null, new Date()) === 'match';

test('one review acceptance supplies its words and immutable base-state transition', async t => {
  const flow = await taskFlow(t);
  const seat = await flow.work(await flow.task('Original title', { userRequested: true }));
  await flow.report(seat, 'done');
  flow.end(seat);
  await flow.person(seat.id, 'held');
  await flow.person(seat.id, 'waiting');
  await flow.confirm(seat.id, seat.runId);
  await flow.commands.update({ id: seat.id, title: 'Updated title', userRequested: false,
    expectedTaskHash: (await flow.get(seat.id)).hash });
  const history = (await flow.get(seat.id)).meta.log;
  const approval = history.find(entry => entry.kind === 'review_approved')!;
  flow.store(({ connection: db }) => {
    const events = readTaskEventReference(db, flow.project, approval.id);
    const state = events.find(event => event.event === 'state_changed')!;
    const words = events.find(event => event.event === 'message_received')!;
    assert.ok(state && words);
    assert.deepEqual(readTaskEvents(db, state.sequence), events);
    assert.deepEqual([state.from, state.to, state.userRequested], ['waiting', 'done', true]);
    assert.equal(state.fields['task.title'], 'Updated title');
    assert.equal(matches(db, { event: 'task.state_changed',
      where: { from: ['waiting', 'stopped'], to: ['done', 'error'], userRequestedOnly: true } }, state), true);
    assert.equal(matches(db, { event: 'task.state_changed',
      where: { from: 'doing', to: 'done' } }, state), false);
    assert.equal(matches(db, { event: 'task.message',
      where: { by: 'human', type: 'accept' } }, words), true);
    assert.deepEqual(readTaskEventReference(db, 'P999', approval.id), []);
    for (const hold of history.filter(entry => entry.stage?.action === 'hold' || entry.stage?.action === 'unhold'))
      assert.deepEqual(readTaskEventReference(db, flow.project, hold.id), []);
  });
});

test('message filters see the fixed question, answer and send-back text', async t => {
  const flow = await taskFlow(t);
  const question = await flow.work(await flow.task('Question task', {
    values: { decide: [{ decide_kind: 'choose', decide_question: 'Full question marker' }] },
  }));
  const noteHash = (await flow.get(question.id)).hash;
  withControlWrite(flow.root, tx => comment(tx, { actor: { kind: 'placement', placementId: question.placementId },
    runId: question.runId, taskId: question.id, opId: randomUUID(), expectedTaskHash: noteHash, title: 'Ordinary note marker' }));
  const asked = await flow.ask(question);
  const answered = await flow.answer(question.id, asked);
  assert.equal(answered.outcome.kind, 'answered');

  const review = await flow.work(await flow.task('Review task', { userRequested: true }));
  await flow.report(review, 'done');
  flow.end(review);
  const ref = randomUUID();
  await new TaskRequestService(flow.root).request({ task: review.id, opId: ref,
    expectedTaskHash: (await flow.get(review.id)).hash,
    expectedPlacementRevision: flow.store(store => store.getPlacement(review.placementId)!.revision),
    newConversation: true, body: 'Request the change with a send-back marker.' }, human, human);

  flow.store(({ connection: db }) => {
    const messages = [...recentTaskEvents(db, flow.project, '1970-01-01T00:00:00Z', '2099-01-01T00:00:00Z')]
      .filter(event => event.event === 'message_received');
    assert.deepEqual(messages.filter(event => matches(db, { event: 'task.message',
      where: { by: 'ai', type: ['question', 'report'], contains: 'Full question marker' } }, event))
      .map(event => event.key), [asked]);
    assert.equal(messages.some(event => matches(db, { event: 'task.message',
      where: { by: 'ai', type: 'report', contains: 'Ordinary note marker' } }, event)), false);
    const replies = messages.filter(event => matches(db, { event: 'task.message',
      where: { by: 'human', type: ['answer', 'send_back'] } }, event));
    assert.deepEqual(replies.map(event => [event.type, event.fields['event.description']]), [
      ['send_back', 'Request the change with a send-back marker.'], ['answer', 'This way'],
    ]);
    assert.equal(replies[0]!.key, ref);
    assert.equal(matches(db, { event: 'task.message',
      where: { by: 'human', type: 'answer', contains: 'send-back marker' } }, replies[0]!), false);
  });
});

test('an automation descendant cannot trigger AI from its words even after a move', async t => {
  const flow = await taskFlow(t);
  const automated = withControlWrite(flow.root, tx => ControlTaskCommands.createAutomationTask(tx, {
    project: flow.project, title: 'Automation task', awaitReview: false,
    origin: { automationId: 'A1', revision: 1, runNumber: 1, name: 'Example automation' },
  }));
  await assignResponsible(flow.root, await flow.get(automated.id), 'fake');
  const child = await flow.task('Descendant', { parentId: automated.id });
  await flow.commands.move({ id: child.id, parentId: flow.project, expectedTaskHash: (await flow.get(child.id)).hash });
  const seat = await flow.work(child);
  const asked = await flow.ask(seat);
  flow.store(({ connection: db }) => {
    const [event] = readTaskEventReference(db, flow.project, asked);
    assert.ok(event && event.event === 'message_received');
    assert.equal(matches(db, { event: 'task.message',
      where: { by: 'ai', type: 'question' } }, event), false);
  });
});
