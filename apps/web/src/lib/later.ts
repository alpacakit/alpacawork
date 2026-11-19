/**
 * Work that can let whatever is waiting go first, the person's keys above all, in a task of its own at the lowest
 * priority. `scheduler.postTask` is not in every browser (https://developer.mozilla.org/docs/Web/API/Scheduler/postTask):
 * without it the work takes the next timer, or with `orNow` (a caller already in a task of its own) runs at once.
 */
type PostTask = (work: () => void, options: { priority: 'background' }) => Promise<void>;
const postTask = () => (globalThis as { scheduler?: { postTask?: PostTask } }).scheduler;
export function later(work: () => void, { orNow = false } = {}) {
  const scheduler = postTask();
  if (scheduler?.postTask) void scheduler.postTask(work, { priority: 'background' }).catch(error => reportError(error));
  else if (orNow) work();
  else setTimeout(work, 0);
}
