import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applyLaunchMemory, type LaunchMemory, type LaunchMemoryChange } from "@alpacawork/contract/agent-selection";
import { useConversationChanges, useLaunchChoice, useLaunchRecord } from "../src/features/forms/launch-choice";
import { notify } from "../src/lib/notify";
import { AgentPicker } from "../src/features/forms/AgentPicker";
import { agentLabel } from "../src/domain/agent-label";
import { launchProfile } from "./fixtures";

/**
 * The server's launch memory (`server`) and the copy the index brings (`index`), published with the save unless
 * `lagging`. A save waits for `gate` when one is set, and is refused while `refuse`.
 */
const given = vi.hoisted(() => ({ profiles: [] as unknown[], server: null as unknown as LaunchMemory, index: null as unknown as LaunchMemory,
  refuse: false, lagging: false, gate: null as Promise<void> | null, firstOnly: false, order: [] as unknown[] }));
vi.mock("../src/data/workspace-store", () => ({ useFrameSelector: (select: (value: unknown) => unknown) => select({ info: {
  profiles: given.profiles, launchMemory: given.index,
} }) }));
vi.mock("../src/data/resources", () => ({ api: { request: vi.fn(async (_path: string, _schema: unknown, _signal: unknown, data: { change: LaunchMemoryChange }) => {
  given.order.push(data.change);
  if (given.gate && (!given.firstOnly || given.order.length === 1)) await given.gate;
  if (given.refuse) throw new Error("refused");
  given.server = applyLaunchMemory(given.server, data.change);
  if (!given.lagging) given.index = given.server;
  return { memory: given.server };
}) } }));
/** What another screen left on the server, as the index has it. */
const share = (memory: Omit<LaunchMemory, "version">, version = given.server.version + 1) => { given.server = given.index = { ...memory, version }; };
const codex = launchProfile("codex", { model: ["a", "b"] });
/** The configured Pi profile omits effort for fixed models. The Grok profile requires effort. */
const pi = launchProfile("pi", { model: ["model-with-effort", "fixed-first", "fixed-second"], effort: ["high", "low", "medium"] }, ["effort"],
  { "fixed-first": ["effort"], "fixed-second": ["effort"] });
/** A row a setting adds (tier) is offered like effort, with nothing written for it. */
const grok = launchProfile("grok", { model: ["grok-4.7"], effort: ["high", "low", "medium", "xhigh"], tier: ["standard", "priority"] });
const stored = () => given.server;
beforeEach(() => { given.profiles = [codex]; given.server = given.index = { agent: null, values: {}, version: 0 }; Object.assign(given, { refuse: false, lagging: false, gate: null, firstOnly: false, order: [] }); });
afterEach(() => { cleanup(); useConversationChanges.setState({ conversation: null, agent: null, changes: {} }); useLaunchRecord.setState({ record: null, saving: [] }); vi.restoreAllMocks(); });

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

test("the task defaults do not decide where the coordinator starts", () => {
  const claude = launchProfile("claude", { model: ["opus", "fable"], effort: ["medium", "high", "low"] });
  // The tasks start on fable and high (each row's initial value); the coordinator still starts on the first model and low.
  given.profiles = [{ ...claude, choices: claude.choices.map(choice => ({ ...choice, initial: choice.key === "model" ? "fable" : "high" })) }];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return null; }
  render(<Picker />);
  expect(choice.send).toEqual({ model: "opus", effort: "low" });
});

test("a choice made on another screen is where the next new conversation starts, with the agent last chosen", async () => {
  given.profiles = [codex, pi];
  share({ agent: "pi", values: { pi: { model: "fixed-first" }, codex: { model: "b" } } });
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice(); return null; }
  render(<Picker />);
  expect([choice.profile, choice.send]).toEqual(["pi", { model: "fixed-first" }]);
  // Picking another agent keeps each agent's values and remembers the agent, on the server.
  await act(async () => choice.chooseProfile("codex"));
  expect(choice.send).toEqual({ model: "b" });
  expect(stored()).toMatchObject({ agent: "codex", values: { pi: { model: "fixed-first" }, codex: { model: "b" } } });
});

