import { Fragment, memo, useCallback, useEffect, useMemo, useState, useRef, type ReactNode } from "react";
import { COORDINATOR_HISTORY_LIMIT } from "@/data/coordinator-history";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { CopyButton } from "@/components/ui/copy-button";
import { textClip } from "@/lib/clipboard";
import { Icon } from "@/components/ui/icon";
import { ON_DISC, ON_RAIL, TimelineMark } from "@/components/ui/timeline-mark";
import { useWriteDisabled } from "@/data/queries";
import type { CoordinatorReset, CoordinatorTurn } from "@/data/coordinator";
import { MarkdownBody } from "@/features/reader/MarkdownBody";
import { useImageViewer } from "@/features/reader/ImageSlider";
import { followTask } from "./follow-task";
import { cn } from "@/lib/utils";
import { useConversation } from "./coordinator";
import { opening } from "./read-boundary";
import { firstSentence } from "./foot";
import { answerBodyFiles, MessageFiles, type OpenMessageImages } from "./MessageFiles";
import { SentMessage, useMessageCopy, useMessageParts } from "./SentMessage";
import { Attempts, coordinatorErrorReason, Thinking, TurnWork } from "./parts";
import { partitionTurns, useShownConversation, type LocalTurn, type SentTurn } from "./shown";
import { ReplyLabel } from './ReplyLabel';
import { messageTime } from './message-time';
import { replyInDraft } from './editor/draft';
import { useReplyNavigationOwner } from './reply-navigation';
import { keepThreadPosition } from './thread-position';
import { Button } from '@/components/ui/button';
import { MessageDelivery } from "./MessageDelivery";
import { LINE_ACTION } from "./delivery-presentation";
import { useActionFocus } from "./use-action-focus";
import { ConversationStart } from "./ConversationStart";
import { ResetLine } from "./ResetLine";
import { useEarlierHistory } from "./earlier-history";

/**
 * A message's head line: who and when, and what it was sent with. `mark` is its turn's mark on the rail: drawn here and
 * centred on this line (its first, when the line wraps), so every kind of mark sits level with "you" and the time
 * whatever the text size. `more`: what follows on the line (a folded exchange's counts, its open or fold control).
 */
function MessageHead({ turn, mark, more }: { turn: SentTurn; mark?: ReactNode; more?: ReactNode }) {
  const { t, i18n } = useTranslation("ui");
  return <div className="relative mb-type-close flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted">
    {/* The mark hangs on the rail from "you", boxed to its capitals, and centres on them. */}
    <span className="relative font-medium text-ink cap-box">
      {mark && <span data-coordinator-mark className={`${ON_RAIL} -ml-(--gutter) inset-y-0 flex items-center`}>{mark}</span>}{t("coordinatorCard.you")}</span>
    <time dateTime={turn.at} className="tabular-nums">{messageTime(turn.at, i18n.language)}</time>
    {turn.status === "joined" && <span>· {t("coordinatorCard.sentDuringWork")}</span>}
    {more}
  </div>;
}

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
        <span className="cap-box font-medium text-ink">{t("coordinatorCard.title")}</span>
        {turn.answeredAt && <><time dateTime={turn.answeredAt} className="cap-box tabular-nums">{messageTime(turn.answeredAt, i18n.language)}</time>
          <span className="cap-box">· {seconds < 60 ? t("coordinatorCard.seconds", { count: seconds }) : t("coordinatorCard.minutes", { count: Math.round(seconds / 60) })}</span></>}
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
  return <><div role="alert" className="text-error">{t("coordinatorCard.failed", { reason: coordinatorErrorReason(turn) })}
    {turn.status === "failed" && !turn.attachments.length && !turn.sentAgain && <button type="button" disabled={disabled} className={LINE_ACTION}
      onClick={() => retry(turn)}>{t("coordinatorCard.retry")}</button>}
    {turn.failure && <span data-coordinator-failure-message className="mt-type-close block whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{turn.failure.message}</span>}</div></>;
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
  if (turn.status === "queued") return <span role="status" className="cap-box text-muted motion-safe:animate-pulse">{t("coordinatorCard.posting")}</span>;
  if (turn.status === "running") return <Thinking turn={turn} />;
  const [text, tone] = turn.status === "succeeded" ? [turn.answer ? firstSentence(turn.answer) : "", "text-ink"]
    : [t("coordinatorCard.failed", { reason: coordinatorErrorReason(turn) }), "text-error"];
  return <span className={cn("min-w-0 flex-1 cap-truncate", tone)}>{text}</span>;
}

