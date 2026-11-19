/** Real coordinator HTTP context cases; independent private fixtures. */
/**
 * The screen's coordinator conversation through serve: /api/coordinator, and what it records (each message a Request
 * of the conversation answered by a coordinator Run, the warm-up apart).
 */
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { questionFact, messageTarget } from './helpers/coordinator-question-fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore } from '@alpacawork/runs';
import { taskHistoryWindowSchema } from '@alpacawork/contract/control';
import { touch } from '@alpacawork/db';
import { messagePart, eventually, records, fixture, boundaryEvidence, assertQuestionContext } from './helpers/coordinator-http-fixture.ts';

test('a press goes as the words the screen showed, with its intent and versions as the screen operation; serve adds no words', async t => {
  const h = await fixture(t), conversationId = (await h.get()).id, id = crypto.randomUUID();
  const intent = { task: h.project, action: 'continue', expectedTaskHash: 'a'.repeat(64), expectedPlacementRevision: 3 };
  const text = 'Please proceed with this';
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id, text, tasks: [h.project], attachments: [], intent })).status, 200);
  const answer = JSON.parse((await h.done(id)).answer!);
  assert.equal(messagePart(answer.prompt), `${text}\nScreen action: ${JSON.stringify(intent)}`,
    'the agent is given the screen\'s words, then the operation as it was pressed');
  const [stored] = h.records(conversationId);
  assert.equal(stored?.body, text, 'the Request keeps only the words the person saw');
  const turn = (await h.get()).turns.find(item => item.id === id)!;
  assert.equal(turn.ask, text); assert.deepEqual(turn.intent, intent, 'the conversation shows the same operation');
  // An operation the screen cannot make, or one carrying words of its own, is refused before anything is admitted.
  for (const refused of [...['approve', 'hold', 'unhold', 'stop', 'merge'].map(action => ({ ...intent, action })), { ...intent, expectedTaskHash: 'not-a-digest' }, { ...intent, text: 'approve it' }])
    assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: crypto.randomUUID(), text, attachments: [], intent: refused })).status, 400);
  assert.equal(h.records(conversationId).length, 1);
});

test('a draft that answers questions goes with each question it answers, by its Task and ID, as a line of its own', async t => {
  const h = await fixture(t), conversationId = (await h.get()).id, id = crypto.randomUUID();
  // The old question was replaced while the person composed replies to both fixed question IDs.
  const task = messageTarget(h.root, h.project);
  questionFact(h.root, task, 'L-first'); questionFact(h.root, task, 'L-second');
  const answers = ['L-first', 'L-second'].map(question => ({ task, question }));
  const text = `${task}（Title） 1-option1 1-option2`;
  const message = { conversationId, id, text, tasks: [task], attachments: [], answers };
  assert.equal((await h.post('/api/coordinator/messages', message)).status, 200);
  const answer = JSON.parse((await h.done(id)).answer!);
  assert.equal(messagePart(answer.prompt), `${text}\nQuestions being answered: ${JSON.stringify(answers)}`,
    'the agent is given each question the words answer');
  const turn = (await h.get()).turns.find(item => item.id === id)!;
  assert.deepEqual(turn.answers, answers, 'the conversation shows the same questions');
  assert.equal(turn.intent, undefined, 'answering is not a press');
  assert.equal((await h.post('/api/coordinator/messages', { ...message, id: crypto.randomUUID(), answers: [{...answers[0],expectedTaskHash:'b'.repeat(64)}] })).status,400,
    'answers do not accept version guards');

  assert.equal((await h.post('/api/coordinator/messages', message)).status, 200, 'sent again as it was, it is the same message');
  assert.equal((await h.post('/api/coordinator/messages', { ...message, answers: answers.slice(1) })).status, 409,
    'the same words answering another question are other input');
  // A choice is not a press, and an empty list says nothing.
  for (const refused of [{ answers: [] }, { answers: undefined, intent: { task: h.project, action: 'choice', question: 'L-first' } }])
    assert.equal((await h.post('/api/coordinator/messages', { ...message, id: crypto.randomUUID(), ...refused })).status, 400);
  assert.equal(h.records(conversationId).length, 1);
});

