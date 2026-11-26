/** Pages, scoped search and timeline reads from a published frame. */
import { valuesText, historyEventKey, joinBusy, reportDisplay, reportMark, runSpan, timeMarkAt, timelineLogOf,
  timelineNoteOf, timelinePlacementOf, timelineRunOf, type LayoutRecord, type TaskValues } from '@alpacawork/contract';
import { isFinished } from '@alpacawork/contract/branch';
import { closedPageScope, finishedBy, standingRecord, type ControlRunDTO, type PlacementDTO, type TaskPageRowDTO, type TaskTimelineAxisDTO,
  type TaskProjectedPageDTO, type TaskProjectedSearchDTO, type TaskTimelineLaneDTO, type TaskTimelineLanesDTO, type TaskProjectedTimelineAxisDTO,
  type ProjectionResourceKind, type ProjectionVersion, type ControlTreeDTO, type TaskRowDTO, type TaskTimelineLanePatchDTO,
  diffTimelineItems } from '@alpacawork/contract/control';
import { byMoved } from '@alpacawork/contract/moved';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { lineWithText, matchesTaskText } from '../control/task-views.js';
import { current, lanesAbove as lanesAboveFor, pageRow, recordEvents, recordedEvents,
  type Kept } from './task-reads.js';
import { controlTaskView } from '../control/task-dto.js';
import type { PublishedFrame } from './projection-contract.js';
import { aggregateRowFacts } from './row-facts.js';
import { readsRow } from './screen-derive.js';
import { liveRow } from './index-rows.js';

/** What rows' strips and axis read: the rows' ancestors and subtrees, from one published frame. */
type PageReadState = {
  runs: Kept<ControlRunDTO>;
  placements: Kept<PlacementDTO>;
  tree?: { tasks: ControlTreeDTO['tasks'] };
  rows: ReadonlyMap<string, { value: TaskRowDTO }>;
  historyEvents: (id: string) => ReturnType<typeof recordEvents>;
};
/** A Task's History events the list's time line reads: what happened to an agent's conversation is History's alone. */
const eventsFor = (state: PageReadState, task: ControlTreeDTO['tasks'][number]) =>
  state.historyEvents(task.id).filter(event => event.kind !== 'conversation');

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

/** The rows' full-lifetime activity: their own records' marks and the Runs of their subtrees. */
export function timelineAxis(state: PageReadState, lanes: readonly string[]): TaskTimelineAxisDTO {
  const own = new Set(lanes);
  const spans: [number, number | null][] = [];
  let earliest = Number.POSITIVE_INFINITY;
  for (const task of current(state).tasks) {
    if (!own.has(task.id)) continue;
    const logs = new Map(task.log.map(log => [log.id, log]));
    const standing = standingRecord({ state: task.state, stateLog: task.log, ball: state.rows.get(task.id)?.value.ball ?? null });
    for (const log of task.log) earliest = Math.min(earliest, Date.parse(log.causeAt ?? log.at));
    for (const event of eventsFor(state, task)) {
      const at = Date.parse(timeMarkAt(event, logs));
      earliest = Math.min(earliest, at);
      if (standing(event.id)) spans.push([at, at]);
    }
  }
  const lanesAbove = lanesAboveFor(state, own);
  for (const { value: run } of state.runs.values()) {
    const span = runSpan(run, null);
    if (own.has(run.taskId)) earliest = Math.min(earliest, Date.parse(run.createdAt));
    else if (!span || !lanesAbove(run.taskId).length) continue;
    else earliest = Math.min(earliest, span.from);
    if (span) spans.push([span.from, span.to]);
  }
  return { busy: joinBusy(spans), earliest: Number.isFinite(earliest) ? earliest : null };
}