test("a message inherits the conversation's AI after its own choice was admitted", async () => {
  given.profiles = [codex, pi];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker({ agent, previous }: { agent: string; previous: { model: string } }) {
    choice = useLaunchChoice({ id: "c1", agent, previous });
    return null;
  }
  const view = render(<Picker agent="codex" previous={{ model: "a" }} />);
  expect([choice.sendAgent, choice.send]).toEqual([undefined, {}]);
  await act(async () => choice.setSelected({ model: "b" }));
  expect([choice.sendAgent, choice.send]).toEqual(["codex", { model: "b" }]);
  view.rerender(<Picker agent="codex" previous={{ model: "b" }} />);
  expect([choice.sendAgent, choice.send]).toEqual([undefined, {}]);
  view.rerender(<Picker agent="pi" previous={{ model: "fixed-first" }} />);
  expect([choice.profile, choice.sendAgent, choice.send]).toEqual(["pi", undefined, {}]);
  expect(stored().values.codex).toEqual({ model: "b" });
});

test("a conversation whose launch never got going (no previous values) starts as a new one: the memory's agent and values", () => {
  const claude = launchProfile("claude", { model: ["opus", "fable"], effort: ["medium", "high", "low"] });
  given.profiles = [claude, codex];
  let choice!: ReturnType<typeof useLaunchChoice>;
  function Picker() { choice = useLaunchChoice({ id: "c1", agent: "claude", previous: null }); return null; }
  const view = render(<Picker />);
  expect([choice.profile, choice.send]).toEqual(["claude", { model: "opus", effort: "low" }]);
  share({ agent: "codex", values: { codex: { model: "b" } } });
  view.rerender(<Picker />);
  expect([choice.profile, choice.send]).toEqual(["codex", { model: "b" }]);
  // The conversation's agent, no longer enabled, does not hold the send back.
  given.profiles = [codex];
  view.rerender(<Picker />);
  expect([choice.profile, choice.ready]).toEqual(["codex", true]);
});

