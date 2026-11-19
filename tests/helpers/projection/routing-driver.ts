/** Two persistent synthetic worlds receive the same operations. One routes only affected seats; the other sweeps.
 * No manager or provider is started. Enabled synthetic profiles admit queued Requests only. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ControlStore, holdControlWriter, keepControlChanges, type ChangeSeq } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { seatFactsOf } from '@alpacawork/backend/test-dist/control/wake.js';
import { affected, recordsSource } from '@alpacawork/backend/test-dist/receiver/screen-derive.js';
import { emptyWorkspaceRecords } from '@alpacawork/backend/test-dist/receiver/workspace-records.js';
import { createOriginal, copyWorkspace, removeWorkspace, profiles } from '../../../scripts/dev-fixtures/fixture.ts';
import { mutate, mutationState } from './mutations.ts';
import { meaning, trace, oldOwnerRecords, type HarnessDriver, type Operation } from './harness.ts';

export async function routingDriver() {
  const area = mkdtempSync(join(tmpdir(), 'projection-routing-'));
  const original = createOriginal({ ...profiles.small, seed: 'projection-equivalence' }, join(area, 'cache'));
  const cleanups: (() => void)[] = [];
  const close = () => { for (const cleanup of cleanups.reverse()) cleanup(); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); };
  try {
    function world(name: string) {
      const root = copyWorkspace(original.root, join(area, name)).root;
      const config = parse(readFileSync(join(root, 'config.yaml'), 'utf8'));
      config.agents.fixture.enabled = true;
      config.agents.fixture.params = Object.fromEntries(Object.keys(config.agents.fixture.params).map(key => [key, []]));
      writeFileSync(join(root, 'config.yaml'), stringify(config));
      const release = holdControlWriter(root), store = new ControlStore(root), journal = keepControlChanges(root);
      journal.log.register('replay');
      cleanups.push(() => { journal.close(); store.close(); release(); removeWorkspace(root); });
      const state = mutationState();
      const load = () => store.read(db => emptyWorkspaceRecords(root, { files: id => state.externalFiles.get(id) ?? [],
        runFiles: run => ({ activity: null, errorCause: state.causes.get(run.id) }) }).load(db, journal.log.latest as unknown as ProjectionVersion));
      let reader = load();
      const router = new ReturnRouter(root, miss => { misses.push(miss.writes); });
      const misses: number[] = [];
      const all = () => new Set([...reader.taskIds()].filter(id => reader.bundle(id)!.task.meta.kind === 'task'));
      function pending() {
        const read = journal.log.read('replay'); assert.equal(read.kind, 'changes');
        if (read.kind !== 'changes') throw new Error('Unexpected routing replay overflow');
        journal.log.acknowledge('replay', read.through);
        return read.batches.flatMap(batch => batch.keys);
      }
      async function route(tasks: ReadonlySet<string>, sweep = false) {
        const result = await router.route({ tasks, after: 0 as ChangeSeq, through: journal.log.latest, mode: sweep ? 'sweep' : 'changed' });
        assert.equal(result.completed, true, 'a synthetic route was deferred');
        const keys = pending();
        const before = reader, change = store.read(db => reader.advance(db, keys, (reader.pv + 1) as ProjectionVersion)); reader = change.next;
        return { keys, impact: affected(change), before };
      }
      async function settle(tasks: ReadonlySet<string>, full: boolean) {
        for (let pass = 0; pass < 32; pass++) {
          const change = await route(full ? all() : tasks);
          if (!change.keys.length) return;
          tasks = new Set([...change.impact.tasks].filter(([, facets]) => facets.has('seat')).map(([id]) => id));
        }
        throw new Error('Routing replay did not settle within 32 passes');
      }
      async function write(operation: Operation) {
        const before = reader, old = new Map([...before.taskIds()].filter(id => before.bundle(id)!.task.meta.kind === 'task')
          .map(id => [id, trace(before, undefined, records => seatFactsOf(recordsSource(records), id))]));
        const { keys } = mutate(store, before, operation, state);
        pending(); // These authored SQL writes supply their explicit keys, rather than claiming touch coverage.
        const change = store.read(db => reader.advance(db, keys, (reader.pv + 1) as ProjectionVersion)); reader = change.next;
        const impact = affected(change), after = reader;
        const affectedByOwner = new Map([...change.owners].map(id => [id, affected({ ...change, owners: new Set([id]) })]));
        const probes = [...reader.taskIds()].filter(id => reader.bundle(id)!.task.meta.kind === 'task').map(target => {
          const current = trace(reader, undefined, records => seatFactsOf(recordsSource(records), target));
          return { target, facet: 'seat' as const, before: old.get(target)?.value, after: current.value,
            withOldOwner: owner => seatFactsOf(recordsSource(oldOwnerRecords(before, after, owner)), target),
            reads: [...old.get(target)?.reads ?? [], ...current.reads], affected: impact, affectedByOwner, changedOwners: change.owners, beforeRecords: before, afterRecords: reader };
        });
        return { seats: new Set([...impact.tasks].filter(([, facets]) => facets.has('seat')).map(([id]) => id)), probes };
      }
      function business() {
        const runs = new RunStore(root, { busyTimeoutMs: 1000 }, true);
        try {
          const snapshot = runs.snapshot(); if (snapshot.runError) throw snapshot.runError;
          const ids = new Map<string, string>();
          const orderedRequests = [...snapshot.requests].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
          const counters = new Map<string, number>();
          for (const request of orderedRequests) {
            const group = `${request.taskId ?? 'coordinator'}:${request.purpose}`;
            const index = counters.get(group) ?? 0; counters.set(group, index + 1);
            ids.set(request.id, request.id.startsWith('RETREQ') ? `request:${group}:${index}` : request.id);
          }
          for (const bundle of [...reader.taskIds()].map(id => reader.bundle(id)!)) bundle.task.meta.log.forEach((log, ordinal) => ids.set(log.id, `log:${bundle.task.id}:${ordinal}`));
          for (const row of snapshot.returns) ids.set(row.id, `return:${ids.get(row.requestId ?? '') ?? row.requestId}:${row.toTaskId}:${row.outcome}:${ids.get(row.causeLogId ?? '') ?? row.causeLogId}`);
          const names = [...ids].sort(([a], [b]) => b.length - a.length);
          const text = (value: string) => names.reduce((value, [id, name]) => value.replaceAll(id, name), value)
            .replaceAll(root, '<workspace>').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<clock>');
          const sorted = (rows: unknown[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
          return meaning({
            tasks: [...reader.taskIds()].map(id => { const task = reader.bundle(id)!.task;
              return { id, state: task.meta.state, baseState: task.meta.baseState, hold: task.meta.hold,
                log: task.meta.log.map(log => ({ kind: log.kind, from: log.fromState, to: log.toState, title: text(log.title ?? '') })) }; }),
            runs: sorted(snapshot.records!.map(run => ({ id: run.id, task: run.task, state: run.state, into: run.into,
              request: ids.get(run.requestId), caller: run.caller, resumes: run.resumes, role: run.role }))),
            requests: sorted(snapshot.requests.map(request => ({ id: ids.get(request.id), task: request.taskId, purpose: request.purpose,
              delivery: request.deliveryState, run: request.runId, body: text(request.body) }))),
            returns: sorted(snapshot.returns.map(row => ({ id: ids.get(row.id), to: row.toTaskId, request: ids.get(row.requestId ?? ''),
              outcome: row.outcome, hold: row.holdReason, resolution: row.resolution?.reason ?? null,
              deliveries: row.deliveries.map(delivery => ({ wake: ids.get(delivery.wakeRequestId), received: !!delivery.receivedAt,
                consumed: !!delivery.consumedAt, released: delivery.releaseReason })) }))),
            cycles: sorted(snapshot.waitCycles.map(cycle => ({ task: cycle.taskId, closed: !!cycle.closedAt,
              requests: snapshot.requests.filter(request => request.waitCycleId === cycle.id).map(request => ids.get(request.id)).sort() }))),
          });
        } finally { runs.close(); }
      }
      return { all, settle, route, write, business, misses };
    }
    const narrow = world('targeted'), full = world('full');
    // Initial fixture work is startup work, not a change-set omission.
    await narrow.settle(narrow.all(), true); await full.settle(full.all(), true);
    assert.deepEqual(narrow.business(), full.business());
    const adapter: NonNullable<HarnessDriver['routing']> = { async verify(operation) {
      const current = await narrow.write(operation); await full.write(operation);

      await narrow.settle(current.seats, false); await full.settle(full.all(), true);
      // Capture business BEFORE the residual sweep, so a sweep cannot conceal missing work.
      const targeted = narrow.business(), reference = full.business(), start = narrow.misses.length;
      const residual = await narrow.route(narrow.all(), true);
      const business = reference as { requests: { id: string; purpose: string }[]; runs: { state: string }[];
        returns: { resolution: unknown; deliveries: { received: boolean; consumed: boolean }[] }[]; cycles: { closed: boolean }[] };
      const coverage = { automaticRequests: business.requests.filter(row => row.purpose === 'return_continuation' && row.id.startsWith('request:')).length, continuations: business.requests.filter(row => row.purpose === 'return_continuation').length,
        queuedRuns: business.runs.filter(row => row.state === 'queued').length,
        resolvedReturns: business.returns.filter(row => row.resolution !== null).length,
        deliveries: business.returns.reduce((count, row) => count + row.deliveries.length, 0),
        received: business.returns.flatMap(row => row.deliveries).filter(row => row.received).length,
        consumed: business.returns.flatMap(row => row.deliveries).filter(row => row.consumed).length,
        closedWaits: business.cycles.filter(row => row.closed).length };
      return { coverage, dependencyProbes: current.probes, residualWrites: residual.keys.length + narrow.misses.slice(start).reduce((sum, value) => sum + value, 0), targeted, full: reference };
    } };
    return { adapter, close };
  } catch (error) { close(); throw error; }
}
