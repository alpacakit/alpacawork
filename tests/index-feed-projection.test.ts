import { controlRunFixture } from './helpers/control-run-fixture.ts';
import { inertFixtureLaunch } from './helpers/agent-stub.ts';
import type { RunRecord } from '@alpacawork/contract/run';

/**
 * History and timeline semantics over the published projection: records, authors, receiving ends, notes and windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupIndexFixture as setup } from './helpers/index-fixture.ts';
import {
  bodyHash, controlRunSchema, placementSchema, taskHistoryWindowSchema as taskHistorySchema,
  taskProjectedTimelineSchema as taskTimelineSchema, timelineNoteOf, type ControlTreeDTO,
} from '@alpacawork/contract/control';
import { canonicalValues, PARENT_VISIBLE_EVENTS, RESULT_HEAD_LENGTH, resultHead, type Ball, type TaskValues } from '@alpacawork/contract';
import { readControlTree } from './helpers/control-tree.ts';
import { snapshotReads } from './helpers/snapshot-projection.ts';

type Task = ControlTreeDTO['tasks'][number];
type Log = Task['log'][number];
type RequestDTO = ControlTreeDTO['requests'][number];

/** A log entry as the store keeps it: a person's record that keeps the state unless `fields` say otherwise. */
/** A log entry, a plain report unless given; a question asks its title unless the test says what (`decide`). */
const entry = (id: string, at: string, fields: Partial<Log> = {}): Log => ({ id, kind: 'reported', at, title: null,
  description: null, actor: { kind: 'human' }, fromState: null, toState: null,
  ...(fields.kind === 'asked' ? { decide: [{ decide_question: fields.title ?? 'Question' }] } : {}), ...fields });
const placement = { kind: 'placement', placementId: 'P1' } as const;
/** The user's ball, as the tree sends it: each reason with the detail it carries. */
const userBall = (reason: Extract<Ball, { holder: 'user' }>['reason'], key: string, at: string): Ball => ({ holder: 'user',
  reason, at, key, questionId: reason === 'question' ? key : null, aboutRunId: reason === 'review' ? 'R1' : null,
  count: reason === 'limit' ? 1 : null, code: reason === 'blocked' ? 'too_deep' : null, failure: null });
/** A Task made like `example` (a fixture Task), with its own ID, folder and facts. */
const like = (example: Task, id: string, fields: Partial<Task>): Task => ({ ...example, id, path: `tasks/${id}`, ...fields, baseState: fields.baseState ?? (fields.state === "held" ? "doing" : fields.state ?? example.baseState), hold: fields.hold ?? fields.state === "held" });
const runOf = (id: string, taskId: string, state: RunRecord['state'], at: string,
  endedAt: string | null = null, fields: Partial<RunRecord> = {}) =>
  controlRunFixture(id, { task: taskId, placementId: 'P1', agent: 'codex', requestId: `Q${id}`,
    cwd: '/fixture/run', state, reason: state === 'failed' ? 'exit' : state === 'cancelled' ? 'stopped' : null,
    created_at: at, started_at: state === 'queued' ? null : at, ended_at: endedAt, ...fields });
test('History: one row per record, the event it is and who wrote it, none made up; a parent sees the kinds PARENT_VISIBLE_EVENTS names and what was asked of its child', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => `2026-10-07T09:0${minute}:00.000Z`;
  const main = { kind: 'main', provider: 'claude', conversationId: 'C1' } as const;
  // Its creation, a link set by a Run and the state it set are no rows of their own.
  const log = [child.log[0]!, entry('Lcomment', at(0), { title: 'A note', description: 'Noted' }),
    entry('Llinked', at(1), { kind: 'linked', actor: placement, fromState: 'todo', toState: 'doing' }),
    entry('Lasked', at(2), { kind: 'asked', actor: placement, askedTo: null, title: 'Which one?', description: 'Pick one' }),
    entry('Lanswer', at(3), { kind: 'answered', actor: main, questionId: 'Lasked', title: 'This one' }),
    entry('Lopen', at(4), { kind: 'asked', actor: placement, askedTo: null, title: 'And then?', description: 'Still open' }),
    entry('Ldone', at(5), { actor: placement, title: 'Finished', fromState: 'doing', toState: 'done' })];
  const grandchild = like(child, 'T999', { parentId: child.id, log: [entry('Lgrand', at(6), { kind: 'asked', actor: placement,
    askedTo: child.id, title: 'Deeper?', description: 'Below' })] });
  // A wake carrying returns is no row: what it carries are their own records' rows.
  const request = (id: string, source: 'human' | 'returns', minute: number): RequestDTO => ({ id, taskId: child.id, placementId: 'P1',
    runId: null, purpose: source === 'returns' ? 'return_continuation' : 'instruction', author: { kind: 'human' }, recipientRole: null, mode: 'new', body: `Do ${id}\nIn detail`,
    submittedAt: at(minute), deliveryState: 'queued' });
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree,
    tasks: [...tree.tasks.map(task => task.id === child.id ? { ...task, state: 'done' as const, log } : task), grandchild],
    placements: [...tree.placements.filter(each => each.id !== 'P1'), placementSchema.parse({ id: 'P1', taskId: child.id, agentId: 'A1', profileKey: 'codex',
      responsible: true, active: true, revision: 1, startedAt: at(0), endedAt: null, headRunId: null,
      runtime: { displayState: 'idle', reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null } })],
    requests: [request('Q1', 'human', 1), request('Qret', 'returns', 6)],
    // The public DTO permits an unknown reason; keep that fact unknown for the state-title fallback.
    runs: [controlRunSchema.parse({ ...runOf('R10', child.id, 'failed', at(7), at(7)), reason: null }), runOf('R11', child.id, 'succeeded', at(7), at(7))],
    dialogues: [{ taskId: child.id, messageId: 'TURN1', at: at(8), words: 'Is it done?', answer: 'Yes' }] }));
  const events = taskHistorySchema.parse(feed.history(child.id)).events.filter(event => !event.fromChild);
  assert.deepEqual(events.map(event => [event.kind, event.id, event.by, event.open ?? null]), [
    ['dialogue', 'TURN1', null, null], ['error', 'R10', null, null], ['report', 'Ldone', null, null],
    ['question', 'Lopen', null, true], ['answer', 'Lanswer', 'main', null], ['question', 'Lasked', null, false],
    ['request', 'Q1', 'human', null], ['comment', 'Lcomment', 'human', null]]);
  const byId = Object.fromEntries(events.map(event => [event.id, event]));
  assert.deepEqual([byId.Q1?.title, byId.Q1?.summary], ['Do Q1', 'Do Q1\nIn detail']);
  assert.deepEqual([byId.TURN1?.title, byId.TURN1?.summary], ['Is it done?', 'Yes']);
  assert.deepEqual([byId.R10?.title, byId.Ldone?.state], ['failed', 'done']);
  // Who stood at each named Task over the page's time, finished ones too: its placements and their Runs.
  const crew = taskHistorySchema.parse(feed.history(child.id)).tasks?.[child.id]?.crew;
  assert.ok(crew?.placements.some(each => each.id === 'P1'));
  assert.deepEqual(crew?.runs.filter(run => run.placementId === 'P1').map(run => [run.id, run.agent, run.at]), [['R10', 'codex', at(7)], ['R11', 'codex', at(7)]]);
  // The parent's history with its children: their records a parent sees, and none of a grandchild's.
  const seen = taskHistorySchema.parse(feed.history(h.parent.id)).events.filter(event => event.fromChild);
  assert.deepEqual(seen.map(event => event.id), ['R10', 'Ldone', 'Lanswer', 'Q1']);
  assert.ok(seen.every(event => event.taskId === child.id && (PARENT_VISIBLE_EVENTS.has(event.kind) || event.kind === 'request')));
});