test('question references remain context after closure; admitted IDs replay without answering the Task', async t => {
  const h = await fixture(t), conversationId = (await h.get()).id;
  const questionTask = messageTarget(h.root, h.project);
  questionFact(h.root, questionTask, 'open-user'); questionFact(h.root, questionTask, 'open-parent', { askedTo: h.project });
  const message = { conversationId, id: crypto.randomUUID(), text: 'My answer', tasks: [questionTask], attachments: [],
    answers: [{ task: questionTask, question: 'open-user' }] };
  await assertQuestionContext(h, questionTask, message);
  questionFact(h.root, questionTask, 'withdrawn', { closes: 'open-user' });
  const admitted = h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id }));
  assert.equal((await h.post('/api/coordinator/messages', message)).status, 200, 'same input checks the admitted ID, not a new answer');
  assert.deepEqual(h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id })), admitted);
  await assertQuestionContext(h, questionTask, { ...message, id: crypto.randomUUID() });
  const beforeRefusals = boundaryEvidence(h.root, questionTask, conversationId);
  for (const [question, status] of [['open-parent', 403], ['absent', 404]] as const) {
    // One invalid reference rejects the whole draft, including any valid earlier references.
    const response = await h.post('/api/coordinator/messages', { ...message, id: crypto.randomUUID(),
      answers: [...message.answers, { task: questionTask, question }] });
    assert.equal(response.status, status);
    assert.deepEqual(boundaryEvidence(h.root, questionTask, conversationId), beforeRefusals);
  }
  const beforeConflict = h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id }));
  assert.equal((await h.post('/api/coordinator/messages', { ...message, answers: [{ task: questionTask, question: 'absent' }] })).status, 409);
  assert.deepEqual(h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id })), beforeConflict);
  assert.equal(beforeConflict.length, 2, 'each new message has one Request and coordinator Run; replay adds neither');
  t.diagnostic(JSON.stringify({ contextReplayFixture: boundaryEvidence(h.root, questionTask, conversationId) }));
});

test('the screen records only frozen explicit targets, answer choices and reader intents', async t => {
  const h = await fixture(t), conversation = await h.get();
  const questionTask = messageTarget(h.root, h.project); questionFact(h.root, questionTask, 'Q1');
  const cases = [
    { name: 'prose reference is not a selected target', text: `Reference ${h.project}`, targets: [], meaning: {} },
    { name: 'explicit selection', text: 'Please explain', targets: [h.project], meaning: { tasks: [h.project] } },
    { name: 'answer choice', text: '1-A', targets: [questionTask], meaning: { answers: [{ task: questionTask, question: 'Q1' }] } },
    ...(['sendback', 'continue', 'retry'] as const).map(action => ({
      name: action, text: action, targets: [h.project], meaning: { intent: { task: h.project, action } },
    })),
  ];
  for (const item of cases) {
    const id = crypto.randomUUID();
    assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id, text: item.text,
      attachments: [], ...item.meaning })).status, 200, item.name);
    assert.equal((await h.done(id)).status, 'succeeded', item.name);
    const store = RunStore.openReadable(h.root, { busyTimeoutMs: 1000 });
    assert.ok(store);
    try {
      const targets = store.connection.prepare(`SELECT k.external_id FROM task_dialogues d JOIN tasks k ON k.id = d.task_uuid
        WHERE d.request_id = ?`).all(id).map(row => row.external_id);
      assert.deepEqual(targets, item.targets, item.name);
    } finally { store.close(); }
  }
  const id = crypto.randomUUID(), input = { conversationId: conversation.id, id, text: 'Selected', attachments: [], tasks: [h.project, h.project] };
  assert.equal((await h.post('/api/coordinator/messages', input)).status, 200);
  assert.equal((await h.post('/api/coordinator/messages', { ...input, tasks: [h.project] })).status, 200, 'set duplicates do not change the input');
  assert.equal((await h.post('/api/coordinator/messages', { ...input, tasks: undefined })).status, 409, 'removing the selected target changes the input');
  await h.done(id);
  // An ID written in pasted words with no Task (a sample's number) neither refuses the message nor links it.
  const written = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { ...input, id: written, text: 'See T99999 and the project', tasks: ['T99999', h.project] })).status, 200);
  assert.equal((await h.done(written)).status, 'succeeded');
  const store = RunStore.openReadable(h.root, { busyTimeoutMs: 1000 });
  assert.ok(store);
  try {
    assert.deepEqual(store.connection.prepare(`SELECT k.external_id FROM task_dialogues d JOIN tasks k ON k.id = d.task_uuid
      WHERE d.request_id = ?`).all(written).map(row => row.external_id), [h.project]);
  } finally { store.close(); }
  // What the message acts on still has to exist.
  const pressed = await h.post('/api/coordinator/messages', { ...input, id: crypto.randomUUID(), tasks: undefined, intent: { task: 'T99999', action: 'continue' } });
  assert.equal(pressed.status, 404); assert.equal((await pressed.json()).error.reason.kind, 'task_does_not_exist');
});

