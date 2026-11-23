/** How the bar and its menu say an agent's plan limits (contract: agent-limits). */
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import type { BuiltinAdapterId } from "@alpacawork/contract/agent-adapters";

/** The services' own short names, untranslated. */
export const AGENT_NAMES: Record<BuiltinAdapterId, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot", grok: "Grok", pi: "pi" };

/** From here a window is close to its limit, and at 100 it is spent. */
export const LIMIT_NEAR = 80;
export type LimitTone = "normal" | "near" | "spent";
export const limitTone = (percent: number): LimitTone => percent >= 100 ? "spent" : percent >= LIMIT_NEAR ? "near" : "normal";

/** The window that stops the agent first: the fullest one. */
export const tightestWindow = (windows: readonly LimitWindow[]): LimitWindow | null =>
  windows.reduce<LimitWindow | null>((tightest, window) => !tightest || window.usedPercent > tightest.usedPercent ? window : tightest, null);

/**
 * What the bar shows: the first agent that tasks use (the server lists the task stack's first) and its fullest window,
 * or no window while that agent's limits are unknown, so another agent's figure never stands as the first's. Null, and
 * no bar, until some agent's limits are known.
 */
export function barLimit(agents: readonly AgentLimits[]): { agent: AgentLimits; window: LimitWindow | null } | null {
  const agent = agents.find(entry => entry.state !== "unsupported");
  if (!agent || !agents.some(entry => entry.state === "ok")) return null;
  return { agent, window: agent.state === "ok" ? tightestWindow(agent.windows) : null };
}

type T = (key: string, options?: Record<string, unknown>) => string;

/** "5 hours", "Weekly", "Weekly (Fable)"; `scoped`: beside a model's own window, the account's says "all models". */
export function windowLabel(window: LimitWindow, t: T, scoped = false): string {
  const period = window.kind === "other" && window.minutes !== null
    ? t("limits.window.hours", { count: Math.round(window.minutes / 60) }) : t(`limits.window.${window.kind}`);
  return window.model ? t("limits.window.model", { model: window.model, period })
    : scoped ? t("limits.window.allModels", { period }) : period;
}

/** Within a day, how long until it resets; further off, the day and time it does. */
export function resetWords(resetsAt: string | null, now: number, locale: string, t: T): string | null {
  if (!resetsAt) return null;
  // Providers stamp a reset a moment before the hour ("…14:59:59.9Z"); it is read as that hour.
  const at = Math.round(Date.parse(resetsAt) / 60_000) * 60_000, left = at - now;
  if (!Number.isFinite(at) || left <= 0) return null;
  if (left < 86_400_000) {
    const minutes = Math.max(1, Math.ceil(left / 60_000));
    return minutes < 60 ? t("limits.reset.inMinutes", { count: minutes })
      : t("limits.reset.inHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }
  const when = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
  return t("limits.reset.at", { when });
}

/** "Read 3 min ago", or "Read just now". */
export function readWords(observedAt: string | null, now: number, t: T): string | null {
  if (!observedAt) return null;
  const minutes = Math.floor((now - Date.parse(observedAt)) / 60_000);
  return minutes < 1 ? t("limits.readNow") : t("limits.readAgo", { count: minutes });
}
