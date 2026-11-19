import { useWriteIntentStore, intentKey } from '../src/data/write-intent';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from "vitest";
import { act, cleanup, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { notify, useToasts } from "../src/lib/notify";
import { Workbench } from "../src/features/shell/Workbench";
import { useDialogStore } from "../src/state/dialog-store";
import { openInput } from "../src/state/open-input";
import { useViewStore } from "../src/state/view-store";
import { navigate } from "../src/lib/history";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { TestWorkspace, homeFixture, narrowScreen, pointerCanHover, screenData, tree, dto } from "./fixtures";
import { problemResponse } from "./problem";
import * as readerModule from "../src/features/reader/Reader";
import * as appBarModule from "../src/features/chrome/AppBar";
import { useSitting } from "../src/features/reader/next-question";
import { readerWidth } from "../src/state/screen-settings";

/**
 * The page as a whole: the full text is one element whatever its form, so an
 * input drawn in it survives a change of width.
 */
beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear();
  useConnection.setState({ offline: false });
  useDialogStore.setState({ dialog: null });
  useViewStore.setState(useViewStore.getInitialState());
  history.replaceState(null, "", "/");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
/** T1 at work with its child T11: a row of the list's Working, which is never folded. */
const data = () => screenData(tree({ tasks: [dto({ hash: "a".repeat(64), body: "Body h0\n" }), dto({ id: "T11", parentId: "T1", title: "Child one" })],
  home: homeFixture([{ taskId: "T1", section: "doing", summary: { done: 0, total: 1 } }]) }));
/**
 * These component checks set up a local view first; restore it after the URL bootstrap mounts, as one change of the
 * screen (the URL then says it too).
 */
const mount = (workspace = data()) => {
  const view = useViewStore.getState();
  const dialog = useDialogStore.getState().dialog;
  const rendered = render(<TestWorkspace data={workspace}><Workbench /></TestWorkspace>);
  act(() => { navigate(() => useViewStore.setState(view)); useDialogStore.setState({ dialog }); });
  return rendered;
};
const editor = () => screen.getByRole("textbox", { name: "本文" }) as HTMLTextAreaElement;
const reader = () => screen.getByRole("complementary", { name: "Full text of the task" });
const save = () => screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
const mockWriteRefusal = (response: Response) => vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
  String(input).includes("/api/task/timeline") ? new Response(JSON.stringify({ rows: [], runs: [], events: [],
    anchors: {}, placements: [], nextAfter: null }),
    { headers: { "Content-Type": "application/json" } }) : response.clone());
const writes = (fetcher: ReturnType<typeof mockWriteRefusal>) => fetcher.mock.calls.filter(([input, init]) =>
  init?.method === "POST" && !String(input).includes("/api/presence"));

test("moving the open reader to another task redraws no page around it, and its sitting redraws no reader", async () => {
  const previousWidth = innerWidth;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  const appBar = vi.spyOn(appBarModule, "AppBar");
  const renderReader = vi.spyOn(readerModule, "Reader");
  mockWriteRefusal(problemResponse("save_unconfirmed", "Unknown"));
  try {
    mount();
    act(() => useViewStore.getState().openTask("T1", { reader: true }));
    await act(async () => {});
    expect(reader().querySelector("[data-reader-task-id]")?.textContent).toBe("T1");
    appBar.mockClear();
    act(() => useViewStore.getState().openTask("T11", { reader: true }));
    await act(async () => {});
    expect(reader().querySelector("[data-reader-task-id]")?.textContent).toBe("T11");
    expect(appBar).not.toHaveBeenCalled();
    renderReader.mockClear();
    act(() => useSitting.setState({ order: ["T11"] }));
    await act(async () => {});
    expect(renderReader).not.toHaveBeenCalled();
    act(() => useViewStore.getState().closeReader());
    await act(async () => {});
    expect(screen.queryByRole("complementary", { name: "Full text of the task" })).toBeNull();
    expect(appBar).toHaveBeenCalled();
  } finally {
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: previousWidth });
  }
});

test("the C title key on a list row opens nothing: the screen makes no Task, even under a task with a responsible", () => {
  const responsible = { id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true,
    active: true, revision: 1, startedAt: "2026-09-24T09:00:00Z", endedAt: null, headRunId: null,
    runtime: { displayState: "idle" as const, reason: null, sourceRunIds: [], runningCount: 0, queuedCount: 0,
      since: null, lastOutputAt: null, activityKind: null, toolName: null } };
  useViewStore.getState().openReader("T1");
  mount(screenData(tree({ tasks: [dto({ hash: "a".repeat(64), body: "Body h0\n" }), dto({ id: "T11", parentId: "T1", title: "Child one" })],
    placements: [responsible], home: homeFixture([{ taskId: "T1", section: "doing", summary: { done: 0, total: 1 } }]) })));
  fireEvent.keyDown(document.querySelector('[data-read="T1"]')!, { key: "c" });
  expect(useDialogStore.getState().dialog).toBeNull();
});

// Another task's edit and every way the full text closes.
/** A refusal as the server answers it: 400 a refused input, 404 a missing Task, 409 a changed Task, 503 an unconfirmed save. */
const refusal = (status: 400 | 404 | 409 | 503) =>
  problemResponse(({ 400: "invalid_input", 404: "not_found", 409: "conflict", 503: "save_unconfirmed" } as const)[status], "Server refusal");
const twoTasks = () => screenData(tree({ tasks: [dto({ hash: "a".repeat(64), body: "Body one\n" }), dto({ id: "T2", title: "Task two", hash: "b".repeat(64), body: "Body two\n" })],
  home: homeFixture(["T1", "T2"].map((taskId) => ({ taskId, section: "doing" as const }))) }));
const title = (id: string) => document.querySelector<HTMLElement>(`[data-read="${id}"]`)!;

test("the reader's title is read, not edited: its whole row is the heading, and T on a card opens nothing", () => {
  mount(twoTasks());
  act(() => useViewStore.getState().openTask("T2", { reader: true }));
  const heading = within(reader()).getByRole("heading", { level: 2 });
  expect(heading.textContent).toBe("Task two");
  expect(heading.parentElement!.querySelector("button")).toBeNull();
  fireEvent.keyDown(title("T2"), { key: "t" });
  expect(useDialogStore.getState().dialog).toBeNull();
});

test("the path in the full text's header follows the ancestor and offers a return", () => {
  pointerCanHover();
  useViewStore.getState().openTask("T11", { reader: true });
  mount();
  fireEvent.click(within(within(reader()).getByRole("navigation")).getByRole("button", { name: /Task one$/ }));
  expect(useViewStore.getState()).toMatchObject({ reader: { open: true }, selected: "T1" });
  expect(useDialogStore.getState().dialog).toBeNull();
  // Following the ancestor is a step of the reader: its one Back goes back to the task it was followed from.
  expect(within(reader()).getByRole("button", { name: "Back" })).toBeTruthy();
  expect(history.state.behind).toMatchObject({ task: "T11", pane: "task" });
});

test("on the narrow width the closed full text gives the focus to the task's title", async () => {
  const narrow = narrowScreen(true);
  try {
    useViewStore.getState().openReader("T1");
    mount();
    fireEvent.click(within(reader()).getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(document.activeElement).toBe(title("T1")));
  } finally { narrow.restore(); }
});
