import { titleColumnWidth } from "@/state/screen-settings";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { recordNotes } from "./time-history-fixture";
import { expect, onTestFinished, test, vi } from "vitest";
import { projectTimeHistory, timeHistoryBase } from "../src/domain/time-history";
import { TimeTree, edgeOf } from "../src/features/tree/TimeTree";
import { Lane, laneMarks, lineOf, lineReports, rowTurn, stretchReport, TurnEdge, useProbe } from "../src/features/tree/time-line";
import { timelineNoteOf } from "@alpacawork/contract/control";
import { eventKey, logKey } from "../src/domain/history";
import { Reader } from "../src/features/reader/Reader";
import { useTaskIndex } from "../src/data/queries";
import { useUrlBootstrap } from "../src/state/bootstrap";
import { useTimeView } from "../src/state/time-view";
import { useViewStore } from "../src/state/view-store";
import { queryClient } from "../src/data/query-client";
import { resources } from "../src/data/resources";
import { TestWorkspace, dto, historyFixture, homeFixture, logEntry, narrowScreen, run, screenData, tree, userBall } from "./fixtures";
import { setupTimeView, canonical, minute, iso, now, created, report, asked, fixture, openGroup, served } from "./time-view-fixture";

setupTimeView();

function UrlSync() { useUrlBootstrap(useTaskIndex()); return null; }

test("the keyboard zooms the strip", () => {
  // Give zoom a real viewport; English labels reserve more future-band space than Japanese labels.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  expect(useTimeView.getState().viewMs).toBeNull();
  fireEvent.keyDown(sheet, { key: "+" });
  expect(useTimeView.getState().viewMs).toBeLessThan(24 * 60 * minute);
  act(() => useTimeView.setState({ viewMs: 20 * minute }));
  fireEvent.keyDown(sheet, { key: "-" });
  expect(useTimeView.getState().viewMs).toBeGreaterThan(20 * minute);
});

test("the clock keeps its help beside the period control", () => {
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  expect(document.querySelector("[data-span]")?.getAttribute("aria-label")).toBe("Time span");
  expect(document.querySelector("[data-time-legend]")).toBeNull();
  const help = document.querySelector<HTMLElement>("[data-time-tree]")!.getAttribute("aria-description");
  expect(document.querySelector("[data-time-clock] title")?.textContent).toBe(help);
});

