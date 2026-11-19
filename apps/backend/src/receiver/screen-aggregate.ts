/**
 * Incremental tree totals and ordered membership. No database reads or project-wide rebuilds on update.
 *
 * Each Task's AggregateContribution is its own part; parentage is its `parentId`. A batch may add, remove and reparent
 * Tasks and change a parent and its child at once: pass each changed ID's final contribution. A cycle throws before
 * publication, and a published snapshot stays readable after later updates and failures (edited paths are copied).
 * Child summaries stop propagating once the values a parent consumes agree; normal updates never scan siblings or whole
 * scopes. `changed.tasks` names changed aggregate values and changed home predecessors (a moved row's neighbours),
 * `changed.pages` the closed pages whose membership, row values or order moved; the caller adds the scopes those reach
 * (aggregateResources) to the ones `affected` names.
 *
 * Repairs rebuild each named node and its ancestor chain from current child summaries, even without a contribution
 * delta, and never subtract from a possibly wrong cached total; corrupt parent edges or contributions are the records'
 * and the derivation's to repair first.
 */
import { HOME_SECTIONS, placeHome, type HomeSection, type UsageTotal } from '@alpacawork/contract';
import { isFinished } from '@alpacawork/contract/branch';
import { closedPageScope, type ControlIndexDTO } from '@alpacawork/contract/control';
import { byTaskNumber } from '@alpacawork/contract/moved';
import type { AggregateChanges, AggregateContribution, AggregateUpdate, ScreenAggregate, TaskId } from './projection-contract.js';
import { AggregateIndex, keyedIndex } from './aggregate-index.js';
import { AggregateTotals } from './aggregate-totals.js';

type ChildCounts = NonNullable<ReturnType<ScreenAggregate['children']>>;
type Home = NonNullable<ReturnType<ScreenAggregate['home']>>;
type Counts = ReturnType<ScreenAggregate['counts']>;
type Change = { readonly before: AggregateContribution | undefined; readonly after: AggregateContribution | undefined };
/** Inputs absent from AggregateContribution (workspace-aggregate-facts makes them). Supply scopes from
 * RecordsReader.scopes, and freshness from the notice baselines (a personal read changes it without a contribution).
 * menuRunning means a Run in state running (distinct from a placement's running flag or an open span).
 * Changed facts are supplied only for their owners; a changed scope chain includes every Task whose scopes changed,
 * a moved or shelved project's subtree included. `listed`: the index sends its row (its project is listed and its
 * row was read), so the home list's order holds it; a row the index does not send is never a shown row's predecessor. */
