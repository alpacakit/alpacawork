import { create } from 'zustand';
import { queryClient } from '@/data/query-client';
import { readIndex } from '@/data/read-model';
import { stateSince } from '@/domain/tasks';

/**
 * The sends this page made, each with the named Tasks' state as it stood at the press (the server's own
 * transition time, or null when it had none; `false` when the row was not in the index). Kept in memory only, so the
 * arc is the sending device's and a reload forgets it. A send is a message to the coordinator (`freeze` in outbox.ts)
 * or, with `write`, a direct state report under that write-intent key (use-task-report.ts); those two are the only
 * places that record one. `settleSent` takes a Task out of its sends once the row took it up, and `forgetSent` drops
 * sends that ended.
 */
export type SentHere = { requestId: string; tasks: Readonly<Record<string, string | null | false>>; write?: string };
export const useSentHere = create<{ sends: readonly SentHere[] }>(() => ({ sends: [] }));

export function rememberSent(requestId: string, taskIds: readonly string[], write?: string) {
  if (!taskIds.length) return;
  const rows = readIndex(queryClient)?.tasks ?? [];
  const tasks = Object.fromEntries(taskIds.map(id => {
    const row = rows.find(each => each.id === id);
    return [id, row ? stateSince(row) : false] as const;
  }));
  useSentHere.setState(state => ({ sends: [...state.sends.filter(each => each.requestId !== requestId), { requestId, tasks, ...write && { write } }] }));
}

/** The row took up what these sends asked: none of them marks it again, even when its Run ends before the turn does. */
export function settleSent(taskId: string, requestIds: readonly string[]) {
  if (!requestIds.length) return;
  useSentHere.setState(state => {
    let changed = false;
    const sends = state.sends.flatMap(send => {
      if (!requestIds.includes(send.requestId) || !(taskId in send.tasks)) return [send];
      changed = true;
      const { [taskId]: _taken, ...tasks } = send.tasks;
      return Object.keys(tasks).length ? [{ ...send, tasks }] : [];
    });
    return changed ? { sends } : state;
  });
}
/** Sends that ended mark nothing more. */
export function forgetSent(requestIds: readonly string[]) {
  if (!requestIds.length) return;
  useSentHere.setState(state => {
    const sends = state.sends.filter(send => !requestIds.includes(send.requestId));
    return sends.length === state.sends.length ? state : { sends };
  });
}
