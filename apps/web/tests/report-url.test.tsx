import { historyCursor } from "@alpacawork/contract";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { recordNotes } from "./time-history-fixture";
import { afterEach, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { startI18n } from "@alpacawork/i18n";
import { controlRequestSchema, type ControlRequestDTO, type TaskHistoryDTO } from "@alpacawork/contract/control";
import { Reader } from "../src/features/reader/Reader";
import { useTaskIndex } from "../src/data/queries";
import { queryClient } from "../src/data/query-client";
import { resources } from "../src/data/resources";
import { useUrlBootstrap } from "../src/state/bootstrap";
import { useTimeView } from "../src/state/time-view";
import { useViewStore } from "../src/state/view-store";
import { projectTimeHistory, timeHistoryBase } from "../src/domain/time-history";
import { compactMark, laneMarks } from "../src/features/tree/time-line";
import { TONE } from "../src/components/ui/tone";
import { TestWorkspace, dto, historyFixture, logEntry, run, screenData, tree, userBall } from "./fixtures";

/** The report row open in the reader is named by the URL's `event`, as a time mark names it. */
function UrlSync() { useUrlBootstrap(useTaskIndex()); return null; }

/** Where each jump in the column goes: the row it brings into view (the glide itself is scroll-report's). */
const jump = vi.hoisted(() => ({ to: (_target: HTMLElement) => {} }));
vi.mock("../src/features/reader/scroll-report", () => ({
  scrollReport: (target: HTMLElement, _block: string, landed?: () => void) => { jump.to(target); landed?.(); },
}));
beforeAll(() => startI18n());
let scrolled: string[] = [];
beforeEach(() => {
  useViewStore.setState(useViewStore.getInitialState());
  useTimeView.getState().pick("", null);
  scrolled = [];
  jump.to = target => scrolled.push(target.closest<HTMLElement>("[data-folded-report]")?.dataset.foldedReport
    ?? target.closest<HTMLElement>("[data-report-key]")?.dataset.reportKey ?? "");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  onTestFinished(() => { jump.to = () => {}; frame.mockRestore(); vi.useRealTimers(); });
});
afterEach(() => { cleanup(); history.replaceState(null, "", "/"); });

const owner = { kind: "placement" as const, placementId: "P1" };
const placement = { id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true, active: true, revision: 1,
  startedAt: "2026-10-10T09:00:00Z", endedAt: null, headRunId: null, runtime: { displayState: "idle" as const, reason: null,
    sourceRunIds: [], runningCount: 0, queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null } };
const instruction = controlRequestSchema.parse({ id: "Q1", taskId: "T1", placementId: "P1", runId: "R1", aboutRunId: null, recipientRole: "owner",
  purpose: "instruction", author: { kind: "human" }, mode: "new", body: "First instruction\n\nInstruction continued", submittedAt: "2026-10-10T09:00:00Z",
  deliveryState: "queued" });
const sendBack = { ...instruction, id: "Q2", purpose: "review_send_back" as const, body: "First send-back line\n\nReason for sending back", submittedAt: "2026-10-10T12:00:00Z" };

/** A request as the server's History page answers it: its event, headed by its first line. */
const answered = (request: ControlRequestDTO): TaskHistoryDTO["events"][number] => ({ id: request.id, kind: "request",
  taskId: request.taskId, fromChild: false, at: request.submittedAt, state: null,
  by: request.author.kind === "placement" ? null : request.author.kind, title: request.body.split("\n", 1)[0] ?? "",
  summary: request.body });
/** An owner's progress report as History's event of it. */
const progressEvent = (id: string, at: string, title: string, summary: string) =>
  historyFixture([{ id, kind: "comment", at, state: "doing", title, summary, runId: "R1", author: { kind: "owner", profileKey: "codex" } }]);
const earlier = progressEvent("L1", "2026-10-10T10:00:00Z", "Intermediate report", "Intermediate body");
const latest = progressEvent("L2", "2026-10-10T11:00:00Z", "Final report", "Final body");

/**
 * One work period (R1) with an earlier report folded under the latest, an instruction before it and a send-back after it;
 * `events` is T1's first History page, newest first.
 */
function feed(tasks = [dto({ log: [
  logEntry({ id: "Q1", kind: "request_accepted", at: instruction.submittedAt }),
  logEntry({ id: "L1", kind: "reported", at: "2026-10-10T10:00:00Z", actor: owner, toState: "doing", title: "Intermediate report", description: "Intermediate body" }),
  logEntry({ id: "L2", kind: "reported", at: "2026-10-10T11:00:00Z", actor: owner, toState: "doing", title: "Final report", description: "Final body" }),
  logEntry({ id: "Q2", kind: "review_sent_back", at: sendBack.submittedAt }),
] })], events = [answered(sendBack), ...latest, ...earlier, answered(instruction)]) {
  return screenData(tree({ tasks, placements: [placement], requests: [instruction, sendBack],
    runs: [run("R1", { startedAt: "2026-10-10T09:30:00Z", endedAt: "2026-10-10T11:30:00Z" })], history: { T1: events } }));
}
const row = (key: string) => document.querySelector<HTMLElement>(`[data-report-key="${CSS.escape(key)}"]`)!;
const toggle = (key: string) => row(key).querySelector<HTMLElement>("button[aria-expanded]")!;
const event = () => new URL(location.href).searchParams.get("event");

async function openAt(url: string, data = feed()) {
  history.replaceState(null, "", url);
  const view = render(<TestWorkspace data={data}><UrlSync /><Reader mode="docked" /></TestWorkspace>);
  await act(async () => { await Promise.resolve(); });
  act(() => vi.advanceTimersByTime(250));
  return view;
}

/** The part of a History window below the held one, as the server answers it: nothing older beyond it. */
const olderWindow = (events: { at: string; taskId: string; id: string; kind: string }[]) => ({ generation: "a", sourcePv: 0, events,
  hasOlder: false, oldestKey: events.length ? historyCursor(events.at(-1) as Parameters<typeof historyCursor>[0]) : null });

test("a URL's event opens that row, scrolls to it and flashes it, once", async () => {
  await openAt("/?task=T1&event=request:Q1");
  expect(toggle("request:Q1").getAttribute("aria-expanded")).toBe("true");
  expect(row("request:Q1").textContent).toContain("Instruction continued");
  expect(scrolled).toEqual(["request:Q1"]);
  expect(row("request:Q1").querySelector("[data-report-line]")).not.toBeNull();
  // The jump is used up: a later redraw of the column does not scroll back to it.
  expect(useTimeView.getState().picked).toBeNull();
  expect(event()).toBe("request:Q1");
});

test("an event on an earlier report of a Run opens that report's own row", async () => {
  await openAt("/?task=T1&event=log:T1:L1");
  expect(toggle("log:T1:L1").getAttribute("aria-expanded")).toBe("true");
  // The newest report still stands open above it: a row opens and closes only itself.
  expect(toggle("log:T1:L2").getAttribute("aria-expanded")).toBe("true");
  expect(scrolled).toEqual(["log:T1:L1"]);
});

test("opening and closing a row replaces the URL's event without a new history entry; closing clears it", async () => {
  await openAt("/?task=T1");
  const length = history.length;
  fireEvent.click(toggle("request:Q2"));
  await act(async () => { await Promise.resolve(); });
  expect(event()).toBe("request:Q2");
  fireEvent.click(toggle("request:Q2"));
  await act(async () => { await Promise.resolve(); });
  expect(event()).toBeNull();
  fireEvent.click(toggle("log:T1:L2"));
  await act(async () => { await Promise.resolve(); });
  expect(toggle("log:T1:L2").getAttribute("aria-expanded")).toBe("false");
  expect(event()).toBeNull();
  fireEvent.click(toggle("log:T1:L2"));
  await act(async () => { await Promise.resolve(); });
  expect(event()).toBe("log:T1:L2");
  fireEvent.click(toggle("log:T1:L1"));
  await act(async () => { await Promise.resolve(); });
  expect(event()).toBe("log:T1:L1");
  expect(history.length).toBe(length);
});

test("another task drops the event from its own entry, and a row the column does not have is left alone", async () => {
  // The owner's report keeps the instruction from standing open in its place, so the row shows what the event did.
  await openAt("/?task=T1&event=log:T1:missing", feed([dto({ log: [logEntry({ id: "Q1", kind: "request_accepted", at: instruction.submittedAt }),
    logEntry({ id: "L1", kind: "reported", at: "2026-10-10T10:00:00Z", actor: owner, toState: "doing", title: "Intermediate report", description: "Intermediate body" })] }),
    dto({ id: "T2", title: "Other task" })], [answered(sendBack), ...earlier, answered(instruction)]));
  expect(toggle("request:Q1").getAttribute("aria-expanded")).toBe("false");
  expect(scrolled).toEqual([]);
  act(() => useViewStore.getState().openTask("T2", { reader: true }));
  await act(async () => { await Promise.resolve(); });
  expect(new URL(location.href).searchParams.get("task")).toBe("T2");
  expect(event()).toBeNull();
});

test("an event in an older History page reads pages until it is found", async () => {
  const older = controlRequestSchema.parse({ ...instruction, id: "Q0", body: "Old instruction\n\nOld instruction continued", submittedAt: "2026-10-01T09:00:00Z" });
  const data = screenData(tree({ tasks: [dto({ log: [logEntry({ id: "Q0", kind: "request_accepted", at: older.submittedAt }),
    logEntry({ id: "Q1", kind: "request_accepted", at: instruction.submittedAt })] })], placements: [placement], requests: [older, instruction] }));
  const key = resources.history(data.info.root, "T1").queryKey;
  const seed = data.seed;
  const first = { events: [answered(instruction)], nextBefore: "cursor" };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(olderWindow([answered(older)])), { headers: { "content-type": "application/json" } }));
  onTestFinished(() => fetcher.mockRestore());
  let served = false;
  // Seeded once: the shared seed would put back a single finished page on every render.
  data.seed = () => { if (served) return; served = true; seed(); queryClient.setQueryData(key, { pages: [first], pageParams: [null] }); };
  await openAt("/?task=T1&event=request:Q0", data);
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  act(() => vi.advanceTimersByTime(250));
  expect(fetcher).toHaveBeenCalled();
  expect(toggle("request:Q0").getAttribute("aria-expanded")).toBe("true");
});

