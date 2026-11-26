import { draftKey, updateDraft, discardDraft, useDraftStore } from '../src/features/forms/draft-store';
import { freeze, returnReaderSubmission, outgoingKey, reconcileOutbox } from '../src/features/coordinator/editor/outbox';
import { readerTurn } from '../src/features/reader/submission';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import * as departureMotion from '../src/features/reader/departure';
import { textDocument } from '../src/features/coordinator/editor/document';
import { openInput } from '../src/state/open-input';
import { afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { readScheduler, startReadScheduler } from "../src/data/read-scheduler";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { userTurn } from "@alpacawork/contract";
import { isFinished } from "@alpacawork/contract/branch";
import type { CoordinatorConversation, CoordinatorMessageInput, CoordinatorResult } from "@alpacawork/contract/coordinator";
import { Reader } from "../src/features/reader/Reader";
import { EmptyDeck } from "../src/features/reader/NextQuestion";
import { TaskActionSlot } from "../src/features/coordinator/task-action-slot";
import { CoordinatorInput } from "../src/features/coordinator/CoordinatorInput";
import { CoordinatorCard } from "../src/features/coordinator/CoordinatorCard";
import { useInputDraft } from "../src/features/coordinator/editor/draft";
import { inlines } from "../src/features/coordinator/editor/document";
import { useConversation } from "../src/features/coordinator/coordinator";
import { useTitleKeys } from "../src/features/forms/title-keys";
import type { Task } from "../src/data/types";
import { Toaster } from "../src/components/ui/toaster";
import { notify, useToasts } from "../src/lib/notify";
import { acceptedInReader, projectDepartures, upNext, useSitting, useWaiting, useShowCard, type Answer } from "../src/features/reader/next-question";
import { duration } from "../src/lib/motion";
import type { ReaderCard } from "../src/features/reader/next-question";
import { useViewStore } from "../src/state/view-store";
import { queryClient } from "../src/data/query-client";
import { TestWorkspace, homeFixture, dto, headOf, logEntry, screenData, taskFixture, tree, userBall, type TaskFixture } from "./fixtures";

import { problemResponse } from "./problem";

/**
 * Answering the question the reader shows sends its card off stamped and goes on to the next question
 * waiting on the reader. A press goes to the coordinator; its card leaves once serve holds the message, and what the
 * coordinator then did decides whether it was answered (the Task moved on) or comes back (it did not).
 */
const confirmedAnswers = () => Object.entries(useSitting.getState().departures).filter(([, each]) => each.status() === "confirmed").map(([id]) => id);

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });

type Animation = { target: Element; keyframes: Keyframe[]; options?: number | KeyframeAnimationOptions };
let animations: Animation[] = [];
const reduce = (on: boolean) => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ ...original(query), matches: on && query.includes("reduce") })) as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
};
beforeEach(() => {
  // These deck tests keep mock animations unresolved to inspect them; gesture shielding has dedicated unit/e2e coverage.
  vi.spyOn(departureMotion, 'readerActionsHeld').mockReturnValue(false);
  animations = [];
  outcome = carried;
  useSitting.setState({ order: [], sent: null, emptied: null });
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    animations.push({ target: this, keyframes: keyframes as Keyframe[], options });
    // The flight is held until the test lets it end, so the copy can be looked at while it flies.
    return { finished: new Promise(() => {}), cancel() {} } as unknown as Animation & globalThis.Animation;
  } as typeof Element.prototype.animate;
});
afterEach(() => {
  // The notices live in one store for the page: a failure's notice must not stay for the next case.
  for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id);
  cleanup(); queryClient.clear(); vi.restoreAllMocks();
  useViewStore.getState().closeReader();
  // Held flights never end here, so neither does a closed reader's copy going (lib/motion.ts leave).
  document.querySelectorAll("[data-flying-card], [data-still-copy]").forEach(card => card.remove());
});

const time = (minute: number) => `2026-09-24T09:${String(minute).padStart(2, "0")}:00Z`;
/** A Task the user asked for, waiting on their review since `minute`: that turn is told apart by its own key. */
const waits = (id: string, minute: number) => taskFixture({ id, title: `Question ${id}`, userRequested: true, state: "waiting",
  log: [logEntry({ userRequested: true }), logEntry({ id: "L2", kind: "reported", at: time(minute), fromState: "doing", toState: "waiting" })],
  ball: userBall("review", `${id}@${minute}`, time(minute), {}) });
const finished = ({ task }: TaskFixture) => taskFixture({ ...task, state: "done" });
const turnAt = ({ ball }: TaskFixture) => userTurn(ball ?? null)?.at ?? "";
/**
 * The screen as the server sends it: what waits on the user in Your turn, the longest wait first; the rest at work or
 * finished.
 */
