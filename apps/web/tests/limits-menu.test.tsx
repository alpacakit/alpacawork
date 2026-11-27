import { afterEach, beforeAll, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { AgentLimits, AgentLimitsResponse, LimitWindow } from "@alpacawork/contract/agent-limits";
import { queryClient } from "../src/data/query-client";
import { resources } from "../src/data/resources";
import { LimitsMenu } from "../src/features/chrome/LimitsMenu";
import { TestWorkspace } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); queryClient.clear(); });
const week = (usedPercent: number, model: string | null = null): LimitWindow =>
  ({ kind: "weekly", minutes: 10_080, model, usedPercent, resetsAt: null });
const agent = (adapter: AgentLimits["adapter"], windows: LimitWindow[]): AgentLimits =>
  ({ adapter, state: "ok", windows, account: null, observedAt: new Date().toISOString() });

function open(limits: AgentLimitsResponse) {
  queryClient.setQueryData(resources.agentLimits("/fixture").queryKey, limits);
  render(<TestWorkspace><LimitsMenu /></TestWorkspace>);
  const trigger = document.querySelector<HTMLElement>("[data-limits-trigger]")!;
  const bar = trigger.textContent;
  fireEvent.click(trigger);
  return { bar, trigger };
}

test("the bar shows each agent as its mark and ring, without names, and says the windows aloud; the menu marks the window of the agent work goes on with", () => {
  const { bar, trigger } = open({ agents: [agent("claude", [week(100)]), agent("codex", [week(25)])],
    stack: [{ adapter: "claude", model: "opus" }, { adapter: "codex", model: null }] });
  expect(bar?.trim()).toBe("");
  expect([...trigger.querySelectorAll("[data-limits-agent]")].map(slot => slot.getAttribute("data-limits-agent"))).toEqual(["claude", "codex"]);
  expect(trigger.getAttribute("aria-label")).toMatch(/Claude[\s\S]*Codex.*25%/);
  expect(document.querySelectorAll("[data-limit-shown]")).toHaveLength(1);
  expect(document.querySelector("[data-limit-shown]")?.closest("[data-limit-agent]")?.getAttribute("data-limit-agent")).toBe("codex");
});

test("the menu says which agents tasks use, and drops a reset window's old figure", () => {
  const reset: LimitWindow = { ...week(100), resetsAt: new Date(Date.now() - 60_000).toISOString() };
  open({ agents: [agent("claude", [reset]), agent("codex", [week(27)])], stack: [{ adapter: "claude", model: "opus" }] });
  const block = (adapter: string) => document.querySelector<HTMLElement>(`[data-limit-agent=${adapter}]`)!;
  expect(block("claude").querySelector("[data-limit-place]")?.textContent).toBe("Primary (opus)");
  expect(block("codex").querySelector("[data-limit-place]")?.textContent).toBe("Not in “AI for tasks”");
  expect(block("claude").textContent).not.toMatch(/100%/);
  expect(block("claude").textContent).toMatch(/Reset · the new usage is not read yet/);
});
