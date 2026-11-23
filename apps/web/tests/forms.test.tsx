import { indexTasks } from '../src/domain/tasks';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { serverView, jsonAnswer } from './receipt-fixture';
import { readerPresentation, readQuery, readIndex, refuseRead } from '../src/data/read-model';
import { resources } from '../src/data/resources';
import { serverReadFacts } from '../src/data/read-model';
import { controlIndexSchema } from '@alpacawork/contract/control';
import { submittedReaderTurn } from '../src/features/reader/submitted-turns';
import { intentKey, useWriteIntentStore } from '../src/data/write-intent';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { textDocument } from '../src/features/coordinator/editor/document';
import { readerTurn } from '../src/features/reader/submission';
import { useDraftStore } from '../src/features/forms/draft-store';
import { freeze, holdsReaderTurn } from '../src/features/coordinator/editor/outbox';
import { compositionClock } from "./timing";
import { test, expect, vi, onTestFinished } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { i18n } from "@alpacawork/i18n";
import type { CoordinatorConversation, CoordinatorMessageInput, CoordinatorResult } from "@alpacawork/contract/coordinator";
import { StateControl } from "../src/features/forms/ReportInputs";
import { useTitleKeys } from "../src/features/forms/title-keys";
import type { Task } from "../src/data/types";
import { Reader } from "../src/features/reader/Reader";
import { TaskActions } from "../src/features/reader/TaskActions";
import { TaskActionSlot, useTaskActionSlot } from "../src/features/coordinator/task-action-slot";
import { HoldKey } from "../src/features/reader/HoldKey";
import { TurnReason } from "../src/features/reader/TurnReason";
import { CoordinatorInput } from "../src/features/coordinator/CoordinatorInput";
import { useConversation } from "../src/features/coordinator/coordinator";
import { useReaderSend } from "../src/features/coordinator/reader-send";
import { AppBar } from "../src/features/chrome/AppBar";
import { Toaster } from "../src/components/ui/toaster";
import { indexKey } from "../src/data/resources";
import type { ControlIndexDTO, PlacementDTO } from "@alpacawork/contract/control";
import { reasonedTurn } from "../src/domain/lead";
import { useDialogStore } from "../src/state/dialog-store";
import { closeInput, openInput } from "../src/state/open-input";
import { useViewStore } from "../src/state/view-store";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { upNext, useSitting } from "../src/features/reader/next-question";
import { controlTreeSchema, type ControlTreeDTO } from "@alpacawork/contract/control";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { headOf, TestWorkspace, at, homeFixture, indexOf, PROJECT_TASK, screenData, taskFixture, tree, dto, logEntry, run, userBall } from "./fixtures";
import { setupForms, errorToasts, refusal, written, submit, body, unconfirmed, reportData, reportPopup, reportTitleField, reportDescriptionField, enter } from "./forms-fixture";
import { problemResponse } from "./problem";


setupForms();

/** A write's answer as the server sends it: the Task as written. */
const answered = (task = dto()) => written(task);

// Awaiting review and Send back need people: a control tree (the control contract fixture) with a responsible person.
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "../../../tests/fixtures/contract-examples", name), "utf8"));

/** The canonical tree: T12 waits for review, Opus (P2, revision 3) is responsible and R2 is its latest run. */
const canonical = tree(controlTreeSchema.parse(fixture("tree.json")));

const CHILD = "T12";

/** The canonical tree on screen, T12's review of R2 waiting on the user. */
const sendbackData = (value: ControlTreeDTO = canonical) =>
  screenData(tree({ ...value, balls: { ...value.balls, [CHILD]: userBall("review", "RET1", "2026-09-24T09:00:00Z", { aboutRunId: "R2" }) } }));

const child = (data: ReturnType<typeof sendbackData>) => data.tasks.find((task) => task.id === CHILD)!;

const review = userBall("review", "L2", at);
const question = userBall("question", "Q1", at, { questionId: "Q1" });
const reported = logEntry({ id: "L2", kind: "reported", fromState: "doing", toState: "waiting" });
/** T1 (or `id`), the user's request, waiting on their review of R1. */
const awaiting = (id = "T1") => taskFixture({ id, title: `Review ${id}`, userRequested: true, state: "waiting", ball: review,
  log: [logEntry({ userRequested: true }), reported] });

/**
 * The input the reader's presses go through (CoordinatorInput) on its conversation, beside `children`, and serve as it
 * answers: a message is held in the conversation under its ID (`asked`), at work until `finish`; the live index is
 * `live`. Every other read is refused.
 */
