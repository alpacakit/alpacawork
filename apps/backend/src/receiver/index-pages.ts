/** Pages, scoped search and timeline reads from a published frame. */
import { valuesText, historyEventKey, joinBusy, reportDisplay, reportMark, runSpan, timeMarkAt, timelineLogOf,
  timelineNoteOf, timelinePlacementOf, timelineRunOf, type LayoutRecord, type TaskValues } from '@alpacawork/contract';
import { isFinished } from '@alpacawork/contract/branch';
import { closedPageScope, finishedBy, standingRecord, type ControlRunDTO, type PlacementDTO, type TaskPageRowDTO, type TaskTimelineAxisDTO,
  type TaskProjectedPageDTO, type TaskProjectedSearchDTO, type TaskTimelineLaneDTO, type TaskTimelineLanesDTO, type TaskProjectedTimelineAxisDTO,
  type ProjectionResourceKind, type ProjectionVersion, type ControlTreeDTO, type TaskRowDTO } from '@alpacawork/contract/control';
import { byMoved } from '@alpacawork/contract/moved';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { lineWithText, matchesTaskText } from '../control/task-views.js';
import { current, lanesAbove as lanesAboveFor, pageRow, recordEvents, recordedEvents,
  type ChildCounts, type Kept } from './task-reads.js';
import { controlTaskView } from '../control/task-dto.js';
import type { PublishedFrame } from './projection-contract.js';
import { aggregateRowFacts } from './row-facts.js';

/** The common inputs of search and time rendering; a published reader supplies only its scope's records. */
type PageReadState = {
  generation: string;
  rev: number;
  children: Record<string, ChildCounts>;
  pageMoved: ReadonlyMap<string, number>;
  runs: Kept<ControlRunDTO>;
  placements: Kept<PlacementDTO>;
  axisPrepared: Map<string, TaskTimelineAxisDTO>;
  tree?: { tasks: ControlTreeDTO['tasks'] };
  rows: ReadonlyMap<string, { value: TaskRowDTO }>;
  resourceVersion: string;
  historyEvents: (id: string, fromChild: boolean) => ReturnType<typeof recordEvents>;
};
const eventsFor = (state: PageReadState, task: ControlTreeDTO['tasks'][number], fromChild: boolean) =>
  state.historyEvents(task.id, fromChild);

/** An opaque page cursor's encoding. What it must hold, and the reason each reader refuses it, stay with that reader. */
const writeCursor = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

function readCursor(after: string, invalid: () => Problem): Record<string, unknown> {
  let cursor: unknown;
  try { cursor = JSON.parse(Buffer.from(after, 'base64url').toString('utf8')); }
  catch { throw invalid(); }
  if (!cursor || typeof cursor !== 'object') throw invalid();
  return cursor as Record<string, unknown>;
}

const invalidPageCursor = () => new Problem(PROBLEM_CODE.invalidInput, 'Invalid page cursor', undefined, { reason: { kind: 'invalid_page_cursor' } });

const invalidSearchCursor = () => new Problem(PROBLEM_CODE.invalidInput, 'Invalid search cursor', undefined, { reason: { kind: 'invalid_search_cursor' } });

/** The axis's lanes: the requested rows and, below a folded one, the Tasks drawn in it. */
function axisLanes(state: PageReadState, input: { scope: string; visible: string; folded: string }) {
  const requested = (text: string) => text ? text.split(',').filter(Boolean) : [];
  const visible = requested(input.visible), folded = requested(input.folded);
  if (visible.length > 200 || folded.some(id => !visible.includes(id)) || visible.some(id => !state.rows.has(id)) || folded.some(id => !state.rows.has(id)))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid visible Task IDs', undefined, { reason: { kind: 'invalid_visible_task_ids' } });
  const scopeId = input.scope === 'root' ? null : input.scope;
  if (scopeId && !state.rows.has(scopeId)) throw new Problem(PROBLEM_CODE.notFound, 'Scope Task does not exist', undefined, { reason: { kind: 'scope_task_does_not_exist' } });
  const underScope = (id: string) => {
    if (!scopeId) return true;
    let parent: string | null = id;
    while (parent) {
      if (parent === scopeId) return true;
      parent = state.rows.get(parent)?.value.parentId ?? null;
    }
    return false;
  };
  if ([...visible, ...folded].some(id => !underScope(id)))
    throw new Problem(PROBLEM_CODE.invalidInput, 'Task is outside scope', undefined, { reason: { kind: 'task_outside_scope' } });
  const own = new Set(visible), candidates = new Set(visible);
  for (const row of state.rows.values()) {
    let parent = row.value.parentId;
    while (parent) {
      if (folded.includes(parent)) { candidates.add(row.value.id); break; }
      parent = state.rows.get(parent)?.value.parentId ?? null;
    }
  }
  return { own, candidates };
}