const screenOf = (tasks: TaskFixture[]) => screenData(tree({ tasks, home: homeFixture([
  ...tasks.filter(({ ball }) => !ball).map(({ task }) => ({ taskId: task.id, section: isFinished(task.state) ? "done" as const : "doing" as const })),
  ...tasks.filter(({ ball }) => ball).sort((a, b) => turnAt(a).localeCompare(turnAt(b))).map(({ task }) => ({ taskId: task.id, section: "review" as const })),
]) }));

/**
 * What the server says a message did once the coordinator's work is over: by default, its command wrote its record on
 * the Task it was about (✔ the OK of the Run it was about, Continue/Retry the request taken in, Hold/Stop a report to
 * held or stopped).
 */
const carried = true, refused = false;
let outcome = carried;
type Report = { task: string; state: string; opId: string; title: string; description: string };
let asked: Report[] = [];
let pending: (() => void)[] = [];
function Recovery() { useDirectWriteRecovery(); return null; }
/** Actual direct report responses stay pending until the test releases them. No coordinator message is fabricated. */
function serve() {
  asked = []; pending = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url) === '/api/commands/task/report' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)) as Report;
      asked.push(input);
      return new Promise<Response>(resolve => pending.push(() => resolve(outcome
        ? new Response(snapshotJson({ task: { ...headOf(dto({ id: input.task })), state: input.state }, outcome: { kind: 'recorded' } }))
        : problemResponse('conflict', 'Task changed'))));
    }
    if (String(url) === '/api/coordinator') return new Response(snapshotJson({ id: 'c1', turns: [], cancelled: [], nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false }));
    return problemResponse('not_found');
  });
  setConversationState({ conversation: { id: 'c1', turns: [], cancelled: [], nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false }, open: false, expanded: false, error: null });
}
const contents = <><Recovery /><TaskActionSlot /><Reader mode="docked" /><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} /><Toaster /></>;
let shownData: ReturnType<typeof screenOf>;
function show(tasks: TaskFixture[], open: string) {
  serve();
  shownData = screenOf(tasks);
  act(() => useViewStore.getState().openTask(open, { reader: true }));
  const view = render(<TestWorkspace data={shownData}>{contents}</TestWorkspace>);
  return { view, data: shownData };
}
/** The server's next snapshot, drawn on the reader shown. */
function publish(view: ReturnType<typeof show>["view"], tasks: TaskFixture[]) {
  shownData = screenOf(tasks);
  view.rerender(<TestWorkspace data={shownData}>{contents}</TestWorkspace>);
}
/** The coordinator's work on every message is over: the conversation says so, with what each did. */
const finish = async () => { const responses = pending.splice(0); await act(async () => { responses.forEach(answer => answer()); }); };
const intents = () => asked.map(input => [input.task, input.state]);
const answeredInReader = (card: ReaderCard | null, id: string, ball: Task["ball"] | undefined, action: "approve" | "stop" | "hold") =>
  acceptedInReader(card, id, ball, { answer: action === "approve" ? "done" : action, id: crypto.randomUUID(), turn: userTurn(ball ?? null)!.key, admitted: () => true, status: () => "confirmed" });
const shown = () => useViewStore.getState().selected;
/** ✔ writes directly with no coordinator message. */
const approve = () => fireEvent.click(document.querySelector<HTMLElement>("[data-task-done]")!);
/** Stop from the reader's state form, which the card's R opens. */
const stop = () => {
  act(() => openInput({ form: "report", taskId: shown()!, answerCard: useSitting.getState().card }));
  fireEvent.click(screen.getByRole("radio", { name: "Stopped" }));
  fireEvent.click(document.querySelector<HTMLElement>("[role=dialog] button[type=submit]")!);
};
const flying = () => document.querySelector<HTMLElement>("[data-flying-card]");
/** The copy's flight, which starts only once its stamp has landed and been held to be read. */
async function flightOf(card: Element) {
  expect(animations.find(item => item.target === card)).toBeUndefined();
  await waitFor(() => expect(animations.find(item => item.target === card)).toBeDefined(), { timeout: duration("base") + duration("read") + 1000 });
  return animations.find(item => item.target === card)!;
}

