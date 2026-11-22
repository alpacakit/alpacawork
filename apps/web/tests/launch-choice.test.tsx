import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyLaunchMemory, type LaunchMemory, type LaunchMemoryChange } from "@alpacawork/contract/agent-selection";
import { useConversationChanges, useLaunchChoice } from "../src/features/forms/launch-choice";
import { AgentPicker } from "../src/features/forms/AgentPicker";
import { agentLabel } from "../src/domain/agent-label";
import { launchProfile } from "./fixtures";

/** The server's launch memory as the index brings it, and the changes the screen saved to it. */
const given = vi.hoisted(() => ({ profiles: [] as unknown[], memory: { agent: null, values: {} } as LaunchMemory }));
vi.mock("../src/data/workspace-store", () => ({ useFrameSelector: (select: (value: unknown) => unknown) => select({ info: {
  profiles: given.profiles, launchMemory: given.memory,
} }) }));
vi.mock("../src/data/resources", () => ({ api: { request: vi.fn(async (_path: string, _schema: unknown, _signal: unknown, data: { change: LaunchMemoryChange }) => {
  given.memory = applyLaunchMemory(given.memory, data.change);
  return { memory: given.memory };
}) } }));
const codex = launchProfile("codex", { model: ["a", "b"] });
/** The configured Pi profile omits effort for fixed models. The Grok profile requires effort. */
const pi = launchProfile("pi", { model: ["model-with-effort", "fixed-first", "fixed-second"], effort: ["high", "low", "medium"] }, ["effort"],
  { "fixed-first": ["effort"], "fixed-second": ["effort"] });
/** A row a setting adds (tier) is offered like effort, with nothing written for it. */
const grok = launchProfile("grok", { model: ["grok-4.7"], effort: ["high", "low", "medium", "xhigh"], tier: ["standard", "priority"] });
const stored = () => given.memory;
beforeEach(() => { given.profiles = [codex]; given.memory = { agent: null, values: {} }; });
afterEach(() => { cleanup(); useConversationChanges.setState({ conversation: null, agent: null, changes: {} }); });

test.each([
  ["an agent offering low starts on it", launchProfile("claude", { model: ["opus", "fable"], effort: ["medium", "high", "low"] }), { model: "opus", effort: "low" }],
  ["an agent without low starts on its first effort", launchProfile("claude", { model: ["opus"], effort: ["high", "max"] }), { model: "opus", effort: "high" }],
  ["a first model without effort starts on none", launchProfile("pi", { model: ["fixed", "live"], effort: ["high", "low"] }, ["effort"], { fixed: ["effort"] }), { model: "fixed" }],
])("with nothing remembered, a new conversation starts on the first model and the lightest effort: %s", (_name, profile, start) => {
  given.profiles = [profile];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return null; }
  render(<Picker />);
  expect(choice.send).toEqual(start);
});

test("a choice made on another screen is where the next new conversation starts, with the agent last chosen", async () => {
  given.profiles = [codex, pi];
  given.memory = { agent: "pi", values: { pi: { model: "fixed-first" }, codex: { model: "b" } } };
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return null; }
  render(<Picker />);
  expect([choice.profile, choice.send]).toEqual(["pi", { model: "fixed-first" }]);
  // Picking another agent keeps each agent's values and remembers the agent, on the server.
  await act(async () => choice.chooseProfile("codex"));
  expect(choice.send).toEqual({ model: "b" });
  expect(stored()).toEqual({ agent: "codex", values: { pi: { model: "fixed-first" }, codex: { model: "b" } } });
});

test("a pick on a page an agent checks (?agent=1) changes its input but not the person's memory", async () => {
  history.replaceState(null, "", "/?agent=1");
  try {
    let choice!: ReturnType<typeof useLaunchChoice>;
    function Picker() { choice = useLaunchChoice(); return null; }
    render(<Picker />);
    await act(async () => choice.setSelected({ model: "b" }));
    expect(choice.send).toEqual({ model: "b" });
    expect(stored()).toEqual({ agent: null, values: {} });
  } finally { history.replaceState(null, "", "/"); }
});

test("the picker offers each row's written values, shallow to deep, never a 'none' the settings did not write", async () => {
  given.profiles = [pi, grok];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  expect(choice.selected).toEqual({ model: "model-with-effort", effort: "low" });
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  const steps = () => [...document.querySelectorAll<HTMLInputElement>('input[name="agent-effort"]')].map(input => input.parentElement!.textContent);
  expect(steps()).toEqual(["low", "medium", "high"]);
  expect(screen.queryByRole("radio", { name: "None" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "medium" }));
  await act(async () => {});
  expect(stored().values.pi).toEqual({ model: "model-with-effort", effort: "medium" });
  expect(choice.send).toEqual({ model: "model-with-effort", effort: "medium" });
  // A fixed model has no effort: no row of steps, and no effort in what is kept and sent.
  fireEvent.click(screen.getByRole("radio", { name: /fixed-first/ }));
  await act(async () => {});
  expect(steps()).toEqual([]);
  screen.getByText("agentPicker.notOffered");
  expect(choice.selected).toEqual({ model: "fixed-first" });
  expect(choice.send).toEqual({ model: "fixed-first" });
  expect(Object.hasOwn(stored().values.pi!, "effort")).toBe(false);
  expect(document.querySelector("[data-agent-picker]")!.getAttribute("aria-label")).not.toMatch(/low|high/);
  fireEvent.click(screen.getByRole("radio", { name: /grok-4\.7/ }));
  expect(choice.selected).toEqual({ model: "grok-4.7", effort: "low", tier: "standard" });
  expect(steps()).toEqual(["low", "medium", "high", "xhigh"]);
  expect([...document.querySelectorAll<HTMLInputElement>('input[name="agent-tier"]')].map(input => input.parentElement!.textContent)).toEqual(["standard", "priority"]);
  fireEvent.click(screen.getByRole("radio", { name: /model-with-effort/ }));
  expect(choice.selected).toEqual({ model: "model-with-effort", effort: "low" });
});

