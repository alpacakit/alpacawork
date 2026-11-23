import type { TaskTimelineLaneDTO, TaskTimelineLanesDTO } from '@alpacawork/contract/control';
import { ApiError, READ_RETRIES, readDeadlinePassed, readRetryDelay } from './client';

type Waiter = { lane: string; signal?: AbortSignal; resolve: (lane: TaskTimelineLaneDTO) => void; reject: (error: unknown) => void };
/** The most rows one answer is asked for (the server's bound). */
const LANES_PER_READ = 200;

/**
 * Transport only: the rows' strips asked for in the same turn over the same range go out as one read, and each row's
 * own read (its Query) receives its row. A row the answer leaves out for its size is asked again; a row the server does
 * not hold is refused as a missing Task. A read the server stayed silent on is asked again as the same one read (its
 * rows' Queries do not retry on their own), so a busy server is not met with one read per row. Nothing here touches the
 * cache.
 */
export function laneBatches(request: (path: string, signal: AbortSignal) => Promise<TaskTimelineLanesDTO>) {
  const queued = new Map<string, Waiter[]>();
  const live = (waiters: Waiter[]) => waiters.filter(waiter => !waiter.signal?.aborted);
  const enqueue = (range: string, waiter: Waiter) => {
    let waiting = queued.get(range);
    if (!waiting) { queued.set(range, waiting = []); queueMicrotask(() => flush(range)); }
    waiting.push(waiter);
  };
  const flush = (range: string) => {
    const waiting = live(queued.get(range) ?? []);
    queued.delete(range);
    for (let at = 0; at < waiting.length; at += LANES_PER_READ) send(range, waiting.slice(at, at + LANES_PER_READ), 0);
  };
  const send = (range: string, waiters: Waiter[], failures: number) => {
    const [from, to] = JSON.parse(range) as [string, string];
    // The read is given up only when every row waiting on it is.
    const controller = new AbortController(), dropped = () => { if (waiters.every(waiter => waiter.signal?.aborted)) controller.abort(); };
    for (const waiter of waiters) waiter.signal?.addEventListener('abort', dropped);
    const lanes = [...new Set(waiters.map(waiter => waiter.lane))];
    request(`task/timeline?lanes=${encodeURIComponent(lanes.join(','))}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, controller.signal)
      .then(answer => {
        const answered = new Map(answer.lanes.map(lane => [lane.lane, lane])), gone = new Set(answer.gone);
        for (const waiter of waiters) {
          const lane = answered.get(waiter.lane);
          if (lane) waiter.resolve(lane);
          else if (gone.has(waiter.lane)) waiter.reject(new ApiError('Task does not exist', 'not_found', 'check'));
          else if (answered.size) enqueue(range, waiter);
          else waiter.reject(new ApiError('Timeline answered no row', 'invalid_response', 'later'));
        }
      }, error => {
        const waiting = live(waiters);
        if (waiting.length && failures < READ_RETRIES && readDeadlinePassed(error))
          setTimeout(() => { const still = live(waiting); if (still.length) send(range, still, failures + 1); }, readRetryDelay(failures));
        else for (const waiter of waiters) waiter.reject(error);
      })
      .finally(() => { for (const waiter of waiters) waiter.signal?.removeEventListener('abort', dropped); });
  };
  return (lane: string, from: string, to: string, signal?: AbortSignal) =>
    new Promise<TaskTimelineLaneDTO>((resolve, reject) => enqueue(JSON.stringify([from, to]), { lane, signal, resolve, reject }));
}
