import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import { barLimit, besideModelWindow, limitTone, resetWords, stoppedWords, windowLabel } from "../src/domain/limits";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
const week = (usedPercent: number, model: string | null = null): LimitWindow =>
  ({ kind: "weekly", minutes: 10_080, model, usedPercent, resetsAt: null });
const agent = (adapter: AgentLimits["adapter"], state: AgentLimits["state"], windows: LimitWindow[] = []): AgentLimits =>
  ({ adapter, state, windows, account: null, observedAt: state === "ok" ? "2026-11-24T00:00:00.000Z" : null });

const at = (iso: string, window: LimitWindow): LimitWindow => ({ ...window, resetsAt: iso });
const response = (agents: AgentLimits[], stack: { adapter: AgentLimits["adapter"]; model: string | null }[]) => ({ agents, stack });
const shownOf = (bar: ReturnType<typeof barLimit>) => bar && { kind: bar.kind, agent: bar.agent.adapter, percent: bar.window?.usedPercent ?? null,
  model: bar.window?.model ?? null, spent: bar.kind === "using" ? bar.spent.map(agent => agent.adapter) : [] };

test("the bar shows the first agent in the stack that can work now, and the window that holds it", () => {
  const claude = agent("claude", "ok", [week(85), week(100, "Fable")]), codex = agent("codex", "ok", [week(25)]);
  // A model's own window holds only the row on that model: Opus works on while Fable's week is spent.
  expect(shownOf(barLimit(response([claude, codex], [{ adapter: "claude", model: "opus" }]))))
    .toEqual({ kind: "using", agent: "claude", percent: 85, model: null, spent: [] });
  // The row on Fable is held by it (the provider's "Fable" is the row's "fable"), and work goes on to the next row.
  expect(shownOf(barLimit(response([claude, codex], [{ adapter: "claude", model: "fable" }, { adapter: "codex", model: null }]))))
    .toEqual({ kind: "using", agent: "codex", percent: 25, model: null, spent: ["claude"] });
  // A row without a model is held by the account's windows alone.
  expect(shownOf(barLimit(response([agent("claude", "ok", [week(40), week(90, "Fable")])], [{ adapter: "claude", model: null }]))))
    .toEqual({ kind: "using", agent: "claude", percent: 40, model: null, spent: [] });
  // Another model of the same agent standing in is not said to be another agent.
  expect(shownOf(barLimit(response([claude], [{ adapter: "claude", model: "fable" }, { adapter: "claude", model: "opus" }]))))
    .toEqual({ kind: "using", agent: "claude", percent: 85, model: null, spent: [] });
  // The user chose red from 80%.
  expect([79, 80, 100].map(limitTone)).toEqual(["normal", "near", "spent"]);
});

test("with every agent in the stack spent, the bar says the first and until when its last spent window holds it", () => {
  const claude = agent("claude", "ok", [at("2026-11-29T11:00:00Z", week(100)), at("2026-11-26T11:00:00Z", week(100, "Fable")), at("2026-11-30T00:00:00Z", week(100, "Sonnet"))]);
  const codex = agent("codex", "ok", [week(25)]);
  // Only the row's own windows: Sonnet's later reset does not hold Opus.
  expect(barLimit(response([claude, codex], [{ adapter: "claude", model: "fable" }])))
    .toMatchObject({ kind: "stopped", agent: { adapter: "claude" }, window: { resetsAt: "2026-11-29T11:00:00Z" } });
  // A stack whose next row is spent too stops on its first; the window names when.
  const spentCodex = agent("codex", "ok", [at("2026-11-27T00:00:00Z", week(100))]);
  expect(barLimit(response([claude, spentCodex], [{ adapter: "claude", model: "opus" }, { adapter: "codex", model: null }])))
    .toMatchObject({ kind: "stopped", agent: { adapter: "claude" } });
  const stopped = barLimit(response([claude], [{ adapter: "claude", model: "opus" }]));
  expect(stopped && stopped.kind === "stopped" && stoppedWords(stopped.window, "en", t)).toMatch(/29/);
  expect(stopped && stopped.kind === "stopped" && stoppedWords(stopped.window, "en", t, true)).not.toMatch(/:/);
});

