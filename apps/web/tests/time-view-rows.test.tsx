import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, onTestFinished, test, vi } from "vitest";
import { logKey } from "../src/domain/history";
import { TONE } from "../src/components/ui/tone";
import { finishWords, type FinishWords } from "../src/domain/finish-words";
import { i18n } from "@alpacawork/i18n";
import { formatClock } from "../src/domain/time";
import { projectTimeHistory, timeHistoryBase, type TaskHistory } from "../src/domain/time-history";
import { TimeTree } from "../src/features/tree/TimeTree";
import { compactMark, futureBandWidth, futureWords, Lane, laneMarks, lineOf } from "../src/features/tree/time-line";
import { useViewStore } from "../src/state/view-store";
import { queryClient } from "../src/data/query-client";
import { indexKey, resources } from "../src/data/resources";
import { TestWorkspace, dto, homeFixture, indexOf, logEntry, narrowScreen, decideItem, questionFixture, run, screenData, taskFixture, tree, userBall } from "./fixtures";
import { recordNotes, timeHistory } from "./time-history-fixture";
import { setupTimeView, canonical, minute, iso, now, created, report, asked, fixture, openGroup, served } from "./time-view-fixture";

setupTimeView();

test("a future band follows the reader's text size, read once and again only when it changes", async () => {
  const was = document.documentElement.style.fontSize, Observer = globalThis.ResizeObserver;
  const sizes: ResizeObserverCallback[] = [];
  onTestFinished(() => { document.documentElement.style.fontSize = was; globalThis.ResizeObserver = Observer; vi.resetModules(); });
  globalThis.ResizeObserver = class { constructor(changed: ResizeObserverCallback) { sizes.push(changed); } observe() {} unobserve() {} disconnect() {} } as never;
  vi.resetModules();
  const { futureBandWidth: bandWidth } = await import("../src/features/tree/time-line");
  document.documentElement.style.fontSize = "16px";
  const normal = bandWidth([{ text: "長い予定時刻の表示", days: 0 }]);
  const measure = vi.spyOn(globalThis, "getComputedStyle");
  expect(bandWidth(Array(200).fill({ text: "長い予定時刻の表示", days: 0 }))).toBe(normal);
  expect(measure).not.toHaveBeenCalled();
  document.documentElement.style.fontSize = "24px";
  for (const changed of sizes) changed([], {} as ResizeObserver);
  expect(bandWidth([{ text: "長い予定時刻の表示", days: 0 }])).toBeGreaterThan(normal);
});

test("recorded intervals keep their identity while only open endpoints follow the clock", () => {
  const task = dto({ log: [created(now - 30 * minute)] });
  const ended = run("R1", { state: "succeeded", startedAt: iso(now - 20 * minute), endedAt: iso(now - 10 * minute) });
  const running = run("R2", { state: "running", startedAt: iso(now - 5 * minute), endedAt: null });
  const settled = served(tree({ tasks: [task], runs: [ended] }));
  const settledBase = timeHistoryBase(settled.tasks[0]!, settled.people, recordNotes(settled.people, (settled.tasks[0]!).id))!;
  expect(projectTimeHistory(settledBase, now)).toBe(projectTimeHistory(settledBase, now + minute));
  const active = served(tree({ tasks: [task], runs: [ended, running] }));
  const activeBase = timeHistoryBase(active.tasks[0]!, active.people, recordNotes(active.people, (active.tasks[0]!).id))!;
  expect(projectTimeHistory(activeBase, now + minute)!.segments).toContainEqual(expect.objectContaining({
    from: now - 5 * minute, to: now + minute, kind: "work" }));
});

test("the current done transition sets the history end", () => {
  const finishedAt = now - 10 * minute;
  const task = dto({ state: "done", log: [created(now - 30 * minute), report("Ldone", finishedAt, "done")] });
  const data = served(tree({ tasks: [task] }));
  expect(timeHistory(data.tasks[0]!, data.people, now)?.end).toBe(finishedAt);
});

test("time line uses History's recorded keys and shared mark meanings", () => {
  const data = fixture();
  const task = data.tasks.find((item) => item.id === "T1")!;
  const line = timeHistory(task, data.people, now)!;
  // The line draws from the index (state, estimate and review entries, runs): History's keys, fewer of them.
  const recorded = new Set([
    ...task.stateLog.map(log => logKey(task.id, log.id)),
    ...(data.people.runsByTask.get(task.id) ?? []).flatMap(run => ["accepted", "started", "finished"]
      .map(phase => `run:${run.id}:${phase}`)),
  ]);
  expect(line.events.every(event => recorded.has(event.key))).toBe(true);
  // The report T1's review waits on is the mark itself, in your turn's colour: no mark is made up for the wait.
  expect(compactMark(line.events.find((event) => event.key === "log:T1:L2")!)).toEqual({ kind: "report", tone: "turn" });
  expect(laneMarks(line).map(mark => compactMark(mark.event))).toEqual([{ kind: "report", tone: "turn" }]);
  expect(line.segments).toContainEqual(expect.objectContaining({ from: now - 30 * minute, to: now, kind: "review" }));
  expect(timeHistory(data.tasks.find((item) => item.id === "T2")!, data.people, now)!.segments)
    .toContainEqual(expect.objectContaining({ from: now - 20 * minute, to: now, kind: "work" }));

});