test('a withdrawn message keeps its frozen explicit targets and replies cancelled even for changed input', async t => {
  const h = await fixture(t), conversation = await h.get(), head = crypto.randomUUID(), id = crypto.randomUUID();
  const gate = join(h.root, 'review-withdraw-gate');
  assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id: head,
    text: `wait:${gate}`, attachments: [] })).status, 200);
  await h.agentOf(conversation.id, head);
  try {
    const input = { conversationId: conversation.id, id, text: 'Explain selected', attachments: [], tasks: [h.project] };
    assert.equal((await h.post('/api/coordinator/messages', input)).status, 200);
    assert.equal((await h.post('/api/coordinator/messages/withdraw', { conversationId: conversation.id, id })).status, 200);
    assert.equal((await h.post('/api/coordinator/messages', input)).status, 200);
    assert.equal((await h.post('/api/coordinator/messages', { ...input, tasks: ['P1'] })).status, 200,
      'cancellation wins over any later payload; the original Request and Run stay unchanged');
    const stored = h.records(conversation.id).find(record => record.id === id)!;
    assert.equal(stored.run?.role, 'coordinator');
    if (stored.run?.role === 'coordinator') assert.deepEqual(stored.run.message.tasks, [h.project]);
  } finally { writeFileSync(gate, 'release'); await h.done(head); }
});

test('explicit dialogues and their answers refresh history without changing Task revision', async t => {
  const h = await fixture(t), conversation = await h.get(), id = crypto.randomUUID();
  const history = async () => {
    const response = await fetch(new URL(`/api/task/history?task=${h.project}&mode=latest`, h.url()));
    assert.equal(response.status, 200);
    return taskHistoryWindowSchema.parse(await response.json());
  };
  const before = await history();
  const store = RunStore.openReadable(h.root, { busyTimeoutMs: 1000 })!;
  const revision = () => store.connection.prepare('SELECT revision FROM tasks WHERE external_id=?').get(h.project)?.revision;
  const originalRevision = revision(), gate = join(h.root, 'history-gate');
  t.after(() => store.close());
  // Hold receipt projection while the real agent reads its input: ready is not yet a history link.
  const importer = t.mock.method(RunEventImporter.prototype, 'pass', () => []);
  try {
    assert.equal((await h.post('/api/coordinator/messages', { conversationId: conversation.id, id,
      text: `wait:${gate}`, attachments: [], tasks: [h.project] })).status, 200);
    await h.agentOf(conversation.id, id);
    importer.mock.restore();
    // Reading the input and importing its dialogue link are separate physical boundaries.
    await eventually(async () => (await history()).events.some(event => event.kind === 'dialogue' && event.taskId === h.project && event.title === `wait:${gate}` && event.summary === ''), 'history must show the admitted dialogue', 3000);
    const pending = await history();
    assert.ok(pending.sourcePv > before.sourcePv, 'the admitted dialogue advances the published history');
    writeFileSync(gate, 'release');
    const turn = await h.done(id);
    await eventually(async () => (await history()).events.some(event => event.kind === 'dialogue' && event.title === `wait:${gate}` && event.summary === turn.answer),
      'history must show the completed answer', 3000);
    assert.ok((await history()).sourcePv > pending.sourcePv, 'answer completion advances the published history');
    assert.equal(revision(), originalRevision, 'coordinator history does not edit the Task to force an update');
  } finally { importer.mock.restore(); writeFileSync(gate, 'release'); await h.done(id); }
});

