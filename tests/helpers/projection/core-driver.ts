/** Real records, derivation, aggregates and read resources driven by isolated synthetic writes.
 * Change keys are authored replay inputs; writer touch completeness is checked by its separate guard. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ControlStore, holdControlWriter, type ChangeSeq } from '@alpacawork/db';
import type { ProjectionVersion, RequiredPvDTO } from '@alpacawork/contract/control';
import { affected, deriveTask } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { raiseRequiredPv, aggregateResources, timelineScopes, type AggregateResources } from '@alpacawork/backend/test-dist/receiver/index-rows.js';
import { emptyWorkspaceRecords, type DatabaseWorkspaceRecords, type WorkspaceObservations } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { createScreenAggregate, repairScreenAggregate, updateScreenAggregate, type AggregateSnapshot, type AggregateFacts } from '@alpacawork/backend/test-dist/receiver/screen-aggregate.js';
import type { AffectedSet, TaskDerived, RecordsReader, Facet, PublishedFrame } from '@alpacawork/backend/test-dist/receiver/projection-contract.js';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../../../scripts/dev-fixtures/fixture.ts';
import { trace, oldOwnerRecords, oldOwnerFrame, assertEquivalent, type HarnessDriver, type Observation, type DependencyProbe } from './harness.ts';
import { mutate, mutationState } from './mutations.ts';
import { ReadResources, recordsMeaning, tracedReads } from './resources.ts';
import { publicationDriver } from './publication-driver.ts';

export async function coreDriver() {
  const sandbox = mkdtempSync(join(tmpdir(), 'projection-replay-'));
  const original = createOriginal({ ...profiles.small, seed: 'projection-equivalence' }, join(sandbox, 'cache'));
  const root = copyWorkspace(original.root, join(sandbox, 'workspace')).root;
  const release = holdControlWriter(root), store = new ControlStore(root);
  let publication: Awaited<ReturnType<typeof publicationDriver>> | undefined;
  const close = async () => { try { await publication?.close(); } finally {
    store.close(); release(); removeWorkspace(root); removeWorkspace(original.root); rmSync(sandbox, { recursive: true, force: true }); } };
  try {
    const state = mutationState();
    let failFiles = false;
    const observations: WorkspaceObservations = {
      files: id => { if (failFiles) throw new Error('Synthetic records read failure'); return state.externalFiles.get(id) ?? []; },
      runFiles: run => ({ activity: null, errorCause: state.causes.get(run.id) }),
    };
    publication = await publicationDriver(root, store, observations, state);
    let pv = 0;
    const load = () => store.read(db => emptyWorkspaceRecords(root, observations).load(db, pv as ProjectionVersion));
    let reader: DatabaseWorkspaceRecords = load();
    let cache = new Map([...reader.taskIds()].map(id => [id, deriveTask(reader, id)]));
    const facts = (source: RecordsReader, derived: ReadonlyMap<string, TaskDerived>) => new Map([...source.taskIds()].map(id => [id, {
      scopes: source.scopes(id), menuRunning: derived.get(id)!.runs.some(run => run.state === 'running'),
    } satisfies AggregateFacts]));
    let aggregate = createScreenAggregate([...cache.values()].map(v => v.contribution), facts(reader, cache));
    let required: RequiredPvDTO = { view: {}, history: {}, page: {}, timeline: {}, search: {} };
    let changed: ReadonlyMap<string, ReadonlySet<Facet>> | undefined;
    const reads = new ReadResources(), executed = new Set<string>();
    const frame = (source: RecordsReader, values: ReadonlyMap<string, TaskDerived>, tree: AggregateSnapshot): PublishedFrame => ({
      generation: 'replay', pv: pv as ProjectionVersion, applied: pv as ChangeSeq, records: source,
      derived: id => values.get(id), aggregate: tree, requiredPv: required, patch: null,
    });
    const rowOf = (value: TaskDerived, tree: AggregateSnapshot, id: string) => ({ ...value.row, movedAt: tree.movedAt(id),
      usageBelow: tree.usageBelow(id), runsBelow: tree.runsBelow(id), childCounts: tree.childCounts(id), children: tree.children(id),
      workingBelow: tree.workingBelow(id), runningRuns: tree.runningRuns(id), live: tree.live(id) });
    function observation(source: RecordsReader, values: ReadonlyMap<string, TaskDerived>, tree: AggregateSnapshot, resources: ReadResources): Observation {
      const ids = [...source.taskIds()].sort(), pageNames = new Set(ids.flatMap(id => tree.pageScopes(id)));
      return { pv, value: {
        records: recordsMeaning(source), rows: Object.fromEntries(ids.map(id => [id, rowOf(values.get(id)!, tree, id)])),
        placements: Object.fromEntries(ids.map(id => [id, values.get(id)!.placements])), runs: Object.fromEntries(ids.map(id => [id, values.get(id)!.runs])),
        home: [...tree.homeIds()].map(id => ({ row: tree.home(id), after: tree.homeAfter(id) })), counts: tree.counts(),
        pages: Object.fromEntries([...pageNames].sort().map(scope => [scope, tree.page(scope)])),
        pushKeys: Object.fromEntries(ids.map(id => [id, values.get(id)!.pushKeys])),
      }, resources: resources.read(frame(source, values, tree), resources === reads ? changed : undefined) };
    }
    function full() {
      const source = load(), values = new Map([...source.taskIds()].map(id => [id, deriveTask(source, id)]));
      return observation(source, values, createScreenAggregate([...values.values()].map(v => v.contribution), facts(source, values)), new ReadResources());
    }
    const driver: HarnessDriver = {
      capabilities: ['database-replay', 'workspace-records', 'derive-affected', 'aggregate', 'required-view-pv', 'view-history', 'search-timeline-axis', 'bounded-audit'],
      publication: publication.publication,
      resync: publication.resync,
      observe: async () => ({ incremental: observation(reader, cache, aggregate, reads), full: full() }),
      async write(operation) {
        const before = reader, beforeCache = cache, beforeAggregate = aggregate;
        const oldRead = tracedReads(frame(before, beforeCache, beforeAggregate));
        if (operation.kind === 'read-failure') {
          const published = recordsMeaning(reader);
          failFiles = true;
          try { assert.throws(() => store.read(db => reader.advance(db, [{ kind: 'files', id: `T${operation.target}` }], (pv + 1) as ProjectionVersion)), /Synthetic records read failure/); }
          finally { failFiles = false; }
          assert.deepEqual(recordsMeaning(reader), published, 'a failed candidate mutated its published predecessor');
        }
        const { keys } = mutate(store, before, operation, state);
        publication!.changed(keys);
        executed.add(operation.kind); pv++;
        const change = store.read(db => reader.advance(db, keys, pv as ProjectionVersion));
        reader = change.next;
        const after = reader;
        const impact = affected(change), probes: DependencyProbe[] = [];
        const affectedByOwner = new Map([...change.owners].map(id => [id, affected({ ...change, owners: new Set([id]) })]));
        const nextCache = new Map(cache), contributions = new Map();
        for (const target of reader.taskIds()) {
          const traced = trace(reader, undefined, r => deriveTask(r, target));
          const old = before.bundle(target) ? deriveTask(before, target) : undefined, value = traced.value;
          for (const facet of ['row', 'view', 'push'] as Facet[]) probes.push({ target, facet, reads: traced.reads, beforeRecords: before, afterRecords: reader,
            before: !old ? undefined : facet === 'push' ? old.pushKeys : old.row,
            after: facet === 'push' ? value.pushKeys : value.row,
            withOldOwner: owner => { const old = deriveTask(oldOwnerRecords(before, after, owner), target); return facet === 'push' ? old.pushKeys : old.row; }, affected: impact, affectedByOwner, changedOwners: change.owners });
          const facets = impact.tasks.get(target);
          // A derived Task owns its placements, Runs and notification keys as well as its contribution.
          if (facets && [...facets].some(facet => ['row', 'membership', 'view', 'push', 'seat'].includes(facet))) {
            nextCache.set(target, value); contributions.set(target, { before: cache.get(target)?.contribution, after: value.contribution });
          }
        }
        cache = nextCache;
        const updated = updateScreenAggregate(aggregate, contributions, facts(reader, cache)); aggregate = updated.next;
        const aggregated = aggregateResources(updated.changed, id => reader.scopes(id), timelineScopes(id => reader.ancestors(id)));
        required = raiseRequiredPv(required, impact, pv as ProjectionVersion, aggregated).next;
        // A resource's version rises for what the records changed (affected) and for what the aggregates changed: a
        // read of an aggregate value is checked against both, as the version is raised from both.
        const raised = (set: AffectedSet) => withAggregate(set, aggregated);
        changed = impact.tasks;
        const previousFrame = frame(before, beforeCache, beforeAggregate), currentFrame = frame(reader, cache, aggregate);
        const currentRead = tracedReads(currentFrame);
        const raisedByOwner = new Map([...affectedByOwner].map(([id, set]) => [id, raised(set)]));
        for (const [key, value] of currentRead) probes.push({ ...value, before: oldRead.get(key)?.value, after: value.value,
          withOldOwner: owner => value.read(oldOwnerFrame(previousFrame, currentFrame, owner)),
          reads: [...oldRead.get(key)?.reads ?? [], ...value.reads], ...(value.scope
            ? { affected: raised(impact), affectedByOwner: raisedByOwner } : { affected: impact, affectedByOwner }), changedOwners: change.owners,
          beforeRecords: before, afterRecords: reader });
        const rowImpact = new Map([...impact.tasks].map(([id, facets]) => [id, new Set(facets)]));
        for (const id of updated.changed.tasks) { const facets = rowImpact.get(id) ?? new Set<Facet>(); facets.add('row'); rowImpact.set(id, facets); }
        for (const target of reader.taskIds()) {
          const traced = trace(reader, aggregate, (_, tree) => rowOf(cache.get(target)!, tree as AggregateSnapshot, target));
          probes.push({ target, facet: 'row', before: beforeCache.has(target) ? rowOf(beforeCache.get(target)!, beforeAggregate, target) : undefined,
            after: traced.value, reads: traced.reads, affected: { ...impact, tasks: rowImpact }, changedOwners: updated.changed.tasks,
            beforeRecords: before, afterRecords: reader });
        }
        return probes;
      },
      repair: { async verify() {
        const target = [...reader.taskIds()].find(id => aggregate.children(id))!;
        const node = (aggregate as unknown as { nodes: { get(id: string): object } }).nodes.get(target);
        Object.assign(node, { belowActive: 5000, belowWorking: 5000, moved: 9999999999999 });
        assert.equal(aggregate.workingBelow(target), 5000);
        aggregate = repairScreenAggregate(aggregate, [{ task: target, kind: 'aggregate' }]).next;
        const repaired = observation(reader, cache, aggregate, reads), rebuilt = full();
        assertEquivalent(repaired, rebuilt);
        return publication!.repair.verify();
      } },
    };
    return { driver, executed, root, close };
  } catch (error) { await close(); throw error; }
}

/** An affected set with the scopes an aggregate update changed added to its own. */
function withAggregate(set: AffectedSet, aggregated: AggregateResources): AffectedSet {
  return { ...set, scopes: { page: new Set([...set.scopes.page, ...aggregated.page]), search: new Set([...set.scopes.search, ...aggregated.search]),
    timeline: new Set([...set.scopes.timeline, ...aggregated.timeline ?? []]) } };
}
