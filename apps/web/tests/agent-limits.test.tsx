import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import { barLimit, barLimits, besideModelWindow, limitTone, resetWords, stoppedWords, windowLabel } from "../src/domain/limits";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
const week = (usedPercent: number, model: string | null = null): LimitWindow =>
  ({ kind: "weekly", minutes: 10_080, model, usedPercent, resetsAt: null });
const agent = (adapter: AgentLimits["adapter"], state: AgentLimits["state"], windows: LimitWindow[] = []): AgentLimits =>
  ({ adapter, state, windows, account: null, observedAt: state === "ok" ? "2026-11-24T00:00:00.000Z" : null });

const NOW = Date.parse("2026-11-25T00:00:00Z");
const at = (iso: string, window: LimitWindow): LimitWindow => ({ ...window, resetsAt: iso });
const response = (agents: AgentLimits[], stack: { adapter: AgentLimits["adapter"]; model: string | null }[]) => ({ agents, stack });
const shownOf = (bar: ReturnType<typeof barLimit>) => bar && { kind: bar.kind, agent: bar.agent.adapter,
  percent: bar.kind === "limited" || bar.kind === "stopped" ? bar.window.usedPercent : null };
const row = (adapter: AgentLimits["adapter"], model: string | null = null) => ({ adapter, model });

test("the bar shows the first agent in the stack that can work now, and the window that holds it", () => {
  const claude = agent("claude", "ok", [week(85), week(100, "Fable")]), codex = agent("codex", "ok", [week(25)]);
  // A model's own window holds only the row on that model: Opus works on while Fable's week is spent.
  expect(shownOf(barLimit(response([claude, codex], [row("claude", "opus")]), NOW)))
    .toEqual({ kind: "limited", agent: "claude", percent: 85 });
  // The row on Fable is held by it (the provider's "Fable" is the row's "fable"), and work goes on to the next row.
  expect(shownOf(barLimit(response([claude, codex], [row("claude", "fable"), row("codex")]), NOW)))
    .toEqual({ kind: "limited", agent: "codex", percent: 25 });
  // A row without a model is held by the account's windows alone.
  expect(shownOf(barLimit(response([agent("claude", "ok", [week(40), week(90, "Fable")])], [row("claude")]), NOW)))
    .toEqual({ kind: "limited", agent: "claude", percent: 40 });
  // Another model of the same agent standing in keeps that agent in the bar.
  expect(shownOf(barLimit(response([claude], [row("claude", "fable"), row("claude", "opus")]), NOW)))
    .toEqual({ kind: "limited", agent: "claude", percent: 85 });
  // The user chose red from 80%.
  expect([79, 80, 100].map(limitTone)).toEqual(["normal", "near", "spent"]);
});

test("after a reset the bar uses the current window, or says the limit has reset until the agent's new reading", () => {
  const expired = at("2026-11-24T23:00:00Z", week(100));
  const codex = agent("codex", "ok", [week(25)]);
  const stack = [row("claude"), row("codex")];
  expect(shownOf(barLimit(response([agent("claude", "ok", [expired]), codex], stack), NOW)))
    .toEqual({ kind: "reset", agent: "claude", percent: null });
  const session: LimitWindow = { ...week(45), kind: "session", minutes: 300 };
  expect(shownOf(barLimit(response([agent("claude", "ok", [expired, session]), codex], stack), NOW)))
    .toEqual({ kind: "limited", agent: "claude", percent: 45 });
});

test("with every agent in the stack spent, the bar says the one that works again first and until when its last spent window holds it", () => {
  const claude = agent("claude", "ok", [at("2026-11-29T11:00:00Z", week(100)), at("2026-11-26T11:00:00Z", week(100, "Fable")), at("2026-11-30T00:00:00Z", week(100, "Sonnet"))]);
  const codex = agent("codex", "ok", [week(25)]);
  // Only the row's own windows: Sonnet's later reset does not hold Opus.
  expect(barLimit(response([claude, codex], [row("claude", "fable")]), NOW))
    .toMatchObject({ kind: "stopped", agent: { adapter: "claude" }, window: { resetsAt: "2026-11-29T11:00:00Z" } });
  // A fallback back before the primary is where work starts again: the bar's date is when anything works, not the primary's.
  const spentCodex = agent("codex", "ok", [at("2026-11-27T00:00:00Z", week(100))]);
  expect(barLimit(response([claude, spentCodex], [row("claude", "opus"), row("codex")]), NOW))
    .toMatchObject({ kind: "stopped", agent: { adapter: "codex" }, window: { resetsAt: "2026-11-27T00:00:00Z" } });
  // A row whose return has no known time never comes before a known one; with none known the first row stands.
  const unknownCodex = agent("codex", "ok", [week(100)]);
  expect(barLimit(response([unknownCodex, claude], [row("codex"), row("claude", "opus")]), NOW))
    .toMatchObject({ kind: "stopped", agent: { adapter: "claude" }, window: { resetsAt: "2026-11-29T11:00:00Z" } });
  expect(barLimit(response([unknownCodex, agent("claude", "ok", [week(100)])], [row("codex"), row("claude")]), NOW))
    .toMatchObject({ kind: "stopped", agent: { adapter: "codex" }, window: { resetsAt: null } });
  const stopped = barLimit(response([claude], [row("claude", "opus")]), NOW);
  expect(stopped && stopped.kind === "stopped" && stoppedWords(stopped.window, NOW, "en", t)).toMatch(/29/);
  // A narrow bar says the time when the agent is back later today on this device's clock, and the day when it is not.
  const morning = new Date(2026, 10, 25, 9, 0).getTime(), back = (hours: number) => at(new Date(morning + hours * 3_600_000).toISOString(), week(100));
  expect(stoppedWords(back(8), morning, "en", t, true)).toMatch(/^Until 5:00\sPM$/);
  expect(stoppedWords(back(16), morning, "en", t, true)).toBe("Until 11/26");
});