type TimelineEvent = TaskTimelineLaneDTO['events'][number];
type TimelineLane = Omit<TaskTimelineLaneDTO, 'row' | 'generation' | 'sourcePv' | 'token'>;
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
    const notes = eventsFor(state, task).map(event => ({ ...event, at: timeMarkAt(event, logs) })).filter(event => {
      const at = Date.parse(event.at);
      return at >= from && at <= to;
    });
    const finishing = finishedBy({ state: task.state, stateLog: task.log })?.id;
    // Layout links remain in detail History. The list receives only the shared rule's compact decision.
    const shown = new Set([...reportDisplay(notes.map(event => ({ ...event, key: historyEventKey(event), text: event.title,
      description: event.summary || null, mark: event.by ? null : reportMark(event), wroteIn: event.runId,
      pinned: event.open === true, finish: event.id === finishing,
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
const lanesVersion = (frame: PublishedFrame, lanes: readonly string[]) =>
  `${frame.generation}:${Math.max(0, ...lanes.map(id => frame.requiredPv.timeline[id] ?? 0))}`;
const invalidLanes = () => new Problem(PROBLEM_CODE.invalidInput, 'Invalid visible Task IDs', undefined, { reason: { kind: 'invalid_visible_task_ids' } });

/** Strips kept to send changes against: per row, and in all. */
const SENT_PER_ROW = 4, SENT_STRIPS = 512;
/** Server-prepared time and search resources expire only when their rows' or scope's requiredPv changes. */
export class ProjectedPages {
  private generation: string | undefined;
  private readonly axes = new Map<string, { lanes: string[]; version: string; value: TaskProjectedTimelineAxisDTO }>();
  private readonly lanes = new Map<string, { lane: string; version: string; value: TaskTimelineLaneDTO }>();
  private readonly searches = new Map<string, { scope: string; version: string; sourcePv: ProjectionVersion; ids: string[] }>();
  /**
   * The strips sent lately, by their token, so a reader holding one is sent only what changed since (any range): a few
   * per row, as a row's strip can be large and each reader holds the newest it was sent; an older one is sent whole.
   */
  private readonly sent = new Map<string, TaskTimelineLaneDTO>();
  private readonly sentOf = new Map<string, string[]>();
  /** Strips made so far: with the generation's head, a token no strip of an earlier server run can have had. */
  private made = 0;
  /** Each item's text, written once per item object: a strip kept for its version shares its items with the next. */
  private readonly texts = new WeakMap<object, string>();

  private invalidate(frame: PublishedFrame): void {
    if (this.generation !== frame.generation) {
      this.axes.clear(); this.lanes.clear(); this.searches.clear(); this.sent.clear(); this.sentOf.clear(); this.generation = frame.generation;
    }
    for (const [key, cached] of this.axes)
      if (cached.version !== lanesVersion(frame, cached.lanes)) this.axes.delete(key);
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
    const records = frame.records;
    for (const id of new Set(lanes.flatMap(id => [...records.ancestors(id), ...records.subtree(id)]))) {
      const bundle = records.bundle(id), derived = frame.derived(id);
      if (!bundle || !readsRow(records, id, derived)) continue;
      rows.set(id, { value: projectedRow(frame, id), json: '' });
      tasks.push({ ...controlTaskView(bundle.task), files: [...bundle.files ?? []] });
      for (const run of derived.runs) runs.set(run.id, { value: run, json: '' });
      for (const placement of derived.placements) placements.set(placement.id, { value: placement, json: '' });
    }
    return { tree: { tasks }, rows, runs, placements,
      historyEvents: id => recordedEvents(records, id) };
  }

  private held(frame: PublishedFrame, id: string) { return readsRow(frame.records, id, frame.derived(id)); }

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

  /**
   * The axis of up to 200 rows, as new as the newest of their versions. A row the server does not read (gone, or its
   * project shelved) adds nothing, as it is left out of the strips (`gone`), until the screen's list catches up.
   */
  timelineAxis(frame: PublishedFrame, input: { lanes: string }): TaskProjectedTimelineAxisDTO {
    this.invalidate(frame);
    const lanes = [...new Set(input.lanes.split(',').filter(Boolean))].sort(), key = lanes.join(',');
    if (lanes.length > 200) throw invalidLanes();
    const cached = this.axes.get(key);
    if (cached) return cached.value;
    const read = lanes.filter(id => this.held(frame, id));
    const value = { ...timelineAxis(this.readState(frame, read), read), generation: frame.generation, sourcePv: frame.pv };
    this.axes.set(key, { lanes, version: lanesVersion(frame, lanes), value });
    if (this.axes.size > 16) this.axes.delete(this.axes.keys().next().value!);
    return value;
  }

  private keep(value: TaskTimelineLaneDTO): void {
    const tokens = (this.sentOf.get(value.lane) ?? []).filter(token => token !== value.token && this.sent.has(token));
    tokens.push(value.token);
    for (const token of tokens.splice(0, Math.max(0, tokens.length - SENT_PER_ROW))) this.sent.delete(token);
    this.sent.delete(value.token); this.sent.set(value.token, value); this.sentOf.set(value.lane, tokens);
    while (this.sent.size > SENT_STRIPS) this.sent.delete(this.sent.keys().next().value!);
  }

  /** What `value` changes in the strip the reader holds (`base`), or the whole strip when that one is no longer kept. */
  private patch(value: TaskTimelineLaneDTO, base: string | undefined): TaskTimelineLanePatchDTO {
    const held = base === undefined ? undefined : this.sent.get(base);
    if (!held || held.lane !== value.lane) return { ...value, base: null, drop: [] };
    const text = (item: object) => {
      let written = this.texts.get(item);
      if (written === undefined) { written = JSON.stringify(item); this.texts.set(item, written); }
      return written;
    };
    return { ...value, ...diffTimelineItems(held, value, text), base: held.token };
  }

  /**
   * Rows' strips over one range, each as new as its own version: a strip already made for its row's current version is
   * not made again. A row whose held strip is named in `bases` is sent only what changed from it. Rows are answered in
   * the order asked until about `limit` events (at least one row).
   */
  timeline(frame: PublishedFrame, input: { lanes: string; bases?: string; from: string; to: string; limit?: number }): TaskTimelineLanesDTO {
    this.invalidate(frame);
    const asked = [...new Set(input.lanes.split(',').filter(Boolean))];
    if (asked.length > 200) throw invalidLanes();
    const held = (id: string) => this.held(frame, id);
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
      // The row as the list holds it: what its current state is drawn from (a held row has derived facts, readsRow). Its
      // chronology is the strip's own events.
      const value = { ...lane, row: liveRow(frame.derived(id)!.row), token: `${frame.generation.slice(0, 8)}.${(++this.made).toString(36)}`, generation: frame.generation, sourcePv: frame.pv };
      values.set(id, value);
      this.lanes.set(key(id), { lane: id, version: lanesVersion(frame, [id]), value });
    }
    while (this.lanes.size > 512) this.lanes.delete(this.lanes.keys().next().value!);
    const bases = new Map((input.bases ?? '').split(',').flatMap(item => {
      const at = item.indexOf(':');
      return at > 0 ? [[item.slice(0, at), item.slice(at + 1)] as const] : [];
    }));
    const answered: TaskTimelineLanePatchDTO[] = [], budget = input.limit ?? 2000;
    let events = 0;
    for (const id of asked) {
      const value = values.get(id);
      if (!value) continue;
      const sent = this.patch(value, bases.get(id));
      if (answered.length && events + sent.events.length > budget) break;
      answered.push(sent); events += sent.events.length;
      this.keep(value);
    }
    return { lanes: answered, gone: asked.filter(id => !values.has(id)) };
  }
}
