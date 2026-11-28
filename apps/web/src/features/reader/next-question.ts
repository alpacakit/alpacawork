import { directSubmittedTurn, useSubmittedTurns } from './submitted-turns';
import { readerOutcome, readerTurn, type ReaderSubmission } from './submission';
import { awaitsReaderResult, holdsReaderTurn, observeReaderTurns } from '@/features/coordinator/editor/outbox';
import { useDraftStore } from '@/features/forms/draft-store';
import { i18n } from "@alpacawork/i18n";
import { useWriteIntentStore } from "@/data/write-intent";
import { flyAway, type Flight } from "./departure";
import { createContext, useContext, useEffect, useLayoutEffect } from "react";
import { create } from "zustand";
import { userTurn, type Ball, type HOME_SECTIONS } from "@alpacawork/contract";
import { useEveryTaskIndex, useHomeList, useWorkspaceInfo, useServerTasks } from "@/data/queries";
import type { Task } from "@/data/types";
import { shownInReader, useViewStore } from "@/state/view-store";
import { deviceValue, useDeviceValue } from "@/lib/device-storage";

/**
 * The one way the reader moves on after a question. When the reader answers the task it shows and the
 * operation is saved locally (a send from the input, or Done or Stop from the state report), that card is stamped and flies off,
 * and the reader goes on to the next question waiting on it (a list row's R on the task the reader shows opens its form on
 * that card). An answer given anywhere else (another tab, a list row's keys on another task, a list card) leaves the reader where it is, and a task that stops waiting by itself does not move it either.
 */

/**
 * One opening of the reader on one task. The reader hands it to what it draws (`ReaderCardContext`); an answer
 * started there carries it, and only an answer whose card is still the one shown moves the reader. So an answer from
 * outside the reader, or one whose reply arrives after the reader was closed or turned to another task, moves nothing.
 */
export type ReaderCard = { readonly taskId: string };
export const ReaderCardContext = createContext<ReaderCard | null>(null);
/** The reader's card around the caller, or null outside the reader. Read it when the answer starts. */
export const useReaderCard = () => useContext(ReaderCardContext);

/**
 * What the operation intends: it names the stamp (Send, Done, Stop) and the way the card leaves (a send and
 * Done to the right, Stop down). A send is one kind whether it answers a question or instructs on a review.
 */
export type Answer = NonNullable<ReaderSubmission['answer']>;
/** Local admission, separate from whether a server has confirmed the operation. */
export type ReaderAdmission = "rejected" | "retained" | "retired";

/** The home list's sections whose questions the reader goes on through: Your turn, and Hold when it opened a held one. */
export type Shelf = Extract<(typeof HOME_SECTIONS)[number], "review" | "held">;
/** The Tasks in view on one shelf, in the order the server lists them. */
function useShelfTasks(shelf: Shelf): Task[] {
  // Rows and Tasks from the one projection the list draws: a row never stands on a shelf its Task has already left (the two reads arrive apart).
  const index = useEveryTaskIndex();
  const { rows } = useHomeList();
  const tasks: Task[] = [];
  rows.forEach((row) => {
    const task = row.section === shelf ? index.byId.get(row.taskId) : undefined;
    if (task && (shelf === "held" ? task.state === "held" : !!userTurn(task.ball))) tasks.push(task);
  });
  return tasks;
}

export type Departure = { readonly release?: number; answer: Answer; id: string | null; turn: string; admitted: () => boolean; status: () => "pending" | "confirmed" | "unconfirmed" | "conflict" | "refused" };

type Sitting = {
  departures: Record<string, Departure>;
  outcomeKey: string;
  /** The current home-list order on this shelf, projected without a separate sort. */
  order: string[];
  /** An admitted operation and the list order it saw, before its row can move or leave. */
  sent: { card: ReaderCard; answer: Answer; order: readonly string[] } | null;
  /** An empty bundle reached by this person's send, with one animation to consume. Never restored from server state. */
  emptied: { taskId: string; animate: boolean } | null;
  /** The Task the reader last moved on from, by an answer or Done sent from it: a new record each time. */
  retired: { taskId: string } | null;
  /** Changes when a displayed card is left, even if closing and reopening are batched in one paint. */
  cardVersion: number;
  /** The card the reader shows now. */
  card: ReaderCard | null;
  /** Whose questions the reader goes on through: Your turn, or Hold when it opened a held one. */
  shelf: Shelf;
};

