import { expect, test } from "vitest";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import { currentWords } from "../src/domain/work-progress";
import { at, logEntry, run, screenData, taskFixture, tree } from "./fixtures";

const placement = { id: "P1", taskId: "T1", agentId: "A-P1", profileKey: "codex", responsible: true, active: true, revision: 1,
  startedAt: at, endedAt: null, headRunId: "R1",
  runtime: { displayState: "attention" as const, reason: "exit" as const, sourceRunIds: [], runningCount: 0, queuedCount: 0,
    since: null, lastOutputAt: null, activityKind: null, toolName: null } };
const report = (id: string, time: string, title = " report ", runId: string | undefined = "R1") =>
  logEntry({ id, kind: "reported", at: time, title, runId });
function fixture(runs: ControlRunDTO[] = [run()]) {
  const data = screenData(tree({ tasks: [taskFixture()], placements: [placement], runs }));
  return { people: data.people, task: data.tasks.find(task => task.id === "T1")! };
}

test("owner report uses the last eligible history entry, not the greatest timestamp, without changing the log", () => {
  const { people, task } = fixture([run(), run("R2", { placementId: "P2" })]);
  task.stateLog = [report("newer", "2026-09-24T10:00:00Z"), report("chosen", at, " chosen "),
    report("blank", at, "  "), report("other", at, "other", "R2"), report("missing", at, "missing", "R9"),
    { ...report("unlinked", at), runId: undefined }, report("old", "2026-09-24T08:00:00Z"),
    { ...report("kind", at), kind: "created" }];
  const log = task.stateLog;
  const before = [...log];
  Object.freeze(log);
  expect(currentWords(task, people)).toEqual({ at, text: "chosen" });
  expect(task.stateLog).toBe(log);
  expect(log).toEqual(before);
});

test("the latest started run sets the inclusive round boundary even when the report belongs to an earlier run", () => {
  const { people, task } = fixture([run(), run("R2", { startedAt: "2026-09-24T10:00:00Z" })]);
  task.stateLog = [report("boundary", "2026-09-24T10:00:00Z"), report("old", at)];
  expect(currentWords(task, people)).toEqual({ at: "2026-09-24T10:00:00Z", text: "report" });
});

test("missing start times allow reports, while any invalid nonempty start time prevents selection", () => {
  const { people, task } = fixture([run("R1", { startedAt: null }), run("R2")]);
  task.stateLog = [report("report", at)];
  const runs = people.runsByPlacement.get("P1")!;
  runs[1] = { ...runs[1]!, startedAt: "" };
  expect(currentWords(task, people)).toEqual({ at, text: "report" });
  runs[0] = { ...runs[0]!, startedAt: "invalid" };
  runs[1] = { ...runs[1]!, startedAt: at };
  expect(currentWords(task, people)).toBeNull();
  people.crews.get("T1")!.responsible = null;
  expect(currentWords(task, people)).toBeNull();
});
