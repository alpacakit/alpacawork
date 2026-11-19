import type { InfiniteData, Query as QueryRecord } from '@tanstack/react-query';
import { historyCursor } from '@alpacawork/contract';
import { HISTORY_WINDOW_SIZE, type HistoryWindowRequest, type TaskHistoryDTO, type TaskHistoryWindowDTO } from '@alpacawork/contract/control';

type Query = QueryRecord<any, any, any, any>;
/**
 * A Task's History window, held as one continuous page: the events from its oldest (`nextBefore`, null when nothing is
 * older) to the newest, with no gap, and the names of the Tasks they name.
 */
export type HistoryWindow = TaskHistoryDTO;
export type HistoryData = InfiniteData<HistoryWindow, string | null>;
/** Record identity, independent of its current display group or position. */
type HistoryProtection = { kind: 'all' } | { kind: 'through'; cursor: string };
export type HistoryReader = (incoming: TaskHistoryDTO['events']) => HistoryProtection | undefined;
const readers = new WeakMap<Query, Set<HistoryReader>>();
/** The reader supplies only the oldest position it still needs; this module owns the window. */
export function holdHistory(query: Query, floor: HistoryReader) {
  const held = readers.get(query) ?? new Set(); held.add(floor); readers.set(query, held);
  return () => { held.delete(floor); if (!held.size) readers.delete(query); };
}
export function historyProtection(query: Query, incoming: TaskHistoryDTO['events'] = []): HistoryProtection | undefined {
  let oldest: Extract<HistoryProtection, { kind: 'through' }> | undefined;
  for (const read of readers.get(query) ?? []) {
    const protection = read(incoming);
    if (protection?.kind === 'all') return protection;
    if (protection && (!oldest || protection.cursor < oldest.cursor)) oldest = protection;
  }
  return oldest;
}

export const historyWindow = (data: HistoryData | undefined): HistoryWindow | undefined => data?.pages[0];
const oldestKey = (events: TaskHistoryDTO['events']) => events.length ? historyCursor(events.at(-1)!) : null;
const asData = (window: HistoryWindow): HistoryData => ({ pages: [window], pageParams: [null] });
const named = (tasks: HistoryWindow['tasks']) => tasks && Object.keys(tasks).length ? { tasks } : {};

/**
 * The request that reads the window's newest part again: the newest events when nothing is held (or the reader moves
 * to the latest); else everything from the held oldest event on, the newest HISTORY_WINDOW_SIZE of it. While a reader
 * protects a position, that window is kept and widened to reach the position (the server refuses past its limit
 * rather than cut); the position never narrows it.
 */
export function freshHistoryRequest(held: HistoryWindow | undefined, protection: HistoryProtection | undefined, latest = false): HistoryWindowRequest {
  const since = held && oldestKey(held.events);
  if (!since || latest) return { mode: 'latest' };
  if (protection) return { mode: 'protect', since, protect: protection.kind === 'all' || protection.cursor < since ? since : protection.cursor };
  return { mode: 'since', since, keep: HISTORY_WINDOW_SIZE };
}
/** The request that widens the window below its oldest event; none when nothing is older. */
export function olderHistoryRequest(held: HistoryWindow | undefined): HistoryWindowRequest | undefined {
  return held?.nextBefore ? { mode: 'older', before: held.nextBefore, limit: HISTORY_WINDOW_SIZE } : undefined;
}
/** A fresh read replaces the whole window: new events and changes to those held (a question closed, a result added) come in one. */
export function replaceHistory(response: TaskHistoryWindowDTO): HistoryData {
  return asData({ events: response.events, nextBefore: response.hasOlder ? response.oldestKey : null, ...named(response.tasks) });
}
/** A wider read adds what lies below the held window's oldest event, never anything it already holds. */
export function widenHistory(held: HistoryWindow, response: TaskHistoryWindowDTO): HistoryData {
  const edge = oldestKey(held.events);
  const events = [...held.events, ...response.events.filter(event => edge === null || historyCursor(event) < edge)];
  return asData({ events, nextBefore: response.hasOlder ? oldestKey(events) : null, ...named({ ...held.tasks, ...response.tasks }) });
}
/** A closed History keeps only its newest HISTORY_WINDOW_SIZE events: a large window is not kept, read or saved. */
export function trimHistory(data: HistoryData): HistoryData {
  const window = historyWindow(data);
  if (!window || window.events.length <= HISTORY_WINDOW_SIZE) return data;
  const events = window.events.slice(0, HISTORY_WINDOW_SIZE);
  return asData({ ...window, events, nextBefore: oldestKey(events) });
}
/**
 * The window's version is the lowest of the reads it was made from: a replacement's own, or, widened, the lower of
 * what it held and what it added. One that does not reach its resource's requiredPv is read again.
 */
export const widenedSource = (held: number, added: number) => Math.min(held, added);