/* Hallmark · component: one exchange of the conversation (a message, what joined it, and its answer) · states: open (all of
 * it) · folded (the message's first two lines and the answer's first sentence; a press opens it) */
/**
 * The history's entrance, just above the opening's latest exchange, counted in messages. A press opens the history and
 * the entrance leaves: what it stood for comes in where it was, the latest exchange staying where it is, so the end of
 * the history shows in its place. The history folds again with the next opening of the conversation.
 */
function EarlierRow({ count, reveal }: { count: number; reveal: () => void }) {
  const { t } = useTranslation("ui");
  const focus = useActionFocus();
  return <li {...focus} data-earlier="folded" className="relative scroll-mt-14 border-b border-rule pl-(--gutter)">
    <button type="button" aria-expanded={false} onClick={reveal}
      className="group flex min-h-11 w-full items-center gap-1.5 py-2 text-left text-xs text-muted narrow:min-h-12">
      <span className="relative font-medium text-ink cap-box">
        <span className={`${ON_RAIL} -ml-(--gutter) inset-y-0 flex items-center`}><Icon name="unfold" className={cn("size-3.5 text-muted", ON_DISC)} /></span>{t("coordinatorCard.earlierCount", { count })}</span>
      <span className="ml-auto rounded-sm px-2 cap-box underline decoration-line underline-offset-3 group-hover:text-ink group-hover:decoration-ink">
        {t("coordinatorCard.exchangeOpen")}</span>
    </button>
  </li>;
}
/**
 * How close to the top of what is read the reader comes before the next page is read: once the message this many from
 * the top is in sight (or passed), the next page is asked for. A page brings more than this, so each page read leaves
 * the next one waiting for the reader to come near it again, rather than several being read at once on a tall screen.
 * It is far enough ahead that a reader flinging on to the top usually gets there after the page; one who gets there
 * first finds the thread still reading above (data-reading-above), which a phone's sheet does not take for its top to
 * pull down from.
 */
const READ_AHEAD = 40;
/**
 * At the top of the opened history, while older turns are still to be read: a press reads the next page of them, and
 * so does the reader coming within READ_AHEAD messages of it. It says it is reading meanwhile, and that it could not,
 * with the same press to try again. Once the history holds as many as the screen keeps, it says nothing further back
 * is read.
 */
function ReadOlder({ held, full, reading, failed, read }: { held: number; full: boolean; reading: boolean; failed: boolean; read: () => void }) {
  const { t } = useTranslation("ui");
  const place = useRef<HTMLLIElement>(null);
  const latest = useRef(read);
  latest.current = read;
  const waiting = !full && !reading && !failed;
  // Watched once per wait: a wait ends with the read it starts, and the next begins with what that read brought
  // (`held`), so the message watched is READ_AHEAD from the top of what is read now.
  useEffect(() => {
    const row = place.current, messages = row?.closest("[data-coordinator-thread]")?.querySelectorAll("[data-coordinator-message]");
    const mark = messages?.[Math.min(READ_AHEAD, messages.length) - 1];
    if (!waiting || !row || !mark || typeof IntersectionObserver === "undefined") return;
    let asked = false;
    // In sight or below it: the reader has come that far.
    const sight = new IntersectionObserver(entries => {
      if (asked || !entries.some(entry => entry.isIntersecting)) return;
      asked = true; latest.current();
    }, { root: row.closest("[data-card-scroll]"), rootMargin: "0px 0px 1000000px 0px" });
    sight.observe(mark);
    return () => sight.disconnect();
  }, [waiting, held]);
  if (full) return <li ref={place} data-earlier-more="full" className="relative border-b border-rule pl-(--gutter)">
    <p role="status" className="m-0 flex min-h-11 items-center py-2 text-xs text-muted narrow:min-h-12">
      {t("coordinatorCard.earlierLimit", { limit: COORDINATOR_HISTORY_LIMIT })}</p>
  </li>;
  // Pressed while it reads, it does nothing, and keeps the focus of whoever pressed it.
  return <li ref={place} data-earlier-more={reading ? "reading" : failed ? "failed" : ""} className="relative border-b border-rule pl-(--gutter)">
    <button type="button" aria-disabled={reading || undefined} onClick={() => { if (!reading) read(); }}
      className="group flex min-h-11 w-full items-center gap-1.5 py-2 text-left text-xs text-muted aria-disabled:cursor-default narrow:min-h-12">
      <span className="relative cap-box">
        <span className={`${ON_RAIL} -ml-(--gutter) inset-y-0 flex items-center`}><Icon name="up" className={cn("size-3.5 text-muted", ON_DISC)} /></span>
        <span role={reading || failed ? "status" : undefined} className={cn(failed && "text-error", reading && "motion-safe:animate-pulse")}>
          {reading ? t("coordinatorCard.earlierReading") : failed ? t("coordinatorCard.earlierFailed") : null}</span></span>
      <span className="ml-auto rounded-sm px-2 cap-box underline decoration-line underline-offset-3 group-hover:text-ink group-hover:decoration-ink group-aria-disabled:no-underline">
        {t("coordinatorCard.earlierMore")}</span>
    </button>
  </li>;
}
/**
 * One message of the thread, open or folded, sent from here or serve's: drawn again only when what it shows changes
 * (its turn, whether it is open or waits, what joined it, the day it is read on), not when another row or the
 * conversation's usage does. One component for both, so a message sent from here keeps its row when serve takes it.
 */
