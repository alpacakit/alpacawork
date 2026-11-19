/** Pages, scoped search and timeline reads from a published frame. */
import { valuesText, historyEventKey, joinBusy, reportDisplay, reportMark, runSpan, timeMarkAt, timelineLogOf,
  timelineNoteOf, timelinePlacementOf, timelineRunOf, type LayoutRecord, type TaskValues } from '@alpacawork/contract';
import { isFinished } from '@alpacawork/contract/branch';
import { closedPageScope, finishedBy, standingRecord, type ControlRunDTO, type PlacementDTO, type TaskPageRowDTO, type TaskTimelineAxisDTO, type TaskTimelineDTO,
  type TaskProjectedPageDTO, type TaskProjectedSearchDTO, type TaskProjectedTimelineDTO, type TaskProjectedTimelineAxisDTO,
  type ProjectionResourceKind, type ProjectionVersion, type ControlTreeDTO, type TaskRowDTO } from '@alpacawork/contract/control';
import { byMoved } from '@alpacawork/contract/moved';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { lineWithText, matchesTaskText } from '../control/task-views.js';
import { current, lanesAbove as lanesAboveFor, pageRow, recordEvents, recordedEvents,
  type ChildCounts, type Kept, type TimelineStamp } from './task-reads.js';
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
  timelinePrepared: Map<string, { scoped: string; stamped: TimelineStamp[]; anchors: TaskTimelineDTO['anchors'];
    belowRuns: TaskTimelineDTO['belowRuns']; version: string }>;
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

const invalidTimelineCursor = () => new Problem(PROBLEM_CODE.invalidInput, 'Invalid timeline cursor', undefined, { reason: { kind: 'invalid_timeline_cursor' } });

const invalidSearchCursor = () => new Problem(PROBLEM_CODE.invalidInput, 'Invalid search cursor', undefined, { reason: { kind: 'invalid_search_cursor' } });