test("a question asked of you is its record's mark, pinned in your turn's colour; the task works on, so no wait is drawn", () => {
  const task = taskFixture({ state: "doing", log: [created(now - 30 * minute), asked("L2", now - 10 * minute)],
    ball: userBall("question", "L2", iso(now - 10 * minute), { questionId: "L2" }) });
  const data = served(tree({ tasks: [task], home: homeFixture([{ taskId: "T1", section: "review" }]) }));
  const line = timeHistory(data.tasks[0]!, data.people, now)!;
  expect(compactMark(line.events.find((event) => event.key === "log:T1:L2")!)).toEqual({ kind: "report", tone: "turn" });
  expect(laneMarks(line).map(mark => [compactMark(mark.event), mark.display])).toEqual([[{ kind: "report", tone: "turn" }, "pin"]]);
  expect(line.segments.filter((segment) => segment.kind !== "work" && segment.kind !== "member")).toEqual([]);
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  expect(document.querySelector(`[data-row="T1"] [data-pin] g.${TONE.turn}`)).toBeTruthy();
});

test("a wait that is not your turn is a review all the same, drawn quietly", () => {
  const task = dto({ state: "waiting", log: [created(now - 30 * minute),
    { ...report("L2", now - 10 * minute, "waiting") }] });
  const data = served(tree({ tasks: [task], home: homeFixture([{ taskId: "T1", section: "doing" }]) }));
  const line = timeHistory(data.tasks[0]!, data.people, now)!;
  expect(line.segments).toContainEqual(expect.objectContaining({ from: now - 10 * minute, to: now, kind: "review" }));
  // It waits on no one you can act for: the line's colour says it, and no mark does.
  expect(laneMarks(line)).toEqual([]);
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  const lines = [...document.querySelectorAll('[data-row="T1"] svg line')];
  expect(lines.some((line) => line.getAttribute("class") === "text-lit-line" && !line.hasAttribute("stroke-dasharray"))).toBe(true);
  expect(lines.some((line) => line.getAttribute("class") === TONE.turn || line.getAttribute("class") === "text-turn-line")).toBe(false);
});

test.each([
  { state: "doing", mark: null },
  { state: "waiting", mark: { kind: "report", tone: "turn" } },
  { state: "held", mark: null },
  { state: "done", mark: { kind: "approve", tone: "done" } },
] as const)("a $state record is marked only for what the task stands on now", ({ state, mark }) => {
  // Holding and hand-made completion are human actions; only working/waiting reports are authored by P1.
  const log = { ...report("L2", now - 10 * minute, state),
    ...(state === "held" || state === "done" ? { actor: { kind: "human" as const } } : {}),
    ...(state === "held" ? { fromState: "waiting" as const } : {}) };
  const before = state === "held" ? [{ ...report("Lwait", now - 20 * minute, "waiting"), actor: { kind: "human" as const } }] : [];
  const data = served(tree({ tasks: [dto({ state, log: [created(now - 30 * minute), ...before, log] })],
    placements: [{ ...canonical.placements[0]!, id: "P1", taskId: "T1" }],
    balls: state === "waiting" ? { T1: userBall("review", "L2", log.at, { aboutRunId: "R1" }) } : {} }));
  const history = timeHistory(data.tasks[0]!, data.people, now)!;
  expect(compactMark(history.events.find(event => event.key === "log:T1:L2")!)).toEqual(mark);
  expect(laneMarks(history).map(each => compactMark(each.event))).toEqual(mark ? [mark] : []);
});

const errorLog = (id: string, at: number) => logEntry({ id: `LEND${id}`, kind: "linked", at: iso(at),
  fromState: "doing", toState: "error" });

const restartLog = (id: string, at: number) => logEntry({ id: `LSTART${id}`, kind: "linked", at: iso(at),
  fromState: "error", toState: "doing" });

test("the Task error interval ends when its next responsible Run starts", () => {
  const failed = run("R1", { state: "failed", startedAt: iso(now - 20 * minute), endedAt: iso(now - 10 * minute) });
  const restarted = run("R2", { state: "running", startedAt: iso(now - 5 * minute), endedAt: null });
  const task = dto({ state: "doing", log: [created(now - 30 * minute), errorLog("R1", now - 10 * minute),
    restartLog("R2", now - 5 * minute)] });
  const data = served(tree({ tasks: [task], runs: [failed, restarted] }));
  expect(timeHistory(data.tasks[0]!, data.people, now)!.segments)
    .toContainEqual(expect.objectContaining({ from: now - 10 * minute, to: now - 5 * minute, kind: "stuck" }));
});

test("a Task stays in error until a recorded transition, even when another Run has ended", () => {
  const task = dto({ state: "error", log: [created(now - 30 * minute), errorLog("R1", now - 10 * minute)] });
  const unrelated = run("R2", { state: "succeeded", startedAt: iso(now - 5 * minute), endedAt: iso(now - 2 * minute) });
  const data = served(tree({ tasks: [task], runs: [unrelated] }));
  expect(timeHistory(data.tasks[0]!, data.people, now)!.segments)
    .toContainEqual(expect.objectContaining({ from: now - 10 * minute, to: now, kind: "stuck" }));
});