function DirectRecovery() { useDirectWriteRecovery(); return null; }
function withInput(data: ReturnType<typeof screenData>, children: ReactNode, holdReports = false) {
  const asked: CoordinatorMessageInput[] = [];
  const reports: any[] = [], pending: ((result: CoordinatorResult) => void)[] = [];
  let status: CoordinatorConversation["turns"][number]["status"] = "running", result: CoordinatorResult | null = null;
  const conversation = (): CoordinatorConversation => ({ id: "c1", nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [],
    turns: asked.map((input) => ({ id: input.id, at, ask: input.text, tasks: input.tasks, attachments: input.attachments,
      ...(input.intent ? { intent: input.intent } : {}), status, waiting: status === "queued" || status === "sending", answer: null, seen: false, answeredAt: null, error: null, result })) });
  const json = (value: unknown) => new Response(snapshotJson(value), { status: 200 });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === '/api/task/report' && init?.method === 'POST') {
      const input = JSON.parse(String(init.body)); reports.push(input);
      const done = () => json({ task: headOf(dto({ id: input.task, state: input.state })), outcome: { kind: 'recorded' } });
      return holdReports ? new Promise<Response>(resolve => pending.push(result => resolve(result.refused.length
        ? problemResponse('conflict', result.refused[0]!.message) : done()))) : done();
    }
    if (path === "/api/coordinator/messages" && init?.method === "POST") { asked.push(JSON.parse(String(init.body))); return json(conversation()); }
    if (path === "/api/coordinator") return json(conversation());
    return problemResponse("not_found");
  });
  setConversationState({ conversation: conversation(), open: true, expanded: false, engaged: false, read: true, error: null });
  const view = render(<TestWorkspace data={data}><DirectRecovery />{children}<TaskActionSlot /><CoordinatorInput launch={{ next: { agent: 'claude', values: {} }, ready: false }} profile="claude" /><Toaster /></TestWorkspace>);
  // The coordinator's Run ends, and the server says what its messages did (`outcome`).
  return { view, asked, reports, fetcher, finish: async (outcome: CoordinatorResult) => { status = "succeeded"; result = outcome; await act(async () => { pending.splice(0).forEach(resolve => resolve(outcome)); }); await act(async () => { await useConversation.getState().refresh(); }); } };
}
/** The state form's own Send: the input beside it has a Send of its own. */
const sendReport = () => document.querySelector<HTMLButtonElement>("[data-inline-form] button[type=submit]")!;