export function timelineAxis(state: PageReadState, input: { scope: string; lanes: string; folded: string }): TaskTimelineAxisDTO {
  const { own, candidates } = axisLanes(state, { ...input, visible: input.lanes });
  const key = JSON.stringify([state.rev, input.scope, [...own].sort(), input.folded]);
  const cached = state.axisPrepared.get(key);
  if (cached) return cached;
  const spans: [number, number | null][] = [];
  let earliest = Number.POSITIVE_INFINITY;
  const tree = current(state);
  for (const task of tree.tasks) {
    if (!candidates.has(task.id)) continue;
    const logs = new Map(task.log.map(log => [log.id, log]));
    const standing = standingRecord({ state: task.state, stateLog: task.log, ball: state.rows.get(task.id)?.value.ball ?? null });
    for (const log of task.log) earliest = Math.min(earliest, Date.parse(log.causeAt ?? log.at));
    for (const event of eventsFor(state, task, !own.has(task.id))) {
      const at = Date.parse(timeMarkAt(event, logs));
      earliest = Math.min(earliest, at);
      if (standing(event.id)) spans.push([at, at]);
    }
  }
  const lanesAbove = lanesAboveFor(state, own);
  for (const { value: run } of state.runs.values()) {
    const span = runSpan(run, null);
    if (candidates.has(run.taskId)) earliest = Math.min(earliest, Date.parse(run.createdAt));
    else if (!span || !lanesAbove(run.taskId).length) continue;
    else earliest = Math.min(earliest, span.from);
    if (span) spans.push([span.from, span.to]);
  }
  const busy = joinBusy(spans);
  const result = { busy, earliest: Number.isFinite(earliest) ? earliest : null,
    version: state.resourceVersion };
  state.axisPrepared.set(key, result);
  if (state.axisPrepared.size > 16) state.axisPrepared.delete(state.axisPrepared.keys().next().value!);
  return result;
}

type TimelineEvent = TaskTimelineLaneDTO['events'][number];
type TimelineLane = Omit<TaskTimelineLaneDTO, 'row' | 'generation' | 'sourcePv'>;
/**
 * Each requested row's strip over [from, to], made from that row's own subtree alone (its History events, log entries,
 * Runs and placements, and the ended Runs below it), so a row's strip changes only with what changes in its subtree.
 */
