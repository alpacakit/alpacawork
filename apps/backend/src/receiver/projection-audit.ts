/** A bounded audit between catch-ups. Its read candidate is evidence; only a later catch-up may publish a repair. */
import { isDeepStrictEqual as same } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { openControlDatabase, type ChangeKey, type ChangeSeq } from '@alpacawork/db';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { finishRecords, type RecordWork } from './record-work.js';
import type { PublishedFrame, RecordsReader, TaskDerived } from './projection-contract.js';
import { DatabaseWorkspaceRecords } from './workspace-records.js';
import { auditCandidate } from './projection-audit-reader.js';
import { readPoint } from './workspace-records-sql.js';
import { deriveTask } from './screen-derive.js';
import { repairScreenAggregate, type AggregateSnapshot } from './screen-aggregate.js';
import { aggregateFactsOf } from './workspace-aggregate-facts.js';

export type ProjectionRepairKind = 'records' | 'derived' | 'aggregate' | 'membership' | 'order';
export interface ProjectionRepair { readonly task: string; readonly kinds: ReadonlySet<ProjectionRepairKind> }
export interface ProjectionAuditResult {
  readonly skipped: boolean;
  readonly tasks: readonly string[];
  readonly repairs: readonly ProjectionRepair[];
  /** Re-discover and reload these bundles at the latest catch-up read point, never reuse the audit candidate. */
  readonly reloadTasks: readonly string[];
  readonly reloadKeys: readonly ChangeKey[];
}
export interface ProjectionAuditOptions {
  /** The caller chooses its tick interval and limit so a complete sweep takes about ten minutes. */
  readonly limit?: number;
  readonly timing?: (facts: Record<string, unknown>) => void;
}
export interface AsyncProjectionAuditOptions extends ProjectionAuditOptions {
  /** Yield after this much work, at the next record assembly checkpoint. */
  readonly sliceMs?: number;
  readonly signal?: AbortSignal;
}
const skipped = (): ProjectionAuditResult => ({ skipped: true, tasks: [], repairs: [], reloadTasks: [], reloadKeys: [] });
const canonical = (keys: readonly ChangeKey[]) => [...new Map(keys.map(key => [JSON.stringify(key), key])).values()];

function* relationSteps(records: RecordsReader, id: string): RecordWork<unknown> {
  const bundle = records.bundle(id);
  if (!bundle) return undefined;
  const collect = function* <T>(items: readonly T[], read: (item: T) => unknown): RecordWork<unknown[]> {
    const values: unknown[] = [];
    for (const item of items) { values.push(read(item)); yield; }
    return values;
  };
  const links = { parent: records.parent(id), project: records.projectOf(id), scopes: records.scopes(id), children: records.children(id),
    dependents: records.dependents(id), senders: records.sendersTo(id), targets: records.targetsFromAll(id),
    causes: records.returnsByCauseTask(id), questions: records.questionsByDestination(id), history: records.historyReferrers(id),
    schema: bundle.task.meta.kind === 'project' ? records.schemaOf(id) : undefined, schemaUsers: records.schemaUsers(id) };
  yield;
  const logs = yield* collect(bundle.task.meta.log, log => [log.id, records.logOwner(log.id)]);
  const placements = yield* collect(bundle.placements, item => [item.id, records.placementOwner(item.id), records.placementWritesTo(item.id)]);
  const runs = yield* collect(bundle.runs, item => [item.id, records.runOwner(item.id), records.runReferrers(item.id), records.joinedMessages(item.id),
    (records as DatabaseWorkspaceRecords).inputsByInstruction(item.id)]);
  const requests = yield* collect(bundle.requests, item => [item.id, records.requestOwner(item.id), records.runByRequest(item.id),
    records.closedRequest(item.id), records.deliveriesByWakeRequest(item.id)]);
  const returns = yield* collect(bundle.returns, item => [item.id, records.returnOwner(item.id)]);
  const messages = yield* collect(bundle.dialogues, item => [item.messageId, records.dialogueTasks(item.messageId), records.messageTasks(item.messageId), records.coordinatorRun(item.messageId)]);
  return { ...links, logs, placements, runs, requests, returns, messages };
}
function totals(aggregate: AggregateSnapshot, id: string): unknown {
  return { children: aggregate.children(id), usage: aggregate.usageBelow(id), runs: aggregate.runsBelow(id),
    running: aggregate.runningRuns(id), working: aggregate.workingBelow(id), moved: aggregate.movedAt(id) };
}

