import { expect, test } from "vitest";
import { sumUsage, type UsageTotal } from "@alpacawork/contract";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import type { Task } from "../src/data/types";
import { indexTasks } from "../src/domain/tasks";
import { taskWorkTime, workTimeMs } from "../src/domain/usage";
import { dto, run, screenData, tree } from "./fixtures";

const minute = 60_000;
const epoch = Date.parse("2026-10-26T05:00:00Z");
const at = (minutes: number) => epoch + minutes * minute;
const iso = (minutes: number) => new Date(at(minutes)).toISOString();
const saved = (minutes: number): UsageTotal => ({ runs: 1, runMs: minutes * minute, tokens: null, tokensUnknown: 1 });

function index(...specs: (Pick<Task, "id"> & Partial<Pick<Task, "parent" | "usage" | "usageBelow" | "runsBelow">>)[]) {
  const tasks = screenData(tree({ tasks: specs.map(task => dto({ id: task.id, parentId: task.parent ?? undefined })),
    usage: Object.fromEntries(specs.map(task => [task.id, { usage: task.usage ?? null, usageBelow: task.usageBelow ?? null,
      runsBelow: task.runsBelow ?? [] }])) })).tasks;
  return indexTasks(tasks);
}

function byTask(...runs: ControlRunDTO[]): ReadonlyMap<string, readonly ControlRunDTO[]> {
  const grouped = new Map<string, ControlRunDTO[]>();
  for (const item of runs) grouped.set(item.taskId, [...(grouped.get(item.taskId) ?? []), item]);
  return grouped;
}

const live = (id: string, start: number, changes: Partial<ControlRunDTO> = {}) =>
  run(id, { state: "running", startedAt: iso(start), endedAt: null, ...changes });
const finished = (id: string, start: number, end: number, changes: Partial<ControlRunDTO> = {}) =>
  run(id, { startedAt: iso(start), endedAt: iso(end), ...changes });

test("own counts this task while subtree adds children and grandchildren, excluding other roots", () => {
  const tasks = index({ id: "T1", usage: saved(2), usageBelow: saved(7), runsBelow: [["R901", at(7)], ["R902", at(6)]] }, { id: "T2", parent: "T1", usage: saved(3) },
    { id: "T3", parent: "T2", usage: saved(4) }, { id: "T4", usage: saved(100) });
  const runs = byTask(live("R1", 8), live("R2", 7, { taskId: "T2" }), live("R3", 6, { taskId: "T3" }),
    live("R4", 0, { taskId: "T4" }));
  const time = taskWorkTime("T1", tasks, runs);
  expect(time.own).toEqual({ doneMs: 2 * minute, runningSince: [at(8)] });
  expect(time.subtree).toEqual({ doneMs: 9 * minute, runningSince: [at(8), at(7), at(6)] });
  expect(workTimeMs(time.own, at(10))).toBe(4 * minute);
  expect(workTimeMs(time.subtree, at(10))).toBe(18 * minute);
});

test("responsible and member Runs on the same task both count, including overlapping time", () => {
  const tasks = index({ id: "T1" });
  const runs = byTask(finished("R1", 0, 2, { placementId: "P-owner" }),
    finished("R2", 0, 3, { placementId: "P-member" }),
    live("R3", 4, { placementId: "P-owner" }), live("R4", 5, { placementId: "P-member" }));
  const time = taskWorkTime("T1", tasks, runs);
  expect(time.own).toEqual({ doneMs: 5 * minute, runningSince: [at(4), at(5)] });
  expect(workTimeMs(time.own, at(10))).toBe(16 * minute);
  expect(time.subtree).toEqual(time.own);
});

test.each([undefined, saved(0)])("joined and queued Runs without a start add no time (saved total: %j)", usage => {
  const tasks = index({ id: "T1", usage });
  const runs = byTask(run("R1", { state: "joined", into: "R3", startedAt: null, endedAt: iso(5) }),
    run("R2", { state: "queued", startedAt: null, endedAt: null }), live("R3", 2, { startedAt: null }));
  const time = taskWorkTime("T1", tasks, runs);
  expect(time.own).toEqual({ doneMs: 0, runningSince: [] });
  expect(workTimeMs(time.subtree, at(10))).toBe(0);
});

