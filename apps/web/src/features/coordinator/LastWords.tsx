import { useDeliverySurface } from './delivery-notice';
import { ROW_GIVES_WAY, ROW_WHOLE, useToolsHere } from './task-action-slot';
import { LocalOutcome } from './LocalOutcome';
import { isOutgoingIn, latestOutgoing, outgoingFinished, useOutbox } from './editor/outbox';
import { localDeliveryText } from './delivery-copy';
import { deliveryLine, deliveryLineWords, deliveryOf, type DeliveryFacts, type DeliveryLine } from './delivery-line';
import { useDraftStore } from '@/features/forms/draft-store';
import { useShallow } from 'zustand/react/shallow';
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useConversation } from "./coordinator";
import { useShownConversation, type SentTurn, type Shown } from "./shown";
import { firstSentence } from "./foot";
import { coordinatorErrorReason, useWorkingWords } from "./parts";
import { UnreadMark } from "./unread-mark";

/**
 * What the conversation says last while it is folded: what the open conversation says under its latest message at work
 * or on its way, from the same decision (deliveryLine), or its last turn's own words (its answer's first sentence, or that
 * it failed or was stopped), unread until its end has been on screen (`read`: read-boundary).
 * Said by the one way into the folded conversation over the input (LastWordsPill).
 */
/** `saying`: what it says while running, when not that it thinks. */
type LastWords = { running: true; said: null; unread: false; saying: string; waiting?: never; soon?: never }
  | { running: false; said: string | null; unread: boolean; waiting?: boolean; saying?: never; soon?: import("./shown").LocalTurn };
type Speaking = { turn: SentTurn; line: DeliveryLine };
/**
 * The message the folded line speaks for: the latest whose line says more than that it waits; else the latest waiting
 * (a message waiting behind work leaves the line to the work, and the waiting count beside it says it waits).
 */
function speaking(shown: Shown, facts: DeliveryFacts): Speaking | undefined {
  const rows = [...shown.thread.filter(turn => turn.status === 'running' || turn.status === 'queued' || turn.status === 'sending').map(turn => ({ turn, local: undefined })),
    ...shown.tail.map(row => row.kind === 'local' ? { turn: row.turn, local: row.turn } : { turn: row.turn, local: undefined })]
    .filter(({ local }) => !local || !outgoingFinished(local) && local.stage !== 'waiting');
  const lines = rows.map(({ turn, local }) => ({ turn, line: deliveryLine(turn, local, deliveryOf(turn, local, facts)) })).filter(({ line }) => line.kind !== 'none');
  return lines.filter(({ line }) => !waits(line)).at(-1) ?? lines.at(-1);
}
const waits = (line: DeliveryLine) => line.kind === 'waiting' || line.kind === 'outcome' && line.turn.stage === 'queued';
function lastWords(shown: Shown, now: Speaking | undefined, read: boolean, working: string, t: TFunction<'ui'>): LastWords {
  const mine = latestOutgoing(shown.local);
  if (mine?.stage === 'waiting') return { running: false, unread: false, waiting: true,
    soon: mine, said: t('coordinatorCard.soon') };
  const last = shown.thread.at(-1);
  // The last turn's own words: its answer's first sentence, or that it failed or was stopped (not an older answer).
  const answer = !last ? null : last.status === "succeeded" ? last.answer ? firstSentence(last.answer) : null
    : last.status === "failed" ? t("coordinatorCard.failed", { reason: coordinatorErrorReason(last) }) : null;
  const unread = !read && !!answer;
  if (now) {
    const words = deliveryLineWords(now.line, shown.preparing, t) ?? '';
    if (now.line.kind === 'working') return { running: true, said: null, unread: false, saying: working };
    // An answer not read yet stays the notice over a message that only waits.
    if (waits(now.line)) return unread ? { running: false, said: answer, unread } : { running: false, said: words, unread: false, waiting: true };
    if (now.line.kind === 'outcome' && now.line.turn.stage !== 'sending') return { running: false, said: words, unread: true };
    return { running: true, said: null, unread: false, saying: words };
  }
  // A send that did not go, when nothing is under way, is the conversation's last word.
  if (mine) return { running: false, said: localDeliveryText(mine, t, shown.preparing), unread: true };
  return { running: false, said: answer, unread };
}
function useLastWords(): LastWords {
  const { t } = useTranslation("ui");
  const shown = useShownConversation();
  const root = useConversation(state => state.root);
  const conversationId = useConversation(state => state.conversation?.id ?? '');
  // Only this conversation's sends: an input edit changes drafts too.
  const entries = useDraftStore(useShallow(state => Object.fromEntries(Object.entries(state.entries).filter(([key]) => isOutgoingIn(key, root)))));
  const live = useOutbox(state => state.live);
  const now = speaking(shown, { root, conversationId, entries, live, shown });
  const working = useWorkingWords(now?.line.kind === 'working' ? now.turn : undefined);
  const read = useConversation(state => state.read);
  return lastWords(shown, now, read, working, t);
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
