import { queryClient } from '../src/data/query-client';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { Reader } from "../src/features/reader/Reader";
import { openScreenLink, useUrlBootstrap } from "../src/state/bootstrap";
import { noteReaderScroll } from "../src/state/reader-position";
import { useEveryTaskIndex } from "../src/data/queries";
import { useViewStore } from "../src/state/view-store";
import { useTimeView } from "../src/state/time-view";
import * as motion from "../src/lib/motion";
import { at, dto, historyFixture, logEntry, narrowScreen, openReference, pointerCanHover, decideItem, questionFixture, run, screenData, taskFixture, TestWorkspace, tree,
  userBall } from "./fixtures";

/** Whether the reader marked `element` as the reference it came back to (the turn tint with its ring). */
const marked = (element: Element | null) => vi.mocked(motion.tint).mock.calls.some(([target, tone, ring]) => !!element && target === element && tone === "turn" && ring);
beforeEach(() => { vi.spyOn(motion, "tint"); });

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
beforeEach(() => {
  queryClient.clear();
  history.replaceState(null, "", "/");
  useViewStore.setState(useViewStore.getInitialState());
  useTimeView.setState(useTimeView.getInitialState());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const placement = { id: "P2", taskId: "T2", agentId: "A2", profileKey: "codex", responsible: true,
  active: true, revision: 1, startedAt: at, endedAt: null, headRunId: null,
  runtime: { displayState: "idle" as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
    since: null, lastOutputAt: null, activityKind: null, toolName: null } };
const source = dto({ id: "T1", title: "Source", body: "T2 Please review", log: [logEntry({ id: "L1", kind: "reported",
  title: "Report with links", description: "T2 Please review", actor: { kind: "placement", placementId: "P1" } })] });
/** T2's history remains separate from its compact reference card. */
const target = dto({ id: "T2", title: "Destination", log: [
  logEntry({ id: "Lold", kind: "reported", at: "2026-09-24T08:00:00Z", title: "Old report", actor: { kind: "placement", placementId: "P2" }, runId: "R2" }),
  logEntry({ id: "Lnew", kind: "reported", at: "2026-09-24T10:00:00Z", title: "Latest report", actor: { kind: "placement", placementId: "P2" }, runId: "R2" }),
] });
const targetRun = run("R2", { taskId: "T2", placementId: "P2", startedAt: "2026-09-24T07:30:00Z", endedAt: "2026-09-24T10:30:00Z" });
/** A report of a placement's that sets no state, as History's event of it. */
const comment = (taskId: string, id: string, when: string, title: string, summary = "") =>
  historyFixture([{ id, kind: "comment", taskId, at: when, title, summary, runId: taskId === "T1" ? "R1" : "R2", author: { kind: "owner", profileKey: "codex" } }]);
/** The tasks' History pages as the server sends them, newest first: T1's report with its reference, T2's reports. */
const histories = { T1: comment("T1", "L1", at, "Report with links", "T2 Please review"),
  T2: [...comment("T2", "Lnew", "2026-09-24T10:00:00Z", "Latest report"), ...comment("T2", "Lold", "2026-09-24T08:00:00Z", "Old report")] };
const data = () => screenData(tree({ tasks: [source, target], placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement],
  runs: [targetRun], history: histories }));

test("a desktop reference shows its actionable task card on hover, whose Open follows it", () => {
  vi.useFakeTimers();
  pointerCanHover();
  try {
    const workspace = data();
    const follow = vi.fn();
    render(<TestWorkspace data={workspace}><MarkdownBody task={workspace.tasks[0]!} text="T2" onFollow={follow} /></TestWorkspace>);
    const reference = screen.getByRole("button", { name: "T2" });
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(600));
    const card = screen.getByRole("dialog", { name: "T2" });
    expect(card.textContent).toContain("Destination");
    expect(card.textContent).toContain(i18n.t(`ui:state.${workspace.tasks.find(task => task.id === "T2")!.state}`));
    expect(card.textContent).not.toContain("Latest report");
    expect(card.textContent).not.toContain("Old report");
    expect(card.textContent).not.toContain("tokens");
    expect(follow).not.toHaveBeenCalled();
    fireEvent.click(card.querySelector<HTMLElement>("[data-task-card-open]")!);
    expect(follow).toHaveBeenCalledWith("T2");
  } finally { vi.useRealTimers(); }
});

test("comments do not replace the title and Open in the shared task card", () => {
  vi.useFakeTimers();
  pointerCanHover();
  try {
    const commented = dto({ ...target, log: [...target.log, logEntry({ id: "Lcomment", kind: "reported",
      at: "2026-09-24T11:00:00Z", title: "Human comment", actor: { kind: "human" } })] });
    const workspace = screenData(tree({ tasks: [source, commented],
      placements: [{ ...placement, id: "P1", taskId: "T1" }, placement], runs: [targetRun] }));
    expect(workspace.tasks[1]!.logs.map(log => log.id)).toEqual(["Lnew", "Lcomment"]);
    render(<TestWorkspace data={workspace}><MarkdownBody task={workspace.tasks[0]!} text="T2" onFollow={vi.fn()} /></TestWorkspace>);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "T2" }), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(600));
    const card = screen.getByRole("dialog", { name: "T2" });
    expect(card.textContent).toContain("Destination");
    expect(card.textContent).not.toContain("Human comment");
    expect(card.textContent).not.toContain("Latest report");
    expect(card.querySelector("[data-task-card-open]")).not.toBeNull();
  } finally { vi.useRealTimers(); }
});

