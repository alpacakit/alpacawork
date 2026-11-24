import { countUse } from '@/features/telemetry/count';
import { WaitingStatus } from './WaitingStatus';
import { useDeliverySurface } from './delivery-notice';
import { useToolsHere } from './task-action-slot';
import type { ReactNode } from 'react';
import { outgoingKey, outgoingCancellation, outgoingFinished, useOutbox } from './editor/outbox';
import { useDraftStore } from '@/features/forms/draft-store';
import { useTranslation } from 'react-i18next';
import { recordFailure } from '@/lib/notify';
import { Icon } from '@/components/ui/icon';
import { useWriteDisabled } from '@/data/queries';
import { useActionFocus } from './use-action-focus';
import { useConversation } from './coordinator';
import { useShownConversation, type LocalTurn, type SentTurn } from './shown';
import { deliveryLine, deliveryOf } from './delivery-line';
import { LocalOutcome } from './LocalOutcome';
import { WorkingReply } from './parts';
import { cn } from '@/lib/utils';
import { waitingKey } from './delivery-copy';

/** One sent message's status and actions, wherever that message is drawn. */
export function MessageDelivery({ turn, local, children, panel = false }: { turn: SentTurn; local?: LocalTurn; children?: ReactNode; panel?: boolean }) {
  const { t } = useTranslation('ui');
  const disabled = useWriteDisabled();
  const shown = useShownConversation();
  const focus = useActionFocus();
  const root = useConversation(state => state.root);
  const conversationId = useConversation(state => state.conversation?.id ?? '');
  const key = outgoingKey(root, turn.id);
  const entry = useDraftStore(state => state.entries[key]);
  const live = useOutbox(state => state.live);
  const delivery = deliveryOf(turn, local, { root, conversationId, entries: entry ? { [key]: entry } : {}, live, shown });
  const { outcome, control } = delivery, line = deliveryLine(turn, local, delivery);
  const visible = useToolsHere(false);
  useDeliverySurface(root, panel || visible, outcome && !outgoingFinished(outcome) ? turn.id : undefined, outcome?.last === 'withdraw' ? 'withdrawal-unknown' : 'delivery');
  const mode = outgoingCancellation(root, turn.id);
  const act = async (action: "withdraw" | "send-now") => {
    try {
      const work = () => useConversation.getState().messageAction(action, turn.id);
      if (action === 'send-now') countUse('coord.sendNow');
      if (action === 'send-now') await shown.press(turn.id, action, work); else await work();
    } catch (error) { recordFailure(error, `coordinator queue ${action}`); }
  };
  const inlineCancellation = !panel && (outcome?.stage === 'waiting' || outcome?.stage === 'unknown');
  // Sent now, it is handed to the work under way: under the message it says "Sending…" as any message on its way does, with
  // nothing to take back (the panel's compact row keeps its own control table).
  const withdrawHere = !inlineCancellation && (panel ? ['requested', 'send-now', 'cancel'] : ['send-now', 'cancel']).includes(control);
  const buttons = control === 'send-now' || withdrawHere;
  // What the message is doing on its way, said once wherever its row is drawn.
  const words = control === 'withdrawing' || control === 'handing' || control === 'requested'
    ? <span role="status" title={control === 'requested' ? t('coordinatorCard.sendNowHint') : undefined} className="text-muted motion-safe:animate-pulse">
      {control === 'withdrawing' ? t('coordinatorCard.withdrawing') : t('coordinatorCard.posting')}</span> : null;
  const status = outcome && (!panel || ['unknown', 'refused', 'cancelled'].includes(outcome.stage))
    ? <LocalOutcome turn={outcome} cancellation={inlineCancellation ? 'inline' : 'external'} /> : null;
  // At work, it says what the work is doing and for how long ("Working on it…").
  if (!panel && line.kind === 'working') return <WorkingReply turn={turn} />;
  return <div className={panel ? 'contents' : 'flex flex-wrap items-center gap-x-3'}>
    {panel ? <div className="min-w-0 flex-1">{children}{status}</div> : status}
    {!panel && line.kind === 'waiting' && <WaitingStatus>{t(waitingKey(shown.preparing))}</WaitingStatus>}
    {/* Under a message its state is said in the conversation's own words and size, from the reply's edge (as "Working on it…" is);
        the panel's compact row says it among its controls. */}
    {!panel && line.kind === 'moving' && words}
    {/* Its buttons say their words at the line's size and in its quiet tone (the ink comes under the pointer), a worded one
        underlined as the line's other worded actions (LINE_ACTION) so it reads as one without a pointer, keep a finger's
        height, overhanging the line evenly, so the state's words stand where "Working on it…" does, and stand the line's one gap
        apart. The panel's compact row keeps its small type. */}
    {(!outcome || !outgoingFinished(outcome)) && (panel ? !!words || buttons : buttons) && <span {...focus} data-coordinator-row-control={control}
      className={cn("flex min-h-7 flex-none items-center gap-x-2 whitespace-nowrap narrow:min-h-11", panel ? "text-xs" : "-my-[calc((--spacing(7)-1lh)/2)] narrow:-my-[calc((--spacing(11)-1lh)/2)]")}>
      {panel && words && <span className="px-1.5">{words}</span>}
      {control === 'send-now' && <button type="button" data-coordinator-send-now data-action-focus-target="send-now" disabled={disabled} title={t("coordinatorCard.sendNowHint")}
          onClick={() => void act("send-now")} className={cn("group/send-now inline-flex h-7 items-center gap-1 rounded-sm px-1.5 hover:bg-hover disabled:opacity-40 narrow:h-11", !panel && "text-muted hover:text-ink")}>
          <Icon name="up" className="size-3.5" /><span className={cn(!panel && "underline decoration-line underline-offset-3 group-hover/send-now:decoration-ink group-disabled/send-now:no-underline")}>{t("coordinatorCard.sendNow")}</span></button>}
      {withdrawHere && <button type="button" data-coordinator-withdraw data-action-focus-target="withdraw" aria-label={t("coordinatorCard.withdraw")} title={t("coordinatorCard.withdraw")}
        disabled={mode === 'server' && disabled} onClick={() => void act("withdraw")}
        className="grid size-7 place-items-center rounded-sm text-muted hover:bg-hover hover:text-ink disabled:opacity-40 narrow:size-11">
        <Icon name="close" className="size-3.5" /></button>}
    </span>}
  </div>;
}
