import type { TaskTimelineLaneDTO } from '@alpacawork/contract/control';
import { unlistedAggregates } from '@/data/read-model';
import { keepSame, sameParts, type Held } from '@/lib/keep-same';
import type { TimelineLog, TimelineNote, TimelineRun } from '@/domain/history';
import { indexTimePeople, type PeopleIndex, type TimePeopleIndex, type TimeTaskRow } from '@/domain/people';
import { projectTimeHistory, timeHistoryBase, type BelowRun, type TaskHistory, type TimeHistoryBase } from '@/domain/time-history';

type Lane = TaskTimelineLaneDTO;
const laneRows = new WeakMap<Lane['row'], TimeTaskRow>();
/** A strip's own row, for a Task the list does not hold: what descendants decide is the list's, so it has none. */
function laneRow(row: Lane['row']): TimeTaskRow {
  let made = laneRows.get(row);
  if (!made) { made = { ...unlistedAggregates, ...row }; laneRows.set(row, made); }
  return made;
}
type Placement = Lane['placements'][number];

const chronology = new WeakMap<object, string>();
/** The one text of an item's chronology, written once per item: a row that did not change costs nothing more on the next update. */
function chronologyOf<T extends object>(item: T, facts: (item: T) => unknown[]) {
  let text = chronology.get(item);
  if (text === undefined) { text = JSON.stringify(facts(item)); chronology.set(item, text); }
  return text;
}
/** What the time projection reads of people: not a task's title, body, progress or Run activity sample. */
export const chronologyKey = (people: PeopleIndex) => {
  const keys: string[] = [];
  for (const row of people.tasks.values()) keys.push(chronologyOf(row, ({ id, createdAt, state, stateLog, ball, runsBelow }) => [id, createdAt, state, stateLog, ball, runsBelow]));
  for (const item of people.placements.values()) keys.push(chronologyOf(item, ({ id, taskId, responsible, active, startedAt, endedAt }) => [id, taskId, responsible, active, startedAt, endedAt]));
  for (const item of people.runs.values()) keys.push(chronologyOf(item, ({ id, taskId, placementId, createdAt, startedAt, endedAt, state }) => [id, taskId, placementId, createdAt, startedAt, endedAt, state]));
  return keys.join('\n');
};

export type TimeProjection = { timePeople: TimePeopleIndex; notes: Map<string, TimelineNote[]> };
export type TimeProjectionHeld = { rows: Held<TimeTaskRow>; runs: Held<TimelineRun>; placements: Held<Placement> };
export const newTimeProjectionHeld = (): TimeProjectionHeld => ({ rows: new Map(), runs: new Map(), placements: new Map() });

/** People as the time view draws them: the live index, with what the acquired chronology adds to it. */
export function projectTimePeople(people: PeopleIndex, lanes: readonly Lane[], held: TimeProjectionHeld): TimeProjection {
  const records = new Map<string, Map<string, TimelineNote>>();
  if (!lanes.length) return { timePeople: people, notes: new Map() };
  const rows = new Map<string, TimeTaskRow>(people.tasks);
  const logs = new Map<string, TimelineLog[]>();
  const runs = new Map<string, TimelineRun>(people.runs);
  const placements = new Map<string, Placement>(people.placements);
  const logged = (id: string) => { let list = logs.get(id); if (!list) logs.set(id, list = []); return list; };
  for (const lane of lanes) {
    if (!people.tasks.has(lane.row.id)) rows.set(lane.row.id, laneRow(lane.row));
    if (lane.anchor) logged(lane.lane).push(lane.anchor);
    for (const placement of lane.placements) if (!people.placements.has(placement.id)) placements.set(placement.id, placement);
    for (const event of lane.events) if (event.kind === 'log') logged(event.taskId).push(event.entry);
    else if (event.kind === 'note') {
      const notes = records.get(event.taskId) ?? new Map<string, TimelineNote>();
      notes.set(event.event.id, event.event); records.set(event.taskId, notes);
    }
    else if (event.kind === 'run' && !people.runs.has(event.run.id)) runs.set(event.run.id, event.run);
  }
  for (const [id, entries] of logs) {
    const row = rows.get(id);
    if (!row) continue;
    const byId = new Map<string, TimelineLog>();
    for (const entry of row.stateLog) byId.set(entry.id, entry);
    for (const entry of entries) byId.set(entry.id, entry);
    rows.set(id, { ...row, stateLog: [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)) });
  }
  const notes = new Map<string, TimelineNote[]>();
  for (const [id, entries] of records) notes.set(id, [...entries.values()].sort((a, b) => a.at.localeCompare(b.at)));
  return { timePeople: indexTimePeople(keepSame(held.rows, rows), keepSame(held.runs, runs), keepSame(held.placements, placements)), notes };
}

