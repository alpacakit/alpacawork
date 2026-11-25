import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { readerHasTask } from "@/data/queries";
import { useWorkspaceStore } from "@/data/workspace-store";
import { readScheduler } from "@/data/read-scheduler";
import { duration, easing, reducedMotion, rise } from "@/lib/motion";
import { untilLeaving } from "./departure";
import { useViewStore } from "@/state/view-store";
import { closeReaderStep } from "@/state/history-step";
import { listNeighbours, useListNavigation } from "@/features/tree/list-navigation";
import { leaveAnsweredCard, moveOn, movingOn, submittedAnswers, takeCompletionAnimation, turnToCard, upNext, useSitting, useWaiting, type Answer, type Departure } from "./next-question";

/**
 * Kept once, by the reader: when an operation is admitted here, its copy leaves and the reader moves to the next
 * question (a step in the browser's history, so Back returns to the answered one and moves nothing again), or, with
 * none left, on the answered card saying so.
 */
export function useMoveOn() {
  const waiting = useWaiting();
  const sent = useSitting(state => state.sent);
  const selected = useViewStore(state => state.selected);
  useLayoutEffect(() => {
    if (!sent) return;
    const next = moveOn(waiting.map(task => task.id));
    if (next) { movingOn(next); turnToCard(next); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent]);
  useEffect(() => {
    if (useSitting.getState().emptied?.taskId !== selected) leaveAnsweredCard();
  }, [selected]);
}

/**
 * Kept once, by the reader: what it reads ahead, told to the one read scheduler (read-scheduler). A task opened in it,
 * whichever way (a row, a link, Back), is read as it is opened, before the screen draws the opening; the next displayed
 * row and the next two cards an answer can bring forward are read after it. The reader's own Queries join these reads.
 */
export function useReaderReads() {
  const client = useQueryClient();
  const workspace = useWorkspaceStore();
  useEffect(() => useViewStore.subscribe((view, before) => {
    const id = view.reader.open && view.reader.pane !== "analysis" ? view.selected : null;
    if (!id || id === before.selected && before.reader.open && view.reader.pane === before.reader.pane) return;
    if (!readerHasTask(client, workspace.getState(), id)) return;
    readScheduler(client)?.opened(id, view.reader.pane === "task");
  }), [client, workspace]);
  const waiting = useWaiting();
  const selected = useViewStore(state => state.selected);
  const open = useViewStore(state => state.reader.open && state.reader.pane !== "analysis");
  const { order } = useSitting();
  const list = useListNavigation();
  const inTurn = open && !!selected && waiting.some(task => task.id === selected);
  const targets = open && selected ? [listNeighbours(list.ids, selected).next,
    ...(inTurn ? upNext(order, waiting.map(task => task.id), selected).slice(0, 2) : [])] : [];
  const key = [...new Set(targets.filter((id): id is string => !!id))].join(" ");
  useEffect(() => { if (key) readScheduler(client)?.next(key.split(" ")); }, [key, client]);
}

/**
 * After the last card has flown, the answered card says every question was answered: a ring cut into one
 * piece per answered task fills piece by piece, a tick draws itself inside and the ring settles with a small overshoot;
 * then how many tasks ended with each kind of answer (each task once, by the answer given to it last; together they
 * are the ring's pieces), and Close, which has the focus so Enter closes. It starts as the flying card is half gone (after its stamp's hold), so it is seen. With reduced motion it only fades in.
 */
/** The completion surface and the region it covers must share this one visibility decision. */
export function useEmptyDeck(taskId: string | undefined) {
  const sitting = useSitting();
  return sitting.emptied?.taskId === taskId ? submittedAnswers(sitting) : null;
}

/** Only whether the deck is empty on this task, for what the completed card covers. */
export const useDeckEmptied = (taskId: string | undefined) =>
  useSitting(state => state.emptied?.taskId === taskId && !!submittedAnswers(state));

export function EmptyDeck({ taskId }: { taskId: string }) {
  const answers = useEmptyDeck(taskId);
  return answers ? <AllAnswered taskId={taskId} answers={answers} /> : null;
}

/** Assistive progress only: pending AI processing never gates submission confirmation. */
export function ReaderOperationStatus() {
  const { t } = useTranslation("reader");
  const sitting = useSitting();
  const pending = Object.values(sitting.departures).filter(each => each.status() === "pending").length;
  return pending ? <span className="sr-only" role="status" aria-live="polite">{t("recovery.pending", { count: pending })}</span> : null;
}

/** Up to this many answers the ring has a piece for each; past it, the ring is whole. */
const PIECES = 24;
const RING = { r: 50, width: 8 };
const ROUND = 2 * Math.PI * RING.r;

function AllAnswered({ taskId, answers }: { taskId: string; answers: Departure[] }) {
  const { t } = useTranslation("reader");
  const shelf = useSitting(state => state.shelf);
  const pieces = answers.length <= PIECES ? answers.length : 1;
  const gap = pieces > 1 ? 7 : 0, piece = ROUND / pieces - gap;
  const ring = useRef<SVGSVGElement>(null), tick = useRef<SVGPathElement>(null), words = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!takeCompletionAnimation(taskId)) return;
    const start = untilLeaving() + duration("fling") / 2;
    if (reducedMotion()) { for (const element of [ring.current, words.current, close.current]) rise(element, start); return; }
    // The pieces fill one after another, fast apart at most, the last one done within two slow lengths: many answers do
    // not make it longer.
    const step = pieces > 1 ? Math.min(duration("fast"), (duration("slow") * 2 - duration("base")) / (pieces - 1)) : 0;
    ring.current?.querySelectorAll("[data-ring-piece]").forEach((each, at) => each.animate(
      [{ strokeDasharray: `0 ${ROUND}` }, { strokeDasharray: `${piece} ${ROUND - piece}` }],
      { duration: duration("base"), delay: start + at * step, easing: easing("out"), fill: "both" }));
    const full = start + (pieces - 1) * step + duration("base");
    tick.current?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: duration("base"), delay: full, easing: easing("out"), fill: "both" });
    ring.current?.animate([{ scale: 1 }, { scale: 1.08 }, { scale: 1 }], { duration: duration("slow"), delay: full, easing: easing("pop") });
    rise(words.current, full + duration("fast"));
    rise(close.current, full + duration("fast") * 2);
  }, [taskId, pieces, piece]);
  const said = { send: t("nextQuestion.kind.send"), done: t("nextQuestion.kind.done"), stop: t("nextQuestion.kind.stop"), hold: t("nextQuestion.kind.hold") };
  const totals: Record<Answer, number> = { send: 0, done: 0, stop: 0, hold: 0 };
  for (const answer of answers) totals[answer.answer]++;
  const counts = (Object.keys(said) as Answer[]).map(kind => [kind, totals[kind]] as const).filter(([, n]) => n > 0);
  return (
    <div data-empty-deck className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-lit px-6 pb-[10%] text-center">
      <svg ref={ring} data-answered-ring={pieces} viewBox="0 0 120 120" className="size-28 flex-none" aria-hidden="true">
        <circle cx="60" cy="60" r={RING.r} fill="none" stroke="var(--line)" strokeWidth={RING.width} />
        <g transform="rotate(-90 60 60)">
          {Array.from({ length: pieces }, (_, at) => <circle key={at} data-ring-piece cx="60" cy="60" r={RING.r} fill="none" stroke="var(--done)"
            strokeWidth={RING.width} strokeDasharray={`${piece} ${ROUND - piece}`} strokeDashoffset={-(at * ROUND / pieces + gap / 2)} />)}
        </g>
        <path ref={tick} d="M42 61 l12 12 l25 -27" pathLength={1} fill="none" stroke="var(--done)" strokeWidth={RING.width}
          strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1" />
      </svg>
      <div ref={words}>
        <p className="m-0 text-xl font-semibold text-ink">{t(shelf === "held" ? "nextQuestion.allAnsweredHeld" : "nextQuestion.allAnswered")}</p>
        <p data-answered-count className="mt-type-close mb-0 text-sm text-muted tabular-nums">
          {counts.map(([kind, n]) => t("nextQuestion.countPart", { word: said[kind], n })).join(" · ")}</p>
      </div>
      <Button ref={close} autoFocus className="min-h-control-lg px-8 narrow:min-h-11" onClick={closeReaderStep}>{t("nextQuestion.close")}</Button>
    </div>
  );
}
