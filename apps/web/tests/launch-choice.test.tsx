import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useConversationChanges, useLaunchChoice } from "../src/features/forms/launch-choice";
import { AgentPicker } from "../src/features/forms/AgentPicker";
import { agentLabel } from "../src/domain/agent-label";
import { launchProfile } from "./fixtures";

const given = vi.hoisted(() => ({ profiles: [] as unknown[] }));
vi.mock("../src/data/workspace-store", () => ({ useFrameSelector: (select: (value: unknown) => unknown) => select({ info: {
  profiles: given.profiles,
} }) }));
const codex = launchProfile("codex", { model: ["a", "b"] });
/** agy's fixed models have no effort; grok's must be given. */
const agy = launchProfile("agy", { model: ["gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking"], effort: ["high", "low", "medium"] }, ["effort"],
  { "claude-sonnet-4-6": ["effort"], "claude-opus-4-6-thinking": ["effort"] });
/** A row a setting adds (tier) is offered like effort, with nothing written for it. */
const grok = launchProfile("grok", { model: ["grok-4.7"], effort: ["high", "low", "medium", "xhigh"], tier: ["standard", "priority"] });
const stored = () => JSON.parse(localStorage.getItem("alpacawork.launchChoice")!) as { agent: string; values: Record<string, Record<string, string>> };
beforeEach(() => { given.profiles = [codex]; localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null })); });
afterEach(() => { cleanup(); useConversationChanges.setState({ conversation: null, agent: null, changes: {} }); });

test.each([true, false])("two prompt inputs show the chosen model when the other tab's notification arrives first=%s", (eventFirst) => {
  localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
  let first!: ReturnType<typeof useLaunchChoice>;
  function Display({ owner = false }: { owner?: boolean }) {
    const choice = useLaunchChoice(); if (owner) first = choice;
    return <span>{choice.selected.model}</span>;
  }
  render(<><Display owner /><Display /></>); expect(screen.getAllByText("a")).toHaveLength(2);
  localStorage.setItem("alpacawork.launchChoice", JSON.stringify({ agent: "codex", values: { codex: { model: "b" } } }));
  if (eventFirst) act(() => window.dispatchEvent(new StorageEvent("storage", { key: "alpacawork.launchChoice" })));
  act(() => first.setSelected({ model: "b" }));
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "alpacawork.launchChoice" })));
  expect(screen.getAllByText("b")).toHaveLength(2);
});

test.each([true, false])("an input that rendered an intermediate model returns to the default after removal, initial event first=%s", (eventFirst) => {
  localStorage.clear(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
  let first!: ReturnType<typeof useLaunchChoice>, bump!: () => void;
  function First() {
    const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1);
    first = useLaunchChoice(); return <span>{first.selected.model}</span>;
  }
  function Second() { return <span>{useLaunchChoice().selected.model}</span>; }
  render(<><First /><Second /></>); expect(screen.getAllByText("a")).toHaveLength(2);
  localStorage.setItem("alpacawork.launchChoice", JSON.stringify({ agent: "codex", values: { codex: { model: "b" } } }));
  if (eventFirst) act(() => window.dispatchEvent(new StorageEvent("storage", { key: "alpacawork.launchChoice" })));
  act(() => bump());
  expect(screen.getAllByText("b")).toHaveLength(eventFirst ? 2 : 1);
  localStorage.removeItem("alpacawork.launchChoice");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "alpacawork.launchChoice" })));
  expect(screen.getAllByText("a")).toHaveLength(2); expect(first.selected).toEqual({ model: "a" });
});

