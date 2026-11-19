import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
// Clock users may have been imported by an earlier file in a shared worker.
vi.hoisted(() => vi.resetModules());
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { controlTreeSchema, type ControlTaskDTO } from "@alpacawork/contract/control";
import { queryClient } from "../src/data/query-client";
import { formatClock } from "../src/domain/time";
import { finishOf, finishWords, type FinishFacts } from "../src/domain/finish-words";
import { indexTasks } from "../src/domain/tasks";
import { TimeTree } from "../src/features/tree/TimeTree";
import { useTimeView } from "../src/state/time-view";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, dto, logEntry, screenData, serveTimeline, tree, homeFixture } from "./fixtures";

/**
 * A parent's finish is what the unfinished tasks under it say (domain/finish-words `finishOf`), on its row in
 * the home list or scoped branch and the task tab alike. Each case is one combination of the children's states.
 */
// Keep both the six-hour overrun and the 150-minute estimate on the same day in UTC and Japan.
const now = Date.parse("2026-10-01T12:00:00Z");
vi.mock("../src/state/clock", () => ({ useNow: () => Date.parse("2026-10-01T12:00:00Z"), advanceNow: () => {} }));
const minute = 60_000;
const iso = (at: number) => new Date(at).toISOString();
const clock = (minutes: number) => formatClock(iso(now + minutes * minute));

type Spec = { id: string; parentId?: string; state?: ControlTaskDTO["state"]; asks?: boolean;
  /** An estimate in minutes, reported `ago` minutes before now. */ estimate?: number; ago?: number; sentBack?: boolean };
const task = ({ id, parentId, state = "doing", asks, estimate, ago = 0, sentBack }: Spec) => dto({ id, parentId: parentId ?? null,
  path: `tasks/${id}`, title: id, state, log: [
    logEntry({ id: "L1", kind: "created", at: iso(now - 120 * minute), toState: "todo" }),
    ...(state === "todo" ? [] : [logEntry({ id: "L2", kind: "reported", at: iso(now - ago * minute), fromState: "todo", toState: "doing",
      ...(estimate === undefined ? {} : { estimateMinutes: estimate }) })]),
    ...(sentBack ? [logEntry({ id: "L3", kind: "review_sent_back", at: iso(now - 1 * minute), actor: { kind: "human" } })] : []),
    ...(state === "waiting" || state === "done" || state === "stopped" ? [logEntry({ id: "L4", kind: "reported", at: iso(now - 1 * minute),
      fromState: "doing", toState: state })] : []),
    ...(asks ? [logEntry({ id: "L5", kind: "asked", askedTo: null, at: iso(now - 1 * minute), title: "Question", description: "Please answer",
      actor: { kind: "placement", placementId: "P1" } })] : []),
  ] });
const canonical = controlTreeSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname,
  "../../../tests/fixtures/contract-examples/tree.json"), "utf8")));
/** A person on each task named in `people`: its responsible, idle, running or with its work stopped in an error. */
type People = Record<string, "idle" | "running" | "attention">;
const data = (specs: Spec[], people: People = {}) => {
  const value = tree({ tasks: specs.map(task), home: homeFixture(specs.filter(spec => !spec.parentId).map(spec => ({ taskId: spec.id, section: "doing" as const }))),
  placements: Object.entries(people).map(([taskId, kind], index) => {
    const displayState = kind === "attention" ? "attention" as const : kind === "running" ? "running" as const : "idle" as const;
    return { ...canonical.placements[0]!, id: `P${index + 10}`, taskId, responsible: true,
      runtime: { ...canonical.placements[0]!.runtime, displayState, reason: kind === "attention" ? "exit_code" : null, sourceRunIds: [], runningCount: kind === "running" ? 1 : 0, since: null } };
  }) });
  serveTimeline(value);
  return screenData(value);
};
/** The list: a parent nobody's run is going under is in Working, which is never folded. */
const list = (specs: Spec[], people: People = {}) => render(<TestWorkspace data={data(specs, people)}><TimeTree /></TestWorkspace>);
/** The parent's estimate and overrun are written in its future band. */
const cardSays = (specs: Spec[], people: People = {}) => {
  const { container } = list(specs, people);
  const words = container.querySelector('[data-row="T1"] svg[data-time-strip] text');
  return { short: words?.lastChild?.textContent ?? "", long: words?.querySelector("title")?.textContent ?? "" };
};
const parent = (spec: Partial<Spec> = {}): Spec => ({ id: "T1", state: "doing", ...spec });
const kid = (id: string, spec: Partial<Spec> = {}): Spec => ({ id, parentId: "T1", ...spec });

