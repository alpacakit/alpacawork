/** Real CLI/API questions keep their original identity while the human reads them at the project-direct Task. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { taskFlow, type Seat } from './task-flow.fixture.ts';
import { call, textFile } from './helpers/cli-session.ts';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { readControlTree } from './helpers/control-tree.ts';
import { readWorkspaceProjection } from './helpers/workspace-projection.ts';
import { deriveEvents } from '@alpacawork/backend/test-dist/receiver/push.js';
import { taskProjectedViewSchema } from '@alpacawork/contract/control';
import { defaultSettings } from '@alpacawork/contract';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

async function fixture(t: Parameters<typeof taskFlow>[0]) {
  let cleanup!: () => void;
  let close: (() => Promise<void>) | undefined;
  const f = await taskFlow({ after: fn => { cleanup = fn; } });
  t.after(async () => { try { await close?.(); } finally { cleanup(); } });
  const top = await f.task('Top'), parent = await f.work(top);
  const child = await f.task('Child', { parentId: top.id });
  const owner = await f.work(child, parent);
  const leaf = await f.task('AI-created leaf', { parentId: child.id });
  const worker = await f.work(leaf, owner);
  const interval = globalThis.setInterval;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) =>
    interval(callback, ms === POLL_INTERVAL_MS ? 3_600_000 : ms, ...args)) as typeof setInterval;
  let server: Awaited<ReturnType<typeof startServer>>;
  try { server = await startServer(f.root, 0); } finally { globalThis.setInterval = interval; }
  close = () => server.close();
  const env = (seat: Seat) => ({ ALPACAWORK_RUN: seat.runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(f.root, seat.runId) });
  const current = (id: string, ...options: string[]) => call(server.url, ['task', 'get', '--task', id, ...options]);
  const ask = async (seat: Seat, to?: string) => {
    const id = randomUUID();
    await call(server.url, ['task', 'report', '--task', seat.id, '--state', 'waiting',
      ...(to === undefined ? [] : ['--ask-to', to]), '--title', 'Choose', '--description-file', textFile('Please decide'), '--op-id', id,
      '--expected-task-hash', (await current(seat.id)).task.hash], env(seat));
    return id;
  };
  const hRevision = (id: string) => f.store(store => store.readPlacements(reader => reader.responsiblePlacement(id)))!.revision;
  const answerInputs = new Map<string, string[]>();
  const answer = async (task: string, question: string, seat?: Seat, op = randomUUID()) => {
    const args = answerInputs.get(op) ?? ['task', 'request', '--task', task, '--answers', question, '--instruction-file', textFile('Approved scope'), '--op-id', op,
];
    answerInputs.set(op, args);
    return call(server.url, args, seat ? env(seat) : {});
  };
  const view = async (task: string) => {
    const response = await fetch(new URL(`/api/task/view?task=${task}`, server.url));
    assert.equal(response.status, 200);
    return taskProjectedViewSchema.parse(await response.json());
  };
  let projection: Awaited<ReturnType<typeof readWorkspaceProjection>>;
  const feed = { history: (id: string) => projection.history(id) };
  const refresh = async () => {
    projection = await readWorkspaceProjection(f.root);
    return readControlTree(f.root, { project: f.project });
  };
  return { f, top, parent, child, owner, leaf, worker, server, env, current, ask, answer, view, feed, refresh };
}

test('CLI requires a chosen recipient; Q1 to parent and Q2 to user retain separate answer authority and W3', async t => {
  const h = await fixture(t);
  await assert.rejects(h.ask(h.owner), { code: 'invalid_input' });
  assert.equal((await h.current(h.child.id)).questions.length, 0);
  const q1 = await h.ask(h.owner, h.top.id);
  const q2 = await h.ask(h.parent, 'user');
  assert.equal((await h.current(h.child.id)).questions[0].destination.taskId, h.top.id, 'userRequested does not choose the recipient');
  await assert.rejects(h.answer(h.child.id, q1), { code: 'forbidden' });
  const top = await h.view(h.top.id);
  assert.deepEqual(top.userQuestions?.map(q => [q.taskId, q.id]), [[h.top.id, q2]], 'Q1 is not a human question');
  await h.answer(h.top.id, q2);
  assert.equal((await h.current(h.child.id)).questions[0].id, q1, 'Q2 answer cannot close Q1');
  await h.answer(h.child.id, q1, h.parent);
  const records = (await h.current(h.child.id, '--include', 'closedQuestions')).questions;
  assert.deepEqual(records.map(q=>q.state), ['answered']);
  const returns = h.f.store(store => store.readReturns());
  for (const [id, question] of [[h.top.id, q2], [h.child.id, q1]]) {
    const task = await h.f.get(id);
    const answer = task.meta.log.find(log => log.kind === 'answered' && log.questionId === question)!;
    assert.ok(returns.some(item => item.toTaskId === id && item.outcome === 'answer' && item.causeLogId === answer.id),
      'W3 notice is addressed to the original asking Task');
  }
});

test('human questions stay on their own Task; a child finishes without review and project-level reviews stay local', async t => {
  const h=await fixture(t);
  const q=await h.ask(h.worker,'user');
  assert.deepEqual((await h.view(h.top.id)).userQuestions,[]);
  assert.deepEqual((await h.view(h.leaf.id)).userQuestions?.map(q=>q.id),[q]);
  const tree=await h.refresh();
  assert.ok(deriveEvents(new Set(),tree.tasks,tree.balls,{...defaultSettings(),'push.question':true})
    .some(e=>e.payload.url===`/?task=${h.leaf.id}`));
  const history=async(id:string)=>{await h.refresh();return h.feed.history(id).events;};
  assert.ok(!(await history(h.child.id)).some(e=>e.id===q));
  await h.answer(h.leaf.id,q);
  assert.ok(!(await history(h.child.id)).some(e=>e.id===q));
  const resumed=await h.f.receive(h.worker);
  await h.f.report(resumed,'done');h.f.end(resumed);
  assert.equal((await h.current(h.leaf.id)).task.state,'done');
  assert.deepEqual((await h.view(h.leaf.id)).userReviews,[]);
  const review=await h.f.task('User review',{userRequested:true}), owner=await h.f.work(review);
  await h.f.report(owner,'done');h.f.end(owner);
  const mark=(await h.view(review.id)).userReviews![0]!;
  assert.deepEqual((await h.view(h.top.id)).userReviews,[]);
  assert.ok(!(await history(h.child.id)).some(e=>e.id===mark.id));
  await h.f.confirm(review.id,owner.runId);
  assert.ok(!(await history(h.child.id)).some(e=>e.id===mark.id));
});
test('ancestor consultations remain in parent History while a newer human question withdraws the consultation', async t => {
  const h=await fixture(t), q=await h.ask(h.worker,h.child.id);
  await h.refresh(); assert.ok(h.feed.history(h.child.id).events.some(e=>e.id===q));
  const current=await h.ask(h.worker,'user');
  assert.equal((await h.current(h.leaf.id)).questions.find(q=>q.id===current)?.state,'open');
  const accepted=await h.answer(h.leaf.id,q,h.owner);
  assert.deepEqual([accepted.outcome.kind,accepted.outcome.answers],['request_accepted',q]);
  await h.refresh(); assert.ok(h.feed.history(h.child.id).events.some(e=>e.id===q));
});

test('Core: a leaf asks a distant ancestor, rejects invalid seats and supplies all open incoming questions independently of carried notices', async t => {
  const h = await fixture(t);
  const other = await h.f.task('Sibling branch');
  const before = (await h.current(h.leaf.id)).task.hash;
  for (const to of ['parent', h.leaf.id, h.f.project, other.id]) await assert.rejects(h.ask(h.worker, to), { code: 'invalid_input' });
  assert.equal((await h.current(h.leaf.id)).task.hash, before, 'invalid destination has no log or state effect');
  const q1 = await h.ask(h.worker, h.top.id), q2 = await h.ask(h.owner, h.top.id);
  const top = await h.current(h.top.id);
  assert.deepEqual(new Set(top.incomingQuestions.map((q: { id: string }) => q.id)), new Set([q1, q2]));
  assert.equal((await h.current(h.child.id)).incomingQuestions.length, 0, 'intermediate parent is not the answering seat');
  await assert.rejects(h.answer(h.leaf.id, q1, h.owner), { code: 'forbidden' });
  const { readControlSource } = await import('@alpacawork/backend/test-dist/control/task-views.js');
  const { startText } = await import('@alpacawork/backend/test-dist/control/start-text.js');
  const { readTaskContexts } = await import('@alpacawork/backend/test-dist/control/task-context.js');
  const { readControl } = await import('@alpacawork/backend/test-dist/control/task-store.js');
  const read = await readControlSource(h.f.root);
  const source = { ...read, contexts: readControl(h.f.root, db => readTaskContexts(db, read.tree)) };
  const prompt = startText({ source, taskId: h.top.id, responsible: true, mode: 'new', at: new Date().toISOString(), body: 'Handover', since: null, carried: [] });
  assert.ok(prompt.includes(q1) && prompt.includes(q2), 'open incoming questions are supplied independently of carried notifications');
  await h.answer(h.leaf.id, q1, h.parent);
  assert.equal((await h.current(h.top.id)).incomingQuestions.length, 1);
  const question = await call(h.server.url, ['task', 'get', '--task', h.leaf.id, '--question', q1]);
  assert.deepEqual(question.question.destination, { kind: 'task', taskId: h.top.id });
  assert.equal(question.question.answer, 'Approved scope');
  assert.ok((await h.current(h.child.id)).relevantAnswers.some((item: {id:string}) => item.id === q1));
  await h.f.commands.move({ id: h.leaf.id, parentId: other.id, expectedTaskHash: (await h.current(h.leaf.id)).task.hash });
  assert.equal((await h.current(h.child.id)).relevantAnswers.length, 0);
  assert.equal((await h.current(other.id)).relevantAnswers.length, 0, 'an answer outside the current fixed-seat path is only historical context');
});

test('answer identity ignores unrelated changes; moving an open ancestor question expires its fixed seat', async t => {
  const h=await fixture(t), q=await h.ask(h.worker,h.top.id);
  await h.f.commands.update({id:h.leaf.id,title:'New version',expectedTaskHash:(await h.f.get(h.leaf.id)).hash});
  const op=randomUUID();
  await h.answer(h.leaf.id,q,h.parent,op);await h.answer(h.leaf.id,q,h.parent,op);
  const q2=await h.ask(h.worker,h.top.id), destination=await h.f.task('Destination');
  await h.f.commands.move({id:h.leaf.id,parentId:destination.id,expectedTaskHash:(await h.f.get(h.leaf.id)).hash});
  const detail=await call(h.server.url,['task','get','--task',h.leaf.id,'--question',q2]);
  assert.equal(detail.question.state,'expired');assert.equal(detail.question.closureReason,'destination_invalid');
  await assert.rejects(h.answer(h.leaf.id,q2,h.parent),{code:'question_expired'});
});

test('Core: archive suspends an open question without rewriting history; restore and past Run boundaries use the same applicability', async t => {
  const h = await fixture(t);
  const q = await h.ask(h.worker, h.top.id);
  h.f.end(h.worker);
  const beforeArchive = (await h.current(h.leaf.id)).questions.find((item: {id:string}) => item.id === q).askedAt;
  await h.f.commands.lifecycle({ id: h.leaf.id, action: 'archive', expectedTaskHash: (await h.f.get(h.leaf.id)).hash });
  assert.equal((await h.current(h.top.id)).incomingQuestions.length, 0);
  const detail = await call(h.server.url, ['task', 'get', '--task', h.leaf.id, '--question', q]);
  assert.equal(detail.question.state, 'open');
  assert.equal(detail.question.applicable, false);
  const { questionSnapshot, questionApplicable } = await import('@alpacawork/backend/test-dist/control/question-rules.js');
  const { ControlTaskStore } = await import('@alpacawork/backend/test-dist/control/task-store.js');
  const snapshot = questionSnapshot((await new ControlTaskStore(h.f.root).snapshot()).tasks);
  const asked = (await h.f.get(h.leaf.id)).meta.log.find(l => l.id === q)!;
  assert.equal(questionApplicable(h.leaf.id, asked, snapshot), false);
  assert.equal(questionApplicable(h.leaf.id, asked, snapshot, beforeArchive), true, 'later archive cannot erase a past wait');
  await h.f.commands.lifecycle({ id: h.leaf.id, action: 'restore', expectedTaskHash: (await h.f.get(h.leaf.id)).hash });
  assert.equal((await h.current(h.top.id)).incomingQuestions[0].id, q);
  assert.equal(h.f.store(s => s.readReturns()).filter(r => r.outcome === 'question' && r.causeLogId === q).length, 1, 'restoration does not reissue notices');
});

test('Core: a replacement owner receives an unanswered ancestor question after its notice was consumed, and the old owner loses answer authority', async t => {
  const h = await fixture(t);
  const q = await h.ask(h.worker, h.top.id);
  const received = await h.f.receive(h.parent);
  h.f.end(received);
  const { ReturnRouter } = await import('@alpacawork/backend/test-dist/control/return-router.js');
  await new ReturnRouter(h.f.root).pass(undefined, { project: h.f.project });
  const notice = h.f.store(s => s.readReturns()).find(r => r.outcome === 'question' && r.causeLogId === q)!;
  assert.ok(notice.deliveries.some(d => d.consumedAt), 'the first owner already consumed the notification');
  const { PlacementCommands } = await import('@alpacawork/backend/test-dist/control/placement-commands.js');
  const replacement = await new PlacementCommands(h.f.root).placeNewResponsible({ taskId: h.top.id,
    expectedTaskHash: (await h.f.get(h.top.id)).hash, profileKey: 'fake', replacePlacementId: h.parent.placementId,
    expectedPlacementRevision: h.f.store(s => s.getPlacement(h.parent.placementId)!.revision) }, { kind: 'human' });
  const next = await h.f.work({ id: h.top.id, placementId: replacement.placement.id });
  const prompt = h.f.store(s => s.getText(next.runId)!.prompt);
  assert.ok(prompt.includes(q), 'new owner gets all canonical incoming questions independently of disposed notices');
  assert.equal((await h.current(h.top.id)).incomingQuestions[0].id, q);
  await assert.rejects(h.answer(h.leaf.id, q, received), { code: 'forbidden' });
  await h.answer(h.leaf.id, q, next);
  assert.equal((await h.current(h.top.id)).incomingQuestions.length, 0);
});