test("the picker offers each row's written values, shallow to deep, never a 'none' the settings did not write", () => {
  given.profiles = [agy, grok];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  expect(choice.selected).toEqual({ model: "gemini-3.8-flash", effort: "high" });
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  const steps = () => [...document.querySelectorAll<HTMLInputElement>('input[name="agent-effort"]')].map(input => input.parentElement!.textContent);
  expect(steps()).toEqual(["low", "medium", "high"]);
  expect(screen.queryByRole("radio", { name: "None" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "low" }));
  expect(stored().values.agy).toEqual({ model: "gemini-3.8-flash", effort: "low" });
  expect(choice.send).toEqual({ model: "gemini-3.8-flash", effort: "low" });
  // A fixed model has no effort: no row of steps, and no effort in what is kept and sent.
  fireEvent.click(screen.getByRole("radio", { name: /claude-sonnet-4-6/ }));
  expect(steps()).toEqual([]);
  screen.getByText("agentPicker.notOffered");
  expect(choice.selected).toEqual({ model: "claude-sonnet-4-6" });
  expect(choice.send).toEqual({ model: "claude-sonnet-4-6" });
  expect(Object.hasOwn(stored().values.agy!, "effort")).toBe(false);
  expect(document.querySelector("[data-agent-picker]")!.getAttribute("aria-label")).not.toMatch(/low|high/);
  fireEvent.click(screen.getByRole("radio", { name: /grok-4\.7/ }));
  expect(choice.selected).toEqual({ model: "grok-4.7", effort: "high", tier: "standard" });
  expect(steps()).toEqual(["low", "medium", "high", "xhigh"]);
  expect([...document.querySelectorAll<HTMLInputElement>('input[name="agent-tier"]')].map(input => input.parentElement!.textContent)).toEqual(["standard", "priority"]);
  fireEvent.click(screen.getByRole("radio", { name: /gemini-3\.8-flash/ }));
  expect(choice.selected).toEqual({ model: "gemini-3.8-flash", effort: "high" });
});

test.each([
  [{ model: "claude-sonnet-4-6", effort: "max" }, { model: "claude-sonnet-4-6" }],
  [{ model: "claude-sonnet-4-6", effort: "low" }, { model: "claude-sonnet-4-6" }],
  [{ model: "gemini-3.8-flash", effort: "xhigh" }, { model: "gemini-3.8-flash", effort: "high" }],
  [{ model: "gone-model", effort: "low" }, { model: "gemini-3.8-flash", effort: "low" }],
  [{ model: "gemini-3.8-flash", effort: "low", tier: "old" }, { model: "gemini-3.8-flash", effort: "low" }],
])("a choice saved on this device before, %o, is shown and sent as %o", (saved, shown) => {
  given.profiles = [agy];
  localStorage.setItem("alpacawork.launchChoice", JSON.stringify({ agent: "agy", values: { agy: saved } }));
  window.dispatchEvent(new StorageEvent("storage", { key: "alpacawork.launchChoice" }));
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  expect(choice.selected).toEqual(shown);
  expect(choice.send).toEqual(shown);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  expect(screen.queryAllByRole("radio", { name: /^(low|medium|high|xhigh|max)$/ })).toHaveLength("effort" in shown ? 3 : 0);
});

test("an effort left out (a written -) is left out of the picker's heading, while a Run's unknown effort is still said so", () => {
  given.profiles = [launchProfile("agy", { model: ["gemini-3.8-flash"], effort: ["-", "high"] }, ["effort"])];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return <AgentPicker choice={choice} />; }
  render(<Picker />);
  fireEvent.click(document.querySelector("[data-agent-picker]")!);
  const effort = [...document.querySelectorAll<HTMLInputElement>('input[name="agent-effort"]')];
  // "None" is offered only because the settings wrote it, first.
  fireEvent.click(effort[1]!); fireEvent.click(effort[0]!);
  expect(choice.selected).toEqual({ model: "gemini-3.8-flash", effort: null });
  expect(document.querySelector("[data-agent-picker]")!.getAttribute("title")).toBe("gemini-3.8-flash");
  expect(agentLabel("gemini-3.8-flash", null, "agy")).toMatch(/\(.+\)$/);
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
  given.profiles = [launchProfile("agy", { model: ["live", "fixed"], effort: ["high", "low"] }, ["effort"], { fixed: ["effort"] })];
  let choice!: ReturnType<typeof useLaunchChoice>, bump!: () => void;
  function Picker() {
    const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1);
    choice = useLaunchChoice({ id: "fresh", agent: null, previous: null }); return <AgentPicker choice={choice} />;
  }
  render(<Picker />);
  act(() => choice.setSelected({ effort: "low" }));
  act(() => choice.setSelected({ model: "fixed" }));
  expect(choice.ready).toBe(true);
  given.profiles = [launchProfile("agy", { model: ["fixed"], effort: ["high"] }, ["effort"], { fixed: ["effort"] })];
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