export function timelineLanes(state: PageReadState, lanes: readonly string[], from: number, to: number): Map<string, TimelineLane> {
  const tasks = new Map(current(state).tasks.map(task => [task.id, task]));
  const result = new Map<string, TimelineLane & { stamped: { at: number; id: string; value: TimelineEvent }[] }>();
  for (const id of lanes) {
    const row = state.rows.get(id)?.value, task = tasks.get(id);
    if (!row || !task) continue;
    const prior = [...row.stateLog].reverse().find(log => log.toState !== null && Date.parse(log.at) < from);
    const stamped: { at: number; id: string; value: TimelineEvent }[] = [];
    // The notes are the Task's History events; a note made from a log entry comes with that entry.
    const logs = new Map(task.log.map(log => [log.id, log]));
    const notes = eventsFor(state, task, false).map(event => ({ ...event, at: timeMarkAt(event, logs) })).filter(event => {
      const at = Date.parse(event.at);
      return at >= from && at <= to;
    });
    const finishing = finishedBy({ state: task.state, stateLog: task.log })?.id;
    // Layout links remain in detail History. The list receives only the shared rule's compact decision.
    const shown = new Set([...reportDisplay(notes.map(event => ({ ...event, key: historyEventKey(event), text: event.title,
      description: event.summary || null, mark: event.by ? null : reportMark(event), wroteIn: event.runId,
      ...(event.fromChild ? { sourceTaskId: event.taskId } : {}), pinned: event.open === true, finish: event.id === finishing,
      ...(event.by && event.state ? { changed: event.state } : {}) }))).targets].filter(([key, target]) => key === target).map(([key]) => key));
    for (const event of notes) {
      const note = timelineNoteOf(event);
      if (!shown.has(historyEventKey(event))) note.displayed = false;
      stamped.push({ at: Date.parse(event.at), id: `${id}:note:${event.kind}:${event.id}`, value: { kind: 'note', taskId: id, event: note } });
    }
    for (const entry of row.stateLog) {
      const at = Date.parse(entry.causeAt ?? entry.at);
      if (at >= from && at <= to) stamped.push({ at, id: `${id}:log:${entry.id}`, value: { kind: 'log', taskId: id, entry: timelineLogOf(entry) } });
    }
    result.set(id, { lane: id, anchor: prior && !isFinished(prior.toState) ? timelineLogOf(prior) : null, events: [], belowRuns: [], placements: [], stamped });
  }
  const lanesAbove = lanesAboveFor(state, new Set(result.keys()));
  for (const { value: run } of state.runs.values()) {
    const own = result.get(run.taskId);
    const created = Date.parse(run.createdAt), started = run.startedAt ? Date.parse(run.startedAt) : created;
    const ended = run.endedAt ? Date.parse(run.endedAt) : Number.POSITIVE_INFINITY;
    if (own && (created >= from && created <= to || started <= to && ended >= from))
      own.stamped.push({ at: Math.max(from, Math.min(started, to)), id: `${run.taskId}:run:${run.id}`,
        value: { kind: 'run', taskId: run.taskId, run: timelineRunOf(run) } });
    const span = runSpan(run, null);
    if (!span || span.to === null || span.from > to || span.to < from) continue;
    for (const lane of lanesAbove(run.taskId)) result.get(lane)!.belowRuns.push([run.id, span.from, span.to]);
  }
  for (const lane of result.values()) {
    lane.events = lane.stamped.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map(item => item.value);
    const placementIds = new Set(lane.events.flatMap(event => event.kind === 'run' ? [event.run.placementId] : []));
    lane.placements = [...state.placements.values()].map(item => item.value).filter(item => placementIds.has(item.id)).map(item => timelinePlacementOf(item));
  }
  return new Map([...result].map(([id, { stamped: _stamped, ...lane }]) => [id, lane]));
}

/** The aggregate is the sole owner of descendant facts; both closed pages and time/search rows add them here. */
function projectedRow(frame: PublishedFrame, id: string): TaskRowDTO {
  const derived = frame.derived(id);
  if (!derived) throw new Error(`Published Task has no derived row: ${id}`);
  return { ...derived.row,
    movedAt: frame.aggregate.movedAt(id), usageBelow: frame.aggregate.usageBelow(id), runsBelow: frame.aggregate.runsBelow(id).map(([run, at]) => [run, at]),
    rowFacts: aggregateRowFacts(derived, frame.aggregate) };
}
function projectedPageRow(frame: PublishedFrame, id: string): TaskPageRowDTO {
  const children = frame.aggregate.children(id);
  return pageRow({ children: children ? { [id]: children } : {} }, projectedRow(frame, id), new Map([[id, frame.aggregate.movedAt(id)]]));
}

/** Opaque pagination positions carry the resource's required version, never a digest of the whole result. */
const resourceVersion = (frame: PublishedFrame, kind: ProjectionResourceKind, scope: string) =>
  `${frame.generation}:${frame.requiredPv[kind][scope] ?? 0}`;