test('instructions have one Request row, including review send-backs, across pages and updates', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = '2026-10-20T11:39:51.452Z';
  const author = { kind: 'main', provider: 'codex', conversationId: 'C1' } as const;
  // A review send-back stores a body-less operational log under the Request's ID.
  // Different Requests at exactly the same time remain different instructions, including across a page edge.
  const requests: RequestDTO[] = Array.from({ length: 82 }, (_, n) => ({ id: `instruction-${n.toString().padStart(3, '0')}`,
    taskId: child.id, placementId: 'P1', runId: null, purpose: n === 0 ? 'review_send_back' : 'instruction', author,
    recipientRole: null, mode: n === 1 ? 'new' : 'continue', body: `Instruction ${n}\nFull body ${n}`,
    submittedAt: at, deliveryState: 'queued' }));
  const records = requests.map(request => entry(request.id, '2026-10-20T11:39:51.457Z', {
    kind: request.purpose === 'review_send_back' ? 'review_sent_back' : 'request_accepted', actor: author,
    fromState: request.purpose === 'review_send_back' ? 'waiting' : 'doing', toState: null,
    ...(request.purpose === 'review_send_back' ? { runId: 'R1' } : {}) }));
  const other = [entry('answer', at, { kind: 'answered', actor: author, questionId: 'question',
    title: 'Choose A', description: 'The answer' }), entry('comment', at, { actor: placement,
    title: 'Supplement', description: 'Keep this state-less comment' })];
  const feed = snapshotReads();
  const publish = (items: RequestDTO[]) => feed.update(h.screen({ ...tree, requests: items,
    tasks: tree.tasks.map(task => task.id === child.id ? { ...task, log: [child.log[0]!, ...records, ...other] } : task) }));
  const all = () => {
    const events: ReturnType<typeof feed.history>['events'] = [];
    let before: string | undefined;
    do {
      const page = taskHistorySchema.parse(feed.history(child.id, before ? { mode: 'older', before, limit: 80 } : { mode: 'latest' }));
      events.push(...page.events);
      before = page.hasOlder ? page.oldestKey! : undefined;
    } while (before);
    return events;
  };
  publish(requests.slice(0, 2));
  const first = all();
  assert.deepEqual(first.filter(event => event.id === requests[0]!.id).map(event => [event.kind, event.title, event.summary]),
    [['request', 'Instruction 0', requests[0]!.body]]);
  assert.deepEqual(first.filter(event => event.kind === 'request').map(event => event.id).sort(), requests.slice(0, 2).map(r => r.id));
  assert.deepEqual(first.filter(event => event.kind !== 'request').map(event => event.kind).sort(), ['answer', 'comment']);
  publish(requests);
  const reloaded = all();
  assert.equal(reloaded.length, 84);
  assert.equal(new Set(reloaded.map(event => event.id)).size, 84);
  assert.equal(reloaded.filter(event => event.kind === 'request').length, requests.length);
  // A parent's page fills with what was asked of its child, and what is past that edge comes on the next page, so
  // many requests only lengthen the walk. A comment stays in the child, and an instruction to the child's member too.
  const walk = (items: readonly RequestDTO[]) => {
    feed.update(h.screen({ ...tree, requests: [...items], tasks: tree.tasks.map(task => task.id === child.id ? { ...task, log: [child.log[0]!, ...records, ...other] } : task) }));
    const pages: ReturnType<typeof feed.history>['events'][] = [];
    let before: string | undefined;
    do {
      const page = taskHistorySchema.parse(feed.history(h.parent.id, before ? { mode: 'older', before, limit: 80 } : { mode: 'latest' }));
      pages.push(page.events.filter(event => event.fromChild));
      before = page.hasOlder ? page.oldestKey! : undefined;
    } while (before);
    return pages;
  };
  const pages = walk(requests);
  assert.ok(pages.length > 1 && pages[0]!.length >= 79, `the first page fills: ${pages.map(page => page.length).join()}`);
  assert.deepEqual(pages.flat().filter(event => event.kind !== 'request').map(event => [event.id, event.kind]), [['answer', 'answer']]);
  assert.equal(new Set(pages.flat().map(event => event.id)).size, 83);
  publish(requests);
  const notes = feed.timeline({ scope: 'root', visible: child.id, folded: '', from: at, to: '2026-10-20T11:40:00Z', limit: 200 }).events
    .flatMap(item => item.kind === 'note' ? [item.event] : []);
  assert.equal(notes.filter(note => note.id === requests[0]!.id).length, 1, 'time view uses the same single instruction');
});

test('a member\'s result is the reply of the Run that took its Request in, on the newest Request that Run took in, learnt when it ends', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 10, minute)).toISOString();
  const member = placementSchema.parse({ ...tree.placements[0]!, id: 'Pmember', taskId: child.id, responsible: false, active: true, endedAt: null });
  const request = (id: string, minute: number, runId: string): RequestDTO => ({ id, taskId: child.id, placementId: member.id, runId,
    recipientRole: 'worker', purpose: 'instruction', mode: 'continue', author: { kind: 'human' }, body: `Check ${id}`, submittedAt: at(minute), deliveryState: 'queued' });
  // Qfirst started R1; Qjoined went into R1 while it worked; Qfailed's Run failed, so its row is the failure, not a result.
  const requests = [request('Qfirst', 1, 'R1'), request('Qjoined', 2, 'R2'), request('Qfailed', 4, 'R3')];
  const runs = (ended: boolean) => [runOf('R1', child.id, ended ? 'succeeded' : 'running', at(1), ended ? at(3) : null, { placementId: member.id, requestId: 'Qfirst' }),
    runOf('R2', child.id, 'joined', at(2), at(2), { placementId: member.id, requestId: 'Qjoined', into: 'R1' }),
    runOf('R3', child.id, 'failed', at(4), at(5), { placementId: member.id, requestId: 'Qfailed' })];
  const facts = { ...tree.historyFacts, placementRoles: { ...tree.historyFacts.placementRoles, [member.id]: 'member' as const } };
  const feed = snapshotReads();
  const publish = (ended: boolean) => feed.update(h.screen({ ...tree, requests, runs: runs(ended), placements: [...tree.placements, member], historyFacts: facts }));
  publish(false);
  const results = () => taskHistorySchema.parse(feed.history(child.id)).events.flatMap(event => event.result ? [[event.id, event.result]] : []);
  assert.deepEqual(results(), [], 'a Run still working has no result');
  publish(true);
  assert.deepEqual(results(), [['Qjoined', { runId: 'R1', at: at(3) }]]);
  assert.ok(!taskHistorySchema.parse(feed.history(h.parent.id)).events.some(event => event.result),
    'a child\'s member results stay in the child');
  // A head cut by code points can exceed the contract's UTF-16 length; it is cut to it, never inside a pair.
  assert.equal(resultHead(`${'a'.repeat(RESULT_HEAD_LENGTH - 1)}😀`), 'a'.repeat(RESULT_HEAD_LENGTH - 1));
});