test.each(["done", "stopped"] as const)("a %s decision closes the Task error interval", (state) => {
  const task = dto({ state, log: [created(now - 30 * minute), errorLog("R1", now - 10 * minute),
    report("L3", now - 7 * minute, state)] });
  const data = served(tree({ tasks: [task] }));
  expect(timeHistory(data.tasks[0]!, data.people, now)!.segments)
    .toContainEqual(expect.objectContaining({ from: now - 10 * minute, to: now - 7 * minute, kind: "stuck" }));
});

test("a failed Run without a Task error transition does not paint the Task red", () => {
  const task = dto({ state: "doing", log: [created(now - 30 * minute)] });
  const failed = run("R1", { state: "failed", startedAt: iso(now - 20 * minute), endedAt: iso(now - 10 * minute) });
  const data = served(tree({ tasks: [task], runs: [failed] }));
  expect(timeHistory(data.tasks[0]!, data.people, now)!.segments.some((segment) => segment.kind === "stuck")).toBe(false);
});

test("a delayed linked log paints the error from the Run end time", () => {
  const cause = now - 10 * minute;
  const task = dto({ state: "error", log: [created(now - 30 * minute),
    { ...errorLog("R1", now - minute), causeAt: iso(cause) }] });
  const data = served(tree({ tasks: [task] }));
  expect(timeHistory(data.tasks[0]!, data.people, now)!.segments)
    .toContainEqual(expect.objectContaining({ from: cause, to: now, kind: "stuck" }));
});

/** Where the shared ground's veil over what is still to come begins, beside the titles: now's x on every strip. */
const futureFrom = () => parseFloat(document.querySelector<HTMLElement>("[data-time-ground] > .bg-future")!.style.left);

/** What a row's strip writes: its words, without the long words of their hover. */
const stripWords = (id: string) => [...document.querySelectorAll(`[data-row="${id}"] svg[data-time-strip] text`)]
  .map((text) => [...text.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join(""));

test("beside the strips a row uses its state icon and the future band says only the time or overrun", () => {
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  // All four tasks at work fit the viewport's budget, independently of the list scrollport's height.
  expect(document.querySelectorAll('[data-section="doing"] + ol > [data-row]')).toHaveLength(4);
  for (const id of ["T2", "T3", "T4", "T6"]) {
    expect(document.querySelector(`[data-row="${id}"] [data-row-meta]`)).toBeNull();
    expect(document.querySelector(`[data-row="${id}"] [data-read]`)?.textContent).toMatch(new RegExp(`^${id}`));
    expect(document.querySelector(`[data-row="${id}"] [data-icon="doing"]`)).toBeTruthy();
  }
  // An expected report is written after now without its prefix; its press retains the full wording.
  expect(stripWords("T2")).toEqual([expect.stringMatching(/^\d\d:\d\d$/)]);
  expect(document.querySelector('[data-row="T2"] svg[data-time-strip] [data-future-tip]')?.getAttribute("aria-label")).toContain("Expected report");
  // No estimate: nothing is written.
  expect(stripWords("T3")).toEqual([]);
  expect(document.querySelector('[data-row="T3"] [data-overrun]')).toBeNull();
  // Past its estimate: the work since the estimate is said quietly, a grey fill under a softened ink line, clipped from
  // the estimate to now; no alarm colour, no heavy rule. Its overrun is written after now.
  const over = document.querySelector('[data-row="T4"] [data-overrun]')!;
  const clip = over.querySelector("clipPath rect")!;
  const t4now = futureFrom();
  expect(Number(clip.getAttribute("x")) + Number(clip.getAttribute("width"))).toBeCloseTo(t4now);
  expect(over.querySelector("g[clip-path]")?.getAttribute("clip-path")).toBe(`url(#${over.querySelector("clipPath")!.id})`);
  expect(over.querySelector('path.text-overdue[fill="none"]')).not.toBeNull();
  expect(over.querySelector("path.fill-overdue-area")).not.toBeNull();
  expect(over.querySelector(".text-error, .text-turn, line, [stroke-width='3']")).toBeNull();
  expect(stripWords("T4")).toEqual([expect.stringMatching(/^~\d+ (min|hours?) overdue$/)]);
  expect(document.querySelector('[data-row="T4"] svg[data-time-strip] [data-future-tip]')?.getAttribute("aria-label")).toMatch(/^Report estimate: \d+ of 30 min worked/);
  // Tomorrow's estimate: the clock alone, with a small "+1" after it, not "tomorrow 06:30".
  expect(stripWords("T6")).toEqual([expect.stringMatching(/^\d\d:\d\d$/)]);
  expect(document.querySelector('[data-row="T6"] [data-future-day]')?.textContent).toBe("+1");
  expect(document.querySelector('[data-row="T5"]')).toBeNull();
  expect(screen.queryByText(/Done \d/)).toBeNull();
});

test("a mark cannot shift the future estimate away from the no-mark column", () => {
  const task = dto({ id: "T2", state: "doing", log: [created(now - 30 * minute), report("L2", now - minute, "doing")] });
  const data = served(tree({ tasks: [task], placements: [{ ...canonical.placements[0]!, id: "P1", taskId: "T2", responsible: true }],
    runs: [run("R1", { taskId: "T2", placementId: "P1", state: "running", startedAt: iso(now - 20 * minute), endedAt: null })] }));
  const history = projectTimeHistory(timeHistoryBase(data.tasks.find((each) => each.id === "T2")!, data.people, recordNotes(data.people, (data.tasks.find((each) => each.id === "T2")!).id)), now)!;
  const reportEvent = history.events.find((event) => event.source.log?.kind === "reported")!;
  const mark = { event: { ...reportEvent, at: now - minute, source: { ...reportEvent.source, finished: true } } };
  const finish = { short: "Expected report 12:30", long: "Expected report 12:30", tone: "quiet" as const, at: now + 30 * minute, ends: true, brief: "12:30", briefDays: 0 };
  const scale = { x: (at: number) => 200 + (at - now) / minute * 3, from: now - 60 * minute, to: now + 30 * minute, width: 324 };
  const draw = (marks: typeof mark[]) => render(<svg><Lane turnFrom={null} line={{ stretches: [], hands: [], waits: [], drops: false }}
    marks={marks} scale={scale} level={{ base: 20, unit: 8, rise: 14 }} now={now} finish={finish} onPick={() => {}} /></svg>).container;
  const without = draw([]);
  const x = without.querySelector("text")?.getAttribute("x");
  cleanup();
  const withMark = draw([mark]);
  expect(withMark.querySelector("text")?.getAttribute("x")).toBe(x);
  expect(Number(x)).toBeGreaterThan(scale.x(now));
  cleanup();
  const dated = { ...finish, at: Date.parse("2027-10-13T12:30:00+09:00") };
  const withPin = render(<svg><Lane turnFrom={null} line={{ stretches: [], hands: [], waits: [], drops: false }}
    marks={[{ ...mark, display: "pin" }]} scale={scale} level={{ base: 20, unit: 8, rise: 14 }} now={now}
    finish={dated} onPick={() => {}} /></svg>).container;
  const pin = withPin.querySelector('[data-pin="true"] rect')!;
  const words = withPin.querySelector("[data-future-label]")!;
  expect(Number(pin.getAttribute("x")) + Number(pin.getAttribute("width"))).toBeLessThan(Number(words.getAttribute("x")) - 4);
});

test("the future band fits the longest visible row, with a clock-only minimum shared by every row", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  const task = dto({ id: "T2", state: "doing", log: [created(now - 30 * minute), report("L2", now - 20 * minute, "doing", 60)] });
  const data = served(tree({ tasks: [task], placements: [{ ...canonical.placements[0]!, id: "P1", taskId: "T2" }],
    runs: [run("R1", { taskId: "T2", placementId: "P1", state: "running", startedAt: iso(now - 20 * minute), endedAt: null })],
    home: homeFixture([{ taskId: "T2", section: "doing" }]) }));
  render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  // One ground lies under every row beside the titles: its veil after now is the band.
  const bandWidth = () => parseFloat(document.querySelector<HTMLElement>("[data-time-ground]")!.style.width) - futureFrom();
  const short = bandWidth();
  expect(short).toBeGreaterThanOrEqual(50);
  expect(short).toBeLessThan(70);
  cleanup();
  render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
  expect(bandWidth()).toBeGreaterThan(short);
  const labels = document.querySelectorAll<SVGTextElement>("[data-future-label]");
  expect(labels.length).toBeGreaterThan(1);
  for (const label of labels) expect(Number(label.getAttribute("x"))).toBe(futureFrom() + 16);
});