export interface AggregateFacts {
  readonly scopes: readonly string[];
  readonly listed: boolean;
  readonly freshFinished: boolean;
  readonly menuRunning: boolean;
}
export type AggregateRepairKind = 'aggregate' | 'membership' | 'order';
export interface AggregateRepair { readonly task: TaskId; readonly kind: AggregateRepairKind }
interface Usage extends UsageTotal { readonly knownGroups: number }
interface Order { readonly id: string; readonly at: number; readonly section: number }
const orderCompare = (a: Order, b: Order) => a.section - b.section || b.at - a.at || byTaskNumber(a, b);
const orderIndex = () => new AggregateIndex<Order, string>(orderCompare);
interface RunKey { readonly id: string; readonly at: number }
const runIndex = () => new AggregateIndex<RunKey, number>((a, b) => byTaskNumber(a, b) || a.at - b.at);
function addRun(runs: ReturnType<typeof runIndex>, key: RunKey, delta: number): ReturnType<typeof runIndex> {
  const count = (runs.get(key) ?? 0) + delta; return count ? runs.set(key, count) : runs.delete(key);
}
const states = (): ChildCounts['states'] => ({ todo: 0, doing: 0, error: 0, waiting: 0, held: 0, done: 0, stopped: 0 });
const emptyUsage = (): Usage => ({ runs: 0, runMs: 0, tokens: null, tokensUnknown: 0, knownGroups: 0 });
const ownUsage = (own?: AggregateContribution): Usage => ({ ...(own?.usage ?? emptyUsage()), knownGroups: own?.usage.tokens === null || !own ? 0 : 1 });
function addUsage(a: Usage, b: Usage, sign: number): Usage {
  const knownGroups = a.knownGroups + sign * b.knownGroups;
  const counter = (key: 'input' | 'cacheRead' | 'cacheWrite' | 'output') => (a.tokens?.[key] ?? 0) + sign * (b.tokens?.[key] ?? 0);
  return { runs: a.runs + sign * b.runs, runMs: a.runMs + sign * b.runMs, tokensUnknown: a.tokensUnknown + sign * b.tokensUnknown,
    knownGroups, tokens: knownGroups ? { input: counter('input'), cacheRead: counter('cacheRead'), cacheWrite: counter('cacheWrite'), output: counter('output') } : null };
}
const publicUsage = ({ knownGroups: _, ...usage }: Usage): UsageTotal => ({ ...usage, tokens: usage.tokens && { ...usage.tokens } });
interface ParentValue {
  readonly own?: Pick<AggregateContribution, 'lifecycle' | 'state'>;
  readonly active: number; readonly running: number; readonly working: number; readonly live: number;
  readonly homeWork: boolean; readonly usage: Usage; readonly moved: number; readonly runs: ReturnType<typeof runIndex>;
}
interface Node extends ParentValue {
  readonly own?: AggregateContribution;
  readonly children: AggregateIndex<string, ParentValue>;
  readonly direct: { readonly live: number; readonly finished: number; readonly states: ChildCounts['states'] };
  readonly belowActive: number; readonly belowRunning: number; readonly belowWorking: number;
  readonly childLive: number; readonly childHome: number;
  readonly belowUsage: Usage; readonly childMoved: AggregateIndex<Order, string>;
}
function emptyNode(): Node {
  return { children: keyedIndex<ParentValue>(), direct: { live: 0, finished: 0, states: states() }, belowActive: 0, belowRunning: 0, belowWorking: 0,
    childLive: 0, childHome: 0, belowUsage: emptyUsage(), childMoved: orderIndex(), runs: runIndex(), active: 0, running: 0, working: 0,
    live: 0, homeWork: false, usage: emptyUsage(), moved: 0 };
}
const moveKey = (id: string, at: number): Order => ({ id, at, section: 0 });
function recalculate(node: Node): Node {
  const own = node.own, active = own?.lifecycle === 'active';
  return { ...node, active: active ? 1 + node.belowActive : 0,
    running: active ? Number(own.running) + node.belowRunning : 0,
    working: active ? Number(own.working) + node.belowWorking : 0,
    live: Number(active && !isFinished(own.state)) + node.childLive,
    homeWork: !!own && active && own.kind === 'task' && (own.homeWorking || node.childHome > 0),
    usage: addUsage(node.belowUsage, ownUsage(own), 1), moved: Math.max(own?.movedAt ?? 0, node.childMoved.first()?.[0].at ?? -Infinity) };
}
function replaceOwn(node: Node, own: AggregateContribution | undefined): Node {
  let runs = node.runs;
  for (const [id, at] of node.own?.openRuns ?? []) runs = addRun(runs, { id, at }, -1);
  for (const [id, at] of own?.openRuns ?? []) runs = addRun(runs, { id, at }, 1);
  return { ...node, own, runs };
}
function replaceChild(node: Node, id: string, child: Node | undefined): Node {
  const before = node.children.get(id);
  if (before === child) return node;
  let { belowActive, belowRunning, belowWorking, childLive, childHome, belowUsage, childMoved, runs } = node;
  const direct = { ...node.direct, states: { ...node.direct.states } };
  for (const [value, sign] of [[before, -1], [child, 1]] as const) {
    if (!value) continue;
    if (value.own?.lifecycle === 'active') {
      direct[isFinished(value.own.state) ? 'finished' : 'live'] += sign;
      direct.states[value.own.state] += sign;
    }
    belowActive += sign * value.active; belowRunning += sign * value.running; belowWorking += sign * value.working;
    childLive += sign * value.live; childHome += sign * Number(value.homeWork); belowUsage = addUsage(belowUsage, value.usage, sign);
    childMoved = sign < 0 ? childMoved.delete(moveKey(id, value.moved)) : childMoved.set(moveKey(id, value.moved), id);
  }
  (before?.runs ?? runIndex()).changes(child?.runs ?? runIndex(), (key, before, after) => { runs = addRun(runs, key, (after ?? 0) - (before ?? 0)); });
  return { ...node, children: child ? node.children.set(id, {
    own: child.own && { lifecycle: child.own.lifecycle, state: child.own.state }, active: child.active, running: child.running, working: child.working,
    live: child.live, homeWork: child.homeWork, usage: child.usage, moved: child.moved, runs: child.runs,
  }) : node.children.delete(id), direct,
    belowActive, belowRunning, belowWorking, childLive, childHome, belowUsage, childMoved, runs };
}
/** Only fields a parent consumes; changed descendant caches alone do not propagate. */
function sameParentValue(a: ParentValue, b: ParentValue): boolean {
  return a.own?.lifecycle === b.own?.lifecycle && a.own?.state === b.own?.state && a.active === b.active && a.running === b.running
    && a.working === b.working && a.live === b.live && a.homeWork === b.homeWork && a.moved === b.moved
    && JSON.stringify(a.usage) === JSON.stringify(b.usage) && sameRuns(a.runs, b.runs);
}
function sameRuns(a: Node['runs'], b: Node['runs']): boolean {
  let same = true; a.changes(b, () => { same = false; }); return same;
}
interface Membership { readonly home?: Home; readonly position: HomeSection | null; readonly order?: Order; readonly pages: readonly string[]; readonly pageOrder: Order; readonly scopes: readonly string[];
  readonly task: boolean; readonly running: boolean; readonly fresh: boolean; readonly closed: 'finished' | 'shelved' | null;
  /** Whether a doing row (its own or one above) lists its work: what the working Tasks below it read; not a shown value. */
  readonly listsWork: boolean }
