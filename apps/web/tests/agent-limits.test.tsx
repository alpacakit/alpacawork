import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import { barLimit, limitTone, resetWords, windowLabel } from "../src/domain/limits";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
const t = (key: string, options?: Record<string, unknown>) => i18n.t(`chrome:${key}`, options);
const week = (usedPercent: number, model: string | null = null): LimitWindow =>
  ({ kind: "weekly", minutes: 10_080, model, usedPercent, resetsAt: null });
const agent = (adapter: AgentLimits["adapter"], state: AgentLimits["state"], windows: LimitWindow[] = []): AgentLimits =>
  ({ adapter, state, windows, observedAt: state === "ok" ? "2026-11-24T00:00:00.000Z" : null });

test("the bar shows the first agent's fullest window, never another agent's in its place, and no bar until one is known", () => {
  expect(barLimit([agent("grok", "unsupported"), agent("claude", "ok", [week(63), week(77, "Fable")]), agent("codex", "ok", [week(99)])]))
    .toMatchObject({ agent: { adapter: "claude" }, window: { usedPercent: 77, model: "Fable" } });
  expect(barLimit([agent("claude", "unavailable"), agent("codex", "ok", [week(9)])])).toMatchObject({ agent: { adapter: "claude" }, window: null });
  expect(barLimit([agent("claude", "unavailable"), agent("grok", "unsupported")])).toBeNull();
  expect([79, 80, 100].map(limitTone)).toEqual(["normal", "near", "spent"]);
});

test("a window names its model, and the account's says all models beside one", () => {
  expect(windowLabel(week(77, "Fable"), t)).toBe("Weekly (Fable)");
  expect(windowLabel(week(63), t, true)).toBe("Weekly (all models)");
  expect(windowLabel({ ...week(5), kind: "other", minutes: 1440 }, t)).toBe("24 hours");
});

test("a reset within a day says how long until it; a later one the day; a past one nothing", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  expect(resetWords("2026-11-24T02:10:00Z", now, "en", t)).toBe("Resets in 2h 10m");
  expect(resetWords("2026-11-24T00:00:30Z", now, "en", t)).toBe("Resets in 1 min");
  expect(resetWords("2026-11-29T14:59:59.900Z", now, "en", t)).toBe(resetWords("2026-11-29T15:00:00Z", now, "en", t));
  expect(resetWords("2026-11-23T00:00:00Z", now, "en", t)).toBeNull();
});
