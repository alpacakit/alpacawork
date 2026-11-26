import { describe, expect, it } from "vitest";
import type { RunStep } from "@alpacawork/contract/run";
import { awaitedStep } from "@/domain/run-activity";

const step = (over: Partial<RunStep>): RunStep => ({ id: "s", at: "2026-01-01T00:00:00Z", tool: "Bash", kind: "command", text: "",
  more: 0, about: null, state: "running", result: null, ...over });

describe("what a silent Run waits on", () => {
  it("is the latest step still running, and nothing once every step has ended", () => {
    expect(awaitedStep([step({ id: "a", text: "gh run watch 1" }), step({ id: "b", text: "ls", state: "done" })])?.id).toBe("a");
    expect(awaitedStep([step({ state: "done" }), step({ state: "failed" })])).toBeNull();
    expect(awaitedStep(undefined)).toBeNull();
  });
});