const NONE_TURNS: readonly CoordinatorTurn[] = [], NO_SKILLS: readonly { name: string }[] = [], NO_RESETS: readonly CoordinatorReset[] = [];
const ThreadRow = memo(function ThreadRow({ served, local, waiting, open, joined, skills, retry, toggle, viewer }: {
  /** Serve's turn, or (`local`) a message sent from here that serve has not shown yet. */
  served?: CoordinatorTurn; local?: LocalTurn; waiting: boolean; open: boolean;
  joined: readonly CoordinatorTurn[]; skills: readonly { name: string }[]; retry: (turn: CoordinatorTurn) => void;
  toggle: (id: string, open: boolean) => void; viewer: OpenMessageImages; clock?: string }) {
  const { t, i18n } = useTranslation("ui");
  if (local) {
    const turn = local;
    // The same request key survives admission; recoverable refused words have their own identity.
      return <li data-action-focus-place tabIndex={-1} data-coordinator-local={turn.stage} data-coordinator-waiting={waiting ? turn.id : undefined} data-coordinator-message={turn.id} className="relative animate-rise border-b border-rule py-3 pl-(--gutter) last:border-b-0">
        <Exchange key={EXCHANGE} turn={turn} open={viewer} skills={skills} joined={NONE}
          mark={<TimelineMark kind={turn.stage === "refused" ? "error" : "request"} tone={turn.stage === "refused" ? "error" : "quiet"} />}
          reply={<MessageDelivery turn={turn} local={turn} />} />
      </li>;
  }
  const turn = served!;
    const mark = <TimelineMark kind={turn.status === "running" ? "start" : turn.status === "failed" ? "error" : "request"}
      tone={turn.status === "running" ? "working" : turn.status === "failed" ? "error" : "quiet"} />;
    // Said in words, not an arrow: an arrow on the conversation is what closes it (its ∨ at the top right). Taller than
    // its line, it overhangs it evenly, so the line keeps its height.
    const button = <button type="button" data-exchange-toggle aria-expanded={open}
      aria-label={t(open ? "coordinatorCard.foldExchange" : "coordinatorCard.openExchange", { time: messageTime(turn.at, i18n.language) })}
      onClick={() => toggle(turn.id, !open)} className="-my-[calc((--spacing(7)-1lh)/2)] ml-auto flex h-7 flex-none items-center self-center rounded-sm px-2 text-xs text-muted underline decoration-line underline-offset-3 hover:bg-hover hover:text-ink hover:decoration-ink narrow:-my-[calc((--spacing(10)-1lh)/2)] narrow:h-10">
      {t(open ? "coordinatorCard.exchangeFold" : "coordinatorCard.exchangeOpen")}</button>;
    return <li data-action-focus-place tabIndex={-1} data-coordinator-turn={turn.status} data-coordinator-waiting={turn.waiting ? turn.id : undefined} data-coordinator-message={turn.id} data-exchange={open ? "open" : "folded"}
      className="relative animate-rise border-b border-rule py-3 pl-(--gutter) last:border-b-0">
      {open ? <Exchange key={EXCHANGE} turn={turn} open={viewer} skills={skills} joined={joined} mark={mark} fold={turn.waiting ? undefined : button}
        reply={<><TurnWork turn={turn} />{delivering(turn) ? <MessageDelivery turn={turn} /> : <Answer turn={turn} retry={retry} />}<Attempts turn={turn} /></>} />
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
        <div data-exchange-outcome className="mt-type-close flex min-h-lh min-w-0 items-center gap-1.5">
          <Icon name="right" className="size-3 flex-none text-muted" /><Outcome turn={turn} />
        </div>
      </div>}
    </li>;
});
/** The hand's key for the earlier row (an exchange's is its ID). */
const EARLIER = "earlier";

