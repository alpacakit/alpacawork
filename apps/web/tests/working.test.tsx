import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { controlTreeSchema } from "@alpacawork/contract/control";
import { indexPeople } from "../src/domain/people";
import { childWork, working } from "../src/domain/working";
import { indexOf } from "./fixtures";

const tree = controlTreeSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../../tests/fixtures/contract-examples/tree.json"), "utf8")));

test("a finished child's Run still closing is no work below, while a member at work on the open Task counts whatever its state", () => {
  // T12 has finished while its Run is still moving, as the screen sees it between the report and the Run's end. T1 has
  // finished too, and a member (P3) has been asked after it: only the member's Run goes there.
  const finished = { ...tree, tasks: tree.tasks.map(task => task.id === "T12" || task.id === "T1" ? { ...task, state: "done" as const } : task),
    placements: tree.placements.map(placement => placement.id === "P3" ? { ...placement, active: true, endedAt: null } : placement),
    runs: tree.runs.map(run => run.taskId === "T12" ? { ...run, state: "running" as const } : run.id === "R1" ? { ...run, id: "R9" as const, placementId: "P3" as const } : run) };
  const people = indexPeople(indexOf(finished));
  expect(childWork("T1", people).map(item => item.id)).not.toContain("T12");
  expect(working("T1", people).map(run => run.placementId)).toEqual(["P3"]);
});