test("popup composition-end Escape is ignored, while plain Escape later closes it and nothing is kept", async () => {
  const elapse = compositionClock();
  const data = reportData();
  render(<TestWorkspace data={data}><StateControl task={data.tasks[0]!} /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Change state" }));
  const field = reportTitleField();
  fireEvent.change(field, { target: { value: "Typed report" } });
  fireEvent.compositionStart(field); fireEvent.compositionEnd(field);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(useDialogStore.getState().dialog).toMatchObject({ form: "report" });
  elapse(50);
  fireEvent.keyDown(field, { key: "Escape" });
  await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Change state" }));
  expect(reportTitleField().value).toBe(i18n.t("forms:reportForm.holdTitle"));
});

test("on a phone the task's Done at the foot is labelled, while it awaits your review, and ready without a conversation input", () => {
  const data = sendbackData();
  const first = render(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={child(data)} phone /></TestWorkspace>);
  // Auto-swipe, then Change state to the left of Done, in the same row and the same round shape, each its mark alone;
  // on hover each says what it does, Change state and Done naming the task shown; over Done, the sheet's close.
  const id = child(data).id;
  const row = [...document.querySelectorAll("[data-task-action-slot] button")].map(button => [button.textContent, button.getAttribute("aria-label"), button.getAttribute("title")]);
  expect(row).toEqual([["", "Auto-swipe", i18n.t("reader:nextQuestion.autoSwipe.hint")], ["", "Change state", `Change the state of ${id}`], ["", "Mark this task done", `Mark ${id} as done`], ["", "Close details", "Close details"]]);
  expect(document.querySelector("[data-task-action-slot] textarea, [data-task-action-slot] [contenteditable]")).toBeNull();
  expect(document.querySelector("[data-approve]")).toBeNull();
  // No input to send with: the press would go nowhere.
  expect((screen.getByRole("button", { name: "Mark this task done" }) as HTMLButtonElement).disabled).toBe(false);
  first.unmount();
  withInput(data, <TaskActions task={child(data)} phone />);
  expect((screen.getByRole("button", { name: "Mark this task done" }) as HTMLButtonElement).disabled).toBe(false);
  cleanup();
  // A question asked of you, or a task at work, has no ✔ even with a visible slot; its state can still be changed.
  for (const ball of [question, null]) {
    const other = screenData(tree({ tasks: [taskFixture({ state: "doing", ball })] }));
    render(<TestWorkspace data={other}><TaskActionSlot /><TaskActions task={other.tasks[0]!} phone /></TestWorkspace>);
    expect(document.querySelector("[data-task-done]")).toBeNull();
    expect(document.querySelector("[data-task-action-slot] [data-task-state]")).not.toBeNull();
    cleanup();
  }
});

test("on a computer the actions stand in the conversation's row with their words, as on a phone", () => {
  // Words stand only where the row has room for them (useRowWords measures it; jsdom has no widths): give it room.
  useTaskActionSlot.setState({ labels: true });
  onTestFinished(() => useTaskActionSlot.setState({ labels: false }));
  const data = sendbackData();
  const view = render(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={child(data)} phone={false} /></TestWorkspace>);
  // The words a button shows: the pin keeps its other word laid out but hidden, so its width never changes.
  const shown = (button: Element) => { const copy = button.cloneNode(true) as Element;
    copy.querySelectorAll("[aria-hidden=true]").forEach(part => part.remove()); return copy.textContent; };
  const row = () => [...document.querySelectorAll("[data-task-action-slot] button")].map(shown);
  // Auto-swipe stands first while the task waits on you.
  expect(row()).toEqual(["Auto-swipe", "Change state", "Done"]);
  // At work: Change state alone. Finished: none, the state form still mounted unseen (R opens it).
  const working = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: null })] }));
  view.rerender(<TestWorkspace data={working}><TaskActionSlot /><TaskActions task={working.tasks[0]!} phone={false} /></TestWorkspace>);
  expect(row()).toEqual(["Change state"]);
  view.rerender(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={{ ...child(data), state: "done" }} phone={false} /></TestWorkspace>);
  expect(row()).toEqual([]);
  expect(document.querySelector("[data-state-host] [data-state-anchor]")).not.toBeNull();
});

test("Done reads as accepted only for its own approval of the version shown, not for another report on the task", () => {
  const data = sendbackData(), task = child(data), key = intentKey(data.info.root, "task/report", task.id);
  const sent = (choice: string, hash: string) => act(() => useWriteIntentStore.setState({ unavailable: false, entries: { [key]: {
    status: "confirmed", operationId: `op-${choice}-${hash}`, transport: "receipt", payload: { task: task.id, expectedTaskHash: hash },
    draft: { choice, title: "", description: "" }, attempt: "a", at: new Date(0).toISOString() } } }));
  try {
    render(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={task} phone={false} /></TestWorkspace>);
    const done = () => screen.getByRole("button", { name: "Mark this task done" }) as HTMLButtonElement;
    // A hold accepted for this task (then taken back to review) leaves Done to press.
    sent("hold", task.hash);
    expect(done().disabled).toBe(false); expect(done().dataset.accepted).toBeUndefined();
    // Its own approval of this version reads as accepted; one of an earlier version does not.
    sent("approve", task.hash);
    expect(done().disabled).toBe(true); expect(done().dataset.accepted).toBe("true");
    sent("approve", "c".repeat(64));
    expect(done().disabled).toBe(false); expect(done().dataset.accepted).toBeUndefined();
  } finally { act(() => useWriteIntentStore.setState({ entries: {} })); }
});

test("✔ sends Review OK of the reviewed Run directly with the versions shown", async () => {
  const data = sendbackData();
  const { reports, fetcher } = withInput(data, <TaskActions task={child(data)} phone />);
  fireEvent.click(screen.getByRole("button", { name: "Mark this task done" }));
  // Done sends at once: no state form opens.
  expect(useDialogStore.getState().dialog).toBeNull();
  await waitFor(() => expect(reports).toHaveLength(1));
  // Its one line is the screen's; the intent carries the Run the review is about and the Task's and its responsible's
  // versions, as the screen showed them.
  expect(reports[0]).toMatchObject({ task: "T12", state: "done", aboutRun: "R2", expectedTaskHash: "b".repeat(64), expectedPlacementRevision: 3 });
  // The Task changes only when the coordinator writes it, quoting the user: the screen sends no Task write.
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url))).toEqual(["/api/task/report"]);
});