test('viewing context is refused as screen input and a general URL question has no targets', async t => {
  const h = await fixture(t), conversationId = (await h.get()).id;
  const text = `PWA cache? Reference https://example.test/?task=${h.project}`;
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: crypto.randomUUID(), text,
    context: h.project, attachments: [] })).status, 400, 'viewing metadata is no longer an input');
  const id = crypto.randomUUID();
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id, text, attachments: [] })).status, 200);
  const turn = await h.done(id), result = JSON.parse(turn.answer!);
  assert.equal(messagePart(result.prompt), text, 'no hidden viewing prefix reaches the agent');
  assert.equal('context' in turn, false);
  const historyResponse = await fetch(new URL(`/api/task/history?task=${h.project}&mode=latest`, h.url()));
  assert.equal(historyResponse.status, 200);
  assert.deepEqual(taskHistoryWindowSchema.parse(await historyResponse.json()).events.filter(event => event.kind === 'dialogue'), []);
  const store = RunStore.openReadable(h.root, { busyTimeoutMs: 1000 })!;
  try { assert.equal(store.connection.prepare(`SELECT count(*) AS n FROM task_dialogues d
    WHERE d.request_id=?`).get(id)?.n, 0); }
  finally { store.close(); }
});

for (const state of ['doing', 'done'] as const) test(`explicit recipient outside live rows (${state}) is admitted`, async t => {
  const h = await fixture(t), conversationId = (await h.get()).id;
  const viewed = await (await fetch(new URL('/api/workspace/live', h.url()))).json();
  const task = messageTarget(h.root, h.project, state);
  assert.equal(viewed.tasks.some(row => row.id === task), false, 'explicit target was outside the last acquired live list');
  const current = await (await fetch(new URL('/api/workspace/live', h.url()))).json();
  if (state === 'done') assert.equal(current.tasks.some(row => row.id === task), false, 'closed recipient is outside the current live list too');
  // Demand no Task detail. The selected recipient is an ID, independent of a mounted/listed row.
  const id = crypto.randomUUID(), input = { conversationId, id, text: 'Explain selected', tasks: [task], attachments: [] };
  const accepted = await h.post('/api/coordinator/messages', input);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await h.done(id)).status, 'succeeded');
  t.diagnostic(JSON.stringify({ state, task, viewed: viewed.tasks.map(row => row.id), current: current.tasks.map(row => row.id), db: boundaryEvidence(h.root, task, conversationId) }));
});

