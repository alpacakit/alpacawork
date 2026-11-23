import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { PlacementDTO } from "@alpacawork/contract/control";
import { agentModelName, modelLabel, placementAgentLabel, selectionAgentLabels, visibleAgentNames } from "../src/domain/agent-label";
import { indexPeople } from "../src/domain/people";
import { at, dto, indexOf, run, tree } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });

test.each([
  ["gpt-6.1-sol", "gpt-6.1-sol"],
  ["anthropic/claude-sonnet-4-6(high)", "claude-sonnet-4-6(high)"],
  ["openrouter/openai/gpt-6.1-sol", "openai/gpt-6.1-sol"],
])("model display drops only the first provider and retains the original value: %s", (full, short) => {
  expect(modelLabel(full)).toMatchObject({ short, full, collision: false });
});

test("only names that collide across providers show the provider, including an unqualified peer", () => {
  const names = ["anthropic/sonnet(high)", "bedrock/sonnet(high)", "openrouter/openai/sol", "anthropic/sonnet(high)"];
  expect(names.map(name => modelLabel(name, names).short)).toEqual(["anth…/sonnet(high)", names[1], "openai/sol", "anth…/sonnet(high)"]);
  expect(modelLabel(names[0]!, names).collision).toBe(true);
  expect(modelLabel("bedrock/sonnet", ["sonnet"]).short).toBe("bedrock/sonnet");
  expect(modelLabel("sonnet", ["bedrock/sonnet"]).short).toBe("sonnet");
  expect(modelLabel(names[0]!, [names[0]!, names[0]!]).collision).toBe(false);
});

test("effort does not hide a provider collision, and remains part of the displayed and full labels", () => {
  const names = [agentModelName("bedrock/sonnet", "high", "pi"), agentModelName("vertexai/sonnet", "low", "pi")];
  expect(names.map(name => modelLabel(name.full, names))).toEqual([
    { short: "bedrock/sonnet(high)", full: names[0]!.full, collision: true, name: "bedrock/sonnet", suffix: "(high)" },
    { short: "vertexai/sonnet(low)", full: names[1]!.full, collision: true, name: "vertexai/sonnet", suffix: "(low)" },
  ]);
  expect(modelLabel(names[0]!.full, [names[0]!]).short).toBe("sonnet(high)");
});

test("nested model names remain distinct when restoring a provider creates another displayed collision", () => {
  const names = ["gpt-6.1-sol", "openai/gpt-6.1-sol", "openrouter/openai/gpt-6.1-sol"];
  expect(names.map(name => modelLabel(name, names).short)).toEqual(names);
  const deeper = [...names, "router/openrouter/openai/gpt-6.1-sol"];
  expect(new Set(deeper.map(name => modelLabel(name, deeper).short)).size).toBe(deeper.length);
});

test("display scopes exclude other tasks and inactive model fields", () => {
  const shown = agentModelName("anthropic/sonnet", "high", "pi");
  const unrelated = agentModelName("bedrock/sonnet", "low", "pi");
  const visible = visibleAgentNames([shown.full], [shown, unrelated]);
  expect(modelLabel(shown.full, visible).short).toBe("sonnet(high)");
  const profiles = [{ key: "pi", models: [shown.model] }, { key: "other", models: [unrelated.model] }];
  const current = profiles[0]!.models;
  expect(modelLabel(current[0]!, current).short).toBe("sonnet");
});

test("a missing model after the provider separator keeps the original nonempty name", () => {
  expect(modelLabel("provider/").short).toBe("provider/");
});

test("long colliding providers use the shortest distinguishing prefix of at least four characters", () => {
  const names = ["amazon-bedrock/sonnet", "amazon-direct/sonnet", "anthropic/sonnet", "bedrock/sonnet", "amaz/sonnet"];
  const labels = names.map(name => modelLabel(name, names));
  expect(labels.map(label => label.short)).toEqual(["amazon-b…/sonnet", "amazon-d…/sonnet", "anth…/sonnet", "bedrock/sonnet", "amaz/sonnet"]);
  expect(labels.map(label => label.full)).toEqual(names);
  expect(new Set(labels.map(label => label.short)).size).toBe(names.length);
  expect(modelLabel("amazon-bedrock/sonnet", ["bedrock/opus"]).short).toBe("sonnet");
  expect(modelLabel("abcdefghij/sonnet", ["abcdefghijk/sonnet"]).short).toBe("abcdefghij/sonnet");
  expect(modelLabel("abcdefgh-axxx/sonnet", ["abcdefgh-bxxx/sonnet"]).short).toBe("abcdefgh-axxx/sonnet");
  expect(modelLabel("abcdefgh-axxxx/sonnet", ["abcdefgh-bxxxx/sonnet"]).short).toBe("abcdefgh-a…/sonnet");
});

test("a placement shows the newest Run's frozen model and effort, or its profile before launch", () => {
  const placement: PlacementDTO = { id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex",
    responsible: true, active: true, revision: 1, startedAt: at, endedAt: null, headRunId: "R2",
    runtime: { displayState: "idle", reason: null, sourceRunIds: [], runningCount: 0,
      queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null } };
  const old = run("R1", { modelId: "gpt-6-sol", effort: "medium" });
  const newest = run("R2", { modelId: "gpt-6-astra", effort: "high", createdAt: "2026-09-24T10:00:00Z" });
  const launched = indexPeople(indexOf(tree({ placements: [placement], runs: [newest, old] })));
  expect(placementAgentLabel(placement, launched)).toBe("gpt-6-astra(high)");
  const unstarted = indexPeople(indexOf(tree({ placements: [placement] })));
  expect(placementAgentLabel(placement, unstarted)).toBe("codex(not started)");
});

test("selection labels add only enough placement ID to distinguish identical visible choices", () => {
  const original: PlacementDTO = { id: "P7873a", taskId: "T1", agentId: "A1", profileKey: "codex",
    responsible: false, active: true, revision: 1, startedAt: at, endedAt: null, headRunId: null,
    runtime: { displayState: "idle", reason: null, sourceRunIds: [], runningCount: 0,
      queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null } };
  const other = { ...original, id: "P7873b", agentId: "A2" };
  const distinct = { ...original, id: "P9", agentId: "A3" };
  const unrelated = { ...original, id: "P77", taskId: "T2", agentId: "A77" };
  const runs = [run("R1", { placementId: original.id, modelId: "openai/gpt-6-sol", effort: "high" }),
    run("R2", { placementId: other.id, modelId: "openai/gpt-6-sol", effort: "high" }),
    run("R3", { placementId: distinct.id, modelId: "gpt-6-astra", effort: "high" }),
    run("R4", { taskId: "T2", placementId: unrelated.id, modelId: "bedrock/gpt-6-sol", effort: "high" })];
  const people = indexPeople(indexOf(tree({ tasks: [dto(), dto({ id: "T2" })], placements: [original, other, distinct, unrelated], runs })));
  const labels = selectionAgentLabels([original, other, distinct], people);
  expect(labels.get(original.id)!.short).toBe("#7873a · gpt-6-sol(high)");
  expect(labels.get(other.id)!.short).toBe("#7873b · gpt-6-sol(high)");
  expect(labels.get(distinct.id)!.short).toBe("gpt-6-astra(high)");
  const withRoles = selectionAgentLabels([original, other], people, (placement) => placement.id === original.id ? " · Owner" : " · Member");
  expect([...withRoles.values()].map(label => label.short)).toEqual(["gpt-6-sol(high) · Owner", "gpt-6-sol(high) · Member"]);
});