test("a ✔ the coordinator did not carry out (refused for an older version) brings its card back, with a notice to open it", async () => {
  const value = tree({ tasks: [awaiting("T1"), awaiting("T2")],
    home: homeFixture([{ taskId: "T1", section: "review" }, { taskId: "T2", section: "review" }]) });
  const data = screenData(value);
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  const { reports, finish } = withInput(data, <Reader mode="docked" />, true);
  fireEvent.click(screen.getByRole("button", { name: "Mark this task done" }));
  // Serve holds it: its card leaves, and the reader is on the next question.
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T2"));
  expect(reports.map(({ state }) => state)).toEqual(["done"]);
  // Nothing waits behind T2 while T1's ✔ is held (the questions the reader goes on to, as it reads them ahead).
  const ahead = () => upNext(useSitting.getState().order, ["T1", "T2"].filter(id => !data.tasks.some(task => task.id === id && submittedReaderTurn(useDraftStore.getState().entries, useWriteIntentStore.getState().entries, data.info.root, readerTurn(task)))), "T2");
  expect(ahead()).toEqual([]);
  // The server refused the approval: it carried an older version of T1.
  await finish({ writes: [], refused: [{ task: "T1", code: 'conflict', message: 'Task changed', retry: 'reread' }] });
  await screen.findByRole("button", { name: "Open" });
  expect(useSitting.getState().departures["T1"]?.status()).toBe("conflict");
  // T1 waits again behind the question on screen.
  await waitFor(() => expect(ahead()).toEqual(["T1"]));
});

test("the state form offers only stateChoices, and saving writes that state directly with separate title and body", async () => {
  const held = [logEntry(), reported, logEntry({ id: "L3", kind: "reported", fromState: "waiting", toState: "held" })];
  for (const [task, names] of [
    [taskFixture({ state: "waiting", ball: review, log: [logEntry(), reported] }), ["Done", "On hold", "Stopped"]],
    // Held from its review: Restore leads back to the review.
    [taskFixture({ state: "held", baseState: "waiting", ball: review, log: held }), ["Done", "Awaiting review", "Stopped"]],
    [taskFixture({ state: "doing", ball: question }), ["On hold", "Stopped"]],
    [taskFixture({ state: "doing" }), ["On hold", "Stopped"]],
    [taskFixture({ state: "done" }), ["On hold"]],
  ] as const) {
    const data = screenData(tree({ tasks: [task] }));
    withInput(data, reportPopup(data.tasks[0]!));
    expect(screen.queryAllByRole("radio").map((radio) => radio.textContent)).toEqual(names);
    expect(sendReport().disabled).toBe(false);
    cleanup(); closeInput();
  }
  const data = screenData(tree({ tasks: [taskFixture({ state: "waiting", ball: review, log: [logEntry(), reported] })] }));
  const { reports } = withInput(data, reportPopup(data.tasks[0]!));
  // A review's decision carries its explanation as the user's words.
  fireEvent.click(screen.getByRole("radio", { name: "Done" }));
  fireEvent.change(reportTitleField(), { target: { value: "Verified all acceptance cases" } });
  fireEvent.change(reportDescriptionField(), { target: { value: "The acceptance cases all passed." } });
  fireEvent.click(sendReport());
  await waitFor(() => expect(reports).toHaveLength(1));
  expect(reports[0]).toMatchObject({ task: "T1", state: "done", expectedTaskHash: "a".repeat(64),
    title: "Verified all acceptance cases", description: "The acceptance cases all passed." });
  expect(useDialogStore.getState().dialog).toBeNull();
});

