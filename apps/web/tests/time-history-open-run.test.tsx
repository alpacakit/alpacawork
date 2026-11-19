import { expect, test } from "vitest";
import { dto, run, screenData, tree } from "./fixtures";
import { timeHistory } from "./time-history-fixture";

const started = Date.parse("2026-10-04T06:44:01.811Z");
const now = started + 24 * 60 * 60_000;
const iso = (at: number) => new Date(at).toISOString();

test("a review run without a recorded end does not draw work through now", () => {
  const task = dto({ id: "T135", state: "doing" });
  const stopped = run("R487", { taskId: task.id, state: "needs_review", reason: "manager_lost",
    createdAt: iso(started), startedAt: iso(started), endedAt: null });
  const data = screenData(tree({ tasks: [task], runs: [stopped] }));
  const segments = timeHistory(data.tasks[0]!, data.people, now)!.segments;
  // No stop timestamp exists, so even a guessed historical work end would be false.
  expect(segments.filter((segment) => segment.kind === "work" || segment.kind === "member")).toEqual([]);
  expect(segments.some((segment) => segment.kind === "stuck")).toBe(false);
});

test("only a running run extends work to now; a recorded end remains historical", () => {
  const task = dto({ id: "T135", state: "doing" });
  const runs = [
    run("R487", { taskId: task.id, state: "running", createdAt: iso(started),
      startedAt: iso(started), endedAt: null }),
    run("R488", { taskId: task.id, state: "needs_review", reason: "conversation_busy",
      createdAt: iso(started), startedAt: iso(started), endedAt: iso(started + 60_000) }),
  ];
  const data = screenData(tree({ tasks: [task], runs }));
  const segments = timeHistory(data.tasks[0]!, data.people, now)!.segments;
  expect(segments).toContainEqual(expect.objectContaining({ from: started, to: now, kind: "work" }));
  expect(segments).toContainEqual(expect.objectContaining({ from: started, to: started + 60_000, kind: "work" }));
});