/** What is read from rows (a strip, the axis) is as new as the newest of their versions. */
const lanesRev = (frame: PublishedFrame, lanes: readonly string[]) => Math.max(0, ...lanes.map(id => frame.requiredPv.timeline[id] ?? 0));
const lanesVersion = (frame: PublishedFrame, lanes: readonly string[]) => `${frame.generation}:${lanesRev(frame, lanes)}`;
const invalidLanes = () => new Problem(PROBLEM_CODE.invalidInput, 'Invalid visible Task IDs', undefined, { reason: { kind: 'invalid_visible_task_ids' } });

/** Server-prepared time and search resources expire only when their rows' or scope's requiredPv changes. */
export class ProjectedPages {
  private generation: string | undefined;
  private readonly prepared = new Map<string, { lanes: string[]; version: string; sourcePv: ProjectionVersion; state: PageReadState }>();
  private readonly lanes = new Map<string, { lane: string; version: string; value: TaskTimelineLaneDTO }>();
  private readonly searches = new Map<string, { scope: string; version: string; sourcePv: ProjectionVersion; ids: string[] }>();

  private invalidate(frame: PublishedFrame): void {
    if (this.generation !== frame.generation) {
      this.prepared.clear(); this.lanes.clear(); this.searches.clear(); this.generation = frame.generation;
    }
    for (const [key, cached] of this.prepared)
      if (cached.version !== lanesVersion(frame, cached.lanes)) this.prepared.delete(key);
    for (const [key, cached] of this.lanes)
      if (cached.version !== lanesVersion(frame, [cached.lane])) this.lanes.delete(key);
    for (const [key, cached] of this.searches)
      if (cached.version !== resourceVersion(frame, 'search', cached.scope)) this.searches.delete(key);
  }

  private scope(frame: PublishedFrame, scope: string | null): void {
    if (scope !== null && !frame.records.shelf().listed.has(scope))
      throw new Problem(PROBLEM_CODE.notFound, 'Project does not exist', { task: scope }, { reason: { kind: 'project_does_not_exist' } });
  }

  /** No page-wide rebuilding: the aggregate already holds the order; make only the requested rows. */
  page(frame: PublishedFrame, kind: 'finished' | 'shelved', parent: string | null, scope: string | null, after?: string, limit = 20): TaskProjectedPageDTO {
    this.scope(frame, scope);
    if (parent !== null && !frame.records.bundle(parent))
      throw new Problem(PROBLEM_CODE.notFound, 'Parent Task does not exist', { task: parent }, { reason: { kind: 'parent_task_does_not_exist' } });
    const name = closedPageScope(kind, parent, parent === null ? scope : null);
    const order = frame.aggregate.page(name), version = resourceVersion(frame, 'page', name);
    let start = 0;
    if (after) {
      const cursor = readCursor(after, invalidPageCursor);
      if (typeof cursor.id !== 'string' || cursor.scope !== name || typeof cursor.version !== 'string') throw invalidPageCursor();
      if (cursor.version !== version) throw new Problem(PROBLEM_CODE.conflict, 'Page changed; read from the first page', undefined,
        { reason: { kind: 'page_changed_read_from_first_page' } });
      const position = order.indexOf(cursor.id);
      if (position < 0) throw invalidPageCursor();
      start = position + 1;
    }
    const page = order.slice(start, start + limit);
    return { generation: frame.generation, sourcePv: frame.pv, rows: page.map(id => projectedPageRow(frame, id)),
      total: order.length, nextAfter: page.length && start + page.length < order.length
        ? writeCursor({ scope: name, version, id: page.at(-1)! }) : null };
  }

  finished(frame: PublishedFrame, parent: string | null, scope: string | null, after?: string, limit = 20): TaskProjectedPageDTO {
    return this.page(frame, 'finished', parent, scope, after, limit);
  }

  shelved(frame: PublishedFrame, scope: string | null, after?: string, limit = 20): TaskProjectedPageDTO {
    return this.page(frame, 'shelved', null, scope, after, limit);
  }

