import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { queryClient } from "../src/data/query-client";
import { indexKey, resources } from "../src/data/resources";
import { AppBar } from "../src/features/chrome/AppBar";
import { NarrowSearchRow } from "../src/features/chrome/SearchField";
import { useGlobalShortcuts } from "../src/features/chrome/use-shortcuts";
import { SearchResults } from "../src/features/chrome/SearchResults";
import { useDocumentTitle } from "../src/features/chrome/use-document-title";
import { useViewStore } from "../src/state/view-store";
import { TimeTree } from "../src/features/tree/TimeTree";
import { useInputMode } from "../src/state/input-mode";
import { useDialogStore } from "../src/state/dialog-store";
import { useReadStore } from "../src/state/read-store";
import { TestWorkspace, at, dto, indexOf, logEntry, screenData, seedSearch, taskFixture, tree, userBall } from "./fixtures";

beforeAll(() => startI18n());
beforeEach(() => { localStorage.clear(); history.replaceState(null, "", "/"); useViewStore.setState(useViewStore.getInitialState()); });
afterEach(() => { cleanup(); queryClient.clear(); });

/** A task waiting for the reader's review of its report (L1), with the turn the server sends. */
const waiting = (id: string) => taskFixture({ id, state: "waiting", log: [logEntry({ kind: "reported", toState: "waiting" })],
  ball: userBall("review", "L1", at, { aboutRunId: "R1" }) });
function Title() { useDocumentTitle(); return null; }

test("Mark all read on search results marks only the tasks it shows read", async () => {
  const value = tree({ tasks: [dto({ id: "T1", state: "done" }), waiting("T2"), dto({ id: "T3", state: "doing" })] });
  const data = screenData(value);
  data.readIds = new Set();
  queryClient.setQueryData(indexKey, indexOf(value));
  const confirm = vi.fn(async () => true);
  useReadStore.setState({ confirm });
  seedSearch(value.root, "x", ["T2"]);
  useViewStore.setState({ query: "x" });
  render(<TestWorkspace data={data}><SearchResults /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("chrome:gathered.markAllRead") }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect((confirm.mock.calls[0] as unknown as [{ id: string }[]])[0].map((task) => task.id)).toEqual(["T2"]);
});

test("a failed search refresh retains its rows and offers a retry", async () => {
  const value = tree({ tasks: [dto({ id: "T1" })] });
  seedSearch(value.root, "x", ["T1"]);
  useViewStore.setState({ query: "x" });
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  render(<TestWorkspace data={screenData(value)}><SearchResults /></TestWorkspace>);
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: resources.taskSearch(value.root, "x", null).queryKey });
  });
  // Said once, where the results are, as every read that failed (ReadFailure).
  await waitFor(() => expect(screen.getByRole("button", { name: i18n.t("retry") })).toBeTruthy());
  expect(document.querySelectorAll("[data-result]")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain(i18n.t("chrome:search.failedFirst"));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("retry") }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  fetcher.mockRestore();
});

test("a result opens its detail while its condition and neighboring rows stay", () => {
  const value = tree({ tasks: [waiting("T1"), waiting("T2")] });
  seedSearch(value.root, "x", ["T1", "T2"]);
  useViewStore.setState({ query: "x" });
  render(<TestWorkspace data={screenData(value)}><SearchResults /></TestWorkspace>);
  const first = document.querySelector<HTMLElement>(`[data-result="T1"]`)!;
  fireEvent.click(first);
  expect(useViewStore.getState()).toMatchObject({ query: "x", selected: "T1", reader: { open: true } });
  expect(document.querySelectorAll("[data-result]")).toHaveLength(2);
  expect(first.getAttribute("aria-current")).toBe("true");
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(useViewStore.getState().selected).toBe("T2");
});

