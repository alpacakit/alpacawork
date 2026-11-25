/** How the bar and its menu say an agent's plan limits (contract: agent-limits). */
import type { AgentLimits, AgentLimitsResponse, LimitWindow } from "@alpacawork/contract/agent-limits";

/** From here a window is close to its limit, and at 100 it is spent. */
export const LIMIT_NEAR = 80;
export type LimitTone = "normal" | "near" | "spent";
export const limitTone = (percent: number): LimitTone => percent >= 100 ? "spent" : percent >= LIMIT_NEAR ? "near" : "normal";

/** The window that stops the agent first: the fullest one. */
export const tightestWindow = (windows: readonly LimitWindow[]): LimitWindow | null =>
  windows.reduce<LimitWindow | null>((tightest, window) => !tightest || window.usedPercent > tightest.usedPercent ? window : tightest, null);

/** The windows that hold a stack row back: the account's own, and its model's (the provider's "Fable", the row's "fable"). */
export const rowWindows = (windows: readonly LimitWindow[], model: string | null): LimitWindow[] =>
  windows.filter(window => window.model === null || model !== null && window.model.toLowerCase() === model.toLowerCase());

/** Whether a window holds its agent back now: spent, and not yet past its reset (the menu then says no reset either). */
export const holds = (window: LimitWindow, now: number): boolean =>
  limitTone(window.usedPercent) === "spent" && !(window.resetsAt && resetMinute(window.resetsAt) <= now);

/**
 * What the bar shows, from the stack tasks run on: the first row that can work now.
 * - `limited`: the row's fullest window that holds it.
 * - `unknown`: its limits could not be read; another agent's figure never stands as its own.
 * - `unlimited`: nothing holds it (an agent used with an API key, or one that reports no limits): work goes on there.
 * - `stopped`: every row is held; the first row's agent, and its window that holds it longest (when work goes on).
 * Null, and no bar, until some agent's limits are known.
 */
export type BarLimit =
  | { kind: "limited" | "stopped"; agent: AgentLimits; window: LimitWindow }
  | { kind: "unknown" | "unlimited"; agent: AgentLimits };
export function barLimit({ agents, stack }: AgentLimitsResponse, now: number): BarLimit | null {
  if (!agents.some(entry => entry.state === "ok")) return null;
  let first: { agent: AgentLimits; windows: LimitWindow[] } | null = null;
  for (const row of stack) {
    const agent = agents.find(entry => entry.adapter === row.adapter);
    if (!agent) continue;
    if (agent.state === "unavailable") return { kind: "unknown", agent };
    const windows = rowWindows(agent.windows, row.model);
    if (agent.state === "unsupported" || windows.length === 0) return { kind: "unlimited", agent };
    const holding = windows.filter(window => holds(window, now));
    if (holding.length === 0) return { kind: "limited", agent, window: tightestWindow(windows)! };
    first ??= { agent, windows: holding };
  }
  if (!first) return null;
  // It works again once its last holding window resets.
  const until = (window: LimitWindow) => window.resetsAt ? Date.parse(window.resetsAt) : Infinity;
  const window = first.windows.reduce((latest, next) => until(next) > until(latest) ? next : latest);
  return { kind: "stopped", agent: first.agent, window };
}

type T = (key: string, options?: Record<string, unknown>) => string;

/** Whether a model has a window of its own over the same period as this account window: the account's then says "all models". */
export const besideModelWindow = (window: LimitWindow, windows: readonly LimitWindow[]): boolean =>
  window.model === null && windows.some(other => other.model !== null && other.kind === window.kind && other.minutes === window.minutes);

/** "5 hours", "Weekly", "Weekly (Fable)"; `scoped` (`besideModelWindow`): "Weekly (all models)". */
export function windowLabel(window: LimitWindow, t: T, scoped = false): string {
  const period = window.kind === "other" && window.minutes !== null && window.minutes >= 60
    ? t("chrome:limits.window.hours", { count: Math.round(window.minutes / 60) }) : t(`chrome:limits.window.${window.kind}`);
  return window.model ? t("chrome:limits.window.model", { model: window.model, period })
    : scoped ? t("chrome:limits.window.allModels", { period }) : period;
}

/** A reset as every place says it: providers stamp one a moment before the hour ("…14:59:59.9Z"), read as that hour. */
export const resetMinute = (resetsAt: string): number => Math.round(Date.parse(resetsAt) / 60_000) * 60_000;

/** Within a day, how long until it resets; further off, the day and time it does. */
export function resetWords(resetsAt: string | null, now: number, locale: string, t: T): string | null {
  if (!resetsAt) return null;
  const at = resetMinute(resetsAt), left = at - now;
  if (!Number.isFinite(at) || left <= 0) return null;
  if (left < 86_400_000) {
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    const hours = Math.floor(minutes / 60);
    return minutes < 60 ? t("chrome:limits.reset.inMinutes", { count: minutes })
      : minutes % 60 === 0 ? t("chrome:limits.reset.inWholeHours", { hours }) : t("chrome:limits.reset.inHours", { hours, minutes: minutes % 60 });
  }
  const when = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
  return t("chrome:limits.reset.at", { when });
}

/** Until when a spent agent stops: "Stopped until Sun 11/29 20:00"; `short` (a phone) the day alone, "Until 11/29". */
export function stoppedWords(window: LimitWindow, locale: string, t: T, short = false): string {
  if (!window.resetsAt) return t("chrome:limits.stopped");
  const when = new Intl.DateTimeFormat(locale, short ? { month: "numeric", day: "numeric" }
    : { month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" }).format(resetMinute(window.resetsAt));
  return t(short ? "chrome:limits.stoppedUntilShort" : "chrome:limits.stoppedUntil", { when });
}

/** "Updated 3 min ago", or "Updated just now". */
export function readWords(observedAt: string | null, now: number, t: T): string | null {
  if (!observedAt) return null;
  const minutes = Math.floor((now - Date.parse(observedAt)) / 60_000);
  return minutes < 1 ? t("chrome:limits.readNow") : t("chrome:limits.readAgo", { count: minutes });
}
