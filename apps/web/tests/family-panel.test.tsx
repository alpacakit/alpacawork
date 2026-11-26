import type { StartOrderDTO } from "@alpacawork/contract";
import { useReaderPanel, forgetPanelPositions } from "../src/features/reader/reader-panel";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { Reader, readerBox } from "../src/features/reader/Reader";
import { useViewStore } from "../src/state/view-store";
import { useBar } from "../src/state/bar";
import { useDialogStore } from "../src/state/dialog-store";
import { indexTasks } from "../src/domain/tasks";
import type { Task } from "../src/data/types";
import { branchOpen, familyRoot, familyShape, familySize, FAMILY_LEVEL_CAP, forgetFamilyShapes, hasChildren, openOn, shownChildren } from "../src/features/reader/family";
import { Dialog, DialogContent, DialogHeading } from "../src/components/ui/dialog";
import { TestWorkspace, at, userBall, dto, homeFixture, narrowScreen, screenData, tree } from "./fixtures";
import { TimeTree } from "../src/features/tree/TimeTree";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
beforeEach(() => {
  useViewStore.setState(useViewStore.getInitialState());
  useDialogStore.setState({ dialog: null });
  sessionStorage.clear();
  forgetFamilyShapes();
  useReaderPanel.setState({ kind: null, entries: {}, slot: null });
  forgetPanelPositions();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useBar.setState({ hidden: false, height: 0 }); });

/**
 * The page has no layout here: the reader is given a place on the screen. By default the window beside the list on a
 * 1440×900 screen (left 900, its reading column right inside it), so a computer's panel has room beside it. `slot` is
 * the top of the place under the entry.
 */
type Geometry = { reader: { left: number; top: number; width: number; height: number }; column: number; content: number; slot: number };
const DOCKED: Geometry = { reader: { left: 900, top: 12, width: 528, height: 876 }, column: 901, content: 60, slot: 140 };
const placeReader = (at: Geometry) => vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
  const { left, top, width, height } = at.reader;
  const rect = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  if (this.matches("aside[data-reader-mode]")) return rect(left, top, width, height);
  if (this.matches("[data-reading-column]")) return rect(at.column, at.content, left + width - at.column, height);
  if (this.matches("[data-reader-content]")) return rect(left, at.content, width, top + height - at.content);
  if (this.matches("[data-reader-panel-slot]")) return rect(at.column, at.slot, left + width - at.column, 0);
  return rect(0, 0, 0, 0);
});
beforeEach(() => { placeReader(DOCKED); });

// T1 right under the project; T2 and T4 its children; T3 a grandchild under T2. T9 stands alone.
const family = [
  dto({ id: "T1", title: "Root work" }),
  dto({ id: "T2", title: "First child", parentId: "T1" }),
  dto({ id: "T3", title: "Grandchild", parentId: "T2", state: "todo" }),
  dto({ id: "T4", title: "Second child", parentId: "T1", state: "done" }),
  dto({ id: "T9", title: "Alone" }),
];
const open = (id: string, data = screenData(tree({ tasks: family }))) => {
  act(() => useViewStore.getState().openTask(id, { reader: true, pane: "task" }));
  return render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
};
const entry = () => screen.getByRole("button", { name: /Task tree/ });
const panel = () => screen.getByRole("list", { name: "Task tree of Root work" });
const row = (name: RegExp) => within(panel()).getByRole("button", { name });

/** A minimal index for the rules: ids with parents (null right under the project). */
const index = (pairs: [string, string | null][]) => indexTasks(pairs.map(([id, parent]) =>
  ({ id, parent, kind: "task", title: id, state: "doing", ball: null }) as unknown as Task));

test("the family's root is the work right under the project, and its size counts the root", () => {
  const at = index([["T1", null], ["T2", "T1"], ["T3", "T2"], ["T9", null]]);
  expect(familyRoot("T3", at)?.id).toBe("T1");
  expect(familySize("T1", at)).toBe(3);
  expect(familySize("T9", at)).toBe(1);
});

