import type { Query as QueryRecord } from '@tanstack/react-query';

type Query = QueryRecord<any, any, any, any>;

/**
 * What one execution reads: the resource again (`full`; for a History window, its newest part as history-window.ts asks
 * for it), or the next page below what is held (`older`). A Query runs one execution at a time, so a History window
 * gets one request at a time: a demand that arrives during an execution is served by the next one.
 */
type ReadPlan = { kind: 'full'; depth: number } | { kind: 'older'; before: string; depth: number };
export type ReadExecution = { through: number; recovery: number; plan: ReadPlan };
type NeedState = {
  requested: number; served: number; failedThrough: number; recovery: number; recovered: number;
  fullThrough: number; older?: { through: number; before: string; depth: number };
  running?: ReadExecution; failedPlan?: ReadPlan;
  waiters: { through: number; settle: () => void }[];
};
const needs = new WeakMap<Query, NeedState>();
const stateFor = (query: Query) => {
  let state = needs.get(query);
  if (!state) { state = { requested: 0, served: 0, failedThrough: -1, recovery: 0, recovered: 0, fullThrough: 0, waiters: [] }; needs.set(query, state); }
  return state;
};
export const readDemandStamp = (query: Query) => stateFor(query).requested;
export const readDemandPending = (query: Query) => stateFor(query).requested > stateFor(query).served;
/** A missing older page owes acquisition without making the already acquired head out of date. */
export const readFreshnessPending = (query: Query) => {
  if (query.queryKey[0] !== 'task-history') return readDemandPending(query);
  const s = stateFor(query);
  return s.fullThrough > s.served || !!s.running && s.running.plan.kind !== 'older' && s.running.through > s.served
    || !!s.failedPlan && s.failedPlan.kind !== 'older' && s.failedThrough > s.served;
};
export const readDemandReady = (query: Query) => readDemandPending(query) && stateFor(query).requested > stateFor(query).failedThrough;
export const readRecoveryPending = (query: Query) => stateFor(query).recovery > stateFor(query).recovered;
export const readHasLaterDemand = (query: Query) => { const s = stateFor(query); return !!s.running && s.requested > s.running.through; };
export const pendingReadPage = (query: Query) => !!stateFor(query).older && stateFor(query).failedPlan?.kind !== 'older';
export const readPageFailed = (query: Query) => stateFor(query).failedPlan?.kind === 'older';
export const readExecution = (query: Query) => stateFor(query).running;

/** Numbered demand and acquired range are distinct. Only completeReadDemand publishes coverage. */
export function requestRead(query: Query) {
  const s = stateFor(query), through = ++s.requested;
  s.fullThrough = through;
  if (query.state.isInvalidated) query.setState({}); else query.invalidate();
  return through;
}
/** Translate native History invalidation once; application requests already have their own generation. */
export function noteReadInvalidation(query: Query) {
  if (query.queryKey[0] === 'task-history' && !readDemandReady(query)) requestRead(query);
}
export function requestReadRecovery(query: Query) {
  const s = stateFor(query); s.recovery++;
  // Preserve a failed older cursor. A failed full read needs a new full acquisition.
  if (s.failedPlan?.kind === 'older' && s.older) { s.older.through = ++s.requested; query.invalidate(); }
  else requestRead(query);
  s.failedPlan = undefined;
}
/**
 * Ask for what lies below the held History window. While another execution runs, it waits its turn: the window is
 * read again first and widened after (never both at once, so news cannot drop what was just widened).
 */
export function requestOlder(query: Query): Promise<void> {
  const s = stateFor(query);
  const before = (query.state.data as { pages?: { nextBefore: string | null }[] } | undefined)?.pages?.at(-1)?.nextBefore;
  if (!before) return Promise.resolve();
  const through = ++s.requested;
  s.older = { through, before, depth: 1 }; s.failedPlan = undefined;
  const waiting = new Promise<void>(settle => s.waiters.push({ through, settle }));
  query.invalidate();
  if (query.state.fetchStatus === 'idle') void query.fetch(undefined, { cancelRefetch: false }).catch(() => {});
  return waiting;
}
export function planRead(query: Query): ReadExecution {
  const s = stateFor(query), pages = (query.state.data as { pages?: unknown[] } | undefined)?.pages;
  if (query.queryKey[0] !== 'task-history' && query.state.fetchMeta?.fetchMore) {
    const last = (query.state.data as { pages?: { nextAfter?: string | null; nextBefore?: string | null }[] } | undefined)?.pages?.at(-1);
    s.older = { through: s.requested, before: last?.nextAfter ?? last?.nextBefore ?? '', depth: (pages?.length ?? 0) + 1 };
  }
  const depth = Math.max(1, pages?.length ?? 1, (s.requested > s.failedThrough ? s.older?.depth : undefined) ?? 1);
  // Reading the newest part again comes first; a wider window is asked for once that has landed.
  const plan: ReadPlan = s.fullThrough > s.served || !s.older || s.requested <= s.failedThrough || !pages?.length
    ? { kind: 'full', depth } : { kind: 'older', before: s.older.before, depth: s.older.depth };
  const run = { through: s.requested, recovery: s.recovery, plan };
  s.running = run;
  return run;
}
const settle = (s: NeedState, through: number) => {
  const done = s.waiters.filter(w => w.through <= through); s.waiters = s.waiters.filter(w => w.through > through);
  done.forEach(w => w.settle());
};
export function completeReadDemand(query: Query, run: ReadExecution) {
  const s = stateFor(query);
  s.served = Math.max(s.served, run.through); s.recovered = Math.max(s.recovered, run.recovery);
  if (s.fullThrough <= run.through && run.plan.kind === 'full') s.fullThrough = 0;
  // A History window's wider read waits for the newer one to land, then follows as its own demand.
  if (query.queryKey[0] === 'task-history' && run.plan.kind === 'full' && s.older) {
    const was = s.older.through; s.older.through = ++s.requested;
    for (const waiter of s.waiters) if (waiter.through === was) waiter.through = s.older.through;
  } else if (s.older && s.older.through <= run.through) {
    const pages = (query.state.data as { pages?: { nextAfter?: string | null; nextBefore?: string | null }[] } | undefined)?.pages;
    const last = pages?.at(-1);
    if (query.queryKey[0] === 'task-history' || !pages || pages.length >= s.older.depth || last?.nextAfter === null || last?.nextBefore === null) s.older = undefined;
  }
  s.failedPlan = undefined;
  if (s.running === run) s.running = undefined;
  settle(s, run.through);
}
export function failReadDemand(query: Query, run = stateFor(query).running) {
  if (!run) return;
  const s = stateFor(query);
  s.failedThrough = Math.max(s.failedThrough, run.through); s.recovered = Math.max(s.recovered, run.recovery); s.failedPlan = run.plan;
  if (s.running === run) s.running = undefined;
  settle(s, run.through);
}
export function retireReadDemand(query: Query) { const s = stateFor(query); settle(s, Infinity); needs.delete(query); }
