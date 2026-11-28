import { recordReadProof, captureReadProof } from '../src/data/read-model';
import { resources } from '../src/data/resources';
import { taskReadState } from '../src/data/read-model';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { waitFor, act, cleanup, fireEvent, render } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { Ball } from "@alpacawork/contract";
import { queryClient } from "../src/data/query-client";
import { TimeTree } from "../src/features/tree/TimeTree";
import { Reader } from "../src/features/reader/Reader";
import { indexKey, applyReadEvidence } from "../src/data/resources";
import { serverReadFacts } from '../src/data/read-model';
import { mapWorkspace } from "../src/data/map";
import { indexPeople } from "../src/domain/people";
import { BriefLine } from "../src/features/reader/BriefLine";
import { TaskLabel } from "../src/components/ui/state-label";
import { useViewStore } from "../src/state/view-store";
import { taskDetail, useTaskIndex } from "../src/data/queries";
import type { TaskIndex } from "../src/domain/tasks";
import { useDialogStore } from "../src/state/dialog-store";
import { useDocumentTitle } from "../src/features/chrome/use-document-title";
import { leadOf } from "../src/domain/lead";
import { TestWorkspace, at, baselines, dto, homeFixture, indexOf, logEntry, narrowScreen, decideItem, questionFixture, run, screenData, 
  taskFixture, tree, userBall, viewsOf, PROJECT_TASK } from "./fixtures";

/** Rest longer than the former card delay to detect delayed hover work. */
function restOnTitle(label: Element) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.pointerEnter(label, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(600));
  vi.useRealTimers();
}

const review = (key = "L2", when = at) => userBall("review", key, when, { aboutRunId: "R1" });
const asking = (key = "L2", when = at) => userBall("question", key, when, { questionId: key });
/** The question `id` asked of T1 (or `taskId`), listed on its row by `title`. */
const listed = (title: string, taskId = "T1", id = "L2") => questionFixture({ id, taskId, title, decide: [decideItem(title, [["Yes", "Answer"]])] });
const reported = logEntry({ id: "L2", kind: "reported", fromState: "doing", toState: "waiting" });

/**
 * A row of the home list (TimeTree), and the state words it shares with the rest of the screen. The list is the
 * server's: T11, a request of the user's under T1, waits on the user's review in Your turn; T1 is not started, with one
 * child of which none finished.
 */
const child = taskFixture({ id: "T11", parentId: "T1", path: "tasks/T11", title: "Child that waits", userRequested: true, state: "waiting",
  log: [logEntry({ userRequested: true }), reported], ball: review() });
const data = () => screenData(tree({ tasks: [dto({ state: "todo", userRequested: true }), child],
  home: homeFixture([{ taskId: "T11", section: "review" }, { taskId: "T1", section: "todo", summary: { done: 0, total: 1 } }]) }));