test("each opening opens the way to the task being read, even folded before, and keeps the way to the one read before", () => {
  const at = index([["T1", null], ["T2", "T1"], ["T3", "T2"], ["T4", "T1"], ["T5", "T4"], ["T6", "T5"]]);
  const shape = familyShape("T1");
  openOn(shape, "T3", at);
  expect(branchOpen(shape, "T2", "T3", at)).toBe(true);
  shape.folds.set("T2", false);                     // the person folds the way to T3, closes, and opens again
  openOn(shape, "T3", at);
  expect(branchOpen(shape, "T2", "T3", at)).toBe(true);
  openOn(shape, "T6", at);                          // reading another task: the way to T3 stays as it was seen
  expect(branchOpen(shape, "T2", "T6", at)).toBe(true);
  expect(branchOpen(shape, "T5", "T6", at)).toBe(true);
});

test("a level shows its first rows and the rest as more, the branch toward the task being read always among them", () => {
  const kids = Array.from({ length: FAMILY_LEVEL_CAP + 4 }, (_, n): [string, string] => [`T${100 + n}`, "T1"]);
  const at = index([["T1", null], ...kids]);
  const last = kids.at(-1)![0];
  const shape = familyShape("T1");
  const { shown, rest } = shownChildren(shape, "T1", last, at);
  expect(shown).toHaveLength(FAMILY_LEVEL_CAP);
  expect(shown.map((task) => task.id)).toContain(last);
  expect(rest).toBe(4);
  shape.more.add("T1");
  expect(shownChildren(shape, "T1", last, at)).toMatchObject({ rest: 0 });
});

test("a task alone under its project shows no way to a family", () => {
  open("T9");
  expect(screen.queryByRole("button", { name: /Task tree/ })).toBeNull();
});

test("from a grandchild, the panel shows the whole family from the root, the task being read boxed, and no counts on rows", async () => {
  open("T3");
  expect(entry().getAttribute("aria-label")).toBe("Task tree 4 tasks");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const here = row(/^T3 Grandchild, Not started, current$/);
  expect(here.getAttribute("aria-current")).toBe("page");
  expect(row(/^T1 Root work, Waiting$/)).toBeTruthy();
  expect(row(/^T4 Second child, Done/)).toBeTruthy();
  // A row says its state and title; its children are behind its fold mark, not a number.
  expect(within(panel()).queryByText(/^\d+$/)).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(here));
});

