import { ControlReadContext } from './read-context.js';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { releaseAdmission } from '../release/journal.js';
/** One durable path from the returns waiting for a seat to the Request that wakes it with them (W1–W3). */
import { randomUUID } from 'node:crypto';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { MAX_INSTRUCTION_BYTES } from '@alpacawork/raw';
import { ControlStore, type ChangeSeq } from '@alpacawork/db';
import type { RoutingWorkSet } from '../receiver/projection-contract.js';
import { routingTasks } from './routing-work.js';
import { prepareRoutingLinks } from './routing-preparation.js';
import type { RoutingTask } from './routing-facts.js';
import { seatSourceIn } from './routing-seats.js';
import { RunStore } from '@alpacawork/runs';
import { RunEventImporter } from '../runs/event-importer.js';
import { readAgentsSettings } from '../agents-settings.js';
import { RequestService } from './requests.js';
import { ReturnLifecycle, returnDisposition } from './return-lifecycle.js';
import { returnLines, returnLinesOf } from './return-lines.js';
import { applyStateLink, stateLinks } from './task-reports.js';
import { TaskTransition, type ControlTx } from './task-transition.js';
import { deliverable, seatFactsOf, seatSettings } from './wake.js';

export type ReturnDispatch = { acceptedRequestIds: string[]; held: Array<{ taskId: string; reason: string; project?: string }> };
/** Legacy project entry points expand to task slices; catch-up passes a work set directly. */
type RoutePasses = 'every' | 'changed' | { project: string } | RoutingWorkSet;
export type RoutingResult = ReturnDispatch & { completed: boolean; completedThrough: ChangeSeq | null };
export type RoutingSweepMiss = { kind: 'routing_sweep_write'; tasks: readonly string[]; after: ChangeSeq; through: ChangeSeq; writes: number };
/** One periodic visit uses the same bounded seat-set interface as catch-up. */
export function* routingSweep(tasks: Iterable<string>, after: ChangeSeq, through: ChangeSeq, size = 16): Generator<RoutingWorkSet> {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Routing batch size must be positive');
  let batch = new Set<string>();
  for (const task of tasks) {
    batch.add(task);
    if (batch.size === size) { yield { tasks: batch, after, through, mode: 'sweep' }; batch = new Set(); }
  }
  if (batch.size) yield { tasks: batch, after, through, mode: 'sweep' };
}

/** Whether to give way to a write now; `resumable` says stopping here loses none of the pass's work. */
type ShouldYield = (resumable: boolean) => boolean;
export type RoutingWrite = <T>(work: () => Promise<T> | T) => Promise<T>;

/** One seat's wake: the returns its Request carries, drawn as its text, at the versions they were read at. */
type Wake = { taskId: string; placementId: string; expectedTaskHash: string; expectedPlacementRevision: number;
  ids: string[]; body: string };

type ChosenWakes = { tasks: readonly RoutingTask[]; wakes: Wake[] };
/** A seat's boundary fault is isolated until the remaining seats have settled; its range stays unacknowledged. */
class BoundaryFailure extends Error {
  constructor(readonly original: unknown, task: string) {
    super(`Run boundaries could not settle for Task ${task}`, { cause: original });
  }
}
export class ReturnRouter {
  constructor(readonly root: string, readonly timing?: (miss: RoutingSweepMiss) => void) {}

