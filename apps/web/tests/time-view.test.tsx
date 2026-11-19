import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, onTestFinished, test, vi } from "vitest";
import { projectTimeHistory, timeHistoryBase } from "../src/domain/time-history";
import { TimeTree, timelineWindow } from "../src/features/tree/TimeTree";
import { laneMarks, lineReports, stretchReport, type MarkAt } from "../src/features/tree/time-line";
import { useTimeView } from "../src/state/time-view";
import { useViewStore } from "../src/state/view-store";
import * as tone from "../src/components/ui/tone";
import * as motion from "../src/lib/motion";
import * as usage from "../src/domain/usage";
import * as timePeople from "../src/features/tree/time-people";
import * as timeLine from "../src/features/tree/time-line";
import { TestWorkspace, dto, homeFixture, logEntry, narrowScreen, run, tree } from "./fixtures";
import { recordNotes, timeHistory } from "./time-history-fixture";
import { queryClient } from "../src/data/query-client";
import { setupTimeView, canonical, minute, iso, now, created, report, fixture, served } from "./time-view-fixture";

setupTimeView();

/** Rest longer than the former card delay to detect delayed hover work. */
function restOnTitle(label: Element) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.pointerEnter(label, { pointerType: "mouse" });
  act(() => vi.advanceTimersByTime(600));
  vi.useRealTimers();
}

test("a visible timeline window keeps its query through small axis shifts and refreshes after zoom", () => {
  const first = timelineWindow(null, { from: 100 * minute, to: 200 * minute });
  expect(timelineWindow(first, { from: 101 * minute, to: 198 * minute })).toBe(first);
  expect(timelineWindow(first, { from: 102 * minute, to: 201 * minute })).toBe(first);
  expect(timelineWindow(first, { from: 130 * minute, to: 160 * minute })).not.toBe(first);
});

test("a hold is the line's quiet stretch alone: the row and its section say it, and you set it", () => {
  const task = dto({ state: "held", log: [created(now - 60 * minute),
    logEntry({ id: "L2", kind: "reported", at: iso(now - 20 * minute), actor: { kind: "human" },
      fromState: "todo", toState: "waiting" }),
    logEntry({ id: "L3", kind: "reported", at: iso(now - 10 * minute), actor: { kind: "human" },
      fromState: "waiting", toState: "held" })] });
  const data = served(tree({ tasks: [task] }));
  const history = projectTimeHistory(timeHistoryBase(data.tasks[0]!, data.people, recordNotes(data.people, (data.tasks[0]!).id)), now)!;
  expect(history.segments.at(-1)?.kind).toBe("held");
  expect(laneMarks(history)).toEqual([]);
});