test('a failure is one row: a Run in trouble its own, an entry into error that none explains with its reason', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => `2026-10-07T09:0${minute}:00.000Z`;
  const error = (id: string, minute: number, runId: string) =>
    entry(id, at(minute), { kind: 'linked', actor: placement, fromState: 'doing', toState: 'error', runId });
  // The Run that failed linked its Task to error too; the one that ended with no report, and the one a person stopped,
  // left no Run in trouble.
  const log = [child.log[0]!, error('LENDR1', 1, 'R1'), error('LENDR2', 2, 'R2'), error('LENDR3', 3, 'R3')];
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree,
    tasks: tree.tasks.map(task => task.id === child.id ? { ...task, state: 'error' as const, log } : task),
    // Unknown reason is a DTO case, not a valid newly persisted failed Run.
    runs: [controlRunSchema.parse({ ...runOf('R1', child.id, 'failed', at(0), at(1)), reason: null }), runOf('R2', child.id, 'succeeded', at(1), at(2)),
      runOf('R3', child.id, 'cancelled', at(2), at(3))] }));
  const rows = (events: { kind: string; id: string; title: string }[]) => events.map(event => [event.kind, event.id, event.title]);
  assert.deepEqual(rows(taskHistorySchema.parse(feed.history(child.id)).events),
    [['error', 'LENDR3', 'stopped'], ['error', 'LENDR2', 'no_report'], ['error', 'R1', 'failed']]);
  // Its parent sees each failure, in its history and in the time view of its folded lane, from the same events.
  assert.deepEqual(rows(taskHistorySchema.parse(feed.history(h.parent.id)).events
    .filter(event => event.fromChild)), [['error', 'LENDR3', 'stopped'], ['error', 'LENDR2', 'no_report'], ['error', 'R1', 'failed']]);
  const lane = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: h.parent.id, folded: h.parent.id,
    from: at(0), to: at(9), limit: 200 }));
  assert.deepEqual(lane.events.flatMap(event => event.kind === 'note' ? [[event.event.kind, event.event.id]] : []),
    [['error', 'R1'], ['error', 'LENDR2'], ['error', 'LENDR3']]);
});

test('the time view\'s notes are the history events: Requests and dialogues too, as History shows them', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => `2026-10-07T09:0${minute}:00.000Z`;
  const request: RequestDTO = { id: 'Q1', taskId: child.id, placementId: 'P1', runId: null, purpose: 'instruction',
    author: { kind: 'human' }, recipientRole: null, mode: 'new', body: 'Do it\nIn detail', submittedAt: at(1),
    deliveryState: 'queued' };
  const log = [child.log[0]!, entry('Lcomment', at(2), { actor: placement, title: 'A note' })];
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: tree.tasks.map(task => task.id === child.id ? { ...task, log } : task),
    requests: [request], dialogues: [{ taskId: child.id, messageId: 'TURN1', at: at(3), words: 'Is it done?', answer: 'Yes' }] }));
  const page = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: child.id, folded: '', from: at(0), to: at(9),
    limit: 200 }));
  const notes = page.events.flatMap(event => event.kind === 'note' ? [event.event] : []);
  const history = taskHistorySchema.parse(feed.history(child.id)).events;
  assert.deepEqual(notes.map(note => [note.kind, note.id]), [['request', 'Q1'], ['comment', 'Lcomment'], ['dialogue', 'TURN1']]);
  assert.deepEqual(notes, [...history].reverse().map(timelineNoteOf));
  assert.ok(notes.every(note => !('title' in note) && !('summary' in note)));
  // A folded parent's lane has only what a parent sees of it: no comment, Request or dialogue of the child.
  const folded = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: h.parent.id, folded: h.parent.id,
    from: at(0), to: at(9), limit: 200 }));
  assert.deepEqual(folded.events.filter(event => event.taskId === child.id), []);
});

test('a row names its oldest open question; the view carries the Task\'s questions with what each fixed when it was asked', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => `2026-10-07T09:0${minute}:00.000Z`;
  const decide = {
    Lq1: [{ decide_question: 'First?' }],
    Lq2: [{ decide_question: 'Second?', decide_choices: [{ decide_choice: 'A', decide_choice_recommended: 'Faster' },
      { decide_choice: 'B', decide_choice_detail: 'Slower' }], decide_note: 'Either works', decide_stop: 'Nothing ships' }, { decide_question: 'And when?' }],
    Lq3: [{ decide_question: 'Third?', decide_note: 'Why' }],
  };
  const asked = (id: keyof typeof decide, minute: number, title: string, askedTo: string | null) =>
    entry(id, at(minute), { kind: 'asked', actor: placement, askedTo, title, description: `About ${title}`, decide: decide[id] });
  const log = [child.log[0]!, asked('Lq1', 1, 'First?', null), asked('Lq2', 2, 'Second?', null),
    asked('Lq3', 3, 'Third?', h.parent.id), entry('La1', at(4), { kind: 'answered', questionId: 'Lq1', title: 'Yes' })];
  const working = { ...tree, tasks: tree.tasks.map(task => task.id === child.id ? { ...task, state: 'doing' as const, log } : task),
    balls: { ...tree.balls, [child.id]: userBall('question', 'Lq2', at(2)) } };
  const feed = snapshotReads();
  // The Task's values say something else by now: the view's questions are what their records fixed, not the values.
  feed.update(h.screen({ ...working, taskValues: { ...working.taskValues, [child.id]: { decide: [{ decide_question: 'Rewritten since' }] } } }));
  const row = feed.row(child.id);
  assert.equal(row.question, 'Second?');
  assert.deepEqual(feed.view(child.id).questions, [
    { id: 'Lq1', taskId: child.id, destination: { kind: 'user' }, applicable: false, title: 'First?', summary: 'About First?', askedAt: at(1), state: 'answered', closedAt: at(4), decide: decide.Lq1 },
    { id: 'Lq2', taskId: child.id, destination: { kind: 'user' }, applicable: true, title: 'Second?', summary: 'About Second?', askedAt: at(2), state: 'open',
      decide: decide.Lq2 },
    { id: 'Lq3', taskId: child.id, destination: { kind: 'task', taskId: h.parent.id }, applicable: true, title: 'Third?', summary: 'About Third?', askedAt: at(3), state: 'open',
      decide: decide.Lq3 }]);
  // The user's own open questions carry the same structure for the screen to draw.
  assert.deepEqual(feed.view(child.id).userQuestions?.map(question => [question.id, question.decide]), [['Lq2', decide.Lq2]]);
});

test('the time view keeps question identity and time without hover-only closure details', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => `2026-10-07T09:${String(minute).padStart(2, '0')}:00.000Z`;
  const asked = (id: string, minute: number) =>
    entry(id, at(minute), { kind: 'asked', actor: placement, askedTo: null, title: `${id}?` });
  const log = [{ ...child.log[0]!, at: at(0) }, asked('Lq1', 1), asked('Lq2', 2), asked('Lq3', 3),
    entry('Lw2', at(4), { kind: 'question_withdrawn', actor: placement, questionId: 'Lq2' }),
    // The answer comes after the visible range, and a stop expires the question still open before it, with no record of its own.
    entry('La1', at(20), { kind: 'answered', questionId: 'Lq1', title: 'Yes' }),
    entry('Lstop', at(30), { fromState: 'doing', toState: 'stopped' }), asked('Lq4', 40)];
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: tree.tasks.map(task => task.id === child.id
    ? { ...task, state: 'stopped' as const, log } : task) }));
  const lane = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: child.id, folded: '', from: at(0), to: at(45), limit: 200 }));
  const questions = lane.events.flatMap(event => event.kind === 'log' && event.entry.kind === 'asked' ? [event.entry] : []);
  assert.deepEqual(questions.map(question => question.id), ['Lq1', 'Lq2', 'Lq3', 'Lq4']);
  for (const question of questions) assert.deepEqual(Object.keys(question).sort(), ['actor', 'at', 'fromState', 'id', 'kind', 'toState']);
  assert.ok(feed.history(child.id).events.some(event => event.kind === 'question' && event.open === true));
});