test("the future band says a time's width, never the state the row's icon says; its title keeps the full words", () => {
  const t = i18n.getFixedT("en", "people");
  const band = (facts: Parameters<typeof finishWords>[0]) => { const words = finishWords(facts, now, t, i18n.language); return [futureWords(words, now)?.text ?? null, words.long]; };
  const ahead = now + 30 * minute, clock = formatClock(iso(ahead)), past = formatClock(iso(now - 10 * minute));
  // A report or an end a moment ahead of the screen's clock: the time alone, as wide as an expected report.
  expect(band({ kind: "reported", at: ahead, turn: false })).toEqual([clock, `Awaiting review, reported ${clock}`]);
  expect(band({ kind: "done", at: ahead })).toEqual([clock, `Done ${clock}`]);
  expect(band({ kind: "subtree", at: ahead, count: 2, open: 0 })[0]).toBe(clock);
  expect(band({ kind: "subtree", at: ahead, count: 2, open: 1 })[0]).toBe(`After ${clock}`);
  expect(band({ kind: "subtree", at: now - 10 * minute, count: 2, open: 0 })).toEqual(["~10 min overdue", `Past the latest estimate of this task and the tasks under it (${past}) by ~10 min`]);
  // A task's own estimate: the expected report alone, or how far past it is.
  const estimate = (minutes: number, used: number) => ({ kind: "estimate" as const, estimate: { minutes, usedMinutes: used,
    remainingMinutes: minutes - used, pending: false } });
  expect(band(estimate(40, 10))[0]).toBe(clock);
  expect(band(estimate(10, 20))[0]).toBe("~10 min overdue");
  // Your turn and the past are on the line and the row, not in the band.
  expect(band({ kind: "reported", at: ahead, turn: true })[0]).toBeNull();
  expect(band({ kind: "reported", at: now - minute, turn: false })[0]).toBeNull();
});

