import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTimelinePatch, taskProjectedPageSchema, taskProjectedSearchSchema, taskTimelineLanesSchema, taskProjectedTimelineAxisSchema,
  timelineEventOrder, timelineLogOf, type TaskTimelineLaneDTO } from '@alpacawork/contract/control';
import { Problem } from '@alpacawork/core';
import { ProjectedPages } from '@alpacawork/backend/test-dist/receiver/index-pages.js';
import { at, bundle, entry, FakeRecords, frame, pv, emptyAggregate } from './helpers/projection-read-fixture.ts';

const changed = (kind: string) => (error: unknown) => error instanceof Problem && error.reason?.kind === kind;

test('closed pages slice aggregate order without enumerating records and reject changed resource cursors', () => {
  const records = new FakeRecords([bundle('P1'), bundle('T1'), bundle('T2')]);
  const counts = { live: 2, finished: 3, states: { todo: 2, doing: 0, error: 0, waiting: 0, held: 0, done: 3, stopped: 0 }, runningBelow: 0, below: 5 };
  const first = frame(records, { requiredPv: { view: {}, history: {}, page: { 'finished:root': pv(1) }, search: {}, timeline: {} },
    aggregate: { ...emptyAggregate, page: name => { assert.equal(name, 'finished:root'); return ['T2', 'T1']; },
      children: id => id === 'T2' ? counts : undefined, movedAt: id => id === 'T2' ? 20 : 10 } });
  records.taskIds = () => { throw new Error('A page must not enumerate Tasks'); };
  const reads = new ProjectedPages();
  const page = taskProjectedPageSchema.parse(reads.page(first, 'finished', null, null, undefined, 1));
  assert.equal(page.rows[0]!.id, 'T2');
  assert.deepEqual(page.rows[0]!.childCounts, { live: 2, finished: 3 });
  assert.equal(page.total, 2);
  const second = reads.page({ ...first, pv: pv(2) }, 'finished', null, null, page.nextAfter!, 1);
  assert.equal(second.rows[0]!.id, 'T1');
  assert.equal(second.sourcePv, 2);
  assert.throws(() => reads.page({ ...first, pv: pv(3), requiredPv: { ...first.requiredPv, page: { 'finished:root': pv(3) } } },
    'finished', null, null, page.nextAfter!, 1), changed('page_changed_read_from_first_page'));
  assert.throws(() => reads.page({ ...first, generation: 'new' }, 'finished', null, null, page.nextAfter!, 1), changed('page_changed_read_from_first_page'));
});

test('search reads ID, title and values within scope and expires only with its required projection version', () => {
  const project = bundle('P1'), nested = bundle('P2', 'P1');
  const titleMatch = bundle('T1', 'P2'); titleMatch.task.meta.title = 'Needle title';
  const valueMatch = bundle('T2', 'P2'); valueMatch.task.values = { goal: 'A needle in the field' };
  const unrelated = bundle('T3', 'P1'); unrelated.task.meta.title = 'Other';
  const nonmatching = bundle('T4', 'P2');
  const records = new FakeRecords([project, nested, titleMatch, valueMatch, unrelated, nonmatching]);
  const point = frame(records, { aggregate: { ...emptyAggregate, movedAt: id => id === 'T1' ? 20 : 10 },
    requiredPv: { view: {}, history: {}, page: {}, search: { P2: pv(1) }, timeline: {} } });
  const first = { ...point, derived: (id: string) => { assert.notEqual(id, 'T4', 'nonmatching rows are not assembled'); return point.derived(id); } };
  const reads = new ProjectedPages();
  const page = taskProjectedSearchSchema.parse(reads.search(first, 'needle', 'P2', undefined, 1));
  assert.deepEqual(page.rows.map(row => row.id), ['T1']);
  assert.equal(page.total, 2);
  assert.deepEqual(page.ancestors.map(row => row.id), ['P2', 'P1']);
  const second = reads.search({ ...first, pv: pv(2) }, 'needle', 'P2', page.nextAfter!, 1);
  assert.equal(second.rows[0]!.id, 'T2');
  assert.match(second.lines.T2!, /needle/);
  assert.equal(second.sourcePv, 1, 'the unchanged prepared scope keeps the frame it was made from');
  assert.equal(reads.search(first, 'T3', 'P2').total, 0);
  assert.equal(reads.search(first, 'T2', 'P2').total, 1);
  assert.throws(() => reads.search(first, 'title', 'P2', page.nextAfter!, 1), changed('search_changed_read_from_first_page'));
  const revised = { ...valueMatch, task: { ...valueMatch.task, meta: { ...valueMatch.task.meta, title: 'Renamed' }, values: { goal: 'Unmatched now' } } };
  const latest = frame(new FakeRecords([project, nested, titleMatch, revised, unrelated], pv(3)), {
    requiredPv: { ...first.requiredPv, search: { P2: pv(3) } }, aggregate: first.aggregate });
  assert.equal(reads.search(latest, 'needle', 'P2').total, 1);
  assert.throws(() => reads.search(latest, 'needle', 'P2', page.nextAfter!, 1), changed('search_changed_read_from_first_page'));
});