test("a failed older page stops the jump's reading and keeps the jump for the retry button", async () => {
  const older = controlRequestSchema.parse({ ...instruction, id: "Q0", body: "Old instruction", submittedAt: "2026-10-01T09:00:00Z" });
  const data = screenData(tree({ tasks: [dto({ log: [logEntry({ id: "Q0", kind: "request_accepted", at: older.submittedAt }),
    logEntry({ id: "Q1", kind: "request_accepted", at: instruction.submittedAt })] })], placements: [placement], requests: [older, instruction] }));
  const key = resources.history(data.info.root, "T1").queryKey;
  const seed = data.seed;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
  onTestFinished(() => fetcher.mockRestore());
  let served = false;
  data.seed = () => { if (served) return; served = true; seed();
    queryClient.setQueryData(key, { pages: [{ events: [answered(instruction)], nextBefore: "cursor" }], pageParams: [null] }); };
  await openAt("/?task=T1&event=request:Q0", data);
  for (let i = 0; i < 5; i++) { await act(async () => { for (let j = 0; j < 5; j++) await Promise.resolve(); }); act(() => vi.advanceTimersByTime(250)); }
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(useTimeView.getState().picked).toEqual({ taskId: "T1", key: "request:Q0" });
});

test("a failed first History page keeps the jump, so the retry button's reading can still land it", async () => {
  const data = feed();
  const key = resources.history(data.info.root, "T1").queryKey;
  const seed = data.seed;
  let served = false;
  data.seed = () => { if (served) return; served = true; seed(); queryClient.removeQueries({ queryKey: key }); };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("down", { status: 503 }));
  onTestFinished(() => fetcher.mockRestore());
  await openAt("/?task=T1&event=request:Q1", data);
  for (let i = 0; i < 3; i++) { await act(async () => { for (let j = 0; j < 5; j++) await Promise.resolve(); }); act(() => vi.advanceTimersByTime(250)); }
  expect(queryClient.getQueryState(key)?.status).toBe("error");
  expect(useTimeView.getState().picked).toEqual({ taskId: "T1", key: "request:Q1" });
});

