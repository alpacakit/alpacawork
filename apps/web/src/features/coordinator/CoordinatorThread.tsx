import { memo, useState, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/components/ui/copy-button";
import { textClip } from "@/lib/clipboard";
import { Icon } from "@/components/ui/icon";
import { ON_RAIL, TimelineMark } from "@/components/ui/timeline-mark";
import { useWriteDisabled } from "@/data/queries";
import type { CoordinatorTurn } from "@/data/coordinator";
import { MarkdownBody } from "@/features/reader/MarkdownBody";
import { useImageViewer } from "@/features/reader/ImageSlider";
import { followTask } from "./follow-task";
import { cn } from "@/lib/utils";
import { useConversation } from "./coordinator";
import { opening } from "./read-boundary";
import { firstSentence } from "./foot";
import { answerBodyFiles, MessageFiles, type OpenMessageImages } from "./MessageFiles";
import { SentMessage, useMessageCopy, useMessageParts } from "./SentMessage";
import { coordinatorErrorReason, Thinking } from "./parts";
import { useShownConversation, type SentTurn } from "./shown";
import { ReplyLabel } from './ReplyLabel';
import { messageTime } from './message-time';
import { replyInDraft } from './editor/draft';
import { useReplyNavigationOwner } from './reply-navigation';
import { keepThreadPosition } from './thread-position';
import { Button } from '@/components/ui/button';
import { MessageDelivery } from "./MessageDelivery";
import { LINE_ACTION } from "./delivery-presentation";
import { useActionFocus } from "./use-action-focus";
import { WarmStart } from "./WarmStart";

/**
 * A message's head line: who and when, and what it was sent with. `mark` is its turn's mark on the rail: drawn here and
 * centred on this line (its first, when the line wraps), so every kind of mark sits level with "you" and the time
 * whatever the text size. `more`: what follows on the line (a folded exchange's counts, its open or fold control).
 */
function MessageHead({ turn, mark, more }: { turn: SentTurn; mark?: ReactNode; more?: ReactNode }) {
  const { t, i18n } = useTranslation("ui");
  return <div className="relative mb-type-close flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted">
    {mark && <span data-coordinator-mark className={`${ON_RAIL} -ml-(--gutter) top-[0.5lh] flex -translate-y-1/2`}>{mark}</span>}
    <span className="font-medium text-ink">{t("coordinatorCard.you")}</span>
    <time dateTime={turn.at} className="tabular-nums">{messageTime(turn.at, i18n.language)}</time>
    {turn.status === "joined" && <span>· {t("coordinatorCard.sentDuringWork")}</span>}
    {more}
  </div>;
}
/** A mark standing on the rail: on a disc of the rail's ground, so the rail stops at it (as TimelineMark's). */
const ON_DISC = "rounded-full bg-lit ring-2 ring-lit";

/** One message sent, in full. */
function Message({ turn, open, skills, mark, fold }: { turn: SentTurn; open: OpenMessageImages; skills: readonly { name: string }[]; mark?: ReactNode; fold?: ReactNode }) {
  const parts = useMessageParts(turn.ask, skills);
  const copy = useMessageCopy(parts);
  return <div data-coordinator-said className="mt-type-block first:mt-0">
    <MessageHead turn={turn} mark={mark} more={fold} />
    <div data-coordinator-origin={turn.id} data-held={copy.held || undefined} className={cn("w-fit max-w-full rounded-md bg-bg px-2.5 py-1.5", HELD)}>
      {(turn.ask || turn.replyTo) && <p {...copy.props} data-sent-message className="m-0 whitespace-pre-wrap">{turn.replyTo && <ReplyLabel reply={turn.replyTo} origin={{ id: turn.id, at: turn.at }} />}<SentMessage parts={parts} /></p>}
      {!!turn.attachments.length && <div className={turn.ask ? "mt-1.5" : undefined}><MessageFiles turn={turn} open={open} /></div>}
    </div>
  </div>;
}
// The answer's document is unchanged by opening or folding the conversation. Its time and controls still render.
const AnswerBody = memo(function AnswerBody({ turn }: { turn: CoordinatorTurn }) {
  // Scrolled to, it stops clear of the head (--pane-head, CoordinatorCard) and the 16px its edge fades over, 48px from
  // the top at least.
  return <div data-ask-answer className="scroll-mt-[max(3rem,calc(var(--pane-head,1.25rem)+1rem))]"><MarkdownBody text={turn.answer!} task={null} variant="note" onFollow={followTask} files={answerBodyFiles(turn)} /></div>;
});
/**
 * One message open: its words, the messages joined to it, and the one reply place under them. A press's own row and serve's
 * turn that takes its place both draw it under the same key, so admission keeps every element and only what they say
 * changes: from the press until the answer, the reply place says where the message is (MessageDelivery), then answers.
 */
const EXCHANGE = "exchange", NONE: readonly SentTurn[] = [];
function Exchange({ turn, open, skills, joined, mark, fold, reply }: { turn: SentTurn; open: OpenMessageImages; skills: readonly { name: string }[];
  joined: readonly SentTurn[]; mark: ReactNode; fold?: ReactNode; reply: ReactNode }) {
  return <>
    <Message turn={turn} open={open} skills={skills} mark={mark} fold={fold} />
    {joined.map(item => <Message key={item.id} turn={item} open={open} skills={skills} />)}
    <div data-coordinator-reply className="mt-type-block">{reply}</div>
  </>;
}
/** On its way or at work: said on the message's one delivery line, not an answer yet. */
const delivering = (turn: CoordinatorTurn) => turn.status === "queued" || turn.status === "sending" || turn.status === "running";
function Answer({ turn, retry }: { turn: CoordinatorTurn; retry: (turn: CoordinatorTurn) => void }) {
  const { t, i18n } = useTranslation("ui");
  const disabled = useWriteDisabled();
  if (turn.status === "succeeded" && turn.answer !== null) {
    const seconds = Math.max(0, Math.round((Date.parse(turn.answeredAt ?? turn.at) - Date.parse(turn.at)) / 1000));
    return <div>
      <AnswerBody turn={turn} />
      <div data-coordinator-answer-meta className="mt-type-close flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
        <span className="font-medium text-ink">{t("coordinatorCard.title")}</span>
        {turn.answeredAt && <><time dateTime={turn.answeredAt} className="tabular-nums">{messageTime(turn.answeredAt, i18n.language)}</time>
          <span>· {seconds < 60 ? t("coordinatorCard.seconds", { count: seconds }) : t("coordinatorCard.minutes", { count: Math.round(seconds / 60) })}</span></>}
        <span className="inline-flex gap-0">
          <CopyButton clip={() => textClip(turn.answer!)} label={t("coordinatorCard.copyAnswer")} className="-my-1 h-8 w-7 narrow:-my-2 narrow:h-10 narrow:w-9" />
          <Button type="button" variant="quiet" size="icon" disabled={disabled} data-reply-answer={turn.id}
            aria-label={t('coordinatorCard.replyAnswer')} title={t('coordinatorCard.replyAnswer')}
            className="-my-1 h-8 w-7 text-muted hover:text-ink narrow:-my-2 narrow:h-10 narrow:w-9"
            onClick={() => replyInDraft({ id: turn.id, answeredAt: turn.answeredAt ?? turn.at })}><Icon name="reply" className="size-3.5" /></Button>
        </span>
      </div>
    </div>;
  }
  // The Run's own error words follow in full, even with a known cause: only they carry details such as when a limit resets.
  return <div role="alert" className="text-error">{t("coordinatorCard.failed", { reason: coordinatorErrorReason(turn) })}
    {turn.status === "failed" && !turn.attachments.length && !turn.sentAgain && <button type="button" disabled={disabled} className={LINE_ACTION}
      onClick={() => retry(turn)}>{t("coordinatorCard.retry")}</button>}
    {turn.failure && <span data-coordinator-failure-message className="mt-type-close block whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{turn.failure.message}</span>}</div>;
}

/**
 * A message held long is copied (`useMessageCopy`). On a touch screen its words are not selected by holding them (the
 * hold is the copy), and while held long enough it is drawn pressed in, to be let go.
 */
const HELD = "pointer-coarse:select-none pointer-coarse:[-webkit-touch-callout:none] transition-colors data-held:bg-hover";
/** A folded exchange's message: its first two lines, held long to copy it whole as the open one is. */
function FoldedMessage({ turn, skills }: { turn: SentTurn; skills: readonly { name: string }[] }) {
  const parts = useMessageParts(turn.ask, skills);
  const copy = useMessageCopy(parts);
  return <p {...copy.props} data-sent-message className={cn("m-0 line-clamp-2 rounded-sm text-muted", HELD)}>{turn.replyTo && <ReplyLabel reply={turn.replyTo} origin={{ id: turn.id, at: turn.at }} />}<SentMessage parts={parts} /></p>;
}

/** What one exchange came to, for its folded line: its answer's first sentence, or that it is at work, failed or stopped. */
function Outcome({ turn }: { turn: CoordinatorTurn }) {
  const { t } = useTranslation("ui");
  if (turn.status === "queued") return <span role="status" className="text-muted motion-safe:animate-pulse">{t("coordinatorCard.posting")}</span>;
  if (turn.status === "running") return <Thinking turn={turn} />;
  const [text, tone] = turn.status === "succeeded" ? [turn.answer ? firstSentence(turn.answer) : "", "text-ink"]
    : [t("coordinatorCard.failed", { reason: coordinatorErrorReason(turn) }), "text-error"];
  return <span className={cn("min-w-0 flex-1 truncate", tone)}>{text}</span>;
}

/* Hallmark · component: one exchange of the conversation (a message, what joined it, and its answer) · states: open (all of
 * it) · folded (the message's first two lines and the answer's first sentence; a press opens it) */
/** One hidden history range, counted in messages; its entrance disappears when the rows are revealed. */
function EarlierRow({ count, reveal }: { count: number; reveal: () => void }) {
  const { t } = useTranslation("ui");
  const focus = useActionFocus();
  return <li {...focus} data-earlier="folded" className="relative scroll-mt-14 border-b border-rule pl-(--gutter)">
    <button type="button" aria-expanded={false} onClick={reveal}
      className="group flex min-h-11 w-full items-center gap-1.5 py-2 text-left text-xs text-muted narrow:min-h-12">
      <span className={`${ON_RAIL} top-1/2 flex -translate-y-1/2`}><Icon name="unfold" className={cn("size-3.5 text-muted", ON_DISC)} /></span>
      <span className="font-medium text-ink">{t("coordinatorCard.earlierCount", { count })}</span>
      <span className="ml-auto rounded-sm px-2 underline decoration-line underline-offset-3 group-hover:text-ink group-hover:decoration-ink">
        {t("coordinatorCard.exchangeOpen")}</span>
    </button>
  </li>;
}
/** The hand's key for the earlier row (an exchange's is its ID). */
const EARLIER = "earlier";

/** Latest exchange and new arrivals stay shown; older history has one independent fold. */
export const CoordinatorThread = memo(function CoordinatorThread({ turns, retry, skills = [] }: {
  // The Card's render remains an opportunity to notice a local day/zone change,
  // even when this memo's conversation inputs are otherwise unchanged.
  turns: CoordinatorTurn[]; retry: (turn: CoordinatorTurn) => void; skills?: readonly { name: string }[]; clock?: string;
}) {
  const { t, i18n } = useTranslation("ui");
  const viewer = useImageViewer();
  const shown = useShownConversation(turns);
  const work = shown.thread;
  const taken = useConversation(state => state.opening);
  const scope = useConversation(state => state.conversation?.id);
  // The store's opening (coordinator.ts owns when it is taken); drawn outside one, as an opening of what is here would be.
  const opened = taken ?? opening(work);
  // What is opened or folded by hand belongs to one opening.
  const [hands, setHands] = useState<{ of?: number; map: ReadonlyMap<string, boolean> }>({ of: taken?.id, map: new Map() });
  if (hands.of !== taken?.id) setHands({ of: taken?.id, map: new Map() });
  const hand = hands.of === taken?.id ? hands.map : new Map<string, boolean>();
  const setHand = (next: (map: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => setHands(state => ({ of: state.of, map: next(state.map) }));
  // History folds at the opening's latest exchange; read facts never change this boundary.
  const start = Math.max(0, work.findIndex(turn => turn.id === opened.latest));
  const earlierOpen = hand.get(EARLIER) ?? false;
  const thread = useRef<HTMLOListElement>(null);
  const toggle = (id: string, open: boolean) => {
    if (thread.current) keepThreadPosition(thread.current);
    setHand(map => new Map(map).set(id, open));
  };
  // Before the server has a warm-up to say, the page's own ask stands for it: about to be sent or on its way (the card
  // asks as soon as it can write), or refused; only a page that cannot write has none to say.
  const writeDisabled = useWriteDisabled();
  const warm = useConversation(({ conversation, warmRefused }) => !conversation ? "none"
    : conversation.warm !== "none" ? conversation.warm : warmRefused === conversation.id ? "failed" : writeDisabled ? "none" : "preparing");
  const asked = useConversation(state => state.asked);
  useReplyNavigationOwner(thread, scope, asked, id => {
    setHand(map => new Map(map).set(EARLIER, true).set(id, true));
  });
  const rows = [...work.map(turn => ({ kind: 'server' as const, turn })), ...shown.tail].map((row, at) => {
    if (row.kind === 'local') {
      const turn = row.turn;
      // The same request key survives admission; recoverable refused words have their own identity.
      return <li key={turn.stage === "refused" ? `refused:${turn.id}` : turn.id} data-action-focus-place tabIndex={-1} data-coordinator-local={turn.stage} data-coordinator-waiting={shown.localWaiting.includes(turn) ? turn.id : undefined} data-coordinator-message={turn.id} className="relative animate-rise border-b border-rule py-3 pl-(--gutter) last:border-b-0">
        <Exchange key={EXCHANGE} turn={turn} open={viewer.open} skills={skills} joined={NONE}
          mark={<TimelineMark kind={turn.stage === "refused" ? "error" : "request"} tone={turn.stage === "refused" ? "error" : "quiet"} />}
          reply={<MessageDelivery turn={turn} local={turn} />} />
      </li>;
    }
    const turn = row.turn;
    // Hidden history has no row yet: build its labels and messages only when it is opened.
    if (at < start && !earlierOpen) return null;
    const open = turn.waiting || (hand.get(turn.id) ?? at >= start);
    const joined = shown.joined.get(turn.id) ?? [];
    const mark = <TimelineMark kind={turn.status === "running" ? "start" : turn.status === "failed" ? "error" : "request"}
      tone={turn.status === "running" ? "working" : turn.status === "failed" ? "error" : "quiet"} />;
    // Said in words, not an arrow: an arrow on the conversation is what closes it (its ∨ at the top right). Taller than
    // its line, it overhangs it evenly, so the line keeps its height.
    const button = <button type="button" data-exchange-toggle aria-expanded={open}
      aria-label={t(open ? "coordinatorCard.foldExchange" : "coordinatorCard.openExchange", { time: messageTime(turn.at, i18n.language) })}
      onClick={() => toggle(turn.id, !open)} className="-my-[calc((--spacing(7)-1lh)/2)] ml-auto flex h-7 flex-none items-center self-center rounded-sm px-2 text-xs text-muted underline decoration-line underline-offset-3 hover:bg-hover hover:text-ink hover:decoration-ink narrow:-my-[calc((--spacing(10)-1lh)/2)] narrow:h-10">
      {t(open ? "coordinatorCard.exchangeFold" : "coordinatorCard.exchangeOpen")}</button>;
    return <li key={turn.id} data-action-focus-place tabIndex={-1} data-coordinator-turn={turn.status} data-coordinator-waiting={turn.waiting ? turn.id : undefined} data-coordinator-message={turn.id} data-exchange={open ? "open" : "folded"}
      className="relative animate-rise border-b border-rule py-3 pl-(--gutter) last:border-b-0">
      {open ? <Exchange key={EXCHANGE} turn={turn} open={viewer.open} skills={skills} joined={joined} mark={mark} fold={turn.waiting ? undefined : button}
        reply={delivering(turn) ? <MessageDelivery turn={turn} /> : <Answer turn={turn} retry={retry} />} />
      : <div className="cursor-pointer" onClick={event => {
        // A press opens it; a press on what it holds (a task's label), or a drag that selects its words, does not.
        if (!(event.target as Element).closest("button, a") && (event.currentTarget.ownerDocument.defaultView?.getSelection()?.isCollapsed ?? true)) toggle(turn.id, true);
      }}>
        <MessageHead turn={turn} mark={mark} more={<>
          {!!joined.length && <span>· {t("coordinatorCard.joinedCount", { count: joined.length })}</span>}
          {!!turn.attachments.length && <span>· {t("coordinatorCard.filesCount", { count: turn.attachments.length })}</span>}
          {button}
        </>} />
        {turn.ask && <FoldedMessage turn={turn} skills={skills} />}
        <div data-exchange-outcome className="mt-type-close flex min-w-0 items-center gap-1.5">
          <Icon name="right" className="size-3 flex-none text-muted" /><Outcome turn={turn} />
        </div>
      </div>}
    </li>;
  });
  // The rail runs through each turn's gutter, its 1px line from 7px in (--rail, its left edge), so it stays on whole
  // pixels; a turn's mark stands on it from its head, a gutter further in. A word with no place to fold (a path, an
  // address, a file's name) folds at any letter where it would outrun the conversation, as in the reader.
  // Empty is no row drawn at all: a first message sent before the warm-up ends waits at the thread's end (tail), in no
  // other list, and stands in the greeting's place as any message does.
  const empty = !work.length && !shown.tail.length && warm !== "none" ? warm : null;
  return <>
    <ol ref={thread} data-action-focus-scope tabIndex={-1} data-coordinator-thread className={cn("relative m-0 list-none px-3 pt-1 pb-2 [overflow-wrap:anywhere] [--gutter:--spacing(6)] [--rail:7px] before:absolute before:top-5 before:bottom-5 before:left-[calc(--spacing(3)+var(--rail))] before:w-px before:bg-rule", empty && "before:hidden")}>
      {empty && <WarmStart warm={empty} />}
      {start > 0 && !earlierOpen && <EarlierRow count={start} reveal={() => toggle(EARLIER, true)} />}
      {rows}
    </ol>
    {viewer.viewer}
  </>;
});