for (const scenario of ['closed', 'expired', 'missing', 'askedTo'] as const)
  test(`GET then ${scenario}: admission and CLI use the same reply eligibility`, async t => {
    const h = await fixture(t), destination = scenario === 'askedTo' ? messageTarget(h.root, h.project) : h.project;
    const task = messageTarget(h.root, destination), conversationId = (await h.get()).id;
    const question = 'Q-' + scenario;
    if (scenario !== 'missing') questionFact(h.root, task, question, { askedTo: scenario === 'askedTo' ? destination : null });
    const get = await fetch(new URL(`/api/task/view?task=${task}`, h.url()));
    assert.equal(get.status, 200); const observed = await get.json();
    if (scenario !== 'missing') assert.ok(observed.questions.some(q => q.id === question));
    if (scenario === 'closed') questionFact(h.root, task, question + '-close', { closes: question });
    if (scenario === 'expired') questionFact(h.root, task, question + '-stop', { expires: true });
    const currentResponse = await fetch(new URL(`/api/task/view?task=${task}`, h.url()));
    assert.equal(currentResponse.status, 200);
    const current = await currentResponse.json(), reference = current.questions.find(q => q.id === question);
    if (scenario === 'missing') assert.equal(reference, undefined);
    else if (scenario === 'askedTo') assert.deepEqual(reference.destination, { kind: 'task', taskId: destination });
    else assert.equal(reference.state, scenario === 'closed' ? 'withdrawn' : 'expired');
    const id = crypto.randomUUID();
    const input = { conversationId, id, text: '1-Yes', tasks: [task], attachments: [], answers: [{ task, question }] };
    const before = boundaryEvidence(h.root, task, conversationId);
    if (scenario === 'closed') await assertQuestionContext(h, task, input);
    else {
      const refused = await h.post('/api/coordinator/messages', input);
      assert.equal(refused.status, scenario === 'missing' ? 404 : scenario === 'askedTo' ? 403 : 409);
      assert.equal((await refused.json()).error.code, scenario === 'missing' ? 'not_found' : scenario === 'askedTo' ? 'forbidden' : 'question_expired');
      assert.deepEqual(boundaryEvidence(h.root, task, conversationId), before,
        'refused references create neither a Request nor a Run nor an answer');
    }
    // Posting words never itself saves the answer. Exercise the sole save Owner through the person's CLI.
    const operation = crypto.randomUUID();
    const cli = await cliRun(h.url(), ['task', 'request', '--task', task, '--answers', question,
      '--instruction-file', '-', '--op-id', operation], {}, 'Actual answer words');
    if (scenario === 'closed') {
      assert.equal(cli.code, 0, cli.stderr);
      const result = JSON.parse(cli.stdout);
      assert.equal(result.outcome.kind, 'request_accepted', 'late words are a new instruction, not a second answered event');
      assert.equal(result.outcome.answers, question);
      const after = await (await fetch(new URL(`/api/task/view?task=${task}`, h.url()))).json();
      assert.equal(after.questions.find(q => q.id === question).state, 'withdrawn');
    } else {
      assert.equal(cli.code, 2, cli.stderr); // The CLI's documented exit for a refused Problem.
      assert.equal(JSON.parse(cli.stderr).error.code, scenario === 'missing' ? 'not_found' : scenario === 'askedTo' ? 'forbidden' : 'question_expired');
      assert.deepEqual(boundaryEvidence(h.root, task, conversationId).canonical, before.canonical,
        'a refused actual answer leaves the Task log unchanged');
    }
    t.diagnostic(JSON.stringify({ scenario, id, get: observed.questions, current: current.questions,
      before, cli, db: boundaryEvidence(h.root, task, conversationId) }));
  });

test('consecutive replies to one Task keep their fixed question identity after the first answer', async t => {
  const h = await fixture(t), task = messageTarget(h.root, h.project), conversationId = (await h.get()).id;
  const question = 'consecutive-question';
  questionFact(h.root, task, question);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const input = (id: string) => ({ conversationId, id, text: 'Please proceed', tasks: [task], attachments: [], answers: [{ task, question }] });
  const first = await h.post('/api/coordinator/messages', input(ids[0]!));
  assert.equal(first.status, 200);
  const saved = await cliRun(h.url(), ['task', 'request', '--task', task, '--answers', question,
    '--instruction-file', '-', '--op-id', crypto.randomUUID()], {}, 'First answer');
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).outcome.kind, 'answered');
  const second = await h.post('/api/coordinator/messages', input(ids[1]!));
  assert.equal(second.status, 200, await second.clone().text());
  const followup = await cliRun(h.url(), ['task', 'request', '--task', task, '--answers', question,
    '--instruction-file', '-', '--op-id', crypto.randomUUID()], {}, 'Second answer');
  assert.equal(followup.code, 0, followup.stderr);
  assert.deepEqual([JSON.parse(followup.stdout).outcome.kind, JSON.parse(followup.stdout).outcome.answers], ['request_accepted', question]);
  const evidence = boundaryEvidence(h.root, task, conversationId);
  assert.equal(evidence.canonical.filter(entry => entry?.kind === 'answered' && entry.questionId === question).length, 1);
  for (const id of ids) {
    assert.equal(h.records(conversationId).filter(row => row.id === id).length, 1);
    await h.done(id);
  }
});

