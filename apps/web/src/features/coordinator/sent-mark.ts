import type { CoordinatorConversation } from '@/data/coordinator';
import type { Task } from '@/data/types';
import { useDraftStore } from '@/features/forms/draft-store';
import { stateSince } from '@/domain/tasks';
import { useConversation } from './coordinator';
import { outgoingItem, type Outgoing } from './editor/outbox';
import { useWriteIntentStore, type WriteIntent } from '@/data/write-intent';
import { forgetSent, settleSent, useSentHere, type SentHere } from './sent-here';
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';

/**
 * The sole rule for the arc around a row's state icon that says "something this page sent to this Task has not shown
 * on its row yet": an instruction to the coordinator whose work has not started, or a state change not yet reported.
 * Only this page's own sends count (sent-here.ts), so other devices show nothing.
 *
 * An instruction is on its way until it ends: refused, cancelled or taken back before serve has it; then, once its
 * coordinator turn exists, until that turn has ended (succeeded, failed, or any turn with a result: a joined turn's
 * result comes when the Run it joined ends) or was withdrawn. A state change is on its way while its write waits out
 * its undo time or is being delivered, and once confirmed until the row shows the state it reported (the row's state
 * comes with the list's update, after the write's answer); a failure or an unknown result ends it. A row shows the arc
 * while a send on its way names it and the row has not taken that send up: the state transition differs from the one
 * at the press (a review the request invalidates moves the row to In progress at admission), or, for an instruction, a
 * Run is queued or running on it. Each send is judged by its own rule, so a message never ends a state change's arc,
 * nor the reverse. Both sides of that comparison are serve's own record, so no device clock is involved. Once the row
 * took a send up, that send no longer names it (settleSent), so the arc never comes back when the Run ends before the
 * coordinator's turn does.
 */
type Turn = CoordinatorConversation['turns'][number];
type Flag = 'on' | 'off' | 'none';

/** This device's fixed request: on its way unless refused, cancelled or taken back; none once it is gone. */
export const localFlag = (item: Outgoing | null): Flag =>
  !item ? 'none' : item.cancelled || item.taken || item.stage === 'refused' ? 'off' : 'on';

/** The coordinator's turn for a request: on until it ended or was withdrawn; none while serve has not shown it. */
export function turnFlag(conversation: CoordinatorConversation | null, requestId: string): Flag {
  if (conversation?.cancelled.includes(requestId)) return 'off';
  const turn: Turn | undefined = conversation?.turns.find(each => each.id === requestId);
  if (!turn) return 'none';
  return turn.status === 'succeeded' || turn.status === 'failed' || turn.result !== null ? 'off' : 'on';
}

/** A send is on its way while its turn is open, or before serve shows a turn, while this device still holds it. */
export const onItsWay = (local: Flag, turn: Flag) => turn === 'on' || (turn === 'none' && local === 'on');

/** A state change is on its way while its own write waits, is delivered, or is confirmed but not yet shown on the row. */
export function writeOnItsWay(entry: WriteIntent | undefined, requestId: string, shown: string): boolean {
  if (entry?.operationId !== requestId) return false;
  if (entry.status === 'waiting' || entry.status === 'pending') return true;
  return entry.status === 'confirmed' && (entry.payload as { state?: unknown }).state !== shown;
}

type MarkedTask = Pick<Task, 'state' | 'stateLog' | 'rowFacts'>;
/**
 * Whether the row took the send up since the press. A Run counts only for an instruction (`byRun`): a state change can be
 * sent to a Task already running. `false` baseline: its state at the press was not known, so only a Run says.
 */
export function tookUp(task: MarkedTask, baseline: string | null | false, byRun = true): boolean {
  const status = task.rowFacts.status?.kind;
  if (byRun && (status === 'queued' || status === 'running')) return true;
  return baseline !== false && stateSince(task) !== baseline;
}

/** What the arc says it waits for: an instruction's work, or a state change. */
export type SentMark = 'instruction' | 'state';
/**
 * One row against this page's sends that name it (oldest first) and whether each is on its way: what the latest send
 * still waiting shows the arc for (null: none), which sends the row has now taken up (to settle), and which ended (to
 * forget).
 */
export function sentVerdict(task: MarkedTask & { id: string }, named: readonly SentHere[], way: readonly boolean[]) {
  const ended: string[] = [], settle: string[] = [];
  let marked: SentMark | null = null;
  named.forEach((send, n) => {
    if (!way[n]) ended.push(send.requestId);
    else if (tookUp(task, send.tasks[task.id]!, !send.write)) settle.push(send.requestId);
    else marked = send.write ? 'state' : 'instruction';
  });
  return { marked: marked as SentMark | null, settle, ended };
}

/** The arc's verdict for one row; it settles and forgets what the verdict says, so a pair never marks again. */
export function useSentMark(task: { id: string } & MarkedTask): SentMark | null {
  const named = useSentHere(useShallow(state => state.sends.filter(send => task.id in send.tasks)));
  const root = useConversation(view => view.root);
  const locals = useDraftStore(state => named.map(send => send.write ? '' : localFlag(outgoingItem(state.entries, root, send.requestId))).join());
  const turns = useConversation(view => named.map(send => send.write ? '' : turnFlag(view.conversation, send.requestId)).join());
  const writes = useWriteIntentStore(state => named.map(send => send.write ? writeOnItsWay(state.entries[send.write], send.requestId, task.state) : '').join());
  const local = locals.split(','), turn = turns.split(','), write = writes.split(',');
  const verdict = sentVerdict(task, named, named.map((send, n) => send.write ? write[n] === 'true' : onItsWay(local[n] as Flag, turn[n] as Flag)));
  const settle = verdict.settle.join(), ended = verdict.ended.join();
  useEffect(() => {
    if (settle) settleSent(task.id, settle.split(','));
    if (ended) forgetSent(ended.split(','));
  }, [task.id, settle, ended]);
  return verdict.marked;
}