/** A question waiting on you is drawn in your colour; once answered, whichever way, it is quiet. The column's line
 * when it is jumped to and the list's mark for the same record take that one colour. */
test.each([
  { answer: "none", state: "doing", reason: "question", after: [] },
  { answer: "a choice", state: "doing", reason: "question", after: [{ id: "Q3", kind: "answered" as const, questionId: "L3", description: "1-Option1 Check the original" }] },
  { answer: "a hold", state: "held", reason: "question", after: [{ id: "L4", kind: "reported" as const, fromState: "doing" as const, toState: "held" as const }] },
  { answer: "a send-back", state: "doing", reason: "review", after: [{ id: "Q3", kind: "review_sent_back" as const }], body: "Another preview option" },
] as const)("a question answered by $answer is drawn the same in the column and on the list", async ({ answer, state, reason, after, ...rest }) => {
  const asked = { id: "L3", at: "2026-10-10T13:00:00Z", actor: owner, title: "Which one?", description: "Option1 or Option2" };
  const question = reason === "review" ? logEntry({ ...asked, kind: "reported", fromState: "doing", toState: "waiting" })
    : logEntry({ ...asked, kind: "asked", askedTo: null });
  const answered = after.map(entry => logEntry({ at: "2026-10-10T13:10:00Z", ...entry }));
  const reply = "body" in rest ? controlRequestSchema.parse({ ...instruction, id: "Q3", purpose: "review_send_back",
    body: rest.body, submittedAt: "2026-10-10T13:10:00Z" }) : null;
  const waiting = answer === "none";
  // History's event of the question (or of the report asking for the review); the answers' own rows are not looked at here.
  const asking = historyFixture([{ id: "L3", kind: reason === "review" ? "review" : "question", at: asked.at,
    ...(reason === "review" ? { state: "waiting" as const } : { open: answer === "none" || answer === "a hold" }),
    title: asked.title, summary: asked.description }]);
  const data = screenData(tree({ tasks: [dto({ state, log: [question, ...answered] })],
    placements: [placement], requests: reply ? [reply] : [],
    balls: waiting ? { T1: userBall("question", "L3", question.at, { questionId: "L3" }) } : {}, history: { T1: asking } }));
  await openAt("/?task=T1&event=log:T1:L3", data);
  const tone = waiting ? "turn" : "quiet";
  expect(row("log:T1:L3").querySelector("[data-report-line]")?.getAttribute("class")).toContain(TONE[tone]);
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, (data.tasks[0]!).id)), Date.parse("2026-10-10T14:00:00Z"))!;
  const mark = laneMarks(history).find(each => each.event.key === "log:T1:L3");
  // On the list it is marked only while it waits on you; the column keeps it as a quiet row.
  expect(mark && compactMark(mark.event)?.tone).toBe(waiting ? "turn" : undefined);
});

