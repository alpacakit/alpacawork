import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { queryClient } from "../src/data/query-client";
import { TimeTree } from "../src/features/tree/TimeTree";
import { Reader } from "../src/features/reader/Reader";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, at, dto, homeFixture, narrowScreen, project, screenData, taskFixture, tree, userBall } from "./fixtures";
import { problemResponse } from "./problem";

/**
 * The home list is the server's (index-feed's homeRows): its sections, its rows in their order, each row's summary, the
 * counts, and which project a row is in. The screen draws them as sent and derives none of them.
 */
beforeAll(() => startI18n());
beforeEach(() => useViewStore.setState(useViewStore.getInitialState()));
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

const rowsIn = (container: HTMLElement, section: string) =>
  [...container.querySelectorAll<HTMLElement>(`[data-section="${section}"] + ol > [data-row]`)].map((row) => row.dataset.row);
/** Whether a row says `word` for its state: in its words (a phone's, for a reader) or as its icon's name (a computer's). */
const saysState = (row: Element, word: string) => !!row.textContent?.includes(word) || [...row.querySelectorAll("[aria-label]")].some(each => each.getAttribute("aria-label") === word);
const heading = (container: HTMLElement, section: string) => container.querySelector(`[data-section="${section}"]`)?.textContent?.trim();

test("each row is in the section the server lists it in, in its order, with the server's counts; a Task it does not list has no row", () => {
  // T1 works but waits on the user (its automatic requests stopped at their limit); T2 waits for a review that is not
  // the user's; T3 is in the index and listed nowhere; Not started is listed T5 before T4.
  const data = screenData(tree({ tasks: [
    taskFixture({ id: "T1", state: "doing", userRequested: true, ball: userBall("limit", "K1", at, { count: 2 }) }),
    taskFixture({ id: "T2", state: "waiting", userRequested: true, ball: { holder: "parent", reason: "question" } }),
    dto({ id: "T3", state: "doing" }), dto({ id: "T4", state: "todo", userRequested: true }), dto({ id: "T5", state: "todo", userRequested: true }),
  ], home: homeFixture([{ taskId: "T1", section: "review" }, { taskId: "T2", section: "doing" },
    { taskId: "T5", section: "todo" }, { taskId: "T4", section: "todo" }]) }));
  // The counts are the server's as well: the heading says them, whatever rows are drawn.
  data.info = { ...data.info, counts: { ...data.info.counts, home: { ...data.info.counts.home, root: { doing: 1, error: 0, review: 4, awaited: 0, held: 0, todo: 2 } } } };
  const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  expect(rowsIn(container, "review")).toEqual(["T1"]);
  expect(rowsIn(container, "doing")).toEqual(["T2"]);
  expect(rowsIn(container, "todo")).toEqual(["T5", "T4"]);
  expect(container.querySelector('[data-row="T3"]')).toBeNull();
  expect(heading(container, "review")).toBe("Awaiting review4");
  expect(heading(container, "todo")).toBe("Not started2");
});

test("a row's summary is the server's: its children finished of all", () => {
  const data = screenData(tree({ tasks: [dto({ id: "T1", state: "doing", userRequested: true })],
    home: homeFixture([{ taskId: "T1", section: "doing", summary: { done: 1, total: 3 } }]) }));
  const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  expect(container.querySelector('[data-row="T1"] [data-row-progress]')?.textContent).toBe("1/3");
  cleanup();
  const phone = narrowScreen(true);
  try {
    const narrow = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>).container;
    expect(narrow.querySelector('[data-row="T1"] [data-row-progress]')?.textContent).toBe(i18n.t("people:line.children", { done: 1, total: 3 }));
  } finally { phone.restore(); }
});

test("home rows omit the request caption on phone and computer", () => {
  const data = screenData(tree({ tasks: [dto({ id: "T1", title: "Parent request", state: "doing", userRequested: true }),
    taskFixture({ id: "T11", parentId: "T1", title: "Failed step", state: "error", ball: userBall("failed", "F1", at) })],
    home: homeFixture([{ taskId: "T11", section: "error" }]) }));
  const wide = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>).container;
  expect(wide.querySelector('[data-row-request]')).toBeNull();
  expect(wide.querySelector('[data-row="T11"] [data-row-title]')?.textContent).toBe("Failed step");
  cleanup();
  const phone = narrowScreen(true);
  try {
    const narrow = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>).container;
    expect(narrow.querySelector('[data-row-request]')).toBeNull();
    expect(narrow.querySelector('[data-row="T11"] [data-row-title]')?.textContent).toBe("Failed step");
  } finally { phone.restore(); }
});