/** Lane membership has one owner for both axis activity and bounded drawing records. */
function timelineLanes(state: PageReadState, input: { scope: string; visible: string; folded: string }) {
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
  const { own, candidates } = timelineLanes(state, { ...input, visible: input.lanes });
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

export function timeline(state: PageReadState, input: { scope: string; visible: string; folded: string; from: string; to: string;
  after?: string; limit?: number }): TaskTimelineDTO {
  const { own, candidates } = timelineLanes(state, input);
  const visible = [...own], folded = input.folded.split(',').filter(Boolean);
  const from = Date.parse(input.from), to = Date.parse(input.to);
  const scoped = JSON.stringify([input.scope, visible, folded, from, to]), key = JSON.stringify([state.rev, scoped]);
  const cursor = input.after ? readCursor(input.after, invalidTimelineCursor) : undefined;
  if (cursor && !('version' in cursor && 'offset' in cursor)) throw invalidTimelineCursor();
  // A chain of pages reads the list its first page read, whatever updates come while it does: their own read follows.
  let prepared = cursor && [...state.timelinePrepared.values()].find(held => held.scoped === scoped && held.version === cursor.version)
    || state.timelinePrepared.get(key);
  if (!prepared) {
    const stamped: TimelineStamp[] = [];
    const anchors: TaskTimelineDTO['anchors'] = {};
    const tree = current(state), tasks = new Map(tree.tasks.map(task => [task.id, task]));
    const lanes = new Map<string, LayoutRecord[]>();
    for (const id of candidates) {
      const row = state.rows.get(id)?.value, task = tasks.get(id);
      if (!row || !task) continue;
      const prior = [...row.stateLog].reverse().find(log => log.toState !== null && Date.parse(log.at) < from);
      if (prior && !isFinished(prior.toState)) {
        anchors[id] = timelineLogOf(prior);
      }
      // The notes are the Task's history events (a Task below a folded one is drawn in that one's lane, with what its
      // parent's history shows of it); a note made from a log entry comes with that entry.
      const logs = new Map(task.log.map(log => [log.id, log]));
      const notes = eventsFor(state, task, !own.has(id)).map(event => ({ ...event, at: timeMarkAt(event, logs) })).filter(event => {
        const at = Date.parse(event.at);
        return at >= from && at <= to;
      });
      let lane = id;
      while (!own.has(lane) && tasks.get(lane)?.parentId) lane = tasks.get(lane)!.parentId!;
      const records = lanes.get(lane) ?? [];
      const finishing = finishedBy({ state: task.state, stateLog: task.log })?.id;
      records.push(...notes.map(event => ({ ...event, key: historyEventKey(event), text: event.title,
        description: event.summary || null, mark: event.by ? null : reportMark(event), wroteIn: event.runId,
        ...(event.fromChild ? { sourceTaskId: event.taskId } : {}),
        pinned: event.open === true, finish: event.id === finishing,
        ...(event.by && event.state ? { changed: event.state } : {}) })));
      lanes.set(lane, records);
      const noted = new Set(notes.map(event => event.id));
      for (const event of notes) stamped.push({ at: Date.parse(event.at), id: `${id}:note:${event.kind}:${event.id}`,
        value: { kind: 'note', taskId: id, event: timelineNoteOf(event) } });
      for (const entry of row.stateLog) {
        // The line of a Task below a folded one is drawn from its states.
        if (!own.has(id) && entry.toState === null && !noted.has(entry.id)) continue;
        const at = Date.parse(entry.causeAt ?? entry.at);
        if (at >= from && at <= to) stamped.push({ at, id: `${id}:log:${entry.id}`,
          value: { kind: 'log', taskId: id, entry: timelineLogOf(entry) } });
      }
    }
    // Layout links remain in detail History. The list receives only the shared rule's compact decision.
    const shown = new Set([...lanes.values()].flatMap(records => [...reportDisplay(records).targets]
      .filter(([key, target]) => key === target).map(([key]) => key)));
    for (const stamp of stamped) if (stamp.value.kind === 'note' && !shown.has(historyEventKey(stamp.value.event)))
      stamp.value.event.displayed = false;
    for (const { value: run } of state.runs.values()) {
      if (!candidates.has(run.taskId)) continue;
      const created = Date.parse(run.createdAt);
      const started = run.startedAt ? Date.parse(run.startedAt) : created;
      const ended = run.endedAt ? Date.parse(run.endedAt) : Number.POSITIVE_INFINITY;
      if (!(created >= from && created <= to) && !(started <= to && ended >= from)) continue;
      stamped.push({ at: Math.max(from, Math.min(started, to)), id: `${run.taskId}:run:${run.id}`,
        value: { kind: 'run', taskId: run.taskId, run: timelineRunOf(run) } });
    }
    stamped.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const belowRuns: TaskTimelineDTO['belowRuns'] = {};
    const lanesAbove = lanesAboveFor(state, own);
    for (const { value: run } of state.runs.values()) {
      const span = runSpan(run, null);
      if (!span || span.to === null || span.from > to || span.to < from) continue;
      for (const lane of lanesAbove(run.taskId)) (belowRuns[lane] ??= []).push([run.id, span.from, span.to]);
    }
    const version = JSON.stringify([state.resourceVersion, scoped]);
    prepared = { scoped, stamped, anchors, belowRuns, version };
    state.timelinePrepared.set(key, prepared);
    if (state.timelinePrepared.size > 8) state.timelinePrepared.delete(state.timelinePrepared.keys().next().value!);
  }
  const { stamped, anchors, belowRuns, version } = prepared;
  let offset = 0;
  if (cursor) {
    // The `after` value is intentionally omitted from the version on both requests.
    if (cursor.version !== version) throw new Problem(PROBLEM_CODE.conflict, 'Timeline changed; read from the first page', undefined, { reason: { kind: 'timeline_changed_read_from_first_page' } });
    if (typeof cursor.offset !== 'number' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw invalidTimelineCursor();
    offset = cursor.offset;
  }
  const budget = input.limit ?? 200;
  const page = stamped.slice(offset, offset + budget);
  // The line's working intervals stay exact while the notes take more than one page: the first page carries every
  // Run of the range.
  const runs: TaskTimelineDTO['runs'] = [];
  if (offset === 0 && stamped.length > budget) for (const { value: run } of state.runs.values()) {
    if (!candidates.has(run.taskId) || !run.startedAt) continue;
    const start = Date.parse(run.startedAt), end = run.endedAt ? Date.parse(run.endedAt) : to;
    if (start <= to && end >= from) runs.push(timelineRunOf(run));
  }
  const pageIds = new Set([...Object.keys(anchors), ...page.map(item => item.value.taskId), ...runs.map(run => run.taskId)]);
  const rows = [...pageIds].map(id => state.rows.get(id)?.value).filter((row): row is TaskRowDTO => !!row)
    .map(row => pageRow(state, row, state.pageMoved));
  const placementIds = new Set([...runs.map(run => run.placementId),
    ...page.flatMap(item => item.value.kind === 'run' ? [item.value.run.placementId]
      : [])]);
  const nextAfter = offset + page.length < stamped.length ? writeCursor({ version, offset: offset + page.length }) : null;
  return { rows, runs, belowRuns: offset === 0 ? belowRuns : {}, events: page.map(item => item.value),
    anchors: Object.fromEntries([...pageIds].flatMap(id => anchors[id] ? [[id, anchors[id]]] : [])),
    placements: [...state.placements.values()].map(item => item.value).filter(item => placementIds.has(item.id)).map(item => timelinePlacementOf(item)),
    nextAfter, scopeVersion: version };
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

/** Server-prepared time and search resources expire only when their scope's requiredPv changes. */
export class ProjectedPages {
  private generation: string | undefined;
  private readonly prepared = new Map<string, { scope: string; version: string; sourcePv: ProjectionVersion; state: PageReadState }>();
  private readonly searches = new Map<string, { scope: string; version: string; sourcePv: ProjectionVersion; ids: string[] }>();

  private invalidate(frame: PublishedFrame): void {
    if (this.generation !== frame.generation) {
      this.prepared.clear(); this.searches.clear(); this.generation = frame.generation;
    }
    for (const [key, cached] of this.prepared)
      if (cached.version !== resourceVersion(frame, 'timeline', cached.scope)) this.prepared.delete(key);
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

  private prepare(frame: PublishedFrame, scope: string, lanes: { visible: string; folded: string }): { sourcePv: ProjectionVersion; state: PageReadState } {
    this.invalidate(frame);
    const key = JSON.stringify([scope, lanes.visible, lanes.folded]), version = resourceVersion(frame, 'timeline', scope);
    const held = this.prepared.get(key);
    if (held) return held;
    const rows = new Map<string, { value: TaskRowDTO; json: string }>();
    const tasks: ControlTreeDTO['tasks'] = [];
    const runs: Kept<ControlRunDTO> = new Map(), placements: Kept<PlacementDTO> = new Map();
    const children: Record<string, ChildCounts> = {}, moved = new Map<string, number>();
    const records = frame.records, shelf = records.shelf();
    const visible = lanes.visible.split(',').filter(Boolean), folded = lanes.folded.split(',').filter(Boolean);
    if (visible.length > 200 || folded.some(id => !visible.includes(id)) || visible.some(id => !records.bundle(id)))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid visible Task IDs', undefined, { reason: { kind: 'invalid_visible_task_ids' } });
    if (scope !== 'root' && !records.bundle(scope))
      throw new Problem(PROBLEM_CODE.notFound, 'Scope Task does not exist', undefined, { reason: { kind: 'scope_task_does_not_exist' } });
    if (scope !== 'root' && visible.some(id => id !== scope && !records.ancestors(id).includes(scope)))
      throw new Problem(PROBLEM_CODE.invalidInput, 'Task is outside scope', undefined, { reason: { kind: 'task_outside_scope' } });
    // Unfolded descendants still supply belowRuns to the visible lane, but unrelated branches supply nothing.
    const ids = new Set(visible.flatMap(id => [...records.ancestors(id), ...records.subtree(id)]));
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
    const state: PageReadState = { generation: frame.generation, rev: frame.requiredPv.timeline[scope] ?? 0,
      resourceVersion: version, tree: { tasks }, rows, children, pageMoved: moved, runs, placements,
      historyEvents: (id, fromChild) => recordedEvents(records, id, fromChild, fromChild ? records.parent(id) ?? id : id),
      timelinePrepared: new Map(), axisPrepared: new Map() };
    const prepared = { scope, version, sourcePv: frame.pv, state };
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

  timeline(frame: PublishedFrame, input: Parameters<typeof timeline>[1]): TaskProjectedTimelineDTO {
    const prepared = this.prepare(frame, input.scope, { visible: input.visible, folded: input.folded });
    const { scopeVersion: _scopeVersion, ...result } = timeline(prepared.state, input);
    return { ...result, rows: result.rows.map(row => projectedPageRow(frame, row.id)),
      generation: frame.generation, sourcePv: prepared.sourcePv };
  }
}
