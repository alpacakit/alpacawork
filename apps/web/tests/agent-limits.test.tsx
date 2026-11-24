import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import { barLimit, besideModelWindow, limitTone, resetWords, windowLabel } from "../src/domain/limits";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
const week = (usedPercent: number, model: string | null = null): LimitWindow =>
  ({ kind: "weekly", minutes: 10_080, model, usedPercent, resetsAt: null });
const agent = (adapter: AgentLimits["adapter"], state: AgentLimits["state"], windows: LimitWindow[] = []): AgentLimits =>
  ({ adapter, state, windows, account: null, observedAt: state === "ok" ? "2026-11-24T00:00:00.000Z" : null });

test("the bar shows the first agent's fullest window, never another agent's in its place, and no bar until one is known", () => {
  expect(barLimit([agent("grok", "unsupported"), agent("claude", "ok", [week(63), week(77, "Fable")]), agent("codex", "ok", [week(99)])]))
    .toMatchObject({ agent: { adapter: "claude" }, window: { usedPercent: 77, model: "Fable" } });
  expect(barLimit([agent("claude", "unavailable"), agent("codex", "ok", [week(9)])])).toMatchObject({ agent: { adapter: "claude" }, window: null });
  // An agent without any limit (an API key) is no warning: the next agent stands first.
  expect(barLimit([agent("claude", "ok"), agent("codex", "ok", [week(9)])])).toMatchObject({ agent: { adapter: "codex" } });
  expect(barLimit([agent("claude", "unavailable"), agent("grok", "unsupported")])).toBeNull();
  // The user chose red from 80%.
  expect([79, 80, 100].map(limitTone)).toEqual(["normal", "near", "spent"]);
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