test('a dense timeline keeps every record as one note and the work line exact', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const parent = tree.tasks.find(task => task.id === h.parent.id)!;
  const minute = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  const logs = Array.from({ length: 400 }, (_, n) => entry(`Lmany${n}`, minute(n),
    { toState: 'doing', title: `Step ${n}`, description: 'history '.repeat(100) }));
  const runs = Array.from({ length: 300 }, (_, n) => runOf(`R${n + 1000}`, parent.id, 'succeeded', minute(n), minute(n + 1)));
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree,
    tasks: tree.tasks.map(task => task.id === parent.id ? { ...task, log: logs } : task), runs }));
  assert.ok(feed.row(parent.id).stateLog.length <= 5);

  assert.equal(feed.row(parent.id).usage?.runs, 300);
  const page = (after?: string) => taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: parent.id, folded: '',
    from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', limit: 200, ...(after ? { after } : {}) }));
  const first = page();
  assert.equal(first.runs.length, 300, 'the first page carries every Run of the range while the notes take more than one page');
  assert.equal(first.runs[0]?.startedAt, '2026-01-01T00:00:00.000Z');
  const notes: string[] = [], entries: string[] = [];
  let events = 0;
  for (let current = first; ; current = page(current.nextAfter!)) {
    notes.push(...current.events.flatMap(event => event.kind === 'note' ? [event.event.id] : []));
    entries.push(...current.events.flatMap(event => event.kind === 'log' ? [event.entry.id] : []));
    events += current.events.length;
    if (!current.nextAfter) break;
  }
  assert.deepEqual(notes, logs.map(log => log.id), 'each record is one note in time order: none is summarized or made up');
  assert.deepEqual(entries, logs.map(log => log.id), 'and the work line has each of its states');
  assert.equal(events, 2 * logs.length + runs.length);
});

test('a finished row keeps its waiting anchor when the visible time range has no state change', async t => {
  const h = await setup(t);
  const original = await readControlTree(h.root);
  const task = original.tasks.find(item => item.id === h.child.id)!;
  const created = { ...task.log[0]!, at: '2026-10-07T09:00:00.000Z' };
  const waiting = entry('Lwait', '2026-10-07T10:00:00.000Z', { actor: placement, title: 'Waiting', fromState: 'doing',
    toState: 'waiting' });
  const finished = entry('Ldone', '2026-10-07T12:00:00.000Z', { title: 'Done', fromState: 'waiting', toState: 'done' });
  const feed = snapshotReads();
  feed.update(h.screen({ ...original, tasks: original.tasks.map(item => item.id === task.id
    ? { ...item, state: 'done' as const, log: [created, waiting, finished] } : item) }));
  const page = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: task.id, folded: '',
    from: '2026-10-07T10:30:00.000Z', to: '2026-10-07T11:30:00.000Z', limit: 200 }));
  assert.equal(page.anchors[task.id]?.id, waiting.id);
  assert.ok(page.rows.some(row => row.id === task.id));
});

test('a dense window keeps its earlier state only as an anchor', async t => {
  const h = await setup(t);
  const original = await readControlTree(h.root);
  const task = original.tasks.find(item => item.id === h.parent.id)!;
  const prior = entry('Lprior', '2025-12-31T23:59:00.000Z', { toState: 'doing' });
  const reports = Array.from({ length: 20 }, (_, n) => entry(`Linside${n}`, new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    { toState: 'doing' }));
  const feed = snapshotReads();
  feed.update(h.screen({ ...original, tasks: original.tasks.map(item => item.id === task.id
    ? { ...item, state: 'doing' as const, log: [prior, ...reports] } : item) }));
  const page = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: task.id, folded: '',
    from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', limit: 10 }));
  assert.equal(page.anchors[task.id]?.id, prior.id);
  // Each state is a fact of the line and a note, side by side in time.
  assert.deepEqual(page.events.map(event => event.kind === 'log' ? event.entry.id : event.kind === 'note' ? event.event.id : ''),
    reports.slice(0, 5).flatMap(report => [report.id, report.id]));
  assert.ok(page.nextAfter, 'the later notes are on the next page');
});

test('the opened view carries only the latest report while History owns the chronology', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const task = tree.tasks.find(item => item.id === h.child.id)!;
  const report = entry('Lreport', '2026-10-07T09:00:00.000Z', { title: 'Latest report' });
  const later = Array.from({ length: 60 }, (_, n) => entry(`Lquiet${n}`, new Date(Date.UTC(2026, 9, 7, 10, n)).toISOString(),
    { kind: 'body_updated' }));
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: tree.tasks.map(item => item.id === task.id
    ? { ...item, log: [task.log[0]!, report, ...later] } : item) }));
  assert.deepEqual(feed.view(task.id).task.log.map(item => item.id), ['Lreport']);
  assert.equal(feed.history(task.id).events.length, 1 + later.length);
});

test('identical log IDs on different folded children are each a note of their own', async t => {
  const h = await setup(t);
  const tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const reports = Array.from({ length: 25 }, (_, n) => entry(n === 24 ? 'Lshared' : `Lchild${n}`,
    new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), { toState: 'done' }));
  const sibling = like(child, 'T999', { state: 'done', log: [entry('Lshared', '2026-01-01T00:01:00.000Z', { toState: 'done' }),
    entry('Lsibling', '2026-01-01T00:26:00.000Z', { toState: 'done' })] });
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: [...tree.tasks.map(task => task.id === child.id
    ? { ...task, state: 'done' as const, log: reports } : task), sibling] }));
  const notes: string[] = [];
  let after: string | undefined;
  do {
    const page = taskTimelineSchema.parse(feed.timeline({ scope: 'root', visible: h.parent.id, folded: h.parent.id,
      from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', limit: 10, ...(after ? { after } : {}) }));
    notes.push(...page.events.flatMap(event => event.kind === 'log' ? [`${event.taskId}:${event.entry.id}`] : []));
    after = page.nextAfter ?? undefined;
  } while (after);
  assert.equal(new Set(notes).size, reports.length + sibling.log.length);
  assert.ok(notes.includes(`${child.id}:Lshared`) && notes.includes(`${sibling.id}:Lshared`));
});

test('history sorts and filters mixed-case equal-time IDs in the same order', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const parent = tree.tasks.find(task => task.id === h.parent.id)!;
  const at = '2026-10-07T00:00:00.000Z', ids = ['Lb', 'la', 'aB', 'a_b'];
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: tree.tasks.map(task => task.id === parent.id
    ? { ...task, log: [{ ...parent.log[0]!, at: '2026-10-06T00:00:00.000Z' }, ...ids.map(id => entry(id, at, { title: id }))] }
    : task) }));
  const seen: string[] = []; let before: string | undefined = `2026-10-08T00:00:00.000Z|${parent.id}|boundary|comment`;
  do {
    const page = taskHistorySchema.parse(feed.history(parent.id, { mode: 'older', before: before!, limit: 1 }));
    seen.push(...page.events.filter(event => event.at === at).map(event => event.id)); before = page.hasOlder ? page.oldestKey! : undefined;
  } while (before);
  assert.deepEqual(seen.sort(), ids.sort());
});