test("a time on another day says no day word in the band, only a small day mark", () => {
  const t = i18n.getFixedT("en", "people");
  const nextDay = new Date(now); nextDay.setDate(nextDay.getDate() + 1); nextDay.setHours(0, 55, 0, 0);
  const at = nextDay.getTime(), clock = formatClock(iso(at));
  const words = finishWords({ kind: "subtree", at, count: 1, open: 0 }, now, t, i18n.language);
  expect(words.long).toContain("tomorrow");
  expect(futureWords(words, now)).toEqual({ text: clock, days: 1 });
  expect(futureWords(finishWords({ kind: "subtree", at, count: 1, open: 1 }, now, t, i18n.language), now)).toEqual({ text: `After ${clock}`, days: 1 });
});

test("a mark keeps its event time even beside the now line", () => {
  const data = fixture();
  const history = projectTimeHistory(timeHistoryBase(data.tasks.find((task) => task.id === "T2")!, data.people, recordNotes(data.people, (data.tasks.find((task) => task.id === "T2")!).id)), now)!;
  const event = history.events.find((each) => each.source.log?.kind === "reported")!;
  const mark = { event: { ...event, at: now + 2 * minute, source: { ...event.source, finished: true,
    log: { ...event.source.log!, estimateMinutes: undefined } } } };
  const scale = { x: (at: number) => 200 + (at - now) / minute * 3, from: now - 60 * minute, to: now + 30 * minute, width: 324 };
  const draw = (pin: boolean) => render(<svg><Lane turnFrom={null} line={{ stretches: [], hands: [], waits: [], drops: false }}
    marks={[pin ? { ...mark, display: "pin" } : mark]} scale={scale} level={{ base: 20, unit: 8, rise: 14 }}
    now={now} finish={{ short: "Expected report 12:30", long: "Expected report 12:30", tone: "quiet", at: now + 30 * minute, ends: true, brief: "12:30", briefDays: 0 }}
    onPick={() => {}} /></svg>).container;
  const ordinary = draw(false).querySelector("[data-mark] g circle")!;
  expect(Number(ordinary.getAttribute("cx"))).toBe(scale.x(now + 2 * minute));
});

test("a phone row is one form in every group: its quiet line with the run's time over its title, read title first", () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
  const press = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"] [data-read]`)!;
  const phone = narrowScreen(true);
  try {
    render(<TestWorkspace data={fixture()}><TimeTree /></TestWorkspace>);
    const metaOf = (id: string) => document.querySelector<HTMLElement>(`[data-row="${id}"] [data-row-meta]`)!;
    const time = (id: string) => metaOf(id).querySelector<HTMLElement>("[data-row-status]");
    // A running task says how long agents have worked on it and under it, in its working colour, apart from its expected report.
    for (const id of ["T2", "T3", "T4", "T6"]) {
      expect(time(id)?.dataset.rowStatus).toBe("running");
      expect(time(id)?.textContent).toBe("20m");
      expect(time(id)?.getAttribute("aria-label")).toBe("Total agent working time: With tasks below 20 min, This task only 20 min");
      expect(time(id)?.className).toContain("text-working");
    }
    for (const [id, title] of [["T2", "With estimate"], ["T3", "Without estimate"], ["T4", "Overdue"]] as const) {
      const row = press(id);
      // A reader hears the state's word, then the title, then the line drawn over it.
      expect(row.querySelector(".sr-only")?.textContent).toBe("In progress");
      const titleEl = row.querySelector<HTMLElement>("[data-row-title]")!, meta = metaOf(id);
      expect(row.getAttribute("aria-describedby")).toBe(meta.id);
      expect(row.contains(meta)).toBe(false);
      expect(titleEl.textContent).toBe(title);
      expect(titleEl.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The meta line is on the outer grid's second row, shared with the first row of the press's subgrid.
      expect(meta.className).toContain("row-start-2");
      expect(row.className).toContain("row-start-2");
      expect(row.className).toContain("grid-rows-subgrid");
      expect(row.querySelector("[data-row-title-line]")?.className).toContain("row-start-2");
      expect(row.querySelector("[data-row-marks]")?.className).toContain("row-start-1");
      // The line is a step under the title, its id quiet too: the icon says the state.
      expect(meta.className).toContain(TONE.aside);
      expect(titleEl.className).toContain("text-ink");
      expect(meta.querySelector("[data-row-own-id]")?.textContent).toBe(id);
      expect(meta.querySelector("[data-row-own-id]")?.className).toBe("");
      // The id and the time are never cut: what is under the row gives way first (jsdom lays nothing out: the classes say it).
      expect(meta.querySelector("[data-row-id]")?.className).toContain("flex-none");
      // A row with no children's count has no place for one, so no empty gap stands before its notes.
      expect(meta.querySelector("[data-row-counts]")).toBeNull();
      if (time(id)) expect(time(id)?.className).toContain("flex-none");
      // The group says the state: no row repeats it in words.
      const shown = meta.cloneNode(true) as HTMLElement;
      shown.querySelectorAll(".sr-only").forEach((each) => each.remove());
      expect(shown.textContent).not.toContain("In progress");
    }
    // A parent's count gives way whole before the id and the time (jsdom lays nothing out: the classes say it).
    const counts = document.querySelector<HTMLElement>("[data-row-counts]");
    expect(counts?.querySelector("[data-row-progress]")).toBeTruthy();
    expect(counts?.className).toMatch(/min-w-0.*overflow-hidden/);
    // A finished leaf has the same form: its icon, how long since it finished, and its title quiet.
    openGroup("finished");
    const done = press("T5");
    expect(document.querySelector('[data-row="T5"] [data-row-label] [data-icon="done"]')).toBeTruthy();
    expect(time("T5")?.dataset.rowStatus).toBe("since");
    expect(time("T5")?.textContent).toBe("10m");
    expect(done.querySelector("[data-row-title]")?.className).toContain("text-muted");
    phone.set(false);
  } finally { phone.set(false); phone.restore(); }
});

