import { useDeliverySurface } from './delivery-notice';
import { ROW_GIVES_WAY, ROW_WHOLE, useToolsHere } from './task-action-slot';
import { LocalOutcome } from './LocalOutcome';
import { latestOutgoing, outgoingFinished } from './editor/outbox';
import { localDeliveryKey, localDeliveryText } from './delivery-copy';
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useConversation } from "./coordinator";
import { useShownConversation, type Shown } from "./shown";
import { firstSentence } from "./foot";
import { coordinatorErrorReason, useWorkingWords } from "./parts";
import { UnreadMark } from "./unread-mark";

/**
 * What the conversation says last while it is folded: that it is thinking, or its last turn's own words (its answer's
 * first sentence, or that it failed or was stopped), unread until its end has been on screen (`read`: read-boundary).
 * Said by the one way into the folded conversation over the input (LastWordsPill).
 */
/** `saying`: what it says while running, when not that it thinks. */
type LastWords = { running: true; said: null; unread: false; saying: string; waiting?: never; soon?: never }
  | { running: false; said: string | null; unread: boolean; waiting?: boolean; saying?: never; soon?: import("./shown").LocalTurn };
const lastTurn = (shown: Shown) => {
  for (let index = shown.thread.length - 1; index >= 0; index--) {
    const turn = shown.thread[index]!;
    if (turn.status === 'running' || turn.status === 'queued') return turn;
  }
  return shown.thread.at(-1);
};
function lastWords(shown: Shown, last: ReturnType<typeof lastTurn>, serveBusy: boolean, read: boolean, working: string, t: TFunction<'ui'>): LastWords {
  const active = last?.status === 'running' || last?.status === 'queued' ? last : undefined;
  const busy = serveBusy && (shown.turns.length > 0 || shown.local.length > 0);
  // A request sent from here that would start at once is the conversation's last word until a snapshot holds it.
  const mine = latestOutgoing(shown.local);
  if (mine?.stage === 'waiting') return { running: false, unread: false, waiting: true,
    soon: mine, said: t('coordinatorCard.soon') };
  if (mine && (mine.stage === 'queued' || mine.stage === 'sending') && shown.localWaiting.includes(mine) && last?.status === 'running')
    return { running: true, said: null, unread: false, saying: working };
  if (mine && !(outgoingFinished(mine) && (busy || active))) return mine.stage === 'sending' || mine.stage === 'queued' ? { running: true, said: null, unread: false, saying: t(localDeliveryKey(mine)) }
    : { running: false, said: localDeliveryText(mine, t), unread: true };
  if (last?.status === "queued") return { running: true, said: null, unread: false, saying: t("coordinatorCard.posting") };
  if (last?.status === 'running' || busy) return { running: true, said: null, unread: false, saying: working };
  // The last turn's own words: its answer's first sentence, or that it failed or was stopped (not an older answer).
  const said = !last ? null : last.status === "succeeded" ? last.answer ? firstSentence(last.answer) : null
    : t("coordinatorCard.failed", { reason: coordinatorErrorReason(last) });
  return { running: false, said, unread: !read && !!said };
}
function useLastWords(): LastWords {
  const { t } = useTranslation("ui");
  const shown = useShownConversation();
  const busy = useConversation(state => state.conversation?.busy ?? false);
  const last = lastTurn(shown);
  const working = useWorkingWords(last?.status === 'running' ? last : undefined);
  const read = useConversation(state => state.read);
  return lastWords(shown, last, busy, read, working, t);
}
/**
 * The one way into the folded conversation: always over the input's left end while the conversation is folded,
 * the input up or down to its one line (`style` places it), saying what the conversation says last with its mark: a
 * blue dot pulsing while it thinks, the conversation's mark with its not-yet-read point on an answer not read yet
 * (UnreadMark), the same mark without the point beside an answer read; with nothing said yet, where it opens. A press
 * opens the conversation.
 */
export function LastWordsPill({ style }: { style: CSSProperties }) {
  const { t } = useTranslation("ui");
  const { running, said, unread, saying, waiting, soon } = useLastWords();
  const root = useConversation(state => state.root);
  const mine = latestOutgoing(useShownConversation().local);
  useDeliverySurface(root, useToolsHere(true), mine && !outgoingFinished(mine) ? mine.id : undefined, mine?.last === 'withdraw' ? 'withdrawal-unknown' : 'delivery');
  // A message's grace is counted whole by the tools beside it (ROW_WHOLE: its words and Undo are said whole or not at
  // all, LocalOutcome), so they become marks while it would not fit, rather than leave it only Undo.
  if (soon) return <div data-coordinator-pill data-coordinator-pill-state="waiting" style={style} {...ROW_WHOLE}
    className={cn(ROW_GIVES_WAY, "pointer-events-auto relative flex h-9 max-w-full items-center gap-2 rounded-full border border-lit-line bg-raised px-3 text-sm shadow-float")}>
    <button type="button" data-coordinator-expand aria-label={t('coordinatorCard.expand')} onClick={() => useConversation.getState().setExpanded(true)} className="absolute inset-0 rounded-full" />
    <div className="pointer-events-none relative flex min-w-0 [&_button]:pointer-events-auto [&>div]:text-sm"><LocalOutcome turn={soon} /></div>
  </div>;
  return <button type="button" data-coordinator-pill data-coordinator-expand data-coordinator-pill-state={running ? "running" : waiting ? "waiting" : unread ? "unread" : said ? "read" : "none"}
    // Its name is what it says (the work, the answer and its dot's "new answer"); what a press does is its title.
    onClick={() => useConversation.getState().setExpanded(true)} title={t("coordinatorCard.expand")}
    style={style} className={cn(ROW_GIVES_WAY, "pointer-events-auto relative flex h-9 max-w-full items-center gap-2 rounded-full border border-lit-line bg-raised pr-3.5 pl-3 text-sm shadow-float hover:bg-hover pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-0 pointer-coarse:before:-bottom-2 pointer-coarse:before:content-['']")}>
    {running ? <i aria-hidden="true" className="size-2 flex-none rounded-full bg-working motion-safe:animate-pulse" />
      : waiting ? <i aria-hidden="true" className="size-2 flex-none rounded-full border border-muted" />
      : unread ? <UnreadMark data-coordinator-unseen label={t("coordinatorCard.newAnswer")} />
      : <Icon name="chat" className="size-3.5 flex-none text-muted" />}
    {/* At work only its dot pulses: the words stay as legible as the rest. */}
    <span className={cn("min-w-0 flex-1 truncate", running ? "text-muted tabular-nums" : unread ? "font-medium text-ink" : "text-muted")}>
      {running ? saying : said ?? t("coordinatorCard.expand")}</span>
  </button>;
}
