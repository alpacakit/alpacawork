/** Owns catch-up, its fixed arrival floors, and the single atomic publication of records and derived facts. */
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { retryDelay } from './retry-delay.js';
import { structuralFallback } from './projection-fallback.js';
import { ControlStore, type ChangeKey, type ChangeLog, type ChangeSeq } from '@alpacawork/db';
import { faultReason, Problem, PROBLEM_CODE } from '@alpacawork/core';
import type { IndexPatchDTO, ProjectedIndexDTO, ProjectionVersion, RequiredPvDTO } from '@alpacawork/contract/control';
import type { TaskDerived, TaskBundle, PublishedFrame, RecordsReader, RoutingWorkSet, AffectedSet, Facet, AggregateContribution } from './projection-contract.js';
import { emptyWorkspaceRecords, type DatabaseWorkspaceRecords, type WorkspaceObservations } from './workspace-records.js';
import { RecordsMap } from './records-map.js';
import { affected, deriveTask, rescope } from './screen-derive.js';
import { aggregateFactsOf } from './workspace-aggregate-facts.js';
import { createScreenAggregate, updateScreenAggregate, repairScreenAggregate, type AggregateSnapshot, type AggregateFacts, type AggregateRepair } from './screen-aggregate.js';
import { aggregateResources, composeRow, IndexPatcher, liveRow, patchCandidates, raiseRequiredPv, type PatchSource } from './index-rows.js';
import { ProjectionAudit, type ProjectionRepairKind } from './projection-audit.js';
import { runRecordsAvailable } from './run-record-health.js';
import { restoreId } from '../release/journal.js';
import { coordinatorFileRunChanges } from './coordinator-file-runs.js';
import type { WatchedRunUpdate } from './workspace-file-thread.js';

export type ProjectionMeta = Required<IndexPatchDTO['meta']>;
export type PersonalProjection = Pick<ProjectionMeta, 'person' | 'presence' | 'host' | 'coordinatorWork'> & { errors?: ProjectionMeta['errors'] };
export interface ProjectionOptions {
  root: string; generation: string; log: ChangeLog; observations?: WorkspaceObservations;
  personal(): Promise<PersonalProjection>;
  locations(): Readonly<Record<string, string>>;
  published(frame: PublishedFrame, previous: PublishedFrame | undefined, work: RoutingWorkSet, full: boolean, fileRuns: WatchedRunUpdate): void;
  timing?(facts: Record<string, unknown>): void;
  fault?(error: unknown): void;
  run?(work: () => Promise<void>): Promise<void>;
  derive?: typeof deriveTask;
  accepting?(): boolean;
}
const emptyRequired = (): RequiredPvDTO => ({ view: {}, history: {}, page: {}, timeline: {}, search: {} });
const emptyPatch = (): IndexPatchDTO['requiredPv'] => ({ view: { upsert: {}, remove: [] }, history: { upsert: {}, remove: [] },
  page: { upsert: {}, remove: [] }, timeline: { upsert: {}, remove: [] }, search: { upsert: {}, remove: [] } });
type HeldFrame = PublishedFrame & { readonly records: DatabaseWorkspaceRecords; readonly aggregate: AggregateSnapshot;
  readonly values: RecordsMap<TaskDerived>; readonly structural: RecordsMap<AggregateContribution>; readonly good: RecordsMap<TaskBundle>; readonly meta: ProjectionMeta; readonly rev: number };
type TaskFailure = { readonly error: ProjectionMeta['errors'][number]; readonly failures: number; readonly at: number };
const failureErrors = (failures: ReadonlyMap<string, TaskFailure>) => [...failures].map(([id, failure]) => [id, failure.error]);
const retainedRuns = new WeakMap<TaskBundle['runs'], ReadonlyMap<string, TaskBundle['runs'][number]>>();