test.each([false, true])("result arrows follow adjacent rows and leave boundaries alone (reader open=%s)", (readerOpen) => {
  const value = tree({ tasks: [waiting("T1"), waiting("T2"), waiting("T3")] });
  seedSearch(value.root, "x", ["T3", "T1", "T2"]);
  useViewStore.setState({ query: "x" });
  render(<TestWorkspace data={screenData(value)}><SearchResults /></TestWorkspace>);
  const rows = [...document.querySelectorAll<HTMLElement>("[data-result]")];
  expect(rows.map(row => row.dataset.result)).toEqual(["T3", "T1", "T2"]);
  if (readerOpen) fireEvent.click(rows[0]!);
  rows[0]!.focus();
  expect(fireEvent.keyDown(rows[0]!, { key: "ArrowUp" })).toBe(true);
  expect(document.activeElement).toBe(rows[0]);
  // A key from a title inside the button still belongs to that result.
  expect(fireEvent.keyDown(rows[0]!.querySelector("strong")!, { key: "ArrowDown" })).toBe(false);
  expect(document.activeElement).toBe(rows[1]);
  expect(useViewStore.getState().selected).toBe(readerOpen ? "T1" : null);
  fireEvent.keyDown(rows[1]!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows[2]);
  expect(fireEvent.keyDown(rows[2]!, { key: "ArrowDown" })).toBe(true);
  expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2]!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(rows[1]);
  expect(useViewStore.getState().selected).toBe(readerOpen ? "T1" : null);
  expect(fireEvent.keyDown(rows[1]!, { key: "ArrowLeft" })).toBe(true);
  expect(document.activeElement).toBe(rows[1]);
});

function Shortcuts() { useGlobalShortcuts(); return null; }

test("the compact bar's button and ⌘K open the search row and focus its visible field", () => {
  const data = screenData(tree());
  const visible = vi.spyOn(HTMLElement.prototype, "getClientRects");
  let compact = true;
  visible.mockImplementation(function (this: HTMLElement) {
    return (compact ? !!this.closest("[data-search-row]") : !!this.closest("header"))
      ? [{}] as unknown as DOMRectList : [] as unknown as DOMRectList;
  });
  try {
    render(<TestWorkspace data={data}><Shortcuts /><AppBar /><main><NarrowSearchRow /></main></TestWorkspace>);
    expect(document.querySelector("[data-search-row]")).toBeNull();
    fireEvent.click(document.querySelector<HTMLElement>("[data-search-toggle]")!);
    const row = document.querySelector<HTMLElement>("[data-search-row]")!;
    expect(document.activeElement).toBe(row.querySelector("input"));
    fireEvent.click(document.querySelector<HTMLElement>("[data-search-toggle]")!);
    expect(row.isConnected).toBe(false);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(document.querySelector("[data-search-row] input"));
    compact = false;
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(document.querySelector("header input"));
  } finally { visible.mockRestore(); }
});

test("⌘, and Ctrl+, open the settings from an input, keep them as they are, and replace another dialog", async () => {
  vi.useFakeTimers();
  try {
    useDialogStore.setState(useDialogStore.getInitialState());
    render(<><Shortcuts /><input data-testid="field" /></>);
    const field = screen.getByTestId("field");
    field.focus();
    for (const press of [{ metaKey: true }, { ctrlKey: true }]) {
      useDialogStore.setState({ dialog: null, settingsTab: "server" });
      expect(fireEvent.keyDown(field, { key: ",", ...press })).toBe(false);
      expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "server" });
    }
    // Already open on a tab of its own, the press leaves it there.
    useDialogStore.setState({ dialog: { kind: "settings", tab: "projects", request: 3 } });
    fireEvent.keyDown(document, { key: ",", metaKey: true });
    expect(useDialogStore.getState().dialog).toEqual({ kind: "settings", tab: "projects", request: 3 });
    // Another dialog closes first, then the settings open.
    useDialogStore.setState({ dialog: { kind: "diagnostics" } });
    fireEvent.keyDown(document, { key: ",", ctrlKey: true });
    expect(useDialogStore.getState().dialog).toBeNull();
    await act(async () => { await vi.runAllTimersAsync(); });
    expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "server" });
    // A comma alone, with Shift or Option, or while an IME is composing, is left to the page.
    for (const press of [{}, { metaKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { metaKey: true, isComposing: true }]) {
      useDialogStore.setState({ dialog: null });
      expect(fireEvent.keyDown(field, { key: ",", ...press })).toBe(true);
      expect(useDialogStore.getState().dialog).toBeNull();
    }
  } finally { vi.useRealTimers(); }
});

