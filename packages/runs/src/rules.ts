/** Pure run relationships, admission rules, and lifecycle decisions. */
import { isRunEnded, RUN_STATE_REASONS, compareRunIds, runNumber, type RunRecord, type CoordinatorRunRecord, type RuntimeRunRecord } from '@alpacawork/contract/run';
import type { RunId } from '@alpacawork/contract/fields';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { hasRequesterSeat, isSeatContinuation } from '@alpacawork/contract';
import { speaksForUser } from '@alpacawork/raw';
import type { StoredRequest } from './reads.js';

type Runs = readonly RunRecord[];
type State = RunRecord['state'];
type Reason = RunRecord['reason'];
export const isEnded = (run: Pick<RunRecord, 'state'>): boolean => isRunEnded(run.state);
/** The one in-memory form of `UNFINISHED_SQL`: queued, running, or waiting for review. */
export const isUnfinished = (run: Pick<RunRecord, 'state'>): boolean => !isEnded(run);
export const usesSlot = (run: Pick<RunRecord, 'state' | 'reason'>): boolean =>
  run.state === 'running' || (run.state === 'needs_review' && run.reason !== 'conversation_busy');
/** How a Request starts out by its Run's place in its lane: a continuation with no session yet waits for it, else any unfinished Run ahead. */
export const admittedDelivery = (continues: boolean, session: RunRecord['session'], lane: readonly Pick<RunRecord, 'state'>[]) =>
  continues && !session ? DELIVERY_STATE.waiting_for_session : lane.some(isUnfinished) ? DELIVERY_STATE.waiting_for_run : DELIVERY_STATE.queued;
export const conversationInUse = (runs: readonly Pick<RunRecord, 'session' | 'state' | 'reason'>[], sessionId: string): boolean =>
  runs.some(run => run.session?.id === sessionId && usesSlot(run));

type Lane = Pick<RunRecord, 'role' | 'placementId'> | Pick<CoordinatorRunRecord, 'role' | 'conversationId'>;
type LanePosition = Lane & Partial<Pick<RuntimeRunRecord, 'id' | 'session' | 'firstRunId'>>;
type OrderedRun = Pick<RuntimeRunRecord, 'id' | 'firstRunId'>;
export const compareRequestOrder = (a: OrderedRun, b: OrderedRun) =>
  runNumber(a.firstRunId ?? a.id) - runNumber(b.firstRunId ?? b.id);
const sameLane = (a: Lane, b: Lane): boolean => a.role === 'coordinator'
  ? b.role === 'coordinator' && a.conversationId === b.conversationId
  : b.role !== 'coordinator' && a.placementId === b.placementId;
/**
 * What must leave a lane before this Run (or a new message with no ID) can go. Delivery holds precede ordinary
 * admission checks in the scheduler; turn order follows them. Keeping the reason preserves that decision order.
 * Settings, capacity and launch preparation are not turn order and do not belong here.
 */
export function laneAhead(runs: readonly RuntimeRunRecord[], position: LanePosition,
  blocked: ReadonlySet<number>, reservations: ReadonlySet<number>): { kind: 'delivery' | 'turn'; run: RunId } | null {
  if (position.id && reservations.has(runNumber(position.id))) return { kind: 'delivery', run: position.id };
  const held = runs.find(run => blocked.has(runNumber(run.id)) &&
    !(run.role === 'coordinator' && run.state !== 'succeeded' && run.state !== 'queued' && !usesSlot(run)) &&
    (sameLane(run, position) || run.session && run.session.id === position.session?.id));
  if (held) return { kind: 'delivery', run: held.id };
  const ahead = runs.find(run => sameLane(run, position) &&
    (!position.id || compareRequestOrder(run, { id: position.id, firstRunId: position.firstRunId }) < 0) && (run.state === 'queued' || usesSlot(run)));
  return ahead ? { kind: 'turn', run: ahead.id } : null;
}