/** The ledger and presentation reuse the last successful Task facts when its fresh derivation is unavailable. */
function usableRecords(records: DatabaseWorkspaceRecords, bundles: () => RecordsMap<TaskBundle>, evaluate?: (task: string) => void): RecordsReader {
  const reader: RecordsReader = new Proxy(records, {
    get(target, property) {
      if (property === 'bundle') return (id: string) => { evaluate?.(id); return bundles().get(id) ?? target.bundle(id); };
      if (property === 'run') return (id: Parameters<RecordsReader['run']>[0]) => {
        const owner = target.runOwner(id);
        if (!owner) return target.run(id);
        evaluate?.(owner);
        const bundle = bundles().get(owner) ?? target.bundle(owner);
        if (bundle === target.bundle(owner)) return target.run(id);
        if (!bundle) return undefined;
        let runs = retainedRuns.get(bundle.runs);
        if (!runs) { runs = new Map(bundle.runs.map(run => [run.id, run])); retainedRuns.set(bundle.runs, runs); }
        return runs.get(id);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(reader) : value;
    },
  });
  return reader;
}

export class ProjectionOwner {
  private frame?: HeldFrame;
  private readonly readFrames = new WeakMap<HeldFrame, PublishedFrame>();
  private patcher = new IndexPatcher();
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;
  private running?: Promise<void>;
  private closed = false;
  private paused = false;
  private draining?: Promise<void>;
  private retryAt = 0;
  private failures = 0;
  private globalFailure?: ProjectionMeta['errors'][number];
  private taskFailures = new Map<string, TaskFailure>();
  private readonly reader: ControlStore;
  private readonly release: () => void;
  private readonly unsubscribe: () => void;
  private locations: Readonly<Record<string, string>> = {};
  private readonly repairs = new Map<string, Set<ProjectionRepairKind>>();
  private readonly repairKeys = new Map<string, ChangeKey>();
  private readonly auditor = new ProjectionAudit();
  private auditAbort?: AbortController;
  private auditing?: Promise<unknown>;
  constructor(private readonly options: ProjectionOptions) {
    this.reader = new ControlStore(options.root, { busyTimeoutMs: 0 }, true);
    this.release = options.log.register('projection', 0 as ChangeSeq);
    this.unsubscribe = options.log.subscribe(() => this.schedule());
  }
  get current(): PublishedFrame | undefined { return this.frame; }
  get rev(): number { return this.frame?.rev ?? 0; }
  get generation(): string { return this.options.generation; }
  private forRead(frame: HeldFrame): PublishedFrame {
    if (!this.taskFailures.size) return frame;
    let readable = this.readFrames.get(frame);
    if (!readable) {
      readable = { ...frame, records: usableRecords(frame.records, () => frame.good) };
      this.readFrames.set(frame, readable);
    }
    return readable;
  }
  async start(): Promise<void> { await this.catchUp(true); }
  private accepting(): boolean { return this.options.accepting?.() ?? true; }
  private schedule() {
    if (this.closed || this.paused || !this.accepting() || this.running) return;
    const now = Date.now();
    const changed = this.options.log.latest > (this.frame?.applied ?? -1) || this.repairs.size || this.repairKeys.size || this.globalFailure;
    const due = Math.max(now + 25, this.retryAt, changed ? now : Math.min(...[...this.taskFailures.values()].map(failure => failure.at)));
    if (!Number.isFinite(due) || this.timer && this.timerAt <= due) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.catchUp().catch(() => {});
    }, due - now);
  }
  /** A floor is captured by the HTTP adapter at arrival, before asynchronous authorization or folder observations. */
  async read(floor = this.options.log.latest, signal?: AbortSignal): Promise<PublishedFrame> {
    signal?.throwIfAborted();
    while (!this.frame || this.frame.applied < floor) {
      if (this.closed) throw new Error('Projection has closed');
      if (this.paused || !this.accepting()) {
        if (this.frame) return this.forRead(this.frame);
        throw new Error('Projection admission has stopped');
      }
      const work = this.catchUp().catch(error => { if (!this.frame) throw error; });
      if (!signal) await work;
      else {
        let cancel!: () => void;
        const abort = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); });
        try { await Promise.race([work, abort]); } finally { signal.removeEventListener('abort', cancel); }
      }
      // A retained publication never claims to have reached the arrival floor. Its
      // stale IDs and public error explain why the caller receives older facts.
      if (this.frame && (this.paused || this.retryAt > Date.now())) return this.forRead(this.frame);
    }
    return this.forRead(this.frame);
  }
  catchUp(full = false): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Projection has closed'));
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.running) return this.running;
    if (!full && this.retryAt > Date.now()) { this.schedule(); return Promise.resolve(); }
    if (this.paused || !this.accepting()) return Promise.resolve();
    const promise = Promise.resolve().then(() => {
      if (this.paused || !this.accepting()) return;
      return this.options.run ? this.options.run(() => this.build(full)) : this.build(full);
    })
      .then(() => {
        this.failures = 0; this.retryAt = 0;
      }, error => {
        this.backoff();
        this.publishFailure(error);
        throw error;
      }).finally(() => {
        this.running = undefined;
        if (!this.closed && (this.options.log.latest > (this.frame?.applied ?? -1) || this.repairs.size || this.repairKeys.size
          || this.taskFailures.size || this.globalFailure)) this.schedule();
      });
    this.running = promise;
    return promise;
  }
  private backoff(): void {
    this.retryAt = Date.now() + retryDelay(++this.failures);
  }
  private error(cause: unknown, task?: string): ProjectionMeta['errors'][number] {
    return { code: cause instanceof Problem ? cause.code : PROBLEM_CODE.unavailable,
      message: `${task ? `Task ${task} derivation` : 'Screen projection catch-up'} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      reason: cause instanceof Problem ? cause.reason ?? faultReason(cause) : faultReason(cause),
      path: task ? `tasks/${task}` : '.alpacawork/alpacawork.sqlite' };
  }
  private publishFailure(cause: unknown): void {
    const error = this.error(cause), before = this.frame;
    if (JSON.stringify(error) === JSON.stringify(this.globalFailure)) return;
    const previousError = this.globalFailure;
    this.globalFailure = error;
    this.options.fault?.(cause);
    if (!before) return;
    let next: HeldFrame = { ...before, rev: before.rev + 1,
      meta: { ...before.meta, staleIds: [...new Set([...before.meta.staleIds, ...before.values.keys()])],
        errors: [...before.meta.errors.filter(error => error !== previousError), error] } };
    const patch = this.patcher.patch(this.source(next, [], emptyPatch(), false));
    next = { ...next, patch, rev: patch ? next.rev : before.rev };
    this.frame = next;
    try { this.options.published(next, before, { after: before.applied, through: before.applied, tasks: new Set(), mode: 'changed' }, false,
      { upsert: [], remove: [] }); } catch (error) { this.options.fault?.(error); }
  }
  private async build(force: boolean): Promise<void> {
    const started = performance.now(), before = this.frame;
    let personal: PersonalProjection, boundary: ChangeSeq;
    do { boundary = this.options.log.latest; personal = await this.options.personal(); }
    while (!this.closed && boundary !== this.options.log.latest);
    if (this.closed) return;
    // No yield between capturing R and establishing SQLite's first read in load/advance.
    const range = this.options.log.read('projection'), full = force || !before || range.kind === 'overflow';
    const through = range.through;
    const keys = range.kind === 'changes' ? [...new Map(range.batches.flatMap(batch => batch.keys).map(key => [JSON.stringify(key), key])).values()] : [];
    const repairing = new Map(this.repairs);
    const retrying = new Set([...this.taskFailures].filter(([, failure]) => failure.at <= Date.now()).map(([id]) => id));
    if (!full && through === before!.applied && !repairing.size && !this.repairKeys.size && !retrying.size && !this.globalFailure) return;
    const pv = ((before?.pv ?? 0) + 1) as ProjectionVersion;
    const reloadKeys = new Map(this.repairKeys);
    const changeKeys = [...keys, ...reloadKeys.values()];
    const reloadTasks = [...repairing].filter(([, kinds]) => kinds.has('records')).map(([id]) => id);
    const change = full ? undefined : reloadTasks.length || reloadKeys.size
      ? before!.records.reloadBundles(this.reader.connection, reloadTasks, pv, changeKeys)
      : before!.records.advance(this.reader.connection, changeKeys, pv);
    const records = full ? emptyWorkspaceRecords(this.options.root, this.options.observations).load(this.reader.connection, pv) : change!.next;
    if (full || keys.some(key => key.kind === 'config')) this.locations = this.options.locations();
    const taskFailures = new Map(this.taskFailures), failed = new Set<string>();
    const derived = new Map<string, TaskDerived | undefined>();
    let good = before?.good ?? new RecordsMap<TaskBundle>();
    let structural = full ? new RecordsMap<AggregateContribution>() : before!.structural;
    // Changes to the failed Task itself retry immediately; unrelated batches keep its existing retry deadline.
    const changedOwners = new Set(full ? records.taskIds() : change!.owners);
    // The dependency comparison and assembly use one evaluation and one failure policy per Task. A failure discovered
    // while computing affected resources must not turn independent healthy Tasks into a global acquisition failure.
    const derive = (id: string): TaskDerived | undefined => {
      if (derived.has(id)) return derived.get(id);
      let value: TaskDerived | undefined;
      const waiting = taskFailures.get(id);
      if (waiting && waiting.at > Date.now() && !changedOwners.has(id) && !repairing.has(id)) {
        failed.add(id); value = before?.derived(id); derived.set(id, value); return value;
      }
      try {
        value = records.bundle(id) ? (this.options.derive ?? deriveTask)(records, id) : undefined;
        good = value ? good.set(id, records.bundle(id)!) : good.delete(id);
        taskFailures.delete(id);
      } catch (cause) {
        const error = this.error(cause, id);
        if (JSON.stringify(error) !== JSON.stringify(taskFailures.get(id)?.error)) this.options.fault?.(cause);
        const failures = (taskFailures.get(id)?.failures ?? 0) + 1;
        taskFailures.set(id, { error, failures, at: Date.now() + retryDelay(failures) });
        failed.add(id);
        value = before?.derived(id);
      }
      derived.set(id, value);
      return value;
    };
    const evaluateTasks = new Set([...(full ? records.taskIds() : change!.owners), ...repairing.keys(), ...retrying]);
    // Related bundles outside the changed owners retain their existing successful facts. Merely looking up a parent
    // or a history reference must not recursively derive the reference graph; only affected Tasks join this set.
    const readable = usableRecords(records, () => good, id => { if (evaluateTasks.has(id)) derive(id); });
    const previous = before && usableRecords(before.records, () => before.good);
    const rows = { before: (id: string) => before?.derived(id), after: derive };
    let effects: AffectedSet = full ? { tasks: new Map([...records.taskIds()].map(id => [id, new Set<Facet>(['row','view','history','files','membership','page','search','timeline','seat','push'])])),
      scopes: { page: new Set(), search: new Set(['root', ...records.shelf().listed]), timeline: new Set(records.taskIds()) }, meta: true }
      : affected({ ...change!, before: previous!, after: readable }, rows);
    // The Tasks this publication gives facets of its own; their scopes follow from the same rule (rescope).
    const forced = new Set<string>();
    if (before && runRecordsAvailable(before.records) !== runRecordsAvailable(records))
      for (const id of records.taskIds()) { forced.add(id); (effects.tasks as Map<string, ReadonlySet<Facet>>).set(id,
        new Set<Facet>([...(effects.tasks.get(id) ?? []), 'row','view','history','membership','page','search','timeline','push'])); }
    for (const [id] of repairing) { forced.add(id); (effects.tasks as Map<string, ReadonlySet<Facet>>).set(id, new Set(['row','view','history','files','membership','page','search','timeline','seat','push'])); }
    for (const id of new Set([...retrying, ...failed])) {
      forced.add(id); (effects.tasks as Map<string, ReadonlySet<Facet>>).set(id, new Set(['row','view','history','files','membership','page','search','timeline','seat','push']));
    }
    for (const id of effects.tasks.keys()) evaluateTasks.add(id);
    let values = full ? new RecordsMap<TaskDerived>() : before!.values;
    const changes = new Map<string, { before: TaskDerived['contribution'] | undefined; after: TaskDerived['contribution'] | undefined }>();
    const facts = new Map<string, AggregateFacts>();
    let slice = performance.now();
    for (const id of effects.tasks.keys()) {
      const old = before?.derived(id);
      let value = derive(id);
      if (failed.has(id)) {
        forced.add(id); (effects.tasks as Map<string, ReadonlySet<Facet>>).set(id, new Set(['row','view','history','files','membership','page','search','timeline','seat','push']));
        // Failed derivation retains only that Task's last contribution. Facts
        // successfully acquired for the other Tasks still publish together. Its facts follow the records as a full
        // build reads them, so a project taken off the list takes its row out of the home order even then.
        if (old) {
          values = values.set(id, old);
          facts.set(id, aggregateFactsOf(readable, id));
        } else {
          const fallback = structuralFallback(readable, id);
          if (fallback) {
            if (!isDeepStrictEqual(before?.structural.get(id), fallback.contribution))
              changes.set(id, { before: before?.structural.get(id), after: fallback.contribution });
            structural = structural.set(id, fallback.contribution);
            facts.set(id, fallback.facts);
          }
        }
        continue;
      }
      if (value && old && !runRecordsAvailable(records)) value = { ...value, ball: old.ball,
        row: { ...value.row, ball: old.ball, notice: { ...value.row.notice, turnKey: old.row.notice.turnKey } },
        contribution: { ...value.contribution, ball: old.ball, homeWorking: old.contribution.homeWorking }, pushKeys: old.pushKeys };
      structural = structural.delete(id);
      values = value ? values.set(id, value) : values.delete(id);
      changes.set(id, { before: old?.contribution ?? before?.structural.get(id), after: value?.contribution });
      if (value) facts.set(id, aggregateFactsOf(readable, id));
      if (performance.now() - slice >= 4) { await yieldTurn(); slice = performance.now(); }
    }
    if (!full && through === before!.applied && !repairing.size && !reloadKeys.size && !this.globalFailure
      && JSON.stringify(failureErrors(taskFailures)) === JSON.stringify(failureErrors(this.taskFailures)) && !changes.size) {
      this.taskFailures = taskFailures;
      return;
    }
    let aggregate: AggregateSnapshot, changed: ReturnType<typeof updateScreenAggregate>['changed'];
    if (full) {
      aggregate = createScreenAggregate([...values.values()].map(value => value.contribution).concat([...structural.values()]), facts);
      changed = { tasks: new Set(records.taskIds()), pages: new Set([...records.taskIds()].flatMap(id => [...aggregate.pageScopes(id)])), counts: true };
    } else {
      const repair: AggregateRepair[] = [...repairing].flatMap(([task, kinds]) => [...kinds].filter((kind): kind is AggregateRepair['kind'] => kind === 'aggregate' || kind === 'membership' || kind === 'order').map(kind => ({ task, kind })));
      const result = repair.length ? repairScreenAggregate(before!.aggregate, repair, changes, facts) : updateScreenAggregate(before!.aggregate, changes, facts);
      aggregate = result.next; changed = result.changed;
    }
    const resources = aggregateResources(changed, id => [...new Set([...(previous?.bundle(id) ? previous.scopes(id) : []), ...(readable.bundle(id) ? readable.scopes(id) : [])])]);
    if (!full && forced.size) effects = rescope(effects, forced, previous!, readable, rows);
    const required = raiseRequiredPv(full ? emptyRequired() : before!.requiredPv, effects, pv, resources);
    if (full && before) for (const kind of Object.keys(required.next) as (keyof RequiredPvDTO)[])
      for (const id of Object.keys(before.requiredPv[kind])) { required.next[kind][id] = pv; required.patch[kind].upsert[id] = pv; }
    const environment = records.environment();
    const projects = [...records.shelf().projects].filter(project => records.shelf().listed.has(project.id))
      .sort((a, b) => {
        const left = [a.id, ...readable.ancestors(a.id)].reverse(), right = [b.id, ...readable.ancestors(b.id)].reverse();
        for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return Number(left[i]!.slice(1)) - Number(right[i]!.slice(1));
        return left.length - right.length;
      }).flatMap(project => {
        const usable = readable.bundle(project.id)?.task;
        return usable ? [{ id: project.id, title: usable.meta.title, parentId: usable.meta.parentId,
          depth: readable.ancestors(project.id).length, color: usable.settings!.color, cwd: this.locations[project.id] || null, counts: aggregate.menu(project.id) }] : [];
      });
    const meta: ProjectionMeta = { ...environment, projects, projectShelfVersion: records.shelf().revision, staleIds: [...taskFailures.keys()],
      person: personal.person, presence: personal.presence, host: personal.host, coordinatorWork: personal.coordinatorWork,
      errors: [...environment.errors, ...personal.errors ?? [], ...[...taskFailures.values()].map(failure => failure.error)] };
    let next: HeldFrame = { generation: this.options.generation, pv, applied: through, records, values, structural, good, aggregate,
      derived: id => values.get(id), requiredPv: required.next, patch: null, meta, rev: (before?.rev ?? 0) + 1 };
    // The patcher mutates only after every asynchronous assembly stage succeeded, immediately before publication.
    const source = this.source(next, patchCandidates(effects, changed), required.patch, changed.counts || full);
    if (full) this.patcher = new IndexPatcher();
    const patch = this.patcher.patch(source);
    next = { ...next, patch: full ? null : patch, rev: patch || full ? next.rev : before!.rev };
    this.frame = next;
    this.globalFailure = undefined;
    this.taskFailures = taskFailures;
    for (const [id, kinds] of repairing) if (this.repairs.get(id) === kinds) this.repairs.delete(id);
    this.options.log.acknowledge('projection', through);
    const work: RoutingWorkSet = { after: before?.applied ?? 0 as ChangeSeq, through,
      tasks: new Set([...effects.tasks].filter(([id, facets]) => facets.has('seat') && !taskFailures.has(id)).map(([id]) => id)), mode: 'changed' };
    for (const [key, value] of reloadKeys) if (this.repairKeys.get(key) === value) this.repairKeys.delete(key);
    const fileRuns = coordinatorFileRunChanges(before?.records, records, change?.keys ?? keys, full);
    try { this.options.published(next, before, work, full, fileRuns); } catch (error) { this.options.fault?.(error); }
    this.options.timing?.({ step: 'catchUp', through, pv, full, keys: keys.length, tasks: effects.tasks.size,
      catchUpMs: performance.now() - started, requiredResources: Object.values(required.patch).reduce((n, part) => n + Object.keys(part.upsert).length, 0) });
  }
  /** An audit candidate is never published: repairs reread the latest database at the next catch-up. */
  async audit(limit = 16): Promise<void> {
    const frame = this.frame;
    if (this.closed || this.paused || this.running || this.auditing || this.taskFailures.size || this.globalFailure || !frame || !runRecordsAvailable(frame.records) || frame.applied !== this.options.log.latest) return;
    const abort = new AbortController(); this.auditAbort = abort;
    const auditing = this.auditor.tickAsync(this.options.root, frame, () => this.options.log.latest,
      { limit, timing: this.options.timing, signal: abort.signal });
    this.auditing = auditing;
    let result;
    try { result = await auditing; }
    finally { this.auditing = undefined; this.auditAbort = undefined; }
    if (result.skipped || this.closed || this.paused || this.running || frame !== this.frame || frame.applied !== this.options.log.latest) return;
    for (const { task, kinds } of result.repairs) this.repairs.set(task, new Set([...this.repairs.get(task) ?? [], ...kinds]));
    for (const key of result.reloadKeys) this.repairKeys.set(JSON.stringify(key), key);
    if (this.repairs.size || this.repairKeys.size) this.schedule();
  }
  get auditInterval(): number { return Math.max(500, 300_000 * 16 / Math.max(1, this.frame?.values.size ?? 1)); }
  private source(frame: HeldFrame, candidates: Iterable<string>, requiredPv: IndexPatchDTO['requiredPv'], counts: boolean): PatchSource {
    const visible = (id: string) => frame.aggregate.live(id) && frame.good.has(id)
      && frame.records.shelf().listed.has(frame.derived(id)!.row.projectId);
    const row = (id: string) => { const value = frame.derived(id); return value && visible(id) ? liveRow(composeRow(value, frame.aggregate)) : undefined; };
    return { rev: frame.rev, generation: frame.generation, pv: frame.pv, candidates, requiredPv, meta: frame.meta,
      row, placements: id => { const value = frame.derived(id); return value && visible(id) ? value.placements.filter(p => value.live.placements.has(p.id)) : []; },
      runs: id => { const value = frame.derived(id); return value && visible(id) ? value.runs.filter(run => value.live.runs.has(run.id)) : []; },
      home: id => { const value = frame.aggregate.home(id), after = frame.aggregate.homeAfter(id); return value && value.section !== 'done' && after !== undefined && visible(id) ? { row: value, after } : undefined; },
      children: id => frame.aggregate.children(id), counts: counts ? frame.aggregate.counts() : null };
  }
  index(): string {
    const frame = this.frame;
    if (!frame) throw new Error('Projection has not started');
    const source = this.source(frame, frame.records.taskIds(), emptyPatch(), true);
    const ids = [...frame.records.taskIds()];
    const value: ProjectedIndexDTO = { restoreId: restoreId(this.options.root), generation: frame.generation, sourcePv: frame.pv, rev: frame.rev,
      ...frame.meta, requiredPv: frame.requiredPv, tasks: ids.flatMap(id => source.row(id) ?? []),
      placements: ids.flatMap(id => [...source.placements(id)]), runs: ids.flatMap(id => [...source.runs(id)]),
      home: [...frame.aggregate.homeIds()].flatMap(id => source.home(id)?.row ?? []),
      counts: { ...frame.aggregate.counts(), children: Object.fromEntries(ids.flatMap(id => { const count = frame.aggregate.children(id); return count ? [[id, count]] : []; })) } };
    return JSON.stringify(value);
  }
  /** Stop reservations while already admitted writes and the current assembly finish. */
  pause(): void { this.paused = true; this.auditAbort?.abort(); this.unsubscribe(); if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
  /** Apply the last committed range once, outside admission, then stop all reservations. */
  drain(): Promise<void> {
    return this.draining ??= (async () => {
      this.pause();
      try {
        await this.running?.catch(() => {});
        if (!this.closed) try { await this.build(false); } catch (error) { this.publishFailure(error); }
      } finally { this.stop(); }
    })();
  }
  stop(): void { this.closed = true; this.pause(); }
  async close(): Promise<void> {
    this.stop();
    try { await this.draining; await this.running; await this.auditing; } finally { this.release(); this.reader.close(); }
  }
}
