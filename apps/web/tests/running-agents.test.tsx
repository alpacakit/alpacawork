import { describe, expect, it } from "vitest";
import type { Task } from "@/data/types";
import type { WorkspaceData } from "@/data/workspace-store";
import { runningAgents } from "@/features/tree/token-speed";

const run = (id: string, taskId: string, agent: string) => ({ id, taskId, agent, state: "running" });
const row = (id: string, runningRuns: number, runsBelow: string[] = []) =>
  ({ id, homeRow: { section: "doing" }, rowFacts: { runningRuns }, runsBelow: runsBelow.map((at) => [at, 0]) }) as unknown as Task;

describe("runningAgents", () => {
  it("counts each agent's running Runs, most first, and keeps the server's count of unloaded ones under null", () => {
    const runs = [run("R1", "T1", "codex"), run("R2", "T1", "claude"), run("R3", "T2", "claude")];
    const data = { people: { runs: new Map(runs.map((each) => [each.id, each])), runsByTask: new Map([["T1", runs.slice(0, 2)]]) } } as unknown as WorkspaceData;
    // T1 runs two itself and R3 below; the server also counts one Run under it no read has brought.
    expect(runningAgents([row("T1", 4, ["R3", "R9"])], data)).toEqual([["claude", 2], ["codex", 1], [null, 1]]);
  });
});
