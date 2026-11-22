/**
 * Pure wake rules: whether a seat is woken with its returns now, which returns go, when a seat is failed, and the seat's
 * facts as seatFactsOf assembles them from one read point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETURN_NOTICES } from '@alpacawork/contract';
import type { ControlTask } from '@alpacawork/raw';
import type { RunSnapshot, StoredPlacement, StoredRequest, StoredReturn } from '@alpacawork/runs';
import { deliverable, seatFactsOf, seatFailed, seatRunBefore, seatSourceOf, wakeBlock, type SeatFacts, type SeatRow } from
  '@alpacawork/backend/test-dist/control/wake.js';
import { ended as endedRun, record, time } from './runs-fixtures.ts';

const row = (id: string, outcome: SeatRow['outcome'] = 'succeeded', holdReason: string | null = null): SeatRow =>
  ({ id, outcome, holdReason, createdAt: `2026-10-19T09:00:0${id.slice(-1)}.000Z` });
const ended = { state: 'succeeded', intoState: null, inputOpen: false } as const;
const seat = (facts: Partial<SeatFacts> = {}): SeatFacts => ({ lifecycle: 'active', state: 'doing', baseState: facts.baseState ?? (facts.state === 'held' ? 'doing' : facts.state ?? 'doing'), hold: facts.hold ?? facts.state === 'held', head: ended,
  profileAvailable: true, automaticLimitReached: false, uncertain: [], openRequests: 0, pending: [row('RET1')], ...facts });
const code = (facts: Partial<SeatFacts>) => wakeBlock(seat(facts))?.code ?? null;

test('a seat wakes with pending returns regardless of open Requests, and a new responsible needs no first instruction', () => {
  assert.equal(wakeBlock(seat()), null);
  assert.equal(wakeBlock(seat({ head: null })), null, 'a handover or the first Request is the first instruction');
});

test('an open Request does not hold back the closing returns, and a stopped owner Run alone does not stop the wake', () => {
  assert.equal(code({ openRequests: 1 }), null);
  assert.equal(code({ openRequests: 1, pending: [] }), 'outstanding');
  assert.equal(code({ openRequests: 0 }), null);
  const stopped = { state: 'cancelled', intoState: null, inputOpen: false } as const;
  assert.equal(code({ head: stopped }), null, 'whether a stop fails the Task is the Task state rule');
  assert.equal(code({ head: stopped, state: 'error' }), 'failed');
});

test('the server\'s own Request (W0: a handover) wakes a failed seat, with what waits for it', () => {
  const failedHead = { state: 'failed', intoState: null, inputOpen: false } as const;
  for (const outcome of ['handover'] as const) {
    const pending = [row('RET1'), row('RET2', outcome)];
    assert.deepEqual(deliverable(seat({ state: 'error', pending }), pending), { rows: pending, block: null }, outcome);
    assert.equal(wakeBlock(seat({ head: failedHead, pending })), null, `${outcome} after a failed Run`);
    assert.equal(code({ state: 'held', pending }), 'held', 'a hold keeps it for the user');
  }
  for (const outcome of ['succeeded', 'question', 'urgent', 'answer', 'work_changed', 'child_added'] as const)
    assert.equal(code({ state: 'error', pending: [row('RET1', outcome)] }), 'failed', `${outcome} is W1–W3`);
});

test('a finished seat, a missing profile, a busy Run and a Run needing review stop the wake', () => {
  assert.equal(code({ state: 'done' }), 'finished');
  assert.equal(code({ state: 'stopped' }), 'finished');
  for (const lifecycle of ['archived', 'deleted'] as const) assert.equal(code({ lifecycle }), 'finished');
  assert.equal(code({ profileAvailable: false }), 'no_profile');
  assert.equal(code({ head: { ...ended, state: 'queued' } }), 'busy');
  assert.equal(code({ head: { ...ended, state: 'needs_review' } }), 'needs_review');
});

test('each admission refusal stops the wake as the user turn with its exact code', () => {
  for (const reason of ['too_deep', 'too_many_children', 'not_resumable', 'responsible_missing']) {
    const held = row('RET2', 'succeeded', reason);
    assert.deepEqual(wakeBlock(seat({ pending: [row('RET1'), held] })),
      { code: reason, human: true, key: `${reason}:RET2`, at: held.createdAt, count: null });
  }
});

test('the automatic limit stops the wake as the user turn only once it is reached', () => {
  const first = row('RET1'), pending = [first, row('RET2', 'urgent')];
  assert.deepEqual(wakeBlock(seat({ automaticLimitReached: true, pending })),
    { code: 'automatic_limit', human: true, key: 'limit:RET1', at: first.createdAt, count: 2 });
  assert.equal(wakeBlock(seat({ automaticLimitReached: false, pending })), null);
});

test('each block is the first rule that holds, in order', () => {
  let facts = seat({ lifecycle: 'archived', state: 'held', head: { state: 'joined', intoState: 'failed', inputOpen: false },
    profileAvailable: false, automaticLimitReached: true, uncertain: [row('RET9', 'question')], openRequests: 1,
    pending: [row('RET1', 'urgent', 'too_deep'), row('RET2')] });
  const steps: Array<[string | null, Partial<SeatFacts>]> = [
    ['finished', { lifecycle: 'active' }],
    ['held', { state: 'doing', hold: false }],
    ['failed', { head: { state: 'needs_review', intoState: null, inputOpen: false } }],
    ['no_profile', { profileAvailable: true }],
    ['automatic_limit', { automaticLimitReached: false }],
    ['uncertain', { uncertain: [] }],
    ['too_deep', { pending: [row('RET1', 'urgent'), row('RET2')] }],
    ['needs_review', { head: { state: 'queued', intoState: null, inputOpen: false } }],
    ['busy', { head: { state: 'running', intoState: null, inputOpen: true } }],
    [null, { pending: [row('RET2')] }],
    [null, { pending: [] }],
    ['outstanding', { openRequests: 0 }],
    ['nothing', {}],
  ];
  for (const [expected, next] of steps) {
    assert.equal(wakeBlock(facts)?.code ?? null, expected, JSON.stringify(facts));
    facts = { ...facts, ...next };
  }
});

test('only the limit, an unknown receipt, a missing profile and a refusal are the user turn', () => {
  const human = [seat({ automaticLimitReached: true }), seat({ uncertain: [row('RET9')] }), seat({ profileAvailable: false }),
    seat({ pending: [row('RET1', 'succeeded', 'not_resumable')] })];
  for (const facts of human) assert.equal(wakeBlock(facts)?.human, true);
  const others = [seat({ state: 'done' }), seat({ state: 'held' }), seat({ state: 'error' }),
    seat({ head: { ...ended, state: 'needs_review' } }), seat({ head: { ...ended, state: 'queued' } }),
    seat({ openRequests: 1, pending: [] }), seat({ pending: [] })];
  for (const facts of others)
    assert.deepEqual({ ...wakeBlock(facts), code: null }, { code: null, human: false, key: null, at: null, count: null });
});

test('all pending results and notices go together while Requests remain open', () => {
  const pending = [row('RET1'), row('RET2', 'question'), row('RET3', 'failed'), row('RET4', 'urgent')];
  for (const openRequests of [0, 1]) {
    const delivered = deliverable(seat({ openRequests }), pending);
    assert.deepEqual(delivered, { rows: pending, block: null });
    assert.notEqual(delivered.rows, pending, 'selection does not mutate the caller array');
    assert.equal(delivered.rows[0], pending[0], 'the caller gets its own rows back');
  }
  for (const outcome of RETURN_NOTICES) {
    const notice = row('RET2', outcome);
    assert.deepEqual(deliverable(seat({ openRequests: 1 }), [row('RET1'), notice]),
      { rows: [row('RET1'), notice], block: null }, outcome);
  }
  const limited = seat({ openRequests: 1, automaticLimitReached: true });
  assert.deepEqual(wakeBlock({ ...limited, pending }), deliverable(limited, pending).block);
  assert.equal(wakeBlock({ ...limited, pending })?.key, 'limit:RET1');
});

test('the user is asked about the limit or a missing profile only when something is to go now', () => {
  const closing = [row('RET1'), row('RET3', 'stopped')];
  assert.equal(code({ openRequests: 1, pending: closing, automaticLimitReached: true }), 'automatic_limit');
  assert.equal(code({ openRequests: 1, pending: closing, profileAvailable: false }), 'no_profile');
  assert.equal(code({ pending: [], profileAvailable: false }), 'nothing');
  const limited = wakeBlock(seat({ openRequests: 1, pending: [...closing, row('RET5', 'answer')], automaticLimitReached: true }));
  assert.deepEqual([limited?.key, limited?.count], ['limit:RET1', 3], 'only what would go now waits behind the limit');
  const unknown = row('RET8', 'question');
  assert.deepEqual(wakeBlock(seat({ pending: [], uncertain: [unknown, row('RET9')] })),
    { code: 'uncertain', human: true, key: 'uncertain:RET8', at: unknown.createdAt, count: null },
    'a delivery of unknown receipt is the user turn with nothing else to go');
});

test('a running Run that takes input gets the returns mid-turn, and any other Run still moving holds them', () => {
  const running = { state: 'running', intoState: null } as const;
  assert.equal(code({ head: { ...running, inputOpen: true } }), null);
  assert.equal(code({ head: { ...running, inputOpen: false } }), 'busy');
  assert.equal(code({ head: { state: 'joined', intoState: 'running', inputOpen: true } }), null);
  assert.equal(code({ head: { state: 'joined', intoState: 'running', inputOpen: false } }), 'busy');
  assert.equal(code({ head: { state: 'queued', intoState: null, inputOpen: true } }), 'busy');
});

test('a failed seat takes no W1, W2 or W3, and a held one waits for the user', () => {
  for (const outcome of ['succeeded', 'urgent', 'question', 'answer'] as const) {
    assert.equal(code({ state: 'error', pending: [row('RET1', outcome)] }), 'failed', outcome);
    assert.equal(code({ head: { ...ended, state: 'failed' }, pending: [row('RET1', outcome)] }), 'failed', outcome);
    assert.equal(code({ state: 'held', pending: [row('RET1', outcome)] }), 'held', outcome);
  }
});

test('a seat is failed by its Task in error or its previous owner Run failing, never by a stop', () => {
  const run = (state: 'succeeded' | 'failed' | 'cancelled' | 'joined', intoState: 'succeeded' | 'failed' | 'cancelled' | null = null) =>
    ({ state, intoState });
  assert.equal(seatFailed({ baseState: 'error' }, null), true);
  assert.equal(seatFailed({ baseState: 'error' }, run('succeeded')), true);
  assert.equal(seatFailed({ baseState: 'doing' }, run('failed')), true);
  assert.equal(seatFailed({ baseState: 'doing' }, run('joined', 'failed')), true, 'a joined Run ends as the Run it joined');
  for (const prior of [null, run('succeeded'), run('cancelled'), run('joined', 'succeeded'), run('joined', 'cancelled')])
    assert.equal(seatFailed({ baseState: 'doing' }, prior), false, JSON.stringify(prior));
});

test('the wake reads a failed seat by seatFailed alone, whatever else the seat waits on', () => {
  const heads: SeatFacts['head'][] = [null, ended, { ...ended, state: 'failed' }, { ...ended, state: 'cancelled' },
    { state: 'joined', intoState: 'failed', inputOpen: false }, { state: 'joined', intoState: 'succeeded', inputOpen: false },
    { state: 'joined', intoState: 'cancelled', inputOpen: false }];
  for (const state of ['doing', 'waiting', 'error'] as const) for (const head of heads) for (const openRequests of [0, 1]) {
    const facts = seat({ state, head, openRequests });
    assert.equal(wakeBlock(facts)?.code === 'failed', seatFailed(facts, facts.head), JSON.stringify({ state, head, openRequests }));
  }
});

// One read point: P1 is the project and T2 its top Task, whose responsible (P2, Run R2) asked the child T3 (P3, R3) and
// had a worker (W2, R4) work; R5 is T2's wake that joined R2. T4 has no responsible.
const at = (minute: number) => new Date(Date.parse(time) + minute * 60_000).toISOString();
const task = (id: string, fields: Partial<ControlTask['meta']> = {}): Pick<ControlTask, 'id' | 'meta'> => ({ id,
  meta: { format: 3n, id, kind: 'task', parentId: 'P1', lifecycle: 'active', title: id, version: 1n, baseState: fields.baseState ?? (fields.state === 'held' ? 'doing' : fields.state ?? 'doing'), hold: fields.hold ?? fields.state === 'held', state: 'doing',
    userRequested: false, log: [], ...fields } });
const questionLog = (id: string, minute: number, askedTo: string): ControlTask['meta']['log'][number] => ({ id, kind: 'asked', at: at(minute), title: 'Decide', description: 'A or B', actor: { kind: 'placement', placementId: 'P3' }, fromState: null, toState: null, askedTo, decide: [{ decide_question: 'Decide', decide_note: 'A or B' }] });
const tasks = [task('P1', { kind: 'project', parentId: null, state: 'todo' }), task('T2'), task('T3', { parentId: 'T2', log: [questionLog('L-RETq', 5, 'T2'), questionLog('L-RETc', 7, 'T2'), questionLog('L-RETd', 8, 'T2')] }),
  task('T4', { parentId: 'T3', log: [questionLog('L-RET3', 9, 'T3')] })];
const placement = (id: string, taskId: string): StoredPlacement => ({ id, taskId, agentId: `A-${id}`, profileKey: 'fake',
  responsible: true, active: true, revision: 1, startedAt: time, endedAt: null });
const request = (id: string, taskId: string, placementId: string, source: 'human' | 'placement' | 'returns', minute: number,
  runId: string | null): StoredRequest => ({ id, taskId, placementId, placementRevision: 1, taskHash: 'a'.repeat(64),
  waitCycleId: source === 'placement' ? 'C2' : null, headRunId: null, aboutRunId: null, mode: 'new', body: `Do ${id}`, purpose: source === 'returns' ? 'return_continuation' : 'instruction',
  author: source === 'human' ? { kind: 'human' } : { kind: 'placement', placementId: 'P2' }, submittedAt: at(minute),
  deliveryState: 'queued', runId });
const returned = (id: string, minute: number, fields: Partial<StoredReturn> = {}): StoredReturn => ({ id, requestId: null,
  outcome: 'question', toTaskId: 'T2', boundaryRunId: null, causeLogId: `L-${id}`, holdReason: null, holdProblemReason: null, createdAt: at(minute),
  deliveries: [], resolution: null, ...fields });
const delivery = (wakeRequestId: string, releaseReason: string | null = null) => ({ wakeRequestId, reservedAt: at(9),
  receivedAt: null, consumedAt: null, releasedAt: releaseReason === null ? null : at(10), releaseReason });
const working = record('R2', { task: 'T2', placementId: 'P2', requestId: 'top', state: 'running', started_at: time,
  session: { provider: 'codex', id: 'S2' }, launch: { ...record().launch, adapter: 'codex' } });
const runs = [working, record('R3', { task: 'T3', placementId: 'P3', requestId: 'ask', caller: { run: 'R2' }, state: 'running',
  started_at: time, launch: { ...record().launch, adapter: 'claude' } }), endedRun('R4', { task: 'T2', role: 'worker', placementId: 'W2', requestId: 'work', caller: { run: 'R2' } }),
  record('R5', { task: 'T2', placementId: 'P2', requestId: 'wake', state: 'joined', into: 'R2', ended_at: time })];
const requests = [request('top', 'T2', 'P2', 'human', 0, 'R2'), request('ask', 'T3', 'P3', 'placement', 1, 'R3'),
  request('work', 'T2', 'W2', 'placement', 2, 'R4'), request('wake', 'T2', 'P2', 'returns', 3, 'R5')];
const closed = returned('RETw', 4, { requestId: 'work', outcome: 'succeeded', boundaryRunId: 'R4', causeLogId: null });
const asked = returned('RETq', 5), inFlight = returned('RETu', 6, { outcome: 'urgent', deliveries: [delivery('wake')] });
const returns = [closed, asked, inFlight, returned('RETc', 7, { deliveries: [delivery('wake-before', 'failed')] }),
  returned('RETd', 8, { resolution: { at: at(9), reason: 'question_closed' } }), returned('RET3', 9, { toTaskId: 'T3' })];
const configured = { profiles: new Set(['fake']), automaticLimit: 20 };
const source = (parts: Partial<RunSnapshot> = {}, settings = configured, scope = tasks) => seatSourceOf(scope, { records: runs,
  runError: null, agents: [], placements: [placement('P2', 'T2'), placement('P3', 'T3')], requests, returns, waitCycles: [],
  headRunIds: new Map([['P2', 'R2'], ['P3', 'R3']]), resultStates: new Map(), questionClosures: new Map(),
  uncertainInputs: new Map(), inputClosed: new Set(['R3']), ...parts }, settings);

test("a seat's facts are its responsible's head, its open Requests and the returns waiting for it at one read point", () => {
  const facts = seatFactsOf(source(), 'T2');
  assert.deepEqual(facts, { lifecycle: 'active', state: 'doing', baseState: 'doing', hold: false, head: { state: 'running', intoState: null, inputOpen: true },
    profileAvailable: true, automaticLimitReached: false, uncertain: [], openRequests: 1, pending: [closed, asked] },
    'a delivery out, a carried return and a resolved one are not pending');
  assert.deepEqual(deliverable(facts, facts.pending), { rows: [closed, asked], block: null },
    'the question and worker result go into the working Run while the child Request remains open');
  assert.deepEqual(seatFactsOf(source(), 'T3'), { lifecycle: 'active', state: 'doing', baseState: 'doing', hold: false,
    head: { state: 'running', intoState: null, inputOpen: false }, profileAvailable: true, automaticLimitReached: false,
    uncertain: [], openRequests: 0, pending: [returns[5]] });
  assert.deepEqual(seatFactsOf(source(), 'T4'), { lifecycle: 'active', state: 'doing', baseState: 'doing', hold: false, head: null, profileAvailable: true,
    automaticLimitReached: false, uncertain: [], openRequests: 0, pending: [] }, 'a seat without a responsible');
  assert.throws(() => seatFactsOf(source(), 'T9'), { code: 'not_found' });
});

test('a closed input, a receipt not known and a joined Run are read from the source as planInputs reads them', () => {
  assert.equal(seatFactsOf(source({ inputClosed: new Set(['R2']) }), 'T2').head?.inputOpen, false);
  const unknown = seatFactsOf(source({ uncertainInputs: new Map([['P2', new Set(['R5'])]]), inputClosed: new Set(['R2']) }), 'T2');
  assert.deepEqual(unknown.uncertain, [inFlight], 'the delivery whose wake Request\'s Run went into R2 unconfirmed');
  assert.deepEqual(wakeBlock(unknown), { code: 'uncertain', human: true, key: 'uncertain:RETu', at: inFlight.createdAt, count: null });
  // A joined Run is never the head: the owner Run it joined (R5 into R2) is, so the seat fails as that Run.
  assert.deepEqual(seatFactsOf(source(), 'T2').head, { state: 'running', intoState: null, inputOpen: true });
  const failed = runs.map(run => run.id === 'R2' ? { ...run, state: 'failed' as const, reason: 'exit' as const, ended_at: time } : run);
  const facts = seatFactsOf(source({ records: failed }), 'T2');
  assert.deepEqual(facts.head, { state: 'failed', intoState: null, inputOpen: false });
  assert.equal(wakeBlock(facts)?.code, 'failed', 'a seat whose Run a later one joined fails as the Run it joined');
});

test('the owner Run before a queued one is the seat\'s head of the Runs before it: never a worker Run or a joined one', () => {
  // P2's conversation: a worker Run it ran before it became the responsible, two owner Runs, a wake joined into the
  // first that failed, the queued continuation the scheduler and ReturnLifecycle ask about, and a later failed Run.
  const worker = record('R1', { role: 'worker', placementId: 'P2', state: 'failed', ended_at: time });
  const failed = record('R2', { placementId: 'P2', state: 'failed', ended_at: time }), owner = endedRun('R3', { placementId: 'P2' });
  const joined = record('R4', { placementId: 'P2', state: 'joined', into: 'R2', ended_at: time });
  const queued = record('R5', { placementId: 'P2' }), later = record('R6', { placementId: 'P2', state: 'failed', ended_at: time });
  const conversation = [worker, failed, owner, joined, queued, later];
  assert.deepEqual(seatRunBefore(conversation, queued), { state: 'succeeded', intoState: null },
    'R3, the latest owner Run before R5: the joined R4 and the later R6 are not read');
  assert.equal(seatFailed({ baseState: 'doing' }, seatRunBefore(conversation, queued)), false);
  assert.deepEqual(seatRunBefore(conversation, owner), { state: 'failed', intoState: null }, 'R2 before R3');
  assert.equal(seatRunBefore(conversation, failed), null, 'the worker Run R1 is not the seat\'s turn');
});

test('an automatic wake sees the earlier request fail even if its final attempt has a greater Run number', () => {
  const original = record('R2', { placementId: 'P2', state: 'failed', ended_at: time, supersededBy: 'R4' });
  const waiting = record('R3', { placementId: 'P2' });
  const final = record('R4', { placementId: 'P2', requestId: original.requestId,
    firstRunId: original.id, attempt: 1, state: 'failed', ended_at: time });
  const before = seatRunBefore([original, waiting, final], waiting);
  assert.equal(seatFailed({ baseState: 'doing' }, before), true, 'block before Task state has caught up');
});

test("a seat's profile and automatic limit are the workspace's settings, and the user's Request counts again from zero", () => {
  const facts = seatFactsOf(source({}, { profiles: new Set(['other']), automaticLimit: 1 }), 'T2');
  assert.deepEqual([facts.profileAvailable, facts.automaticLimitReached], [false, true]);
  assert.equal(seatFactsOf(source({}, { ...configured, automaticLimit: 2 }), 'T2').automaticLimitReached, false);
  const again = [...requests, request('again', 'T2', 'P2', 'human', 6, null)];
  assert.equal(seatFactsOf(source({ requests: again }, { ...configured, automaticLimit: 1 }), 'T2').automaticLimitReached, false);
});

test('seat automatic facts are captured eagerly; a new source observes changed Request rows', () => {
  const items = [request('capture', 'T2', 'P2', 'returns', 3, 'R5')];
  const captured = source({ requests: items }, { ...configured, automaticLimit: 1 });
  items[0]!.deliveryState = 'aborted';
  items[0]!.placementId = 'different';
  items.splice(0, 1);
  assert.equal(seatFactsOf(captured, 'T2').automaticLimitReached, true, 'capture precedes the first seat query');
  assert.equal(seatFactsOf(source({ requests: items }, { ...configured, automaticLimit: 1 }), 'T2').automaticLimitReached, false);
  assert.equal(Object.isFrozen(items), false, 'source must not freeze its caller array');
});


test('a captured automatic index still reads the Task ancestry and current placement at each seat query', () => {
  const scope = tasks.map(task => ({ ...task, meta: { ...task.meta } }));
  const held = placement('P2', 'T2'), automatic = request('auto-parent', 'T2', 'P2', 'returns', 1, null);
  const reset = request('reset-elsewhere', 'T4', 'P4', 'human', 2, null);
  const captured = source({ requests: [automatic, reset], placements: [held] }, { ...configured, automaticLimit: 1 }, scope);
  assert.equal(seatFactsOf(captured, 'T2').automaticLimitReached, true);
  scope.find(task => task.id === 'T2')!.meta.parentId = 'T4';
  scope.find(task => task.id === 'T4')!.meta.parentId = 'P1';
  assert.equal(seatFactsOf(captured, 'T2').automaticLimitReached, false, 'current parent makes the captured user reset an ancestor');
  scope.find(task => task.id === 'T2')!.meta.parentId = 'P1';
  held.id = 'new-placement';
  assert.equal(seatFactsOf(captured, 'T2').automaticLimitReached, false, 'a changed placement queries its own captured group');
});