const idle: Sitting = { outcomeKey: JSON.stringify([]), departures: {}, order: [], sent: null, emptied: null, retired: null, cardVersion: 0, card: null, shelf: "review" };
export const useSitting = create<Sitting>(() => idle);

/**
 * The stamped copy still held over the reader, the operation its stamp says was done, and the card the reader moves on
 * to under it (`to`): that move is the answer's own, so the copy stays held over it.
 */
let stamped: { departure: Departure; flight: Flight; to?: string } | null = null;
/** The reader moves on from the answered card to `next`, under its stamped copy (useMoveOn). */
export function movingOn(next: string) { if (stamped) stamped.to = next; }

// A card lasts through operations within the same detail. Only leaving that detail (or explicitly reopening the
// finished deck) ends it. This is shared by every action, and observes navigation before React batches its paints.
useViewStore.subscribe((view, before) => {
  const scopeChanged = view.project !== before.project;
  const left = before.reader.open && (!view.reader.open || view.selected !== before.selected);
  const reopened = view.reader.open && view.reader.opening !== before.reader.opening && useSitting.getState().emptied?.taskId === view.selected;
  // What the person turned to is not held behind the answered card's stamp, and is not the next card coming forward.
  if (stamped && (scopeChanged || left && (!view.reader.open || view.selected !== stamped.to))) stamped.flight.leave(false);
  // A bundle follows the filtered list. Answers from another project cannot contribute to this one's count.
  if (scopeChanged) { stamped = null; useSitting.setState(state => ({ ...idle, cardVersion: state.cardVersion + 1 })); }
  else if (left || reopened) useSitting.setState(state => ({ card: null, cardVersion: state.cardVersion + 1 }));
});

/**
 * The reader shows `card` on `shelf`'s question (null: it asks nothing). Turning by hand to the other shelf begins
 * answering that one afresh; what was answered on the first stays with it. Opening again by hand the task whose card
 * said every question was answered makes it wait once more. Moving on, and an input opened on the card, go on.
 */
export function showCard(card: ReaderCard | null, shelf: Shelf | null, byHand: boolean, waiting: readonly (readonly [id: string, turn: string])[], submitted: readonly string[] = []) {
  useSitting.setState(before => {
    const changed = card !== before.card;
    const next = changed ? shelf ?? before.shelf : before.shelf;
    const state = card && changed && byHand && next !== before.shelf
      ? { ...idle, cardVersion: before.cardVersion } : before;
    const ids = waiting.map(([id]) => id);
    const renewed = new Set(waiting.filter(([id, turn]) => state.departures[id] && state.departures[id].turn !== turn).map(([id]) => id));
    const retired = new Set(submitted);
    const outstanding = waiting.some(([id]) => !retired.has(id));
    const departures = Object.fromEntries(Object.entries(state.departures).filter(([id, each]) => !renewed.has(id)
      && (!returned(each) || waiting.some(([task, turn]) => task === id && turn === each.turn))));
    const ends = outstanding || card && changed && state.emptied?.taskId === card.taskId;
    return { ...state, card, shelf: next, order: ids, departures,
      ...(state.sent && renewed.has(state.sent.card.taskId) ? { sent: null } : {}),
      ...(ends && state.emptied ? roundEnded() : {}) };
  });
  projectDepartures();
}

/**
 * The answered card closes a round: once it goes (a new question came, its task was opened again, or the reader turned
 * to another task), what is answered next is counted afresh, not added to what that card showed. A refused answer
 * taking it away (projectDepartures) does not end the round: the round goes on until that answer is given again.
 */
const roundEnded = (): Pick<Sitting, "emptied" | "departures"> => ({ emptied: null, departures: {} });
export const leaveAnsweredCard = () => useSitting.setState(state => state.emptied ? roundEnded() : state);

/** `card` is the card on screen now: the reader is open on its task, and it is the opening the reader last handed out. */
export function onScreen(card: ReaderCard | null, taskId: string): card is ReaderCard {
  const view = useViewStore.getState();
  return !!card && card.taskId === taskId && shownInReader(view) === taskId && useSitting.getState().card === card;
}