/** The list, whose sections other than Done are never folded. */
const list = (screenful = data()) => render(<TestWorkspace data={screenful}><TimeTree /></TestWorkspace>);
const head = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-row="${id}"] > [data-row-head]`)!;

test("a list row leaves right-click to the browser on a computer and a phone", () => {
  const rightClick = (target: HTMLElement) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 });
    act(() => { target.dispatchEvent(event); });
    return event;
  };
  const view = list();
  expect(rightClick(head(view.container, "T1")).defaultPrevented).toBe(false);
  expect(useDialogStore.getState().dialog).toBeNull();
  view.unmount();
  const narrow = narrowScreen(true);
  try {
    const phone = list();
    expect(phone.container.querySelector("[data-row-controls]")).toBeNull();
  } finally { narrow.restore(); }
});

test("a closed scope update removes old rows from current projection; the shown list keeps them as dated rows, and the reader data stays for UI binding", async () => {
  const value = tree({ tasks: [dto({ state: "done" })], home: homeFixture([{ taskId: "T1", section: "done" }]) });
  const first = screenData(value);
  const seed = first.seed;
  first.seed = () => {
    seed();
    // The opened view stays a current read while the closed page loses authority.
    const key = resources.taskView(value.root, 'T1').queryKey;
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })!;
    recordReadProof(query, captureReadProof(indexOf(value), key));
  };
  const before = { ...indexOf(value), tasks: [] };
  queryClient.setQueryData(indexKey, before);
  const view = render(<TestWorkspace data={first}><TimeTree /><Reader mode="docked" /></TestWorkspace>);
  fireEvent.click(view.container.querySelector<HTMLElement>('[data-section="done"] button')!);
  act(() => useViewStore.getState().openReader("T1"));
  await waitFor(() => expect(view.container.querySelector('[data-reader-task-id]')?.textContent).toBe("T1"));
  const row = view.container.querySelector('[data-row="T1"]');
  const aside = view.container.querySelector('aside[aria-label]');
  expect(row).toBeTruthy();
  expect(aside).toBeTruthy();

  // T1 leaves the closed page: the server raises the page and T1's own view.
  const after = { ...before, rev: before.rev + 1, requiredPv: { ...before.requiredPv, page: { "finished:root": 1 as never }, view: { T1: 1 as never } } };
  act(() => {
    applyReadEvidence(queryClient, after);
  });
  const projected = { ...after, ...serverReadFacts(queryClient)! };
  const mapped = mapWorkspace(projected, baselines(value.tasks));
  const taskView = viewsOf(value)[0]!;
  const next = { ...first, ...mapped,
    tasks: mapped.tasks.map(task => taskDetail(task, taskView)),
    shelved: mapped.shelved.map(item => ({ ...item, task: taskDetail(item.task, taskView) })),
    people: indexPeople(projected), info: { ...first.info, rev: after.rev, counts: after.counts }, seed: () => {} };
  view.rerender(<TestWorkspace data={next}><TimeTree /><Reader mode="docked" /></TestWorkspace>);
  // Not a current fact any more; the open Done list draws it from its own Query, as of its time.
  expect(projected.tasks.some(task => task.id === "T1")).toBe(false);
  expect(view.container.querySelector<HTMLElement>('[data-row="T1"]')!.dataset.dated).toBe("true");
  expect(view.container.querySelector('[data-row="T1"]')).toBe(row);
  expect(view.container.querySelector('aside[aria-label]')).toBe(aside);
  expect(taskReadState(queryClient, after.root, 'T1').assessment.display).toBe(true);
  expect(queryClient.getQueryData(resources.taskView(after.root, 'T1').queryKey)).toBeDefined();
});

beforeAll(() => startI18n());
beforeEach(() => { useViewStore.setState(useViewStore.getInitialState()); useDialogStore.setState(useDialogStore.getInitialState()); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

test("wait reasons use the same words and emphasis on labels", () => {
  for (const [state, ball, key, emphasized] of [
    ["waiting", review(), "state.waitingReview", true],
    ["doing", asking(), "turn.question", true],
    ["waiting", null, "state.waitingReview", false],
  ] as const) {
    const label = render(<TaskLabel task={{ state, ball, rowFacts: null }} />);
    expect(label.container.textContent).toContain(i18n.t(`ui:${key}`));
    expect(label.container.firstElementChild?.className.includes("text-turn")).toBe(emphasized);
    label.unmount();
  }
});

test("a review and a question are both your turn's colour, told apart by their icon and word", () => {
  const look = (reason: "review" | "question") => {
    const view = render(reason === "review" ? <TaskLabel task={{ state: "waiting", ball: review(), rowFacts: null }} />
      : <TaskLabel task={{ state: "doing", ball: asking(), rowFacts: null }} />);
    const svg = view.container.querySelector("svg")!;
    const seen = { colour: svg.getAttribute("class")!.split(" ").find((name) => name.startsWith("text-") && name !== "text-xs"),
      icon: svg.getAttribute("data-icon"), word: view.container.textContent };
    view.unmount();
    return seen;
  };
  expect(look("review")).toEqual({ colour: "text-turn", icon: "review", word: i18n.t("ui:state.waitingReview") });
  expect(look("question")).toEqual({ colour: "text-turn", icon: "question", word: i18n.t("ui:turn.question") });
});

test.each([
  ["review", "Awaiting review", "review", "Review"],
  ["question", "Question", "question", "Question"],
  [null, "Awaiting review", null, null],
] as const)("a %s turn's phone row says it by its icon and the kind's word, with no time in Awaiting review; no state word is drawn", (reason, word, kind, label) => {
  const questioned = reason === "question";
  const ball: Ball | null = reason === "review" ? review() : questioned ? asking() : null;
  const task = taskFixture({ state: questioned ? "doing" : "waiting", ball, log: [logEntry(), questioned
    ? logEntry({ id: "L2", kind: "asked", askedTo: null, title: "Which one?", description: "Please answer", actor: { kind: "placement", placementId: "P1" } })
    : reported] });
  // Own review facts stay in review even when no user ball is available.
  const screenful = () => screenData(tree({ tasks: [task], questions: questioned ? [listed("Which one?")] : [],
    home: homeFixture([{ taskId: "T1", section: "review" }]) }));
  const wide = list(screenful());
  expect(wide.container.querySelector('[data-row="T1"] [data-row-meta]')).toBeNull();
  expect(wide.container.querySelector('[data-row="T1"] [data-read]')?.textContent).toContain("T1");
  cleanup();
  const phone = narrowScreen(true);
  try {
    const { container } = list(screenful());
    const press = container.querySelector<HTMLElement>('[data-row="T1"] [data-read]')!;
    const meta = container.querySelector<HTMLElement>('[data-row="T1"] [data-row-meta]')!;
    expect(press.getAttribute("aria-describedby")).toBe(meta.id);
    expect(press.contains(meta)).toBe(false);
    // A screen reader hears the state's word; the screen shows it as the icon, and the id stays quiet.
    expect(press.querySelector(".sr-only")?.textContent).toBe(word);
    expect(meta.querySelector("[data-row-own-id]")?.className).toBe("");
    const shown = meta.cloneNode(true) as HTMLElement;
    shown.querySelectorAll(".sr-only, [data-row-kind]").forEach((each) => each.remove());
    expect(shown.textContent).not.toContain(word);
    const words = meta.querySelector<HTMLElement>("[data-row-kind]");
    expect(words?.dataset.rowKind ?? null).toBe(kind);
    if (label) expect(words?.textContent).toBe(label);
    // What it asks is read in the task, not on its row.
    expect(press.textContent).not.toContain("Which one?");
    expect(meta.textContent).not.toContain("Which one?");
    // Its home review section suppresses every time.
    expect(meta.querySelector<HTMLElement>("[data-row-status]")?.dataset.rowStatus).toBeUndefined();
  } finally { phone.set(false); phone.restore(); }
});

test("a parent's row says the server's summary of its children; the wait below it is its own row in Waiting for you, once (J2)", () => {
  const { container } = list();
  expect(head(container, "T11").querySelector("[data-read]")?.textContent).toContain("T11");
  expect(container.querySelectorAll('[data-row="T11"]')).toHaveLength(1);
  expect(container.querySelector('[data-section="review"] + ol [data-row="T11"]')).toBeTruthy();
  expect(head(container, "T1").querySelector("[data-row-progress]")?.textContent).toBe("0/1");
});

test("a Working row whose own Run does not run stands for the work below: running while a child runs, else queued", () => {
  const states = { todo: 0, doing: 1, error: 0, waiting: 0, held: 0, done: 0, stopped: 0 };
  const screenful = (runningBelow: number) => screenData(tree({ tasks: [dto({ state: "doing", userRequested: true }),
    dto({ id: "T11", parentId: "T1", path: "tasks/T11", state: "doing" })],
  home: homeFixture([{ taskId: "T1", section: "doing", summary: { done: 0, total: 1 } }]),
  children: { T1: { live: 1, finished: 0, states, runningBelow, below: 1 } } }));
  const status = (container: HTMLElement) => head(container, "T1").querySelector<HTMLElement>("[data-row-status]");
  const running = list(screenful(2));
  expect(status(running.container)?.dataset.rowStatus).toBe("running");
  expect(status(running.container)?.textContent).toBe(i18n.t("tree:status.running"));
  running.unmount();
  expect(status(list(screenful(0)).container)?.dataset.rowStatus).toBe("queued");
});

test("the one-line row leaves its artifacts out of the title", () => {
  const screenful = screenData(tree({ tasks: [dto({ body: "- 成果物: Report — location /tmp/report.md" })],
    home: homeFixture([{ taskId: "T1", section: "doing" }]) }));
  const { container } = list(screenful);
  expect(container.textContent).not.toContain("Report");
  expect(container.querySelector("[data-row='T1'] [data-card-lead]")).toBeNull();
  expect(container.querySelector("[data-row='T1'] [data-read]")?.textContent).toContain("Task one");
});

test("a newer human comment cannot replace the owner's report in a working task's summary", () => {
  const reportAt = "2026-09-24T10:00:00Z", report = "Owner checked 12 sample cards";
  const data = screenData(tree({ tasks: [dto({ state: "doing", log: [
    logEntry({ id: "Lowner", kind: "reported", at: reportAt, title: report,
      actor: { kind: "placement", placementId: "P1" }, runId: "R1", toState: "doing" }),
    logEntry({ id: "Lhuman", kind: "reported", at: "2026-09-24T11:00:00Z", title: "Human scheduling comment",
      actor: { kind: "human" }, toState: null }),
  ] })], placements: [{ id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true,
    active: true, revision: 1, startedAt: at, endedAt: null, headRunId: "R1",
    runtime: { displayState: "idle", reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
      since: null, lastOutputAt: null, activityKind: null, toolName: null } }],
    runs: [run("R1", { placementId: "P1", startedAt: "2026-09-24T09:00:00Z", endedAt: "2026-09-24T10:30:00Z" })] }));
  const task = data.tasks.find(task => task.id === "T1")!;
  expect(task.state).toBe("doing");
  expect(task.stateLog.map(entry => entry.id)).toContain("Lhuman");
  expect(leadOf(task, data.people)).toMatchObject({ kind: "doing", line: report, at: reportAt });
});

test("a running owner's image report is absent from the row and its hover", () => {
  const report = "Checked 12 sample cards";
  const value = tree({ tasks: [dto({ log: [logEntry(), logEntry({ id: "L2", kind: "reported", at: "2026-09-24T10:00:00Z",
    actor: { kind: "placement", placementId: "P1" }, runId: "R1", toState: "doing", title: report,
    description: "[Breakdown](plan.md)\n![Two items in red](report.png)\nCheck the two remaining sample cards." })] })],
    placements: [{ id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true, active: true,
      revision: 1, startedAt: "2026-09-24T09:00:00Z", endedAt: null, headRunId: "R1",
      runtime: { displayState: "running", reason: null, sourceRunIds: ["R1"], runningCount: 1, queuedCount: 0,
        since: "2026-09-24T09:00:00Z", lastOutputAt: null, activityKind: null, toolName: null } }],
    runs: [run("R1", { state: "running", endedAt: null })], home: homeFixture([{ taskId: "T1", section: "doing" }]) });
  const data = screenData(value);
  expect(leadOf(data.tasks[0]!, data.people).line).toBe(report);
  const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const row = container.querySelector('[data-row="T1"]');
  expect(row?.textContent).not.toContain(report);
  expect(row?.textContent).not.toContain("![");
  expect(row?.textContent).not.toContain("Two items in red");
  restOnTitle(row!.querySelector("[data-row-label]")!);
  expect(document.querySelector("[data-reading-note]")).toBeNull();
});

test("a home child owns a row of its own; the title opens the detail", () => {
  const { container } = list(screenData(tree({ tasks: [dto({ state: "todo" }),
    dto({ id: "T11", parentId: "T1", path: "tasks/T11", title: "Child at work", state: "doing" })],
    home: homeFixture([{ taskId: "T11", section: "doing" }, { taskId: "T1", section: "todo" }]) })));
  expect(head(container, "T1").querySelector("[data-fold]")).toBeNull();
  expect(head(container, "T11").querySelector("[data-read]")?.textContent).toContain("T11");
  fireEvent.click(container.querySelector('[data-read="T1"]')!);
  expect(useViewStore.getState()).toMatchObject({ selected: "T1", reader: { open: true } });
});

test("a press on the row's words outside the title and its controls opens the detail too", () => {
  const { container } = list();
  fireEvent.click(head(container, "T11").querySelector("[data-row-end]")!);
  expect(useViewStore.getState()).toMatchObject({ selected: "T11", reader: { open: true } });
});

test("Not started stays open and lists only the rows the server lists, a parent with the count of its children", async () => {
  await act(async () => { await i18n.changeLanguage("en"); });
  const { container } = render(<TestWorkspace data={screenData(tree({ tasks: [dto({ state: "todo" }),
    dto({ id: "T11", parentId: "T1", path: "tasks/T11", state: "todo" }),
    dto({ id: "T12", parentId: "T1", path: "tasks/T12", state: "todo" })],
    home: homeFixture([{ taskId: "T1", section: "todo", summary: { done: 0, total: 2 } }]) }))}><TimeTree /></TestWorkspace>);
  expect(container.querySelector('[data-section="todo"]')?.textContent).toContain("Not started1");
  expect(container.querySelector('[data-row="T1"] [data-row-progress]')?.textContent).toBe("0/2");
  expect(container.querySelector('[data-row="T11"], [data-row="T12"]')).toBeNull();
  await act(async () => { await i18n.changeLanguage("en"); });
});

test("R on a row's title opens the report input; Shift+Enter opens the full text", () => {
  const { container } = list();
  const title = container.querySelector<HTMLElement>('[data-read="T1"]')!;
  fireEvent.keyDown(title, { key: "r" });
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "input", form: "report", taskId: "T1" });
  act(() => { useDialogStore.setState({ dialog: null }); useViewStore.setState(useViewStore.getInitialState()); });
  fireEvent.keyDown(container.querySelector<HTMLElement>('[data-read="T1"]')!, { key: "Enter", shiftKey: true });
  expect(useViewStore.getState()).toMatchObject({ selected: "T1", reader: { open: true } });
});

/** A task waiting on the user's review since `when`. */
const waiting = (id: string, when = at) => taskFixture({ id, state: "waiting", ball: review("L2", when),
  log: [logEntry({ toState: "waiting" }), reported] });
function Title() { useDocumentTitle(); return null; }

test("every heading opens and closes its section from where it starts; this device keeps the choice across a reload", () => {
  const running = Array.from({ length: 5 }, (_, i) => dto({ id: `T${i + 1}`, state: "doing" }));
  const held = taskFixture({ id: "T7", state: "held", ball: review("L2"),
    log: [logEntry(), reported, logEntry({ id: "L3", kind: "reported", fromState: "waiting", toState: "held" })] });
  const data = screenData(tree({ tasks: [...running, waiting("T6"), held],
    home: homeFixture([...running.map((task) => ({ taskId: task.id, section: "doing" as const })),
      { taskId: "T6", section: "review" }, { taskId: "T7", section: "held" }]) }));
  const head = (section: string) => document.querySelector<HTMLButtonElement>(`[data-section="${section}"] button`)!;
  const rows = (section: string) => document.querySelectorAll(`[data-section="${section}"] + ol > [data-row]`).length;
  const more = () => document.querySelector<HTMLButtonElement>('[data-group-more="doing"] button');
  const draw = () => { cleanup(); render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>); };
  draw();
  // In progress shows its first four; On hold starts closed.
  expect([head("doing"), head("review"), head("held")].map((button) => button.getAttribute("aria-expanded"))).toEqual(["true", "true", "false"]);
  expect([rows("doing"), rows("review"), rows("held")]).toEqual([4, 1, 0]);
  fireEvent.click(more()!);
  expect(rows("doing")).toBe(5);
  fireEvent.click(head("doing"));
  fireEvent.click(head("held"));
  expect([rows("doing"), rows("held")]).toEqual([0, 1]);
  expect(more()).toBeNull();
  draw();
  expect([head("doing"), head("review"), head("held")].map((button) => button.getAttribute("aria-expanded"))).toEqual(["false", "true", "true"]);
  expect([rows("doing"), rows("held")]).toEqual([0, 1]);
  // Opened again, it starts from its first four once more.
  fireEvent.click(head("doing"));
  expect(rows("doing")).toBe(4);
});

test("home headings follow the requested order and words in both languages; a section is drawn while it holds something", async () => {
  const held = taskFixture({ id: "T2", state: "held", ball: review("L2"),
    log: [logEntry(), reported, logEntry({ id: "L3", kind: "reported", fromState: "waiting", toState: "held" })] });
  const { container } = render(<TestWorkspace data={screenData(tree({ tasks: [waiting("T1"), held, dto({ id: "T3", state: "todo" }), dto({ id: "T4", state: "doing" })],
    home: homeFixture([{ taskId: "T1", section: "review" }, { taskId: "T2", section: "held" }, { taskId: "T3", section: "todo" }, { taskId: "T4", section: "doing" }]) }))}><Title /><TimeTree /></TestWorkspace>);
  const headings = () => [...container.querySelectorAll<HTMLElement>("[data-section]")].map((head) => ({
    group: head.dataset.section, text: head.textContent?.trim(),
  }));
  expect(headings()).toEqual([
    { group: "doing", text: "In progress1" },
    { group: "review", text: "Awaiting review1" },
    { group: "todo", text: "Not started1" },
    { group: "held", text: "On hold1" },
  ]);
  await act(async () => { await i18n.changeLanguage("ja"); });
  expect(headings()).toEqual([
    { group: "doing", text: "作業中1" },
    { group: "review", text: "確認待ち1" },
    { group: "todo", text: "未着手1" },
    { group: "held", text: "保留1" },
  ]);
  expect(document.title).toContain("確認待ち 1件");
  await act(async () => { await i18n.changeLanguage("en"); });
});

test("a section with nothing in it is not drawn, its heading included; the first drawn has no space above it", () => {
  render(<TestWorkspace data={screenData(tree({ tasks: [dto({ id: "T1", state: "todo" })],
    home: homeFixture([{ taskId: "T1", section: "todo" }]) }))}><TimeTree /></TestWorkspace>);
  expect([...document.querySelectorAll<HTMLElement>("[data-section]")].map(head => head.dataset.section)).toEqual(["todo"]);
  expect(document.querySelector('[data-section="todo"]')!.className).not.toMatch(/\bmt-3\b/);
  expect(document.querySelector("[data-welcome]")).toBeNull();
  expect(document.querySelector("[data-time-corner]")).not.toBeNull();
});

test("a list holding nothing draws no section, no clock and no time ground; its place says how work starts", () => {
  render(<TestWorkspace data={screenData(tree({ tasks: [], home: homeFixture([]) }))}><TimeTree /></TestWorkspace>);
  expect(document.querySelector("[data-section]")).toBeNull();
  expect(document.querySelector("[data-time-corner]")).toBeNull();
  expect(document.querySelector("[data-time-ground]")).toBeNull();
  expect(document.querySelectorAll("[data-welcome] [data-welcome-picture-part]")).toHaveLength(4);
});

test("an unread row has a dot at its start, in the one colour for not yet read; a read row has none", () => {
  const screenful = screenData(tree({ tasks: [waiting("T1"), dto({ id: "T2", state: "doing" }), dto({ id: "T3", state: "todo" })],
    home: homeFixture([{ taskId: "T2", section: "doing" }, { taskId: "T1", section: "review" }, { taskId: "T3", section: "todo" }]) }));
  screenful.readIds = new Set(["T3"]);
  const { container } = list(screenful);
  const dot = (id: string) => head(container, id).querySelector("[data-unread]");
  expect(dot("T1")?.getAttribute("class")).toContain("bg-changed");
  expect(dot("T2")?.getAttribute("class")).toContain("bg-changed");
  expect(dot("T3")).toBeNull();
});

test("a stopped run of what you asked for uses the error icon in Errors, and its brief says why your turn came", () => {
  const stopped = taskFixture({ id: "T2", path: "tasks/T2", title: "Stopped", userRequested: true, state: "error",
    ball: userBall("failed", "F1", at), log: [logEntry({ id: "L1", userRequested: true })] });
  const placement = { id: "P2", taskId: "T2", agentId: "A-P2", profileKey: "codex", responsible: true, active: true, revision: 1,
    startedAt: "2026-09-24T09:00:00Z", endedAt: null, headRunId: null,
    runtime: { displayState: "attention" as const, reason: "exit" as const, sourceRunIds: [], runningCount: 0, queuedCount: 0, since: null,
      lastOutputAt: null, activityKind: null, toolName: null } };
  const data = screenData(tree({ tasks: [stopped], placements: [placement], home: homeFixture([{ taskId: "T2", section: "error" }]) }));
  const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const row = container.querySelector<HTMLElement>('[data-section="error"] + ol [data-row="T2"]')!;
  expect(row).not.toBeNull();
  expect(row.querySelector('[data-row-label] [data-icon="error"]')).toBeTruthy();
  expect(row.querySelector("[data-asks-too]")).toBeNull();
  expect(row.querySelector("[data-card-lead]")).toBeNull();
  expect(row.querySelector<HTMLElement>("[data-row-label]")?.style.height).toBe("32px");
  const task = data.tasks.find((each) => each.id === "T2")!;
  const brief = render(<TestWorkspace data={data}><BriefLine task={task} people={data.people} /></TestWorkspace>);
  expect(brief.container.querySelector('[data-turn-reason="failed"]')?.textContent).toBe(i18n.t("ui:turn.reason.failed"));
  expect(brief.container.querySelector("[data-asks]")).toBeNull();
});

test("a working row does not present a question it lists as yours, while the ball does not ask it of you", () => {
  const working = taskFixture({ id: "T8", title: "Working, its question with the parent", state: "doing",
    ball: { holder: "parent", reason: "question" } });
  const data = screenData(tree({ tasks: [working], questions: [listed("Old question", "T8")], home: homeFixture([{ taskId: "T8", section: "doing" }]) }));
  const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const row = container.querySelector<HTMLElement>('[data-row="T8"]')!;
  expect(row.querySelector("[data-asks-too]")).toBeNull();
  const brief = render(<TestWorkspace data={data}><BriefLine task={data.tasks[0]!} people={data.people} /></TestWorkspace>);
  expect(brief.container.querySelector("[data-asks]")).toBeNull();
  expect(brief.container.textContent).not.toContain("Old question");
});

test("a phone row says why your turn came in a short word that gives way last; the sentence is its title", () => {
  const phone = narrowScreen(true);
  try {
    for (const [ball, word, sentence] of [
      [userBall("limit", "K1", at, { count: 1 }), "tree:status.turn.limit", i18n.t("ui:turn.reason.limit", { count: 1 })],
      [userBall("blocked", "B1", at, { code: "too_many_children" }), "tree:status.turn.children", i18n.t("ui:turn.reason.children")],
      [userBall("blocked", "B2", at, { code: "unlisted" }), "tree:status.turn.refused", i18n.t("ui:turn.reason.refused")],
    ] as const) {
      const turned = taskFixture({ id: "T1", state: "doing", userRequested: true, ball });
      const { container } = render(<TestWorkspace data={screenData(tree({ tasks: [turned],
        home: homeFixture([{ taskId: "T1", section: "review" }]) }))}><TimeTree /></TestWorkspace>);
      const words = container.querySelector<HTMLElement>('[data-row="T1"] [data-row-kind]')!;
      expect(words.dataset.rowKind).toBe("followup");
      expect(words.textContent).toBe(i18n.t(word));
      expect(words.textContent).not.toBe(word.split(":")[1]); // a key lost from both languages would show itself
      expect(words.title).toBe(sentence);
      // It is cut with "…" only after the counts and notes beside it have given way, and never pushes the times out.
      expect(words.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "shrink-[0.0001]", "truncate"]));
      cleanup(); queryClient.clear();
    }
  } finally { phone.restore(); }
});

test("a phone working row omits a question it lists but does not ask you", () => {
  const task = dto({ id: "T8", state: "doing" });
  const placement = { id: "P8", taskId: "T8", agentId: "A-P8", profileKey: "codex", responsible: true, active: true, revision: 1,
    startedAt: "2026-09-24T09:00:00Z", endedAt: null, headRunId: null,
    runtime: { displayState: "running" as const, reason: null, sourceRunIds: [], runningCount: 1, queuedCount: 0, since: null,
      lastOutputAt: null, activityKind: null, toolName: null } };
  const phone = narrowScreen(true);
  try {
    const { container } = render(<TestWorkspace data={screenData(tree({ tasks: [task], placements: [placement],
      questions: [listed("Old question", "T8")], home: homeFixture([{ taskId: "T8", section: "doing" }]) }))}><TimeTree /></TestWorkspace>);
    const row = container.querySelector('[data-row="T8"] [data-row-meta]');
    expect(row).toBeTruthy();
    expect(row?.textContent).not.toContain(i18n.t("ui:turn.question"));
    expect(row?.textContent).not.toContain("Old question");
  } finally { phone.restore(); }
});

test("at the limit the brief says only why your turn came; a question is its line only while the ball asks it of you", () => {
  const question = "Check the current question.".repeat(30);
  const brief = (ball: Ball) => {
    const data = screenData(tree({ tasks: [taskFixture({ state: "doing", ball })], questions: [listed(question)] }));
    return render(<TestWorkspace data={data}><BriefLine task={data.tasks[0]!} people={data.people} className="line-clamp-1" /></TestWorkspace>).container;
  };
  const limited = brief(userBall("limit", "K1", at, { count: 1 }));
  const reason = limited.querySelector<HTMLElement>('[data-turn-reason="limit"]')!;
  expect(reason.textContent).toBe(i18n.t("ui:turn.reason.limit", { count: 1 }));
  expect(reason.className).toContain("line-clamp-1");
  expect(limited.querySelector("[data-asks]")).toBeNull();
  expect(limited.textContent).not.toContain(question);
  cleanup();
  const asked = brief(asking());
  const asks = asked.querySelector<HTMLElement>("[data-asks]")!;
  expect(asks.className).toContain("line-clamp-1");
  expect(asks.textContent).toBe(`${i18n.t("ui:turn.question")}${question}`);
  expect(asked.querySelector("[data-turn-reason]")).toBeNull();
});