beforeAll(() => startI18n());
beforeEach(async () => { await i18n.changeLanguage("en"); useViewStore.setState(useViewStore.getInitialState()); });
afterEach(() => { cleanup(); queryClient.clear(); });
afterAll(() => { vi.doUnmock("../src/state/clock"); vi.resetModules(); });

test.each([
  { combination: "every unfinished child has an estimate; a done child does not count",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12", { estimate: 90 }), kid("T13", { state: "done" })], says: `Expected report ${clock(90)}` },
  { combination: "done and stopped children do not count",
    specs: [parent(), kid("T11", { state: "done" }), kid("T12", { state: "stopped" }), kid("T13", { estimate: 45 })], says: `Expected report ${clock(45)}` },
  { combination: "a working child without an estimate makes it not before",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12")], says: `After ${clock(40)}` },
  { combination: "a child not started makes it not before",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12", { state: "todo" })], says: `After ${clock(40)}` },
  { combination: "a child waiting for review makes it not before",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12", { state: "waiting" })], says: `After ${clock(40)}` },
  { combination: "a child asking a question makes it not before",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12", { asks: true })], says: `After ${clock(40)}` },
  { combination: "a child whose estimate waits for an update makes it not before",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12", { estimate: 90, ago: 5, sentBack: true })], says: `After ${clock(40)}` },
  { combination: "a child whose person's work stopped makes it not before",
    specs: [parent(), kid("T11", { estimate: 40 }), kid("T12", { estimate: 90 })], people: { T12: "attention" }, says: `After ${clock(40)}` },
  { combination: "a past estimate leads, the earliest one, before later and unknown ends",
    specs: [parent(), kid("T11", { estimate: 30, ago: 60 }), kid("T12", { estimate: 20, ago: 30 }), kid("T13", { estimate: 120 }), kid("T14")],
    says: `~30 min overdue` },
  { combination: "grandchildren count through a child that waits for them",
    specs: [parent(), kid("T11", { state: "doing" }), kid("T111", { parentId: "T11", estimate: 30 }),
      kid("T112", { parentId: "T11", estimate: 100 }), kid("T12", { estimate: 50 })], says: `Expected report ${clock(100)}` },
  { combination: "a grandchild without an estimate makes it not before",
    specs: [parent(), kid("T11", { state: "doing" }), kid("T111", { parentId: "T11", state: "todo" }),
      kid("T112", { parentId: "T11", estimate: 100 })], says: `After ${clock(100)}` },
  { combination: "a working child nobody is placed on speaks through its grandchildren, as such a parent does",
    specs: [parent(), kid("T11"), kid("T111", { parentId: "T11", estimate: 100 })], says: `Expected report ${clock(100)}` },
  { combination: "a child whose responsible works without an estimate leaves its own end unsaid, whatever its grandchildren say",
    specs: [parent(), kid("T11"), kid("T111", { parentId: "T11", estimate: 100 })], people: { T11: "running" }, says: `After ${clock(100)}` },
  { combination: "a child whose responsible waits for its children speaks through them",
    specs: [parent(), kid("T11", { state: "doing" }), kid("T111", { parentId: "T11", estimate: 100 })],
    people: { T11: "idle" }, says: `Expected report ${clock(100)}` },
  { combination: "a child whose estimate waits for an update leaves its own end unsaid, whatever its grandchildren say",
    specs: [parent(), kid("T11", { estimate: 60, ago: 5, sentBack: true }), kid("T111", { parentId: "T11", estimate: 100 })],
    says: `After ${clock(100)}` },
  { combination: "a child's own estimate covers its grandchildren without one",
    specs: [parent(), kid("T11", { estimate: 60 }), kid("T111", { parentId: "T11", state: "todo" })], says: `Expected report ${clock(60)}` },
  { combination: "the parent's own estimate covers its children without one",
    specs: [parent({ state: "doing", estimate: 150 }), kid("T11", { state: "todo" })], people: { T1: "running" }, says: `Expected report ${clock(150)}` },
  { combination: "a child later than the parent's own estimate is the end",
    specs: [parent({ state: "doing", estimate: 30 }), kid("T11", { estimate: 90 })], people: { T1: "running" }, says: `Expected report ${clock(90)}` },
  { combination: "the parent's responsible working without an estimate leaves its own end unsaid",
    specs: [parent({ state: "doing" }), kid("T11", { estimate: 40 })], people: { T1: "running" }, says: `After ${clock(40)}` },
  { combination: "the parent's estimate waiting for an update leaves its own end unsaid",
    specs: [parent({ state: "doing", estimate: 60, ago: 5, sentBack: true }), kid("T11", { estimate: 40 })], people: { T1: "running" }, says: `After ${clock(40)}` },
  { combination: "nothing under the parent says when: the strip has no estimate words",
    specs: [parent({ state: "doing" }), kid("T11", { state: "todo" })], people: { T1: "running" }, says: "" },
  { combination: "nothing under the parent says when, and its own estimate waits for an update",
    specs: [parent({ state: "doing", estimate: 60, ago: 5, sentBack: true }), kid("T11", { state: "todo" })], people: { T1: "running" }, says: "" },
] as { combination: string; specs: Spec[]; people?: People; says: string }[])("$combination", ({ specs, people, says }) => {
  expect(cardSays(specs, people).short).toBe(says.replace(/^Expected report /, ""));
});

test("a doing parent keeps its estimate while its child has not started", () => {
  for (const people of [{}, { T1: "idle" }] as People[]) {
    expect(cardSays([parent({ state: "doing", estimate: 150 }), kid("T11", { state: "todo" })], people).short).toBe(clock(150));
    expect(document.querySelector('[data-row="T1"] [data-idle-doing]')).toBeNull();
    cleanup();
  }
  // A run going under it is work going on.
  expect(cardSays([parent({ state: "doing", estimate: 150 }), kid("T11", { state: "todo" })], { T11: "running" }).short).toBe(clock(150));
});

test("the long words say how many estimates count, how many have none, or that one is past", () => {
  expect(cardSays([parent(), kid("T11", { estimate: 40 }), kid("T12", { estimate: 90 })]).long).toBe(`The latest of 2 estimates. Expected report ${clock(90)}`);
  cleanup();
  expect(cardSays([parent(), kid("T11", { estimate: 40 }), kid("T12"), kid("T13", { state: "todo" })]).long)
    .toBe(`Excluding 2 tasks without an estimate, the latest expected report is ${clock(40)}. Not all reports will be in before then`);
  cleanup();
  expect(cardSays([parent(), kid("T11", { estimate: 30, ago: 60 })]).long).toBe(`A task under it is past the ${clock(-30)} estimate by ~30 min`);
});

test("an overrun says how far past the estimate it is, no finer than the estimate is said", async () => {
  await i18n.changeLanguage("ja");
  const past = (minutes: number) => finishWords({ kind: "subtree", at: now - minutes * minute, count: 1, open: 0 }, now, i18n.getFixedT(null, "people"));
  expect(past(2).short).toBe(`${clock(-2)}から約5分超過`);
  expect(past(31).short).toBe(`${clock(-31)}から約30分超過`);
  expect(past(58).short).toBe(`${clock(-58)}から約1時間超過`);
  expect(past(6 * 60 + 10).short).toBe(`${clock(-370)}から約6時間超過`);
  // The long words say it is the estimate that was passed.
  expect(past(6 * 60 + 10).long).toBe(`下のタスクが${clock(-370)}の見込みを約6時間超過`);
  expect(past(3 * 24 * 60 + 100).short).toMatch(/から約3日超過$/);
  await i18n.changeLanguage("en");
  expect(past(6 * 60 + 10).short).toBe(`~6 hours past ${clock(-370)}`);
  expect(past(6 * 60 + 10).long).toBe(`A task under it is past the ${clock(-370)} estimate by ~6 hours`);
  expect(past(24 * 60).short).toMatch(/^~1 day past /);
});

test("an estimate an instruction or send-back made void says it waits for a new one, not that it was passed", async () => {
  await i18n.changeLanguage("ja");
  const said = () => finishWords({ kind: "pending" }, now, i18n.getFixedT(null, "people")).short;
  expect(said()).toBe("見込みの出し直し待ち");
  await i18n.changeLanguage("en");
  expect(said()).toBe("Awaiting a new estimate");
});

test("a parent's future band says its children's end, or a not-before time", () => {
  useTimeView.setState({ viewMs: null, picked: null });
  useViewStore.setState({ ...useViewStore.getInitialState() });
  const rows = (specs: Spec[]) => list(specs);
  rows([parent(), kid("T11", { estimate: 40 }), kid("T12", { estimate: 90 })]);
  expect(document.querySelector('[data-row="T1"] svg[data-time-strip] [data-future-label]')?.lastChild?.textContent).toBe(clock(90));
  expect(document.querySelector('[data-row="T1"] svg[data-time-strip] [data-future-label] title')?.textContent).toContain(`Expected report ${clock(90)}`);
  expect(document.querySelector('[data-row="T1"] [data-row-meta]')).toBeNull();
  expect(document.querySelector('[data-row="T1"] [data-read]')?.textContent).not.toContain("Report estimate");
  cleanup();
  rows([parent(), kid("T11", { estimate: 40 }), kid("T12")]);
  expect(document.querySelector('[data-row="T1"] svg[data-time-strip] text')?.textContent?.endsWith(`After ${clock(40)}`)).toBe(true);
});

test.each([
  { minutes: [NaN], expected: null },
  { minutes: [NaN, 0, 0, 10], expected: { kind: "subtree", at: now, count: 4, open: 0 } },
  { minutes: [NaN, 10, 10], expected: { kind: "subtree", at: now + 10 * minute, count: 3, open: 0 } },
])("subtree aggregation retains invalid and repeated times: $minutes", ({ minutes, expected }) => {
  const children = minutes.map((remaining, i) => ({ id: `T${i + 11}`, remaining }));
  const index = indexTasks(data([parent(), ...children.map(({ id }) => kid(id))]).tasks);
  const facts = new Map<string, FinishFacts>(children.map(({ id, remaining }) => [id, {
    kind: "estimate", estimate: { minutes: remaining, usedMinutes: 0, remainingMinutes: remaining, pending: false },
  }]));
  expect(finishOf("T1", { index, now, factsOf: id => facts.get(id) ?? null })).toEqual(expected);
});

test("open children do not hide later estimates at either depth", () => {
  const index = indexTasks(data([
    parent(), kid("T11", { state: "todo" }), kid("T12"),
    kid("T121", { parentId: "T12", state: "todo" }), kid("T122", { parentId: "T12" }),
  ]).tasks);
  const estimate: FinishFacts = { kind: "estimate", estimate: {
    minutes: 100, usedMinutes: 0, remainingMinutes: 100, pending: false,
  } };
  expect(finishOf("T1", { index, now, factsOf: id => id === "T122" ? estimate : null }))
    .toEqual({ kind: "subtree", at: now + 100 * minute, count: 1, open: 2 });
});