interface ScopeCounts { readonly home: Counts['home'][string]; readonly tasks: number; readonly running: number; readonly closed: Counts['closed'][string] }

const countedSections = ['doing', 'error', 'review', 'awaited', 'held', 'todo'] as const;
function countContribution(member: Membership): readonly number[] {
  return [...countedSections.map(section => Number(member.home?.section === section)), Number(member.task), Number(member.running),
    Number(member.closed === 'finished' && member.home?.section === 'done'),
    Number(member.closed === 'finished' && member.home?.section === 'done' && member.fresh), Number(member.closed === 'shelved')];
}
function scopeCounts(totals?: AggregateTotals): ScopeCounts {
  const n = totals?.total ?? [];
  return { home: Object.fromEntries(countedSections.map((section, i) => [section, n[i] ?? 0])) as ScopeCounts['home'],
    tasks: n[6] ?? 0, running: n[7] ?? 0, closed: { finished: n[8] ?? 0, freshFinished: n[9] ?? 0, shelved: n[10] ?? 0 } };
}

/** Additional reads used to publish project-menu counts and to audit one Task without materializing every count. */
export interface AggregateSnapshot extends ScreenAggregate {
  menu(scope: string): ControlIndexDTO['counts']['all'];
  scopeCounts(scope: string): Readonly<ScopeCounts>;
  pageAfter(scope: string, task: TaskId): TaskId | null | undefined;
  childCounts(task: TaskId): { live: number; finished: number };
  pageScopes(task: TaskId): readonly string[];
  homeIds(): Iterable<TaskId>;
  taskIds(): Iterable<TaskId>;
}
class Frame implements AggregateSnapshot {
  constructor(readonly nodes = keyedIndex<Node>(), readonly facts = keyedIndex<AggregateFacts>(), readonly members = keyedIndex<Membership>(),
    readonly homeOrder = orderIndex(), readonly pages = keyedIndex<AggregateIndex<Order, string>>(), readonly scopes = keyedIndex<AggregateTotals>().set('root', new AggregateTotals())) {}
  children(task: string): ChildCounts | undefined {
    const n = this.nodes.get(task); if (!n || !n.direct.live && !n.direct.finished) return undefined;
    return { ...n.direct, states: { ...n.direct.states }, below: n.belowActive, runningBelow: n.belowRunning };
  }
  childCounts(task: string): { live: number; finished: number } { const n = this.nodes.get(task); return { live: n?.direct.live ?? 0, finished: n?.direct.finished ?? 0 }; }
  movedAt(task: string): number { return this.nodes.get(task)?.moved ?? 0; }
  usageBelow(task: string): UsageTotal { return publicUsage(this.nodes.get(task)?.belowUsage ?? emptyUsage()); }
  runsBelow(task: string): readonly (readonly [string, number])[] {
    const n = this.nodes.get(task); if (!n) return [];
    const own = new Set(n.own?.openRuns.map(([id]) => id)); return [...n.runs.entries()].filter(([key]) => !own.has(key.id)).map(([key]) => [key.id, key.at] as const);
  }
  runningRuns(task: string): number { return this.nodes.get(task)?.runs.size ?? 0; }
  workingBelow(task: string): number { return this.nodes.get(task)?.belowWorking ?? 0; }
  live(task: string): boolean { const n = this.nodes.get(task); return !!n?.own && n.live > 0; }
  position(task: string): HomeSection | null { return this.members.get(task)?.position ?? null; }
  home(task: string): Home | undefined { const row = this.members.get(task)?.home; return row && { ...row, summary: { ...row.summary } }; }
  homeAfter(task: string): string | null | undefined {
    const key = this.members.get(task)?.order;
    return key && this.homeOrder.get(key) === task ? this.homeOrder.neighbor(key, 'before')?.[1] ?? null : undefined;
  }
  page(scope: string): readonly string[] { return [...this.pages.get(scope)?.entries() ?? []].map(([, id]) => id); }
  pageAfter(scope: string, task: string): string | null | undefined {
    const member = this.members.get(task), page = this.pages.get(scope);
    return member && page?.get(member.pageOrder) === task ? page.neighbor(member.pageOrder, 'before')?.[1] ?? null : undefined;
  }
  pageScopes(task: string): readonly string[] { return [...this.members.get(task)?.pages ?? []]; }
  *homeIds(): IterableIterator<string> { for (const [, id] of this.homeOrder.entries()) yield id; }
  *taskIds(): IterableIterator<string> { for (const [id, n] of this.nodes.entries()) if (n.own) yield id; }
  menu(scope: string): Counts['all'] { const n = scopeCounts(this.scopes.get(scope)); return { turn: n.home.review, running: n.running }; }
  scopeCounts(scope: string): Readonly<ScopeCounts> { return scopeCounts(this.scopes.get(scope)); }
  counts(): Counts {
    const entries = [...this.scopes.entries()].map(([id, value]) => [id, scopeCounts(value)] as const);
    return { home: Object.fromEntries(entries.map(([id, n]) => [id, { ...n.home }])), tasks: Object.fromEntries(entries.map(([id, n]) => [id, n.tasks])),
      closed: Object.fromEntries(entries.map(([id, n]) => [id, { ...n.closed }])), all: this.menu('root') };
  }
}
function asFrame(previous: ScreenAggregate): Frame {
  if (!(previous instanceof Frame)) throw new Error('Aggregate updates require a snapshot created by createScreenAggregate');
  return previous;
}
type HomeOwn = Pick<AggregateContribution, 'id' | 'parentId' | 'kind' | 'lifecycle' | 'state' | 'baseState' | 'hold' | 'ball'>;
/** An ancestor as a home row reads it; `working` is whether work runs on it or below it. */
export type HomeAncestor = Pick<AggregateContribution, 'id' | 'kind' | 'lifecycle' | 'baseState' | 'hold'> &
  { readonly ball?: AggregateContribution['ball']; readonly working: boolean };