/**
 * The one value that says what a send from the input does. Auto-swipe off (the default), the card stays with its
 * answer shown and the input stays open. Auto-swipe on, the card it was made on is stamped and leaves, the reader goes
 * on to the next question and the input folds. A swipe, Done, Hold, Stop and a card's press finish the card, and always
 * leave. Once turned on or off it holds until it is pressed again, on whatever card: going on to the next card,
 * finishing one, another tab and a reload keep it (kept on this device).
 */
const autoSwipe = deviceValue<boolean>("alpacawork.autoSwipe", { read: (raw) => raw === "on" ? true : raw === "off" ? false : null, write: (on) => on ? "on" : "off" }, false);
export const swipesOnSend = () => autoSwipe.get();
export const useAutoSwipe = () => useDeviceValue(autoSwipe);
export const setAutoSwipe = (on: boolean) => { autoSwipe.set(on); };

/**
 * What writes the next message on the card's turn waits for: one sent on it that serve has not admitted yet (or an
 * explicit operation, holdsReaderTurn), or a direct write that retired the turn. The coordinator's reply is not waited
 * for: it takes messages in order. The send button and the card's choices (which only put answers in the input) read this one.
 */
export function useReaderTurnUnadmitted(taskId: string | null | undefined) {
  const root = useWorkspaceInfo(info => info.root);
  const current = useServerTasks()?.find(each => each.id === taskId);
  const message = useDraftStore(state => !!current && holdsReaderTurn(state.entries, root, readerTurn(current)));
  const direct = useWriteIntentStore(state => !!current && directSubmittedTurn(state.entries, root, readerTurn(current)));
  return message || direct;
}

/** Card controls that write the Task (Done, a swipe, a press's intent) wait for a submission's result (awaitsReaderResult); the automatic deck separately reads the submitted fact. */
export function useReaderTurnHeld(task: Pick<Task, 'id' | 'ball' | 'state' | 'stateLog'>) {
  const root = useWorkspaceInfo(info => info.root);
  const current = useServerTasks()?.find(each => each.id === task.id);
  const conversation = useDraftStore(state => !!current && awaitsReaderResult(state.entries, root, readerTurn(current)));
  const direct = useWriteIntentStore(state => !!current && directSubmittedTurn(state.entries, root, readerTurn(current)));
  return conversation || direct;
}

/**
 * Record only which immutable operation retired this opening, while its task is the user's turn. Its owner supplies all
 * result facts.
 */
export function acceptedInReader(card: ReaderCard | null, taskId: string, ball: Ball | null | undefined, departure: Departure) {
  const state = useSitting.getState(), previous = state.departures[taskId];
  // Deduplicate this opening's animation event. Submission eligibility belongs to the fixed record owners.
  const consumed = previous && readerOutcome(previous.status()) === 'kept'
    && (state.sent?.card === card || state.emptied?.taskId === taskId);
  const shown = onScreen(card, taskId);
  if (!userTurn(ball ?? null) || !shown && !state.order.includes(taskId) || consumed || previous?.id === departure.id) return false;
  if (!shown && !useViewStore.getState().reader.open) return false;
  if (!shown) { useSitting.setState(state => ({ departures: { ...state.departures, [taskId]: departure } })); return false; }
  const flight = flyAway(departure.answer, ({ send: i18n.t("reader:nextQuestion.sent"), done: i18n.t("reader:nextQuestion.done"), stop: i18n.t("reader:nextQuestion.stopped"), hold: i18n.t("reader:nextQuestion.held") })[departure.answer], departure.release);
  stamped = flight && { departure, flight };
  useSitting.setState(state => ({ departures: { ...state.departures, [taskId]: departure }, sent: { card, answer: departure.answer, order: state.order } }));
  projectDepartures();
  return true;
}

const returned = (departure: Departure) => readerOutcome(departure.status()) === 'returned';
/** The reader goes on to `id` as the sitting's next card: a step in the browser's history that Back returns from. */
export const turnToCard = (id: string) => useViewStore.getState().openTask(id, { reader: true, pane: 'task', turnSequence: true });

