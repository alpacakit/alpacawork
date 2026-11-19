import { test, expect } from "vitest";
import { mapWorkspace } from "../src/data/map";
import { taskBaseline } from "../src/data/notice-model";
import type { ControlTreeDTO } from "@alpacawork/contract/control";
import { dto, tree, baselines, indexOf, logEntry, rowOf, screenData, at, PROJECT_TASK } from "./fixtures";

const project = (value: ControlTreeDTO = tree(), baseline = baselines()) => mapWorkspace(indexOf(value), baseline);

test("index mapping preserves hash, parent, path and the state log, uses the last log time and shelves archived and deleted tasks", () => {
  const task = dto({ id: "T12", parentId: "T1", path: "tasks/T12", log: [...dto().log, logEntry({ id: "L2", kind: "reported", at: "2026-09-25T09:00:00Z", title: "New" })] });
  const mapped = project(tree({ tasks: [dto(), task] })).tasks[1]!;
  expect(mapped).toMatchObject({ id: "T12", parent: "T1", path: "tasks/T12", hash: task.hash, version: task.version, updatedAt: task.log.at(-1)!.at });
  expect(mapped.stateLog.map((log) => log.id)).toEqual(["L2"]);
  expect(mapped.stateLog[0]?.title).toBe("New");
  expect(mapped).not.toHaveProperty("body");
  expect(mapped).not.toHaveProperty("session");
  expect(project(tree({ tasks: [dto({ log: [] })] })).tasks[0]).toMatchObject({ updatedAt: "" });
  const shelved = project(tree({ tasks: [dto(), dto({ id: "T2", lifecycle: "archived" }), dto({ id: "T3", lifecycle: "deleted" })] }));
  expect(shelved.tasks.map((item) => item.id)).toEqual(["T1", PROJECT_TASK]);
  expect(shelved.shelved.map((item) => [item.task.id, item.lifecycle])).toEqual([["T2", "archived"], ["T3", "deleted"]]);
});

test("checkpoint changes use created > state > reported > body and stable first-seen times", () => {
  const before = dto();
  const current = dto({ state: "waiting", body: "Edited", log: [...before.log, logEntry({ id: "L2", kind: "reported", at, title: "Report" })] });
  const changes = (baseline = baselines(), task = current) => project(tree({ tasks: [task] }), baseline).tasks[0]!.change;
  expect(changes(baselines([]))).toMatchObject({ kind: "new", detail: { type: "created" }, at });
  const baseline = baselines();
  baseline.firstSeen = new Map([[`T1|state|doing|waiting`, { at: Date.parse("2026-09-25T01:00:00Z") }]]);
  expect(changes(baseline)).toMatchObject({ kind: "state", detail: { type: "state", from: "doing", to: "waiting" }, at: "2026-09-25T01:00:00.000Z" });
  expect(changes(baselines(), { ...current, state: before.state })).toMatchObject({ kind: "content", detail: { type: "note", text: "Report" }, at });
  expect(changes(baselines(), { ...before, values: { notes: "Edited" } })).toMatchObject({ detail: { type: "body" } });
  expect(changes(baselines(), before)).toBeNull();
  baseline.reads["T1"] = taskBaseline(rowOf(current));
  expect(project(tree({ tasks: [current] }), baseline).readIds.has("T1")).toBe(true);
  expect(changes(baseline)).not.toBeNull();
});

test("of several reports after the checkpoint, the change shows the latest", () => {
  const before = dto();
  const current = dto({ log: [...before.log,
    logEntry({ id: "L2", kind: "reported", at: "2026-09-25T01:00:00Z", title: "Older report" }),
    logEntry({ id: "L3", kind: "reported", at: "2026-09-25T02:00:00Z", title: "Newer report" })] });
  expect(project(tree({ tasks: [current] }), baselines([before])).tasks[0]!.change)
    .toMatchObject({ kind: "content", detail: { type: "note", text: "Newer report" }, at: "2026-09-25T02:00:00Z" });
});

test("unchanged index rows keep their screen Task identity across a one-row delta", () => {
  const index = indexOf(tree({ tasks: [dto(), dto({ id: "T2" })] }));
  const baseline = baselines();
  const first = mapWorkspace(index, baseline);
  const next = mapWorkspace({ ...index, tasks: [index.tasks[0]!, { ...index.tasks[1]!, title: "Changed" }] }, baseline);
  expect(next.tasks[0]).toBe(first.tasks[0]);
  expect(next.tasks[1]).not.toBe(first.tasks[1]);
  const changedBaseline = baselines([]);
  expect(mapWorkspace(index, changedBaseline).tasks[0]).not.toBe(first.tasks[0]);
});