test("a reference to a task with a question uses the same compact actionable card", () => {
  vi.useFakeTimers();
  pointerCanHover();
  try {
    const asking = dto({ ...target, state: "doing", body: "## 問い\n### 1 Proceed this way?",
      log: [...target.log, logEntry({ id: "Lwait", kind: "asked", askedTo: null, at: "2026-09-24T11:00:00Z", title: "Please decide",
        description: "Proceed this way?", actor: { kind: "placement", placementId: "P2" } })] });
    // The open question as the server sends it: its row names it by its title.
    const workspace = screenData(tree({ tasks: [source, asking], placements: [{ ...placement, id: "P1", taskId: "T1" }, placement],
      runs: [targetRun], balls: { T2: userBall("question", "Lwait", at, { questionId: "Lwait" }) },
      questions: [questionFixture({ id: "Lwait", taskId: "T2", decide: [decideItem("Proceed this way?")], title: "Please decide",
        summary: "Proceed this way?", askedAt: "2026-09-24T11:00:00Z" })] }));
    render(<TestWorkspace data={workspace}><MarkdownBody task={workspace.tasks[0]!} text="T2" onFollow={() => {}} /></TestWorkspace>);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "T2" }), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(600));
    const card = screen.getByRole("dialog", { name: "T2" });
    expect(card.textContent).toContain("Destination");
    expect(card.textContent).toContain(i18n.t(`ui:state.${workspace.tasks.find(task => task.id === "T2")!.state}`));
    expect(card.textContent).not.toContain("Please decide");
    expect(card.textContent).not.toContain("Latest report");
    expect(card.querySelector("[data-task-card-open]")).not.toBeNull();
  } finally { vi.useRealTimers(); }
});

test("a phone reference shows the task's card, and its Open follows it (the task comes up in a sheet)", () => {
  const narrow = narrowScreen(true);
  try {
    const workspace = data();
    const follow = vi.fn();
    render(<TestWorkspace data={workspace}><MarkdownBody task={workspace.tasks[0]!} text="T2" onFollow={follow} /></TestWorkspace>);
    fireEvent.click(screen.getByRole("button", { name: "T2" }));
    expect(follow).not.toHaveBeenCalled();
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("dialog", { name: "T2" }).querySelector<HTMLElement>("[data-task-card-open]")!);
    expect(follow).toHaveBeenCalledWith("T2");
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { narrow.restore(); }
});

/** The screen's URL owner, so a press is a history step and Back the browser's Back, as on the page. */
function Bootstrap() { useUrlBootstrap(useEveryTaskIndex()); return null; }
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
const param = (key: string) => new URL(location.href).searchParams.get(key);
const backButton = () => screen.queryByRole("button", { name: "Back" });
/** Back pressed: the browser goes back a step and the screen shows it. */
/** The browser's Back, as a phone's gesture or the browser's button gives it: what closes the viewer over the reader. */
const browserBack = () => act(async () => {
  const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
  history.back(); await done;
});
const pressBack = () => act(async () => {
  const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
  fireEvent.click(backButton()!); await done;
});
const content = () => document.querySelector<HTMLElement>("[data-reader-content]")!;
/** The reader read down to `top`, as a person's scroll is (the browser tells it). */
const readTo = (top: number) => { content().scrollTop = top; fireEvent.scroll(content()); };
const behind = (task: string) => ({ task: task, pane: "task", path: null });
/** A task whose report (L1) waits for the reader's review: its turn, as the server sends it. */
const awaitsReview = (id: string) => taskFixture({ id, state: "waiting", log: [logEntry({ kind: "reported", toState: "waiting" })],
  ball: userBall("review", "L1", at, { aboutRunId: "R1" }) });

test("the header's one Back appears when the reader has a place behind it, except when moving between turns", () => {
  const workspace = data();
  history.replaceState({ alpacaworkNavigation: 1, behind: behind("T1") }, "", "/?task=T2");
  act(() => useViewStore.getState().openTask("T2", { reader: true }));
  const view = render(<TestWorkspace data={workspace}><Reader mode="docked" /></TestWorkspace>);
  // It says only Back, wherever it goes, and stands in the head, not in what the reader shows.
  expect(backButton()?.textContent).toBe("Back");
  expect(document.querySelector("header [data-reader-back]")).toBeTruthy();
  expect(document.querySelector("[data-reader-content] [data-reader-back]")).toBeNull();
  view.unmount();

  const turns = screenData(tree({ tasks: [awaitsReview("T1"), awaitsReview("T2")] }));
  history.replaceState({ alpacaworkNavigation: 1, behind: behind("T1"), turnSequence: true }, "", "/?task=T2");
  render(<TestWorkspace data={turns}><Reader mode="docked" /></TestWorkspace>);
  expect(backButton()).toBeNull();
  cleanup();
  history.replaceState({ alpacaworkNavigation: 1, behind: behind("T1"), turnSequence: false }, "", "/?task=T2");
  render(<TestWorkspace data={turns}><Reader mode="docked" /></TestWorkspace>);
  expect(backButton()).toBeTruthy();
  cleanup();
  // Nothing behind it, on its reports: no Back.
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T2");
  render(<TestWorkspace data={turns}><Reader mode="docked" /></TestWorkspace>);
  expect(backButton()).toBeNull();
});