test("the same prepared time advances with now, clamping each future start separately", () => {
  const time = taskWorkTime("T1", index({ id: "T1", usage: saved(3) }), byTask(live("R1", 2), live("R2", 4))).own;
  Object.freeze(time.runningSince);
  Object.freeze(time);
  expect(workTimeMs(time, at(1))).toBe(3 * minute);
  expect(workTimeMs(time, at(3))).toBe(4 * minute);
  expect(workTimeMs(time, at(10))).toBe(17 * minute);
  expect(workTimeMs(time, at(12))).toBe(21 * minute);
});

test("saved completed usage replaces finished Run records and a newly finished Run stops growing", () => {
  const ended = finished("R1", 0, 3);
  const running = live("R2", 8);
  const tasks = index({ id: "T1", usage: saved(3) });
  const before = taskWorkTime("T1", tasks, byTask(ended, running));
  expect(before.own.doneMs).toBe(3 * minute);
  expect(workTimeMs(before.subtree, at(10))).toBe(5 * minute);
  const after = taskWorkTime("T1", index({ id: "T1", usage: saved(5) }),
    byTask(ended, { ...running, state: "succeeded", endedAt: iso(10) }));
  expect(after.own).toEqual({ doneMs: 5 * minute, runningSince: [] });
  expect(workTimeMs(after.subtree, at(20))).toBe(5 * minute);
});

test("without saved usage, recorded elapsed time never grows after an end", () => {
  const tasks = index({ id: "T1" });
  const runs = byTask(finished("R1", 0, 2), finished("R2", 2, 5, { state: "failed" }),
    finished("R3", 4, 6, { state: "cancelled" }), live("R4", 6, { state: "needs_review" }),
    finished("R5", 6, 6), finished("R6", 8, 7));
  const time = taskWorkTime("T1", tasks, runs);
  expect(time.own).toEqual({ doneMs: 7 * minute, runningSince: [] });
  expect(workTimeMs(time.subtree, at(10))).toBe(7 * minute);
  expect(workTimeMs(time.subtree, at(20))).toBe(7 * minute);
});

test("a moving Run with an end has a fixed span and invalid timestamps add no time", () => {
  const tasks = index({ id: "T1" });
  const badStart = { ...live("R2", 1), startedAt: "invalid" };
  const badEnd = { ...live("R3", 1), endedAt: "invalid" };
  const runs = byTask(live("R1", 2, { endedAt: iso(4) }), badStart, badEnd);
  const time = taskWorkTime("T1", tasks, runs);
  expect(time.own).toEqual({ doneMs: 2 * minute, runningSince: [] });
  expect(workTimeMs(time.subtree, at(20))).toBe(2 * minute);
});

test.each([true, false])("subtree adds saved or calculated own time to server descendant time (saved: %s)", hasSaved => {
  const tokens = { input: 10, cacheRead: 2, cacheWrite: 3, output: 4 };
  const ended = finished("R1", 0, 2, { usage: { run: tokens, includesEarlier: false } });
  const stored = sumUsage([ended], at(10));
  const tasks = index({ id: "T1", usage: hasSaved ? stored : undefined, usageBelow: { ...saved(4), runs: 2, tokensUnknown: 2 },
    runsBelow: [["R903", at(7)]] }, { id: "T2", parent: "T1" },
    { id: "T3", parent: "T2", usage: saved(3) });
  const runs = byTask(ended, live("R2", 6), finished("R3", 0, 1, { taskId: "T2" }),
    live("R4", 7, { taskId: "T3", placementId: "P-member" }));
  const time = taskWorkTime("T1", tasks, runs);
  for (const now of [at(5), at(10), at(12)]) {
    expect(workTimeMs(time.subtree, now)).toBe((6 + Math.max(0, (now - at(6)) / minute)
      + Math.max(0, (now - at(7)) / minute)) * minute);
  }
});

test("an absent task with no Runs has zero own and subtree time", () => {
  const tasks = index({ id: "T1" });
  const time = taskWorkTime("T404", tasks, byTask());
  expect(time).toEqual({ own: { doneMs: 0, runningSince: [] }, subtree: { doneMs: 0, runningSince: [] } });
  expect(workTimeMs(time.subtree, at(10))).toBe(0);
});

