/** How the bar and its menu say an agent's plan limits (contract: agent-limits). */
import type { AgentLimits, AgentLimitsResponse, LimitWindow } from "@alpacawork/contract/agent-limits";

/** From here a window is close to its limit, and at 100 it is spent. */
const LIMIT_NEAR = 80;
export type LimitTone = "normal" | "near" | "spent";
export const limitTone = (percent: number): LimitTone => percent >= 100 ? "spent" : percent >= LIMIT_NEAR ? "near" : "normal";

/** The window that stops the agent first: the fullest one. */
const tightestWindow = (windows: readonly LimitWindow[]): LimitWindow | null =>
  windows.reduce<LimitWindow | null>((tightest, window) => !tightest || window.usedPercent > tightest.usedPercent ? window : tightest, null);

/** The windows that hold a stack row back: the account's own, and its model's (the provider's "Fable", the row's "fable"). */
const rowWindows = (windows: readonly LimitWindow[], model: string | null): LimitWindow[] =>
  windows.filter(window => window.model === null || model !== null && window.model.toLowerCase() === model.toLowerCase());

/** A reading applies until its window resets; past it the window has reset, and its new usage is not read yet. */
export const currentLimitWindow = (window: LimitWindow, now: number): boolean =>
  window.resetsAt === null || resetMinute(window.resetsAt) > now;

/** When a spent window lets its row work again; one of no reset time, never as far as anyone knows. */
const backAt = (window: LimitWindow): number => window.resetsAt ? resetMinute(window.resetsAt) : Infinity;

/**
 * What the bar shows, from the stack tasks run on: the first row that can work now.
 * - `limited`: the row's fullest current window.
 * - `reset`: every window that holds the row has reset since it was read: it works, and its new usage is not read yet.
 * - `unknown`: its limits could not be read.
 * - `unlimited`: nothing holds it (an agent used with an API key, or one that reports no limits): work goes on there.
 * - `stopped`: every row is held; the row that works again first, by when its windows that hold it have all reset (the
 *   latest of them). A row with a holding window of no reset time has no known return: a known one comes first, and
 *   with none known the first row stands, its window saying no time.
 * Null, and no bar, until some agent's limits are known.
 */
export type BarLimit =
  | { kind: "limited" | "stopped"; agent: AgentLimits; window: LimitWindow }
  | { kind: "reset" | "unknown" | "unlimited"; agent: AgentLimits };
export function barLimit({ agents, stack }: AgentLimitsResponse, now: number): BarLimit | null {
  if (!agents.some(entry => entry.state === "ok")) return null;
  let first: { agent: AgentLimits; window: LimitWindow; back: number } | null = null;
  for (const row of stack) {
    const agent = agents.find(entry => entry.adapter === row.adapter);
    if (!agent) continue;
    if (agent.state === "unavailable") return { kind: "unknown", agent };
    const windows = rowWindows(agent.windows, row.model);
    if (agent.state === "unsupported" || windows.length === 0) return { kind: "unlimited", agent };
    const current = windows.filter(window => currentLimitWindow(window, now));
    const fullest = tightestWindow(current);
    if (!fullest) return { kind: "reset", agent };
    if (limitTone(fullest.usedPercent) !== "spent") return { kind: "limited", agent, window: fullest };
    // It works again once its last holding window resets.
    const window = current.filter(window => limitTone(window.usedPercent) === "spent")
      .reduce((latest, next) => backAt(next) > backAt(latest) ? next : latest);
    if (!first || backAt(window) < first.back) first = { agent, window, back: backAt(window) };
  }
  return first && { kind: "stopped", agent: first.agent, window: first.window };
}

/** How many agents the bar shows side by side: two fit beside the other buttons on a phone, as the name of one did. */
export const BAR_AGENTS = 2;

/**
 * The agents the bar shows, each as `barLimit` says it on that agent's own rows: the agents in the stack's order, then
 * the others whose limits are read (tasks use them when a request names one). Of these, the first `BAR_AGENTS` in a row
 * that include the one work goes on with now, so a spent primary stands beside the fallback that carries on. An agent
 * whose limits cannot be read shows only when the stack lists it (work may go there); none, until some agent's are known.
 */
export function barLimits(response: AgentLimitsResponse, now: number): BarLimit[] {
  const current = barLimit(response, now);
  if (!current) return [];
  const listed = [...new Set(response.stack.map(row => row.adapter))];
  const others = response.agents.filter(agent => agent.state === "ok" && !listed.includes(agent.adapter)).map(agent => agent.adapter);
  const shown = [...listed, ...others].flatMap(adapter => {
    const rows = response.stack.filter(row => row.adapter === adapter);
    return barLimit({ agents: response.agents, stack: rows.length ? rows : [{ adapter, model: null }] }, now) ?? [];
  });
  const at = shown.findIndex(limit => limit.agent.adapter === current.agent.adapter);
  const start = Math.max(0, at - (BAR_AGENTS - 1));
  return shown.slice(start, start + BAR_AGENTS);
}

/** Where an agent stands in the stack tasks run on: each of its rows' place (0 the primary) and model; none when tasks use it only when a request names it. */
export const stackPlaces = (adapter: AgentLimits["adapter"], stack: AgentLimitsResponse["stack"]): { at: number; model: string | null }[] =>
  stack.flatMap((row, at) => row.adapter === adapter ? [{ at, model: row.model }] : []);

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

/** Until when a spent agent stops: "Stopped until Sun 11/29 20:00"; `short` (a narrow bar) the time alone when it is back
 *  later today on this device's clock, "Until 17:13", and otherwise the day alone, "Until 11/29". */
export function stoppedWords(window: LimitWindow, now: number, locale: string, t: T, short = false): string {
  if (!window.resetsAt) return t("chrome:limits.stopped");
  const at = resetMinute(window.resetsAt);
  if (!short) return t("chrome:limits.stoppedUntil", { when: new Intl.DateTimeFormat(locale,
    { month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" }).format(at) });
  const today = new Date(at).toDateString() === new Date(now).toDateString();
  return today ? t("chrome:limits.stoppedUntilTimeShort", { when: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at) })
    : t("chrome:limits.stoppedUntilShort", { when: new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(at) });
}

/** "Updated 3 min ago", or "Updated just now". */
export function readWords(observedAt: string | null, now: number, t: T): string | null {
  if (!observedAt) return null;
  const minutes = Math.floor((now - Date.parse(observedAt)) / 60_000);
  return minutes < 1 ? t("chrome:limits.readNow") : t("chrome:limits.readAgo", { count: minutes });
}
