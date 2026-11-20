import type { TFunction } from 'i18next';
import { i18n } from '@alpacawork/i18n';
import { ApiError } from '@/data/client';
import type { LocalTurn } from './shown';
/** What a message waiting to start says: while the coordinator starts (its warm-up), that it is starting; else that it waits its turn. */
export const waitingKey = (preparing: boolean) => preparing ? 'coordinatorCard.warm.preparing' as const : 'coordinatorCard.queuedLocally' as const;
/** Both queue surfaces, the local row and the folded line name the same delivery facts. */
export function localDeliveryKey(turn: Pick<LocalTurn, 'stage' | 'last' | 'refusal'>, preparing: boolean) {
  if (turn.stage === 'queued') return waitingKey(preparing);
  if (turn.stage === 'cancelled') return 'coordinatorCard.withdrawn' as const;
  if (turn.stage === 'refused') return turn.refusal ? 'coordinatorCard.refused' as const : 'coordinatorCard.notCarriedOut' as const;
  if (turn.stage === 'sending') return turn.last === 'withdraw' ? 'coordinatorCard.withdrawing' as const : 'coordinatorCard.posting' as const;
  return turn.last === 'withdraw' ? 'coordinatorCard.withdrawUnknown' as const : 'coordinatorCard.unconfirmed' as const;
}
/** What a request's outcome says: that it was taken back, or its delivery fact with the reason it was refused. */
export const localDeliveryText = (turn: Pick<LocalTurn, 'stage' | 'last' | 'cancelled' | 'refusal' | 'blocked'>, t: TFunction<'ui'>, preparing: boolean) =>
  turn.blocked ? turn.refusal ?? '' : turn.cancelled ? i18n.t('undo.toast.undone') : t(localDeliveryKey(turn, preparing), { reason: turn.refusal ?? '' });
/** Only this explicit server reason proves the work had started. A transport failure cannot say that. */
export const withdrawalStarted = (error: unknown) => error instanceof ApiError && error.reason?.kind === 'message_has_already_been_sent';