  /** Business processing, then receipts, then completion of (after, through]. A partial pass acknowledges nothing. */
  async route(work: RoutingWorkSet, shouldYield?: ShouldYield, ordered: RoutingWrite = async execute => execute()): Promise<RoutingResult> {
    const empty: RoutingResult = { acceptedRequestIds: [], held: [], completed: false, completedThrough: null };
    if (releaseAdmission(this.root) !== 'accepting') return empty;
    // The caller may enqueue another set while this one yields. Neither its seats nor its evidence can grow here.
    work = { ...work, tasks: new Set(work.tasks) };
    const runs = new RunStore(this.root, { busyTimeoutMs: 1_000 });
    let receipts;
    try { receipts = new RunEventImporter(runs).routingReceipts(work); } finally { runs.close(); }
    const writes = { count: 0 };
    const context = new ControlReadContext(new ControlStore(this.root, { busyTimeoutMs: 1_000 }));
    try {
      const one: ReturnDispatch & { deferred: boolean } = { acceptedRequestIds: [], held: [], deferred: false };
      const depths = await context.prepare(async () => new Map(context.connection.prepare(`WITH RECURSIVE
        ancestry(task,id,parent_id) AS (
          SELECT external_id,id,parent_id FROM tasks WHERE external_id IN (SELECT value FROM json_each(?))
          UNION SELECT a.task,t.id,t.parent_id FROM ancestry a JOIN tasks t ON t.id=a.parent_id
        ) SELECT task,count(*) AS depth FROM ancestry GROUP BY task`).all(JSON.stringify([...work.tasks]))
        .map(row => [String(row.task), Number(row.depth)])));
      const seats = [...work.tasks].sort((a, b) => (depths.get(b) ?? 0) - (depths.get(a) ?? 0))
        .map(task => ({ ...work, tasks: new Set([task]) }));
      const failures = new Map<string, BoundaryFailure>();
      // Deepest seats first, and all selected boundaries before reconciliation: a parent sees its child's finish.
      for (const seat of seats) {
        try { await this.settleBoundaries(context, seat, writes, shouldYield, ordered); }
        catch (error) {
          if (!(error instanceof BoundaryFailure)) throw error;
          failures.set([...seat.tasks][0]!, error);
        }
      }
      for (const seat of seats) {
        if (failures.has([...seat.tasks][0]!)) continue;
        await yieldTurn();
        try {
          const next = await this.passWork(seat, writes, shouldYield, ordered, context);
          one.acceptedRequestIds.push(...next.acceptedRequestIds); one.held.push(...next.held);
          one.deferred ||= next.deferred;
          if (next.deferred) break;
        } catch (error) {
          if (!(error instanceof BoundaryFailure)) throw error;
          failures.set([...seat.tasks][0]!, error);
        }
      }
      if (failures.size === 1) throw failures.values().next().value!.original;
      if (failures.size) throw new AggregateError([...failures.values()], 'Run boundaries failed for selected seats');
      if (!one.deferred) {
        await ordered(() => context.write(db => {
          const store = new RunStore(this.root, { busyTimeoutMs: 1_000 }, false, db);
          try { return new RunEventImporter(store).acknowledgeRouting(work, receipts); } finally { store.close(); }
        }));
      }
      return { acceptedRequestIds: one.acceptedRequestIds, held: one.held, completed: !one.deferred,
        completedThrough: one.deferred ? null : work.through };
    } finally {
      context.close();
      if (work.mode === 'sweep' && writes.count) {
        const miss: RoutingSweepMiss = { kind: 'routing_sweep_write', tasks: [...work.tasks], after: work.after,
          through: work.through, writes: writes.count };
        console.error(JSON.stringify(miss));
        this.timing?.(miss);
      }
    }
  }
  /** Existing administrative/configuration entry points; the server's changed path supplies RoutingWorkSet. */
  async pass(shouldYield?: ShouldYield, which: RoutePasses = 'every'): Promise<ReturnDispatch | RoutingResult> {
    if (typeof which === 'object' && 'tasks' in which) return this.route(which, shouldYield);
    const result: ReturnDispatch = { acceptedRequestIds: [], held: [] };
    if (releaseAdmission(this.root) !== 'accepting') return result;
    const control = new ControlStore(this.root, { busyTimeoutMs: 1_000 }, true);
    let tasks: string[];
    try { tasks = control.read(db => {
      if (typeof which === 'object') return [...routingTasks(db, which.project).tasks];
      return db.prepare(`SELECT external_id FROM tasks WHERE kind='task' AND project_task_id IN
        (SELECT id FROM tasks WHERE kind='project' AND lifecycle='active') ORDER BY number`)
        .all().map(row => String(row.external_id));
    }); } finally { control.close(); }
    // Initial/configuration routing is expected to write. Only the periodic sweep is an omission detector.
    for (const slice of routingSweep(tasks, 0 as ChangeSeq, 0 as ChangeSeq)) {
      const one = await this.route({ ...slice, mode: 'changed' }, shouldYield);
      result.acceptedRequestIds.push(...one.acceptedRequestIds); result.held.push(...one.held);
    }
    return result;
  }
  /** Every boundary commits independently and rereads its current Task facts, yielding between writes. */
  private async settleBoundaries(context: ControlReadContext, work: RoutingWorkSet, writes: { count: number },
    shouldYield: ShouldYield | undefined, ordered: RoutingWrite): Promise<void> {
    try {
      await yieldTurn();
      if (shouldYield?.(true)) throw new Problem(PROBLEM_CODE.busy, 'Returns yielded to a Task write');
      let pending = await prepareRoutingLinks(context, work, shouldYield);
      while (pending) {
        await yieldTurn();
        pending = await ordered(() => {
          if (shouldYield?.(true)) throw new Problem(PROBLEM_CODE.busy, 'Returns yielded to a Task write');
          return this.controlWrite(context, writes, tx => {
            const current = stateLinks(tx, work, context).links;
            if (current[0]) applyStateLink(tx, new TaskTransition(), current[0]);
            return current.length > 1;
          });
        });
      }
    } catch (error) {
      // A shared write's turn and quiesce stop the pass immediately; only a seat fault is isolated.
      if (error instanceof Problem && error.code === PROBLEM_CODE.busy) throw error;
      throw new BoundaryFailure(error, [...work.tasks][0]!);
    }
  }
  /** The selected seats, reconciled at one write point, then each wake sent as its own Request. */
  private async passWork(work: RoutingWorkSet, writes: { count: number }, shouldYield: ShouldYield | undefined, ordered: RoutingWrite, context: ControlReadContext): Promise<ReturnDispatch & { deferred: boolean }> {
    let deferred = false;
    const yieldToWrite = (resumable = false) => { if (shouldYield?.(resumable)) throw new Problem(PROBLEM_CODE.busy, 'Returns yielded to a Task write', undefined, { reason: { kind: 'returns_yielded_task_write' } }); };
    yieldToWrite();
    const held: ReturnDispatch['held'] = [];
    let chosen: ChosenWakes | { pending: true };
    do {
      await this.settleBoundaries(context, work, writes, shouldYield, ordered);
      chosen = await ordered(() => { yieldToWrite(); return this.chooseWakes(context, work, held, writes); });
      // A boundary may arrive after preparation. Return to the same one-boundary transaction path.
    } while ('pending' in chosen);
    const { tasks, wakes } = chosen;
    yieldToWrite();
    const acceptedRequestIds: string[] = [];
    for (const wake of wakes) {
      yieldToWrite();
      // A new ID for each try: a Request that was refused or conflicted is never sent again.
      const requestId = `RETREQ${randomUUID()}`;
      try {
        await ordered(() => { yieldToWrite(); return new RequestService(this.root).request({ taskId: wake.taskId, body: wake.body, requestId,
          expectedTaskHash: wake.expectedTaskHash, expectedPlacementRevision: wake.expectedPlacementRevision,
          targetPlacementId: wake.placementId }, { purpose: 'return_continuation', returnIds: wake.ids }); });
        acceptedRequestIds.push(requestId);
        writes.count++;
      } catch (error) {
        if (!(error instanceof Problem)) throw error;
        // Only busy needs this range retried; writes resolving conflict, conversation_busy or handoff_pending enqueue the seat again.
        if (['conflict', 'conversation_busy', 'handoff_pending', 'busy'].includes(error.code)) { deferred ||= error.code === 'busy'; continue; }
        // An admission's refusal (too_deep, too_many_children, not_resumable, ...) stays on the returns: the user's turn.
        held.push({ taskId: wake.taskId, reason: error.code });
        await ordered(() => this.controlWrite(context, writes, ({ runs }, db) => new ReturnLifecycle(db, runs, tasks, undefined, context, this.root).hold(wake.ids, error.code, error.reason)));
      }
    }
    return { acceptedRequestIds, held, deferred };
  }
  private controlWrite<T>(context: ControlReadContext, writes: { count: number }, execute: (tx: ControlTx, db: import('node:sqlite').DatabaseSync) => T): T {
    const result = context.write(db => {
      const before = Number(db.prepare('SELECT total_changes() AS n').get()!.n);
      const store = new RunStore(this.root, { busyTimeoutMs: 1_000 }, false, db);
      try {
        const value = store.write(runs => execute({ store, runs }, db));
        return { value, count: Number(db.prepare('SELECT total_changes() AS n').get()!.n) - before };
      } finally { store.close(); }
    });
    writes.count += result.count;
    return result.value;
  }
  /** Reconcile at the current write point only once every selected Run boundary has settled. */
  private chooseWakes(context: ControlReadContext, work: RoutingWorkSet, held: ReturnDispatch['held'],
    writes: { count: number }): ChosenWakes | { pending: true } {
    // Unreadable settings configure no agent: a responsible's seat waits for its profile.
    const limits = seatSettings(readAgentsSettings(this.root));
    return this.controlWrite(context, writes, ({ store, runs }, db) => {
      const found = stateLinks({ store, runs }, work, context);
      if (found.links.length) return { pending: true as const };
      const snapshot = found.snapshot;
      const tasks = snapshot.tasks, lifecycle = new ReturnLifecycle(db, runs, tasks, undefined, context, this.root);
      lifecycle.reconcile(work);
      lifecycle.abortStaleContinuations(work);
      // Dispatch reads the seats at this write's read point, after reconciliation, with no snapshot of its own.
      const seats = seatSourceIn(runs, work, tasks, limits, lifecycle.current);
      const ready = tasks.filter(task => work.tasks.has(task.id)).flatMap(task => {
        const pending = seats.returnsTo(task.id).filter(row => returnDisposition(row) === 'pending');
        if (!pending.length) return [];
        const { rows, block } = deliverable(seatFactsOf(seats, task.id), pending);
        if (block?.human) held.push({ taskId: task.id, reason: block.code });
        return block ? [] : [{ task, rows }];
      });
      const wakes = ready.flatMap(({ task, rows }): Wake[] => {
        const ids = rows.map(row => row.id), placement = seats.responsible(task.id);
        if (!placement) {
          lifecycle.hold(ids, PROBLEM_CODE.responsibleMissing);
          held.push({ taskId: task.id, reason: PROBLEM_CODE.responsibleMissing });
          return [];
        }
        return [{ taskId: task.id, placementId: placement.id, expectedTaskHash: task.hash,
          expectedPlacementRevision: placement.revision, ids,
          body: returnLines(returnLinesOf(lifecycle, rows), MAX_INSTRUCTION_BYTES).body }];
      });
      return { tasks, wakes };
    });
  }
}