/**
 * A Task's home row, the home list's own rule (projectHome) over the Task and its ancestors, nearest first, up to and
 * including the first that is not an active Task (which makes the Task below it a top one); `working` is whether work
 * runs on the Task or below it. The ancestors' sections say whether a row above already lists that work.
 */
export function homeRowOf(own: HomeOwn, ancestors: readonly HomeAncestor[], working: boolean,
  summary: Home['summary'] = { done: 0, total: 0 }): Home | undefined {
  return homePlaceOf(own, ancestors, working, summary).row;
}
/** homeRowOf with the Task's position and whether a doing row (its own or one above) lists its work, which the Tasks below it read. */
function homePlaceOf(own: HomeOwn, ancestors: readonly HomeAncestor[], working: boolean,
  summary: Home['summary']): { row: Home | undefined; position: HomeSection | null; listsWork: boolean } {
  const chain = ancestors.map((ancestor, at) => ({ ...ancestor, parentId: ancestors[at + 1]?.id ?? null, summary: { done: 0, total: 0 } }));
  const balls = Object.fromEntries([own, ...chain].flatMap(task => task.ball ? [[task.id, task.ball]] : []));
  const work = new Set([...(working ? [own.id] : []), ...chain.filter(ancestor => ancestor.working).map(ancestor => ancestor.id)]);
  const placed = placeHome([...chain, { ...own, summary }], balls, work).find(each => each.taskId === own.id);
  return { row: placed?.row ?? undefined, position: placed?.position ?? null, listsWork: placed?.listsWork ?? false };
}
/** A Task's ancestors as homeRowOf reads them, from the aggregate's nodes. */
function ancestorsOf(nodes: Frame['nodes'], own: AggregateContribution): HomeAncestor[] {
  const out: HomeAncestor[] = [];
  for (let id = own.parentId; id !== null;) {
    const node = nodes.get(id), above = node?.own;
    if (!above) break;
    out.push({ id: above.id, kind: above.kind, lifecycle: above.lifecycle, baseState: above.baseState, hold: above.hold,
      ball: above.ball, working: node.homeWork });
    if (above.kind !== 'task' || above.lifecycle !== 'active') break;
    id = above.parentId;
  }
  return out;
}
/**
 * The closed pages that list a Task: a finished one on its parent Task's page (not its project's, which is the top
 * level's), and one the home list lists as done or a shelved one on the top level's page of every scope it is counted
 * in. The aggregate's membership and the scopes `affected` raises both ask here.
 */
