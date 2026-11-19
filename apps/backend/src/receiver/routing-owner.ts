/** The routing reader retains unfinished ranges and advances only over completed business work. */
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { ChangeLog, ChangeSeq } from '@alpacawork/db';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { routingSweep, type ReturnRouter } from '../control/return-router.js';
import type { PublishedFrame, RoutingWorkSet } from './projection-contract.js';
import { retryDelay } from './retry-delay.js';
type Retry = { count: number; at: number };
function deferRetry(previous: Retry | undefined, fault: boolean): Retry {
  const count = (previous?.count ?? 0) + Number(fault);
  return { count, at: Date.now() + retryDelay(fault ? count : 1) };
}

/** Only unfinished work needs its seats; completed ranges reduce to a high-water mark behind their holes. */
class RoutingQueue {
  private readonly pending: RoutingWorkSet[] = [];
  private readonly retries = new Map<RoutingWorkSet, Retry>();
  completedThrough = 0 as ChangeSeq;
  get length() { return this.pending.length; }
  get floor(): ChangeSeq | undefined { return this.pending[0]?.after; }
  enqueue(work: RoutingWorkSet) { this.pending.push(work); }
  contains(work: RoutingWorkSet) { return this.pending.includes(work); }
  available(work: RoutingWorkSet) { return (this.retries.get(work)?.at ?? 0) <= Date.now(); }
  next() { return this.pending.find(work => this.available(work)); }
  retry() { return this.pending.find(work => this.available(work) && this.retries.has(work)); }
  overlappingRetry(work: RoutingWorkSet) {
    return this.pending.find(pending => this.available(pending) && this.retries.has(pending)
      && [...work.tasks].some(task => pending.tasks.has(task)));
  }
  overlapsDeferred(work: RoutingWorkSet) {
    return this.pending.some(pending => !this.available(pending)
      && [...work.tasks].some(task => pending.tasks.has(task)));
  }
  defer(work: RoutingWorkSet, fault: boolean): Retry {
    const retry = deferRetry(this.retries.get(work), fault);
    this.retries.set(work, retry);
    return retry;
  }
  complete(work: RoutingWorkSet) {
    const index = this.pending.indexOf(work);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.retries.delete(work);
    this.completedThrough = Math.max(this.completedThrough, work.through) as ChangeSeq;
  }
}

type Sweep = { after: ChangeSeq; through: ChangeSeq; slices: Generator<RoutingWorkSet>; current?: RoutingWorkSet;
  retry?: Retry; recovery: boolean; mode: RoutingWorkSet['mode'] };
/** A retained slice and its recovery boundary survive ordinary work and newer full publications. */
class RoutingSweeps {
  active?: Sweep;
  pendingRecovery?: ChangeSeq;
  recoveredThrough = 0 as ChangeSeq;
  resume = false;
  last = Date.now();
  begin(ids: Iterable<string>, after: ChangeSeq, through: ChangeSeq, recovery: boolean, initial = false) {
    if (this.active) return;
    this.resume = false;
    this.active = { after, through, slices: routingSweep(ids, after, through, 16), recovery, mode: initial ? 'changed' : 'sweep' };
  }
  available() { return (this.active?.retry?.at ?? 0) <= Date.now(); }
  defer(fault: boolean): Retry {
    const active = this.active!;
    return active.retry = deferRetry(active.retry, fault);
  }
  completeSlice() {
    this.active!.current = undefined;
    this.active!.retry = undefined;
    this.resume = false;
  }
  finish() {
    const finished = this.active!;
    this.active = undefined;
    if (finished.recovery) this.recoveredThrough = Math.max(this.recoveredThrough, finished.through) as ChangeSeq;
    this.last = Date.now();
  }
}