// The header no longer reads config.yaml (`config/get`) for its name: it is the project's name from the index's
// project rows, and the tab title keeps that name alongside the product.
test("the bar and tab use the project's name from the index", async () => {
  const data = screenData(tree());
  const named = (name: string) => ({ ...data, info: { ...data.info, projects: data.info.projects.map((project) => ({ ...project, title: name })) } });
  const view = render(<TestWorkspace data={data}><Title /><AppBar /></TestWorkspace>);
  expect(screen.getByRole("heading", { name: "default" })).toBeTruthy();
  expect(screen.getAllByText("default")).toHaveLength(1);
  await waitFor(() => expect(document.title).toBe("default · alpacawork"));
  view.rerender(<TestWorkspace data={named("منصة البيانات")}><Title /><AppBar /></TestWorkspace>);
  await waitFor(() => expect(screen.getByText("منصة البيانات").getAttribute("dir")).toBe("auto"));
  expect(screen.getByRole("heading", { name: "منصة البيانات" })).toBeTruthy();
  expect(screen.queryByText("default")).toBeNull();
  expect(document.title).toBe("منصة البيانات · alpacawork");
  const long = "A very long project name for another server";
  view.rerender(<TestWorkspace data={named(long)}><Title /><AppBar /></TestWorkspace>);
  await waitFor(() => expect(screen.getByRole("heading", { name: long })).toBeTruthy());
  expect(document.title).toContain(long);
  expect(screen.getByRole("heading", { name: long }).getAttribute("title")).toBe(long);
});


// Test visibility is supplied as the container query's input; the real 707/708px boundary and rectangles are not
// checked in a browser, and appbar.check.ts keeps only native focus of an existing query.
// The stubbed activeElement checks below cover component state only, never native focus availability.
function SearchContract() {
  useGlobalShortcuts(); useInputMode();
  const query = useViewStore(state => state.query);
  return <><AppBar /><NarrowSearchRow />{query ? <SearchResults /> : <TimeTree />}</>;
}
function mountSearch(compact: boolean, query = '') {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  useViewStore.setState({ query, navigationReady: true }); useDialogStore.setState({ dialog: null });
  const value = tree({ tasks: [dto({ id: 'T1', title: 'Invoice' })] });
  seedSearch(value.root, 'Invoice', ['T1']);
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function(this: HTMLElement) {
    const visible = this.matches('[data-search-toggle]') || (compact ? !!this.closest('[data-search-row]') : !!this.closest('header'));
    return visible ? [{}] as unknown as DOMRectList : [] as unknown as DOMRectList;
  });
  return render(<TestWorkspace data={screenData(value)}><SearchContract /></TestWorkspace>);
}
const visibleSearch = (compact: boolean) => document.querySelector<HTMLInputElement>(compact ? '[data-search-row] input' : 'header input')!;