test("a finished row on a phone says no Question, whatever question it still lists", () => {
  const phone = narrowScreen(true);
  try {
    const done = dto({ id: "T1", title: "Finished", state: "done", log: [created(now - 80 * minute), report("L2", now - 10 * minute, "done")] });
    const data = served(tree({ tasks: [done], home: homeFixture([{ taskId: "T1", section: "done" }]),
      questions: [questionFixture({ id: "L3", title: "Remaining question", decide: [decideItem("Remaining question", [["Option1", "Difference", "Reason"]])] })] }));
    expect(data.tasks[0]!.question).toBe("Remaining question");
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    openGroup("finished");
    const meta = document.querySelector('[data-row="T1"] [data-row-meta]');
    expect(meta).toBeTruthy();
    // No Question word and no words of the question (a row never says the work's words).
    expect(meta?.querySelector("[data-row-kind]")).toBeNull();
    expect(meta?.textContent).not.toContain("Question");
    expect(document.querySelector('[data-row="T1"]')?.textContent).not.toContain("Remaining question");
  } finally { phone.set(false); phone.restore(); }
});

test("an overrun stays in the future band while its quiet past keeps its true time", () => {
  const hour = 60 * minute;
  const finish = { short: "~9 hours past 04:30", long: "540 of 30 min worked", tone: "late" as const, at: now - 9 * hour, ends: false, brief: "~9 hours overdue", briefDays: 0 };
  const scale = { x: (time: number) => (time - (now - 10 * hour)) / minute * 3, from: now - 10 * hour, to: now + 14 * minute, width: 1924 };
  const lane = () => render(<svg><Lane turnFrom={null} line={{ stretches: [], hands: [], waits: [], drops: false }}
    marks={[]} scale={scale} level={{ base: 20, unit: 8, rise: 14 }} now={now} finish={finish} onPick={() => {}} /></svg>).container;
  // What is past the estimate is drawn from the estimate to now.
  let strip = lane();
  const clip = strip.querySelector("[data-overrun] clipPath rect")!;
  expect(clip.getAttribute("x")).toBe(String(scale.x(finish.at)));
  expect(clip.getAttribute("width")).toBe(String(scale.x(now) - scale.x(finish.at)));
  const labelX = strip.querySelector("text")?.getAttribute("x");
  expect(Number(labelX)).toBeGreaterThan(scale.x(now));
  expect(strip.querySelector("text")?.lastChild?.textContent).toBe("~9 hours overdue");
  expect(strip.querySelector("text")?.hasAttribute("data-edge")).toBe(false);
  cleanup();
  // The shared band grows for a long localized label, so the label keeps the same starting column.
  scale.width = scale.x(now) + futureBandWidth([{ text: "~9 hours overdue", days: 0 }]);
  strip = lane();
  expect(Number(strip.querySelector("text")?.getAttribute("x"))).toBe(scale.x(now) + 16);
  expect(strip.querySelector("[data-future-tip]")?.getAttribute("aria-label")).toBe(`Report estimate: ${finish.long}`);
  expect(strip.querySelector("[data-overrun] clipPath rect")).toBeTruthy();
});