test("each state choice fills the title and body with its own words; a choice moves only the words left as they were", async () => {
  const words = (key: string) => [i18n.t(`forms:reportForm.${key}Title`), i18n.t(`forms:reportForm.${key}Description`)];
  const shown = () => [reportTitleField().value, reportDescriptionField().value];
  const pick = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
  const held = [logEntry(), reported, logEntry({ id: "L3", kind: "reported", fromState: "waiting", toState: "held" })];
  const heldData = screenData(tree({ tasks: [taskFixture({ state: "held", baseState: "waiting", ball: review, log: held })] }));
  withInput(heldData, reportPopup(heldData.tasks[0]!));
  for (const [name, key] of [["Done", "approve"], ["Awaiting review", "restore"], ["Stopped", "stop"]] as const) {
    pick(name); expect(shown()).toEqual(words(key));
  }
  cleanup(); closeInput();
  const data = screenData(tree({ tasks: [taskFixture({ state: "waiting", ball: review, log: [logEntry(), reported] })] }));
  withInput(data, reportPopup(data.tasks[0]!));
  expect(shown()).toEqual(words("approve"));
  pick("On hold"); expect(shown()).toEqual(words("hold"));
  // What the person wrote stays, an emptied body too; only the field left as it was follows the choice.
  fireEvent.change(reportTitleField(), { target: { value: "Waiting on the design" } });
  pick("Stopped"); expect(shown()).toEqual(["Waiting on the design", words("stop")[1]]);
  fireEvent.change(reportDescriptionField(), { target: { value: "" } });
  pick("Done"); expect(shown()).toEqual(["Waiting on the design", ""]);
  // Written words stay even when they read like another choice's default.
  fireEvent.change(reportTitleField(), { target: { value: words("approve")[0] } });
  fireEvent.change(reportDescriptionField(), { target: { value: words("approve")[1] } });
  pick("On hold"); pick("Stopped"); expect(shown()).toEqual(words("approve"));
  cleanup(); closeInput();
  // As shown, the words go as they are.
  const sent = withInput(data, reportPopup(data.tasks[0]!));
  pick("On hold"); fireEvent.click(sendReport());
  await waitFor(() => expect(sent.reports).toHaveLength(1));
  expect(sent.reports[0]).toMatchObject({ task: "T1", state: "held", title: words("hold")[0], description: words("hold")[1] });
  // Opened again, or for another task, the form starts from that task's first choice.
  const doing = screenData(tree({ tasks: [taskFixture({ state: "doing" })] }));
  cleanup(); closeInput();
  withInput(doing, reportPopup(doing.tasks[0]!));
  expect(shown()).toEqual(words("hold"));
});

test("a refused report comes back with what the person wrote kept apart from the words that follow the choice", () => {
  const data = screenData(tree({ tasks: [taskFixture({ state: "waiting", ball: review, log: [logEntry(), reported] })] }));
  const key = intentKey(data.info.root, "task/report", "T1");
  const refused = (draft: Record<string, string>) => act(() => useWriteIntentStore.setState({ unavailable: false, entries: { [key]: {
    status: "conflict", operationId: "op", transport: "receipt", payload: { task: "T1" }, draft, attempt: "a", at: new Date(0).toISOString() } } }));
  const shown = () => [reportTitleField().value, reportDescriptionField().value];
  const pick = (name: string) => fireEvent.click(screen.getByRole("radio", { name }));
  try {
    // Written words that read like Done's defaults stay through later choices; the unwritten body follows them.
    refused({ choice: "approve", title: i18n.t("forms:reportForm.approveTitle") });
    withInput(data, reportPopup(data.tasks[0]!));
    expect(shown()).toEqual([i18n.t("forms:reportForm.approveTitle"), i18n.t("forms:reportForm.approveDescription")]);
    pick("On hold"); expect(shown()).toEqual([i18n.t("forms:reportForm.approveTitle"), i18n.t("forms:reportForm.holdDescription")]);
    cleanup(); closeInput();
    // An emptied field comes back empty and stays so.
    refused({ choice: "hold", description: "" });
    withInput(data, reportPopup(data.tasks[0]!));
    pick("Stopped"); expect(shown()).toEqual([i18n.t("forms:reportForm.stopTitle"), ""]);
  } finally { act(() => useWriteIntentStore.setState({ entries: {} })); }
});

test("H holds the open task regardless of its ball; an already held task sends nothing", async () => {
  const asking = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: question })] }));
  const { view, reports } = withInput(asking, <HoldKey task={asking.tasks[0]!} />);
  fireEvent.keyDown(document.body, { key: "h" });
  await waitFor(() => expect(reports).toHaveLength(1));
  expect(reports[0]).toMatchObject({ task: "T1", state: "held" });
  view.unmount();
  // Work with no question is held by the same user intent.
  const working = screenData(tree({ tasks: [taskFixture({ state: "doing", ball: { holder: "owner" } })] }));
  const other = withInput(working, <HoldKey task={working.tasks[0]!} />);
  fireEvent.keyDown(document.body, { key: "h" });
  await act(async () => {});
  expect(other.reports).toHaveLength(1);
  expect(other.reports[0]).toMatchObject({ task: "T1", state: "held" });
  other.view.unmount();
  const heldData = screenData(tree({ tasks: [taskFixture({ state: "held", log: [logEntry({ id: "Lheld", kind: "reported", fromState: "doing", toState: "held" })] })] }));
  const heldInput = withInput(heldData, <HoldKey task={heldData.tasks[0]!} />);
  fireEvent.keyDown(document.body, { key: "h" });
  await act(async () => {});
  expect(heldInput.reports).toEqual([]);
});

