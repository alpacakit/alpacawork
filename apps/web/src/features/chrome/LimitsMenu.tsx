import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentLimits, AgentLimitsResponse, LimitWindow } from "@alpacawork/contract/agent-limits";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useRefreshAgentLimits } from "@/data/queries";
import { notify } from "@/lib/notify";
import { Popup } from "@/components/ui/popup";
import { useFrameSelector } from "@/data/workspace-store";
import { resources } from "@/data/resources";
import { barLimit, type BarLimit, besideModelWindow, currentLimitWindow, limitTone, readWords, resetWords, stackPlaces, stoppedWords, windowLabel } from "@/domain/limits";
import { AGENT_NAMES } from "@/domain/agent-names";
import { useNow } from "@/state/clock";
import { cn } from "@/lib/utils";
import { TONE_FILL, TONE_TEXT, UsageRing, percentText } from "@/components/ui/usage-ring";

/* Hallmark · component: plan limits in the bar · genre: modern-minimal · theme: the app's own tokens (working, warn, error, line) */

/**
 * One window in the menu: its name, how full it is, and close under them when it resets, so the reset reads as this
 * window's and not the next one's. The reset has the row's whole width, so a long one (a weekday and a time, in any
 * language) stays on its line. A window past its reset has no figure until the next read: the old one was the last
 * period's, so the row says it has reset.
 */
function WindowRow({ window, now, scoped, shown }: { window: LimitWindow; now: number; scoped: boolean; shown: boolean }) {
  const { t, i18n } = useTranslation("chrome");
  const current = currentLimitWindow(window, now);
  const tone = current ? limitTone(window.usedPercent) : "normal";
  const reset = current ? resetWords(window.resetsAt, now, i18n.language, t) : t("limits.reset.done");
  // The label's and the percent's boxes are trimmed to their letters (capitals over the baseline), so centring the line
  // centres what is drawn: the bar stands level with the words, not with their line boxes (which sit about 1px lower).
  // The window the bar shows is marked in the padding at its left and named in bold, so the bar's figure is found here.
  return <li data-limit-window={window.kind} data-limit-shown={shown || undefined} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_2.5rem] items-center gap-x-3 gap-y-2">
    <span className={cn("relative [text-box:trim-both_cap_alphabetic]", shown && "font-semibold")}>
      {shown && <span aria-hidden className={cn("absolute -inset-y-1 -left-2.5 w-[3px] rounded-full", TONE_FILL[tone])} />}
      {windowLabel(window, t, scoped)}</span>
    <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-line">
      {current && <span className={cn("block h-full rounded-full", TONE_FILL[tone])} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />}
    </span>
    <span className={cn("text-right font-medium tabular-nums [text-box:trim-both_cap_alphabetic]", current ? TONE_TEXT[tone] : "text-muted")}>
      {current ? percentText(window.usedPercent) : "—"}</span>
    {reset && <span className="col-span-full text-xs text-muted">{reset}</span>}
  </li>;
}

/**
 * Where an agent stands in the stack tasks run on, in the words of the settings that set it: "Primary (opus) · Fallback 2
 * (sonnet)", each row with its model, as one agent can stand in more than one row; or that tasks use it only when named.
 */
function placeWords(agent: AgentLimits, stack: AgentLimitsResponse["stack"], t: (key: string, options?: Record<string, unknown>) => string): string {
  const places = stackPlaces(agent.adapter, stack);
  if (places.length === 0) return t("limits.place.namedOnly");
  return places.map(({ at, model }) => {
    const role = at === 0 ? t("panels:agentSettings.aiStack.first") : t("panels:agentSettings.aiStack.fallback", { n: at });
    return model ? t("limits.place.model", { role, model }) : role;
  }).join(" · ");
}

/** An agent's windows under its name and its place in the stack; one with none to show says why on its name's line (under it when the words are long). */
function AgentBlock({ agent, stack, now, shown }: { agent: AgentLimits; stack: AgentLimitsResponse["stack"]; now: number; shown: LimitWindow | null }) {
  const { t } = useTranslation("chrome");
  const name = AGENT_NAMES[agent.adapter].short;
  const note = agent.state === "unsupported" ? t("limits.unsupported") : agent.state === "unavailable" ? t("limits.unavailable")
    : agent.windows.length === 0 ? t("limits.none") : null;
  return <section data-limit-agent={agent.adapter} aria-label={name} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 not-first:border-t not-first:border-line">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="m-0 text-sm font-semibold">{name}</h3>
      <span data-limit-place className="text-xs text-muted">{placeWords(agent, stack, t)}</span>
      {/* Whose limits these are: the account the agent is signed in as, cut to the menu's width (whole in the tooltip). */}
      {agent.account && <span data-limit-account className="min-w-0 max-w-full truncate text-xs text-muted" title={agent.account}>{agent.account}</span>}
      {note && <p className="m-0 text-sm text-muted">{note}</p>}
    </div>
    {!note && <ul className="m-0 flex list-none flex-col gap-5 p-0 text-sm">{agent.windows.map((window, at) =>
      <WindowRow key={at} window={window} now={now} scoped={besideModelWindow(window, agent.windows)} shown={window === shown} />)}</ul>}
  </section>;
}

