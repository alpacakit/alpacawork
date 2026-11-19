import { expect, test } from "vitest";
import { compileAgentSetting } from "@alpacawork/contract/agent-settings";
import { agentChoices, resolveAgentSelection, selectionOffer } from "@alpacawork/contract/agent-selection";
import { agentOffers } from "../src/features/forms/agent-offers";
import { launchProfile } from "./fixtures";
import { launchSelection } from "../src/features/forms/launch-selection";

const offerOf = (key: string, setting: Parameters<typeof compileAgentSetting>[1]) => selectionOffer(compileAgentSetting(key, setting));

/** codex as configured: `fast` is written with a leading '-', so it may be left out, and starts so. */
const codex = offerOf("codex", { params: {
  model: ["gpt-6.1-sol", "gpt-6-astra"], effort: ["high", "low", "xhigh"], fast: ["-", "fast"],
} });

test("a new launch starts at each row's first value and offers only the written values, a leading - as none", () => {
  const view = launchSelection(codex, { kind: "new", hints: {} });
  expect(view.shown).toEqual({ model: "gpt-6.1-sol", effort: "high", fast: null });
  expect(view.choices.map(choice => [choice.key, choice.candidates])).toEqual([
    ["model", ["gpt-6.1-sol", "gpt-6-astra"]], ["effort", ["high", "low", "xhigh"]], ["fast", [null, "fast"]],
  ]);
  expect(view.problems).toEqual([]);
});

test("a new launch takes this device's last choices while the config offers them, and sends what it shows", () => {
  const view = launchSelection(codex, { kind: "new", hints: { model: "gpt-6-astra", effort: "max", fast: "fast" } });
  expect(view.shown).toEqual({ model: "gpt-6-astra", effort: "high", fast: "fast" });
  expect(view.send).toEqual(view.shown);
});

test("going on in a conversation shows its previous values and sends only what is changed here, never the device's", () => {
  const previous = { model: "gpt-6-astra", effort: "low", fast: null };
  const kept = launchSelection(codex, { kind: "continue", previous });
  expect(kept.shown).toEqual(previous);
  expect(kept.send).toEqual({});
  const changed = launchSelection(codex, { kind: "continue", previous }, { effort: "xhigh" });
  expect(changed.shown).toEqual({ ...previous, effort: "xhigh" });
  expect(changed.send).toEqual({ effort: "xhigh" });
});

test("a previous value the config no longer offers asks to choose again rather than taking today's first, until chosen", () => {
  const previous = { model: "gpt-5", effort: "low", fast: null };
  const view = launchSelection(codex, { kind: "continue", previous });
  expect(view.problems).toEqual([{ key: "model", previous: "gpt-5", candidates: ["gpt-6.1-sol", "gpt-6-astra"],
    reason: "invalid_value", recovery: "select_value" }]);
  expect(Object.hasOwn(view.shown, "model")).toBe(false);
  expect(view.shown).toEqual({ effort: "low", fast: null });
  const chosen = launchSelection(codex, { kind: "continue", previous }, { model: "gpt-6-astra" });
  expect(chosen.problems).toEqual([]);
  expect(chosen.send).toEqual({ model: "gpt-6-astra" });
});

test("a previous row the config removed needs a new conversation; a new launch with the same device hint does not", () => {
  const previous = { model: "gpt-6-astra", effort: "low", fast: null, verbosity: "low" };
  expect(launchSelection(codex, { kind: "continue", previous }).problems).toEqual([
    { key: "verbosity", previous: "low", candidates: [], reason: "removed", recovery: "new_conversation" },
  ]);
  expect(launchSelection(codex, { kind: "new", hints: previous }).problems).toEqual([]);
});

test("a value chosen here that the settings stop offering stays to choose again; a stale device hint quietly falls back", () => {
  const before = offerOf("codex", { params: { model: ["a", "b"], effort: ["high"], fast: ["-", "fast"] } });
  const after = offerOf("codex", { params: { model: ["a"], effort: ["high"], fast: ["-", "fast"] } });
  const previous = { model: "a", effort: "high", fast: null };
  expect(launchSelection(before, { kind: "continue", previous }, { model: "b" }).send).toEqual({ model: "b" });
  const gone = launchSelection(after, { kind: "continue", previous }, { model: "b" });
  expect(gone.problems).toEqual([{ key: "model", previous: "b", candidates: ["a"], reason: "invalid_value", recovery: "select_value" }]);
  expect(Object.hasOwn(gone.shown, "model")).toBe(false);
  expect(launchSelection(after, { kind: "new", hints: { model: "b" } })).toMatchObject({ shown: { model: "a" }, problems: [] });
});

test("for an agent whose models omit rows, what the picker shows is what admission launches with", () => {
  const setting = { params: { model: ["gemini-3.8-flash", "claude-sonnet-4-6"], effort: ["high", "low"] }, without: { "claude-sonnet-4-6": ["effort"] } };
  const served = compileAgentSetting("agy", setting);
  // As serve lists it: the rows and each model's omitted rows.
  const [offer] = agentOffers([{ key: "agy", choices: agentChoices(served), without: setting.without }]);
  const tries: Record<string, string | null>[] = [{}, { model: "claude-sonnet-4-6" }, { model: "claude-sonnet-4-6", effort: "low" }];
  for (const changes of tries) {
    const view = launchSelection(offer!.offer, { kind: "new", hints: {} }, changes);
    const admitted = resolveAgentSelection(served, view.send);
    const launched = Object.fromEntries(admitted.choices.filter(choice => choice.active).map(choice => [choice.key, admitted.effective[choice.key]]));
    expect(view.shown).toEqual(launched);
  }
  expect(launchSelection(offer!.offer, { kind: "new", hints: {} }, { model: "claude-sonnet-4-6" }).choices.map(choice => choice.key)).toEqual(["model"]);
});

test("a model named like an object's own property still starts and is sent when no row leaves it out", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const [offer] = agentOffers([launchProfile("codex", { model: [name], effort: ["high", "low"] })]);
    const view = launchSelection(offer!.offer, { kind: "new", hints: { model: name, effort: "low" } });
    expect(view.shown).toEqual({ model: name, effort: "low" });
    expect(view.send).toEqual({ model: name, effort: "low" });
  }
});
