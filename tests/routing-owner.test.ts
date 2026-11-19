/** An interrupted routing pass keeps its exact range until all business work completed. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeLog, type ChangeSeq } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RoutingOwner } from '@alpacawork/backend/test-dist/receiver/routing-owner.js';
import type { PublishedFrame, RoutingWorkSet } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { taskFlow } from './task-flow.fixture.ts';
const seq = (n: number) => n as ChangeSeq;
const completed = (value: boolean) => ({ completed: value, acceptedRequestIds: [], held: [] });
const frame = (applied: ChangeSeq, ids: string[] = []): PublishedFrame => ({ applied, records: { taskIds: () => ids, environment: () => ({ writable: true }) } }) as PublishedFrame;

test('only completed ranges advance routing, and overflow keeps the suspended sweep slice', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const log = new ChangeLog(2);
  let current = frame(seq(0)), outcome: 'done' | 'incomplete' | 'busy' = 'incomplete';
  const calls: RoutingWorkSet[] = [];
  const fake = { route: async (work: RoutingWorkSet) => {
    calls.push(work);
    if (outcome === 'busy') throw new Problem(PROBLEM_CODE.busy, 'Synthetic writer is busy');
    return { ...completed(outcome === 'done'), completedThrough: outcome === 'done' ? work.through : null };
  } } as unknown as ReturnRouter;
  const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
  const batches = () => { const read = log.read('routing'); assert.ok(read.kind === 'changes'); return read.batches; };
  t.after(() => owner.close());
  const first = log.append([{ kind: 'task', id: 'T2' }]); current = frame(first);
  const work: RoutingWorkSet = { after: seq(0), through: first, tasks: new Set(['T2']), mode: 'changed' };
  owner.enqueue(work, false);
  await owner.pass();
  assert.equal(log.read('routing').kind, 'changes');
  assert.equal(batches().length, 1);
  now += 250; outcome = 'busy'; await owner.pass();
  now += 250; outcome = 'done'; await owner.pass();
  assert.equal(calls[0], calls[1]); assert.equal(calls[1], calls[2]);
  assert.equal(batches().length, 0);

  log.append([{ kind: 'task', id: 'T3' }]); log.append([{ kind: 'task', id: 'T4' }]);
  const recovery = log.append([{ kind: 'task', id: 'T5' }]);
  const ids = Array.from({ length: 20 }, (_, i) => `T${i + 2}`); current = frame(recovery, ids);
  outcome = 'incomplete'; await owner.pass();
  const slice = calls.at(-1)!;
  assert.equal(slice.mode, 'sweep'); assert.ok(slice.tasks.size <= 16);
  assert.equal(log.read('routing').kind, 'overflow');
  const later = log.append([{ kind: 'task', id: 'T21' }]); current = frame(later, ids);
  owner.enqueue({ after: recovery, through: later, tasks: new Set(['T21']), mode: 'changed' }, false);
  outcome = 'done'; await owner.pass();
  assert.equal(calls.at(-1)!.through, later, 'newly changed seats do not wait for a full recovery sweep');
  assert.equal(calls.at(-1)!.mode, 'changed');
  assert.equal(log.read('routing').kind, 'overflow', 'completed newer work cannot acknowledge the unfinished recovery');
  now += 250;
  const beforeResume = calls.length;
  await owner.pass();
  assert.equal(calls[beforeResume], slice, 'the original suspended slice resumes with its range unchanged');
  assert.equal(log.read('routing').kind, 'overflow', 'one recovery slice leaves the remaining seats for a later pass');
  await owner.pass(); await owner.pass();
  assert.equal(batches().length, 0);

  const firstFull = log.append([{ kind: 'task', id: 'T2' }]); current = frame(firstFull, ids);
  owner.enqueue({ after: later, through: firstFull, tasks: new Set(ids), mode: 'changed' }, true);
  outcome = 'incomplete'; await owner.pass(); const retained = calls.at(-1)!;
  const nextFull = log.append([{ kind: 'task', id: 'T3' }]); current = frame(nextFull, ids);
  owner.enqueue({ after: firstFull, through: nextFull, tasks: new Set(ids), mode: 'changed' }, true);
  now += 250; outcome = 'done';
  const beforeFullResume = calls.length;
  await owner.pass();
  assert.equal(calls[beforeFullResume], retained);
  for (let i = 0; i < 7; i++) await owner.pass();
  assert.ok(calls.filter(call => call.through >= firstFull).every(call => call.tasks.size <= 16),
    'a newer full publication cannot turn a suspended recovery into one all-seat transaction');
  assert.equal(batches().length, 0);
});

test('a retained periodic sweep cannot rewind routing after newer work and a full publication', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const log = new ChangeLog(), ids = Array.from({ length: 20 }, (_, index) => `T${index + 2}`);
  let current = frame(seq(0), ids), done = true;
  const calls: RoutingWorkSet[] = [];
  const fake = { route: async (work: RoutingWorkSet) => {
    calls.push(work);
    return { ...completed(done), completedThrough: done ? work.through : null };
  } } as unknown as ReturnRouter;
  const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
  t.after(() => owner.close());
  const first = log.append([{ kind: 'task', id: 'T2' }]); current = frame(first, ids);
  owner.enqueue({ after: seq(0), through: first, tasks: new Set(['T2']), mode: 'changed' }, false);
  await owner.pass();

  now = 300_000; done = false;
  await owner.pass();
  const retained = calls.at(-1)!;
  assert.equal(retained.mode, 'sweep');
  assert.equal(retained.through, first);
  const newer = log.append([{ kind: 'task', id: 'T3' }]); current = frame(newer, ids);
  owner.enqueue({ after: first, through: newer, tasks: new Set(['T3']), mode: 'changed' }, false);
  done = true; await owner.pass();
  assert.equal(calls.at(-1)!.through, newer);
  const full = log.append([{ kind: 'task', id: 'T4' }]); current = frame(full, ids);
  owner.enqueue({ after: newer, through: full, tasks: new Set(ids), mode: 'changed' }, true);
  now += 250;
  const beforeResume = calls.length;
  await owner.pass();
  assert.equal(calls[beforeResume], retained, 'the original slice and range resume before the newer recovery');
  for (let index = 0; index < 6; index++) await owner.pass();
  const read = log.read('routing');
  assert.equal(read.kind, 'changes');
  if (read.kind === 'changes') assert.deepEqual(read.batches, [], 'the newer full recovery completed without a backward acknowledgment');
  assert(calls.filter(work => work.mode === 'sweep').every(work => work.tasks.size <= 16));
});

test('an older in-flight range cannot remove later ordinary work after a full publication', async t => {
  const log = new ChangeLog();
  let current = frame(seq(0), ['T2']), finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const calls: RoutingWorkSet[] = [];
  const fake = { route: async (work: RoutingWorkSet) => {
    calls.push(work);
    if (calls.length === 1) { entered(); await new Promise<void>(resolve => { finish = resolve; }); }
    return { ...completed(true), completedThrough: work.through };
  } } as unknown as ReturnRouter;
  const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
  t.after(() => owner.close());
  const first = log.append([{ kind: 'task', id: 'T2' }]); current = frame(first, ['T2']);
  owner.enqueue({ after: seq(0), through: first, tasks: new Set(['T2']), mode: 'changed' }, false);
  const inFlight = owner.pass();
  await started;

  const full = log.append([{ kind: 'task', id: 'T2' }]); current = frame(full, ['T2']);
  owner.enqueue({ after: first, through: full, tasks: new Set(['T2']), mode: 'changed' }, true);
  const later = log.append([{ kind: 'task', id: 'T3' }]); current = frame(later, ['T2', 'T3']);
  owner.enqueue({ after: full, through: later, tasks: new Set(['T3']), mode: 'changed' }, false);
  finish(); await inFlight;

  for (let index = 0; index < 4; index++) await owner.pass();
  assert(calls.some(work => work.through === later && work.mode === 'changed' && work.tasks.has('T3')),
    'the Task added after the recovery boundary still receives its ordinary pass');
  const read = log.read('routing');
  assert.equal(read.kind, 'changes');
  if (read.kind === 'changes') assert.deepEqual(read.batches, []);
});

test('queued work wakes immediately, drains without pressure and cannot yield to writes beyond four seconds', async t => {
  let now = 0, pressure = true;
  t.mock.method(Date, 'now', () => now);
  const log = new ChangeLog();
  let current = frame(seq(0));
  const delivered: ChangeSeq[] = [];
  const fake = { route: async (work: RoutingWorkSet) => {
    delivered.push(work.through);
    return { ...completed(true), completedThrough: work.through };
  } } as unknown as ReturnRouter;
  const owner = new RoutingOwner(log, fake, () => current, work => work(), overdue => pressure && !overdue);
  t.after(() => owner.close());
  for (let i = 0; i < 3; i++) {
    const after = log.latest, through = log.append([{ kind: 'task', id: `T${i + 2}` }]);
    current = frame(through);
    owner.enqueue({ after, through, tasks: new Set([`T${i + 2}`]), mode: 'changed' }, false);
  }
  await owner.pass(); assert.deepEqual(delivered, []);
  now = 3999; await owner.pass(); assert.deepEqual(delivered, []);
  now = 4000; await owner.pass(); assert.deepEqual(delivered, [seq(1)]);
  pressure = false;
  await owner.pass(); assert.deepEqual(delivered, [seq(1), seq(2), seq(3)]);
  const through = log.append([{ kind: 'task', id: 'T5' }]); current = frame(through);
  owner.enqueue({ after: seq(3), through, tasks: new Set(['T5']), mode: 'changed' }, false);
  await new Promise<void>(resolve => setImmediate(resolve));
  await owner.pass();
  assert.deepEqual(delivered, [seq(1), seq(2), seq(3), through]);
  const remaining = log.read('routing'); assert.equal(remaining.kind, 'changes');
  if (remaining.kind === 'changes') assert.deepEqual(remaining.batches, []);
});

test('routing waits for publication for at most four seconds and then uses current business facts', async t => {
  const owned: { routing?: RoutingOwner } = {};
  t.after(() => owned.routing?.close());
  const f = await taskFlow(t);
  const parent = await f.task('Receiving seat'), child = await f.task('Question origin', { parentId: parent.id });
  const receiving = await f.work(parent), asking = await f.work(child, receiving);
  const question = await f.ask(asking, parent.id);
  const log = new ChangeLog(), through = log.append([{ kind: 'task', id: parent.id }]);
  const current = frame(through, [parent.id, child.id]);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const owner = owned.routing = new RoutingOwner(log, new ReturnRouter(f.root), () => current, work => work(), () => false,
    undefined, async overdue => overdue || current.applied === log.latest);
  owner.enqueue({ after: seq(0), through, tasks: new Set([parent.id]), mode: 'changed' }, false);
  log.append([{ kind: 'person', id: 'configuration' }]);
  const before = f.store(store => store.readReturns());
  await owner.pass();
  now = 3999;
  await f.withdraw(asking, question);
  const requests = f.store(store => store.readRequests());
  await owner.pass();
  assert.deepEqual(f.store(store => store.readReturns()), before, 'publication wait cannot dispatch early');
  const waiting = log.read('routing');
  assert.equal(waiting.kind, 'changes');
  if (waiting.kind === 'changes') assert.equal(waiting.batches.length, 2);

  now = 4000;
  await owner.pass();
  assert(current.applied < log.latest, 'the projection never catches the continuously moving publication floor');
  const notice = f.store(store => store.readReturns().find(row => row.causeLogId === question));
  assert(notice);
  assert.equal(notice.resolution?.reason, 'question_closed', 'routing reads the withdrawal committed while it waited');
  assert.deepEqual(notice.deliveries, []);
  assert.deepEqual(f.store(store => store.readRequests()), requests, 'the obsolete question cannot create a wake');
  const remaining = log.read('routing');
  assert.equal(remaining.kind, 'changes');
  if (remaining.kind === 'changes') assert.deepEqual(remaining.batches.map(batch => batch.seq), [log.latest],
    'the unpublished range remains unacknowledged');
});

test('completed ranges release their seats while one failed gap retains its retry and acknowledgment floor', async t => {
  let now = 0, failed = true;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  const log = new ChangeLog(2);
  let current = frame(seq(0), ['T2', 'T3']);
  const delivered = new Set<ChangeSeq>();
  const fake = { route: async (work: RoutingWorkSet) => {
    if (failed && work.tasks.has('T2')) throw new Error('Persistent seat failure');
    delivered.add(work.through);
    return { ...completed(true), completedThrough: work.through };
  } } as unknown as ReturnRouter;
  const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
  t.after(() => owner.close());
  const append = (id: string) => {
    const after = log.latest, through = log.append([{ kind: 'task', id }]);
    const work: RoutingWorkSet = { after, through, tasks: new Set([id]), mode: 'changed' };
    current = frame(through, ['T2', 'T3']); owner.enqueue(work, false);
    return work;
  };
  const gap = append('T2');
  await owner.pass();
  for (let index = 0; index < 1_000; index++) { append('T3'); await owner.pass(); }
  assert.equal(delivered.size, 1_000, 'the failed seat does not stop later seats');
  assert.equal(log.read('routing').kind, 'overflow', 'none of those completions acknowledge the unfinished gap');
  // Retained memory is part of this contract: completed seats must not accumulate behind the gap.
  const retained = (owner as unknown as { queue: { pending: RoutingWorkSet[]; retries: Map<RoutingWorkSet, unknown>;
    completedThrough: ChangeSeq } }).queue;
  assert.deepEqual(retained.pending, [gap]);
  assert.equal(retained.retries.size, 1);
  assert.equal(retained.completedThrough, log.latest);
  failed = false; now = 249;
  await owner.pass();
  assert.equal(delivered.has(gap.through), false, 'compaction preserves the failed range retry deadline');
  now = 250;
  for (let index = 0; index < 4; index++) await owner.pass();
  assert.equal(delivered.has(gap.through), true);
  assert.equal(retained.pending.length, 0);
  assert.equal(retained.retries.size, 0);
  const done = log.read('routing');
  assert.equal(done.kind, 'changes');
  if (done.kind === 'changes') assert.deepEqual(done.batches, [], 'closing the gap releases all compressed completions');
});

test('slow ordinary interruptions give recovery a turn even when another retry is already due', async t => {
  let now = 0, attempts = 0;
  t.mock.method(Date, 'now', () => now);
  const log = new ChangeLog();
  let current = frame(seq(0));
  const calls: RoutingWorkSet[] = [];
  let owner!: RoutingOwner;
  const fake = { route: async (work: RoutingWorkSet) => {
    calls.push(work);
    if (work.mode === 'changed') {
      now += 300;
      if (++attempts === 2) {
        const after = log.latest, through = log.append([{ kind: 'person', id: 'configuration' }]);
        const ids = [...Array.from({ length: 16 }, (_, i) => `T${i + 4}`), 'T2', 'T3'];
        current = frame(through, ids);
        owner.enqueue({ after, through, tasks: new Set(ids), mode: 'changed' }, true);
      }
      // Bound the old retry loop so this regression fails an assertion instead of hanging.
      if (attempts <= 6) {
        if (work.tasks.has('T2')) throw new Problem(PROBLEM_CODE.busy, 'Synthetic slow busy seat');
        return { ...completed(false), completedThrough: null };
      }
    }
    return { ...completed(true), completedThrough: work.through };
  } } as unknown as ReturnRouter;
  owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
  t.after(() => owner.close());
  for (const id of ['T2', 'T3']) {
    const after = log.latest, through = log.append([{ kind: 'task', id }]);
    current = frame(through, ['T2', 'T3']);
    owner.enqueue({ after, through, tasks: new Set([id]), mode: 'changed' }, false);
  }
  await owner.pass();
  assert.equal(attempts, 2, 'after busy and incomplete attempts, recovery runs before the already-due first retry');
  assert.equal(calls[2]?.mode, 'sweep');
  assert.equal(calls[2]?.tasks.size, 16);
  const pending = log.read('routing');
  assert.equal(pending.kind, 'changes');
  if (pending.kind === 'changes') assert.equal(pending.batches.length, 3, 'the ordinary gap still prevents acknowledgment');
});

test('faulted ranges remain unread through three failures and deliver after recovery without losing later work', async t => {
  let now = 0, failed = true;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  const log = new ChangeLog();
  let current = frame(seq(0));
  const delivered: ChangeSeq[] = [];
  const fake = { route: async (work: RoutingWorkSet) => {
    if (failed && work.through === 1) throw new Error('Synthetic delivery outage');
    delivered.push(work.through);
    return { ...completed(true), completedThrough: work.through };
  } } as unknown as ReturnRouter;
  const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
  t.after(() => owner.close());
  for (let i = 0; i < 2; i++) {
    const after = log.latest, through = log.append([{ kind: 'task', id: `T${i + 2}` }]); current = frame(through);
    owner.enqueue({ after, through, tasks: new Set([`T${i + 2}`]), mode: 'changed' }, false);
  }
  await owner.pass();
  assert.deepEqual(delivered, [seq(2)], 'later work can complete while the failed range backs off');
  now = 250; await owner.pass(); now = 750; await owner.pass();
  const unfinished = log.read('routing'); assert.equal(unfinished.kind, 'changes');
  if (unfinished.kind === 'changes') assert.equal(unfinished.batches.length, 2, 'later completion cannot acknowledge an unfinished gap');
  failed = false;
  await owner.pass(); assert.deepEqual(delivered, [seq(2)], 'recovery respects the retained retry deadline');
  now = 1750; await owner.pass();
  assert.deepEqual(delivered, [seq(2), seq(1)]);
  const done = log.read('routing'); assert.equal(done.kind, 'changes');
  if (done.kind === 'changes') assert.deepEqual(done.batches, []);

  for (const interruption of ['busy', 'incomplete'] as const) await t.test(`${interruption} defers one seat while later work completes`, async t => {
    now += 1_000;
    const log = new ChangeLog();
    let current = frame(seq(0)), blocked = true;
    const delivered: ChangeSeq[] = [];
    const fake = { route: async (work: RoutingWorkSet) => {
      if (blocked && work.through === 1) {
        if (interruption === 'busy') throw new Problem(PROBLEM_CODE.busy, 'This seat is busy');
        return { ...completed(false), completedThrough: null };
      }
      delivered.push(work.through);
      return { ...completed(true), completedThrough: work.through };
    } } as unknown as ReturnRouter;
    const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
    t.after(() => owner.close());
    for (let i = 0; i < 2; i++) {
      const after = log.latest, through = log.append([{ kind: 'task', id: `T${i + 2}` }]); current = frame(through);
      owner.enqueue({ after, through, tasks: new Set([`T${i + 2}`]), mode: 'changed' }, false);
    }
    await owner.pass();
    assert.deepEqual(delivered, [seq(2)], 'the blocked seat does not prevent a later seat receiving its work');
    now += 250; await owner.pass();
    const waiting = log.read('routing'); assert.equal(waiting.kind, 'changes');
    if (waiting.kind === 'changes') assert.equal(waiting.batches.length, 2, 'the unfinished range still prevents acknowledgment');
    blocked = false;
    await owner.pass(); assert.deepEqual(delivered, [seq(2)], 'the retry still waits its short deadline');
    now += 250; await owner.pass();
    assert.deepEqual(delivered, [seq(2), seq(1)], 'local interruptions keep the same short retry instead of increasing fault backoff');
    const done = log.read('routing'); assert.equal(done.kind, 'changes');
    if (done.kind === 'changes') assert.deepEqual(done.batches, []);
  });

  await t.test('ordinary backoff does not stop an available recovery slice', async t => {
    now += 1_000;
    const log = new ChangeLog();
    let current = frame(seq(0)), blocked = true;
    const delivered: ChangeSeq[] = [];
    const fake = { route: async (work: RoutingWorkSet) => {
      if (blocked && work.through === 2) return { ...completed(false), completedThrough: null };
      delivered.push(work.through);
      return { ...completed(true), completedThrough: work.through };
    } } as unknown as ReturnRouter;
    const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
    t.after(() => owner.close());
    const recovery = log.append([{ kind: 'task', id: 'T2' }]); current = frame(recovery, ['T2']);
    owner.enqueue({ after: seq(0), through: recovery, tasks: new Set(['T2']), mode: 'changed' }, true);
    const later = log.append([{ kind: 'task', id: 'T3' }]); current = frame(later, ['T2', 'T3']);
    owner.enqueue({ after: recovery, through: later, tasks: new Set(['T3']), mode: 'changed' }, false);
    await owner.pass();
    assert.deepEqual(delivered, [recovery], 'recovery completes while ordinary work is deferred');
    await owner.pass();
    const waiting = log.read('routing'); assert.equal(waiting.kind, 'changes');
    if (waiting.kind === 'changes') assert.deepEqual(waiting.batches.map(batch => batch.seq), [later],
      'the completed recovery does not acknowledge later unfinished work');
    blocked = false; now += 250; await owner.pass();
    assert.deepEqual(delivered, [recovery, later]);
    const done = log.read('routing'); assert.equal(done.kind, 'changes');
    if (done.kind === 'changes') assert.deepEqual(done.batches, []);
  });

  await t.test('full and overflow recovery retain ordinary gaps and their fault backoff', async t => {
    now = 0;
    const log = new ChangeLog(2);
    let current = frame(seq(0)), failed = true, ids: string[] = [];
    const calls: RoutingWorkSet[] = [], faulted = new Set<RoutingWorkSet>();
    const fake = { route: async (work: RoutingWorkSet) => {
      calls.push(work);
      if (failed && faulted.has(work)) throw new Error('Synthetic retained range fault');
      return { ...completed(true), completedThrough: work.through };
    } } as unknown as ReturnRouter;
    const owner = new RoutingOwner(log, fake, () => current, work => work(), () => false);
    t.after(() => owner.close());
    const ordinary = (id: string, fails = false) => {
      const after = log.latest, through = log.append([{ kind: 'task', id }]);
      const work: RoutingWorkSet = { after, through, tasks: new Set([id]), mode: 'changed' };
      if (fails) faulted.add(work);
      ids = [...new Set([...ids, id])];
      current = frame(through, ids); owner.enqueue(work, false);
      return work;
    };
    const full = (nextIds: string[]) => {
      const after = log.latest, through = log.append([{ kind: 'person', id: 'configuration' }]);
      ids = nextIds;
      current = frame(through, ids);
      owner.enqueue({ after, through, tasks: new Set(ids), mode: 'changed' }, true);
      return through;
    };
    const gap = ordinary('T2', true), later = ordinary('T3');
    await owner.pass(); now = 250; await owner.pass(); now = 750; await owner.pass();
    assert.equal(calls.filter(work => work === gap).length, 3);
    full(['T2', 'T3']);
    assert.equal(log.read('routing').kind, 'overflow');
    const beforeSweep = calls.length;
    await owner.pass();
    assert.equal(calls.length, beforeSweep, 'a new full sweep cannot bypass the failed Task backoff');
    full(['T2', 'T3', 'T4']);
    const newest = ordinary('T4');
    await owner.pass();
    assert.equal(calls.at(-1), newest, 'unrelated ordinary work proceeds while the overlapping slice waits');
    now = 1749; failed = false;
    await owner.pass();
    assert.equal(calls.filter(work => work === gap).length, 3, 'full and pending recovery preserve the original deadline');
    now = 1750;
    const beforeRetry = calls.length;
    await owner.pass();
    assert.equal(calls[beforeRetry], gap, 'the due original range runs before the overlapping sweep');
    for (let index = 0; index < 5; index++) await owner.pass();
    assert.equal(calls.filter(work => work === later).length, 1, 'completed later work is retained across full recovery');
    let remaining = log.read('routing');
    assert.equal(remaining.kind, 'changes');
    if (remaining.kind === 'changes') assert.deepEqual(remaining.batches, []);

    failed = true;
    const absentGap = ordinary('T9', true);
    await owner.pass();
    full(['T3']);
    await owner.pass();
    const recovered = full(['T3']);
    for (let index = 0; index < 5; index++) await owner.pass();
    assert.equal(log.read('routing').kind, 'overflow', 'completed recovery cannot acknowledge the older ordinary gap');
    const recoveredCalls = calls.length;
    await owner.pass(); await owner.pass();
    assert.equal(calls.length, recoveredCalls, 'the same completed overflow boundary is not swept again while its gap waits');
    failed = false; now += 250;
    const beforeGap = calls.length;
    await owner.pass();
    assert.equal(calls[beforeGap], absentGap);
    remaining = log.read('routing');
    assert.equal(remaining.kind, 'changes');
    if (remaining.kind === 'changes') {
      assert.equal(remaining.through, recovered);
      assert.deepEqual(remaining.batches, [], 'closing the gap acknowledges the remembered completed recovery too');
    }
  });
});