test("work past the estimate is redrawn quietly on its own line, in the row's ground, inside a phone's row", () => {
  const hour = 60 * minute;
  const finish = { short: "~45 min overdue", long: "60 of 15 min worked", tone: "late" as const, at: now - 45 * minute, ends: false, brief: "~45 min overdue", briefDays: 0 };
  const stretch = (from: number, to: number, count: number) => ({ from, to, count, wait: null, peak: count, merged: 0 });
  // Past the estimate: one at work, a quiet gap, then two at once up to now: a row with two concurrent workers.
  const line = { stretches: [stretch(now - 50 * minute, now - 40 * minute, 1), stretch(now - 40 * minute, now - 35 * minute, 0),
    stretch(now - 35 * minute, now - 20 * minute, 1), stretch(now - 20 * minute, now, 2)], hands: [], waits: [], drops: false };
  const level = { base: 11, unit: 5, rise: 7 };
  const draw = (from: number) => {
    const scale = { x: (at: number) => (at - from) / minute * 3, from, to: now + 20 * minute, width: 400 };
    const strip = render(<svg><Lane turnFrom={null} line={line} marks={[]} scale={scale} level={level} now={now} finish={finish}
      onPick={() => {}} /></svg>).container;
    return { strip, scale };
  };
  const { strip, scale } = draw(now - hour);
  const over = strip.querySelector("[data-overrun]")!;
  const clip = over.querySelector("clipPath rect")!;
  expect(Number(clip.getAttribute("x"))).toBe(scale.x(finish.at));
  expect(Number(clip.getAttribute("width"))).toBe(scale.x(now) - scale.x(finish.at));
  // The late look is the same line as the working one, so nothing shifts where it begins; only its work is redrawn.
  const working = [...strip.querySelectorAll('path.text-working[fill="none"]')].filter(path => !over.contains(path)).map(path => path.getAttribute("d"));
  const late = [...over.querySelectorAll('path.text-overdue[fill="none"]')];
  expect(late.map(path => path.getAttribute("d"))).toEqual(working);
  expect(over.querySelectorAll("path.fill-overdue-area")).toHaveLength(2);
  // Its cover is the row's own ground, so no seam shows.
  expect(over.querySelectorAll("path.text-bg")).toHaveLength(2);
  expect(over.querySelector("path.text-hover, line, .text-error, .text-turn, [stroke-width='3']")).toBeNull();
  // The quiet gap past the estimate keeps its ordinary base line; the late look adds nothing over it.
  const gap = [...strip.querySelectorAll("line")].find(each => Number(each.getAttribute("x1")) === scale.x(now - 40 * minute))!;
  expect(over.contains(gap)).toBe(false);
  expect(Number(gap.getAttribute("x2"))).toBe(scale.x(now - 35 * minute));
  // Two at once still stays inside a phone's 22px row.
  const ys = late.flatMap(path => [...path.getAttribute("d")!.matchAll(/V([\d.]+)/g)].map(match => Number(match[1])));
  expect(Math.min(...ys)).toBe(level.base - level.rise);
  expect(Math.max(...ys)).toBeLessThanOrEqual(22);
  cleanup();
  // An estimate before the screen's start: what is past it starts at the screen's edge.
  const later = draw(now - 25 * minute);
  expect(Number(later.strip.querySelector("[data-overrun] clipPath rect")!.getAttribute("x"))).toBe(later.scale.x(later.scale.from));
  expect(later.strip.querySelectorAll("[data-overrun] path.text-bg")).toHaveLength(2);
});

test("a phone keeps the first In progress row visible above ten open Not started rows", () => {
  const narrow = narrowScreen(true);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(844);
  try {
    const running = dto({ id: "T1", state: "doing" });
    const unstarted = Array.from({ length: 10 }, (_, i) => dto({ id: `T${i + 2}`, state: "todo" }));
    const placement = { ...canonical.placements[0]!, id: "P1", taskId: running.id,
      runtime: { ...canonical.placements[0]!.runtime, displayState: "running" as const, runningCount: 1,
        sourceRunIds: ["R1"] } };
    const data = served(tree({ tasks: [running, ...unstarted], placements: [placement],
      runs: [run("R1", { taskId: running.id, placementId: placement.id, state: "running", endedAt: null })],
      home: homeFixture([{ taskId: running.id, section: "doing" },
        ...unstarted.map((task) => ({ taskId: task.id, section: "todo" as const }))]) }));
    const { container } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    expect(container.querySelector('[data-section="doing"] + ol > [data-row="T1"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-section="todo"] + ol > [data-row]')).toHaveLength(10);
  } finally { narrow.restore(); }
});

test("desktop time rows put the state icon, ID, title and child progress on one 32px line", () => {
  render(<TestWorkspace data={fixture({ parentResponsible: true })}><TimeTree /></TestWorkspace>);
  const parent = document.querySelector('[data-row="T1"]')!;
  const title = parent.querySelector('[data-read="T1"]')!;
  expect(parent.querySelector('[data-row-label] [data-icon="review"]')).toBeTruthy();
  expect(title.textContent).toBe("T1Parent");
  const end = parent.querySelector("[data-row-end]")!;
  expect(title.getAttribute("aria-describedby")).toBe(end.id);
  expect(title.contains(end)).toBe(false);
  expect(title.parentElement).toBe(end.parentElement);
  expect(end.querySelector("[data-row-progress]")?.textContent).toBe("0/1");
  expect(parent.querySelector('[data-row-meta], [data-card-lead]')).toBeNull();
  expect(document.querySelector('[data-row="T2"] [data-read]')?.textContent).toContain("T2");
  const strip = parent.querySelector('svg[data-time-strip]')!;
  expect(strip.getAttribute("height")).toBe("32");
  expect(strip.querySelector('g[data-pin] circle')?.getAttribute("cy")).toBe("16");
  expect(parent.querySelector<HTMLElement>('[data-row-label]')!.style.height).toBe("32px");
  fireEvent.click(document.querySelector('[data-section="done"] button')!);
  expect(document.querySelector('[data-row="T5"] svg[data-time-strip]')?.getAttribute("height")).toBe("32");
  // Under the work going on, at the end of the top level.
  expect([...document.querySelectorAll('[data-depth="0"]')].at(-1)?.getAttribute("data-row")).toBe("T5");
});