test('axis activity is complete and independent of drawing windows, pages and read order', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const original = tree.tasks.find(task => task.id === h.child.id)!;
  const day = 86400000, base = Date.parse('2026-10-20T10:00:00Z');
  const iso = (offset: number) => new Date(base + offset).toISOString();
  const task = { ...original, state: 'done' as const, log: [
    { ...original.log[0]!, at: iso(-10 * day) },
    entry('Lhuman', iso(-8 * day), { title: 'Human note' }),
    ...Array.from({ length: 240 }, (_, at) => entry(`Lreport${at}`, iso(-7 * day + at * 3600000), { actor: placement, title: 'Report' })),
    entry('Lcause', iso(10 * day), { kind: 'linked', actor: placement, title: 'Delayed error', fromState: 'doing', toState: 'error', causeAt: iso(-9 * day) }),
    entry('Ldone-person', iso(-8.5 * day), { fromState: 'doing', toState: 'done' }),
  ] };
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: tree.tasks.map(row => row.id === task.id ? task : row),
    runs: [runOf('R99999', task.id, 'running', iso(-2 * day))] }));
  const input = { scope: 'root', lanes: task.id, folded: '' };
  const before = feed.timelineAxis(input);
  assert.equal(before.earliest, base - 10 * day);
  assert.ok(before.busy.some(([from, to]) => from === base - 2 * day && to === null));
  assert.ok(before.busy.some(([from, to]) => from <= base - 8.5 * day && to !== null && to >= base - 8.5 * day), 'a human completion is an activity mark');
  assert.ok(!before.busy.some(([from, to]) => from <= base - 8 * day && to !== null && to >= base - 8 * day), 'ordinary human notes are not marks');
  const caused = feed.timeline({ scope: 'root', visible: task.id, folded: '', from: iso(-9 * day - 1), to: iso(-9 * day + 1), limit: 200 });
  assert.ok(caused.events.some(event => event.kind === 'note' && event.event.id === 'Lcause' && event.event.at === iso(-9 * day)));
  assert.ok(caused.events.some(event => event.kind === 'log' && event.entry.id === 'Lcause'));
  for (const range of [[-3 * day, 0], [-10 * day, 10 * day], [-5 * day, -4 * day]].reverse()) {
    const first = feed.timeline({ scope: 'root', visible: task.id, folded: '', from: iso(range[0]!), to: iso(range[1]!), limit: 10 });
    if (first.nextAfter) feed.timeline({ scope: 'root', visible: task.id, folded: '', from: iso(range[0]!), to: iso(range[1]!), limit: 200, after: first.nextAfter });
    assert.deepEqual(feed.timelineAxis(input), before);
  }
  const folded = feed.timelineAxis({ scope: 'root', lanes: h.parent.id, folded: h.parent.id });
  assert.ok(folded.earliest! <= before.earliest!, 'a closed child older than the parent still determines the axis start');
  assert.throws(() => feed.timelineAxis({ scope: 'root', lanes: Array(201).fill(task.id).join(','), folded: '' }));
  assert.throws(() => feed.timelineAxis({ scope: task.id, lanes: h.parent.id, folded: '' }));
});