test('a strip and the axis expire with their rows\' versions and read only those rows\' subtrees; rows are answered whole', () => {
  const project = bundle('P1'), task = bundle('T1', 'P1', [entry('L1', 1), entry('L2', 2)]), other = bundle('T2', 'P1', [entry('L3', 3)]);
  const records = new FakeRecords([project, task, other, bundle('T99')]);
  const first = frame(records, { requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: { T1: pv(1), T2: pv(1) } } });
  records.taskIds = () => { throw new Error('A timeline must not enumerate unrelated Tasks'); };
  const lookup = records.bundle.bind(records);
  records.bundle = id => { assert.notEqual(id, 'T99', 'an unrelated branch is not a timeline input'); return lookup(id); };
  const reads = new ProjectedPages();
  const query = { lanes: 'T1,T2', from: at(0), to: at(10) };
  const answer = taskTimelineLanesSchema.parse(reads.timeline(first, query));
  assert.deepEqual(answer.lanes.map(lane => [lane.lane, lane.row.id, lane.sourcePv]), [['T1', 'T1', 1], ['T2', 'T2', 1]]);
  // The row carries only what its current state is drawn from; its chronology is the strip's events.
  assert.deepEqual(answer.lanes[0]!.row.stateLog.map(log => log.id), ['L2']);
  assert.deepEqual(answer.lanes[0]!.events.flatMap(event => event.kind === 'note' ? [event.event.id] : []), ['L1', 'L2']);
  assert.deepEqual(reads.timeline(first, { ...query, limit: 1 }).lanes.map(lane => lane.lane), ['T1'], 'a row is never cut: at least one, whole');
  assert.deepEqual(reads.timeline(first, { ...query, lanes: 'T1,T404' }).gone, ['T404']);
  const held = reads.timeline({ ...first, pv: pv(2) }, query).lanes;
  assert.equal(held[0]!.token, reads.timeline(first, query).lanes[0]!.token, 'a strip whose row version holds is not made again');
  const axis = taskProjectedTimelineAxisSchema.parse(reads.timelineAxis(first, { lanes: 'T1' }));
  assert.equal(axis.earliest, Date.parse(at(1)));
  const updated = { ...task, task: { ...task.task, meta: { ...task.task.meta, title: 'New title', log: [entry('L0', -1), ...task.task.meta.log] } } };
  const latest = frame(new FakeRecords([project, updated, other], pv(3)), { requiredPv: { ...first.requiredPv, timeline: { T1: pv(3), T2: pv(1) } } });
  const changedAxis = reads.timelineAxis(latest, { lanes: 'T1' });
  assert.equal(changedAxis.earliest, Date.parse(at(-1)));
  assert.equal(changedAxis.sourcePv, 3);
  const [changedStrip, otherStrip] = reads.timeline(latest, { ...query, from: at(-2) }).lanes;
  assert.equal(changedStrip?.row.title, 'New title');
  assert.ok(changedStrip?.events.some(event => event.kind === 'note' && event.event.id === 'L0'));
  assert.equal(reads.timeline(latest, query).lanes[1]!.token, held[1]!.token, 'a row whose version holds keeps its strip');
  assert.equal(otherStrip?.sourcePv, 3);
});

test('a row the server does not read is left out of strips and the axis, never failing the read of the others', () => {
  const records = new FakeRecords([bundle('P1'), bundle('T1', 'P1', [entry('L1', 1)]), bundle('T2', 'P1', [entry('L2', 2)])]);
  const base = frame(records);
  // T2 has no derived facts (its derivation never succeeded); T404 does not exist.
  const point = { ...base, derived: (id: string) => id === 'T2' ? undefined : base.derived(id) };
  const reads = new ProjectedPages();
  const strips = taskTimelineLanesSchema.parse(reads.timeline(point, { lanes: 'T1,T2,T404', from: at(0), to: at(10) }));
  assert.deepEqual([strips.lanes.map(lane => lane.lane), strips.gone], [['T1'], ['T2', 'T404']]);
  const axis = taskProjectedTimelineAxisSchema.parse(reads.timelineAxis(point, { lanes: 'T1,T2,T404' }));
  assert.equal(axis.earliest, Date.parse(at(1)));
});

