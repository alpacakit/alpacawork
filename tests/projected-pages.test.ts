import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskProjectedPageSchema, taskProjectedSearchSchema, taskProjectedTimelineSchema, taskProjectedTimelineAxisSchema } from '@alpacawork/contract/control';
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

test('timeline and axis expire together by scope, bind cursors to their query, and retain exact note records', () => {
  const project = bundle('P1'), task = bundle('T1', 'P1', [entry('L1', 1), entry('L2', 2)]);
  const records = new FakeRecords([project, task, bundle('T99')]);
  const first = frame(records, { requiredPv: { view: {}, history: {}, page: {}, search: {}, timeline: { root: pv(1) } } });
  records.taskIds = () => { throw new Error('A timeline must not enumerate unrelated Tasks'); };
  const lookup = records.bundle.bind(records);
  records.bundle = id => { assert.notEqual(id, 'T99', 'an unrelated branch is not a timeline input'); return lookup(id); };
  const reads = new ProjectedPages();
  const query = { scope: 'root', visible: 'T1', folded: '', from: at(0), to: at(10), limit: 1 };
  const page = taskProjectedTimelineSchema.parse(reads.timeline(first, query));
  assert.ok(page.nextAfter);
  const next = taskProjectedTimelineSchema.parse(reads.timeline({ ...first, pv: pv(2) }, { ...query, after: page.nextAfter! }));
  assert.equal(next.sourcePv, 1);
  const counts = { live: 1, finished: 2, states: { todo: 1, doing: 0, error: 0, waiting: 0, held: 0, done: 2, stopped: 0 }, runningBelow: 0, below: 3 };
  const refreshed = reads.timeline({ ...first, pv: pv(2), aggregate: { ...first.aggregate, children: () => counts } }, query);
  assert.deepEqual(refreshed.rows[0]?.childCounts, { live: 1, finished: 2 });
  assert.deepEqual(refreshed.events, page.events, 'unchanged timeline events retain their prepared scope');
  assert.notDeepEqual(next.events, page.events);
  assert.throws(() => reads.timeline(first, { ...query, from: at(1), after: page.nextAfter! }), changed('timeline_changed_read_from_first_page'));
  const axis = taskProjectedTimelineAxisSchema.parse(reads.timelineAxis(first, { scope: 'root', lanes: 'T1', folded: '' }));
  assert.equal(axis.earliest, Date.parse(at(1)));
  const updated = { ...task, task: { ...task.task, meta: { ...task.task.meta, title: 'New title', log: [entry('L0', -1), ...task.task.meta.log] } } };
  const latest = frame(new FakeRecords([project, updated], pv(3)), { requiredPv: { ...first.requiredPv, timeline: { root: pv(3) } } });
  const changedAxis = reads.timelineAxis(latest, { scope: 'root', lanes: 'T1', folded: '' });
  assert.equal(changedAxis.earliest, Date.parse(at(-1)));
  assert.equal(changedAxis.sourcePv, 3);
  const changedTimeline = reads.timeline(latest, { ...query, from: at(-2), limit: 20 });
  assert.equal(changedTimeline.rows[0]?.title, 'New title');
  assert.ok(changedTimeline.events.some(event => event.kind === 'note' && event.event.id === 'L0'));
  assert.throws(() => reads.timeline(latest, { ...query, after: page.nextAfter! }), changed('timeline_changed_read_from_first_page'));
});