test('History projects authors, recipients, answer words and causal delivery links from the tree, including joined Runs', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const parent = tree.tasks.find(task => task.id === h.parent.id)!;
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 24, 10, minute)).toISOString();
  const placementOf = (id: string, taskId: string, responsible: boolean, profileKey = 'fake') => placementSchema.parse({
    ...tree.placements[0]!, id, taskId, responsible, profileKey, active: true, endedAt: null,
  });
  const own = placementOf('Powner', parent.id, false); // Released/current role does not rewrite historical authorship.
  const member = placementOf('Pmember', parent.id, false, 'codex');
  const childOwner = placementOf('Pchild', child.id, true);
  const grand = like(child, 'T900', { title: 'Grandchild', parentId: child.id, log: [
    entry('Lgrand', at(1), { actor: { kind: 'placement', placementId: 'Pgrand' }, kind: 'asked', askedTo: child.id,
      title: 'Grandchild choice', description: 'A or B', runId: 'R90' }),
    entry('Lgrand-created', at(0), { kind: 'created', userRequested: false, title: 'Grandchild added' })] });
  const main = { kind: 'main' as const, provider: 'codex' as const, conversationId: 'test', message: 'turn1', quote: 'Choose A' };
  const parentLog = [entry('Lowner', at(6), { actor: { kind: 'placement', placementId: own.id }, title: 'Final', runId: 'R10' }),
    entry('Lmember', at(5), { actor: { kind: 'placement', placementId: member.id }, title: 'Member result', runId: 'R12' }),
    entry('Lmissing', at(5), { actor: { kind: 'placement', placementId: member.id }, title: 'Missing Run', runId: 'R404' }),
    entry('Lmain', at(7), { actor: main, title: 'Coordinator record' }), entry('Lyou', at(8), { title: 'Your record' }),
    entry('Lconfirmed', at(9), { kind: 'review_approved', actor: main, title: 'Reviewed result', runId: 'R12' })];
  const childLog = [entry('Lask', at(2), { actor: { kind: 'placement', placementId: childOwner.id }, kind: 'asked', askedTo: parent.id,
    title: 'Child choice', description: 'Choose', runId: 'R20' }),
    entry('Lanswer', at(4), { actor: main, kind: 'answered', questionId: 'Lask', title: 'A' }),
    entry('Lparent', at(5), { actor: { kind: 'placement', placementId: own.id }, title: 'Parent instruction note' })];
  const requests: RequestDTO[] = [{ id: 'Q11', taskId: parent.id, placementId: own.id, runId: 'R11', recipientRole: 'owner',
    purpose: 'return_continuation', mode: 'new', author: main, body: 'Delivered', submittedAt: at(3), deliveryState: 'recorded_unconfirmed' },
    { id: 'Qmember', taskId: parent.id, placementId: member.id, runId: 'R13', recipientRole: null,
      purpose: 'instruction', mode: 'new', author: { kind: 'placement', placementId: own.id }, body: 'Check result', submittedAt: at(4), deliveryState: 'queued' },
    { id: 'Qcoord', taskId: parent.id, placementId: own.id, runId: null, recipientRole: null,
      purpose: 'instruction', mode: 'new', author: main, body: 'Choose A for the user', submittedAt: at(4), deliveryState: 'queued' }];
  const runs = [runOf('R10', parent.id, 'succeeded', at(1), at(5),
    { placementId: own.id, requestId: 'Q10', agent: 'fake', launch: inertFixtureLaunch('codex', { model: 'sonnet', effort: 'medium' }) }),
    runOf('R11', parent.id, 'joined', at(3), at(6), { into: 'R10', placementId: own.id, requestId: 'Q11' }),
    runOf('R12', parent.id, 'succeeded', at(3), at(5),
      { placementId: member.id, requestId: 'Q12', agent: 'codex', launch: inertFixtureLaunch('codex', { model: 'opus', effort: 'high' }) }),
    runOf('R20', child.id, 'succeeded', at(1), at(2), { placementId: childOwner.id, requestId: 'Q20', agent: 'fake' }),
    runOf('R13', parent.id, 'joined', at(4), at(5), { into: 'R12', placementId: member.id,
      requestId: 'Qmember', caller: { run: 'R10' }, launch: inertFixtureLaunch('codex', { model: 'ignored-joined', effort: 'low' }) }),
    runOf('R14', parent.id, 'succeeded', at(7), at(8),
      { placementId: member.id, launch: inertFixtureLaunch('codex', { model: 'newer-model', effort: 'low' }) })];
  const facts = { ...tree.historyFacts, answerTexts: { Lanswer: 'Full fixed answer\nWith details' },
    placementRoles: { Powner: 'owner' as const, Pmember: 'member' as const, Pchild: 'owner' as const },
    runRoles: { R10: 'owner' as const, R11: 'owner' as const, R12: 'member' as const, R20: 'owner' as const },
    deliveries: [{ logId: 'Lask', toTaskId: parent.id, requestId: 'Q11', outcome: 'question' as const, consumed: true },
      { logId: 'Lgrand', toTaskId: child.id, requestId: 'Q20', outcome: 'question' as const, consumed: true },
      { logId: 'Lgrand-created', toTaskId: child.id, requestId: 'Q20', outcome: 'child_added' as const, consumed: true }] };
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: [...tree.tasks.map(task => task.id === parent.id ? { ...task, log: parentLog }
    : task.id === child.id ? { ...task, log: childLog } : task), grand], runs, requests, placements: [own, member, childOwner], historyFacts: facts,
    dialogues: [{ taskId: parent.id, messageId: 'turn1', at: at(3), words: 'Choose A', answer: 'Recorded' }] }));
  const events = taskHistorySchema.parse(feed.history(parent.id)).events;
  const byId = new Map(events.map(event => [event.id, event]));
  assert.deepEqual(byId.get('Lowner')?.author, { kind: 'owner', profileKey: 'fake', modelId: 'sonnet', effort: 'medium' });
  assert.deepEqual(byId.get('Lmember')?.author, { kind: 'member', profileKey: 'codex', modelId: 'opus', effort: 'high' });
  assert.deepEqual(byId.get('Qmember')?.author, { kind: 'owner', profileKey: 'fake', modelId: 'sonnet', effort: 'medium' });
  assert.deepEqual(byId.get('Lask')?.author, { kind: 'owner', profileKey: 'fake', modelId: null, effort: null });
  assert.deepEqual(byId.get('Qcoord')?.recipient, { role: 'owner', profileKey: 'fake' });
  assert.deepEqual(byId.get('Lmissing')?.author, { kind: 'member', profileKey: 'codex' });
  assert.deepEqual(byId.get('Lyou')?.author, { kind: 'human' });
  assert.deepEqual(byId.get('Lmain')?.author, { kind: 'main' });
  assert.equal(byId.get('Lconfirmed')?.runId, undefined, 'the reviewed Run is not the Run that wrote the confirmation');
  assert.deepEqual(byId.get('Qmember')?.recipient, { role: 'member', profileKey: 'codex', modelId: 'opus', effort: 'high' });
  assert.deepEqual([byId.get('Qcoord')?.message, byId.get('Qcoord')?.quote], ['turn1', 'Choose A']);
  assert.deepEqual([byId.get('Lanswer')?.answers, byId.get('Lanswer')?.answerText, byId.get('Lanswer')?.quote, byId.get('Lanswer')?.message],
    ['Lask', 'Full fixed answer\nWith details', 'Choose A', 'turn1']);
  assert.equal(byId.get('Lask')?.askedTo, parent.id);
  assert.equal(byId.get('Lask')?.runId, 'R20');
  assert.deepEqual(byId.get('Lask')?.consumedBy, ['R10']);
  assert.deepEqual(byId.get('Lask')?.causes, [
    { taskId: grand.id, id: 'Lgrand-created', kind: 'child_added', title: 'Grandchild added', at: at(0) },
    { taskId: grand.id, id: 'Lgrand', kind: 'question', title: 'Grandchild choice', at: at(1) }]);
  assert.deepEqual(feed.history(child.id).events.find(event => event.id === 'Lparent')?.author,
    { kind: 'parent', taskId: parent.id, profileKey: 'fake' });
  assert.ok(byId.get('turn1')?.wordsKey);
  const notes = feed.timeline({ scope: 'root', visible: parent.id, folded: parent.id, from: at(0), to: at(9), limit: 200 })
    .events.flatMap(event => event.kind === 'note' ? [event.event] : []);
  assert.ok(notes.every(note => Object.keys(note).every(key => ['id', 'kind', 'taskId', 'at', 'state', 'mark', 'displayed'].includes(key))),
    'the list receives a compact display result, never causal/authorship/answer links or text');
  assert.equal(notes.find(note => note.id === 'Lask')?.displayed, false, 'the server applies the shared causal fold rule');
});

test('History preserves complete fixed answer text from captured records', async t => {
  const { ControlStore } = await import('@alpacawork/db');
  const h = await setup(t);
  const store = new ControlStore(h.root, { busyTimeoutMs: 1000 });
  const answer = 'Complete fixed answer\n' + 'Detail '.repeat(800);
  try {
    store.write(db => {
      const taskId = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(h.parent.id)!.id);
      const placementId = String(db.prepare('SELECT id FROM placements WHERE task_id=?').get(h.parent.id)!.id);
      const first = Number(db.prepare('SELECT max(ordinal)+1 AS n FROM task_log WHERE task_id=?').get(taskId)!.n);
      const logs = [entry('Lfixedq', '2026-10-24T12:00:00Z', { kind: 'asked', actor: { kind: 'placement', placementId },
        askedTo: null, title: 'Choose', description: 'A or B' }),
        entry('Lfixeda', '2026-10-24T12:01:00Z', { kind: 'answered', questionId: 'Lfixedq', title: 'A' })];
      for (const [i, log] of logs.entries()) db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)')
        .run(log.id, taskId, first + i, JSON.stringify(log));
      db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)').run('Lfixeda', 'Lfixedq');
      db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)').run('Lfixeda', answer);
      db.prepare(`INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES (?,?,'answer',?,?)`)
        .run('RETfixed', h.parent.id, 'Lfixeda', '2026-10-24T12:01:00Z');
    });
  } finally { store.close(); }
  const tree = await readControlTree(h.root);
  assert.equal(tree.historyFacts.answerTexts.Lfixeda, answer);
  const feed = snapshotReads();
  feed.update(h.screen(tree));
  assert.equal(taskHistorySchema.parse(feed.history(h.parent.id)).events.find(event => event.id === 'Lfixeda')?.answerText, answer);
});