/** The bar's words for a screen reader (and its tooltip): what the ring and the name say, with the window and the percent. */
function barWords(shown: BarLimit, name: string, locale: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (shown.kind === "stopped") return t("limits.barStopped", { agent: name, state: stoppedWords(shown.window, locale, t) });
  if (shown.kind === "limited") return t("limits.barLabel", { agent: name, window: windowLabel(shown.window, t), percent: percentText(shown.window.usedPercent) });
  return t(shown.kind === "reset" ? "limits.barReset" : shown.kind === "unknown" ? "limits.barUnknown" : "limits.barUnlimited", { agent: name });
}

/**
 * The bar's plan limits: the agent work goes on with now (the first in the task stack whose limit is not spent) as a
 * ring and its name when the bar has room. The reset fits in the wide or split bar. The window, percent and reset
 * time are available in the label and the menu.
 * A press opens every agent's windows with when each resets and the account each is signed in as. Nothing shows until
 * some agent's limits are known.
 */
export function LimitsMenu() {
  const { t, i18n } = useTranslation("chrome");
  // The bar is drawn before the first index: the limits are read once it names the workspace.
  const root = useFrameSelector(data => data?.info.root ?? null);
  const limits = useQuery({ ...resources.agentLimits(root ?? ""), enabled: !!root });
  // A refresh asks every agent again now: no model is called, so it costs no tokens, only a second or two.
  const { refresh, refreshing } = useRefreshAgentLimits();
  useNow();
  const now = Date.now();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const agents = limits.data?.agents ?? [];
  const shown = limits.data ? barLimit(limits.data, now) : null;
  if (!shown) return null;
  // A stopped agent's window is a spent one, so its ring is full too.
  const shownWindow = "window" in shown ? shown.window : null;
  const percent = shownWindow?.usedPercent ?? 0;
  const tone = limitTone(percent);
  const name = AGENT_NAMES[shown.agent.adapter].short;
  const label = barWords(shown, name, i18n.language, t);
  const read = readWords(agents.map(agent => agent.observedAt).filter(at => at !== null).sort()[0] ?? null, now, t);
  return <>
    <Button ref={trigger} variant="ghost" size="bar" data-limits-trigger data-tone={tone} aria-haspopup="dialog" aria-expanded={open}
      aria-label={label} title={label} onClick={() => setOpen(value => !value)}
      className="w-auto min-w-0 gap-1.5 px-2 narrow:w-auto narrow:min-w-9">
      {/* An agent nothing holds has the ring of no limit (four arcs), and no window or figure. */}
      <UsageRing percent={percent} tone={tone} open={shown.kind === "unlimited"} />
      <span className="min-w-0 truncate text-sm">{name}</span>
      {shown.kind === "stopped" ? <>
        <span className="hidden text-sm whitespace-nowrap text-error @min-[60rem]:inline">{stoppedWords(shown.window, i18n.language, t)}</span>
        <span className="text-sm whitespace-nowrap text-error @min-[60rem]:hidden">{stoppedWords(shown.window, i18n.language, t, true)}</span>
      </> : shown.kind === "unknown" && <span className="text-sm text-muted">—</span>}
    </Button>
    {/* The heading's line is as high as its button, so the box is shorter over it: the title stands as far from the top
        edge as from the side. The button's box is wider than its mark, so it is pulled out to end the mark where the
        percents under it end (a phone's sheet closes with × beside it, and keeps it in). */}
    {open && <Popup open onOpenChange={setOpen} label={t("limits.title")} align="end" className="w-88 p-4 pt-3" anchorRef={trigger}
      heading={<span className="flex items-center justify-between gap-3"><span>{t("limits.title")}</span>
        <span className="flex items-center gap-1 text-xs font-normal text-muted">
          <span aria-live="polite">{refreshing ? t("limits.refreshing") : read}</span>
          <Button variant="ghost" size="icon" data-limits-refresh aria-label={t("limits.refresh")} title={t("limits.refresh")}
            disabled={refreshing} onClick={() => void refresh().catch(error =>
              notify.failure(error, { about: "limits", text: t("limits.refreshFailed"), from: trigger.current }))} className="-mr-2 size-7 text-muted hover:text-ink narrow:mr-0 narrow:size-9">
            <Icon name="reload" className={cn("size-3.5", refreshing && "animate-spin")} /></Button>
        </span></span>}>
      <div data-limits-menu lang={i18n.language} className="pt-2">
        {agents.map(agent => <AgentBlock key={agent.adapter} agent={agent} stack={limits.data!.stack} now={now}
          shown={agent.adapter === shown.agent.adapter ? shownWindow : null} />)}
        {/* Why the bar shows the agent it does, when another reads as free: the stack decides, not the figures alone. */}
        <p className="m-0 mt-4 border-t border-line pt-3 text-xs text-pretty text-muted">
          {t("limits.place.note", { title: t("panels:agentSettings.aiStack.title") })}</p>
      </div>
    </Popup>}
  </>;
}
