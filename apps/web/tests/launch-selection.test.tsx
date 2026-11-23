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
  const view = launchSelection(codex);
  expect(view.shown).toEqual({ model: "gpt-6.1-sol", effort: "high", fast: null });
  expect(view.choices.map(choice => [choice.key, choice.candidates])).toEqual([
    ["model", ["gpt-6.1-sol", "gpt-6-astra"]], ["effort", ["high", "low", "xhigh"]], ["fast", [null, "fast"]],
  ]);
  expect(view.problems).toEqual([]);
});

test("a value chosen here that the settings stop offering stays to choose again, never quietly replaced, until chosen", () => {
  const before = offerOf("codex", { params: { model: ["a", "b"], effort: ["high"], fast: ["-", "fast"] } });
  const after = offerOf("codex", { params: { model: ["a"], effort: ["high"], fast: ["-", "fast"] } });
  expect(launchSelection(before, { model: "b" }).shown).toMatchObject({ model: "b" });
  const gone = launchSelection(after, { model: "b" });
  expect(gone.problems).toEqual([{ key: "model", previous: "b", candidates: ["a"], reason: "invalid_value", recovery: "select_value" }]);
  expect(Object.hasOwn(gone.shown, "model")).toBe(false);
  expect(launchSelection(after, { model: "a" })).toMatchObject({ shown: { model: "a" }, problems: [] });
});

test("for an agent whose models omit rows, what the choice shows is what admission launches with", () => {
  const setting = { params: { model: ["model-with-effort", "fixed-first"], effort: ["high", "low"] }, without: { "fixed-first": ["effort"] } };
  const served = compileAgentSetting("pi", setting);
  // As serve lists it: the rows and each model's omitted rows.
  const [offer] = agentOffers([{ key: "pi", choices: agentChoices(served), without: setting.without }]);
  const tries: Record<string, string | null>[] = [{}, { model: "fixed-first" }, { model: "fixed-first", effort: "low" }];
  for (const changes of tries) {
    const view = launchSelection(offer!.offer, changes);
    const admitted = resolveAgentSelection(served, view.shown);
    const launched = Object.fromEntries(admitted.choices.filter(choice => choice.active).map(choice => [choice.key, admitted.effective[choice.key]]));
    expect(view.shown).toEqual(launched);
  }
  expect(launchSelection(offer!.offer, { model: "fixed-first" }).choices.map(choice => choice.key)).toEqual(["model"]);
});

test("a model named like an object's own property is chosen and shown when no row leaves it out", () => {
  for (const name of ["constructor", "toString", "__proto__"]) {
    const [offer] = agentOffers([launchProfile("codex", { model: [name], effort: ["high", "low"] })]);
    expect(launchSelection(offer!.offer, { model: name, effort: "low" }).shown).toEqual({ model: name, effort: "low" });
  }
});