test('History and timeline take human question membership from the same certified projection', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const question = entry('Lhumanq', '2026-10-24T12:00:00Z', { kind: 'asked', actor: placement,
    askedTo: null, title: 'Choose' });
  const owner = tree.placements.find(item => item.taskId === h.parent.id)!;
  const run = { ...runOf('R9001', h.parent.id, 'succeeded', '2026-10-24T12:00:00Z', '2026-10-24T12:02:00Z'), placementId: owner.id };
  const action = entry('Lhumanaction', '2026-10-24T12:01:00Z', { actor: { kind: 'placement', placementId: owner.id },
    runId: run.id, title: 'Decision' });
  const working = { ...tree, runs: [...tree.runs, run], tasks: tree.tasks.map(task => task.id === child.id
    ? { ...task, log: [...task.log, question] } : task.id === h.parent.id ? { ...task, log: [...task.log, action] } : task),
    historyFacts: { ...tree.historyFacts, runRoles: { ...tree.historyFacts.runRoles, [run.id]: 'owner' as const },
      deliveries: [...tree.historyFacts.deliveries, { logId: question.id, toTaskId: h.parent.id, requestId: run.requestId!, outcome: 'question' as const, consumed: true }] } };
  const feed = snapshotReads();
  // A partial read certifies no complete set of human decisions; a whole one does.
  for (const certified of [false, true, false]) {
    feed.update(h.screen({ ...working, errors: certified ? [] : [{ code: 'read_failed', message: 'Unread', path: 'tasks/T9999' }] }));
    const membership = feed.view(child.id).userQuestions?.some(asked => asked.id === question.id) ?? false;
    assert.equal(membership, certified);
    assert.ok(!feed.history(h.parent.id).events.some(event=>event.id===question.id), 'a child human question never enters parent History');
    const event = feed.history(child.id).events.find(event => event.id === question.id)!;
    assert.equal(event.open, true);
    assert.equal(event.askedTo, 'user');
    assert.equal(event.userQuestion, membership, 'an open human recipient does not certify membership when the read was partial');
    const parentNote=feed.timeline({scope:'root',visible:h.parent.id,folded:h.parent.id,
      from:'2026-10-24T11:59:00Z',to:'2026-10-24T12:01:00Z',limit:200}).events
      .find(item=>item.kind==='note'&&item.event.id===question.id);
    assert.equal(parentNote,undefined,'child human questions are absent from parent notes too');
    const note=feed.timeline({scope:'root',visible:child.id,folded:child.id,
      from:'2026-10-24T11:59:00Z',to:'2026-10-24T12:01:00Z',limit:200}).events
      .find(item=>item.kind==='note'&&item.event.id===question.id);
    assert.ok(note?.kind==='note');
    assert.ok(!('userQuestion' in note.event),'question membership stays on the detail boundary');
  }
});

test('History names each end by its own Run: the Run that took a record in, the Coordinator Run of a message, a stopped Run', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const owner = tree.placements.find(item => item.taskId === h.parent.id)!;
  const took = runOf('R9101', h.parent.id, 'succeeded', '2026-10-24T12:00:00Z', '2026-10-24T12:02:00Z',
    { placementId: owner.id, agent: 'claude', launch: inertFixtureLaunch('claude', { model: 'opus', effort: 'high' }) });
  const stopped = runOf('R9102', h.parent.id, 'failed', '2026-10-24T12:03:00Z', '2026-10-24T12:04:00Z',
    { placementId: owner.id, agent: 'claude', launch: inertFixtureLaunch('claude', { model: 'sonnet' }) });
  const named: RequestDTO = { id: stopped.requestId!, taskId: h.parent.id, placementId: owner.id, runId: stopped.id,
    recipientRole: 'owner', purpose: 'instruction', mode: 'new', author: { kind: 'human' }, body: 'Use Claude for this request',
    submittedAt: '2026-10-24T12:03:00Z', deliveryState: 'queued' };
  const report = entry('Ltaken', '2026-10-24T11:59:00Z', { actor: placement, title: 'Done', toState: 'done' });
  const coordinator = entry('Lmain', '2026-10-24T12:05:00Z', { kind: 'reported', actor: { kind: 'main', provider: 'claude', conversationId: 'c1', message: 'M1' }, title: 'Noted' });
  const outside = entry('Loutside', '2026-10-24T12:06:00Z', { kind: 'reported', actor: { kind: 'main', provider: 'codex', conversationId: 'c2' }, title: 'From outside' });
  const working = { ...tree, runs: [...tree.runs, took, stopped], requests: [...tree.requests, named], tasks: tree.tasks.map(task => task.id === child.id
    ? { ...task, log: [...task.log, report] } : task.id === h.parent.id ? { ...task, log: [...task.log, coordinator, outside] } : task),
    historyFacts: { ...tree.historyFacts, runRoles: { ...tree.historyFacts.runRoles, [took.id]: 'owner' as const, [stopped.id]: 'owner' as const },
      deliveries: [...tree.historyFacts.deliveries, { logId: report.id, toTaskId: h.parent.id, requestId: took.requestId!, outcome: 'succeeded' as const, consumed: true }],
      coordinatorRuns: { M1: { agent: 'claude', modelId: 'opus', effort: 'max' } } } };
  const feed = snapshotReads();
  feed.update(h.screen(working));
  const events = feed.history(h.parent.id).events;
  const of = (id: string) => events.find(event => event.id === id)!;
  assert.deepEqual(of(report.id).recipient, { role: 'owner', profileKey: 'claude', modelId: 'opus', effort: 'high' }, 'the Run that took the report in');
  assert.deepEqual(of(coordinator.id).coordinator, { profileKey: 'claude', modelId: 'opus', effort: 'max' }, 'the Coordinator Run of the message');
  assert.equal(of(outside.id).coordinator, undefined, 'an outside Coordinator has no Run to name');
  assert.equal(of(outside.id).recipient, undefined, 'a record no Run took in names none');
  assert.deepEqual(of(stopped.id).author, { kind: 'owner', profileKey: 'claude', modelId: 'sonnet', effort: null }, 'the stopped Run writes its row');
  assert.deepEqual(of(named.id).recipient, { role: 'owner', profileKey: 'claude', modelId: 'sonnet', effort: null },
    'the request names the AI from its launch even without fallback');
});