test("the period control writes the same zoom used by the keys", () => {
  // Give the control a real desktop width and 90 minutes of continuous work, independent of home row allocation.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(900);
  const task = dto({ id: "T1", state: "doing", log: [created(now - 90 * minute)] });
  const placement = { ...canonical.placements[0]!, id: "P1", taskId: "T1" };
  const data = served(tree({ tasks: [task], placements: [placement], runs: [run("R1", {
    taskId: "T1", placementId: "P1", state: "running", startedAt: iso(now - 90 * minute), endedAt: null,
  })], home: homeFixture([{ taskId: "T1", section: "doing" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const period = document.querySelector<HTMLSelectElement>("[data-span]")!;
  expect(period.querySelector('option[value="1800000"]')).toBeTruthy();
  fireEvent.change(period, { target: { value: "1800000" } });
  expect(useTimeView.getState().viewMs).toBe(30 * minute);
  expect(new URL(location.href).searchParams.get("zoom")).toBe(String(30 * minute));
  fireEvent.keyDown(document.querySelector<HTMLElement>("[data-time-tree]")!, { key: "+" });
  expect(useTimeView.getState().viewMs).toBeLessThan(30 * minute);
});

test("a phone's period options follow the current clock when Time is shown again", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
  const phone = narrowScreen(true);
  try {
    useTimeView.setState({ strips: true });
    const task = dto({ id: "T1", state: "doing", log: [created(now - 90 * minute)] });
    const placement = { ...canonical.placements[0]!, id: "P1", taskId: "T1" };
    const data = served(tree({ tasks: [task], placements: [placement], runs: [run("R1", {
      taskId: "T1", placementId: "P1", state: "running", startedAt: iso(now - 90 * minute), endedAt: null,
    })], home: homeFixture([{ taskId: "T1", section: "doing" }]) }));
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    const period = screen.getByRole("combobox", { name: "Time span" });
    expect(period.querySelector('option[value="21600000"]')).toBeNull();
    fireEvent.change(period, { target: { value: "all" } });

    act(() => { useTimeView.setState({ strips: false }); });
    expect(screen.queryByRole("combobox", { name: "Time span" })).toBeNull();
    vi.setSystemTime(new Date(now + 8 * 60 * minute));
    act(() => { vi.advanceTimersByTime(30_000); });
    act(() => { useTimeView.setState({ strips: true }); });

    const reopened = screen.getByRole("combobox", { name: "Time span" });
    expect(reopened.querySelector('option[value="21600000"]')).toBeTruthy();
    expect(reopened).toHaveProperty("value", "all");
  } finally { phone.restore(); }
});

/** A list that finished hours ago, and the same list once work started 40 minutes before now. */
function laterWork() {
  const before = [dto({ id: "T1", title: "Finished earlier", state: "done",
    log: [created(now - 7 * 60 * minute), report("L2", now - 6 * 60 * minute - 35 * minute, "done")] })];
  const done = { placements: [{ ...canonical.placements[0]!, id: "P1", taskId: "T1" }],
    runs: [run("R1", { taskId: "T1", placementId: "P1", state: "succeeded", createdAt: iso(now - 7 * 60 * minute),
      startedAt: iso(now - 7 * 60 * minute), endedAt: iso(now - 6 * 60 * minute - 10 * minute) })] };
  const later = served(tree({ tasks: [...before, dto({ id: "T2", title: "Started later", state: "doing",
    log: [created(now - 45 * minute), report("L2", now - 40 * minute, "doing", 60)] })],
  placements: [...done.placements, { ...canonical.placements[0]!, id: "P2", taskId: "T2" }],
  runs: [...done.runs, run("R2", { taskId: "T2", placementId: "P2", state: "running", createdAt: iso(now - 40 * minute), startedAt: iso(now - 40 * minute), endedAt: null })],
  home: homeFixture([{ taskId: "T2", section: "doing" }, { taskId: "T1", section: "done" }]) }));
  const clock = () => document.querySelector("[data-time-clock]")!.outerHTML;
  // The axis alone (its length and where now is on it), whatever part of it is scrolled into view.
  const axis = () => { const svg = document.querySelector("[data-time-clock]")!;
    return `${svg.getAttribute("width")} ${svg.querySelector("line.stroke-ink")!.getAttribute("x1")}`; };
  // The finished work is drawn on its Done row, read from the top level's finished page once Done is opened.
  const show = (data: typeof later) => { const view = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>); openGroup("finished"); return view; };
  const fresh = show(later);
  // As a list opened now with Done open: on now, the axis takes in the finished work Done brought.
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  sheet.scrollLeft = 5000;
  fireEvent.scroll(sheet);
  fresh.rerender(<TestWorkspace data={{ ...later }}><TimeTree /></TestWorkspace>);
  const opened = clock(), openedAxis = axis();
  fresh.unmount();
  return { before: served(tree({ tasks: before, ...done, home: homeFixture([{ taskId: "T1", section: "done" }]) })), later, clock, opened, axis, openedAxis, show };
}

test("a chosen period keeps folding only what is quiet: work that came after the list opened stays on the axis", () => {
  // The period is kept in the settings, so a list opened hours ago is drawn at it from the start. Work since then is not
  // a quiet stretch: the axis at now is the one a list opened now would draw.
  useTimeView.setState({ viewMs: 60 * minute });
  const { before, later, clock, opened, show } = laterWork();
  const view = show(before);
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  expect(clock()).toBe(opened);
});

/** A sheet as wide as a computer's; at 30 minutes a screen the strip is longer than it and can be read back in time. */
function wideSheet() {
  const was = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
  Object.defineProperty(Element.prototype, "clientWidth", { configurable: true,
    get(this: Element) { return this.hasAttribute("data-time-tree") ? 1200 : was.get!.call(this); } });
  onTestFinished(() => { Object.defineProperty(Element.prototype, "clientWidth", was); });
}

test("read back in time, the axis stays as it was until now is on screen again", () => {
  wideSheet();
  useTimeView.setState({ viewMs: 30 * minute });
  const { before, later, clock, opened, show } = laterWork();
  const view = show(before);
  const kept = clock();
  expect(kept).not.toBe(opened);
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  sheet.scrollLeft = 0;
  fireEvent.scroll(sheet);
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  expect(clock()).toBe(kept);
  sheet.scrollLeft = 5000;
  fireEvent.scroll(sheet);
  view.rerender(<TestWorkspace data={{ ...later }}><TimeTree /></TestWorkspace>);
  expect(clock()).toBe(opened);
});

test("under a pinch the axis stays as it was, even with now on screen; let go, it follows", () => {
  wideSheet();
  useTimeView.setState({ viewMs: 30 * minute });
  const { before, later, clock, opened, show } = laterWork();
  const view = show(before);
  const kept = clock();
  // On now (the test's sheet has no scroll width of its own, so the strip is put there by hand).
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  sheet.scrollLeft = 5000;
  fireEvent.scroll(sheet);
  const strip = document.querySelector<SVGElement>("[data-time-clock]")!;
  const finger = (clientX: number) => ({ clientX, clientY: 10, target: strip });
  fireEvent.touchStart(strip, { touches: [finger(100), finger(300)] });
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  expect(clock()).toBe(kept);
  fireEvent.touchEnd(strip, { touches: [] });
  view.rerender(<TestWorkspace data={{ ...later }}><TimeTree /></TestWorkspace>);
  expect(clock()).toBe(opened);
});

test("the whole of it, chosen at the strip's left end, follows new work", () => {
  wideSheet();
  useTimeView.setState({ viewMs: 30 * minute });
  const { before, later, clock, show } = laterWork();
  const view = show(before);
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  sheet.scrollLeft = 0;
  fireEvent.scroll(sheet);
  fireEvent.keyDown(sheet, { key: "0" });
  expect(document.querySelector("[data-span]")).toHaveProperty("value", "all");
  const wholeBefore = clock();
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  expect(clock()).not.toBe(wholeBefore);
});

/** The sheet's scroll width as a browser lays it out: the title column and the strip (the test DOM lays nothing out). */
function laidOutSheet() {
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  const strip = () => Number(document.querySelector("[data-time-clock]")!.getAttribute("width"));
  Object.defineProperty(sheet, "scrollWidth", { configurable: true, get: () => titleColumnWidth(1200) + strip() });
  const nowOnScreen = () => Number(document.querySelector("[data-time-clock] line.stroke-ink")!.getAttribute("x1")) - sheet.scrollLeft;
  return { sheet, end: () => sheet.scrollWidth - 1200, nowOnScreen };
}

test("a press on the strip let go off it does not keep the axis held", () => {
  wideSheet();
  useTimeView.setState({ viewMs: 30 * minute });
  const { before, later, axis, openedAxis, show } = laterWork();
  const view = show(before);
  const { sheet, end } = laidOutSheet();
  sheet.scrollLeft = end();
  fireEvent.scroll(sheet);
  const strip = document.querySelector<SVGElement>("[data-time-clock]")!;
  fireEvent.pointerDown(strip, { pointerType: "mouse", button: 0, clientX: 600, pointerId: 1 });
  fireEvent.pointerUp(document.body, { pointerType: "mouse", button: 0, clientX: 600, pointerId: 1 });
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  expect(axis()).toBe(openedAxis);
});

test("just short of the strip's end, new work keeps now where it was on screen", () => {
  wideSheet();
  useTimeView.setState({ viewMs: 30 * minute });
  const { before, later, show } = laterWork();
  const view = show(before);
  const { sheet, end, nowOnScreen } = laidOutSheet();
  sheet.scrollLeft = end() - 20;
  fireEvent.scroll(sheet);
  const was = nowOnScreen();
  expect(was).toBeGreaterThan(0);
  expect(was).toBeLessThan(1200 - titleColumnWidth(1200));
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  expect(nowOnScreen()).toBeCloseTo(was, 0);
});

test("on the way to now, new work coming in still brings the strip to its end", () => {
  wideSheet();
  useTimeView.setState({ viewMs: 30 * minute });
  const { before, later, axis, openedAxis, show } = laterWork();
  const view = show(before);
  const { sheet, end } = laidOutSheet();
  sheet.scrollLeft = 0;
  fireEvent.scroll(sheet);
  view.rerender(<TestWorkspace data={later}><TimeTree /></TestWorkspace>);
  fireEvent.click(document.querySelector<HTMLElement>("[data-to-now]")!);
  // The smooth scroll is part of the way there, with now already on screen, when the axis takes the new work in.
  sheet.scrollLeft = end() - 40;
  fireEvent.scroll(sheet);
  view.rerender(<TestWorkspace data={{ ...later }}><TimeTree /></TestWorkspace>);
  expect(axis()).toBe(openedAxis);
  expect(sheet.scrollLeft).toBe(sheet.scrollWidth);
});

test("a row past the screen's left edge writes its state's icon and time; the state's word is only heard and pointed at", () => {
  wideSheet();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(now);
  useTimeView.setState({ viewMs: 30 * minute });
  const long = now - 7 * 60 * minute, placed = (id: string, taskId: string) => ({ ...canonical.placements[0]!, id, taskId });
  const idle = (taskId: string) => { const number = taskId.slice(1); return { ...placed(`P${number}`, taskId), headRunId: `R${number}`,
    runtime: { ...canonical.placements[0]!.runtime, displayState: "idle" as const, runningCount: 0, sourceRunIds: [], since: null } }; };
  const ended = (taskId: string) => { const number = taskId.slice(1);
    return run(`R${number}`, { taskId, placementId: `P${number}`, state: "succeeded", createdAt: iso(long), startedAt: iso(long), endedAt: iso(long + minute) }); };
  const data = served(tree({ tasks: [dto({ id: "T2", title: "Running", state: "doing", log: [created(now - 90 * minute)] }),
    dto({ id: "T3", title: "Still not started", state: "todo", log: [created(long)] }),
    dto({ id: "T4", title: "Waits on a review", state: "waiting", log: [created(long), report("L2", long + minute, "waiting")] }),
    dto({ id: "T5", title: "Waits on a question", state: "doing", log: [created(long), asked("L2", long + minute)] }),
    dto({ id: "T6", title: "Finished earlier", state: "done", log: [created(long), report("L2", long + minute, "done")] }),
    dto({ id: "T7", title: "Stopped earlier", state: "stopped", log: [created(long), report("L2", long + minute, "stopped")] }),
    // Its question's record is not read yet: the row's ball still says the turn and when it began.
    dto({ id: "T8", title: "Asks before its record is read", state: "waiting", log: [created(long)] })],
  placements: [placed("P2", "T2"), ...["T4", "T5", "T6", "T7"].map(idle)],
  runs: [run("R2", { taskId: "T2", placementId: "P2", state: "running", createdAt: iso(now - 90 * minute), startedAt: iso(now - 90 * minute), endedAt: null }),
    ...["T4", "T5", "T6", "T7"].map(ended)],
  balls: { T4: userBall("review", "L2", iso(long + minute), { aboutRunId: "R4" }), T5: userBall("question", "L2", iso(long + minute), { questionId: "L2" }),
    T8: userBall("question", "Q8", iso(long + minute), { questionId: "Q8" }) },
  home: homeFixture([{ taskId: "T2", section: "doing" }, { taskId: "T3", section: "todo" }, { taskId: "T4", section: "review" }, { taskId: "T5", section: "review" }, { taskId: "T8", section: "review" },
    { taskId: "T6", section: "done" }, { taskId: "T7", section: "done" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  openGroup("finished");
  // On now, with all that happened to them off the screen's left.
  const { sheet, end } = laidOutSheet();
  sheet.scrollLeft = end();
  fireEvent.scroll(sheet);
  act(() => { vi.advanceTimersByTime(50); });
  for (const [row, kind, icon, word] of [["T3", "todo", "todo", "Not started"], ["T4", "turn", "review", "Awaiting review"], ["T5", "turn", "question", "Question"], ["T8", "turn", "question", "Question"],
    ["T6", "done", "done", "Completed"], ["T7", "stopped", "stopped", "Stopped"]] as const) {
    const edge = document.querySelector<SVGGElement>(`[data-row="${row}"] [data-edge="${kind}"]`)!;
    expect(edge.querySelector(`[data-icon="${icon}"]`), row).toBeTruthy();
    const written = edge.querySelector("text")!.textContent!;
    // The time, and "From" while it still holds: no state's word. Its day is "yesterday" or a date by the reader's zone.
    expect(written, row).toMatch(kind === "done" || kind === "stopped" ? /^(?:\S+ )?\d+:\d\d$/ : /^From (?:\S+ )?\d+:\d\d$/);
    expect(written, row).not.toContain(word);
    const time = /\d+:\d\d$/.exec(written)![0];
    // One name, from its title: an aria-label beside the same words would be heard again as a description.
    expect(edge.hasAttribute("aria-label"), row).toBe(false);
    const said = edge.querySelector("title")!.textContent!;
    expect(said, row).toContain(word);
    expect(said, row).toContain(time);
  }
});

test("an edge note rides with the strip while it scrolls or is held, and stands at the edge once it rests", () => {
  wideSheet();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(now);
  useTimeView.setState({ viewMs: 30 * minute });
  const data = served(tree({ tasks: [dto({ id: "T2", title: "Running", state: "doing", log: [created(now - 3 * 60 * minute)] }),
    dto({ id: "T3", title: "Still not started", state: "todo", log: [created(now - 7 * 60 * minute)] })],
  placements: [{ ...canonical.placements[0]!, id: "P2", taskId: "T2" }],
  runs: [run("R2", { taskId: "T2", placementId: "P2", state: "running", createdAt: iso(now - 3 * 60 * minute), startedAt: iso(now - 3 * 60 * minute), endedAt: null })],
  home: homeFixture([{ taskId: "T2", section: "doing" }, { taskId: "T3", section: "todo" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const { sheet, end } = laidOutSheet();
  // Scrolled as a browser scrolls, never past its ends.
  let left = 0;
  Object.defineProperty(sheet, "scrollLeft", { configurable: true, get: () => left, set: (value: number) => { left = Math.max(0, Math.min(value, end())); } });
  // The note's left on screen, from the strip's left edge: where it is drawn, moved by its transform, less the scroll.
  const onScreen = () => {
    const edge = document.querySelector<SVGGElement>('[data-row="T3"] [data-edge="todo"]')!;
    const shift = Number(/translateX\((-?[\d.e]+)px\)/.exec(edge.closest<HTMLElement>("[data-edge-layer]")!.style.transform)?.[1] ?? 0);
    return Number(edge.querySelector("[data-icon]")!.getAttribute("x")) + shift - sheet.scrollLeft;
  };
  const scrollTo = (left: number) => { sheet.scrollLeft = left; fireEvent.scroll(sheet); act(() => { vi.advanceTimersByTime(16); }); };
  scrollTo(end());
  act(() => { vi.advanceTimersByTime(200); });
  expect(onScreen()).toBeCloseTo(6, 0);
  expect(end()).toBeGreaterThan(300);
  // Scrolling, it goes with the time under it.
  scrollTo(end() - 150);
  scrollTo(end() - 300);
  expect(onScreen()).toBeCloseTo(306, 0);
  // A finger on the strip holds it there however long it stays still.
  fireEvent.touchStart(sheet, { touches: [{ clientX: 600, clientY: 10 }] });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(onScreen()).toBeCloseTo(306, 0);
  fireEvent.touchEnd(sheet, { touches: [] });
  act(() => { vi.advanceTimersByTime(100); });
  expect(onScreen()).toBeCloseTo(306, 0);
  // Let go and still, the strip rests: the note stands at its edge again.
  act(() => { vi.advanceTimersByTime(100); });
  expect(onScreen()).toBeCloseTo(6, 0);
  // So does a mouse pressed on the scroller (its scrollbar) until it is let go anywhere.
  fireEvent.pointerDown(sheet, { pointerType: "mouse", button: 0, pointerId: 1 });
  scrollTo(end() - 100);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(onScreen()).toBeCloseTo(-194, 0);
  fireEvent.pointerUp(window, { pointerType: "mouse", button: 0, pointerId: 1 });
  act(() => { vi.advanceTimersByTime(200); });
  expect(onScreen()).toBeCloseTo(6, 0);
  // A finger that began on something taken out of the page while it moved (a clock time scrolled away) still lets go:
  // its touchend goes only to that, never bubbling up to the scroller.
  const gone = document.createElementNS("http://www.w3.org/2000/svg", "text");
  document.querySelector("[data-time-clock]")!.append(gone);
  fireEvent.touchStart(gone, { touches: [{ clientX: 600, clientY: 10 }] });
  scrollTo(end() - 250);
  gone.remove();
  fireEvent.touchEnd(gone, { touches: [] });
  act(() => { vi.advanceTimersByTime(200); });
  expect(onScreen()).toBeCloseTo(6, 0);
  // Nor does a second finger put down off the list, lifted last, keep it held.
  fireEvent.touchStart(sheet, { touches: [{ clientX: 600, clientY: 10 }] });
  scrollTo(end() - 200);
  fireEvent.touchEnd(sheet, { touches: [{ clientX: 20, clientY: 20 }] });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(onScreen()).toBeCloseTo(-44, 0);
  fireEvent.touchEnd(document.body, { touches: [] });
  act(() => { vi.advanceTimersByTime(200); });
  expect(onScreen()).toBeCloseTo(6, 0);
  // A new axis at rest (a zoom) puts it at the edge at once, before any scroll could come.
  fireEvent.keyDown(sheet, { key: "-" });
  expect(onScreen()).toBeCloseTo(6, 0);
  // Modified wheels zoom the axis too; neither starts a native pan before the new axis is drawn.
  const strip = sheet.querySelector("[data-time-strip]")!;
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    fireEvent.wheel(strip, { ...modifier, deltaY: -40, clientX: 600 });
    expect(onScreen()).toBeCloseTo(6, 0);
  }
});

test("without zoom the clock uses the same width as an explicit twenty four hours", () => {
  const data = fixture();
  const first = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const defaultClock = document.querySelector("[data-time-clock]")?.outerHTML;
  first.unmount();
  useTimeView.setState({ viewMs: 24 * 60 * minute });
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  expect(document.querySelector("[data-time-clock]")?.outerHTML).toBe(defaultClock);
});

test("a recent branch keeps the twenty four hour axis and zero leaves five minutes before its first line", () => {
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  const start = () => Number(document.querySelector('[data-row="T1"] svg[data-time-strip] g g line')?.getAttribute("x1"));
  const nowX = () => Number(document.querySelector("[data-time-clock] line.stroke-ink")?.getAttribute("x1"));
  expect(start()).toBeGreaterThan(20);
  fireEvent.keyDown(sheet, { key: "0" });
  expect(start()).toBeGreaterThan(5);
});

test("zero and repeated minus reach a record older than ninety days", () => {
  const old = now - 150 * 24 * 60 * minute;
  const data = served(tree({
    tasks: [dto({ id: "T1", title: "Old records", log: [created(old)] })],
    placements: [{ ...canonical.placements[0]!, id: "P100", taskId: "T1" }],
    runs: [run("R100", { taskId: "T1", placementId: "P100", state: "running", createdAt: iso(old), startedAt: iso(old), endedAt: null })],
    home: homeFixture([{ taskId: "T1", section: "doing" }]),
  }));
  const { unmount } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const sheet = document.querySelector<HTMLElement>("[data-time-tree]")!;
  // Zero is all of time, kept as such: whatever zoom has all of the strip, the old record included, in sight.
  fireEvent.keyDown(sheet, { key: "0" });
  expect(useTimeView.getState().viewMs).toBe("all");
  expect(new URL(location.href).searchParams.get("zoom")).toBe("all");
  expect(sheet.querySelector<HTMLSelectElement>("[data-span]")!.value).toBe("all");
  unmount();
  useTimeView.setState({ viewMs: null });
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const again = document.querySelector<HTMLElement>("[data-time-tree]")!;
  for (let i = 0; i < 30; i++) fireEvent.keyDown(again, { key: "-" });
  expect(useTimeView.getState().viewMs).toBeGreaterThan(150 * 24 * 60 * minute);
});

test("a row waiting on you marks what it waits on alone, as your turn", () => {
  render(<TestWorkspace data={fixture({ parentResponsible: true })}><TimeTree /></TestWorkspace>);
  const marks = [...document.querySelectorAll('[data-row="T1"] [data-mark]')];
  expect(marks.map(mark => mark.getAttribute("aria-label"))).toEqual(["Your turn"]);
  const pin = marks[0]!;
  expect(pin.querySelector("text")).toBeNull();
  act(() => useTimeView.getState().hover("T1", "log:T1:L2"));
  // The pin's ring stays under its pill.
  expect(pin.querySelector("circle")?.getAttribute("r")).toBe("8");
});

test("the current review report uses an icon-only tag", () => {
  render(<TestWorkspace data={fixture({ parentResponsible: true })}><TimeTree /></TestWorkspace>);
  const pin = document.querySelector<SVGGElement>('[data-row="T1"] [data-pin="true"]')!;
  expect(pin.querySelector('[data-icon="review"]')).toBeTruthy();
  expect(pin.querySelector("rect")).toBeTruthy();
  expect(pin.querySelector(":scope > g > path")).toBeNull();
  expect(pin.querySelector("text")).toBeNull();
  expect(pin.querySelectorAll("circle")).toHaveLength(1);
  expect(pin.getAttribute("aria-label")).toBe("Your turn");
});

test("a current turn before the visible time stands at the left edge, as the row's ball says it", () => {
  const data = fixture({ parentResponsible: true });
  const task = data.tasks.find(item => item.id === "T1")!;
  const history = projectTimeHistory(timeHistoryBase(task, data.people, recordNotes(data.people, (task).id)), now)!;
  const marks = laneMarks(history);
  const line = lineOf(history, now, { x: at => at, from: history.start, to: now, width: 600 });
  const turn = rowTurn(task)!;
  expect(turn).toEqual({ at: now - 30 * minute, why: "review", key: logKey("T1", "L2") });
  const scale = { x: (at: number) => (at - turn.at) / minute * 10, from: history.start, to: now };
  expect(edgeOf(task, history, line.hands, marks, { from: turn.at + minute, to: now }, now, scale, turn)).toEqual({ side: "left", kind: "turn", turn });
  expect(edgeOf(task, history, line.hands, marks, { from: turn.at + minute / 2, to: now }, now, scale, turn)).toBeNull();
  expect(edgeOf(task, history, line.hands, marks, { from: turn.at, to: now }, now, scale, turn)).toBeNull();

  const picked = vi.fn(), shown = vi.fn();
  const { container } = render(<svg><TurnEdge turn={turn} x={14} y={15} onPick={picked} probe={{ show: shown, hide: vi.fn() }}
    words="From 10/11 11:30" heard="Awaiting acceptance · from 10/11 11:30" /></svg>);
  const label = container.querySelector<SVGGElement>('[data-edge="turn"]')!;
  expect(label.querySelector('[data-icon="review"]')).toBeTruthy();
  expect(label.querySelector("text")?.textContent).toBe("From 10/11 11:30");
  expect(label.querySelector("title")?.textContent).toBe("Awaiting acceptance · from 10/11 11:30");
  fireEvent.pointerEnter(label, { pointerType: "mouse", clientX: 14, clientY: 15 });
  expect(shown).toHaveBeenCalledWith(turn.key, turn.at);
  fireEvent.click(label);
  expect(picked).toHaveBeenCalledOnce();
});

test("the line takes the turn's colour from when the turn began to now, a question's as a review's", () => {
  const turn = rowTurn({ id: "T7", ball: userBall("question", "Q9", iso(now - 30 * minute), { questionId: "Q9" }) })!;
  expect(turn).toMatchObject({ at: now - 30 * minute, why: "question" });
  const scale = { x: (at: number) => 200 + (at - now) / minute * 3, from: now - 60 * minute, to: now, width: 200 };
  for (const wait of [null, "review"] as const) {
    const { container } = render(<svg><Lane turnFrom={turn.at} line={{ stretches: [{ from: now - 60 * minute, to: now, count: 0, wait, peak: 0, merged: 0 }], hands: [], waits: [], drops: false }}
      marks={[]} scale={scale} level={{ height: 40, base: 20, unit: 8, rise: 14 }} now={now} finish={null} onPick={() => {}} /></svg>);
    const turnLines = [...container.querySelectorAll("line.text-turn-line")];
    expect(turnLines.map(line => [Number(line.getAttribute("x1")), Number(line.getAttribute("x2"))])).toEqual([[scale.x(turn.at), scale.x(now)]]);
    expect(container.querySelector("line:not(.text-turn-line)")?.getAttribute("x2")).toBe(String(scale.x(turn.at)));
    cleanup();
  }
});

test("a turn tag sits on the time it was reported, even just before now, and may reach into the future band", () => {
  const data = fixture();
  const history = projectTimeHistory(timeHistoryBase(data.tasks.find((task) => task.id === "T2")!, data.people, recordNotes(data.people, (data.tasks.find((task) => task.id === "T2")!).id)), now)!;
  const event = history.events.find((each) => each.source.log?.kind === "reported")!;
  const scale = { x: (at: number) => 200 + (at - now) / minute * 3, from: now - 60 * minute, to: now + 30 * minute, width: 324 };
  const tagAt = (at: number) => {
    const container = render(<svg><Lane turnFrom={null} line={{ stretches: [], hands: [], waits: [], drops: false }}
      marks={[{ event: { ...event, at, source: { ...event.source, yours: true } },
        display: "pin" }]} scale={scale} level={{ height: 40, base: 20, unit: 8, rise: 14 }} now={now}
      finish={null} onPick={() => {}} /></svg>).container;
    const rect = container.querySelector("[data-pin] rect")!;
    cleanup();
    return Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) / 2;
  };
  // A report a minute before now (3px) is drawn there, not pushed left before the run that wrote it.
  expect(tagAt(now - minute)).toBe(scale.x(now - minute));
  expect(tagAt(now)).toBe(scale.x(now));
  expect(tagAt(now - 60 * minute)).toBe(scale.x(now - 60 * minute));
});

test("a question tag uses the question icon", () => {
  const task = dto({ state: "doing", log: [created(now - 30 * minute), asked("L2", now - 10 * minute)] });
  render(<TestWorkspace data={served(tree({ tasks: [task], placements: [{ ...canonical.placements[0]!, taskId: "T1" }],
    balls: { T1: userBall("question", "L2", iso(now - 10 * minute), { questionId: "L2" }) },
    home: homeFixture([{ taskId: "T1", section: "review" }]) }))}><TimeTree /></TestWorkspace>);
  expect(document.querySelector('[data-row="T1"] [data-pin="true"] [data-icon="question"]')).toBeTruthy();
});

test("a press on a stretch opens its last authored report, though no report is marked", () => {
  const first = { ...report("L2", now - 15 * minute, "doing"), title: "First report" };
  const later = { ...report("L3", now - 14 * minute, "doing"), title: "Second report" };
  const task = dto({ state: "doing", log: [created(now - 30 * minute), first, later] });
  const work = run("R1", { state: "running", startedAt: iso(now - 20 * minute), endedAt: null });
  const data = served(tree({ tasks: [task], runs: [work], placements: [canonical.placements[0]!] }));
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, (data.tasks[0]!).id)), now)!;
  const scale = { x: (time: number) => (time - (now - 30 * minute)) / minute * 10,
    from: now - 30 * minute, to: now, width: 300 };
  const line = lineOf(history, now, scale);
  const pointed = now - 14.5 * minute;
  // Neither report has a mark on the line; a press on the line still reads the last one.
  expect(laneMarks(history)).toEqual([]);
  expect(stretchReport(line.stretches, lineReports(history), pointed, now)?.event.key).toBe("log:T1:L3");
});

test("a press where only the work under the task went on opens no report from before it", () => {
  const earlier = { ...report("L2", now - 60 * minute, "doing"), title: "Started" };
  const data = served(tree({ tasks: [dto({ state: "doing", log: [created(now - 90 * minute), earlier] })], placements: [canonical.placements[0]!] }));
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, "T1"),
    [["R9", now - 20 * minute, now - 5 * minute]]), now)!;
  const scale = { x: (time: number) => (time - (now - 90 * minute)) / minute * 10, from: now - 90 * minute, to: now, width: 900 };
  const line = lineOf(history, now, scale);
  expect(line.stretches.find(each => each.count === 1)).toMatchObject({ from: now - 20 * minute, to: now - 5 * minute });
  expect(stretchReport(line.stretches, lineReports(history), now - 10 * minute, now)).toBeUndefined();
});

test("a question waiting on you keeps the only mark when the task stopped after it", () => {
  const question = asked("L2", now - 20 * minute);
  const stop = logEntry({ id: "LENDR1", kind: "linked", at: iso(now - 20 * minute + 6000), fromState: "doing", toState: "error" });
  const data = served(tree({ tasks: [dto({ id: "T1", state: "error", log: [created(now - 30 * minute), question, stop] })],
    placements: [{ ...canonical.placements[0]!, taskId: "T1" }],
    balls: { T1: userBall("question", "L2", question.at, { questionId: "L2" }) } }));
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, "T1")), now)!;
  expect(laneMarks(history).map(mark => [mark.event.key, mark.display])).toEqual([["log:T1:L2", "pin"]]);
  expect(history.segments.at(-1)?.kind).toBe("stuck");
});

test.each([
  ["progress", report("L2", now - 20 * minute, "doing")],
  ["a comment", logEntry({ id: "L2", kind: "reported", at: iso(now - 20 * minute), title: "A note", actor: { kind: "placement", placementId: "P1" }, fromState: null, toState: null })],
  ["a report that waits on no one yet", report("L2", now - 20 * minute, "waiting")],
  ["a question asked of a parent", { ...asked("L2", now - 20 * minute), askedTo: "T9" }],
  ["an urgent report", logEntry({ id: "L2", kind: "reported", at: iso(now - 20 * minute), title: "Disk is full", urgentReason: "Disk is full", actor: { kind: "placement", placementId: "P1" }, fromState: null, toState: null })],
])("%s is not marked: the row has nothing to tell you there", (_name, entry) => {
  const tasks = [dto({ id: "T1", state: "doing", log: [created(now - 30 * minute), entry] })];
  render(<TestWorkspace data={served(tree({ tasks, placements: [{ ...canonical.placements[0]!, taskId: "T1" }],
    home: homeFixture([{ taskId: "T1", section: "doing" }]) }))}><TimeTree /></TestWorkspace>);
  expect(document.querySelector('[data-row="T1"] [data-mark]')).toBeNull();
});

test("a stop is marked in red at the record that stopped the task, only while it is stopped", () => {
  const stop = logEntry({ id: "LENDR1", kind: "linked", at: iso(now - 10 * minute), fromState: "doing", toState: "error" });
  const data = served(tree({ tasks: [dto({ id: "T1", state: "error", log: [created(now - 30 * minute), stop] })],
    placements: [{ ...canonical.placements[0]!, taskId: "T1" }], home: homeFixture([{ taskId: "T1", section: "error" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const mark = document.querySelector('[data-row="T1"] [data-mark="log:T1:LENDR1"]')!;
  expect(mark.getAttribute("aria-label")).toBe("Error");
  expect(mark.querySelector('[data-icon="error"]')).toBeTruthy();
  cleanup();
  const again = logEntry({ id: "L3", kind: "linked", at: iso(now - 5 * minute), fromState: "error", toState: "doing" });
  render(<TestWorkspace data={served(tree({ tasks: [dto({ id: "T1", state: "doing", log: [created(now - 30 * minute), stop, again] })],
    placements: [{ ...canonical.placements[0]!, taskId: "T1" }], home: homeFixture([{ taskId: "T1", section: "doing" }]) }))}><TimeTree /></TestWorkspace>);
  expect(document.querySelector('[data-row="T1"] [data-mark]')).toBeNull();
});

test("a stop by a failed Run is marked at the Run's own record, and a member's failure is not", () => {
  const stop = logEntry({ id: "LENDR1", kind: "linked", at: iso(now - 10 * minute), fromState: "doing", toState: "error", runId: "R1" });
  const events = [{ id: "R1", kind: "error" as const, taskId: "T1", fromChild: false, at: iso(now - 10 * minute), state: null, by: null, title: "exit", summary: "" },
    { id: "R2", kind: "error" as const, taskId: "T1", fromChild: false, at: iso(now - 20 * minute), state: null, by: null, title: "exit", summary: "" }];
  const data = served(tree({ tasks: [dto({ id: "T1", state: "error", log: [created(now - 30 * minute), stop] })],
    runs: [run("R1", { taskId: "T1", state: "failed", startedAt: iso(now - 12 * minute), endedAt: iso(now - 10 * minute) }),
      run("R2", { taskId: "T1", state: "failed", startedAt: iso(now - 22 * minute), endedAt: iso(now - 20 * minute) })] }));
  const base = timeHistoryBase(data.tasks[0]!, data.people, events.map(event => timelineNoteOf(event)))!;
  const history = projectTimeHistory(base, now)!;
  expect(laneMarks(history).map(mark => mark.event.key)).toEqual(["run:R1:finished"]);
});

test("marks come from the list alone: opening the time sheet reads no task's detail", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 404 }));
  const reviewed = report("L2", now - 20 * minute, "waiting");
  const tasks = [dto({ id: "T2", title: "Waiting", state: "waiting", log: [created(now - 30 * minute), reviewed] })];
  const data = served(tree({ tasks, placements: [{ ...canonical.placements[0]!, taskId: "T2" }],
    balls: { T2: userBall("review", "L2", reviewed.at, { aboutRunId: "R1" }) },
    home: homeFixture([{ taskId: "T2", section: "review" }]) }));
  const seed = data.seed;
  data.seed = () => { seed(); queryClient.removeQueries({ queryKey: ["task"] }); };
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  await act(async () => { await Promise.resolve(); });
  expect(fetcher.mock.calls.map(([input]) => String(input)).filter(url => url.includes("task/view"))).toEqual([]);
  expect(document.querySelector('[data-mark="log:T2:L2"]')?.getAttribute("aria-label")).toBe("Your turn");
});

test("a finished task marks where it finished, not the report before it", () => {
  const reviewed = { ...report("L2", now - 20 * minute, "waiting"), description: "Preview body" };
  const approved = logEntry({ id: "L3", kind: "review_approved", at: iso(now - 18 * minute), title: null, fromState: "waiting", toState: "done" });
  const task = dto({ id: "T5", title: "Finished", state: "done", log: [created(now - 60 * minute), reviewed, approved] });
  const data = served(tree({ tasks: [task], placements: [{ ...canonical.placements[0]!, taskId: "T5" }],
    home: homeFixture([{ taskId: "T5", section: "done" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  openGroup("finished");
  const drawn = [...document.querySelectorAll('[data-row="T5"] [data-mark]')];
  expect(drawn.map(mark => mark.getAttribute("data-mark"))).toEqual(["log:T5:L3"]);
  expect(drawn[0]?.querySelector("[data-icon='done']")).toBeTruthy();
});

test("the reader moving puts the list's pointing away, also when it has drawn no card yet", () => {
  // A time with nothing to say draws no card, but is still pointed at: data arriving later would draw one.
  act(() => useProbe.getState().set({ place: "list", row: "T1", at: now }));
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  expect(useProbe.getState().probe).toBeNull();
  act(() => useProbe.getState().set({ place: "list", row: "T1", at: now }));
  act(() => useViewStore.getState().openTask("T2", { reader: true }));
  expect(useProbe.getState().probe).toBeNull();
});

test("the marks are the records the server sends the time view as notes: one it does not send is not marked", () => {
  const stand = report("L3", now - 20 * minute, "waiting");
  const tasks = [dto({ id: "T1", title: "Parent", state: "waiting", log: [created(now - 60 * minute), stand] })];
  const data = served(tree({ tasks, placements: [{ ...canonical.placements[0]!, taskId: "T1" }],
    balls: { T1: userBall("review", "L3", stand.at, { aboutRunId: "R1" }) } }));
  const lane = (only: string[]) => laneMarks(projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, "T1", only)), now)!);
  expect(lane(["L3"]).map(mark => mark.event.key)).toEqual(["log:T1:L3"]);
  expect(lane([])).toEqual([]);
});

test("a failure is keyed as the record it is: a Run's end, or the log entry that put the Task into error", () => {
  expect(eventKey({ kind: "error", taskId: "T1", id: "R4", state: null })).toBe("run:R4:finished");
  expect(eventKey({ kind: "error", taskId: "T1", id: "LENDR4", state: "error" })).toBe(logKey("T1", "LENDR4"));
});