test("a project's list is the rows of Tasks in it, nested projects included, with that project's counts", () => {
  const data = screenData(tree({ tasks: [project({ id: "P200", parentId: "P100", title: "Nested" }), project({ id: "P300", title: "Other" }),
    dto({ id: "T1", state: "doing", userRequested: true }),
    taskFixture({ id: "T5", parentId: "P200", projectId: "P200", state: "doing", userRequested: true }),
    taskFixture({ id: "T7", parentId: "P300", projectId: "P300", state: "doing", userRequested: true })],
  home: homeFixture(["T1", "T5", "T7"].map((taskId) => ({ taskId, section: "doing" as const }))) }));
  useViewStore.setState({ project: "P100" });
  const { container, unmount } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  expect(rowsIn(container, "doing")).toEqual(["T1", "T5"]);
  expect(heading(container, "doing")).toBe("In progress2");
  unmount();
  useViewStore.setState({ project: "P200" });
  const nested = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>).container;
  expect(rowsIn(nested, "doing")).toEqual(["T5"]);
  expect(heading(nested, "doing")).toBe("In progress1");
});

test("the reader shows the ball's reason and the actions available for that turn", () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => problemResponse("not_found"));
  for (const [ball, words, moves] of [
    [userBall("limit", "K1", at, { count: 3 }), i18n.t("ui:turn.reason.limit", { count: 3 }), [i18n.t("ui:turn.continue")]],
    [userBall("failed", "F1", at), i18n.t("ui:turn.reason.failed"), [i18n.t("ui:turn.retry"), i18n.t("ui:turn.switch"), i18n.t("ui:turn.stop")]],
    [userBall("unconfirmed", "U1", at), i18n.t("ui:turn.reason.unconfirmed"), []],
    [userBall("blocked", "B1", at, { code: "no_profile" }), i18n.t("ui:turn.reason.noProfile"), []],
  ] as const) {
    const data = screenData(tree({ tasks: [taskFixture({ state: "doing", userRequested: true, ball })],
      home: homeFixture([{ taskId: "T1", section: "review" }]) }));
    useViewStore.getState().openTask("T1", { reader: true });
    render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
    const reason = document.querySelector<HTMLElement>("[data-head-title] [data-turn-reason]")!;
    const buttons = [...reason.querySelectorAll("[data-turn-action]")].map((button) => button.textContent);
    expect(buttons).toEqual(moves);
    expect(reason.textContent).toBe([words, ...moves].join(""));
    cleanup(); queryClient.clear(); useViewStore.getState().closeReader();
  }
  // A review or a question says itself: no reason is written for it.
  const data = screenData(tree({ tasks: [taskFixture({ state: "waiting", userRequested: true, ball: userBall("review", "L2", at, { aboutRunId: "R1" }) })],
    home: homeFixture([{ taskId: "T1", section: "review" }]) }));
  useViewStore.getState().openTask("T1", { reader: true });
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  expect(document.querySelector("[data-turn-reason]")).toBeNull();
});

test.each([false, true])("a Waiting row takes the pause look and the section's word, and is otherwise an ordinary row (phone=%s)", narrow => {
  const phone = narrowScreen(narrow);
  try {
    const data = screenData(tree({ tasks: [dto({ id: "T1", state: "doing", userRequested: true }), dto({ id: "T2", parentId: "T1", state: "todo" })],
      home: homeFixture([{ taskId: "T1", section: "awaited", summary: { done: 0, total: 1 } }]) }));
    data.info.counts.home.root!.awaited = 1;
    const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    fireEvent.click(container.querySelector('[data-section="awaited"] button')!);
    const row = container.querySelector('[data-row="T1"]')!;
    expect(row.querySelector('[data-icon="pause"]')?.getAttribute("class")).toContain("text-muted");
    expect(saysState(row, i18n.t("tree:home.awaited"))).toBe(true);
    // It says its children's count as any row does; nothing says what or whom it waits for.
    expect(row.querySelector("[data-row-progress]")).not.toBeNull();
  } finally { phone.restore(); }
});

test.each([false, true])("a row in Error takes the error look even while its Task's state is Working (phone=%s)", narrow => {
  const phone = narrowScreen(narrow);
  try {
    const data = screenData(tree({ tasks: [dto({ id: "T1", state: "doing", userRequested: true }),
      taskFixture({ id: "T11", parentId: "T1", state: "doing", ball: userBall("limit", "K1", at, { count: 2 }) })],
    home: homeFixture([{ taskId: "T11", section: "error" }]) }));
    data.info.counts.home.root!.error = 1;
    const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    const icon = container.querySelector('[data-row="T11"] [data-icon="error"]');
    expect(icon?.getAttribute("class")).toContain("text-error");
    expect(saysState(container.querySelector('[data-row="T11"]')!, i18n.t("ui:state.error"))).toBe(true);
  } finally { phone.restore(); }
});