test("server cost includes unloaded descendants and never counts loaded descendant Runs twice", () => {
  const tokens = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0, output: 0 });
  const own = { ...saved(2), tokens: tokens(2), tokensUnknown: 0 };
  // Three minutes on the loaded child and four on an unloaded finished grandchild.
  const below = { ...saved(7), runs: 2, tokens: tokens(7), tokensUnknown: 0 };
  const tasks = index({ id: "T1", usage: own, usageBelow: below, runsBelow: [["R904", at(7)]] },
    { id: "T2", parent: "T1", usage: { ...saved(3), tokens: tokens(3), tokensUnknown: 0 }, usageBelow: saved(4) });
  expect(tasks.byId.has("T3")).toBe(false);
  expect(tasks.byId.get("T1")?.usageBelow).toEqual(below);
  const runs = byTask(finished("R1", 0, 2), live("R2", 8),
    finished("R3", 0, 3, { taskId: "T2" }), live("R4", 7, { taskId: "T2", placementId: "P-member" }),
    finished("R5", 0, 4, { taskId: "T3" }));
  const time = taskWorkTime("T1", tasks, runs);
  expect(time.own).toEqual({ doneMs: 2 * minute, runningSince: [at(8)] });
  expect(time.subtree).toEqual({ doneMs: 9 * minute, runningSince: [at(8), at(7)] });
  expect(workTimeMs(time.subtree, at(10))).toBe(14 * minute);
  expect(workTimeMs(time.subtree, at(20))).toBe(34 * minute);
  // Loading a finished grandchild, including its saved total and full Run record, changes neither total.
  const withGrandchild = indexTasks([...tasks.tasks, { ...tasks.byId.get("T2")!, id: "T3", parent: "T2", usage: saved(4) }]);
  expect(taskWorkTime("T1", withGrandchild, runs)).toEqual(time);
  // Loading no child rows or Run records produces the same time.
  const onlyParent = indexTasks([tasks.byId.get("T1")!]);
  const onlyOwnRuns = byTask(...runs.get("T1")!);
  expect(taskWorkTime("T1", onlyParent, onlyOwnRuns)).toEqual(time);
  // Preparing time does not consult the loaded child graph.
  Object.defineProperty(onlyParent, "children", { get() { throw new Error("cost must not walk loaded children"); } });
  expect(taskWorkTime("T1", onlyParent, onlyOwnRuns)).toEqual(time);
});

test("a completed child can disappear from the live index without losing or doubling its Run time", () => {
  const own = { id: "T1", usage: saved(2), usageBelow: saved(7), runsBelow: [["R905", at(7)]] as [string, number][] };
  const ownRun = live("R1", 8);
  const childRun = live("R2", 7, { taskId: "T2" });
  const beforeIndex = index(own, { id: "T2", parent: "T1", usage: saved(3) });
  const before = taskWorkTime("T1", beforeIndex, byTask(ownRun, childRun));
  // Task completion removes the child before its Run ends; the server start keeps its contribution present.
  const duringIndex = index(own);
  const during = taskWorkTime("T1", duringIndex, byTask(ownRun));
  expect(during).toEqual(before);
  expect(workTimeMs(during.subtree, at(10))).toBe(14 * minute);
  const afterIndex = index({ ...own, usageBelow: saved(10), runsBelow: [] });
  const afterRuns = byTask(ownRun, { ...childRun, state: "succeeded", endedAt: iso(10) });
  const after = taskWorkTime("T1", afterIndex, afterRuns);
  expect(workTimeMs(before.subtree, at(10))).toBe(14 * minute);
  expect(workTimeMs(after.subtree, at(10))).toBe(14 * minute);
  expect(after.subtree.runningSince).toEqual([at(8)]);
  expect(workTimeMs(after.subtree, at(12))).toBe(16 * minute);
});

test("own and subtree combine completed time and preserve independent ordered starts", () => {
  const below = { ...saved(0), runMs: 2 ** 53 };
  const tasks = index({ id: "T1", usageBelow: below,
    runsBelow: [["R901", at(7)], ["R902", at(7)]] });
  const endedAt = new Date(epoch + 1).toISOString();
  const runs = [finished("R1", 0, 0, { endedAt }), live("R2", 8),
    finished("R3", 0, 0, { endedAt }), live("R4", 8)];
  for (const run of runs) Object.freeze(run);
  Object.freeze(runs);
  const time = taskWorkTime("T1", tasks, new Map([["T1", runs]]));
  expect(time.own).toEqual({ doneMs: 2, runningSince: [at(8), at(8)] });
  expect(time.subtree).toEqual({ doneMs: 2 ** 53 + 2, runningSince: [at(8), at(8), at(7), at(7)] });
  expect(time.own.runningSince).not.toBe(time.subtree.runningSince);
  expect(tasks.byId.get("T1")?.runsBelow).toEqual([["R901", at(7)], ["R902", at(7)]]);
});