test("the panel has no head: the root's row names it once and holds the × beside it, for a task with no family too", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const surface = document.querySelector<HTMLElement>("[data-family-surface]")!;
  expect(within(surface).queryByRole("heading")).toBeNull();
  expect(within(surface).getAllByText("Root work")).toHaveLength(1);
  expect(surface.getAttribute("aria-label")).toBe("Task tree");   // no heading on screen; the name is still the surface's
  const head = surface.querySelector<HTMLElement>("[data-family-head]")!;
  expect(head.querySelector("[data-family-row]")!.getAttribute("data-family-row")).toBe("T1");
  expect(head.querySelector("[data-family-row] button[aria-label='Close the task tree']")).toBeNull();   // outside the row's box
  expect(within(head).getByRole("button", { name: "Close the task tree" })).toBeTruthy();
  // Moved to a task alone under its project: no entry any more, and the × is what closes it.
  act(() => useViewStore.getState().openTask("T9", { reader: true, pane: "task" }));
  await waitFor(() => screen.getByRole("list", { name: "Task tree of Alone" }));
  expect(screen.queryByRole("button", { name: /^Task tree/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close the task tree" }));
  await waitFor(() => expect((useReaderPanel.getState().kind !== null)).toBe(false));
});

test("each row, parent, child and grandchild alike, shows its task's ID before its title", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  for (const [id, title] of [["T1", "Root work"], ["T2", "First child"], ["T3", "Grandchild"], ["T4", "Second child"]]) {
    const go = panel().querySelector(`[data-family-row="${id}"] [data-family-go]`)!;
    const [shownId, shownTitle] = [...go.querySelectorAll("span")].filter((span) => span.textContent).map((span) => span);
    expect(shownId!.textContent).toBe(id);
    expect(shownTitle!.textContent).toBe(title);           // the title is the task's own, nothing added to it
  }
});

test("picking a task opens it in the reader and the panel stays open, the box moved to it and the way before still open", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  fireEvent.click(row(/^T4 Second child/));
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T4"));
  expect(row(/^T4 Second child, Done, current$/).getAttribute("aria-current")).toBe("page");
  expect(row(/^T3 Grandchild/)).toBeTruthy();          // the way to the task read before stays open
  expect(entry().getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(row(/^T1 Root work/));                // and another, in a row
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T1"));
  expect(row(/^T1 Root work, Waiting, current$/)).toBeTruthy();
});

test("the panel stays open whichever way the reader moves, to another family too, and closes with the reader or its ×", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  act(() => useViewStore.getState().openTask("T9", { reader: true, pane: "task" }));   // a link, the list: another root
  await waitFor(() => screen.getByRole("list", { name: "Task tree of Alone" }));
  act(() => useViewStore.getState().openTask("T2", { reader: true, pane: "task" }));
  await waitFor(() => panel());
  expect(row(/^T2 First child, Waiting, current$/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close the task tree" }));
  await waitFor(() => expect(screen.queryByRole("list", { name: /Task tree of/ })).toBeNull());
  expect((useReaderPanel.getState().kind !== null)).toBe(false);
  fireEvent.click(entry());                          // the entry opens it again, and closes it
  await waitFor(() => panel());
  fireEvent.click(entry());
  await waitFor(() => expect(screen.queryByRole("list", { name: /Task tree of/ })).toBeNull());
  fireEvent.click(entry());
  await waitFor(() => panel());
  act(() => useViewStore.getState().closeReader());
  expect((useReaderPanel.getState().kind !== null)).toBe(false);
});

test("the panel stays open while the reader waits for a task still being looked up, and comes back on the next one", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  // A link to a task the page does not hold yet: the reader stands waiting for it, drawn without a task.
  act(() => useViewStore.setState((view) => ({ selected: null, reader: { ...view.reader, open: true, address: "T118" } })));
  expect((useReaderPanel.getState().kind !== null)).toBe(true);
  expect(panel()).toBeTruthy();                      // still the family of the task last shown
  act(() => useViewStore.getState().openTask("T4", { reader: true, pane: "task" }));
  await waitFor(() => expect(row(/^T4 Second child, Done, current$/)).toBeTruthy());
  expect(entry().getAttribute("aria-expanded")).toBe("true");
});

test("Esc closes a dialog opened over the panel first, and the panel stays", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  function Settings() {
    const [shown, show] = useState(true);
    return <Dialog open={shown} onOpenChange={show}><DialogContent><DialogHeading title="Settings" /></DialogContent></Dialog>;
  }
  render(<Settings />);
  await waitFor(() => screen.getByRole("dialog", { name: "Settings" }));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  expect((useReaderPanel.getState().kind !== null)).toBe(true);
  fireEvent.keyDown(document.body, { key: "Escape" });   // and then the panel
  expect((useReaderPanel.getState().kind !== null)).toBe(false);
});

test("on a computer the panel stands beside the reader, over the list, from under the entry down to the reader's foot, clear of it", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const surface = document.querySelector<HTMLElement>("[data-family-surface]")!;
  expect(surface.getAttribute("data-family-surface")).toBe("beside");
  // Its right edge 12px left of the reader's (900), its top 4px under the entry's slot (140), down to the reader's foot,
  // as wide as it may be.
  expect([surface.style.left, surface.style.top, surface.style.width, surface.style.maxHeight]).toEqual(["505px", "144px", "384px", "744px"]);
  expect(surface.closest("aside[data-reader-mode]")).toBeNull();
  // Its edge and shadow are the reader window's: the same hairline in lit-line, the same float (a 1px edge in a browser
  // drawing hairlines at 1px would not show in its computed style, so the definitions are compared).
  const edge = (classes: string) => classes.split(/\s+/).filter((name) => /^(border|shadow|rounded)/.test(name)).sort();
  expect(edge(surface.className)).toEqual(edge(readerBox("docked")));
});