  /** The records rows' strips and axis read: the rows' ancestors and subtrees; unrelated branches supply nothing. */
  private readState(frame: PublishedFrame, lanes: readonly string[]): PageReadState {
    const rows = new Map<string, { value: TaskRowDTO; json: string }>();
    const tasks: ControlTreeDTO['tasks'] = [];
    const runs: Kept<ControlRunDTO> = new Map(), placements: Kept<PlacementDTO> = new Map();
    const children: Record<string, ChildCounts> = {}, moved = new Map<string, number>();
    const records = frame.records, shelf = records.shelf();
    const ids = new Set(lanes.flatMap(id => [...records.ancestors(id), ...records.subtree(id)]));
    for (const id of ids) {
      const bundle = records.bundle(id);
      if (!bundle || !shelf.listed.has(records.projectOf(id))) continue;
      const row = projectedRow(frame, id), derived = frame.derived(id)!;
      rows.set(id, { value: row, json: '' });
      tasks.push({ ...controlTaskView(bundle.task), files: [...bundle.files ?? []] });
      for (const run of derived.runs) runs.set(run.id, { value: run, json: '' });
      for (const placement of derived.placements) placements.set(placement.id, { value: placement, json: '' });
      const counts = frame.aggregate.children(id);
      if (counts) children[id] = counts;
      moved.set(id, frame.aggregate.movedAt(id));
    }
    return { generation: frame.generation, rev: lanesRev(frame, lanes), resourceVersion: lanesVersion(frame, lanes),
      tree: { tasks }, rows, children, pageMoved: moved, runs, placements,
      historyEvents: (id, fromChild) => recordedEvents(records, id, fromChild, fromChild ? records.parent(id) ?? id : id),
      axisPrepared: new Map() };
  }

  private prepare(frame: PublishedFrame, scope: string, lanes: { visible: string; folded: string }): { sourcePv: ProjectionVersion; state: PageReadState } {
    this.invalidate(frame);
    const key = JSON.stringify([scope, lanes.visible, lanes.folded]);
    const held = this.prepared.get(key);
    if (held) return held;
    const records = frame.records;
    const visible = lanes.visible.split(',').filter(Boolean), folded = lanes.folded.split(',').filter(Boolean);
    if (visible.length > 200 || folded.some(id => !visible.includes(id)) || visible.some(id => !records.bundle(id))) throw invalidLanes();
    if (scope !== 'root' && !records.bundle(scope))
      throw new Problem(PROBLEM_CODE.notFound, 'Scope Task does not exist', undefined, { reason: { kind: 'scope_task_does_not_exist' } });
    if (scope !== 'root' && visible.some(id => id !== scope && !records.ancestors(id).includes(scope)))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Task is outside scope', undefined, { reason: { kind: 'task_outside_scope' } });
    const prepared = { lanes: visible, version: lanesVersion(frame, visible), sourcePv: frame.pv, state: this.readState(frame, visible) };
    this.prepared.set(key, prepared);
    if (this.prepared.size > 16) this.prepared.delete(this.prepared.keys().next().value!);
    return prepared;
  }

