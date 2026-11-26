import { describe, expect, it } from "vitest";
import { agentLetters, modelAgent } from "@/domain/agent-mark";

describe("modelAgent", () => {
  it("names the agent whose setting offers the model, then the kind whose models it is, else none", () => {
    const agents = { inkling: { adapter: "pi", params: { model: ["inkling-2-mini"] } } };
    expect(modelAgent("inkling-2-mini", agents)).toEqual({ name: "inkling", kind: "pi" });
    expect(modelAgent("opus(medium)", agents)).toEqual({ name: "claude", kind: "claude" });
    expect(modelAgent("gpt-6.2-sol", agents)).toEqual({ name: "codex", kind: "codex" });
    expect(modelAgent("mystery-7b", agents)).toBeNull();
  });
  it("gives agents of one kind different letters", () => {
    expect([agentLetters("claude"), agentLetters("claude-chrome"), agentLetters("inkling")]).toEqual(["Cl", "CC", "In"]);
  });
});