test("a progress report's line stays in the working colour, and the list does not mark it", async () => {
  const progress = logEntry({ id: "L3", kind: "reported", at: "2026-10-10T13:00:00Z", actor: owner, fromState: "doing", toState: "doing", title: "Checking" });
  const data = screenData(tree({ tasks: [dto({ state: "doing", log: [progress] })], placements: [placement], requests: [],
    history: { T1: historyFixture([{ id: "L3", kind: "comment", at: progress.at, state: "doing", title: "Checking" }]) } }));
  await openAt("/?task=T1&event=log:T1:L3", data);
  expect(row("log:T1:L3").querySelector("[data-report-line]")?.getAttribute("class")).toContain(TONE.working);
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, (data.tasks[0]!).id)), Date.parse("2026-10-10T14:00:00Z"))!;
  expect(laneMarks(history)).toEqual([]);
});

test('an old projected user question waits for History to reach its position, then scrolls once from the existing pick', async () => {
  const question = { id: 'Lold-question', taskId: 'T1', taskTitle: 'Task one', destination: { kind: 'user' as const }, applicable: true, state: 'open' as const,
    title: 'Old question', summary: 'Choose', decide: [{ decide_question: 'Choose', decide_choices: [{ decide_choice: 'A', decide_choice_detail: 'Proceed' }] }], askedAt: '2026-10-01T10:00:00Z' };
  const data = screenData(tree({ tasks: [dto()], userQuestions: { T1: [question] }, history: { T1: historyFixture([
    { id: 'Llatest', kind: 'comment', at: '2026-10-10T10:00:00Z', title: 'New report' }]) } }));
  const queryKey = resources.history(data.info.root, 'T1').queryKey;
  const seed = data.seed;
  let seeded = false;
  data.seed = () => { if (seeded) return; seeded = true; seed(); queryClient.setQueryData(queryKey, {
    pages: [{ events: historyFixture([{ id: 'Llatest', kind: 'comment', at: '2026-10-10T10:00:00Z', title: 'New report' }]), nextBefore: 'older' }], pageParams: [null],
  }); };
  let answer!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  await openAt('/?task=T1', data);
  fireEvent.click(document.querySelector('[data-questions-bar] button')!);
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  act(() => vi.advanceTimersByTime(500));
  expect(scrolled).toEqual([]);
  expect(useTimeView.getState().picked?.key).toBe('log:T1:Lold-question');
  await act(async () => answer(new Response(JSON.stringify(olderWindow(historyFixture([
    { id: question.id, kind: 'question', at: question.askedAt, title: question.title, open: true },
    { id: 'Lprior', kind: 'comment', at: '2026-10-01T09:00:00Z', title: 'Prior record' }]))))));
  act(() => vi.advanceTimersByTime(250));
  for (let i = 0; i < 3; i++) { await act(async () => { for (let j = 0; j < 5; j++) await Promise.resolve(); }); act(() => vi.advanceTimersByTime(250)); }
  expect(scrolled).toEqual(['log:T1:Lold-question']);
  expect(useTimeView.getState().picked).toBeNull();
});