export class ProjectionAudit {
  private taskCursor = '';
  private fieldCursor = '';
  private conversationCursor = '';
  private taskIds?: Iterator<string>;
  private fieldIds?: Iterator<string>;
  private conversationIds?: Iterator<string>;
  private alternate = false;
  private takePublished(kind: 'task' | 'field' | 'conversation', records: DatabaseWorkspaceRecords, count: number): string[] {
    const take = (values: Iterable<string>) => values[Symbol.iterator]();
    const name = `${kind}Ids` as const;
    this[name] ??= take(kind === 'task' ? records.taskIds() : kind === 'field' ? records.catalog().keys() : records.conversationIds());
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const next = this[name]!.next();
      if (next.done) { this[name] = undefined; break; }
      ids.push(next.value);
    }
    return ids;
  }
  private active = false;
  /** The synchronous entry point drains exactly the same checkpoints as the asynchronous audit. */
  tick(db: DatabaseSync, frame: PublishedFrame, latest: () => ChangeSeq, options: ProjectionAuditOptions = {}): ProjectionAuditResult {
    if (this.active || frame.applied !== latest()) return skipped();
    const started = performance.now();
    const result = readPoint(db, () => finishRecords(this.steps(db, frame, options)));
    return this.complete(frame, latest, result, started, options);
  }
  /** A dedicated connection keeps one coherent read snapshot without holding the writer's connection across yields. */
  async tickAsync(root: string, frame: PublishedFrame, latest: () => ChangeSeq,
    options: AsyncProjectionAuditOptions = {}): Promise<ProjectionAuditResult> {
    if (this.active || options.signal?.aborted || frame.applied !== latest()) return skipped();
    this.active = true;
    const started = performance.now(), budget = Math.max(0, options.sliceMs ?? 4);
    let db: DatabaseSync | undefined, work: RecordWork<ProjectionAuditResult> | undefined;
    let yields = 0, maxSliceMs = 0, sliceStarted = started;
    try {
      db = openControlDatabase(root, { busyTimeoutMs: 0 }, true);
      db.exec('BEGIN');
      work = this.steps(db, frame, options);
      while (true) {
        if (options.signal?.aborted || frame.applied !== latest()) return skipped();
        const step = work.next();
        const elapsed = performance.now() - sliceStarted;
        maxSliceMs = Math.max(maxSliceMs, elapsed);
        if (step.done) {
          db.exec('COMMIT');
          return this.complete(frame, latest, step.value, started, options, { yields, maxSliceMs });
        }
        if (elapsed >= budget) {
          yields++;
          await nextTurn();
          sliceStarted = performance.now();
        }
      }
    } finally {
      try { work?.return(undefined as never); }
      finally {
        try { if (db?.isTransaction) db.exec('ROLLBACK'); }
        finally { db?.close(); this.active = false; }
      }
    }
  }
  private *steps(db: DatabaseSync, frame: PublishedFrame, options: ProjectionAuditOptions): RecordWork<ProjectionAuditResult> {
    if (!(frame.records instanceof DatabaseWorkspaceRecords)) throw new Error('Projection audit requires database-backed records');
    const original = frame.records, aggregate = frame.aggregate as AggregateSnapshot;
    const limit = Math.max(1, Math.floor(options.limit ?? 10));
    this.alternate = !this.alternate;
    const dbLimit = limit === 1 ? Number(this.alternate) : Math.ceil(limit / 2), oldLimit = limit - dbLimit;
    const rows = db.prepare('SELECT external_id FROM tasks WHERE external_id>? ORDER BY external_id LIMIT ?').all(this.taskCursor, dbLimit);
    if (dbLimit) this.taskCursor = rows.length ? String(rows.at(-1)!.external_id) : '';
    const tasks = [...new Set([...rows.map(row => String(row.external_id)), ...this.takePublished('task', original, oldLimit)])];
    const fieldRows = db.prepare('SELECT id FROM field_defs WHERE id>? ORDER BY id LIMIT 1').all(this.fieldCursor);
    this.fieldCursor = fieldRows.length ? String(fieldRows[0]!.id) : '';
    const fields = [...new Set([...fieldRows.map(row => String(row.id)), ...this.takePublished('field', original, 1)])];
    const conversationRows = db.prepare('SELECT id FROM coordinator_conversations WHERE id>? ORDER BY id LIMIT 1').all(this.conversationCursor);
    this.conversationCursor = conversationRows.length ? String(conversationRows[0]!.id) : '';
    const conversations = [...new Set([...conversationRows.map(row => String(row.id)), ...this.takePublished('conversation', original, 1)])];
    const ownerKeys: ChangeKey[] = [...fields.map(id => ({ kind: 'field_def' as const, id })),
      ...conversations.map(id => ({ kind: 'conversation' as const, id }))];
    yield;
    const fresh = auditCandidate(db, original, tasks, ownerKeys);
    const observed = yield* fresh.readSteps(function* (id) {
      const value = fresh.reader.bundle(id) ? deriveTask(fresh.reader, id) : undefined;
      yield;
      const links = yield* relationSteps(fresh.reader, id);
      const facts = value ? aggregateFactsOf(fresh.reader, id) : undefined;
      const scopes = new Map([id, ...(original.bundle(id) ? original.ancestors(id) : [])].map(target =>
        [target, fresh.reader.bundle(target) ? fresh.reader.scopes(target) : []]));
      return { value, links, facts, scopes };
    });
    const repairs = new Map<string, Set<ProjectionRepairKind>>();
    const add = (id: string, kind: ProjectionRepairKind) => { const kinds = repairs.get(id) ?? new Set(); kinds.add(kind); repairs.set(id, kinds); };
    const derived = new Map<string, TaskDerived | undefined>();
    let relationMismatch = false;
    for (const id of tasks) {
      yield;
      const { value, links } = observed.get(id)!;
      derived.set(id, value);
      if (!same(frame.derived(id), value)) add(id, 'derived');
      if (!same(yield* relationSteps(original, id), links)) { add(id, 'records'); relationMismatch = true; }
    }
    const repairKeys: ChangeKey[] = [];
    if (relationMismatch) repairKeys.push(...fresh.keys());
    for (const field of fields) if (!same(original.catalog().get(field), fresh.records().catalog().get(field))) {
      repairKeys.push({ kind: 'field_def', id: field });
      for (const project of new Set([...original.fieldUsers(field), ...fresh.records().fieldUsers(field)])) add(project, 'records');
    }
    for (const conversation of conversations) if (!same(original.conversationFacts(conversation), fresh.records().conversationFacts(conversation))) {
      repairKeys.push({ kind: 'conversation', id: conversation }, { kind: 'person', id: 'coordinator' });
    }
    for (const id of fresh.loaded) {
      if (!same(original.bundle(id), fresh.records().bundle(id))) add(id, 'records');
      yield;
    }
    const changes = new Map([...derived].map(([id, value]) => [id, { before: frame.derived(id)?.contribution, after: value?.contribution }]));
    const facts = new Map([...observed].map(([id, value]) => [id, value.facts]));
    yield;
    const rebuilt = repairScreenAggregate(aggregate, tasks.map(task => ({ task, kind: 'aggregate' })), changes, facts).next;
    for (const id of tasks) for (const target of [id, ...(original.bundle(id) ? original.ancestors(id) : [])]) {
      yield;
      if (!same(totals(aggregate, target), totals(rebuilt, target))) add(id, 'aggregate');
      const beforePages = aggregate.pageScopes(target), afterPages = rebuilt.pageScopes(target);
      if (!same([aggregate.live(target), aggregate.home(target), beforePages], [rebuilt.live(target), rebuilt.home(target), afterPages])) add(id, 'membership');
      if (aggregate.homeAfter(target) !== rebuilt.homeAfter(target)
        || [...new Set([...beforePages, ...afterPages])].some(scope => aggregate.pageAfter(scope, target) !== rebuilt.pageAfter(scope, target))) add(id, 'order');
      const scopes = new Set([...(original.bundle(target) ? original.scopes(target) : []), ...(observed.get(id)!.scopes.get(target) ?? [])]);
      for (const scope of scopes) if (!same(aggregate.scopeCounts(scope), rebuilt.scopeCounts(scope))) add(id, 'aggregate');
    }
    return { skipped: false, tasks, repairs: [...repairs].map(([task, kinds]) => ({ task, kinds })),
      reloadTasks: [...repairs].filter(([, kinds]) => kinds.has('records')).map(([id]) => id), reloadKeys: canonical(repairKeys) };
  }
  private complete(frame: PublishedFrame, latest: () => ChangeSeq, result: ProjectionAuditResult, started: number,
    options: ProjectionAuditOptions, scheduling: Record<string, number> = {}): ProjectionAuditResult {
    if (frame.applied !== latest()) return skipped();
    if (result.repairs.length || result.reloadKeys.length) console.error('Projection audit found stale values',
      { repairs: result.repairs.map(repair => ({ task: repair.task, kinds: [...repair.kinds] })), keys: result.reloadKeys });
    options.timing?.({ step: 'projection-audit', tasks: result.tasks.length, repairs: result.repairs.length,
      keys: result.reloadKeys.length, auditMs: performance.now() - started, ...scheduling });
    return result;
  }
}