export function closedPagesOf(own: Pick<AggregateContribution, 'lifecycle' | 'state' | 'parentId' | 'projectId'>,
  homeSection: Home['section'] | undefined, scopes: readonly string[]): string[] {
  const closed = own.lifecycle !== 'active' ? 'shelved' : isFinished(own.state) ? 'finished' : null;
  if (!closed) return [];
  return [...(closed === 'finished' && own.parentId !== null && own.parentId !== own.projectId ? [closedPageScope(closed, own.parentId, null)] : []),
    ...(closed === 'shelved' || homeSection === 'done' ? scopes.map(scope => closedPageScope(closed, null, scope === 'root' ? null : scope)) : [])];
}
function membership(frame: Frame, id: string): Membership | undefined {
  const node = frame.nodes.get(id), own = node?.own; if (!own) return undefined;
  // A node already holds the result of propagating work through its children.
  const { row: home, position, listsWork } = homePlaceOf(own, ancestorsOf(frame.nodes, own), node.homeWork,
    { done: node.direct.states.done, total: node.direct.live + node.direct.states.done });
  const facts = frame.facts.get(id);
  // Explicit scopes are authoritative (including shelves and unlisted project boundaries).
  const scopes = [...new Set(facts?.scopes ?? defaultScopes(frame, own.projectId))];
  const closed = own.lifecycle !== 'active' ? 'shelved' : isFinished(own.state) ? 'finished' : null;
  const pages = closedPagesOf(own, home?.section, scopes);
  const ordered = home && home.section !== 'done' && (facts?.listed ?? true);
  return { home, position, order: ordered ? { id, at: node.moved, section: HOME_SECTIONS.indexOf(home.section) } : undefined,
    pages, pageOrder: moveKey(id, node.moved), scopes, task: own.kind === 'task', running: facts?.menuRunning ?? own.openRuns.length > 0,
    fresh: facts?.freshFinished ?? false, closed, listsWork };
}
function defaultScopes(frame: Frame, project: string): string[] {
  const chain: string[] = [], seen = new Set<string>(); let node = frame.nodes.get(project)?.own;
  while (node) {
    if (seen.has(node.id)) throw new Error(`Cyclic aggregate tree: ${node.id}`); seen.add(node.id);
    if (node.kind === 'project') { if (node.lifecycle !== 'active') break; chain.unshift(node.id); }
    node = node.parentId === null ? undefined : frame.nodes.get(node.parentId)?.own;
  }
  return ['root', ...chain];
}