// Ordinary typing must not redraw the reader; submitted answers still have to invalidate both readers of the outbox.
for (const hook of ['waiting', 'shown'] as const) test(`${hook} reader ignores editable drafts but follows submitted answer entries`, async () => {
  const data = screenOf([waits('T1', 1)]), root = data.info.root;
  const key = draftKey(root, 'coordinator', 'c1');
  const values = { doc: JSON.stringify(textDocument('first words')), requestId: crypto.randomUUID() };
  useDraftStore.setState({ entries: { [key]: { status: 'editing', values } }, unavailable: false });
  let renders = 0, waiting: string[] = [];
  function Probe() {
    renders++;
    if (hook === 'waiting') waiting = useWaiting().map(task => task.id);
    else useShowCard(null, 'review', false);
    return null;
  }
  render(<TestWorkspace data={data}><Probe /></TestWorkspace>);
  await act(async () => {});
  const initial = renders;
  act(() => { updateDraft(key, { values: { ...values, doc: JSON.stringify(textDocument('typing more words')) } }); });
  expect(renders).toBe(initial);
  // An outgoing answer in another workspace is also outside the shown reader.
  act(() => { freeze('/other-workspace', { conversationId: 'c1', text: 'other', attachments: [] },
    { ...values, requestId: crypto.randomUUID() }, undefined,
    [{ ...readerTurn(data.tasks[0]!), title: 'Other', kind: 'answer', answer: 'send', expectedWrites: null }]); });
  expect(renders).toBe(initial);
  const requestId = crypto.randomUUID();
  act(() => { freeze(root, { conversationId: 'c1', text: 'answer', attachments: [] },
    { ...values, requestId }, undefined,
    [{ ...readerTurn(data.tasks[0]!), title: 'Question', kind: 'answer', answer: 'send', expectedWrites: null }]); });
  expect(renders).toBeGreaterThan(initial);
  if (hook === 'waiting') expect(waiting).toEqual([]);
  act(() => { reconcileOutbox({ id:'c1',nextLaunch: { agent: 'claude', values: {} },warm: 'none' as const,busy:false,cancelled:[],turns:[{
    id:requestId,at:new Date().toISOString(),ask:'answer',attachments:[],status:'succeeded',waiting:false,
    answer:null,seen:false,answeredAt:null,error:null,result:{writes:[],refused:[]}
  }] },root, null,true); });
  expect(useDraftStore.getState().entries[outgoingKey(root,requestId)]?.values.stage).toBe('settled');
  if (hook === 'waiting') expect(waiting).toEqual([]);
  const submitted = renders;
  act(() => { returnReaderSubmission(root, requestId, 'refused'); });
  expect(renders).toBeGreaterThan(submitted);
  if (hook === 'waiting') expect(waiting).toEqual(['T1']);
  const returned = renders;
  act(() => { discardDraft(outgoingKey(root, requestId)); });
  expect(renders).toBeGreaterThan(returned);
  if (hook === 'waiting') expect(waiting).toEqual(['T1']);
  cleanup();
  useDraftStore.setState({ entries: {}, unavailable: false });
});

test("the questions up next are those below the answered one, then those from the top; answered and gone ones are skipped", () => {
  expect(upNext(["T1", "T2", "T3"], ["T1", "T2", "T3"], "T2")).toEqual(["T3", "T1"]);
  expect(upNext(["T1", "T2", "T3"], ["T1", "T2", "T3"], "T3")).toEqual(["T1", "T2"]);
  expect(upNext(["T1", "T2", "T3"], ["T1", "T3"], "T1")).toEqual(["T3"]);
  // The answered task has already left the server's list: its place in the sitting still decides.
  expect(upNext(["T1", "T2", "T3"], ["T1", "T3"], "T2")).toEqual(["T3", "T1"]);
  // A question arriving after the operation captured its order follows that snapshot's remaining rows.
  expect(upNext(["T1", "T2"], ["T1", "T2", "T9"], "T2")).toEqual(["T9", "T1"]);
  // A task not in the order at all: from the top.
  expect(upNext(["T1", "T2"], ["T1", "T2"], "T7")).toEqual(["T1", "T2"]);
  expect(upNext(["T1"], ["T1"], "T1")).toEqual([]);
});

test("a question in the middle reads ahead the two it goes on to, not the first two", async () => {
  const stop = startReadScheduler(queryClient);
  onTestFinished(stop);
  const ahead = vi.spyOn(readScheduler(queryClient)!, "next");
  show([1, 2, 3, 4, 5].map(at => waits(`T${at}`, at)), "T3");
  await waitFor(() => expect(ahead).toHaveBeenCalled());
  expect(ahead).toHaveBeenLastCalledWith(["T4", "T5"]);
  // Nothing of them is drawn behind the reader.
  expect(document.querySelector("[data-deck-card]")).toBeNull();
});