test.each([
  [{ model: "fixed-first", effort: "max" }, { model: "fixed-first" }],
  [{ model: "fixed-first", effort: "low" }, { model: "fixed-first" }],
  [{ model: "model-with-effort", effort: "xhigh" }, { model: "model-with-effort", effort: "high" }],
  [{ model: "gone-model", effort: "low" }, { model: "model-with-effort", effort: "low" }],
  [{ model: "model-with-effort", effort: "low", tier: "old" }, { model: "model-with-effort", effort: "low" }],
])("a choice remembered before, %o, is shown and sent as %o", (saved, shown) => {
  given.profiles = [pi];
  given.memory = { agent: "pi", values: { pi: saved } };
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  expect(choice.selected).toEqual(shown);
  expect(choice.send).toEqual(shown);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  expect(screen.queryAllByRole("radio", { name: /^(low|medium|high|xhigh|max)$/ })).toHaveLength("effort" in shown ? 3 : 0);
});

test("an effort left out (a written -) is left out of the picker's heading, while a Run's unknown effort is still said so", () => {
  given.profiles = [launchProfile("pi", { model: ["model-with-effort"], effort: ["-", "high"] }, ["effort"])];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  const effort = [...document.querySelectorAll<HTMLInputElement>('input[name="agent-effort"]')];
  // "None" is offered only because the settings wrote it, first.
  fireEvent.click(effort[1]!); fireEvent.click(effort[0]!);
  expect(choice.selected).toEqual({ model: "model-with-effort", effort: null });
  expect(document.querySelector("[data-agent-picker]")!.getAttribute("title")).toBe("model-with-effort");
  expect(agentLabel("model-with-effort", null, "pi")).toMatch(/\(.+\)$/);
});

test("a required row of one value whose previous value is no longer offered can be chosen again", () => {
  given.profiles = [launchProfile("claude", { model: ["opus"], effort: ["high"] })];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice({ id: "c1", agent: "claude", previous: { model: "opus", effort: "low" } }); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  expect(choice.ready).toBe(false);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  fireEvent.click(screen.getByRole("radio", { name: "high" }));
  expect(choice.ready).toBe(true);
  expect(choice.send).toEqual({ effort: "high" });
});

test("a conversation whose agent the settings no longer enable does not go to another agent until the person picks one", () => {
  given.profiles = [codex];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice({ id: "c1", agent: "claude", previous: { model: "opus" } }); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  expect([choice.profile, choice.gone, choice.ready]).toEqual(["claude", "claude", false]);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  fireEvent.click(screen.getByRole("radio", { name: "a" }));
  expect([choice.profile, choice.gone, choice.ready]).toEqual(["codex", null, true]);
});

test("a value chosen for a new launch that the settings stop offering stays to choose again and does not go", () => {
  let choice!: ReturnType<typeof useLaunchChoice>, bump!: () => void;
  function Picker() {
    const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1);
    choice = useLaunchChoice({ id: "fresh", agent: null, previous: null }); return <AgentPicker choice={choice} />;
  }
  render(<Picker />);
  act(() => choice.setSelected({ model: "b" }));
  expect(choice.send).toEqual({ model: "b" });
  given.profiles = [launchProfile("codex", { model: ["a"] })];
  act(() => bump());
  expect(choice.ready).toBe(false);
  expect(choice.problems.map(problem => [problem.key, problem.previous])).toEqual([["model", "b"]]);
});

test("a value chosen here for a row the model leaves out, gone from the settings, can be settled there, then the row is out of sight again", () => {
  given.profiles = [launchProfile("pi", { model: ["live", "fixed"], effort: ["high", "low"] }, ["effort"], { fixed: ["effort"] })];
  let choice!: ReturnType<typeof useLaunchChoice>, bump!: () => void;
  function Picker() {
    const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1);
    choice = useLaunchChoice({ id: "fresh", agent: null, previous: null }); return <AgentPicker choice={choice} />;
  }
  render(<Picker />);
  act(() => choice.setSelected({ effort: "low" }));
  act(() => choice.setSelected({ model: "fixed" }));
  expect(choice.ready).toBe(true);
  given.profiles = [launchProfile("pi", { model: ["fixed"], effort: ["high"] }, ["effort"], { fixed: ["effort"] })];
  act(() => bump());
  expect(choice.ready).toBe(false);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  const steps = () => [...document.querySelectorAll<HTMLInputElement>('input[name="agent-effort"]')];
  expect(steps()).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: "high" }));
  expect(choice.ready).toBe(true);
  expect(choice.selected).toEqual({ model: "fixed" });
  expect(steps()).toHaveLength(0);
});

test("the picker's button opens and closes it without a pointer, and Enter takes the choice except while an IME composes", () => {
  function Picker() { return <AgentPicker choice={useLaunchChoice()} />; }
  render(<Picker />);
  const button = document.querySelector<HTMLElement>("[data-agent-picker]")!, menu = () => document.querySelector("[data-agent-picker-menu]");
  fireEvent.click(button); expect(menu()).not.toBeNull();
  fireEvent.click(button); expect(menu()).toBeNull();
  const row = () => document.querySelector<HTMLElement>('input[name="agent-pick"]')!;
  fireEvent.click(button);
  fireEvent.keyDown(row(), { key: "Enter", keyCode: 13 }); expect(menu()).toBeNull();
  fireEvent.click(button);
  fireEvent.keyDown(row(), { key: "Enter", keyCode: 229 }); expect(menu()).not.toBeNull();
});