/** Build at startup or resynchronization. Incremental updates use aggregate instead. */
export function createScreenAggregate(contributions: Iterable<AggregateContribution>, facts: ReadonlyMap<TaskId, AggregateFacts> = new Map()): AggregateSnapshot {
  const changes = new Map<string, Change>();
  for (const value of contributions) {
    if (changes.has(value.id)) throw new Error(`Duplicate aggregate contribution: ${value.id}`);
    changes.set(value.id, { before: undefined, after: value });
  }
  return updateScreenAggregate(new Frame(), changes, facts).next;
}
/** The contract's update function. Extra personal/scope facts can be updated through updateScreenAggregate. */
export const aggregate: AggregateUpdate = (previous, changes) => updateScreenAggregate(previous, changes);
export function updateScreenAggregate(previous: ScreenAggregate, changes: ReadonlyMap<TaskId, Change>,
  factChanges: ReadonlyMap<TaskId, AggregateFacts | undefined> = new Map()): { next: AggregateSnapshot; changed: AggregateChanges } {
  return update(asFrame(previous), changes, factChanges, []);
}
/** Repair is deliberately a rebuild, even when the current contribution equals the stored one. Call after deriving
 * fresh contributions in the current catch-up; repairs are never applied to an older published frame. */
export function repairScreenAggregate(previous: ScreenAggregate, repairs: readonly AggregateRepair[],
  changes: ReadonlyMap<TaskId, Change> = new Map(), factChanges: ReadonlyMap<TaskId, AggregateFacts | undefined> = new Map()):
  { next: AggregateSnapshot; changed: AggregateChanges } {
  return update(asFrame(previous), changes, factChanges, repairs);
}
function update(previous: Frame, changes: ReadonlyMap<string, Change>, factChanges: ReadonlyMap<string, AggregateFacts | undefined>,
  repairs: readonly AggregateRepair[]): { next: Frame; changed: AggregateChanges } {
  let nodes = previous.nodes, facts = previous.facts;
  const candidates = new Set<string>(), changedTasks = new Set<string>(), changedPages = new Set<string>();
  const forced = new Set<string>();
  let pending = new AggregateIndex<{ id: string; depth: number }, string>((a, b) => b.depth - a.depth || byTaskNumber(a, b));
  const queued = new Map<string, { id: string; depth: number }>();
  for (const [id, change] of changes) {
    if (change.after && change.after.id !== id) throw new Error(`Aggregate contribution ID differs from its key: ${id}`);
    nodes = nodes.set(id, replaceOwn(nodes.get(id) ?? emptyNode(), change.after)); candidates.add(id);
  }
  const depth = (id: string): number => {
    const seen = new Set<string>(); let cursor: string | null = id, n = 0;
    while (cursor !== null) {
      if (seen.has(cursor)) throw new Error(`Cyclic aggregate tree: ${cursor}`); seen.add(cursor); n++;
      cursor = nodes.get(cursor)?.own?.parentId ?? null;
    }
    return n;
  };
  const schedule = (id: string) => {
    if (queued.has(id)) return;
    const key = { id, depth: depth(id) }; queued.set(id, key); pending = pending.set(key, id);
  };
  // Reparenting removes the whole old subtree contribution before installing its new parent edge.
  for (const [id, change] of changes) {
    const old = previous.nodes.get(id)?.own;
    if (old?.parentId && old.parentId !== change.after?.parentId) {
      nodes = nodes.set(old.parentId, replaceChild(nodes.get(old.parentId) ?? emptyNode(), id, undefined)); schedule(old.parentId);
    }
    schedule(id);
    // A parent's kind/lifecycle affects its children's top-level home status, independent of totals.
    if (old?.kind !== change.after?.kind || old?.lifecycle !== change.after?.lifecycle)
      for (const [child] of nodes.get(id)?.children.entries() ?? []) candidates.add(child);
    // Moving a subtree can change the ancestry of projects nested anywhere within it.
    if (old?.parentId !== change.after?.parentId ||
      ((old?.kind === 'project' || change.after?.kind === 'project') && (old?.lifecycle !== change.after?.lifecycle || old?.kind !== change.after?.kind))) {
      const stack = [id];
      while (stack.length) { const task = stack.pop()!; candidates.add(task); for (const [child] of nodes.get(task)?.children.entries() ?? []) stack.push(child); }
    }
  }
  for (const [id, value] of factChanges) { facts = value ? facts.set(id, { ...value, scopes: [...value.scopes] }) : facts.delete(id); candidates.add(id); }
  for (const repair of repairs) {
    // The kind is intentionally retained at this boundary: an order-only mismatch must schedule work too.
    if (!['aggregate', 'membership', 'order'].includes(repair.kind)) throw new Error(`Unknown aggregate repair kind: ${repair.kind}`);
    let id: string | null = repair.task;
    const seen = new Set<string>();
    while (id !== null) {
      if (seen.has(id)) throw new Error(`Cyclic aggregate tree: ${id}`); seen.add(id);
      forced.add(id); candidates.add(id); schedule(id); id = nodes.get(id)?.own?.parentId ?? null;
    }
  }
  while (pending.size) {
    const [key, id] = pending.first()!; pending = pending.delete(key); queued.delete(id);
    let node = nodes.get(id) ?? emptyNode();
    if (forced.has(id)) {
      const own = node.own, children = node.children;
      node = replaceOwn(emptyNode(), own);
      for (const [child] of children.entries()) {
        const current = nodes.get(child);
        if (current?.own?.parentId === id) node = replaceChild(node, child, current);
      }
    }
    node = recalculate(node); nodes = nodes.set(id, node); candidates.add(id);
    const parent = node.own?.parentId;
    if (parent !== null && parent !== undefined) {
      const current = nodes.get(parent) ?? emptyNode(), old = current.children.get(id);
      if (!old || !sameParentValue(old, node)) { nodes = nodes.set(parent, replaceChild(current, id, node)); schedule(parent); }
    }
  }
  let frame = new Frame(nodes, facts, previous.members, previous.homeOrder, previous.pages, previous.scopes);
  let members = frame.members, homeOrder = frame.homeOrder, pages = frame.pages, scopes = frame.scopes;
  let countsChanged = false;
  const applyCount = (id: string, member: Membership, remove: boolean) => {
    for (const scope of member.scopes) scopes = scopes.set(scope, (scopes.get(scope) ?? new AggregateTotals()).set(id, remove ? undefined : countContribution(member)));
  };
  for (const id of candidates) {
    const old = previous.members.get(id), next = membership(frame, id), repair = forced.has(id);
    // A working child's row reads whether a row above lists its work; only a change to that reaches the children (the
    // Set's iteration visits them), and work propagates upward, so the ones it reaches are the working children.
    if ((old?.listsWork ?? false) !== (next?.listsWork ?? false))
      for (const [child] of nodes.get(id)?.children.entries() ?? []) if (nodes.get(child)?.homeWork) candidates.add(child);
    const beforeNode = previous.nodes.get(id), afterNode = nodes.get(id);
    if (repair || JSON.stringify(old && { ...old, listsWork: null }) !== JSON.stringify(next && { ...next, listsWork: null }) || !beforeNode || !afterNode || !sameParentValue(beforeNode, afterNode)
      || JSON.stringify(beforeNode.own?.openRuns) !== JSON.stringify(afterNode.own?.openRuns)
      || beforeNode.belowWorking !== afterNode.belowWorking || beforeNode.belowActive !== afterNode.belowActive
      || beforeNode.belowRunning !== afterNode.belowRunning || JSON.stringify(beforeNode.direct) !== JSON.stringify(afterNode.direct)
      || JSON.stringify(beforeNode.belowUsage) !== JSON.stringify(afterNode.belowUsage)) changedTasks.add(id);
    // A descendant can change the order predecessor of a row whose own content is identical.
    const reordered = JSON.stringify(old?.order) !== JSON.stringify(next?.order);
    const beforeSuccessor = reordered && old?.order ? homeOrder.neighbor(old.order, 'after')?.[1] : undefined;
    if (old?.order) homeOrder = homeOrder.delete(old.order);
    if (next?.order) homeOrder = homeOrder.set(next.order, id);
    if (beforeSuccessor) changedTasks.add(beforeSuccessor);
    if (reordered && next?.order) { const afterSuccessor = homeOrder.neighbor(next.order, 'after')?.[1]; if (afterSuccessor) changedTasks.add(afterSuccessor); }
    for (const scope of old?.pages ?? []) {
      const page = pages.get(scope) ?? orderIndex();
      const key = old!.pageOrder;
      const nextPage = page.delete(key); pages = nextPage.size ? pages.set(scope, nextPage) : pages.delete(scope);
      if (changedTasks.has(id)) changedPages.add(scope);
    }
    for (const scope of next?.pages ?? []) {
      pages = pages.set(scope, (pages.get(scope) ?? orderIndex()).set(moveKey(id, nodes.get(id)?.moved ?? 0), id));
      if (changedTasks.has(id)) changedPages.add(scope);
    }
    if (old) applyCount(id, old, true);
    if (next) { applyCount(id, next, false); members = members.set(id, next); } else { members = members.delete(id); facts = facts.delete(id); }
  }
  // Empty listed projects still have count entries. Removed/unlisted projects have none.
  for (const [id, change] of changes) {
    if (change.after?.kind === 'project' && change.after.lifecycle === 'active' && !scopes.get(id)) scopes = scopes.set(id, new AggregateTotals());
    if (change.before?.kind === 'project' && (change.after?.kind !== 'project' || change.after.lifecycle !== 'active')) scopes = scopes.delete(id);
  }
  previous.scopes.changes(scopes, (_, before, after) => { if (JSON.stringify(before?.total) !== JSON.stringify(after?.total)) countsChanged = true; });
  frame = new Frame(nodes, facts, members, homeOrder, pages, scopes);
  return { next: frame, changed: { tasks: changedTasks, pages: changedPages, counts: countsChanged } };
}