test("Done opens for the task in the detail by its list row, and its rows come with the page it then reads", async () => {
  // T1 is on the top level's finished page (its row stands in Done), T3 finished on its parent's page only; Done's page is
  // not read yet, as when the list has not opened it. T3 in the detail neither opens Done nor reads its page.
  const value = tree({ tasks: [
    dto({ id: "T1", title: "Opened", state: "done", userRequested: true }),
    dto({ id: "T2", title: "Neighbor", state: "done", userRequested: true }),
    dto({ id: "T3", title: "Child", state: "done", parentId: "T2" }),
  ], home: homeFixture([{ taskId: "T1", section: "done" }, { taskId: "T2", section: "done" }]) });
  const data = screenData(value);
  data.readIds = new Set();
  const finishedKey = resources.finished(value.root, null).queryKey;
  const page = queryClient.getQueryData<{ pages: unknown[] }>(finishedKey)!.pages[0];
  const seed = data.seed;
  const unread = { ...data, seed: () => { seed(); queryClient.removeQueries({ queryKey: finishedKey, exact: true }); } };
  const reads: string[] = [];
  let answer = () => {};
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    reads.push(url);
    if (!url.includes("task/finished")) throw new Error(`not served: ${url}`);
    await answered;
    return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
  });
  const rows = () => [...document.querySelectorAll<HTMLElement>("li[data-row]")].map((row) => row.dataset.row)
    .filter((id) => id === "T1" || id === "T2" || id === "T3");
  const dotted = () => ["T1", "T2"].filter((id) => document.querySelector(`[data-row="${id}"] [data-unread]`));
  useViewStore.getState().openTask("T3", { reader: true });
  const { rerender } = render(<TestWorkspace data={unread}><TimeTree /></TestWorkspace>);
  expect(rows()).toEqual([]);
  expect(reads.filter((url) => url.includes("task/finished"))).toEqual([]);
  act(() => { useViewStore.getState().openTask("T1", { reader: true }); });
  rerender(<TestWorkspace data={unread}><TimeTree /></TestWorkspace>);
  // Opening T1 acknowledges it before the Done page arrives; the late page must not restore its dot.
  rerender(<TestWorkspace data={{ ...unread, readIds: new Set(["T1"]) }}><TimeTree /></TestWorkspace>);
  expect(reads.some((url) => url.includes("task/finished"))).toBe(true);
  await act(async () => { answer(); await vi.waitFor(() => expect(rows()).toEqual(["T1", "T2"])); });
  expect(dotted()).toEqual(["T2"]);
});

test("desktop sections share the completed row's unread dot, icon, ID and title; the phone keeps its layout", () => {
  const tasks = [
    dto({ id: "T1", title: "In progress", state: "doing" }),
    taskFixture({ id: "T2", title: "Awaiting review", state: "waiting", log: [created(now - 30 * minute), report("L2", now - 10 * minute, "waiting")],
      ball: userBall("review", "L2", iso(now - 10 * minute), { aboutRunId: "R1" }) }),
    taskFixture({ id: "T3", title: "Waiting for answer", state: "doing", log: [created(now - 30 * minute), asked("L2", now - 9 * minute)],
      ball: userBall("question", "L2", iso(now - 9 * minute), { questionId: "L2" }) }),
    dto({ id: "T4", title: "Not started", state: "todo" }),
    taskFixture({ id: "T5", title: "Waiting for child", state: "waiting", log: [created(now - 30 * minute), { ...report("L2", now - 8 * minute, "waiting") }],
      ball: userBall("review", "L2", iso(now - 8 * minute), { aboutRunId: "R1" }) }),
    dto({ id: "T6", title: "Done", state: "done" }),
    dto({ id: "T7", title: "Stopped", state: "stopped" }),
  ];
  // A question still listed on a finished task is not drawn on its row.
  const listed = (taskId: string, title: string) => questionFixture({ id: "L9", taskId, title, decide: [decideItem(title, [["Yes", "Check"]])] });
  // T1 works: a Run of it runs, as its doing row says.
  const data = served(tree({ tasks, questions: [listed("T3", "Answer"), listed("T6", "Answered question"), listed("T7", "Stopped question")],
    runs: [run("R9", { taskId: "T1", state: "running", endedAt: null })],
    home: homeFixture([{ taskId: "T1", section: "doing" }, { taskId: "T2", section: "review" }, { taskId: "T3", section: "review" },
      { taskId: "T5", section: "review" }, { taskId: "T4", section: "todo" }, { taskId: "T6", section: "done" }, { taskId: "T7", section: "done" }]) }));
  expect(data.tasks.find(task => task.id === "T6")?.question).toBe("Answered question");
  expect(data.tasks.find(task => task.id === "T7")?.question).toBe("Stopped question");
  data.readIds = new Set(["T6"]);
  const { unmount } = render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
  openGroup("finished");
  for (const [id, icon] of [["T1", "doing"], ["T2", "review"], ["T3", "question"], ["T4", "todo"],
    ["T5", "review"], ["T6", "done"], ["T7", "stopped"]] as const) {
    const row = document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;
    expect(row.querySelector(`[data-row-label] [data-icon="${icon}"]`)).toBeTruthy();
    expect(row.querySelector<HTMLElement>("[data-row-label]")?.style.height).toBe("32px");
    expect(row.querySelector("[data-read]")?.textContent).toContain(id);
    expect(row.querySelector("[data-row-meta], [data-card-lead]")).toBeNull();
    expect(!!row.querySelector("[data-unread]")).toBe(id !== "T6");
    expect(row.querySelector("[data-asks-too]")).toBeNull();
  }
  expect(document.querySelector('[data-row="T2"] [data-read]')?.textContent).toMatch(/^T2Awaiting review/);
  unmount();
  const phone = narrowScreen(true);
  try {
    render(<TestWorkspace data={data}><TimeTree /></TestWorkspace>);
    expect(document.querySelector('[data-row="T2"] [data-row-meta]')).toBeTruthy();
  } finally { phone.restore(); }
});
