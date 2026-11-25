import { WaitingStatus } from './WaitingStatus';
import { WorkMark } from '@/features/people/RunSteps';
import { SoonRing } from './SoonRing';
import { i18n } from '@alpacawork/i18n';
import { notify } from '@/lib/notify';
import { useTranslation } from "react-i18next";
import { useWriteDisabled } from "@/data/queries";
import { draftKey, useDraftStore } from "@/features/forms/draft-store";
import { recordFailure } from '@/lib/notify';
import { useConversation } from "./coordinator";
import { canTakeBack, takeBack, cancelUnsent, useOutbox } from "./editor/outbox";
import { focusCoordinator } from "./editor/draft";
import { localDeliveryText } from './delivery-copy';
import { useShownConversation, type LocalTurn } from "./shown";
import { LINE_ACTION } from './delivery-presentation';
import { cn } from '@/lib/utils';

/** Each action follows the outbox's fixed request and last intent, independent of where the row is drawn. */
export function LocalOutcome({ turn, cancellation = 'inline' }: { turn: LocalTurn; cancellation?: 'inline' | 'external' }) {
  const { t } = useTranslation("ui");
  const disabled = useWriteDisabled();
  const root = useConversation(state => state.root);
  const conversationId = useConversation(state => state.conversation?.id);
  const destination = conversationId ? draftKey(root, 'coordinator', conversationId) : null;
  const back = useDraftStore(state => (turn.stage === "refused" || turn.stage === 'cancelled') && canTakeBack(state.entries, root, turn.id, destination));
  const inlineCancellation = cancellation === 'inline';
  const preparing = useShownConversation().preparing;
  // Its words whole or not at all where the row is narrow: a line too short for them wraps them out of sight, and Undo,
  // first on the line (order), stays beside the ring.
  if (turn.stage === 'waiting') return <div role="status" className="flex min-w-0 items-center gap-1.5 text-muted"><SoonRing until={turn.due} />
    <span className="flex h-[1lh] min-w-0 flex-row-reverse flex-wrap justify-end overflow-hidden"><span className="flex-none">{t('coordinatorCard.soon')}</span>
    {inlineCancellation && <button type="button" data-coordinator-cancel-unsent className={cn(LINE_ACTION, 'order-first flex-none focus-visible:outline-offset-[-2px]')}
      onClick={() => { try { if (cancelUnsent(root, turn.id) === 'cancelled') { takeBack(root, turn.id, destination); focusCoordinator(); } } catch (error) { notify.failure(error, { about: 'cancel unsent message', from: 'coordinator' }); } }}>{i18n.t('undo.toast.undo')}</button>}</span></div>;
  const text = localDeliveryText(turn, t, preparing);
  const withdraw = async () => {
    try { await useConversation.getState().messageAction('withdraw', turn.id); }
    catch (error) { recordFailure(error, 'coordinator withdraw'); }
  };
  if (turn.stage === "sending") return <span role="status" data-coordinator-posting className="inline-flex items-center gap-1.5 text-muted"><WorkMark />{text}</span>;
  const withdrawButton = inlineCancellation && <button type="button" data-coordinator-withdraw disabled={turn.stage === 'unknown' && disabled} className={LINE_ACTION} onClick={() => void withdraw()}>{t('coordinatorCard.withdraw')}</button>;
  if (turn.stage === 'queued') return <WaitingStatus>{text}{withdrawButton}</WaitingStatus>;
  if (turn.stage === 'unknown') return <div role="alert" className="text-warn">{text}
    {turn.last !== 'withdraw' && !turn.blocked && <button type="button" data-coordinator-resend disabled={disabled} className={LINE_ACTION} onClick={() => void useOutbox.getState().resend?.(turn.id)}>{t("coordinatorCard.resend")}</button>}
    {withdrawButton}</div>;
  const takeBackButton = <button type="button" data-coordinator-take-back disabled={!back} title={back ? undefined : t("coordinatorCard.takeBackHint")} className={LINE_ACTION}
    onClick={() => { if (takeBack(root, turn.id, destination)) focusCoordinator(); }}>{t("coordinatorCard.takeBack")}</button>;
  if (turn.cancelled) return <div role="status" className="text-muted">{text}{takeBackButton}</div>;
  return <div role="alert" className={`${turn.stage === 'cancelled' ? 'text-muted' : 'text-error'} [overflow-wrap:anywhere]`}>{text}{takeBackButton}</div>;
}
