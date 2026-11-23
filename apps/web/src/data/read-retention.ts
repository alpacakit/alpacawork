import { readDataSize } from './read-json';
export { readSize, readDataSize } from './read-json';
import { readGroup, readTaskId, readUsedAt, READ_BUNDLE_AGE, READ_MAX_BYTES, READ_MAX_TASKS, readLifetime } from './read-model';
import { type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';

const memoryBytes = (query: Query) => readDataSize(query.state.data, data => ({ key: query.queryKey, data }));
export function representedReadIds(key: QueryKey, data: unknown): string[] {
  if (['task-finished', 'task-shelved', 'task-search'].includes(String(key[0])))
    return ((data as { pages?: { rows?: { id: string }[] }[] } | undefined)?.pages ?? []).flatMap(page => (page.rows ?? []).map(row => row.id));
  if (isTimelineLane(key)) return [String(key[3])];
  const id = readTaskId(key);
  return id ? [id] : [];
}
const isTimelineLane = (key: QueryKey) => key[0] === 'task-timeline' && key[2] === 'lane' && key.length === 6;
/**
 * Whether a stored strip adds nothing to `later`: the same row and start, read after it, ending no earlier. The range's
 * end moves with the clock, so without this each turn of it leaves one more whole copy for every restart to prove.
 */
export function coversTimelineWindow(later: { key: QueryKey; acquiredAt: number }, earlier: { key: QueryKey; acquiredAt: number }) {
  // [kind, root, 'lane', lane, from, to]: everything but the end names the same row and start.
  return later.key !== earlier.key && isTimelineLane(later.key) && isTimelineLane(earlier.key)
    && later.key.every((part, at) => at === 5 || part === earlier.key[at])
    && String(later.key[5]) >= String(earlier.key[5]) && later.acquiredAt >= earlier.acquiredAt;
}
type RetentionItem<T> = { value: T; key: QueryKey; hash: string; data: unknown; usedAt: number; bytes: number; required: boolean; protected: boolean };
/** One group/deadline/rank/budget policy. Adapters decide which values are eligible and what protection means. */
export function selectGroups<T>(items: RetentionItem<T>[], now: number, envelopeBytes: number, budgetProtected: boolean) {
  const required = items.filter(item => item.required), selected = [...required];
  let bytes = envelopeBytes + required.reduce((n, item) => n + item.bytes, 0) + Math.max(0, required.length - 1);
  if (bytes > READ_MAX_BYTES) return { selected: [] as RetentionItem<T>[], unavailable: true, partial: false, expiresAt: Infinity };
  const groups = new Map<string, RetentionItem<T>[]>();
  for (const item of items.filter(item => !item.required)) {
    const group = readGroup(item.key, item.hash), entries = groups.get(group) ?? []; entries.push(item); groups.set(group, entries);
  }
  const ordered = [...groups.values()].sort((a, b) => Number(b.some(i => i.protected)) - Number(a.some(i => i.protected))
    || Math.max(...b.map(i => i.usedAt)) - Math.max(...a.map(i => i.usedAt)));
  const ids = new Set<string>(); let partial = false, expiresAt = Infinity;
  for (const group of ordered) {
    const protectedGroup = group.some(i => i.protected);
    if (protectedGroup && !budgetProtected) { selected.push(...group); continue; }
    const deadline = Math.max(...group.map(i => i.usedAt)) + (readLifetime(group[0]!.key) ?? READ_BUNDLE_AGE);
    const union = new Set([...ids, ...group.flatMap(i => representedReadIds(i.key, i.data))]);
    const added = group.reduce((n, i) => n + i.bytes, 0) + group.length - (selected.length ? 0 : 1);
    if ((!protectedGroup && now >= deadline) || union.size > READ_MAX_TASKS || bytes + added > READ_MAX_BYTES) { partial ||= protectedGroup; continue; }
    selected.push(...group); bytes += added; union.forEach(id => ids.add(id));
    if (!protectedGroup) expiresAt = Math.min(expiresAt, deadline);
  }
  return { selected, unavailable: false, partial, expiresAt };
}
const pinPredicates = new WeakMap<QueryClient, (query: Query) => boolean>();
export function protectReadRefusals(client: QueryClient, predicate: (query: Query) => boolean) { pinPredicates.set(client, predicate); }
const controllers = new WeakSet<QueryClient>();
export function startReadRetention(client: QueryClient) {
  if (controllers.has(client)) return;
  controllers.add(client);
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, scheduled = false;
  function sweep() {
    clearTimeout(timer); timer = undefined;
    if (running) return;
    running = true;
    try {
      const queries = client.getQueryCache().getAll().filter(query => readLifetime(query.queryKey) !== undefined);
      const selection = selectGroups(queries.map(query => ({ value: query, key: query.queryKey, hash: query.queryHash, data: query.state.data,
        // The selector keeps protected groups outside the memory budget. Size a
        // payload only when that same policy actually needs its byte count.
        usedAt: readUsedAt(query), get bytes() { return memoryBytes(query); }, required: false,
        protected: query.isActive() || query.state.fetchStatus !== 'idle' || !!pinPredicates.get(client)?.(query) })), Date.now(), 2, false);
      const kept = new Set(selection.selected.map(item => item.value));
      for (const query of queries) if (!kept.has(query)) client.removeQueries({ queryKey: query.queryKey, exact: true });
      if (Number.isFinite(selection.expiresAt)) {
        timer = setTimeout(sweep, Math.min(2_147_483_647, Math.max(1, selection.expiresAt - Date.now())));
        (timer as unknown as { unref?: () => void }).unref?.();
      }
    } finally { running = false; }
  }
  client.getQueryCache().subscribe(event => {
    if (running) return;
    if (event.type === 'observerRemoved' || event.type === 'removed' || event.type === 'updated' && ['success', 'error', 'setState'].includes(event.action.type)) {
      if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; sweep(); }); }
    }
  });
}