for (const withdrawn of [false, true]) test(`strict accepted replay after question closure, withdrawn=${withdrawn}, never duplicates`, async t => {
  const h = await fixture(t), task = messageTarget(h.root, h.project), conversationId = (await h.get()).id;
  questionFact(h.root, task, 'replay-Q1'); questionFact(h.root, task, 'replay-Q2');
  const gate = join(h.root, 'replay-gate'), head = crypto.randomUUID();
  await h.post('/api/coordinator/messages', { conversationId, id: head, text: `wait:${gate}`, attachments: [] });
  try {
    await h.agentOf(conversationId, head);
    const id = crypto.randomUUID(), input = { conversationId, id, text: '1-Yes', tasks: [task], attachments: [], answers: [{ task, question: 'replay-Q1' }] };
    const first = await h.post('/api/coordinator/messages', input); assert.equal(first.status, 200);
    questionFact(h.root, task, 'replay-stop', { expires: true });
    if (withdrawn) assert.equal((await h.post('/api/coordinator/messages/withdraw', { conversationId, id })).status, 200);
    const before = h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id, delivery: row.deliveryState }));
    const replay = await h.post('/api/coordinator/messages', input); assert.equal(replay.status, 200);
    const after = h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id, delivery: row.deliveryState }));
    assert.deepEqual(after, before); assert.equal(after.filter(row => row.id === id).length, 1);
    const fresh = await h.post('/api/coordinator/messages', { ...input, id: crypto.randomUUID() });
    assert.equal(fresh.status, 409, 'expiry rejects a new operation while preserving an accepted replay');
    assert.equal((await fresh.json()).error.code, 'question_expired');
    assert.deepEqual(h.records(conversationId).map(row => ({ id: row.id, run: row.run?.id, delivery: row.deliveryState })), after);
    assert.equal((await h.post('/api/coordinator/messages', { ...input, answers: [{ task, question: 'replay-Q2' }] })).status, withdrawn ? 200 : 409);
    t.diagnostic(JSON.stringify({ withdrawn, accepted: id, before, after, replay: await replay.json(), db: boundaryEvidence(h.root, task, conversationId) }));
  } finally { writeFileSync(gate, 'release'); await h.done(head); }
});

test('historical operation JSON is readable without becoming a live coordinator intent', async t => {
  const h = await fixture(t), conversationId = (await h.get()).id, id = crypto.randomUUID();
  await h.post('/api/coordinator/messages', { conversationId, id, text: 'An archived operation', attachments: [] });
  await h.done(id);
  const old = h.records(conversationId).find(item => item.id === id)!.run!;
  const record = { ...old, message: { context: null, attachments: [], intent: { task: h.project, action: 'archived-operation', previousMeaning: { any: true } } } };
  const store = RunStore.openExisting(h.root, { busyTimeoutMs: 1000 });
  assert.ok(store);
  try {
    store.write(() => {
      store.connection.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), Number(old.id.slice(1)));
      touch(store.connection, { kind: 'run', id: old.id });
    });
  }
  finally { store.close(); }
  assert.deepEqual((await h.get()).turns.find(turn => turn.id === id)!.intent, record.message.intent);
  assert.equal((await h.post('/api/coordinator/messages', { conversationId, id: crypto.randomUUID(), text:'Do not execute history', attachments:[], intent:record.message.intent })).status, 400);
});