test('answering follows the updated home order while the reader stays open, then wraps and finishes', async () => {
  const tasks = [1, 2, 3].map(at => waits(`T${at}`, at));
  const { view } = show(tasks, 'T2');
  // A live update rearranges the same waiting turns; the open card has not changed.
  const reordered = screenData(tree({ tasks, home: homeFixture(
    ['T3', 'T2', 'T1'].map(taskId => ({ taskId, section: 'review' })),
  ) }));
  view.rerender(<TestWorkspace data={reordered}>{contents}</TestWorkspace>);
  expect(shown()).toBe('T2');
  approve();
  await waitFor(() => expect(shown()).toBe('T1'));
  await finish();
  // The answered row leaves the list, and a new turn takes its actual place in it.
  const arriving = waits('T4', 4);
  const latest = screenData(tree({ tasks: [tasks[0]!, finished(tasks[1]!), tasks[2]!, arriving], home: homeFixture(
    ['T3', 'T1', 'T4'].map(taskId => ({ taskId, section: 'review' })),
  ) }));
  view.rerender(<TestWorkspace data={latest}>{contents}</TestWorkspace>);
  approve();
  await waitFor(() => expect(shown()).toBe('T4'));
  await finish();
  approve();
  await waitFor(() => expect(shown()).toBe('T3'));
  await finish();
  approve();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  expect(shown()).toBe('T3');
});