export class RoutingOwner {
  private position = 0 as ChangeSeq;
  private readonly queue = new RoutingQueue();
  private readonly sweeps = new RoutingSweeps();
  private running?: Promise<void>;
  private readonly release: () => void;
  private closed = false;
  private dueSince?: number;
  private kick?: ReturnType<typeof setImmediate>;
  constructor(private readonly log: ChangeLog, private readonly router: ReturnRouter,
    private readonly current: () => PublishedFrame | undefined,
    private readonly ordered: <T>(work: () => Promise<T>) => Promise<T>, private readonly yieldToWrite: (overdue: boolean) => boolean,
    private readonly timing?: (facts: Record<string, unknown>) => void,
    private readonly ready?: (overdue: boolean) => Promise<boolean>) {
    this.release = log.register('routing', this.position);
  }
  enqueue(work: RoutingWorkSet, full: boolean) {
    if (this.closed) return;
    if (full && this.current()) {
      if (this.sweeps.active) {
        // Complete the retained slice/range first; the newer boundary gets its own bounded recovery sweep.
        this.sweeps.pendingRecovery = work.through;
        this.sweeps.active.recovery = true;
      } else this.beginSweep(work.through, true, work.after === 0);
    } else this.queue.enqueue(work);
    this.dueSince ??= Date.now();
    if (!this.kick) this.kick = setImmediate(() => {
      this.kick = undefined;
      void this.pass().catch(error => console.error('Routing reader failed', error));
    });
  }
  private beginSweep(through: ChangeSeq, recovery: boolean, initial = false) {
    this.sweeps.begin(this.current()?.records.taskIds() ?? [], this.position, through, recovery, initial);
  }
  pass(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    const work = this.drain(); this.running = work;
    return work.finally(() => { this.running = undefined; });
  }
  private overdue() { return this.dueSince !== undefined && Date.now() - this.dueSince >= 4_000; }
  private shouldYield() { return this.yieldToWrite(this.overdue()); }
  private defer(work: RoutingWorkSet, fault: boolean) {
    return this.queue.contains(work) ? this.queue.defer(work, fault) : this.sweeps.defer(fault);
  }
  private deferIncomplete(work: RoutingWorkSet) {
    if (this.closed || this.shouldYield()) return;
    // A seat waiting on input or its own writer must not hold unrelated seats behind it.
    this.defer(work, false);
    return true;
  }
  private async drain() {
    while (!this.closed) {
      if (this.queue.length || this.sweeps.active || this.sweeps.pendingRecovery !== undefined
        || this.log.read('routing').kind === 'overflow' || Date.now() - this.sweeps.last >= 300_000)
        this.dueSince ??= Date.now();
      // A command's committed response may still be passing through its HTTP middleware.
      await yieldTurn();
      if (this.closed || this.ready && !await this.ready(this.overdue())) return;
      // A floor read may just have published compressed SSE output. Return to I/O before taking the business lane.
      await yieldTurn();
      if (this.closed) return;
      const progress = await this.one();
      if (!progress || progress === 'sweep') return;
    }
  }
  private finishQueued(work: RoutingWorkSet) {
    this.queue.complete(work);
    this.sweeps.resume = true;
    this.advance();
  }
  /** Completed recovery is evidence, but cannot acknowledge an ordinary range still awaiting its business work. */
  private advance() {
    let through = Math.max(this.queue.completedThrough, this.sweeps.recoveredThrough) as ChangeSeq;
    if (this.queue.floor !== undefined) through = Math.min(through, this.queue.floor) as ChangeSeq;
    if (this.sweeps.active?.recovery) through = Math.min(through, this.sweeps.active.after) as ChangeSeq;
    if (this.sweeps.pendingRecovery !== undefined) through = Math.min(through, this.position) as ChangeSeq;
    if (through > this.position) {
      this.position = through; this.log.acknowledge('routing', through);
    }
  }
  private async one() {
    const frame = this.current();
    if (!frame || this.closed || !frame.records.environment().writable) return;
    if (!this.sweeps.active && this.sweeps.pendingRecovery !== undefined) {
      const through = this.sweeps.pendingRecovery; this.sweeps.pendingRecovery = undefined;
      this.beginSweep(through, true);
    }
    const overflow = this.log.read('routing').kind === 'overflow';
    if (overflow && !this.sweeps.active && frame.applied > this.sweeps.recoveredThrough) {
      if (frame.applied < this.log.latest && !this.overdue()) return;
      this.beginSweep(frame.applied, true);
    }
    // Alternate changed seats with recovery slices; recovery still owns the acknowledgment floor.
    const queued = this.queue.next();
    const retry = this.queue.retry();
    const retryingSweep = this.sweeps.active?.current && !this.sweeps.available();
    let work = this.sweeps.active?.recovery && this.sweeps.resume && !retryingSweep ? undefined : retry ?? queued, fromSweep = false;
    if (!work) {
      if (retryingSweep || this.queue.length && !queued && !this.sweeps.active?.recovery) return;
      if (!this.sweeps.active?.recovery && !this.overdue()
        && (this.position !== this.log.latest || frame.applied !== this.log.latest)) return;
      if (!this.sweeps.active && Date.now() - this.sweeps.last >= 300_000) this.beginSweep(frame.applied, false);
      if (!this.sweeps.active) return;
      work = this.sweeps.active.current ?? this.sweeps.active.slices.next().value;
      if (!work) {
        this.sweeps.finish();
        this.advance(); return true;
      }
      work = this.sweeps.active.current ?? { ...work, mode: this.sweeps.active.mode };
      this.sweeps.active.current = work;
      const original = this.queue.overlappingRetry(work);
      if (original) work = original;
      else if (this.queue.overlapsDeferred(work)) {
        if (!queued) return;
        work = queued;
      } else fromSweep = true;
    }
    this.dueSince ??= Date.now();
    const started = performance.now();
    try {
      const interrupted = { completed: false, completedThrough: null, acceptedRequestIds: [], held: [] };
      const ready = !this.closed && !this.shouldYield() && (!this.ready || await this.ready(this.overdue()));
      const result = !ready || this.closed || this.shouldYield() ? interrupted
        : await this.router.route(work!, () => this.closed || this.shouldYield()
          || fromSweep && !this.sweeps.active?.recovery && !this.overdue() && this.position !== this.log.latest,
          execute => this.ordered(async () => {
            if (this.closed || this.shouldYield() || this.ready && !await this.ready(this.overdue()))
              throw new Problem(PROBLEM_CODE.busy, 'Routing waits for published facts or a waiting reader');
            if (this.closed || this.shouldYield())
              throw new Problem(PROBLEM_CODE.busy, 'Routing yielded while waiting for publication');
            return execute();
          }));
      if (!result.completed || result.completedThrough !== work.through) return this.deferIncomplete(work);
      if (fromSweep) this.sweeps.completeSlice();
      else this.finishQueued(work);
      this.dueSince = this.queue.length || this.sweeps.active ? Date.now() : undefined;
      return fromSweep ? 'sweep' as const : true;
    } catch (error) {
      if (error instanceof Problem && error.code === PROBLEM_CODE.busy) return this.deferIncomplete(work);
      const { count } = this.defer(work, true), retryMs = retryDelay(count);
      console.error('Routing range failed', { after: work.after, through: work.through, tasks: [...work.tasks], error });
      if (count >= 3) console.error('Routing range deferred after repeated fault',
        { after: work.after, through: work.through, tasks: [...work.tasks], retryMs });
      this.timing?.({ step: 'pass', kind: 'routing_retry', after: work.after, through: work.through, failures: count, retryMs });
      return true;
    } finally {
      if (!fromSweep) this.sweeps.resume = true;
      this.timing?.({ step: 'pass', kind: 'routing', after: work.after, through: work.through, tasks: work.tasks.size, routeMs: performance.now() - started });
    }
  }
  async close(): Promise<void> { this.closed = true; if (this.kick) clearImmediate(this.kick); try { await this.running; } finally { this.release(); } }
}