  /** Search only indexes matching IDs and their order; rows and ancestor facts are made for the returned page. */
  search(frame: PublishedFrame, text: string, scope: string | null, after?: string, limit = 40): TaskProjectedSearchDTO {
    this.scope(frame, scope); this.invalidate(frame);
    const name = scope ?? 'root', key = JSON.stringify([name, text]), records = frame.records;
    let prepared = this.searches.get(key);
    if (!prepared) {
      const moved = new Map<string, number>(), shelf = records.shelf();
      const found: { id: string }[] = [];
      for (const id of scope === null ? records.taskIds() : records.subtree(scope)) {
        const task = records.bundle(id)?.task;
        if (!task || !shelf.listed.has(records.projectOf(id)) ||
          !matchesTaskText(text, [id, task.meta.title, valuesText(task.values as TaskValues)])) continue;
        found.push({ id }); moved.set(id, frame.aggregate.movedAt(id));
      }
      prepared = { scope: name, version: resourceVersion(frame, 'search', name), sourcePv: frame.pv,
        ids: found.sort(byMoved(moved)).map(task => task.id) };
      this.searches.set(key, prepared);
      if (this.searches.size > 16) this.searches.delete(this.searches.keys().next().value!);
    }
    const version = JSON.stringify([prepared.version, text, scope]);
    let start = 0;
    if (after) {
      const cursor = readCursor(after, invalidSearchCursor);
      if (typeof cursor.id !== 'string' || typeof cursor.version !== 'string' || typeof cursor.generation !== 'string') throw invalidSearchCursor();
      if (cursor.generation !== frame.generation || cursor.version !== version)
        throw new Problem(PROBLEM_CODE.conflict, 'Search changed; read from the first page', undefined,
          { reason: { kind: 'search_changed_read_from_first_page' } });
      const position = prepared.ids.indexOf(cursor.id);
      if (position < 0) throw invalidSearchCursor();
      start = position + 1;
    }
    const ids = prepared.ids.slice(start, start + limit), ancestors = new Set(ids.flatMap(id => records.ancestors(id)));
    const lines: Record<string, string> = {};
    for (const id of ids) {
      const task = records.bundle(id)!.task;
      if (!matchesTaskText(text, [id, task.meta.title])) lines[id] = lineWithText(text, task.values as TaskValues);
    }
    return { generation: frame.generation, sourcePv: prepared.sourcePv, rows: ids.map(id => projectedPageRow(frame, id)),
      ancestors: [...ancestors].map(id => projectedPageRow(frame, id)), lines, total: prepared.ids.length,
      nextAfter: ids.length && start + ids.length < prepared.ids.length
        ? writeCursor({ generation: frame.generation, version, id: ids.at(-1)! }) : null };
  }

  timelineAxis(frame: PublishedFrame, input: Parameters<typeof timelineAxis>[1]): TaskProjectedTimelineAxisDTO {
    const prepared = this.prepare(frame, input.scope, { visible: input.lanes, folded: input.folded });
    const { version: _version, ...result } = timelineAxis(prepared.state, input);
    return { ...result, generation: frame.generation, sourcePv: prepared.sourcePv };
  }

  /**
   * Rows' strips over one range, each whole and as new as its own version: a strip already made for its row's current
   * version is not made again. Rows are answered in the order asked until about `limit` events (at least one row).
   */
  timeline(frame: PublishedFrame, input: { lanes: string; from: string; to: string; limit?: number }): TaskTimelineLanesDTO {
    this.invalidate(frame);
    const asked = [...new Set(input.lanes.split(',').filter(Boolean))];
    if (asked.length > 200) throw invalidLanes();
    const records = frame.records, shelf = records.shelf();
    const held = (id: string) => !!records.bundle(id) && shelf.listed.has(records.projectOf(id));
    const from = Date.parse(input.from), to = Date.parse(input.to), key = (id: string) => JSON.stringify([id, from, to]);
    const values = new Map<string, TaskTimelineLaneDTO>();
    for (const id of asked) {
      const cached = held(id) ? this.lanes.get(key(id)) : undefined;
      if (!cached) continue;
      values.set(id, cached.value);
      this.lanes.delete(key(id)); this.lanes.set(key(id), cached);
    }
    const missing = asked.filter(id => held(id) && !values.has(id));
    if (missing.length) for (const [id, lane] of timelineLanes(this.readState(frame, missing), missing, from, to)) {
      const value = { ...lane, row: frame.derived(id)!.row, generation: frame.generation, sourcePv: frame.pv };
      values.set(id, value);
      this.lanes.set(key(id), { lane: id, version: lanesVersion(frame, [id]), value });
    }
    while (this.lanes.size > 512) this.lanes.delete(this.lanes.keys().next().value!);
    const answered: TaskTimelineLaneDTO[] = [], budget = input.limit ?? 2000;
    let events = 0;
    for (const id of asked) {
      const value = values.get(id);
      if (!value) continue;
      if (answered.length && events + value.events.length > budget) break;
      answered.push(value); events += value.events.length;
    }
    return { lanes: answered, gone: asked.filter(id => !values.has(id)) };
  }
}