test("✔ sends Review OK to the API; once locally saved the card is stamped and flies off, and the reader is on the next question without a toast", async () => {
  show([waits("T1", 1), waits("T2", 2), waits("T3", 3)], "T1");
  approve();
  await waitFor(() => expect(shown()).toBe("T2"));
  expect(intents()).toEqual([["T1", "done"]]);
  // A step through the questions: the browser's history gets a step and no "back to" control is added.
  expect(useViewStore.getState().reader.turnSequence).toBe(true);
  const card = flying()!;
  expect(card.getAttribute("data-flying-card")).toBe("done");
  expect(card.getAttribute("aria-hidden")).toBe("true");
  expect(card.querySelector("[data-stamp]")!.textContent).toBe("Done");
  const flight = await flightOf(card);
  expect(String(flight.keyframes.at(-1)!.transform)).toMatch(/^translate\(\d/);
  expect(document.querySelector("[data-toast]")).toBeNull();
});

test.each([
  ["the next waiting Task", [waits("T1", 1), waits("T2", 2)], "T2"],
  ["the card saying every turn is answered", [waits("T1", 1)], "T1"],
] as const)("Done moving the reader on to %s takes the finished Task's label off a draft holding only it", async (_, tasks, after) => {
  let input: ReturnType<typeof useInputDraft> | undefined;
  function Draft() { input = useInputDraft(); return null; }
  serve();
  shownData = screenOf([...tasks]);
  useViewStore.setState({ navigationReady: true });
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  render(<TestWorkspace data={shownData}><Recovery /><TaskActionSlot /><Reader mode="docked" /><CoordinatorCard /><Draft /><Toaster /></TestWorkspace>);
  const labels = () => inlines(input!.doc).flatMap(node => node.type === "taskLabel" ? [node.attrs.id] : []);
  await waitFor(() => expect(labels()).toEqual(["T1"]));
  // Words typed and taken away again: the draft is the person's, holding the label alone.
  act(() => input!.change(doc => ({ ...doc, content: [...doc.content, { type: "paragraph", content: [{ type: "text", text: "x" }] }] })));
  act(() => input!.change(doc => ({ ...doc, content: doc.content.slice(0, -1) })));
  approve();
  await waitFor(() => expect(shown()).toBe(after));
  await waitFor(() => expect(labels()).not.toContain("T1"));
});

test("a ✔ the server refused (an older version) keeps the successor and offers the task again", async () => {
  const tasks = [waits("T1", 1), waits("T2", 2)];
  show(tasks, "T1");
  // The coordinator was refused (an older version than the one shown).
  outcome = refused;
  approve();
  await waitFor(() => expect(shown()).toBe("T2"));
  await finish();
  await screen.findByRole("button", { name: "Open" });
  expect(confirmedAnswers()).toEqual([]);
});

const ring = () => document.querySelector<SVGElement>("[data-answered-ring]");
/** The page's clock stopped: a stamp's hold has all of itself still to come, so when what waits on it starts is exact. */
const stopClock = () => vi.spyOn(performance, "now").mockReturnValue(performance.now());
/** The ring starts once the stamp is pressed on and read, and the card is half flung off (styles.css, Stamp). */
const ringStart = () => duration("stamp") + duration("read") + duration("fling") / 2;
const fills = () => animations.filter(item => item.target.matches("[data-ring-piece]"));

test("the last admitted answer completes immediately while the HTTP result is pending, and its animation never restarts at confirmation", async () => {
  show([waits("T1", 1), taskFixture({ id: "T2", state: "doing" })], "T1");
  approve();
  await waitFor(() => expect(useSitting.getState().emptied?.taskId).toBe("T1"));
  await screen.findByText(i18n.t("reader:nextQuestion.allAnswered"));
  expect(confirmedAnswers()).toEqual([]);
  const before = fills().length;
  await finish();
  expect(fills()).toHaveLength(before);
  expect(confirmedAnswers()).toEqual(["T1"]);
  expect(shown()).toBe("T1");
  expect(flying()).toBeTruthy();
  expect(document.querySelector("[data-answered-count]")!.textContent).toBe("1 done");
  // One answer, one piece: it fills, then the tick draws and the ring settles; all after the stamp is read and the card half gone.
  expect(ring()!.getAttribute("data-answered-ring")).toBe("1");
  expect(fills()).toHaveLength(1);
  expect(animations.some(item => item.target.matches("[data-answered-ring] path") && item.keyframes.at(-1)!.strokeDashoffset === 0)).toBe(true);
  expect(animations.some(item => item.target === ring() && item.keyframes.some(frame => frame.scale === 1.08))).toBe(true);
  const close = screen.getByRole("button", { name: i18n.t("reader:nextQuestion.close") });
  expect(document.activeElement).toBe(close);
  fireEvent.click(close);
  expect(useViewStore.getState().reader.open).toBe(false);
});

test("the ring has a piece for each answer of the sitting, filled one after another, and the count says how each was answered", async () => {
  show([waits("T1", 1), waits("T2", 2), waits("T3", 3)], "T1");
  stopClock();
  approve();
  await waitFor(() => expect(shown()).toBe("T2"));
  stop();
  await waitFor(() => expect(shown()).toBe("T3"));
  approve();
  await waitFor(() => expect(useSitting.getState().emptied?.taskId).toBe("T3"));
  expect(intents()).toEqual([["T1", "done"], ["T2", "stopped"], ["T3", "done"]]);
  await screen.findByText(i18n.t("reader:nextQuestion.allAnswered"));
  expect(confirmedAnswers()).toEqual([]);
  expect(document.querySelector("[data-answered-count]")!.textContent).toBe("2 done · 1 stopped");
  expect(ring()!.getAttribute("data-answered-ring")).toBe("3");
  // It starts once the last stamp has been held to be read and the card is half gone (half of fling); the clock is
  // stopped, so all of that hold is still to come. The pieces follow each other by fast at most, all within two slow
  // lengths; every part is hidden before its turn and stays after it.
  const step = Math.min(duration("fast"), (duration("slow") * 2 - duration("base")) / 2);
  const options = (item: Animation) => item.options as KeyframeAnimationOptions;
  const start = options(fills()[0]!).delay as number;
  expect(start).toBe(ringStart());
  expect(fills().map(item => options(item).delay)).toEqual([start, start + step, start + step * 2]);
  const full = start + step * 2 + duration("base");
  const tick = animations.find(item => item.target.matches("[data-answered-ring] path"))!;
  expect(options(tick).delay).toBe(full);
  const words = animations.filter(item => item.target.closest("[data-empty-deck]") && !item.target.closest("svg"));
  expect(words.map(item => options(item).delay)).toEqual([full + duration("fast"), full + duration("fast") * 2]);
  expect([...fills(), tick].map(item => options(item).fill)).toEqual(["both", "both", "both", "both"]);
  expect(words.map(item => options(item).fill)).toEqual(["backwards", "backwards"]);
  // Each piece grows from nothing to its length; the tick draws from nothing to whole; the words rise from hidden to shown.
  for (const piece of fills()) {
    const [from, to] = piece.keyframes.map(frame => String(frame.strokeDasharray).split(" ").map(Number));
    expect(from![0]).toBe(0);
    expect(to![0]).toBeGreaterThan(0);
    expect(to![0]! + to![1]!).toBeCloseTo(from![1]!);
  }
  expect(tick.keyframes.map(frame => frame.strokeDashoffset)).toEqual([1, 0]);
  for (const each of words) expect(each.keyframes.map(frame => frame.opacity)).toEqual([0, 1]);
});

/** The reader on `last`, with the sitting at its end: `answered` were answered here, all with `kind`. */
function ended(answered: string[], kind: Answer = "done") {
  const last = answered.at(-1)!;
  show([waits(last, 1)], last);
  act(() => {
    useSitting.setState({ departures: Object.fromEntries(answered.map(id => [id, { answer: kind, id: null,
      turn: userTurn(waits(id, 1).ball ?? null)!.key, admitted: () => true, status: () => "confirmed" as const }])), emptied: { taskId: last, animate: true } });
    projectDepartures();
  });
}

test("up to 24 answers the ring has a piece for each; past that it is one whole ring, and the count still says how many", () => {
  ended(Array.from({ length: 24 }, (_, at) => `T${at + 1}`));
  expect(ring()!.getAttribute("data-answered-ring")).toBe("24");
  expect(document.querySelectorAll("[data-ring-piece]")).toHaveLength(24);
  // However many pieces, the last is full within two slow lengths of the first.
  const filling = fills().map(item => (item.options as KeyframeAnimationOptions).delay as number);
  expect(filling.at(-1)! + duration("base") - filling[0]!).toBeLessThanOrEqual(duration("slow") * 2);
  cleanup(); useViewStore.getState().closeReader();
  ended(Array.from({ length: 25 }, (_, at) => `T${at + 1}`));
  expect(ring()!.getAttribute("data-answered-ring")).toBe("1");
  expect(document.querySelectorAll("[data-ring-piece]")).toHaveLength(1);
  expect(document.querySelector("[data-answered-count]")!.textContent).toBe("25 done");
});

test("a later refused operation cancels completion and leaves recovery to the existing notice", () => {
  ended(["T1", "T2"]);
  act(() => {
    useSitting.setState(state => ({ departures: { ...state.departures, ["T1"]: { ...state.departures["T1"]!, status: () => "refused" } } }));
    projectDepartures();
  });
  expect(screen.queryByText(i18n.t("reader:nextQuestion.allAnswered"))).toBeNull();
  expect(document.querySelector('[data-empty-deck]')).toBeNull();
  expect(useSitting.getState()).toMatchObject({ emptied: null });
});

test('an admitted last press that is refused later takes back completion and offers exactly one existing recovery entrance', async () => {
  show([waits('T1', 1)], 'T1');
  outcome = refused;
  approve();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  expect(fills()).toHaveLength(1);
  await finish();
  await screen.findByRole('button', { name: 'Open' });
  expect(document.querySelectorAll('[data-toast]')).toHaveLength(1);
  expect(document.querySelector('[data-empty-deck]')).toBeNull();
  expect(useSitting.getState().emptied).toBeNull();
});

test('remounting the completed display does not replay the consumed animation', () => {
  ended(['T1']);
  const before = fills().length;
  cleanup();
  render(<EmptyDeck taskId="T1" />);
  expect(ring()).toBeTruthy();
  expect(fills()).toHaveLength(before);
});

test('a new question after completion clears the display without a second animation', async () => {
  const tasks = [waits('T1', 1)];
  const { view } = show(tasks, 'T1');
  approve();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  const before = fills().length;
  publish(view, [...tasks, waits('T2', 2)]);
  await waitFor(() => expect(ring()).toBeNull());
  expect(shown()).toBe('T1');
  expect(fills()).toHaveLength(before);
  await finish();
  expect(ring()).toBeNull();
});

test("an arrival above the open last row is next when the current list wraps", async () => {
  const tasks = [waits("T1", 1), waits("T2", 2)];
  const { view } = show(tasks, "T2");
  // T9 waited longest by the clock, so the server lists it first; it arrived after the sitting began.
  publish(view, [...tasks, waits("T9", 0)]);
  approve();
  // The current list is T9, T1, T2, so answering its last row wraps to T9.
  await waitFor(() => expect(shown()).toBe("T9"));
});

test("with reduced motion the stamp shows on a card that only fades, and a refusal does not shake", async () => {
  const restore = reduce(true);
  try {
    const tasks = [waits("T1", 1), waits("T2", 2)];
    show(tasks, "T1");
    approve();
    await waitFor(() => expect(shown()).toBe("T2"));
    const flight = await flightOf(flying()!);
    expect(flight.keyframes.every(frame => frame.transform === undefined)).toBe(true);
    // The stamp does not grow either: it is there, fading in.
    const stamp = animations.find(item => item.target.matches("[data-stamp]"))!;
    expect(stamp.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(flight.keyframes.map(frame => frame.opacity)).toEqual([1, 0]);
  } finally { restore(); }
});

test("with reduced motion a refusal does not shake the reader", async () => {
  const restore = reduce(true);
  try {
    show([waits("T1", 1), waits("T2", 2)], "T1");
    outcome = refused;
    approve();
    await finish();
    // The refusal has been taken in once its notice is up.
    await waitFor(() => expect(document.querySelector("[data-toast]")).toBeTruthy());
    // The reader only faded in when it opened; nothing moves it.
    expect(animations.filter(item => item.target.matches("aside[data-reader-mode]")
      && item.keyframes.some(frame => "transform" in frame || "translate" in frame))).toEqual([]);
  } finally { restore(); }
});

test("with reduced motion the answered card's ring, words and Close only fade in, and nothing fills or bounces", async () => {
  const restore = reduce(true);
  try {
    show([waits("T1", 1)], "T1");
    stopClock();
    approve();
    await waitFor(() => expect(useSitting.getState().emptied?.taskId).toBe("T1"));
    await finish();
    await screen.findByText(i18n.t("reader:nextQuestion.allAnswered"));
    expect(fills()).toEqual([]);
    // The ring, the words and Close each fade in, from hidden to shown, once the stamp is read and the card half gone; nothing else moves.
    const deckBox = document.querySelector("[data-empty-deck]")!;
    const shown = animations.filter(item => item.target.closest("[data-empty-deck]"));
    expect(shown.map(item => item.target)).toEqual([...deckBox.children]);
    for (const item of shown) {
      expect(item.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
      expect(item.options).toMatchObject({ delay: ringStart(), fill: "backwards" });
    }
  } finally { restore(); }
});

test("a question answered elsewhere leaves the reader where it is", () => {
  const tasks = [waits("T1", 1), waits("T2", 2)];
  const { view } = show(tasks, "T1");
  publish(view, [finished(tasks[0]!), tasks[1]!]);
  expect(shown()).toBe("T1");
  expect(useViewStore.getState().reader.open).toBe(true);
  expect(flying()).toBeNull();
});

test("Stop from the state form is an answer too: once serve holds it, the card is stamped Stop and falls down", async () => {
  show([waits("T1", 1), waits("T2", 2)], "T1");
  stop();
  await waitFor(() => expect(shown()).toBe("T2"));
  expect(intents()).toEqual([["T1", "stopped"]]);
  const card = flying()!;
  expect(card.getAttribute("data-flying-card")).toBe("stop");
  expect(card.querySelector("[data-stamp]")!.textContent).toBe("Stop");
  expect(String((await flightOf(card)).keyframes.at(-1)!.transform)).toMatch(/^translate\(0px, \d/);
});

/** A list row's title with its keys (R opens the general state report), as the tree draws it. */
function RowTitle({ task }: { task: Task }) {
  const keys = useTitleKeys(task);
  return <button type="button" data-row-title={task.id} onKeyDown={keys}>{task.title}</button>;
}

/** R on a list row's title, then Done sent from the state form it opens in the reader. */
async function approveFromRow(id: string) {
  fireEvent.keyDown(document.querySelector<HTMLElement>(`[data-row-title="${id}"]`)!, { key: "r" });
  fireEvent.click(screen.getByRole("radio", { name: "Done" }));
  fireEvent.click(document.querySelector<HTMLElement>("[role=dialog] button[type=submit]")!);
  await waitFor(() => expect(asked).toHaveLength(1));
}

test("Review OK from a list row's state report on the task the reader shows answers its card, and the reader goes on", async () => {
  const { data } = show([waits("T1", 1), waits("T2", 2)], "T1");
  render(<TestWorkspace data={data}><RowTitle task={data.tasks.find(task => task.id === "T1")!} /></TestWorkspace>);
  await approveFromRow("T1");
  await waitFor(() => expect(shown()).toBe("T2"));
});

test("Review OK from a list row's state report on another task leaves the reader on the question it turned to", async () => {
  const { data } = show([waits("T1", 1), waits("T2", 2), waits("T3", 3)], "T1");
  render(<TestWorkspace data={data}><RowTitle task={data.tasks.find(task => task.id === "T2")!} /></TestWorkspace>);
  // Pressed while the reader showed T1: the form opens on T2 with no card of the reader's to answer.
  await approveFromRow("T2");
  expect(shown()).toBe("T2");
  expect(flying()).toBeNull();
});

test("serve's receipt that arrives after the reader was closed and opened again on the same task moves nothing", async () => {
  show([waits("T1", 1), waits("T2", 2)], "T1");
  approve();
  await waitFor(() => expect(asked).toHaveLength(1));
  act(() => useViewStore.getState().closeReader());
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  const copies = document.querySelectorAll("[data-flying-card]").length;
  await finish();
  expect(shown()).toBe("T1");
  expect(document.querySelectorAll("[data-flying-card]")).toHaveLength(copies);
});

test("a reply that arrives just after the reader turned to another task moves nothing", () => {
  const { data } = show([waits("T1", 1), waits("T2", 2), waits("T3", 3)], "T1");
  const card = useSitting.getState().card;
  // The reply lands in the same turn as the reader's move, before the reader has handed out the new task's card.
  act(() => {
    useViewStore.getState().openTask("T3", { reader: true });
    expect(answeredInReader(card, "T1", data.tasks.find(task => task.id === "T1")!.ball, "approve")).toBe(false);
  });
  expect(shown()).toBe("T3");
  expect(flying()).toBeNull();
});

test("closing immediately after admission keeps the reader closed while the decorative departure finishes", () => {
  const { data } = show([waits("T1", 1), waits("T2", 2)], "T1");
  act(() => {
    expect(answeredInReader(useSitting.getState().card, "T1", data.tasks.find(task => task.id === "T1")!.ball, "approve")).toBe(true);
    useViewStore.getState().closeReader();
  });
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(flying()).toBeTruthy();
});

test('opening a restored middle question by hand refreshes the order, including a task that was missing earlier', async () => {
  const tasks = [1, 2, 3, 4, 5].map(at => waits(`T${at}`, at));
  const { view } = show(tasks.filter(({ task }) => task.id !== 'T3'), 'T1');
  publish(view, tasks);
  act(() => useViewStore.getState().openTask('T3', { reader: true }));
  approve();
  await waitFor(() => expect(shown()).toBe('T4'));
});

test('a new waiting turn on an answered task joins behind the outstanding questions', async () => {
  const tasks = [waits('T1', 1), waits('T2', 2), waits('T3', 3)];
  const { view } = show(tasks, 'T1'); approve();
  await waitFor(() => expect(shown()).toBe('T2'));
  publish(view, [waits('T1', 5), tasks[1]!, tasks[2]!]);
  approve(); await waitFor(() => expect(shown()).toBe('T3'));
  approve(); await waitFor(() => expect(shown()).toBe('T1'));
});

test('a fresh question on the last answered task clears the all-answered result without moving the reader', async () => {
  const { view } = show([waits('T1', 1)], 'T1'); approve();
  await waitFor(() => expect(useSitting.getState().emptied?.taskId).toBe('T1'));
  await finish();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  publish(view, [waits('T1', 5)]);
  await waitFor(() => expect(screen.queryByText(i18n.t('reader:nextQuestion.allAnswered'))).toBeNull());
  expect(shown()).toBe('T1');
});

// A new question arriving on the answered card, or the reader turned to another task first: either way that card goes.
for (const away of ['stays', 'turns'] as const) test(`answers after an all-answered result count afresh, not on top of what that result showed (${away})`, async () => {
  const first = waits('T1', 1), other = finished(waits('T9', 0));
  const { view } = show([first, other], 'T1'); approve();
  await finish();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  if (away === 'turns') act(() => useViewStore.getState().openTask('T9', { reader: true }));
  publish(view, [finished(first), other, waits('T2', 5)]);
  await waitFor(() => expect(useSitting.getState().emptied).toBeNull());
  act(() => useViewStore.getState().openTask('T2', { reader: true }));
  await waitFor(() => expect(document.querySelector('[data-task-done]')).toBeTruthy());
  approve();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  expect(document.querySelector('[data-answered-count]')!.textContent).toBe('1 done');
  expect(ring()!.getAttribute('data-answered-ring')).toBe('1');
});

 test('a refused answer resolved elsewhere cannot block completion of the remaining card', async () => {
  const tasks=[waits('T1',1),waits('T2',2)], {view}=show(tasks,'T1');
  approve(); await waitFor(()=>expect(shown()).toBe('T2'));
  outcome=refused; await finish();
  expect(useSitting.getState().departures.T1?.status()).toBe('conflict');
  publish(view,[finished(tasks[0]!),tasks[1]!]);
  await waitFor(()=>expect(useSitting.getState().departures.T1).toBeUndefined());
  outcome=carried; approve();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  expect(document.querySelector('[data-answered-count]')!.textContent).toBe('1 done');
 });

test('cancelling completion restores the first failed card in bundle order', () => {
  ended(['T1','T2','T3']);
  act(()=>{
    useSitting.setState(state=>({order:['T2','T1','T3'],departures:{...state.departures,
      T1:{...state.departures.T1!,status:()=> 'refused'},T2:{...state.departures.T2!,status:()=> 'refused'}}}));
    projectDepartures();
  });
  expect(useViewStore.getState().selected).toBe('T2');
  expect(useSitting.getState().emptied).toBeNull();
});

test('a direct response preceding the home projection keeps the completed card and never invents a fresh turn', async () => {
  const first = waits('T1', 1);
  const { view } = show([first], 'T1');
  approve();
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  const opening = useSitting.getState().card;
  // A task write is newer than home: its row has no user turn, but home still lists the old review slot.
  const transitional = screenData(tree({ tasks: [finished(first)], home: homeFixture([{ taskId: 'T1', section: 'review' }]) }));
  view.rerender(<TestWorkspace data={transitional}>{contents}</TestWorkspace>);
  await screen.findByText(i18n.t('reader:nextQuestion.allAnswered'));
  expect(useSitting.getState().card).toBe(opening);
  expect(useSitting.getState().emptied?.taskId).toBe('T1');
  expect(fills()).toHaveLength(1);
});