/** Latest exchange and new arrivals stay shown; older history has one independent fold. */
export const CoordinatorThread = memo(function CoordinatorThread({ turns: recent, retry, skills = NO_SKILLS, clock }: {
  // The Card's render remains an opportunity to notice a local day/zone change,
  // even when this memo's conversation inputs are otherwise unchanged.
  turns: CoordinatorTurn[]; retry: (turn: CoordinatorTurn) => void; skills?: readonly { name: string }[]; clock?: string;
}) {
  const { t, i18n } = useTranslation("ui");
  const viewer = useImageViewer();
  // Each fact the thread draws from, by itself: the usage figure changes none of them.
  const served = useConversation(useShallow(state => ({ id: state.conversation?.id, earlier: state.conversation?.earlier, resets: state.conversation?.resets })));
  const root = useConversation(state => state.root);
  const taken = useConversation(state => state.opening);
  const scope = useConversation(state => state.conversation?.id);
  // What is opened or folded by hand belongs to one opening.
  const [hands, setHands] = useState<{ of?: number; map: ReadonlyMap<string, boolean> }>({ of: taken?.id, map: new Map() });
  if (hands.of !== taken?.id) setHands({ of: taken?.id, map: new Map() });
  const hand = hands.of === taken?.id ? hands.map : new Map<string, boolean>();
  const setHand = (next: (map: ReadonlyMap<string, boolean>) => ReadonlyMap<string, boolean>) => setHands(state => ({ of: state.of, map: next(state.map) }));
  const earlierOpen = hand.get(EARLIER) ?? false;
  // Turns older than the snapshot's, serve's window ending where the snapshot starts, read once the history is open.
  const earlier = useEarlierHistory(root, served.id ?? null, served.earlier ?? null, earlierOpen, recent, served.resets ?? NO_RESETS);
  const shown = useShownConversation(recent);
  // The window and the snapshot are joined by ID in serve's order (the window first), then grouped once: a message
  // sent into another across the snapshot's first turn stands under it.
  const turns = useMemo(() => {
    if (!earlier.turns.length) return recent;
    const here = new Set(recent.map(turn => turn.id));
    return [...earlier.turns.filter(turn => !here.has(turn.id)), ...recent];
  }, [earlier.turns, recent]);
  const grouped = useMemo(() => turns === recent ? null : partitionTurns(turns), [turns, recent]);
  const work = grouped?.thread ?? shown.thread;
  const joinedTo = grouped?.joined ?? shown.joined;
  // The store's opening (coordinator.ts owns when it is taken); drawn outside one, as an opening of what is here would be.
  const opened = taken ?? opening(work);
  // History folds at the opening's latest exchange; read facts never change this boundary.
  const start = Math.max(0, work.findIndex(turn => turn.id === opened.latest));
  const thread = useRef<HTMLOListElement>(null);
  // One function for every row's press, so a row is not drawn again for a new one.
  const toggle = useCallback((id: string, open: boolean) => {
    if (thread.current) keepThreadPosition(thread.current);
    setHands(state => ({ of: state.of, map: new Map(state.map).set(id, open) }));
  }, []);
  const asked = useConversation(state => state.asked);
  useReplyNavigationOwner(thread, scope, asked, id => {
    // Words sent from here that serve has not taken yet are drawn already, at the end.
    if (shown.tail.some(row => row.kind === 'local' && row.turn.id === id)) return 'here';
    // One not read yet is read first, a page at a time from the oldest here, until it is here or the first turn is.
    if (!work.some(turn => turn.id === id)) {
      if (earlier.reading) return 'later';
      if (!earlier.more || earlier.failed) return 'gone';
      // Opened, the history reads its first page; open, the next one.
      if (earlierOpen) void earlier.readMore(); else setHand(map => new Map(map).set(EARLIER, true));
      return 'later';
    }
    setHand(map => new Map(map).set(EARLIER, true).set(id, true));
    return 'here';
  });
  const readOlder = () => { if (thread.current) keepThreadPosition(thread.current); void earlier.readMore(); };
  // Where the coordinator started again: before the message it started with, or at the end until there is one. A message
  // drawn as no row of its own (sent into another, or sent again in its place) leaves its line before the next row in
  // serve's order, so a line is never folded away with it.
  const resets = useMemo(() => {
    const at = new Map<string | null, CoordinatorReset[]>(), all = [...earlier.resets, ...served.resets ?? []];
    if (!all.length) return at;
    // One walk back through serve's order: for each message, the first row drawn at or after it.
    const drawn = new Set([...work.map(turn => turn.id), ...shown.tail.map(row => row.turn.id)]), rowAt = new Map<string, string | null>();
    let next: string | null = null;
    for (let index = turns.length - 1; index >= 0; index--) {
      const id = turns[index]!.id;
      if (drawn.has(id)) next = id;
      rowAt.set(id, next);
    }
    const ids = new Set<string>();
    for (const reset of all) {
      if (ids.has(reset.id)) continue;
      ids.add(reset.id);
      const key = reset.beforeRequestId === null ? null : rowAt.get(reset.beforeRequestId) ?? null;
      at.set(key, [...at.get(key) ?? [], reset]);
    }
    return at;
  }, [earlier.resets, served.resets, turns, work, shown.tail]);
  const resetLines = (id: string | null) => resets.get(id)?.map(reset => <ResetLine key={reset.id} reset={reset} />) ?? null;
  const tailStart = work.length;
  // Folded, the history is counted whole: the turns of the snapshot before its latest exchange and those before it.
  const count = Math.max(0, shown.thread.findIndex(turn => turn.id === opened.latest)) + (served.earlier?.count ?? 0);
  const entrance = count > 0 && !earlierOpen && <EarlierRow count={count} reveal={() => toggle(EARLIER, true)} />;
  const rows = [...work.map(turn => ({ kind: 'server' as const, turn })), ...shown.tail].map((row, at) => {
    // Lines of a reset stand before the message it started with; one with none yet, before what is still on its way.
    const lines = at === tailStart ? <>{resetLines(null)}{resetLines(row.turn.id)}</> : at >= start || earlierOpen ? resetLines(row.turn.id) : null;
    return <Fragment key={row.kind === 'local' && row.turn.stage === "refused" ? `refused:${row.turn.id}` : row.turn.id}>{at === start && entrance}{lines}{drawRow(row, at)}</Fragment>;
  });
  function drawRow(row: { kind: 'server'; turn: CoordinatorTurn } | (typeof shown.tail)[number], at: number) {
    if (row.kind === 'local')
      return <ThreadRow local={row.turn} waiting={shown.localWaiting.includes(row.turn)} open joined={NONE_TURNS} skills={skills} retry={retry} toggle={toggle} viewer={viewer.open} clock={clock} />;
    // Hidden history has no row yet: build its labels and messages only when it is opened.
    if (at < start && !earlierOpen) return null;
    const turn = row.turn;
    return <ThreadRow served={turn} waiting={!!turn.waiting} open={turn.waiting || (hand.get(turn.id) ?? at >= start)} joined={joinedTo.get(turn.id) ?? NONE_TURNS}
      skills={skills} retry={retry} toggle={toggle} viewer={viewer.open} clock={clock} />;
  }
  // The rail runs through each turn's gutter, its 1px line from 7px in (--rail, its left edge), so it stays on whole
  // pixels; a turn's mark stands on it from its head, a gutter further in. A word with no place to fold (a path, an
  // address, a file's name) folds at any letter where it would outrun the conversation, as in the reader.
  // Empty is no message at all: the first one sent stands in the greeting's place as any message does.
  const empty = !!served.id && !work.length && !shown.tail.length && !served.earlier;
  return <>
    <ol ref={thread} data-action-focus-scope tabIndex={-1} data-coordinator-thread data-reading-above={earlierOpen && earlier.reading || undefined} className={cn("relative m-0 list-none px-3 pt-1 pb-2 [overflow-wrap:anywhere] [--gutter:--spacing(6)] [--rail:7px] before:absolute before:top-5 before:bottom-5 before:left-[calc(--spacing(3)+var(--rail))] before:w-px before:bg-rule", empty && "before:hidden")}>
      {empty && <ConversationStart />}
      {earlierOpen && (earlier.more || earlier.full) && <ReadOlder held={earlier.turns.length} full={earlier.full} reading={earlier.reading} failed={earlier.failed} read={readOlder} />}
      {rows}
      {!rows.length && entrance}
      {!shown.tail.length && resetLines(null)}
    </ol>
    {viewer.viewer}
  </>;
});