test("an agent nothing holds (an API key, or one that reports no limits) is where work goes, so the bar never says stopped for it", () => {
  const spentCodex = agent("codex", "ok", [at("2026-11-27T00:00:00Z", week(100))]), spentClaude = agent("claude", "ok", [week(100)]);
  expect(shownOf(barLimit(response([agent("claude", "ok"), spentCodex], [row("claude"), row("codex")]), NOW)))
    .toEqual({ kind: "unlimited", agent: "claude", percent: null });
  expect(shownOf(barLimit(response([spentClaude, agent("codex", "ok")], [row("claude"), row("codex")]), NOW)))
    .toEqual({ kind: "unlimited", agent: "codex", percent: null });
  expect(shownOf(barLimit(response([spentClaude, agent("grok", "unsupported")], [row("claude"), row("grok")]), NOW)))
    .toEqual({ kind: "unlimited", agent: "grok", percent: null });
});

test("an agent whose limits are unknown shows none in its place, and no bar until one is known", () => {
  const codex = agent("codex", "ok", [week(9)]);
  expect(shownOf(barLimit(response([agent("claude", "unavailable"), codex], [row("claude", "opus"), row("codex")]), NOW)))
    .toEqual({ kind: "unknown", agent: "claude", percent: null });
  // After a spent agent too: the unknown one is where work goes, not the one after it.
  expect(shownOf(barLimit(response([agent("claude", "ok", [week(100)]), agent("codex", "unavailable"), agent("copilot", "ok", [week(5)])],
    [row("claude"), row("codex"), row("copilot")]), NOW)))
    .toEqual({ kind: "unknown", agent: "codex", percent: null });
  expect(barLimit(response([agent("claude", "unavailable"), agent("grok", "unsupported")], [row("claude")]), NOW)).toBeNull();
});

test("the bar shows two agents in the stack's order, always with the one work goes on with, then the others whose limits are read", () => {
  const shown = (agents: AgentLimits[], stack: ReturnType<typeof row>[]) => barLimits(response(agents, stack), NOW).map(shownOf);
  const claude = agent("claude", "ok", [week(37)]), codex = agent("codex", "ok", [week(8)]), copilot = agent("copilot", "ok", [week(5)]);
  const spent = (adapter: AgentLimits["adapter"]) => agent(adapter, "ok", [week(100)]);
  expect(shown([claude, codex, copilot], [row("claude", "opus"), row("codex"), row("copilot")]))
    .toEqual([{ kind: "limited", agent: "claude", percent: 37 }, { kind: "limited", agent: "codex", percent: 8 }]);
  // Past two spent agents, the third carries on and stands beside the last spent one.
  expect(shown([spent("claude"), spent("codex"), copilot], [row("claude"), row("codex"), row("copilot")]))
    .toEqual([{ kind: "stopped", agent: "codex", percent: 100 }, { kind: "limited", agent: "copilot", percent: 5 }]);
  // An agent listed twice is one place, said by its first row that can work.
  expect(shown([agent("claude", "ok", [week(40), week(100, "Fable")]), codex], [row("claude", "fable"), row("claude", "opus"), row("codex")]))
    .toEqual([{ kind: "limited", agent: "claude", percent: 40 }, { kind: "limited", agent: "codex", percent: 8 }]);
  // Beyond the stack: one whose limits are read fills the room; one whose limits are not, does not.
  expect(shown([claude, agent("grok", "unsupported"), codex], [row("claude")]))
    .toEqual([{ kind: "limited", agent: "claude", percent: 37 }, { kind: "limited", agent: "codex", percent: 8 }]);
  expect(shown([claude, agent("codex", "unavailable")], [row("claude")])).toEqual([{ kind: "limited", agent: "claude", percent: 37 }]);
  // Listed in the stack, an unknown one keeps its place: work may go there.
  expect(shown([claude, agent("codex", "unavailable")], [row("claude"), row("codex")]))
    .toEqual([{ kind: "limited", agent: "claude", percent: 37 }, { kind: "unknown", agent: "codex", percent: null }]);
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