test("moving on to the next question after an answer adds no return control", () => {
  const first = dto({ id: "T1", state: "done", log: [logEntry({ toState: "done" })] });
  const workspace = screenData(tree({ tasks: [first, awaitsReview("T2")] }));
  history.replaceState({ alpacaworkNavigation: 1, behind: behind("T1"), turnSequence: true }, "", "/?task=T2");
  act(() => useViewStore.getState().openTask("T2", { reader: true, turnSequence: true }));
  render(<TestWorkspace data={workspace}><Reader mode="docked" /></TestWorkspace>);
  expect(document.querySelector("[data-reader-task-id]")?.textContent).toBe("T2");
  expect(document.querySelector("[data-reader-back]")).toBeNull();
});

test("Back comes back to where a reference was read: the source scroll, and the pressed reference marked", async () => {
  history.replaceState(null, "", "/?task=T1");
  const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={data()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  expect(backButton()).toBeNull();
  readTo(137);
  openReference(content().querySelector<HTMLElement>('[data-task-reference="T2"]')!); await flush();
  expect(param("task")).toBe("T2");
  readTo(11);
  await pressBack(); await flush();
  expect(param("task")).toBe("T1");
  expect(content().scrollTop).toBe(137);
  expect(marked(content().querySelector('[data-task-reference="T2"]'))).toBe(true);
  expect(frame).toHaveBeenCalled();
  // Back where it began, nothing is behind it.
  expect(backButton()).toBeNull();
});

test("Back reopens a repeat folded in its row before restoring its reference", async () => {
  history.replaceState(null, "", "/?task=T1");
  const old = logEntry({ id: "Lold", kind: "reported", at: "2026-09-24T09:10:00Z", title: "Latest report",
    description: "Continued in T2", actor: { kind: "placement", placementId: "P1" } });
  const latest = logEntry({ id: "Lnew", kind: "reported", at: "2026-09-24T09:20:00Z", title: "Latest report",
    description: "Continued in T2", actor: { kind: "placement", placementId: "P1" } });
  const workspace = screenData(tree({ tasks: [dto({ ...source, log: [old, latest] }), target],
    placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement],
    runs: [run("R1", { taskId: "T1", placementId: "P1", startedAt: "2026-09-24T09:00:00Z", endedAt: "2026-09-24T09:30:00Z" })],
    history: { ...histories, T1: [...comment("T1", "Lnew", latest.at, "Latest report", "Continued in T2"),
      ...comment("T1", "Lold", old.at, "Latest report", "Continued in T2")] } }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={workspace}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  fireEvent.click(screen.getByRole("button", { name: /Show 1 earlier/ }));
  readTo(89);
  openReference(document.querySelector<HTMLElement>('[data-folded-report] [data-task-reference="T2"]')!); await flush();
  expect(param("task")).toBe("T2");
  readTo(11);
  await pressBack(); await flush();
  // The step left names the folded report the reference was read in; coming back opens its card and fold again.
  expect(param("event")).toBe("log:T1:Lold");
  expect(screen.getByRole("button", { name: /Show 1 earlier/ }).getAttribute("aria-expanded")).toBe("true");
  expect(marked(document.querySelector('[data-folded-report] [data-task-reference="T2"]'))).toBe(true);
  expect(content().scrollTop).toBe(89);
});

test("Back reopens the row a reference was read in, even when another row above holds the same reference", async () => {
  history.replaceState(null, "", "/?task=T1");
  const old = logEntry({ id: "Lold", kind: "reported", at: "2026-09-24T09:10:00Z", title: "Intermediate report", description: "Also here T2",
    actor: { kind: "placement", placementId: "P1" } });
  const latest = logEntry({ id: "Lnew", kind: "reported", at: "2026-09-24T09:20:00Z", title: "Leading report", description: "Checked",
    actor: { kind: "placement", placementId: "P1" } });
  const instruction = logEntry({ id: "Lanswer", kind: "reported", at: "2026-09-24T09:05:00Z", title: "Answer", description: "In the answer: T2",
    actor: { kind: "human" } });
  const workspace = screenData(tree({ tasks: [dto({ ...source, log: [instruction, old, latest] }), target],
    placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement],
    runs: [run("R1", { taskId: "T1", placementId: "P1", startedAt: "2026-09-24T09:00:00Z", endedAt: "2026-09-24T09:30:00Z" })],
    history: { ...histories, T1: [...comment("T1", "Lnew", latest.at, "Leading report", "Checked"),
      ...comment("T1", "Lold", old.at, "Intermediate report", "Also here T2"),
      ...historyFixture([{ id: "Lanswer", kind: "comment", at: instruction.at, by: "human", title: "Answer", summary: "In the answer: T2" }])] } }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={workspace}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  const row = () => document.querySelector<HTMLElement>('[data-report-key="log:T1:Lanswer"]')!;
  const first = document.querySelector<HTMLElement>('[data-report-key="log:T1:Lnew"]')!;
  expect(first.querySelector('button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  const item = document.querySelector<HTMLElement>('[data-report-key="log:T1:Lold"]')!;
  fireEvent.click(item.querySelector<HTMLElement>('button[aria-expanded]')!);
  expect(item.querySelector('[data-task-reference="T2"]')).toBeTruthy();
  fireEvent.click(row().querySelector<HTMLElement>('button[aria-expanded]')!);
  readTo(89);
  openReference(row().querySelector<HTMLElement>('[data-task-reference="T2"]')!); await flush();
  expect(param("task")).toBe("T2");
  readTo(11);
  await pressBack(); await flush();
  expect(param("event")).toBe("log:T1:Lanswer");
  // The URL names one row: the one the reference was in. The newest card opens as it always does.
  expect(document.querySelector('[data-report-key="log:T1:Lnew"] button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  expect(row().querySelector('button[aria-expanded]')?.getAttribute("aria-expanded")).toBe("true");
  expect(marked(row().querySelector('[data-task-reference="T2"]'))).toBe(true);
  expect(content().scrollTop).toBe(89);
});

/** T1's newest report with a body, an older one holding a reference to T2, and T2 as T1's child reporting to it. */
function readRows() {
  const latest = logEntry({ id: "Lnew", kind: "reported", at: "2026-09-24T09:20:00Z", title: "Leading report", description: "Checked",
    actor: { kind: "placement", placementId: "P1" } });
  const old = logEntry({ id: "Lold", kind: "reported", at: "2026-09-24T09:10:00Z", title: "Intermediate report", description: "Also here T2",
    actor: { kind: "placement", placementId: "P1" } });
  return screenData(tree({ tasks: [dto({ ...source, log: [old, latest] }), dto({ ...target, parentId: "T1" })],
    placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement],
    runs: [run("R1", { taskId: "T1", placementId: "P1", startedAt: "2026-09-24T09:00:00Z", endedAt: "2026-09-24T09:30:00Z" })],
    history: { ...histories, T1: [...comment("T1", "Lnew", latest.at, "Leading report", "Checked"),
      ...historyFixture([{ id: "Lkid", kind: "comment", taskId: "T2", fromChild: true, at: "2026-09-24T09:15:00Z", title: "Child note",
        summary: "From the child", author: { kind: "owner", profileKey: "codex" } }]),
      ...comment("T1", "Lold", old.at, "Intermediate report", "Also here T2")] } }));
}
const press = (key: string) => fireEvent.click(document.querySelector<HTMLElement>(`[data-report-key="${key}"] button[aria-expanded]`)!);
const opened = (key: string) => document.querySelector(`[data-report-key="${key}"] button[aria-expanded]`)?.getAttribute("aria-expanded");

test("Back lays the rows out as they were left: the newest report closed by hand stays closed", async () => {
  history.replaceState(null, "", "/?task=T1");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={readRows()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  expect(opened("log:T1:Lnew")).toBe("true");
  press("log:T1:Lnew");
  press("log:T1:Lold");
  readTo(89);
  openReference(document.querySelector<HTMLElement>('[data-report-key="log:T1:Lold"] [data-task-reference="T2"]')!); await flush();
  expect(param("task")).toBe("T2");
  await pressBack(); await flush();
  expect(param("event")).toBe("log:T1:Lold");
  expect([opened("log:T1:Lnew"), opened("log:T1:Lold")]).toEqual(["false", "true"]);
  expect(content().scrollTop).toBe(89);
});

test("a reload lays the rows out as the step kept them with where it was read: the newest closed by hand stays closed", async () => {
  history.replaceState(null, "", "/?task=T1");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={readRows()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  press("log:T1:Lnew");
  press("log:T1:Lold");
  readTo(89);
  // Read and left still: the step keeps where, and which rows stood open.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 260)); });
  expect(history.state.readerPosition).toMatchObject({ task: "T1", scroll: 89, rows: { "log:T1:Lnew": false, "log:T1:Lold": true } });
  cleanup(); queryClient.clear(); useViewStore.setState(useViewStore.getInitialState());
  render(<TestWorkspace data={readRows()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  expect([opened("log:T1:Lnew"), opened("log:T1:Lold")]).toEqual(["false", "true"]);
  expect(content().scrollTop).toBe(89);
});

test("a Task's tag at the top of an open row is followed as a reference: Back reopens the row it was read in and marks it", async () => {
  history.replaceState(null, "", "/?task=T1");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={readRows()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  press("log:T2:Lkid");
  press("log:T1:Lold");
  expect(param("event")).toBe("log:T1:Lold");
  readTo(89);
  const tag = () => document.querySelector<HTMLElement>('[data-report-key="log:T2:Lkid"] [data-row-parties] [data-task-reference="T2"]')!;
  expect(tag().getAttribute("aria-label")).toBe("Open “T2 Destination”");
  fireEvent.click(tag()); await flush();
  expect(param("task")).toBe("T2");
  await pressBack(); await flush();
  expect(param("event")).toBe("log:T2:Lkid");
  expect([opened("log:T2:Lkid"), opened("log:T1:Lold")]).toEqual(["true", "true"]);
  expect(marked(tag())).toBe(true);
  expect(content().scrollTop).toBe(89);
});

const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
/** A report linking a path of its Task's folder (`href`): a folder, which the Files tab opens in the reader's place, by default. */
const withFiles = (href = "docs/") => screenData(tree({ tasks: [dto({ ...source, log: [logEntry({ id: "L1", kind: "reported", title: "Report with links",
  description: `Steps are [Instructions](${href})  here`, actor: { kind: "placement", placementId: "P1" } })],
  files: [file("docs/steps.md"), file("notes.md")] }), target], placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement],
  history: { ...histories, T1: comment("T1", "L1", at, "Report with links", `Steps are [Instructions](${href})  here`) } }));

test("a report's file link opens the file in the viewer over the report as a step; Back closes it where the report was read", async () => {
  history.replaceState(null, "", "/?task=T1");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={withFiles("docs/steps.md")}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  readTo(240);
  fireEvent.click(screen.getByRole("link", { name: "Instructions" })); await flush();
  expect([param("tab"), param("path"), param("view")]).toEqual([null, null, "T1/docs/steps.md"]);
  await browserBack(); await flush();
  expect([param("tab"), param("view")]).toEqual([null, null]);
  expect(content().scrollTop).toBe(240);
  expect(backButton()).toBeNull();
});

test("a file opened straight from its URL: Back goes to the reports over its step, so no Back leads back to the file", async () => {
  history.replaceState(null, "", "/?task=T1&tab=files&path=docs%2Fsteps.md");
  render(<TestWorkspace data={withFiles()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  const length = history.length;
  fireEvent.click(backButton()!); await flush();
  expect([param("task"), param("tab"), param("path")]).toEqual(["T1", null, null]);
  expect(history.length).toBe(length);
  expect(backButton()).toBeNull();
});

test("Context and the files stand as entries under the title, each a step Back comes back from", async () => {
  history.replaceState(null, "", "/?task=T1");
  render(<TestWorkspace data={withFiles()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  // The head keeps neither: no tab for Context or the files.
  expect(document.querySelector("header")?.textContent).not.toMatch(/Context|file/i);
  fireEvent.click(document.querySelector<HTMLElement>('[data-reader-entry="about"]')!); await flush();
  expect(param("tab")).toBe("about");
  expect(document.querySelector("[data-task-about]")).not.toBeNull();
  await pressBack(); await flush();
  expect(param("tab")).toBeNull();
  fireEvent.click(document.querySelector<HTMLElement>('[data-reader-entry="files"]')!); await flush();
  expect(param("tab")).toBe("files");
  fireEvent.click(screen.getByRole("button", { name: /notes\.md/ })); await flush();
  expect(param("view")).toBe("T1/notes.md");
  await browserBack(); await flush();
  expect([param("tab"), param("path"), param("view")]).toEqual(["files", null, null]);
  await pressBack(); await flush();
  expect(param("tab")).toBeNull();
  expect(backButton()).toBeNull();
});

test("a link to another state of the screen pressed in the reader is a step its Back comes back from", async () => {
  history.replaceState(null, "", "/?task=T1");
  render(<TestWorkspace data={data()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  act(() => openScreenLink("/?task=T2&tab=about")); await flush();
  expect([param("task"), param("tab")]).toEqual(["T2", "about"]);
  expect(history.state.behind).toMatchObject({ task: "T1", pane: "task" });
  await pressBack(); await flush();
  expect([param("task"), param("tab")]).toEqual(["T1", null]);
});

test("Back and Forward land where each place was last read, not where it was first left", async () => {
  history.replaceState(null, "", "/?task=T1");
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  render(<TestWorkspace data={withFiles()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  readTo(240);
  fireEvent.click(screen.getByRole("link", { name: "Instructions" })); await flush();
  readTo(300);
  await pressBack(); await flush();
  expect(content().scrollTop).toBe(240);
  // Read on, and stop: the step keeps the new place.
  readTo(50);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
  await act(async () => { const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true })); history.forward(); await done; }); await flush();
  expect(param("path")).toBe("docs/");
  expect(content().scrollTop).toBe(300);
  await act(async () => { const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true })); history.back(); await done; }); await flush();
  expect(param("path")).toBeNull();
  expect(content().scrollTop).toBe(50);
});

test("a reference to the task itself moves nothing and leaves nothing for the next step to keep", async () => {
  history.replaceState(null, "", "/?task=T1");
  const self = screenData(tree({ tasks: [dto({ ...source, log: [logEntry({ id: "L1", kind: "reported", title: "Report with links",
    description: "This is T1 itself.Steps are [Instructions](docs/steps.md)", actor: { kind: "placement", placementId: "P1" } })],
    files: [file("docs/steps.md")] }), target], placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement],
    history: { ...histories, T1: comment("T1", "L1", at, "Report with links", "This is T1 itself.Steps are [Instructions](docs/steps.md)") } }));
  render(<TestWorkspace data={self}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  const length = history.length;
  openReference(content().querySelector<HTMLElement>('[data-task-reference="T1"]')!); await flush();
  expect(history.length).toBe(length);
  fireEvent.click(screen.getByRole("link", { name: "Instructions" })); await flush();
  await browserBack(); await flush();
  expect(history.state.readerPosition?.referenceId).toBeUndefined();
});

test("coming back, the reader is placed again as what it shows grows, past any short wait, until the person moves it", async () => {
  // The browser's scroll stops at what there is to scroll: here nothing, until more comes.
  let room = 0;
  const tops = new WeakMap<Element, number>();
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true,
    get(this: Element) { return this.hasAttribute("data-reader-content") ? tops.get(this) ?? 0 : native.get!.call(this); },
    set(this: Element, value: number) { if (this.hasAttribute("data-reader-content")) tops.set(this, Math.min(value, room)); else native.set!.call(this, value); } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  const grow = async () => { await act(async () => { content().append(document.createElement("div")); await Promise.resolve(); }); };
  try {
    history.replaceState({ alpacaworkNavigation: 1, readerPosition: { task: "T1", pane: "task", path: null, scroll: 500 } }, "", "/?task=T1");
    act(() => useViewStore.getState().openTask("T1", { reader: true }));
    render(<TestWorkspace data={data()}><Reader mode="docked" /></TestWorkspace>);
    expect(content().scrollTop).toBe(0);
    act(() => { vi.advanceTimersByTime(5000); });
    // The text comes late: the reader stands where it was read.
    room = 2000;
    await grow();
    expect(content().scrollTop).toBe(500);
    // Placed, it is done: what comes later leaves where the person reads.
    content().scrollTop = 120;
    await grow();
    expect(content().scrollTop).toBe(120);
  } finally {
    vi.useRealTimers();
    Object.defineProperty(Element.prototype, "scrollTop", native);
  }
});

test("coming back, the person's own move ends the placing: what comes later leaves the reader where they put it", async () => {
  let room = 0;
  const tops = new WeakMap<Element, number>();
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true,
    get(this: Element) { return this.hasAttribute("data-reader-content") ? tops.get(this) ?? 0 : native.get!.call(this); },
    set(this: Element, value: number) { if (this.hasAttribute("data-reader-content")) tops.set(this, Math.min(value, room)); else native.set!.call(this, value); } });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
  const grow = async () => { await act(async () => { content().append(document.createElement("div")); await Promise.resolve(); }); };
  try {
    history.replaceState({ alpacaworkNavigation: 1, readerPosition: { task: "T1", pane: "task", path: null, scroll: 500 } }, "", "/?task=T1");
    act(() => useViewStore.getState().openTask("T1", { reader: true }));
    render(<TestWorkspace data={data()}><Reader mode="docked" /></TestWorkspace>);
    room = 100;
    await grow();
    expect(content().scrollTop).toBe(100);
    // A vertical wheel move takes over from restoration; a zero-delta activation does not.
    fireEvent.wheel(content(), { deltaY: -60 });
    content().scrollTop = 40;
    room = 2000;
    await grow();
    expect(content().scrollTop).toBe(40);
  } finally {
    Object.defineProperty(Element.prototype, "scrollTop", native);
  }
});

/** The browser's scroll stops at what there is to scroll (`room`), as a reader whose text has not come yet. */
function clampReaderScroll() {
  const state = { room: 100_000 };
  const tops = new WeakMap<Element, number>();
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
  Object.defineProperty(Element.prototype, "scrollTop", { configurable: true,
    get(this: Element) { return this.hasAttribute("data-reader-content") ? tops.get(this) ?? 0 : native.get!.call(this); },
    set(this: Element, value: number) { if (this.hasAttribute("data-reader-content")) tops.set(this, Math.min(value, state.room)); else native.set!.call(this, value); } });
  return { state, restore: () => Object.defineProperty(Element.prototype, "scrollTop", native) };
}

test("coming back while the text is still coming, the scrolls the reader makes itself do not overwrite where it was read", async () => {
  const clamp = clampReaderScroll();
  try {
    history.replaceState(null, "", "/?task=T1");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
    render(<TestWorkspace data={withFiles()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
    readTo(500);
    fireEvent.click(screen.getByRole("link", { name: "Instructions" })); await flush();
    readTo(300);
    // Back on the reports before their text is there: nothing to scroll yet.
    clamp.state.room = 0;
    await pressBack(); await flush();
    expect(content().scrollTop).toBe(0);
    // The reader's own scroll (to the top, on the way back) is no reading: past the keeping's wait, the step still says 500.
    fireEvent.scroll(content());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(history.state.readerPosition).toMatchObject({ pane: "task", scroll: 500 });
    clamp.state.room = 100_000;
    await act(async () => { content().append(document.createElement("div")); await Promise.resolve(); });
    expect(content().scrollTop).toBe(500);
  } finally { clamp.restore(); }
});

test("a link to another state of the screen brings its own settings, and opens its place afresh: no walk carried over", async () => {
  history.replaceState({ alpacaworkNavigation: 1, turnSequence: true }, "", "/?task=T1&strip=off");
  render(<TestWorkspace data={data()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  act(() => openScreenLink("/?q=T11&strip=on&zoom=3600000")); await flush();
  expect([param("q"), param("strip"), param("zoom")]).toEqual(["T11", "on", "3600000"]);
  expect(useTimeView.getState().strips).toBe(true);
  await act(async () => { const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true })); history.back(); await done; }); await flush();
  expect(param("task")).toBe("T1");
  act(() => openScreenLink("/?task=T2")); await flush();
  expect(param("task")).toBe("T2");
  expect(history.state.turnSequence).toBe(false);
  expect(backButton()).toBeTruthy();
});

test("a place noted on one browser entry is not kept on another the browser goes to first, though both show it", async () => {
  history.replaceState(null, "", "/?task=T1");
  render(<TestWorkspace data={withFiles()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  const place = { task: "T1", pane: "task", path: null };
  // Entry A keeps 240; entry B, the same place with another row open, is read at 800.
  history.replaceState({ ...history.state, readerPosition: { ...place, scroll: 240 } }, "", location.href);
  history.pushState({ ...history.state, readerPosition: { ...place, scroll: 800 } }, "", "/?task=T1&event=request%3AQ1");
  // A row opened on B notes where the reader stands; the browser's Back comes before it is kept.
  noteReaderScroll("T1", "task", null, 800);
  await act(async () => {
    const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
    history.back(); await done;
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(history.state.readerPosition.scroll).toBe(240);
  // On the step it was noted on, the same note is kept.
  noteReaderScroll("T1", "task", null, 320);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(history.state.readerPosition.scroll).toBe(320);
});

test("in Context, a reference to the task itself opens its reports as a step, and a file opened there closes Back to Context", async () => {
  history.replaceState(null, "", "/?task=T1&tab=about");
  const self = screenData(tree({ tasks: [dto({ ...source, values: { goal: "This checks T1 itself", notes: "Steps are [Instructions](docs/steps.md)" },
    files: [file("docs/steps.md")] }), target],
    placements: [{ ...placement, id: "P1", taskId: "T1", agentId: "A1" }, placement], history: histories }));
  render(<TestWorkspace data={self}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
  expect(document.querySelector("[data-task-about]")).not.toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Instructions" })); await flush();
  expect([param("tab"), param("view")]).toEqual(["about", "T1/docs/steps.md"]);
  await browserBack(); await flush();
  expect([param("tab"), param("view")]).toEqual(["about", null]);
  expect(document.querySelector("[data-task-about]")).not.toBeNull();
  // The task named in its own Context is the task's own place, its reports; Back comes back to Context.
  openReference(content().querySelector<HTMLElement>('[data-task-about] [data-task-reference="T1"]')!); await flush();
  expect(param("tab")).toBeNull();
  await pressBack(); await flush();
  expect(param("tab")).toBe("about");
});

test("left again while still being put back, a place keeps where it was read and the reference followed from it", async () => {
  const clamp = clampReaderScroll();
  try {
    history.replaceState(null, "", "/?task=T1");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
    render(<TestWorkspace data={withFiles()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
    readTo(500);
    fireEvent.click(screen.getByRole("link", { name: "Instructions" })); await flush();
    clamp.state.room = 0;
    await pressBack(); await flush();
    expect(content().scrollTop).toBe(0);
    // Another task opened from the list before the reports' text came, then Back.
    act(() => useViewStore.getState().openTask("T2", { reader: true })); await flush();
    expect(param("task")).toBe("T2");
    await act(async () => { const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true })); history.back(); await done; }); await flush();
    expect(history.state.readerPosition).toMatchObject({ task: "T1", pane: "task", scroll: 500 });
    clamp.state.room = 100_000;
    await act(async () => { content().append(document.createElement("div")); await Promise.resolve(); });
    expect(content().scrollTop).toBe(500);
  } finally { clamp.restore(); }
});

test("a followed reference found on the way back does not end the putting back: it ends where the reader was read", async () => {
  const clamp = clampReaderScroll();
  try {
    history.replaceState(null, "", "/?task=T1");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
    render(<TestWorkspace data={data()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
    readTo(137);
    openReference(content().querySelector<HTMLElement>('[data-task-reference="T2"]')!); await flush();
    // Back while the pictures above it have not come: the reference is drawn, but the reader cannot reach where it was read.
    clamp.state.room = 50;
    await pressBack(); await flush();
    expect(content().scrollTop).toBe(50);
    expect(marked(content().querySelector('[data-task-reference="T2"]'))).toBe(true);
    // Its own scroll on the way is no reading, past the keeping's wait.
    fireEvent.scroll(content());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(history.state.readerPosition).toMatchObject({ scroll: 137 });
    clamp.state.room = 100_000;
    await act(async () => { content().append(document.createElement("div")); await Promise.resolve(); });
    expect(content().scrollTop).toBe(137);
  } finally { clamp.restore(); }
});

test("left again while still being put back after a reference, the place keeps the reference too: coming back marks it", async () => {
  const clamp = clampReaderScroll();
  try {
    history.replaceState(null, "", "/?task=T1");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
    render(<TestWorkspace data={data()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
    readTo(137);
    openReference(content().querySelector<HTMLElement>('[data-task-reference="T2"]')!); await flush();
    clamp.state.room = 50;
    await pressBack(); await flush();
    act(() => useViewStore.getState().openTask("T2", { reader: true })); await flush();
    await act(async () => { const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true })); history.back(); await done; }); await flush();
    expect(history.state.readerPosition).toMatchObject({ task: "T1", scroll: 137, referenceId: "T2", occurrence: 0 });
  } finally { clamp.restore(); }
});

test("Retry after the person took over chooses the whole place again, the followed reference included", async () => {
  const clamp = clampReaderScroll();
  try {
    history.replaceState(null, "", "/?task=T1");
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(0); return 1; });
    render(<TestWorkspace data={data()}><Bootstrap /><Reader mode="docked" /></TestWorkspace>); await flush();
    readTo(137);
    openReference(content().querySelector<HTMLElement>('[data-task-reference="T2"]')!); await flush();
    // A real failed acquisition is still unfinished when Back returns. The History's
    // existing production ReadFailure supplies Retry through the Reader's context.
    const { readQuery, readIndex } = await import('../src/data/read-model');
    act(() => {
      const index = readIndex(queryClient)!;
      readQuery(queryClient, ['task', index.root, 'T1'])!.setState({ status: 'error', error: new Error('temporary read failure') });
      readQuery(queryClient, ['task-history', index.root, 'T1'])!.setState({ status: 'error', error: new Error('temporary History failure') });
      queryClient.setQueryData(['index'], { ...index, tasks: index.tasks.map(row => row.id === 'T1' ? { ...row, hash: 'b'.repeat(64) } : row) });
    });
    clamp.state.room = 50;
    await pressBack(); await flush();
    // The person moves while the place is still being put back: what they read replaces it, without the reference.
    fireEvent.wheel(content(), { deltaY: -40 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(history.state.readerPosition).toMatchObject({ task: "T1", scroll: 50 });
    expect(history.state.readerPosition.referenceId).toBeUndefined();
    // Any read failure's Retry in this reader is the same unfinished request's explicit new attempt.
    const retry = document.querySelector<HTMLButtonElement>('[data-reading-column] [data-read-failure] button');
    expect(retry).not.toBeNull();
    fireEvent.click(retry!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 260)); });
    expect(history.state.readerPosition).toMatchObject({ task: "T1", scroll: 137, referenceId: "T2", occurrence: 0 });
  } finally { clamp.restore(); }
});

test.each(['settled', 'taken'] as const)('phone header ignores intermediate placing and reads from its %s baseline', async outcome => {
  const narrow = narrowScreen(true), clamp = clampReaderScroll();
  clamp.state.room = 100;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(0); return 1; });
  try {
    history.replaceState({ alpacaworkNavigation: 1, readerPosition: { task: 'T1', pane: 'task', path: null, scroll: 500 } }, '', '/?task=T1');
    act(() => useViewStore.getState().openTask('T1', { reader: true }));
    render(<TestWorkspace data={data()}><Reader mode="sheet" /></TestWorkspace>);
    // History rows are drawn in a render after the head (a feed mounted afresh); the place is put back once they land.
    await act(async () => { await Promise.resolve(); });
    const area = content(), layer = () => document.querySelector<HTMLElement>('[data-reader-header]')!;
    Object.defineProperties(area, { scrollHeight: { configurable: true, value: 3000 }, clientHeight: { configurable: true, value: 800 } });
    expect(area.scrollTop).toBe(100);
    fireEvent.scroll(area); expect(layer().dataset.readerHeader).toBe('shown');
    clamp.state.room = 300;
    await act(async () => { area.append(document.createElement('div')); await Promise.resolve(); });
    expect(area.scrollTop).toBe(300);
    fireEvent.scroll(area); expect(layer().dataset.readerHeader).toBe('shown');
    if (outcome === 'settled') {
      clamp.state.room = 2000;
      await act(async () => { area.append(document.createElement('div')); await Promise.resolve(); });
      expect(area.scrollTop).toBe(500);
      fireEvent.scroll(area); expect(layer().dataset.readerHeader).toBe('shown');
    } else {
      // The person chooses this vertical position before the remaining text arrives.
      fireEvent.wheel(area, { deltaY: 60 });
      clamp.state.room = 2000;
      await act(async () => { area.append(document.createElement('div')); await Promise.resolve(); });
      expect(area.scrollTop).toBe(300);
    }
    const baseline = area.scrollTop;
    area.scrollTop = baseline + 17; fireEvent.scroll(area);
    expect(layer().dataset.readerHeader).toBe('hidden');
    // Once taken over, subsequent input must not keep resetting the header while the person reads.
    fireEvent.wheel(area, { deltaY: 60 }); expect(layer().dataset.readerHeader).toBe('hidden');
    area.scrollTop = baseline; fireEvent.scroll(area);
    expect(layer().dataset.readerHeader).toBe('shown');
  } finally { clamp.restore(); narrow.restore(); }
});