/**
 * The ended Runs under each row, from the range the list reads now. Which row a Run is under is the tree's now, so strips
 * kept from other ranges for their notes are not asked: one may still hold a Run under a parent its Task has left. A row
 * not read yet for this range keeps the last it was read with.
 */
export function belowOf(lanes: readonly Lane[], held: { lanes: readonly Lane[]; below: Map<string, BelowRun[]> }) {
  if (lanes === held.lanes) return held.below;
  const below = new Map(held.below);
  for (const lane of lanes) below.set(lane.lane, lane.belowRuns);
  held.lanes = lanes; held.below = below;
  return below;
}

/** Read items, with their text once it has been written out to compare them. */
type HeldRead = { items: readonly unknown[]; text?: string };
export type HeldBase = { row: unknown; runs: readonly unknown[]; members: string; notes: HeldRead; below: HeldRead; base: TimeHistoryBase | null };
/** The same read items, or (read again as new objects) the same text: each side is written out at most once. */
function sameRead(before: HeldRead, now: HeldRead) {
  if (sameParts(before.items, now.items)) return true;
  before.text ??= JSON.stringify(before.items); now.text ??= JSON.stringify(now.items);
  return before.text === now.text;
}
/** Each row's base is built again only when what it is built from changed. */
export function timeHistoryBases(timePeople: TimePeopleIndex, notes: ReadonlyMap<string, TimelineNote[]>, below: ReadonlyMap<string, BelowRun[]>, held: Map<string, HeldBase>) {
  const bases = new Map<string, TimeHistoryBase | null>();
  for (const row of timePeople.tasks.values()) {
    const runs = timePeople.runsByTask.get(row.id) ?? [], own = notes.get(row.id) ?? [];
    const members = runs.map(run => timePeople.placements.get(run.placementId)?.responsible).join();
    const under = below.get(row.id) ?? [], noted: HeldRead = { items: own }, beneath: HeldRead = { items: under };
    const before = held.get(row.id);
    const same = before && before.row === row && before.members === members && sameParts(before.runs, runs)
      && sameRead(before.notes, noted) && sameRead(before.below, beneath);
    const base = same ? before.base : timeHistoryBase({ id: row.id, createdAt: row.createdAt }, timePeople, own, under);
    if (!same) held.set(row.id, { row, runs, members, notes: noted, below: beneath, base });
    bases.set(row.id, base);
  }
  for (const id of held.keys()) if (!timePeople.tasks.has(id)) held.delete(id);
  return bases;
}

/** A row's history at this clock: the same one while its base and the clock are, and always the same one when it is wholly past. */
export type HeldHistory = { base: TimeHistoryBase | null; now: number; history: TaskHistory | null };
export function timeHistories(bases: ReadonlyMap<string, TimeHistoryBase | null>, now: number, held: Map<string, HeldHistory>) {
  const histories = new Map<string, TaskHistory | null>();
  for (const [id, base] of bases) {
    const before = held.get(id);
    const history = before && before.base === base && before.now === now ? before.history : projectTimeHistory(base, now);
    held.set(id, { base, now, history });
    histories.set(id, history);
  }
  for (const id of held.keys()) if (!bases.has(id)) held.delete(id);
  return histories;
}