test("a pick on a page an agent checks (?agent=1) changes its input but not the person's memory", async () => {
  history.replaceState(null, "", "/?agent=1");
  try {
    let choice!: ReturnType<typeof useLaunchChoice>;
    function Picker() { choice = useLaunchChoice(); return null; }
    render(<Picker />);
    await act(async () => choice.setSelected({ model: "b" }));
    expect(choice.send).toEqual({ model: "b" });
    expect(stored()).toEqual({ agent: null, values: {}, version: 0 });
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
  // Only the row chosen is kept: the model, never chosen, goes on following the config.
  expect(stored().values.pi).toEqual({ effort: "medium" });
  expect(choice.send).toEqual({ model: "model-with-effort", effort: "medium" });
  // A fixed model has no effort: no row of steps, and no effort in what is kept and sent.
  fireEvent.click(screen.getByRole("radio", { name: /fixed-first/ }));
  await act(async () => {});
  expect(steps()).toEqual([]);
  screen.getByText("agentPicker.notOffered");
  expect(choice.selected).toEqual({ model: "fixed-first" });
  expect(choice.send).toEqual({ model: "fixed-first" });
  // The effort chosen before is kept for when a model with one is chosen again.
  expect(stored().values.pi).toEqual({ effort: "medium", model: "fixed-first" });
  expect(document.querySelector("[data-agent-picker]")!.getAttribute("aria-label")).not.toMatch(/low|high/);
  fireEvent.click(screen.getByRole("radio", { name: /grok-4\.7/ }));
  expect(choice.selected).toEqual({ model: "grok-4.7", effort: "low", tier: "standard" });
  expect(steps()).toEqual(["low", "medium", "high", "xhigh"]);
  expect([...document.querySelectorAll<HTMLInputElement>('input[name="agent-tier"]')].map(input => input.parentElement!.textContent)).toEqual(["standard", "priority"]);
  fireEvent.click(screen.getByRole("radio", { name: /model-with-effort/ }));
  expect(choice.selected).toEqual({ model: "model-with-effort", effort: "medium" });
});

test.each([
  [{ model: "fixed-first", effort: "max" }, { model: "fixed-first" }],
  [{ model: "fixed-first", effort: "low" }, { model: "fixed-first" }],
  [{ model: "model-with-effort", effort: "xhigh" }, { model: "model-with-effort", effort: "low" }],
  [{ model: "gone-model", effort: "low" }, { model: "model-with-effort", effort: "low" }],
  [{ model: "model-with-effort", effort: "low", tier: "old" }, { model: "model-with-effort", effort: "low" }],
])("a choice remembered before, %o, is shown and sent as %o", (saved, shown) => {
  given.profiles = [pi];
  share({ agent: "pi", values: { pi: saved } });
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

function newConversation() {
  let choice!: ReturnType<typeof useLaunchChoice>, bump!: () => void;
  function Picker() {
    const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1);
    choice = useLaunchChoice({ id: "fresh", agent: null, previous: null }); return null;
  }
  render(<Picker />);
  return { choice: () => choice, bump: () => act(() => bump()) };
}

test.each([["the save's answer", true], ["the index", false]])("a pick goes with the send whether %s comes first", async (_first, answerFirst) => {
  const input = newConversation();
  let open!: () => void;
  given.gate = new Promise(resolve => { open = resolve; });
  given.lagging = answerFirst;
  act(() => input.choice().setSelected({ model: "b" }));
  // Shown at once; the send waits while it is being saved.
  expect([input.choice().send, input.choice().saving]).toEqual([{ model: "b" }, true]);
  if (!answerFirst) { given.server = given.index = applyLaunchMemory(given.server, { kind: "choose", agent: "codex", values: { model: "b" } }); input.bump(); }
  await act(async () => { open(); await given.gate; });
  if (answerFirst) {
    expect([input.choice().send, input.choice().saving]).toEqual([{ model: "b" }, false]);
    // The index catches up later with the same version: nothing changes.
    given.index = given.server; input.bump();
  }
  expect([input.choice().send, input.choice().saving]).toEqual([{ model: "b" }, false]);
});

test("two picks in a row reach the server in order, and the later one stays", async () => {
  given.profiles = [launchProfile("claude", { model: ["opus"], effort: ["medium", "high", "low"] })];
  const input = newConversation();
  // The first save is slow: the second must not overtake it.
  let open!: () => void;
  given.gate = new Promise(resolve => { open = resolve; }); given.firstOnly = true;
  act(() => input.choice().setSelected({ effort: "high" }));
  act(() => input.choice().setSelected({ effort: "medium" }));
  await act(async () => {});
  expect(input.choice().send).toEqual({ model: "opus", effort: "medium" });
  await act(async () => { open(); await given.gate; });
  expect(given.order).toEqual([{ kind: "choose", agent: "claude", values: { effort: "high" } }, { kind: "choose", agent: "claude", values: { effort: "medium" } }]);
  expect(stored().values.claude).toEqual({ effort: "medium" });
  expect(input.choice().send).toEqual({ model: "opus", effort: "medium" });
});

test("after a save, a later choice from another screen leads; an older copy does not", async () => {
  const input = newConversation();
  given.lagging = true;
  await act(async () => input.choice().setSelected({ model: "b" }));
  // An index older than the answer is not read.
  input.bump();
  expect(input.choice().send).toEqual({ model: "b" });
  share({ agent: "codex", values: { codex: { model: "a" } } });
  input.bump();
  expect(input.choice().send).toEqual({ model: "a" });
});

test("a pick whose save is refused is said, and the new conversation keeps what this screen had", async () => {
  share({ agent: "codex", values: { codex: { model: "a" } } });
  given.refuse = true;
  const failure = vi.spyOn(notify, "failure").mockImplementation(() => undefined as never);
  const input = newConversation();
  act(() => input.choice().setSelected({ model: "b" }));
  expect(input.choice().send).toEqual({ model: "b" });
  await act(async () => {});
  expect(failure).toHaveBeenCalledOnce();
  expect([input.choice().send, input.choice().saving]).toEqual([{ model: "a" }, false]);
});

test("a value chosen here for a row the model leaves out, gone from the settings, can be settled there, then the row is out of sight again", () => {
  given.profiles = [launchProfile("pi", { model: ["live", "fixed"], effort: ["high", "low"] }, ["effort"], { fixed: ["effort"] })];
  let choice!: ReturnType<typeof useLaunchChoice>, bump!: () => void;
  function Picker() {
    const [, renderAgain] = useState(0); bump = () => renderAgain(n => n + 1);
    choice = useLaunchChoice({ id: "c1", agent: "pi", previous: { model: "live", effort: "high" } }); return <AgentPicker choice={choice} />;
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