/** A strip as drawn: its events in order, its other items whatever their order, without the server's name for it. */
const drawn = ({ token: _token, ...lane }: TaskTimelineLaneDTO) => ({ ...lane,
  belowRuns: [...lane.belowRuns].sort(), placements: [...lane.placements].sort((a, b) => a.id.localeCompare(b.id)) });

test('a row read again with the strip it holds, of this range or another, is sent only what changed; made whole it is the strip read afresh', () => {
  // Records of one time, caused at different times: their order is the strip's, however it was put together.
  const log = [...Array.from({ length: 40 }, (_, index) => entry(`L${index + 1}`, index + 1)),
    entry('S1', 50, { causeAt: at(45) }), entry('S2', 50, { causeAt: at(30), toState: 'waiting' })];
  const project = bundle('P1'), task = bundle('T1', 'P1', log);
  const first = frame(new FakeRecords([project, task]), { requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: { T1: pv(1) } } });
  const reads = new ProjectedPages(), query = { lanes: 'T1', from: at(0), to: at(100) };
  const [whole] = taskTimelineLanesSchema.parse(reads.timeline(first, query)).lanes;
  assert.equal(whole!.base, null);
  const held = applyTimelinePatch(null, whole!);
  const added = { ...task, task: { ...task.task, meta: { ...task.task.meta, log: [...log, entry('L41', 41)] } } };
  const latest = frame(new FakeRecords([project, added], pv(2)), { requiredPv: { ...first.requiredPv, timeline: { T1: pv(2) } } });
  const narrow = applyTimelinePatch(null, reads.timeline(first, { ...query, from: at(40) }).lanes[0]!);
  const [widened] = reads.timeline(first, { ...query, bases: `T1:${narrow.token}` }).lanes;
  assert.deepEqual(drawn(applyTimelinePatch(narrow, widened!)), drawn(held), 'a wider range laid on a narrower one keeps the one order');
  for (const range of [query, { ...query, from: at(20) }]) {
    const [patch] = taskTimelineLanesSchema.parse(reads.timeline(latest, { ...range, bases: `T1:${held.token}` })).lanes;
    assert.equal(patch!.base, held.token);
    const [afresh] = new ProjectedPages().timeline(latest, range).lanes;
    assert.deepEqual(drawn(applyTimelinePatch(held, patch!)), drawn(applyTimelinePatch(null, afresh!)));
    if (range === query) assert.ok(patch!.events.length <= 2 && patch!.drop.length === 0, 'one new record is sent as itself, not the whole strip');
    else assert.ok(patch!.drop.length >= 19, 'what a narrower range leaves out is dropped');
  }
  const [unknown] = reads.timeline(latest, { ...query, bases: 'T1:not-kept' }).lanes;
  assert.equal(unknown!.base, null, 'a strip no longer kept is answered whole');
  assert.throws(() => applyTimelinePatch({ ...held, token: 'other' }, { ...unknown!, base: held.token }), 'a patch is never laid on another strip');
});

test('screens holding one row over several ranges are each sent only what changed, whatever order they read in', () => {
  const project = bundle('P1');
  let log = Array.from({ length: 30 }, (_, index) => entry(`L${index + 1}`, index + 1));
  const reads = new ProjectedPages(), ranges = [at(0), at(10), at(20)].map(from => ({ lanes: 'T1', from, to: at(100) }));
  const frameAt = (n: number) => frame(new FakeRecords([project, bundle('T1', 'P1', log)], pv(n)),
    { requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: { T1: pv(n) } } });
  const held = ranges.map(range => reads.timeline(frameAt(1), range).lanes[0]!.token);
  for (let n = 2; n <= 5; n++) {
    log = [...log, entry(`L${30 + n}`, 30 + n)];
    const order = n % 2 ? [0, 1, 2] : [2, 1, 0];
    for (const screen of order) {
      const [patch] = reads.timeline(frameAt(n), { ...ranges[screen]!, bases: `T1:${held[screen]}` }).lanes;
      assert.equal(patch!.base, held[screen], `screen ${screen} after record ${n} is sent what changed`);
      held[screen] = patch!.token;
    }
  }
});

test('records of one time keep the order they had before strips were patched (IDs compared as text is compared)', () => {
  const events = ['A', 'a'].map(id => ({ kind: 'log' as const, taskId: 'T1', entry: entry(id, 1) as unknown as ReturnType<typeof timelineLogOf> }));
  assert.deepEqual(events.sort(timelineEventOrder).map(event => event.entry.id), ['a', 'A']);
});