test('compact search closes with Escape or its button after entering a query', async () => {
  mountSearch(true);
  expect(document.querySelector('[data-time-tree]')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  fireEvent.change(visibleSearch(true), { target: { value: 'Invoice' } });
  await waitFor(() => expect(document.querySelector('[data-result-list]')).toBeTruthy());
  fireEvent.keyDown(visibleSearch(true), { key: 'Escape' });
  await waitFor(() => expect(document.querySelector('[data-search-row]')).toBeNull());
  const toggle = document.querySelector<HTMLElement>('[data-search-toggle]')!;
  await waitFor(() => expect(document.activeElement).toBe(toggle));
  expect(document.documentElement.dataset.input).toBe('keyboard');
  expect(document.querySelector('[data-result-list]')).toBeNull();
  fireEvent.click(toggle); fireEvent.change(visibleSearch(true), { target: { value: 'Invoice' } });
  fireEvent.click(toggle);
  expect(document.querySelector('[data-search-row]')).toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});

test.each([true, false])('Escape cancels a delayed search (compact=%s)', async compact => {
  mountSearch(compact);
  expect(document.querySelector('[data-time-tree]')).toBeTruthy();
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  fireEvent.change(visibleSearch(compact), { target: { value: 'Invoice' } });
  fireEvent.keyDown(visibleSearch(compact), { key: 'Escape' });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
  expect(document.querySelector('[data-result-list]')).toBeNull();
  if (compact) expect(document.querySelector('[data-search-row]')).toBeNull();
  else expect(visibleSearch(false).value).toBe('');
});

test.each([true, false])('search shortcut retains an existing query and results (compact=%s)', async compact => {
  mountSearch(compact, 'Invoice');
  const search = visibleSearch(compact);
  expect(search.value).toBe('Invoice'); expect(document.querySelector('[data-result-list]')).toBeTruthy();
  const projectTrigger = document.querySelector<HTMLElement>('[data-project-trigger]')!;
  projectTrigger.focus(); fireEvent.click(projectTrigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  // The project trigger owns focus once its menu closes; typing the shortcut returns it to search.
  const trigger = document.querySelector<HTMLElement>('[data-project-trigger]')!;
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(screen.queryByRole('menu', { name: 'Projects' })).toBeNull();
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  expect(document.activeElement).toBe(search);
  expect(search.value).toBe('Invoice'); expect(document.querySelector('[data-result-list]')).toBeTruthy();
});

test("a result says a task asking the user as every screen does, not by its state or its end words", async () => {
  await i18n.changeLanguage("en");
  // A working child with no estimate asks the user: the list and the tree say Question, and so does its result.
  const asking = taskFixture({ id: "T2", parentId: "T1", state: "doing",
    ball: userBall("question", "Lask", at, { questionId: "Lask" }) });
  const finished = taskFixture({ id: "T3", state: "done", log: [logEntry({ id: "Ldone", kind: "reported", toState: "done", fromState: "doing" })] });
  // A held parent says when the work below it is expected to report, as it is said by its own state's word.
  const held = dto({ id: "T4", state: "held" });
  const below = taskFixture({ id: "T5", parentId: "T4", state: "doing",
    log: [logEntry({ id: "Lplan", kind: "reported", fromState: "todo", toState: "doing", estimateMinutes: 60 })] });
  // A member's Run failed while its owner asks the user: still a question, as the list says, not the member's error.
  const memberFailed = taskFixture({ id: "T6", state: "doing", ball: userBall("question", "Lask6", at, { questionId: "Lask6" }) });
  const member = { id: "P6", taskId: "T6", agentId: "A-P6", profileKey: "codex", responsible: false, active: true, revision: 1,
    startedAt: at, endedAt: null, headRunId: null,
    runtime: { displayState: "attention" as const, reason: "exit" as const, sourceRunIds: [], runningCount: 0, queuedCount: 0, since: null,
      lastOutputAt: null, activityKind: null, toolName: null } };
  const value = tree({ tasks: [dto({ id: "T1" }), asking, finished, held, below, memberFailed], placements: [member] });
  seedSearch(value.root, "x", ["T2", "T3", "T4", "T6"]);
  useViewStore.setState({ query: "x" });
  render(<TestWorkspace data={screenData(value)}><SearchResults /></TestWorkspace>);
  const row = document.querySelector<HTMLElement>('[data-result="T2"]')!;
  expect(row.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("question");
  const word = row.querySelector<HTMLElement>("span span span")!;
  expect(word.textContent).toBe(i18n.t("ui:turn.question"));
  expect(word.className).toContain("text-turn");
  // An end it reached still says when: a done task's result keeps its time.
  const done = document.querySelector<HTMLElement>('[data-result="T3"] span span span')!.textContent!;
  expect(done).toMatch(new RegExp(`^${i18n.t("ui:state.done")}\\s*\\S`));
  expect(document.querySelector<HTMLElement>('[data-result="T4"] span span span')!.textContent).toMatch(/\d{1,2}:\d{2}/);
  expect(document.querySelector<HTMLElement>('[data-result="T6"] span span span')!.textContent).toBe(i18n.t("ui:turn.question"));
});