type AutomaticRequest = Pick<StoredRequest, 'taskId' | 'placementId' | 'purpose' | 'author' | 'deliveryState' | 'submittedAt'>;
type RequestPosition = { at: string; index: number };
/** The stable locale order the automatic limit reads; equal timestamps retain their original array order. */
const after = (position: RequestPosition, prior: RequestPosition): boolean => {
  const order = position.at.localeCompare(prior.at);
  return order > 0 || order === 0 && position.index > prior.index;
};

/** The automatic limit's derived facts, fixed when its Requests are captured, never retaining their mutable rows. */
export interface AutomaticIndex {
  count(placementId: string, ancestry: readonly string[]): number;
  reached(placementId: string, ancestry: readonly string[], limit: number): boolean;
}

/** Capture one read point's last user reset per Task and automatic Request positions per placement, indexed once. */
export function automaticIndex(requests: readonly AutomaticRequest[]): AutomaticIndex {
  const resets = new Map<string, RequestPosition>(), automatic = new Map<string, RequestPosition[]>();
  for (const [index, request] of requests.entries()) {
    if (request.deliveryState === DELIVERY_STATE.aborted || request.deliveryState === DELIVERY_STATE.recorded_unconfirmed) continue;
    const position = { at: request.submittedAt, index };
    if (speaksForUser(request.author)) {
      const reset = resets.get(request.taskId);
      if (!reset || after(position, reset)) resets.set(request.taskId, position);
    }
    // A user-authored continuation can reset an ancestor and still count for a seat outside that ancestry.
    if (hasRequesterSeat(request) || isSeatContinuation(request.purpose)) {
      const group = automatic.get(request.placementId);
      if (group) group.push(position); else automatic.set(request.placementId, [position]);
    }
  }
  const count = (placementId: string, ancestry: readonly string[]): number => {
    let reset: RequestPosition | undefined;
    for (const taskId of ancestry) {
      const candidate = resets.get(taskId);
      if (candidate && (!reset || after(candidate, reset))) reset = candidate;
    }
    const group = automatic.get(placementId);
    if (!reset) return group?.length ?? 0;
    let total = 0;
    // Strictly after excludes the reset itself, including a user-authored continuation.
    for (const position of group ?? []) if (after(position, reset)) total++;
    return total;
  };
  return { count, reached: (placementId, ancestry, limit) => count(placementId, ancestry) >= limit };
}

/** The one automatic-limit test, shared with each read point's captured AutomaticIndex. */
export function automaticLimitReached(requests: readonly AutomaticRequest[],
  placementId: string, ancestry: readonly string[], limit: number): boolean {
  return automaticIndex(requests).reached(placementId, ancestry, limit);
}

function isSameSeat(run: Pick<RunRecord, 'task' | 'role'>,
  caller: Pick<RunRecord, 'task' | 'role'>): boolean {
  return run.task === caller.task && run.role === caller.role;
}

/** Build once per decision pass; these indexes never outlive their input snapshot. */
export function relationships(runs: Runs) {
  const records = new Map(runs.map(run => [run.id, run]));
  const kids = new Map<RunId, RunRecord[]>();
  for (const run of runs) {
    if (run.caller) {
      const group = kids.get(run.caller.run) ?? [];
      group.push(run); kids.set(run.caller.run, group);
    }
  }
  const children = (id: RunId): RunRecord[] => (kids.get(id) ?? []).slice().sort(compareRunIds);
  function ancestors(caller: RunRecord['caller']): RunRecord[] {
    const result: RunRecord[] = [], seen = new Set<RunId>();
    while (caller) {
      if (seen.has(caller.run)) throw new Error('Cyclic caller chain');
      seen.add(caller.run);
      const parent = records.get(caller.run);
      if (!parent) throw new Error('Missing caller run');
      result.push(parent); caller = parent.caller;
    }
    return result;
  }
  function delegationDepth(run: Pick<RunRecord, 'caller' | 'task' | 'role' | 'resumes'>): number {
    let count = 1;
    let child = run;
    for (const parent of ancestors(run.caller)) {
      // A request-backed resume of the same Task and role is causally below
      // its caller for stopping, but does not add a delegation level.
      if (!isSameSeat(child, parent))
        count++;
      child = parent;
    }
    return count;
  }
  function descendants(id: RunId): RunRecord[] {
    const found = new Map<RunId, RunRecord>(), pending = [id];
    while (pending.length) {
      const run = records.get(pending.pop()!);
      if (!run || found.has(run.id)) continue;
      found.set(run.id, run);
      pending.push(...children(run.id).map(child => child.id));
      if (run.supersededBy) pending.push(run.supersededBy);
    }
    return [...found.values()].sort(compareRunIds);
  }
  function stopEffect(run: RunRecord): StopEffect | null {
    if (run.state === 'queued') return 'cancel';
    if (run.state === 'needs_review')
      return run.reason === 'conversation_busy' ? 'cancel' : run.pids.agent !== null ? 'request' : 'hold';
    if (run.state === 'running') return 'request';
    return isEnded(run) && run.role === 'owner' ? 'hold' : null;
  }
  return { children, ancestors, delegationDepth, descendants, stopEffect };
}
export const children = (runs: Runs, id: RunId): RunRecord[] => relationships(runs).children(id);
export const depth = (runs: Runs, run: Pick<RunRecord, 'caller' | 'task' | 'role' | 'resumes'>): number =>
  relationships(runs).delegationDepth(run);