test("a time row outside the viewport keeps its strip width and draws when it enters", () => {
  let notify: IntersectionObserverCallback = () => {};
  class ViewObserver {
    constructor(callback: IntersectionObserverCallback) { notify = callback; }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", ViewObserver);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  const row = document.querySelector<HTMLElement>('[data-row="T2"]')!;
  const strip = () => row.querySelector<SVGSVGElement>("svg[data-time-strip]")!;
  expect(strip().children.length).toBeGreaterThan(0);
  const width = strip().getAttribute("width");
  const entry = (isIntersecting: boolean) => ({ target: row, isIntersecting } as unknown as IntersectionObserverEntry);
  act(() => notify([entry(false)], {} as IntersectionObserver));
  expect(strip().getAttribute("width")).toBe(width);
  expect(strip().children.length).toBe(0);
  act(() => notify([entry(true)], {} as IntersectionObserver));
  expect(strip().children.length).toBeGreaterThan(0);
});

test("every task state keeps its times while title and mark hover fetch no detail", async () => {
  const states = ["todo", "doing", "waiting", "held", "error", "done", "stopped"] as const;
  const tasks = states.map((state, index) => dto({ id: `T${index + 1}`, title: state, state,
    log: [created(now - 30 * minute), report("L2", now - 10 * minute, state)] }));
  const data = served(tree({ tasks, home: homeFixture(tasks.map(task => ({ taskId: task.id,
    section: task.state === "done" || task.state === "stopped" ? "done" : task.state === "todo" ? "todo"
      : task.state === "held" ? "held" : "doing" }))) }));
  const fetch = vi.spyOn(globalThis, "fetch");
  const prefetch = vi.spyOn(queryClient, "prefetchQuery");
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  for (const section of ["held", "done"]) fireEvent.click(document.querySelector(`[data-section="${section}"] button`)!);
  const detailReads = () => fetch.mock.calls.filter(([input]) => /\/task\/(view|history|request|reply)/.test(String(input instanceof Request ? input.url : input)));
  const before = detailReads().length;
  for (const task of tasks) {
    const row = document.querySelector<HTMLElement>(`[data-row="${task.id}"]`)!;
    const label = row.querySelector<HTMLElement>("[data-row-label]")!;
    const title = row.querySelector<HTMLElement>("[data-read]")!;
    const marks = [...row.querySelectorAll<SVGGElement>("[data-mark]")];
    expect(marks.length).toBe(task.state === "done" || task.state === "error" ? 1 : 0);
    const icon = label.querySelector("[data-icon]")!.outerHTML;
    const time = row.querySelector("[data-row-status]")?.textContent;
    restOnTitle(label);
    fireEvent.focus(title);
    for (const mark of marks) {
      fireEvent.pointerEnter(mark, { pointerType: "mouse" });
      fireEvent.focus(mark);
      expect(document.querySelector("[data-reading-note]")).toBeNull();
    }
    expect(label.querySelector("[data-icon]")!.outerHTML).toBe(icon);
    expect(row.querySelector("[data-row-status]")?.textContent).toBe(time);
    expect(document.querySelector("[data-reading-note]")).toBeNull();
    fireEvent.click(title);
    expect(useViewStore.getState()).toMatchObject({ selected: task.id, reader: { pane: "task", open: true } });
  }
  await act(async () => { await Promise.resolve(); });
  expect(detailReads()).toHaveLength(before);
  expect(prefetch.mock.calls.filter(([options]) => options.queryKey[0] === "task-view")).toHaveLength(0);
});

test("the title column does not open a hover card on narrow screens", () => {
  const phone = narrowScreen(true);
  try {
    render(<TestWorkspace data={fixture({ parentResponsible: true })}><TimeTree /></TestWorkspace>);
    const label = document.querySelector<HTMLElement>('[data-row="T1"] [data-row-label]')!;
    restOnTitle(label);
    label.querySelector<HTMLElement>('[data-read="T1"]')!.focus();
    expect(screen.queryByRole("tooltip")).toBeNull();
  } finally { phone.restore(); }
});

test("a desktop working row gives its width to the title and keeps its row layout without cards", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  useTimeView.setState({ viewMs: minute }); // Its report is outside the visible part of the strip.
  const work = dto({ id: "T2", title: "With estimate", state: "doing", log: [created(now - 30 * minute),
    { ...report("L2", now - 5 * minute, "doing"), runId: "R1" }] });
  const emptyTask = dto({ id: "T3", title: "No report", state: "doing", log: [created(now - 20 * minute)] });
  const placement = { ...canonical.placements[0]!, id: "P1", taskId: "T2", active: true, endedAt: null };
  const emptyPlacement = { ...placement, id: "P2", taskId: "T3" };
  const data = served(tree({ tasks: [work, emptyTask], placements: [placement, emptyPlacement], runs: [run("R1", {
    taskId: "T2", placementId: "P1", state: "running", startedAt: iso(now - 20 * minute), endedAt: null }), run("R2", {
    taskId: "T3", placementId: "P2", state: "running", startedAt: iso(now - 20 * minute), endedAt: null,
    activity: { at: iso(now - minute), kind: "tool_end", toolName: "Bash", doing: null, note: { at: iso(now - minute), text: "Current work note" } } })],
    home: homeFixture([{ taskId: "T2", section: "doing" }, { taskId: "T3", section: "doing" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const empty = document.querySelector<HTMLElement>('[data-row="T3"] [data-row-label]')!;
  expect(empty.querySelector("[data-slim-words]")).toBeNull();
  restOnTitle(empty);
  expect(document.querySelector("[data-reading-note]")).toBeNull();
  const row = document.querySelector<HTMLElement>('[data-row="T2"]')!;
  const title = row.querySelector<HTMLElement>('[data-read="T2"]')!;
  // The id and the title, then the row's one time at its end.
  expect(title.textContent).toMatch(/^T2With estimate/);
  expect(title.querySelector("[data-row-title]")?.className).toContain("flex-1");
  const end = row.querySelector("[data-row-end]")!;
  expect(end.querySelector("[data-row-status]")).toBeTruthy();
  expect(title.contains(end)).toBe(false);
  expect(title.getAttribute("aria-describedby")).toBe(end.id);
  expect(row.querySelector("[data-slim-words], [data-slim-state]")).toBeNull();
  restOnTitle(row.querySelector("[data-row-label]")!);
  expect(lineReports(projectTimeHistory(timeHistoryBase(data.tasks.find(item => item.id === "T2")!, data.people, recordNotes(data.people, (data.tasks.find(item => item.id === "T2")!).id)), now)).at(-1)?.event.key).toBe("log:T2:L2");
  expect(document.querySelector("[data-reading-note]")).toBeNull();
});

test("latest marks keep the descending time and key order, with the first candidate winning equal keys", () => {
  const data = fixture({ parentResponsible: true });
  const task = data.tasks.find(item => item.id === "T1")!;
  const event = timeHistory(task, data.people, now)!.events[0]!;
  const mark = (key: string, at: number): MarkAt => ({ event: { ...event, key, at }, display: "pin" });
  const older = mark("z", now - minute), lowerKey = mark("a", now), winner = mark("z", now), equal = mark("z", now);
  const marks = [lowerKey, older, winner, equal];
  const stretches = [{ from: now - minute, to: now, count: 1, wait: null, peak: 1, merged: 0 }];
  expect(stretchReport(stretches, marks, now, now)).toBe(winner);
  expect(marks).toEqual([lowerKey, older, winner, equal]);
  expect(stretchReport(stretches, [], now, now)).toBeUndefined();
});

test("a phone list projects chronology and histories only while Time is shown and resumes at the current clock", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  const phone = narrowScreen(true);
  try {
    useTimeView.setState({ strips: false });
    const projection = vi.spyOn(timePeople, "projectTimePeople");
    const bases = vi.spyOn(timePeople, "timeHistoryBases");
    const histories = vi.spyOn(timePeople, "timeHistories");
    render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(projection).not.toHaveBeenCalled();
    expect(bases).not.toHaveBeenCalled();
    expect(histories).not.toHaveBeenCalled();
    expect(document.querySelector("[data-time-strip]")).toBeNull();

    act(() => { useTimeView.setState({ strips: true }); });
    expect(projection).toHaveBeenCalled();
    expect(bases).toHaveBeenCalled();
    expect(histories.mock.calls.at(-1)?.[1]).toBe(now + 30_000);
    const firstBase = bases.mock.results.at(-1)!.value;
    const firstPeople = projection.mock.results.at(-1)!.value.timePeople;
    expect(document.querySelector("[data-time-strip]")).not.toBeNull();

    act(() => { useTimeView.setState({ strips: false }); });
    projection.mockClear();
    bases.mockClear();
    histories.mockClear();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(projection).not.toHaveBeenCalled();
    expect(bases).not.toHaveBeenCalled();
    expect(histories).not.toHaveBeenCalled();
    act(() => { useTimeView.setState({ strips: true }); });
    expect(projection.mock.results.at(-1)!.value.timePeople.tasks.get("T1")).toBe(firstPeople.tasks.get("T1"));
    expect(histories.mock.calls.at(-1)?.[1]).toBe(now + 60_000);
    expect(bases.mock.results.at(-1)!.value.get("T1")).toBe(firstBase.get("T1"));
    expect(histories.mock.results.at(-1)!.value.get("T1")).toEqual(timePeople.timeHistories(firstBase, now + 60_000, new Map()).get("T1"));
  } finally { phone.restore(); }
});

test("a hidden Time projection leaves live row updates subscribed and reopens with the latest chronology", () => {
  const phone = narrowScreen(true);
  try {
    useTimeView.setState({ strips: false });
    const projection = vi.spyOn(timePeople, "projectTimePeople");
    const work = dto({ id: "T2", title: "Live work", state: "doing", log: [created(now - 30 * minute)] });
    const placement = { ...canonical.placements[0]!, id: "P1", taskId: "T2", active: true, endedAt: null };
    const running = run("R1", { taskId: "T2", placementId: "P1", state: "running", startedAt: iso(now - 20 * minute), endedAt: null });
    const data = (current: typeof running) => served(tree({ tasks: [work], placements: [placement], runs: [current],
      home: homeFixture([{ taskId: "T2", section: "doing" }]) }));
    const initial = data(running);
    const view = render(<TestWorkspace data={initial}><TimeTree /></TestWorkspace>);
    const time = () => document.querySelector('[data-row="T2"] [data-row-status]')?.textContent;
    expect(time()).toBe("20m");
    const latest = data({ ...running, state: "succeeded", endedAt: iso(now - 5 * minute) });
    view.rerender(<TestWorkspace data={latest}><TimeTree /></TestWorkspace>);
    expect(time()).toBe("15m");
    expect(projection).not.toHaveBeenCalled();
    act(() => { useTimeView.setState({ strips: true }); });
    expect(projection.mock.calls.at(-1)?.[0]).toBe(latest.people);
    expect(projection.mock.results.at(-1)!.value.timePeople.runsByTask.get("T2")?.find((run: { id: string }) => run.id === "R1")?.endedAt).toBe(iso(now - 5 * minute));
  } finally { phone.restore(); }
});

test("a phone list collects future labels only while Time is shown and uses the current clock on return", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  const phone = narrowScreen(true);
  try {
    useTimeView.setState({ strips: false });
    const labels = vi.spyOn(timeLine, "futureWords");
    render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(labels).not.toHaveBeenCalled();
    expect(document.querySelector("[data-time-strip]")).toBeNull();
    expect(screen.getByText("With estimate")).toBeTruthy();

    act(() => { useTimeView.setState({ strips: true }); });
    expect(labels.mock.calls.length).toBeGreaterThan(0);
    expect(labels.mock.calls.every(([, clock]) => clock === now + 30_000)).toBe(true);
    expect(document.querySelector("[data-future-label]")).not.toBeNull();

    act(() => { useTimeView.setState({ strips: false }); });
    labels.mockClear();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(labels).not.toHaveBeenCalled();
    expect(document.querySelector("[data-time-strip]")).toBeNull();
    act(() => { useTimeView.setState({ strips: true }); });
    expect(labels.mock.calls.length).toBeGreaterThan(0);
    expect(labels.mock.calls.every(([, clock]) => clock === now + 60_000)).toBe(true);
    expect(document.querySelector("[data-future-label]")).not.toBeNull();
  } finally { phone.restore(); }
});

test("a clock tick updates time strips without redrawing the row controls", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  const row = vi.spyOn(motion, "useTint");
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  expect(row.mock.calls.length).toBeGreaterThan(0);
  row.mockClear();
  act(() => { vi.advanceTimersByTime(30_000); });
  expect(row).not.toHaveBeenCalled();
});

test("a clock tick on a phone redraws a row's time and notes, not its lines or press", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  const phone = narrowScreen(true);
  try {
    const lines = vi.spyOn(tone, "useStateLook");
    render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
    const time = () => document.querySelector('[data-row="T2"] [data-row-status]')?.textContent;
    expect(time()).toBe("20m");
    lines.mockClear();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(time()).toBe("21m");
    expect(lines).not.toHaveBeenCalled();
  } finally { phone.restore(); }
});

test("a running parent advances its subtree time on clock ticks without preparing work time again", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(now));
  const prepare = vi.spyOn(usage, "taskWorkTime");
  const empty = { runs: 0, runMs: 0, tokens: null, tokensUnknown: 0 };
  const placement = { ...canonical.placements[0]!, id: "P1", taskId: "T1",
    runtime: { ...canonical.placements[0]!.runtime, sourceRunIds: ["R1"], since: iso(now - 2 * minute) } };
  const data = served(tree({ tasks: [dto({ id: "T1", userRequested: true }), dto({ id: "T11", parentId: "T1" })],
    placements: [placement], home: homeFixture([{ taskId: "T1", section: "doing" }]),
    usage: { T1: { usage: empty, usageBelow: empty, runsBelow: [["R906", now - 3 * minute]] } },
    runs: [run("R1", { taskId: "T1", placementId: "P1", state: "running", startedAt: iso(now - 2 * minute), endedAt: null }),
      run("R2", { taskId: "T11", state: "running", startedAt: iso(now - 3 * minute), endedAt: null })] }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const time = () => document.querySelector('[data-row="T1"] [data-row-status]')?.textContent;
  expect(time()).toBe("5m");
  expect(prepare.mock.calls.some(([id]) => id === "T1")).toBe(true);
  const calls = prepare.mock.calls.length;
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(time()).toBe("7m");
  expect(prepare).toHaveBeenCalledTimes(calls);
});