test("an agent whose limits are unknown shows none in its place, one without limits is passed over, and no bar until one is known", () => {
  const codex = agent("codex", "ok", [week(9)]);
  expect(shownOf(barLimit(response([agent("claude", "unavailable"), codex], [{ adapter: "claude", model: "opus" }, { adapter: "codex", model: null }]))))
    .toEqual({ kind: "using", agent: "claude", percent: null, model: null, spent: [] });
  // After a spent agent too: the unknown one is where work goes, not the one after it.
  expect(shownOf(barLimit(response([agent("claude", "ok", [week(100)]), agent("codex", "unavailable"), agent("copilot", "ok", [week(5)])],
    [{ adapter: "claude", model: null }, { adapter: "codex", model: null }, { adapter: "copilot", model: null }]))))
    .toEqual({ kind: "using", agent: "codex", percent: null, model: null, spent: ["claude"] });
  // An agent without any limit (an API key) is no warning: the next row stands first.
  expect(shownOf(barLimit(response([agent("claude", "ok"), agent("grok", "unsupported"), codex],
    [{ adapter: "claude", model: null }, { adapter: "grok", model: null }, { adapter: "codex", model: null }]))))
    .toEqual({ kind: "using", agent: "codex", percent: 9, model: null, spent: [] });
  expect(barLimit(response([agent("claude", "unavailable"), agent("grok", "unsupported")], [{ adapter: "claude", model: null }]))).toBeNull();
});

test("every window has a name in words, a model's own window names its model, and the account's sets itself apart", () => {
  const named = (window: LimitWindow, scoped = false) => windowLabel(window, t, scoped);
  for (const window of [week(5), { ...week(5), kind: "session" as const, minutes: 300 }, { ...week(5), kind: "monthly" as const, minutes: null },
    { ...week(5), kind: "other" as const, minutes: null }, { ...week(5), kind: "other" as const, minutes: 1440 }])
    expect(named(window)).not.toMatch(/limits\.|^$/);
  expect(named(week(77, "Fable"))).toContain("Fable");
  expect(named(week(63), true)).not.toBe(named(week(63)));
  // Only the account's window over the same period as a model's own is set apart: a 5-hour one beside a model's week is not.
  const session: LimitWindow = { ...week(5), kind: "session", minutes: 300 }, windows = [session, week(63), week(77, "Fable")];
  expect(windows.map(window => besideModelWindow(window, windows))).toEqual([false, true, false]);
});

test("a reset within a day says how long until it, a later one when; a past one says nothing", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  const soon = resetWords("2026-11-24T02:10:00Z", now, "en", t), later = resetWords("2026-11-29T15:00:00Z", now, "en", t);
  expect(soon).toMatch(/2.*10/);
  // Whole hours say no "0 minutes".
  expect(resetWords("2026-11-24T04:00:00Z", now, "en", t)).not.toMatch(/\b0/);
  expect(later).not.toBeNull();
  expect(later).not.toBe(soon);
  // A reset stamped a moment before the hour is read as that hour.
  expect(resetWords("2026-11-29T14:59:59.900Z", now, "en", t)).toBe(later);
  expect(resetWords("2026-11-23T00:00:00Z", now, "en", t)).toBeNull();
});

test("a context limit's own mistakes are told as such", async () => {
  const { agentDraftIssueKind } = await import("../src/features/panels/agent-settings-issues");
  expect(agentDraftIssueKind({ field: "context", message: "Unknown model candidate" })).toBe("contextModel");
  expect(agentDraftIssueKind({ field: "without", message: "Unknown model candidate" })).toBe("withoutModel");
});