test("reading on in the reader leaves the panel beside it where it opened, under the entry", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const content = document.querySelector<HTMLElement>("[data-reader-content]")!;
  // Scrolled 200px: the slot has gone up as far, out of the reader's top.
  Object.defineProperty(content, "scrollTop", { configurable: true, get: () => 200 });
  placeReader({ ...DOCKED, slot: -60 });
  act(() => { window.dispatchEvent(new Event("resize")); });
  expect(document.querySelector<HTMLElement>("[data-family-surface]")!.style.top).toBe("144px");
});

test("the reader as the whole screen: the panel stands in its margin, left of the reading column, its top under the entry", async () => {
  placeReader({ reader: { left: 0, top: 0, width: 1440, height: 900 }, column: 336, content: 56, slot: 120 });
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const surface = document.querySelector<HTMLElement>("[data-family-surface]")!;
  expect(surface.getAttribute("data-family-surface")).toBe("beside");
  expect([surface.style.left, surface.style.top, surface.style.width, surface.style.maxHeight]).toEqual(["12px", "124px", "312px", "764px"]);
  // The list's bar, under the reader here, does not push it down however tall a notice makes it.
  act(() => { useBar.setState({ height: 200 }); });
  expect(document.querySelector<HTMLElement>("[data-family-surface]")!.style.top).toBe("124px");
});