test("why the user's turn came is said by the ball: at the limit Continue, on a failure continue with the same AI or another, or Stop", async () => {
  const limit = userBall("limit", "K1", at, { count: 3 });
  const failed = userBall("failed", "F1", at);
  const blocked = userBall("blocked", "B1", at, { code: "too_deep" });
  for (const [ball, words, actions] of [
    [limit, i18n.t("ui:turn.reason.limit", { count: 3 }), ["continue"]],
    [failed, i18n.t("ui:turn.reason.failed"), ["retry", "switch", "stop"]],
    [blocked, i18n.t("ui:turn.reason.depth"), []],
  ] as const) {
    const data = screenData(tree({ tasks: [taskFixture({ state: "doing", ball })] }));
    const task = data.tasks[0]!;
    const { asked, reports } = withInput(data, <TurnReason turn={reasonedTurn(task.ball)!} task={task} />);
    const reason = document.querySelector<HTMLElement>(`[data-turn-reason="${ball.holder === "user" ? ball.reason : ""}"]`)!;
    const buttons = [...reason.querySelectorAll<HTMLElement>("[data-turn-action]")];
    expect(buttons.map((button) => button.dataset.turnAction)).toEqual(actions);
    expect(reason.textContent).toBe([words, ...buttons.map((button) => button.textContent)].join(""));
    for (const [count, button] of buttons.entries()) {
      // A press goes once the input can send: one still on its way to serve holds the next.
      await waitFor(() => expect(useReaderSend.getState().post).not.toBeNull());
      fireEvent.click(button);
      await waitFor(() => expect(asked).toHaveLength(1));
      // The same unchanged Task turn has one fixed submission. Other actions cannot send a second one.
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    expect(asked.map(({ intent, text }) => [intent?.action, text]))
      .toEqual(actions.slice(0,1).map((action) => [action, i18n.t(`reader:intent.${action}`, { id: "T1" })]));
    cleanup();
  }
});

test("Continue with another AI only puts its line in the input; Continue with the same AI then sends its own line", async () => {
  const data = screenData(tree({ tasks: [taskFixture({ state: "error", ball: userBall("failed", "F1", at) })] }));
  const task = data.tasks[0]!;
  const { asked } = withInput(data, <TurnReason turn={reasonedTurn(task.ball)!} task={task} />);
  await waitFor(() => expect(useReaderSend.getState().post).not.toBeNull());
  const button = (action: string) => document.querySelector<HTMLButtonElement>(`[data-turn-action="${action}"]`)!;
  fireEvent.click(button("switch"));
  const field = screen.getByRole("textbox", { name: "Message the coordinator" });
  await waitFor(() => expect(field.textContent).toContain(i18n.t("reader:intent.switch")));
  await act(async () => {});
  expect(asked).toEqual([]);
  // The line is already there: a second press would add nothing.
  expect(button("switch").disabled).toBe(true);
  fireEvent.click(button("retry"));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect([asked[0]!.intent?.action, asked[0]!.text]).toEqual(["retry", i18n.t("reader:intent.retry", { id: "T1" })]);
  expect(field.textContent).toContain(i18n.t("reader:intent.switch"));
});

test("TurnReason Stop reports directly with the displayed task version and no coordinator message", async () => {
  const data = screenData(tree({ tasks: [taskFixture({ state: "error", ball: userBall("failed", "F1", at) })] }));
  const task = data.tasks[0]!;
  const { asked, reports } = withInput(data, <TurnReason turn={reasonedTurn(task.ball)!} task={task} />);
  fireEvent.click(document.querySelector<HTMLElement>('[data-turn-action="stop"]')!);
  await waitFor(() => expect(reports).toHaveLength(1));
  expect(reports[0]).toMatchObject({ task: task.id, state: "stopped", expectedTaskHash: task.hash });
  expect(reports[0]).not.toHaveProperty("aboutRun");
  expect(asked).toEqual([]);
});

test.each(["offline", "read-only"])("%s blocks sending and the inline frame refuses programmatic submission", async (reason) => {
  const data = screenData(tree({ tasks: [awaiting()], writable: reason !== "read-only" }));
  useConnection.setState({ offline: reason === "offline" });
  const task = data.tasks[0]!;
  useViewStore.getState().openReader(task.id);
  const { view, fetcher } = withInput(data, <><AppBar /><Reader mode="docked" /></>);
  // The reader's direct ✔ shares the workspace's write availability.
  const names = ["Mark this task done"];
  const buttons = screen.getAllByRole("button").filter((button) => names.includes(button.textContent?.trim() ?? "") || names.includes(button.getAttribute("aria-label") ?? ""));
  expect(buttons.length).toBe(names.length);
  buttons.forEach((button) => expect((button as HTMLButtonElement).disabled).toBe(true));
  // The state control is the entry of State and report (the reader's form, opened from R).
  view.unmount();
  render(<TestWorkspace data={data}><StateControl task={task} /></TestWorkspace>);
  expect((screen.getByRole("button", { name: /Change state$/ }) as HTMLButtonElement).disabled).toBe(reason === 'read-only');
  cleanup();
  fetcher.mockClear();
  render(<TestWorkspace data={data}>{reportPopup(task)}</TestWorkspace>);
  fireEvent.change(reportTitleField(), { target: { value: "Cannot send" } });
  await act(async () => fireEvent.submit(reportTitleField().closest("form")!));
  expect(fetcher).not.toHaveBeenCalled(); expect(submit("Update").disabled).toBe(true);
});

/** A list row's title with its keys, as the tree draws it. */
function RowTitle({ task }: { task: Task }) {
  const keys = useTitleKeys(task);
  return <button type="button" onKeyDown={keys}>{task.title}</button>;
}

test("title keys respect active responsible runs and offline sends; C makes no Task anywhere", async () => {
  vi.spyOn(globalThis, "fetch");
  const runtime: PlacementDTO["runtime"] = { displayState: "idle", reason: null, sourceRunIds: [], runningCount: 0,
    queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null };
  const placement = (id: string, taskId: string, headRunId: string | null, running: boolean): PlacementDTO => ({ id, taskId, agentId: `A-${id}`,
    profileKey: "codex", responsible: true, active: true, revision: 1, startedAt: at, endedAt: null, headRunId,
    runtime: running ? { ...runtime, displayState: "running", sourceRunIds: [headRunId!], runningCount: 1, since: at } : runtime });
  const data = screenData(tree({ tasks: [dto(), dto({ id: "T7", state: "done" }), dto({ id: "T8" }), dto({ id: "T9" })],
    placements: [placement("P1", "T1", null, false), placement("P8", "T8", "R8", true)],
    runs: [run("R8", { taskId: "T8", placementId: "P8", state: "running", endedAt: null })] }));
  const task = (id: string) => data.tasks.find((each) => each.id === id)!;
  const press = (id: string, key: string) => {
    cleanup(); act(() => useDialogStore.setState({ dialog: null }));
    render(<TestWorkspace data={data}><RowTitle task={task(id)} /></TestWorkspace>);
    fireEvent.keyDown(screen.getByRole("button", { name: task(id).title }), { key });
    return useDialogStore.getState().dialog;
  };
  expect(press("T8", "a")).toBeNull();
  expect(press("T1", "a")).toMatchObject({ form: "responsible", taskId: "T1" });
  // The screen makes no Task: a Task is asked of the coordinator, under a project or a task alike.
  expect(press("P100", "c")).toBeNull();
  expect(press("T1", "c")).toBeNull();

  useConnection.setState({ offline: true });
  for (const key of ["a", "e", "m"]) expect(press("T1", key)).toBeNull();
  expect(press('T1', 'r')).toMatchObject({ form: 'report', taskId: 'T1' });
  expect(fetch).not.toHaveBeenCalled();
});

test('report openers stay available while reconnecting, but sending and unavailable targets stay protected', async () => {
  const data = reportData(), task = data.tasks[0]!;
  const { reports } = withInput(data, <TaskActions task={task} phone={false} />);
  const opener = screen.getByRole('button', { name: 'Change state' }) as HTMLButtonElement;
  const anchor = document.querySelector<HTMLButtonElement>('[data-state-anchor]')!;
  expect(opener.disabled).toBe(false); expect(anchor.disabled).toBe(false);
  await act(async () => { useConnection.setState({ state: 'connecting', offline: true }); });
  expect(screen.getByRole('button', { name: 'Change state' })).toBe(opener);
  expect(opener.disabled).toBe(false); expect(anchor.disabled).toBe(false);
  fireEvent.click(opener);
  fireEvent.change(reportTitleField(), { target: { value: 'Prepared while reconnecting' } });
  expect(submit('Update').disabled).toBe(true);
  await act(async () => { fireEvent.submit(reportTitleField().closest('form')!); });
  expect(reports).toEqual([]);
  await act(async () => { useConnection.setState({ state: 'live', offline: false }); });
  expect(submit('Update').disabled).toBe(false);
  fireEvent.click(submit('Update'));
  await waitFor(() => expect(reports).toHaveLength(1));
  expect(reports[0]).toMatchObject({ task: task.id, expectedTaskHash: task.hash, title: 'Prepared while reconnecting' });
  await act(async () => {
    const query = readQuery(queryClient, resources.taskView(data.info.root, task.id).queryKey)!;
    refuseRead(query, readIndex(queryClient)); query.setState({});
  });
  await waitFor(() => expect(opener.disabled).toBe(true));
  expect(anchor.disabled).toBe(true);
});

test("the reader state control opens the report and keeps the state visible", () => {
  vi.spyOn(globalThis, "fetch");
  const data = screenData(tree({ tasks: [dto({ state: "waiting", log: [logEntry({ toState: "waiting" })] })] }));
  const task = data.tasks[0]!;
  render(<TestWorkspace data={data}><StateControl task={task} /></TestWorkspace>);
  const button = screen.getByRole("button", { name: "Change state" });
  expect(button.textContent).toBe("Change state");
  fireEvent.click(button);
  expect(useDialogStore.getState().dialog).toEqual({ kind: "input", form: "report", taskId: "T1", answerCard: null });
  expect(screen.getByRole("radiogroup", { name: "Change state" })).toBeTruthy();
});

test('Done needs a displayed row and is absent for ended tasks even with a stale review ball', () => {
  const data = sendbackData();
  const task = child(data);
  const view = render(<TestWorkspace data={data}><TaskActions task={task} phone /></TestWorkspace>);
  expect(document.querySelector('[data-task-done]')).toBeNull();
  for (const state of ['done', 'stopped'] as const) {
    view.rerender(<TestWorkspace data={data}><TaskActionSlot /><TaskActions task={{ ...task, state }} phone /></TestWorkspace>);
    expect(document.querySelector('[data-task-done]')).toBeNull();
  }
});

test('a submitted reader turn disables its state form while another Task remains actionable', async()=>{
 const data=screenData(tree({tasks:[awaiting('T1'),awaiting('T2')],home:homeFixture([{taskId:'T1',section:'review'},{taskId:'T2',section:'review'}])}));
 act(()=>useViewStore.getState().openTask('T1',{reader:true}));
 const {reports}=withInput(data,<Reader mode="docked"/>);
 fireEvent.click(screen.getByRole('button',{name:'Mark this task done'}));
 await waitFor(()=>expect(useViewStore.getState().selected).toBe('T2'));
 await waitFor(()=>expect(reports).toHaveLength(1));
 act(()=>useViewStore.getState().openTask('T1',{reader:true}));
 act(()=>openInput({form:'report',taskId:'T1',answerCard:useSitting.getState().card}));
 expect(sendReport().disabled).toBe(true);
 for(const radio of screen.getAllByRole('radio'))expect((radio as HTMLInputElement).disabled).toBe(true);
 act(()=>{closeInput();useViewStore.getState().openTask('T2',{reader:true});});
 await waitFor(()=>expect((screen.getByRole('button',{name:'Mark this task done'}) as HTMLButtonElement).disabled).toBe(false));
 expect(reports).toHaveLength(1);
});

test('a persisted submission disables the original failure actions but not another Task', async()=>{
 const data=screenData(tree({tasks:[taskFixture({id:'T1',state:'waiting',ball:userBall('failed','L1',at)}),taskFixture({id:'T2',state:'waiting',ball:userBall('failed','L2',at)})]}));
 const task=data.tasks[0]!,other=data.tasks[1]!,id=crypto.randomUUID();
 freeze(data.info.root,{conversationId:'c1',text:'Retry T1',tasks:['T1'],attachments:[],intent:{task:'T1',action:'retry'}},{requestId:id,doc:JSON.stringify(textDocument('Retry T1'))},undefined,[{...readerTurn(task),kind:'intent',title:task.title,answer:'send',expectedWrites:[]}]);
 withInput(data,<><TurnReason turn={reasonedTurn(task.ball)!} task={task}/><TurnReason turn={reasonedTurn(other.ball)!} task={other}/></>);
 const retry=screen.getAllByRole('button',{name:'Continue with the same AI'}),another=screen.getAllByRole('button',{name:'Continue with another AI'}),stop=screen.getAllByRole('button',{name:'Stop'});
 expect((retry[0] as HTMLButtonElement).disabled).toBe(true);expect((another[0] as HTMLButtonElement).disabled).toBe(true);expect((stop[0] as HTMLButtonElement).disabled).toBe(true);
 await waitFor(()=>expect((retry[1] as HTMLButtonElement).disabled).toBe(false));expect((stop[1] as HTMLButtonElement).disabled).toBe(false);
});