test('a record\'s receiving end is the Run that consumed it, not a wake that never reached its agent', async t => {
  const { ControlStore } = await import('@alpacawork/db');
  const { record } = await import('./runs-fixtures.ts');
  const h = await setup(t);
  const store = new ControlStore(h.root, { busyTimeoutMs: 1000 });
  try {
    store.write(db => {
      const taskRow = String(db.prepare('SELECT id FROM tasks WHERE external_id=?').get(h.parent.id)!.id);
      const seat = db.prepare('SELECT id,revision FROM placements WHERE task_id=? AND responsible=1').get(h.parent.id)!;
      const first = Number(db.prepare('SELECT max(ordinal)+1 AS n FROM task_log WHERE task_id=?').get(taskRow)!.n);
      // The parent's question and your answer, which is returned to the parent's seat.
      const logs = [entry('Lreceiptq', '2026-10-24T11:59:00Z', { kind: 'asked', actor: { kind: 'placement', placementId: String(seat.id) },
        askedTo: null, title: 'Which one?', description: 'A or B' }), entry('Lreceipt', '2026-10-24T12:00:00Z', { kind: 'answered', questionId: 'Lreceiptq', title: 'A' })];
      for (const [i, log] of logs.entries()) db.prepare('INSERT INTO task_log(id,task_id,ordinal,entry) VALUES(?,?,?,?)').run(log.id, taskRow, first + i, JSON.stringify(log));
      db.prepare('INSERT INTO task_log_question(log_id,question_log_id) VALUES(?,?)').run('Lreceipt', 'Lreceiptq');
      db.prepare('INSERT INTO log_texts(log_id,text) VALUES(?,?)').run('Lreceipt', 'A');
      db.prepare(`INSERT INTO returns(id,to_task_id,outcome,cause_log_id,created_at) VALUES (?,?,'answer',?,?)`).run('RETreceipt', h.parent.id, 'Lreceipt', '2026-10-24T12:00:00Z');
      // Two wakes of the parent's seat: the first was never delivered and its Run (sonnet, low) was cancelled before it
      // started; the second's Run (opus, high) took the answer in and finished its turn.
      for (const [n, wake, state, values, at] of [[9101, 'Qnot-delivered', 'cancelled', { model: 'sonnet', effort: 'low' }, '2026-10-24T12:01:00Z'],
        [9102, 'Qconsumed', 'succeeded', { model: 'opus', effort: 'high' }, '2026-10-24T12:02:00Z']] as const) {
        db.prepare(`INSERT INTO requests(id,task_id,placement_id,placement_revision,task_hash,mode,body,purpose,author,submitted_at,delivery_state)
          VALUES(?,?,?,?,?,'new','Returns','return_continuation',?,?,?)`).run(wake, h.parent.id, String(seat.id), Number(seat.revision), '0'.repeat(64),
          JSON.stringify({ kind: 'placement', placementId: String(seat.id) }), at, state === 'cancelled' ? 'aborted' : 'queued');
        const run = record(`R${n}`, { task: h.parent.id, placementId: String(seat.id), requestId: wake, agent: 'claude', role: 'owner', state,
          reason: state === 'cancelled' ? 'stopped' : null, created_at: at, started_at: state === 'cancelled' ? null : at, ended_at: at,
          launch: inertFixtureLaunch('claude', values) });
        db.prepare(`INSERT INTO runs(id,record,prompt,result,result_state) VALUES(?,?,'Returns','','present')`).run(n, JSON.stringify(run));
      }
      db.prepare(`INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at,released_at,release_reason) VALUES(?,?,?,?,'not_delivered')`)
        .run('RETreceipt', 'Qnot-delivered', '2026-10-24T12:01:00Z', '2026-10-24T12:01:00Z');
      db.prepare(`INSERT INTO return_deliveries(return_id,wake_request_id,reserved_at,received_at,consumed_at) VALUES(?,?,?,?,?)`)
        .run('RETreceipt', 'Qconsumed', '2026-10-24T12:02:00Z', '2026-10-24T12:02:00Z', '2026-10-24T12:03:00Z');
    });
  } finally { store.close(); }
  const tree = await readControlTree(h.root);
  assert.deepEqual(tree.historyFacts.deliveries.filter(delivery => delivery.logId === 'Lreceipt').map(delivery => [delivery.requestId, delivery.consumed]),
    [['Qnot-delivered', false], ['Qconsumed', true]]);
  const feed = snapshotReads();
  feed.update(h.screen(tree));
  const event = feed.history(h.parent.id).events.find(item => item.id === 'Lreceipt')!;
  assert.deepEqual(event.recipient, { role: 'owner', profileKey: 'claude', modelId: 'opus', effort: 'high' }, 'the Run that consumed it, not the undelivered wake');
  // With only the undelivered wake, no Run received it: the end is named by its word alone.
  const unreceived = { ...tree, historyFacts: { ...tree.historyFacts, deliveries: tree.historyFacts.deliveries.filter(delivery => delivery.requestId !== 'Qconsumed') } };
  feed.update(h.screen(unreceived));
  assert.equal(feed.history(h.parent.id).events.find(item => item.id === 'Lreceipt')!.recipient, undefined);
});

test('History learns the Run that consumed a record after the record was written', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const child = tree.tasks.find(task => task.id === h.child.id)!;
  const owner = tree.placements.find(item => item.taskId === h.parent.id)!;
  const took = runOf('R9201', h.parent.id, 'succeeded', '2026-10-24T12:00:00Z', '2026-10-24T12:02:00Z',
    { placementId: owner.id, agent: 'claude', launch: inertFixtureLaunch('claude', { model: 'opus', effort: 'high' }) });
  const report = entry('Lconsumed', '2026-10-24T11:59:00Z', { actor: placement, title: 'Done', toState: 'done' });
  // The same read twice over: the wake's Run has ended, and only whether the return was consumed differs.
  const at = (consumed: boolean) => h.screen({ ...tree, runs: [...tree.runs, took],
    tasks: tree.tasks.map(task => task.id === child.id ? { ...task, log: [...task.log, report] } : task),
    historyFacts: { ...tree.historyFacts, runRoles: { ...tree.historyFacts.runRoles, [took.id]: 'owner' as const },
      deliveries: [...tree.historyFacts.deliveries, { logId: report.id, toTaskId: h.parent.id, requestId: took.requestId!, outcome: 'succeeded' as const, consumed }] } });
  const recipient = () => feed.history(h.parent.id).events.find(event => event.id === report.id)!.recipient;
  const feed = snapshotReads();
  feed.update(at(false));
  assert.equal(recipient(), undefined, 'not consumed yet: no receiving Run');
  feed.update(at(true));
  assert.deepEqual(recipient(), { role: 'owner', profileKey: 'claude', modelId: 'opus', effort: 'high' });
});

test('a restored hold keeps the report its wait began with in the live summary', async t => {
  const h = await setup(t);
  const original = await readControlTree(h.root);
  const child = original.tasks.find(task => task.id === h.child.id)!;
  // The report that asked for the review, the user's hold of it, and its return from the hold.
  const step = (id: string, at: string, fromState: 'doing' | 'waiting' | 'held', toState: 'waiting' | 'held', title: string) =>
    entry(id, at, { title, description: 'Context', fromState, toState });
  const log = [...child.log, step('Lreview', '2026-10-07T09:00:00.000Z', 'doing', 'waiting', 'Please review'),
    step('Lhold', '2026-10-07T10:00:00.000Z', 'waiting', 'held', 'Record'),
    step('Lrestore', '2026-10-07T11:00:00.000Z', 'held', 'waiting', 'Record')];
  const feed = snapshotReads();
  feed.update(h.screen({ ...original, tasks: original.tasks.map(task => task.id === child.id
    ? { ...task, state: 'waiting' as const, log } : task) }));
  const row = feed.row(h.child.id);
  assert.deepEqual(row.stateLog.filter(item => item.toState !== null).map(item => item.id).slice(-2), ['Lhold', 'Lrestore']);
  assert.equal(row.stateLog.find(item => item.toState === 'waiting')?.title, 'Please review');
});


test('closed pages and search carry the same row facts from the current projection', async t => {
  const h = await setup(t), tree = await readControlTree(h.root);
  const source = tree.tasks.find(task => task.id === h.parent.id)!;
  const task = like(source, 'T50', { title: 'Closed facts', parentId: h.projectId, state: 'done', userRequested: true,
    log: [entry('L50', '2026-10-07T10:00:00.000Z', { toState: 'done' })] });
  const feed = snapshotReads();
  feed.update(h.screen({ ...tree, tasks: [...tree.tasks, task] }));
  const expected = { status: { kind: 'since', at: Date.parse('2026-10-07T10:00:00.000Z') },
    childrenRunning: 0, runningRuns: 0, warning: null, kind: null, position: 'done' };
  assert.deepEqual(feed.finished(null, h.projectId).rows.find(row => row.id === task.id)?.rowFacts, expected);
  assert.deepEqual(feed.search('Closed facts', h.projectId).rows[0]?.rowFacts, expected);
});
