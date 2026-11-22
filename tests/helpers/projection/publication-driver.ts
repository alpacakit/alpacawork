/** The real server publication owner, compared with independent full database reads after the shared replay writes. */
import assert from 'node:assert/strict';
import { ChangeLog, type ChangeKey, type ControlStore } from '@alpacawork/db';
import type { PublishedFrame } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { ProjectionOwner, type PersonalProjection } from '@alpacawork/backend/test-dist/receiver/projection-owner.js';
import { emptyWorkspaceRecords, type WorkspaceObservations } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { createScreenAggregate, type AggregateSnapshot } from '@alpacawork/backend/test-dist/receiver/screen-aggregate.js';
import { aggregateFactsOf } from '@alpacawork/backend/test-dist/receiver/workspace-aggregate-facts.js';
import { composeRow, liveRow } from '@alpacawork/backend/test-dist/receiver/index-rows.js';
import { meaning, type Observation } from './harness.ts';
import { ReadResources, recordsMeaning } from './resources.ts';
import type { MutationState } from './mutations.ts';

export async function publicationDriver(root: string, store: ControlStore, observations: WorkspaceObservations, state: MutationState) {
  const log = new ChangeLog(2), reads = new ReadResources();
  const ticks: { tasks: number }[] = [], publications: { frame: PublishedFrame; full: boolean }[] = [];
  let pause: Promise<void> | undefined;
  const personal = (): PersonalProjection => ({
    person: { settings: null, notices: state.fresh ? 'b'.repeat(64) : null, coordinator: null },
    presence: { state: 'away', until: null }, host: null, coordinatorWork: null });
  const owner = new ProjectionOwner({ root, log, observations, generation: 'publication-replay', locations: () => ({}),
    personal: async () => { await pause; return personal(); },
    published(frame, _previous, _work, full) { publications.push({ frame, full }); },
    timing(event) { if (event.step === 'projection-audit') ticks.push({ tasks: Number(event.tasks) }); },
  });
  try { await owner.start(); } catch (error) { await owner.close(); throw error; }

  function full(frame: PublishedFrame): PublishedFrame {
    const records = store.read(db => emptyWorkspaceRecords(root, observations).load(db, frame.pv));
    const values = new Map([...records.taskIds()].map(id => [id, deriveTask(records, id)]));
    const facts = new Map([...values].map(([id, value]) => [id, aggregateFactsOf(records, id, value.row, personal().notices)]));
    return { ...frame, records, derived: id => values.get(id),
      aggregate: createScreenAggregate([...values.values()].map(value => value.contribution), facts) };
  }
  function index(frame: PublishedFrame) {
    const { records, aggregate } = frame;
    const ids = [...records.taskIds()].filter(id => aggregate.live(id) && records.shelf().listed.has(records.projectOf(id)));
    return {
      tasks: ids.map(id => liveRow(composeRow(frame.derived(id)!, aggregate))),
      placements: ids.flatMap(id => { const value = frame.derived(id)!; return value.placements.filter(p => value.live.placements.has(p.id)); }),
      runs: ids.flatMap(id => { const value = frame.derived(id)!; return value.runs.filter(run => value.live.runs.has(run.id)); }),
      home: [...aggregate.homeIds()].filter(id => ids.includes(id) && aggregate.home(id)?.section !== 'done').map(id => aggregate.home(id)),
      counts: { ...aggregate.counts(), children: Object.fromEntries([...records.taskIds()].flatMap(id => {
        const count = aggregate.children(id); return count ? [[id, count]] : []; })) },
    };
  }
  function observe(frame: PublishedFrame, readers = new ReadResources(), liveIndex = false): Observation {
    const tree = frame.aggregate, ids = [...frame.records.taskIds()].sort();
    const actualIndex = liveIndex ? JSON.parse(owner.index()) : index(frame);
    return { pv: frame.pv, value: {
      records: recordsMeaning(frame.records), derived: Object.fromEntries(ids.map(id => [id, frame.derived(id)])),
      totals: Object.fromEntries(ids.map(id => [id, { children: tree.children(id), childCounts: tree.childCounts(id),
        usage: tree.usageBelow(id), runs: tree.runsBelow(id), working: tree.workingBelow(id), running: tree.runningRuns(id), moved: tree.movedAt(id) }])),
      home: [...tree.homeIds()].map(id => [tree.home(id), tree.homeAfter(id)]), counts: tree.counts(),
      pages: Object.fromEntries([...new Set(ids.flatMap(id => tree.pageScopes(id)))].sort().map(scope => [scope, tree.page(scope)])),
      index: Object.fromEntries(['tasks', 'placements', 'runs', 'home', 'counts'].map(key => [key, actualIndex[key as keyof typeof actualIndex]])),
    }, resources: readers.read(frame) };
  }
  function pair(frame = owner.current!) { return { incremental: observe(frame, reads, true), full: observe(full(frame)) }; }
  function title(value: string) {
    store.write(db => db.prepare("UPDATE tasks SET title=?,revision=revision+1 WHERE external_id='T5'").run(value));
    return log.append([{ kind: 'task', id: 'T5' }]);
  }
  return {
    changed(keys: readonly ChangeKey[]) { log.append(keys); },
    publication: { async verify() {
      const previous = owner.current!, held = meaning(observe(previous)), floor = log.latest;
      const pending = owner.read(floor);
      assert.equal(owner.current, previous, 'an asynchronous candidate must not publish before assembly completes');
      const frame = await pending;
      assert.ok(frame.applied >= floor, 'the reader must reach its captured arrival floor');
      assert.equal(frame.records.pv, frame.pv, 'records and derived facts publish as one version');
      assert.deepEqual(meaning(observe(previous)), held, 'catch-up mutated the previously published frame');
      const served = JSON.parse(owner.index());
      assert.equal(served.sourcePv, frame.pv);
      assert.deepEqual(served.requiredPv, frame.requiredPv, 'the index must expose the same publication proofs');
      return { ...pair(frame), applied: frame.applied, floor };
    } },
    repair: { async verify() {
      await owner.read(log.latest);
      const held = owner.current!, aggregate = held.aggregate as AggregateSnapshot;
      const target = 'P1', node = (aggregate as unknown as { nodes: { get(id: string): object } }).nodes.get(target);
      Object.assign(node, { belowWorking: 5000, belowActive: 5000, moved: 9999999999999 });
      assert.equal(aggregate.workingBelow(target), 5000);
      const corrupted = meaning(observe(held));
      const start = ticks.length, limit = 2;
      // Both database and published cursors must have time to visit every Task, using bounded ticks.
      for (let i = 0; i < [...held.records.taskIds()].length * 2 + 4; i++) {
        const before = owner.current;
        await owner.audit(limit);
        assert.equal(owner.current, before, 'audit candidates cannot publish or repair a frame in place');
        await owner.catchUp();
      }
      assert.ok(ticks.length > start, 'the owner must actually run its bounded auditor');
      assert.ok(ticks.slice(start).every(tick => tick.tasks <= limit), 'audit exceeded its Task budget');
      assert.deepEqual(meaning(observe(held)), corrupted, 'repair changed the held damaged frame in place');
      assert.notEqual(owner.current, held, 'audit must request a catch-up publication');
      const result = pair();
      return { repaired: result.incremental, full: result.full };
    } },
    resync: { async verify() {
      await owner.read(log.latest);
      const previous = owner.current!, oldProofs = previous.requiredPv;
      const before = publications.length;
      // No yield: the projection cannot consume any batch before the small journal overflows.
      for (let i = 0; i <= log.capacity; i++) title(`Synthetic overflow ${i}`);
      const floor = log.latest;
      assert.equal(log.read('projection').kind, 'overflow', 'the lag must exceed the actual journal capacity');
      let release!: () => void;
      pause = new Promise<void>(resolve => { release = resolve; });
      const catchingUp = owner.catchUp(), reading = owner.read(floor);
      try {
        assert.equal(owner.current, previous, 'a blocked rebuild must leave the old frame published');
        title('Synthetic write while recovery awaits observations');
      } finally { pause = undefined; release(); await Promise.all([catchingUp, reading]); }
      const recovered = await owner.read(log.latest);
      assert.ok(publications.slice(before).some(item => item.full), 'overflow must use the real full recovery path');
      for (const kind of Object.keys(oldProofs) as (keyof typeof oldProofs)[]) for (const id of Object.keys(oldProofs[kind]))
        assert.ok(recovered.requiredPv[kind][id]! > oldProofs[kind][id]!, `recovery did not invalidate cached ${String(kind)}:${id}`);
      const result = pair(recovered);
      return { recovered: result.incremental, full: result.full, applied: recovered.applied, floor: log.latest };
    } },
    close: () => owner.close(),
  };
}