test("with no room beside the reader, the panel stands under the entry inside the reader and pushes the reading down", async () => {
  placeReader({ reader: { left: 160, top: 12, width: 1268, height: 876 }, column: 161, content: 60, slot: 140 });
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const surface = document.querySelector<HTMLElement>("[data-family-surface]")!;
  expect(surface.getAttribute("data-family-surface")).toBe("under");
  expect(surface.closest("[data-head-title]")).not.toBeNull();
  // In the reader's own flow: the window's edge line, and no shadow (it lies in its place, not over anything). It stands
  // inside the reader's pane, so its corner steps down from the pane's: rounded-lg, not rounded-pane.
  const edge = (classes: string) => classes.split(/\s+/).filter((name) => /^border/.test(name)).sort();
  expect(edge(surface.className)).toEqual(edge(readerBox("docked")));
  expect(surface.className.split(/\s+/)).toContain("rounded-lg");
  expect(surface.className).not.toMatch(/shadow/);
  expect(entry().compareDocumentPosition(surface) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // Picking a task there keeps it open under the next task's entry.
  fireEvent.click(row(/^T4 Second child/));
  await waitFor(() => expect(row(/^T4 Second child, Done, current$/)).toBeTruthy());
  expect(document.querySelector("[data-family-surface]")!.closest("[data-head-title]")).not.toBeNull();
});

test("with no room beside the reader, the panel stays through a task still being looked up, the same panel, and comes back under the next entry", async () => {
  placeReader({ reader: { left: 160, top: 12, width: 1268, height: 876 }, column: 161, content: 60, slot: 140 });
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const drawn = document.querySelector("[data-family-panel]");
  act(() => useViewStore.setState((view) => ({ selected: null, reader: { ...view.reader, open: true, address: "T118" } })));
  expect(panel()).toBeTruthy();
  expect(document.querySelector("[data-family-surface]")!.closest("[data-reader-awaiting]")).not.toBeNull();
  act(() => useViewStore.getState().openTask("T4", { reader: true, pane: "task" }));
  await waitFor(() => expect(row(/^T4 Second child, Done, current$/)).toBeTruthy());
  expect(document.querySelector("[data-family-surface]")!.closest("[data-head-title]")).not.toBeNull();
  expect(document.querySelector("[data-family-panel]")).toBe(drawn);
});

for (const [from, to] of [[true, false], [false, true]] as const)
  test(`turned from ${from ? "a phone" : "a computer"} to ${to ? "a phone" : "a computer"} with a dialog open over it, the panel stays under the dialog and Esc closes the dialog first`, async () => {
    const screen_ = narrowScreen(from);
    try {
      open("T3");
      fireEvent.click(entry());
      await waitFor(() => panel());
      function Settings() {
        const [shown, show] = useState(true);
        return <Dialog open={shown} onOpenChange={show}><DialogContent><DialogHeading title="Settings" /></DialogContent></Dialog>;
      }
      render(<Settings />);
      await waitFor(() => screen.getByRole("dialog", { name: "Settings" }));
      screen_.set(to);                                 // the phone turned, or the window widened or narrowed
      await waitFor(() => expect(document.querySelector(to ? "[data-family-sheet]" : "[data-family-surface]")).not.toBeNull());
      // Drawn where it was opened: before the dialog opened after it, in the page's order.
      const surface = document.querySelector(to ? "[data-family-sheet]" : "[data-family-surface]")!;
      const dialog = screen.getByRole("dialog", { name: "Settings" });
      expect(surface.compareDocumentPosition(dialog) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      fireEvent.keyDown(document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
      expect((useReaderPanel.getState().kind !== null)).toBe(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect((useReaderPanel.getState().kind !== null)).toBe(false);
    } finally { screen_.restore(); }
  });

test("the fold mark opens and folds a branch without leaving the panel", async () => {
  open("T4");
  fireEvent.click(entry());
  await waitFor(() => panel());
  expect(within(panel()).queryByRole("button", { name: /^T3 Grandchild/ })).toBeNull();
  const fold = within(panel()).getByRole("button", { name: "Expand tasks under First child" });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(fold);
  expect(row(/^T3 Grandchild/)).toBeTruthy();
  expect(within(panel()).getByRole("button", { name: "Collapse tasks under First child" }).getAttribute("aria-expanded")).toBe("true");
  expect(useViewStore.getState().selected).toBe("T4");
});

test("picking the task being read leaves everything as it is", async () => {
  open("T3");
  fireEvent.click(entry());
  await waitFor(() => panel());
  fireEvent.click(row(/^T3 Grandchild/));
  expect(useViewStore.getState().selected).toBe("T3");
  expect(panel()).toBeTruthy();
});

const states = { todo: 0, doing: 0, error: 0, waiting: 0, held: 0, done: 2, stopped: 0 };

test("a branch whose children are all finished has children, by the server's count, before any of them is read", () => {
  const at = indexTasks([{ id: "T1", parent: null, kind: "task" }, { id: "T2", parent: "T1", kind: "task" }] as unknown as Task[],
    { T2: { live: 0, finished: 2, states, runningBelow: 0, below: 2 }, T1: { live: 1, finished: 0, states, runningBelow: 0, below: 3 } });
  expect(hasChildren("T2", at)).toBe(true);
  expect(familySize("T1", at)).toBe(4);
});

test("a branch with only finished children has its fold mark, and opening it reads their page", async () => {
  const data = screenData(tree({ tasks: family.slice(0, 3), children: {
    T1: { live: 1, finished: 0, states: { ...states, done: 0, doing: 1 }, runningBelow: 0, below: 4 },
    T2: { live: 1, finished: 0, states: { ...states, done: 0, todo: 1 }, runningBelow: 0, below: 1 },
    T3: { live: 0, finished: 2, states, runningBelow: 0, below: 2 } } }));
  act(() => useViewStore.getState().openTask("T2", { reader: true, pane: "task" }));
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  expect(entry().getAttribute("aria-label")).toBe("Task tree 5 tasks");
  fireEvent.click(entry());
  await waitFor(() => panel());
  const fold = within(panel()).getByRole("button", { name: "Expand tasks under Grandchild" });
  fireEvent.click(fold);
  expect(within(panel()).getByRole("button", { name: "Collapse tasks under Grandchild" }).getAttribute("aria-expanded")).toBe("true");
  // The finished page is being read (or says why it could not be): the branch does not stay empty in silence.
  await waitFor(() => expect(within(panel().parentElement!).queryByRole("status") ?? within(panel().parentElement!).queryByRole("alert")).not.toBeNull());
});

// The same surface opens tree and both dependency directions, never two at once.
const relation = (task: string, state = "doing", finished = false): StartOrderDTO["after"][number] => ({ task, title: `Read ${task}`, state, finished, lifecycle: "active" });
const relationOrder = (after: ReturnType<typeof relation>[], started = false) => ({ after, started, waiting: !started });
function openRelations(started = false) {
  const tasks = [dto({ id: "T1", title: "Family" }), dto({ id: "T2", parentId: "T1", title: "Both sides", state: "todo" }),
    dto({ id: "T3", title: "Stopped work", state: "held" }), dto({ id: "T4", title: "Moving work" }),
    dto({ id: "T5", title: "Finished work", state: "done" }), dto({ id: "T6", title: "Your move", state: "waiting" }),
    dto({ id: "T7", title: "Follower", state: "todo" }), dto({ id: "T8", title: "Only follower", state: "todo" })];
  const after = started ? [relation("T3", "stopped", true), relation("T5", "done", true)]
    : [relation("T5", "done", true), relation("T4"), relation("T3", "held"), relation("T6", "waiting")];
  const data = screenData(tree({ tasks, startOrder: { T2: relationOrder(after, started),
    T7: relationOrder([relation("T2", "todo"), relation("T4")]), T8: relationOrder([relation("T2", "todo")]) },
    balls: { T6: userBall("question", "L6", at, { questionId: "11111111-1111-4111-8111-111111111111" }) } }));
  act(() => useViewStore.getState().openTask("T2", { reader: true, pane: "task" }));
  return render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
}
const relationEntry = (kind: string) => document.querySelector<HTMLButtonElement>(`[data-reader-panel-entry="${kind}"]`)!;
const relatedPanel = () => document.querySelector<HTMLElement>("[data-reader-panel]")!;
function dependencyHead(name: string) {
  const surface = relatedPanel();
  expect(within(surface).queryByText("Dependencies", { exact: true })).toBeNull();
  const first = surface.querySelector<HTMLElement>("[data-order-head]")!;
  expect(first.querySelector("h3")!.textContent).toBe(name);
  expect(surface.querySelector("[data-order-scroll]")!.firstElementChild).toBe(first);
  expect(first.querySelector("button")).toBe(within(surface).getByRole("button", { name: "Close" }));
  expect(within(surface).getAllByRole("button", { name: "Close" })).toHaveLength(1);
}

test("entries show both directions, count every prerequisite after first start too, and no inline dependency block", async () => {
  openRelations(true);
  const entries = document.querySelector("[data-reader-entries]")!;
  expect([...entries.querySelectorAll("button")].map(button => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "History", "Context", "Analysis", "Task tree 2 tasks", "Dependencies 4 tasks",
  ]);
  expect(document.querySelector("[data-reader-order]")).toBeNull();
  expect(document.querySelector("[data-order-task]")).toBeNull();
  fireEvent.click(relationEntry("dependencies"));
  await waitFor(() => expect(relatedPanel()?.getAttribute("data-reader-panel")).toBe("dependencies"));
  expect(relatedPanel().querySelector("[data-order-started]")!.textContent).toBe("This task started after the following tasks");
  const rows = [...relatedPanel().querySelectorAll('[data-order-section="after"] [data-order-task]')];
  expect(rows.map(row => row.getAttribute("data-order-task"))).toEqual(["T3", "T5"]);
  expect(rows[0]!.textContent).toContain("Stopped");
  expect(rows[1]!.textContent).toContain("Done");
  expect(relatedPanel().querySelector("[data-order-stuck]")).toBeNull();
});

test("prerequisites rank the user's move, stopped, moving then finished; stuck help belongs below its row", async () => {
  openRelations();
  fireEvent.click(relationEntry("dependencies"));
  await waitFor(() => expect(relatedPanel()).toBeTruthy());
  const list = relatedPanel().querySelector("ul")!;
  expect([...list.querySelectorAll("[data-order-task]")].map(row => row.getAttribute("data-order-task"))).toEqual(["T6", "T3", "T4", "T5"]);
  expect(list.querySelector('[data-order-task="T6"]')!.textContent).toContain("Question");
  const stuck = list.querySelector('[data-order-task="T3"]')!.parentElement!;
  expect(stuck.querySelector("[data-order-stuck]")!.textContent).toContain("T3 is on hold.");
  expect(stuck.nextElementSibling!.querySelector("[data-order-stuck]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(relatedPanel()).toBeNull());
  expect(relationEntry("dependencies")).toBe(document.activeElement);
});

for (const narrow of [false, true]) test(`one shared ${narrow ? "phone sheet" : "computer panel"} shows both dependency sections; navigation and closing keep the same rules`, async () => {
  const phone = narrowScreen(narrow);
  try {
    openRelations();
    expect(relationEntry("dependencies").getAttribute("aria-label")).toBe("Dependencies 6 tasks");
    expect(relationEntry("after")).toBeNull();
    expect(relationEntry("waiters")).toBeNull();
    fireEvent.click(relationEntry("family"));
    await waitFor(() => expect(relatedPanel()?.getAttribute("data-reader-panel")).toBe("family"));
    const place = relatedPanel().parentElement;
    fireEvent.click(relationEntry("dependencies"));
    await waitFor(() => expect(relatedPanel()?.getAttribute("data-reader-panel")).toBe("dependencies"));
    expect(document.querySelectorAll("[data-reader-panel]")).toHaveLength(1);
    expect(relatedPanel().getAttribute("aria-label")).toBe("Dependencies");
    expect(document.querySelector("[data-family-panel]")).toBeNull();
    expect(relatedPanel().parentElement).toBe(place);
    expect(relatedPanel().querySelector("[data-sheet-grip]") !== null).toBe(narrow);
    expect([...relatedPanel().querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Waits for 4 tasks", "Followed by 2 tasks"]);
    dependencyHead("Waits for 4 tasks");
    expect(relatedPanel().querySelector('[data-order-task="T7"]')!.textContent).toContain("Not started");
    expect(relatedPanel().textContent).toContain("Also waits for T4");
    expect(relatedPanel().textContent).toContain("Waits only for this task");
    expect(relationEntry("family").getAttribute("aria-expanded")).toBe("false");
    expect(relationEntry("dependencies").getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(relatedPanel().querySelector('[data-order-task="T7"]')!);
    await waitFor(() => expect(useViewStore.getState().selected).toBe("T7"));
    expect(useReaderPanel.getState().kind).toBe("dependencies");
    expect(relationEntry("dependencies").getAttribute("aria-label")).toBe("Dependencies 2 tasks");
    expect([...relatedPanel().querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Waits for 2 tasks"]);
    dependencyHead("Waits for 2 tasks");
    fireEvent.click(within(relatedPanel()).getByRole("button", { name: "Close" }));
    expect(useReaderPanel.getState().kind).toBeNull();
    fireEvent.click(relationEntry("dependencies"));
    await waitFor(() => expect(relatedPanel()).toBeTruthy());
    // Follow a prerequisite with followers only: the same panel now shows that direction alone.
    fireEvent.click(relatedPanel().querySelector('[data-order-task="T4"]')!);
    await waitFor(() => expect(useViewStore.getState().selected).toBe("T4"));
    expect(relationEntry("dependencies").getAttribute("aria-label")).toBe("Dependencies 2 tasks");
    expect([...relatedPanel().querySelectorAll("h3")].map(h => h.textContent)).toEqual(["Followed by 2 tasks"]);
    dependencyHead("Followed by 2 tasks");
    fireEvent.click(within(relatedPanel()).getByRole("button", { name: "Close" }));
    expect(useReaderPanel.getState().kind).toBeNull();
    fireEvent.click(relationEntry("dependencies"));
    await waitFor(() => expect(relatedPanel()).toBeTruthy());
    act(() => useViewStore.getState().openTask("T2", { reader: true, pane: "task" }));
    await waitFor(() => expect(relatedPanel()?.querySelectorAll("[data-order-task]")).toHaveLength(6));
    fireEvent.click(relationEntry("family"));
    expect(document.querySelectorAll("[data-reader-panel]")).toHaveLength(1);
    expect(document.querySelector("[data-order-list]")).toBeNull();
    fireEvent.click(relationEntry("dependencies"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useReaderPanel.getState().kind).toBeNull();
    fireEvent.click(relationEntry("dependencies"));
    await waitFor(() => expect(relatedPanel()).toBeTruthy());
    fireEvent.click(relationEntry("dependencies"));
    expect(useReaderPanel.getState().kind).toBeNull();
    fireEvent.click(relationEntry("dependencies"));
    act(() => useViewStore.getState().closeReader());
    expect(useReaderPanel.getState().kind).toBeNull();
  } finally { phone.restore(); }
});

for (const narrow of [false, true]) test(`dependencies disappear at a task with neither direction and return with their selected kind (${narrow ? "phone" : "computer"})`, async () => {
  const phone = narrowScreen(narrow);
  try {
    openRelations();
    fireEvent.click(relationEntry("dependencies"));
    await waitFor(() => expect(relatedPanel()?.getAttribute("data-reader-panel")).toBe("dependencies"));
    // Finished T5 has no prerequisites, nor any unfinished dependency edge back to it.
    fireEvent.click(relatedPanel().querySelector('[data-order-task="T5"]')!);
    await waitFor(() => expect(useViewStore.getState().selected).toBe("T5"));
    expect(relationEntry("dependencies")).toBeNull();
    expect(relatedPanel()).toBeNull();
    expect(document.querySelector('[data-order-list]')).toBeNull();
    expect(useReaderPanel.getState().kind).toBe("dependencies");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useReaderPanel.getState().kind).toBe("dependencies");
    act(() => useViewStore.getState().openTask("T2", { reader: true, pane: "task" }));
    await waitFor(() => expect(relatedPanel()?.getAttribute("data-reader-panel")).toBe("dependencies"));
    expect(relationEntry("dependencies").getAttribute("aria-expanded")).toBe("true");
    expect(relatedPanel().querySelectorAll('[data-order-task]')).toHaveLength(6);
  } finally { phone.restore(); }
});

test("a task has the same mark in the list as in the task tree: idle work waits, a stop for the user is an error", async () => {
  // T1 works on nothing itself and its children run nothing: its child T2 is held, T3 stopped at its limit.
  const tasks = [dto({ id: "T1", title: "Root work" }), dto({ id: "T2", title: "Held child", parentId: "T1", state: "held" }),
    dto({ id: "T3", title: "Stopped child", parentId: "T1" })];
  const data = () => screenData(tree({ tasks, balls: { T3: userBall("limit", "Llimit", at, { count: 1 }) },
    home: homeFixture([{ taskId: "T1", section: "awaited" }, { taskId: "T3", section: "error" }]) }));
  const listData = data();
  listData.info.counts.home.root!.awaited = 1;
  listData.info.counts.home.root!.error = 1;
  const list = render(<TestWorkspace data={listData}><TimeTree /></TestWorkspace>);
  fireEvent.click(list.container.querySelector('[data-section="awaited"] button')!);
  const listed = (id: string) => document.querySelector(`[data-row="${id}"] [data-row-label] [data-icon]`)?.getAttribute("data-icon");
  expect([listed("T1"), listed("T3")]).toEqual(["pause", "error"]);
  list.unmount();
  open("T1", data());
  fireEvent.click(entry());
  await waitFor(() => panel());
  const inTree = (id: string) => document.querySelector(`[data-family-row="${id}"] [data-icon]:not([data-icon="right"])`)?.getAttribute("data-icon");
  expect([inTree("T1"), inTree("T2"), inTree("T3")]).toEqual(["pause", "held", "error"]);
});
