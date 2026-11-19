/**
 * Reading `/api/events` as the screen does: the first `index` event is the whole index, each
 * `patch` changes rows, resource versions, counts and positions by key. `index()` answers the index after
 * the next event.
 * A wait for an event fails after `EVENT_DEADLINE_MS` instead of holding the test run open.
 */
import assert from 'node:assert/strict';
import { placeHomeRows } from '@alpacawork/contract';
import {
  projectedIndexSchema, indexPatchSchema, type ProjectedIndexDTO, type IndexPatchDTO,
} from '@alpacawork/contract/control';

export type SseEvent = { event: string; id: string | undefined; data: string };

/** How long a test waits for the next event before it fails. */
export const EVENT_DEADLINE_MS = 15_000;

export function applyIndexPatch(index: ProjectedIndexDTO, patch: IndexPatchDTO): ProjectedIndexDTO {
  assert.equal(patch.rev, index.rev + 1, 'a patch follows the index it changes');
  assert.equal(patch.generation, index.generation);
  assert.ok(patch.sourcePv >= index.sourcePv);
  const id = (item: unknown) => (item as { id: string }).id;
  const merge = <T,>(items: T[], change: { upsert: T[]; remove: string[] }) => {
    const byId = new Map(items.map(item => [id(item), item]));
    for (const item of change.upsert) byId.set(id(item), item);
    for (const key of change.remove) byId.delete(key);
    return [...byId.values()];
  };
  const keyed = <T,>(items: Record<string, T>, change: { upsert: Record<string, T>; remove: string[] }) => {
    const next = { ...items, ...change.upsert };
    for (const key of change.remove) delete next[key];
    return next;
  };
  // The screen's own rule, so a stream test sees the list the screen would show.
  const home = placeHomeRows(index.home, patch.home);
  assert.ok(home, 'every changed home position has a predecessor in the resulting list');
  return { ...index, ...patch.meta, generation: patch.generation, sourcePv: patch.sourcePv, rev: patch.rev,
    tasks: merge(index.tasks, patch.tasks), placements: merge(index.placements, patch.placements), runs: merge(index.runs, patch.runs), home,
    counts: { closed: keyed(index.counts.closed, patch.counts.closed), home: keyed(index.counts.home, patch.counts.home),
      tasks: keyed(index.counts.tasks, patch.counts.tasks), children: keyed(index.counts.children, patch.counts.children),
      all: patch.counts.all ?? index.counts.all },
    requiredPv: { view: keyed(index.requiredPv.view, patch.requiredPv.view), history: keyed(index.requiredPv.history, patch.requiredPv.history),
      page: keyed(index.requiredPv.page, patch.requiredPv.page), timeline: keyed(index.requiredPv.timeline, patch.requiredPv.timeline),
      search: keyed(index.requiredPv.search, patch.requiredPv.search) } };
}

export async function openIndexStream(url: URL, signal: AbortSignal, headers: Record<string, string> = {},
  deadlineMs = EVENT_DEADLINE_MS) {
  const response = await fetch(url, { signal, headers });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffered = '', current: ProjectedIndexDTO | undefined;
  /** The next chunk, or a failure (and the stream closed) when none comes within the deadline. */
  async function read(deadline: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = () => new assert.AssertionError({ message: `no event from ${url.pathname} within ${deadlineMs} ms` });
    const remaining = deadline - Date.now();
    try {
      if (remaining <= 0) throw timeout();
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeout()), remaining); });
      return await Promise.race([reader.read(), expired]);
    }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { clearTimeout(timer); }
  }
  /** The next event with data; heartbeats (comments) are skipped. */
  async function event(): Promise<SseEvent> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end !== -1) {
        const block = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (data) return { event: /^event: (.+)$/m.exec(block)?.[1] ?? 'message', id: /^id: (.+)$/m.exec(block)?.[1], data };
        continue;
      }
      const chunk = await read(deadline);
      assert.equal(chunk.done, false, 'the stream stays open');
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  }
  /** The index after the next event. */
  async function index(): Promise<ProjectedIndexDTO> {
    const next = await event();
    if (next.event === 'index') current = projectedIndexSchema.parse(JSON.parse(next.data));
    else {
      assert.equal(next.event, 'patch');
      assert.ok(current, 'a patch follows an index');
      current = applyIndexPatch(current, indexPatchSchema.parse(JSON.parse(next.data)));
    }
    assert.equal(next.id, `${current.generation}:${current.rev}`);
    return current;
  }
  return { response, event, index };
}