/** Publish changed receipt facts and cancel the empty-bundle event on failure; recovery has one existing notice. */
export function projectDepartures() {
  let restore: string | undefined;
  useSitting.setState(state => {
    const entries = Object.entries(state.departures);
    const outcomeKey = JSON.stringify(entries.map(([id, each]) => [id, each.id, each.turn, each.admitted(), each.status()]));
    const returning = entries.filter(([, each]) => returned(each)).map(([id]) => id);
    const emptied = returning.length ? null : state.emptied;
    if (state.emptied && returning.length) {
      const view = useViewStore.getState();
      if (shownInReader(view) === state.emptied.taskId)
        restore = state.order.find(id => returning.includes(id)) ?? returning[0];
    }
    return outcomeKey === state.outcomeKey && emptied === state.emptied ? state : { outcomeKey, emptied,
      ...(state.sent && returning.includes(state.sent.card.taskId) ? { sent: null } : {}) };
  });
  if (restore) turnToCard(restore);
}
useWriteIntentStore.subscribe(projectDepartures);

/** The only way to finish a bundle: consume an operation started on this opening, using the questions still in view. */
export function moveOn(waiting: readonly string[]) {
  const { sent } = useSitting.getState();
  if (!sent) return null;
  const from = sent.card.taskId;
  if (!onScreen(sent.card, from)) { useSitting.setState({ sent: null }); return null; }
  const next = upNext(sent.order, waiting, from)[0] ?? null;
  useSitting.setState({ sent: null, emptied: next ? null : { taskId: from, animate: true }, retired: { taskId: from } });
  projectDepartures();
  return next;
}

/** Count what the person submitted, rather than waiting for the AI to write it. Receipts own admission and failure. */
export function submittedAnswers(state = useSitting.getState()) {
  const answers = Object.values(state.departures);
  return state.emptied && answers.length && answers.every(each => !returned(each)) ? answers : null;
}

/** Animation belongs to the empty-bundle event, not a component mount or a later server update. */
export function takeCompletionAnimation(taskId: string) {
  const { emptied } = useSitting.getState();
  if (emptied?.taskId !== taskId || !emptied.animate || !submittedAnswers()) return false;
  useSitting.setState({ emptied: { taskId, animate: false } });
  return true;
}


/**
 * The questions after `from`, in the order the reader goes on through them: those of `waiting` (useWaiting has left out
 * those answered here) below it in the supplied list order, then those above it from the top. The first is the next
 * question; the reader reads the first two ahead (useReaderReads).
 */
export function upNext(order: readonly string[], waiting: readonly string[], from: string): string[] {
  const place = [...order, ...waiting.filter(id => !order.includes(id))];
  const at = place.indexOf(from);
  const left = place.filter(id => id !== from && waiting.includes(id));
  return [...left.filter(id => place.indexOf(id) > at), ...left.filter(id => place.indexOf(id) < at)];
}

/** The questions still waiting on this shelf, in the home list's current order, without those answered here. */
export function useWaiting(): Task[] {
  const shelf = useSitting(state => state.shelf);
  const { submitted } = useSubmittedTurns();
  return useShelfTasks(shelf).filter(task => !submitted(task));
}

/** Project the current home-list order before the displayed card can accept an answer. */
export function useShowCard(card: ReaderCard | null, shelf: Shelf | null, byHand: boolean) {
  const server = useServerTasks();
  const open = useViewStore(state => state.reader.open);
  const sittingShelf = useSitting(state => state.shelf);
  const shownCard = useSitting(state => state.card);
  const activeShelf = card !== shownCard ? shelf ?? sittingShelf : sittingShelf;
  const tasks = useShelfTasks(activeShelf);
  const ids = JSON.stringify(tasks.map(task => [task.id, userTurn(task.ball)?.key ?? ""]));
  const { root, entries, submitted: isSubmitted } = useSubmittedTurns();
  const submitted = JSON.stringify(tasks.filter(isSubmitted).map(task => task.id));
  useEffect(() => { if (server) observeReaderTurns(root, server); }, [root, server, entries]);
  useLayoutEffect(() => {
    if (!open) { useSitting.setState(state => ({ ...idle, cardVersion: state.cardVersion })); return; }
    if (!server) return;
    showCard(card, shelf, byHand, JSON.parse(ids) as [string, string][], JSON.parse(submitted));
  }, [card, ids, submitted, open, shelf, byHand, server]);
}