export const descendants = (runs: Runs, id: RunId): RunRecord[] => relationships(runs).descendants(id);
/** What stop does to one targeted run (design §2.3); null when the run needs nothing. */
type StopEffect = 'cancel' | 'request' | 'hold';
export const stopEffect = (runs: Runs, run: RunRecord): StopEffect | null => relationships(runs).stopEffect(run);
/** A Run still working cannot be found busy by failing; only a Run already waiting for review can (`needs_review`). */
const WORK_FAILURES = RUN_STATE_REASONS.failed.filter(reason => reason !== 'conversation_busy');
const RUN_TRANSITIONS = {
  queued: { running: [null], cancelled: RUN_STATE_REASONS.cancelled, joined: [null] },
  running: { succeeded: [null], failed: WORK_FAILURES, cancelled: ['stopped'], needs_review: RUN_STATE_REASONS.needs_review },
  needs_review: { cancelled: ['stopped'], failed: RUN_STATE_REASONS.failed, succeeded: [null], needs_review: RUN_STATE_REASONS.needs_review },
  succeeded: {}, failed: {}, cancelled: {}, joined: {},
} as const;
export function canTransition(before: Pick<RunRecord, 'state' | 'reason'>, after: Pick<RunRecord, 'state' | 'reason'>): boolean {
  const reasons: readonly Reason[] = RUN_STATE_REASONS[after.state];
  if (!reasons.includes(after.reason)) return false;
  if (before.state === after.state && before.reason === after.reason) return true;
  // Generic faults and manager loss are provisional. A durable observation can resolve
  // either to contention; already confirmed contention cannot become execution.
  if (before.state === 'needs_review') {
    if (before.reason === 'conversation_busy' && after.state !== 'cancelled' && after.reason !== 'conversation_busy') return false;
  }
  const transitions: Partial<Record<State, readonly Reason[]>> = RUN_TRANSITIONS[before.state];
  return transitions[after.state]?.includes(after.reason) ?? false;
}

type RunLimitRefusal = 'too_deep' | 'too_many_children';
// Admission marks the same seat's automatic continuation before the persisted Run is created.
type RunLimitIdentity = Pick<RunRecord, 'caller' | 'task' | 'role' | 'resumes'> & { continues: boolean };
/** Request reservations use the caller-chain limits. */
export function checkRunLimits(runs: Runs, identity: RunLimitIdentity,
  limits: { depth: number; children_per_run: number }): RunLimitRefusal | null {
  const graph = relationships(runs);
  const ancestors = graph.ancestors(identity.caller);
  if (graph.delegationDepth(identity) > limits.depth) return 'too_deep';
  const parent = ancestors[0];
  // The same seat's automatic continuation goes on with existing work; it does not add a child.
  if (parent && !identity.continues && graph.children(parent.id).filter(child => child.attempt === undefined).length >= limits.children_per_run)
    return 'too_many_children';
  return null;
}
