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

test("the bar names only the agent, without the window or the percent, but says them aloud; the menu marks the window the bar shows", () => {
  const { bar, trigger } = open({ agents: [agent("claude", [week(85), week(100, "Fable")]), agent("codex", [week(25)])],
    stack: [{ adapter: "claude", model: "opus" }, { adapter: "codex", model: null }] });
  expect(bar?.trim()).toBe("Claude");
  expect(trigger.getAttribute("aria-label")).toMatch(/85%/);
  expect(screen.getByRole("dialog").querySelector("[data-limit-shown]")?.closest("[data-limit-agent]")?.getAttribute("data-limit-agent")).toBe("claude");
  expect(document.querySelectorAll("[data-limit-shown]")).toHaveLength(1);
});

test("with the first agent spent, the bar shows only the next one, the agent work goes on with", () => {
  const { bar, trigger } = open({ agents: [agent("claude", [week(100)]), agent("codex", [week(25)])],
    stack: [{ adapter: "claude", model: "opus" }, { adapter: "codex", model: null }] });
  expect(bar?.trim()).toBe("Codex");
  expect(trigger.getAttribute("aria-label")).toMatch(/Codex.*25%/);
  expect(document.querySelector("[data-limit-shown]")?.closest("[data-limit-agent]")?.getAttribute("data-limit-agent")).toBe("codex");
});
