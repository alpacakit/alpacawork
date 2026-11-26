import type { TFunction } from 'i18next';
import type { DraftEntry } from '@/features/forms/draft-store';
import { awaitsWithdrawal, isLive, outgoing, outgoingDisplay, outgoingKey } from './editor/outbox';
import { rowControl } from './delivery-presentation';
import { localDeliveryText } from './delivery-copy';
import type { LocalTurn, SentTurn, Shown } from './shown';

/** What a message's delivery is read from, besides the message: the outbox's entries and live sends, and the drawn partition. */
export type DeliveryFacts = { root: string; conversationId: string; entries: Record<string, DraftEntry>; live: ReadonlySet<string>; shown: Shown };

/**
 * One message's delivery as every surface draws it: the outcome its sender knows (`outcome`: sent from here and not
 * held by serve yet, a withdrawal on its way, or serve handing it over), the withdrawal under way, and its control (rowControl).
 */
export function deliveryOf(turn: SentTurn, local: LocalTurn | undefined, facts: DeliveryFacts) {
  const { root, conversationId, entries, live, shown } = facts;
  const key = outgoingKey(root, turn.id), entry = entries[key];
  const tracked = entry && outgoing({ [key]: entry }, root).at(0);
  const withdrawing = tracked && awaitsWithdrawal(tracked) ? tracked : null;
  const outcome: LocalTurn | undefined = local ?? (withdrawing
    ? { ...turn, root, conversationId: withdrawing.fixed.conversationId, ...outgoingDisplay(withdrawing, isLive(key, withdrawing.last, live)) }
    : turn.status === 'sending' ? { ...turn, root, conversationId, stage: 'sending', last: 'ask', refusal: null } : undefined);
  const running = shown.thread.some(each => each.status === 'running');
  const control = rowControl({ closing: shown.closing, withdrawal: withdrawing ? isLive(key, 'withdraw', live) ? 'live' : 'unknown' : undefined,
    // On its way to start at once (posted, or admitted and not yet at work) nothing is offered to take back, either side of
    // admission: one "Sending…". One that will wait behind work keeps its × throughout, as its "Waiting in line" does.
    sending: outcome?.stage === 'sending' && !shown.localWaiting.some(each => each.id === turn.id) || turn.status === 'sending' || !local && turn.status === 'queued' && !turn.waiting, deliveryError: !!turn.deliveryError, requested: !!turn.joinRequested || shown.pressed.get(turn.id) === 'send-now', server: !local && !outcome, running });
  return { outcome, withdrawing, control };
}
export type Delivery = ReturnType<typeof deliveryOf>;

/**
 * What a message's line under it says, the one decision both the open conversation (MessageDelivery) and the folded
 * line (LastWords) draw: at work; its sender's outcome; waiting to start (for the coordinator to start, or its turn);
 * an action on its way (taking it back, handing it over); or nothing.
 */
export type DeliveryLine = { kind: 'working' } | { kind: 'outcome'; turn: LocalTurn } | { kind: 'waiting' }
  | { kind: 'moving'; key: 'coordinatorCard.withdrawing' | 'coordinatorCard.posting' } | { kind: 'none' };
export function deliveryLine(turn: SentTurn, local: LocalTurn | undefined, { outcome, control }: Delivery): DeliveryLine {
  if (!local && turn.status === 'running') return { kind: 'working' };
  if (outcome) return { kind: 'outcome', turn: outcome };
  if (control === 'cancel' || control === 'send-now') return { kind: 'waiting' };
  if (control === 'withdrawing') return { kind: 'moving', key: 'coordinatorCard.withdrawing' };
  if (control === 'handing' || control === 'requested') return { kind: 'moving', key: 'coordinatorCard.posting' };
  return { kind: 'none' };
}
/** The line's words, except at work (whose words come from the work itself: useWorkingWords). */
export function deliveryLineWords(line: DeliveryLine, t: TFunction<'ui'>): string | null {
  switch (line.kind) {
    case 'outcome': return localDeliveryText(line.turn, t);
    case 'waiting': return t('coordinatorCard.queuedLocally');
    case 'moving': return t(line.key);
    default: return null;
  }
}
