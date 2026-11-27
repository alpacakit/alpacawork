import { useRef, useState } from "react";
import { AgentMark } from "@/components/ui/agent-mark";
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
import { barLimit, barLimits, type BarLimit, besideModelWindow, currentLimitWindow, limitTone, readWords, resetWords, stackPlaces, stoppedWords, windowLabel } from "@/domain/limits";
import { AGENT_NAMES } from "@/domain/agent-names";
import { useNow } from "@/state/clock";
import { openSettings } from "@/state/dialog-store";
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
    <span className={cn("relative cap-box", shown && "font-semibold")}>
      {shown && <span aria-hidden className={cn("absolute -inset-y-1 -left-2.5 w-[3px] rounded-full", TONE_FILL[tone])} />}
      {windowLabel(window, t, scoped)}</span>
    <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-line">
      {current && <span className={cn("block h-full rounded-full", TONE_FILL[tone])} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />}
    </span>
    <span className={cn("text-right font-medium tabular-nums cap-box", current ? TONE_TEXT[tone] : "text-muted")}>
      {current ? percentText(window.usedPercent) : "—"}</span>
    {reset && <span className="col-span-full text-xs text-muted">{reset}</span>}
  </li>;
}

/**
 * Where an agent stands in the stack tasks run on, in the words of the settings that set it: "Primary (opus) · Fallback 2
 * (sonnet)", each row with its model, as one agent can stand in more than one row; or that the stack does not list it.
 */
function placeWords(agent: AgentLimits, stack: AgentLimitsResponse["stack"], t: (key: string, options?: Record<string, unknown>) => string): string {
  const places = stackPlaces(agent.adapter, stack);
  if (places.length === 0) return t("limits.place.notListed", { title: t("panels:agentSettings.aiStack.title") });
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
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h3 className="m-0 flex items-center gap-1.5 text-sm font-semibold"><AgentMark name={agent.adapter} kind={agent.adapter} />{name}</h3>
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
function barWords(shown: BarLimit, name: string, now: number, locale: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (shown.kind === "stopped") return t("limits.barStopped", { agent: name, state: stoppedWords(shown.window, now, locale, t) });
  if (shown.kind === "limited") return t("limits.barLabel", { agent: name, window: windowLabel(shown.window, t), percent: percentText(shown.window.usedPercent) });
  return t(shown.kind === "reset" ? "limits.barReset" : shown.kind === "unknown" ? "limits.barUnknown" : "limits.barUnlimited", { agent: name });
}

/**
 * One agent in the bar: its mark, then a ring as full as the window that holds it, as the menu reads (the name, then its
 * bars). One nothing holds has the ring of no limit (four arcs); one whose limits are unknown, a dash in the ring's place,
 * as an empty ring would read as 0%. A mark is faded while its agent cannot take work (stopped, or unknown), since a
 * spent ring and one past 80% share a colour.
 */
function BarAgent({ limit }: { limit: BarLimit }) {
  const percent = "window" in limit ? limit.window.usedPercent : 0;
  return <span data-limits-agent={limit.agent.adapter} data-limit-kind={limit.kind} className="flex flex-none items-center gap-1">
    <AgentMark name={limit.agent.adapter} kind={limit.agent.adapter} className={cn((limit.kind === "stopped" || limit.kind === "unknown") && "opacity-50")} />
    {limit.kind === "unknown" ? <span className="w-4 text-center text-sm text-muted">—</span>
      : <UsageRing percent={percent} tone={limitTone(percent)} open={limit.kind === "unlimited"} />}
  </span>;
}

/**
 * The bar's plan limits: up to two agents tasks run on (`barLimits`), each as a ring and its mark, with no names: the
 * marks say whose they are. While every agent is stopped, it shows only the one that works again first, and until when,
 * so the time reads as that agent's. The windows, percents and reset times are in the label and the menu.
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
  if (!shown || !limits.data) return null;
  // The menu marks the window the bar's agent of now shows, so its figure is found there.
  const shownWindow = "window" in shown ? shown.window : null;
  const stopped = shown.kind === "stopped" ? shown.window : null;
  const bar = stopped ? [shown] : barLimits(limits.data, now);
  const label = bar.map(limit => barWords(limit, AGENT_NAMES[limit.agent.adapter].short, now, i18n.language, t)).join("\n");
  const stackLabel = t("limits.openStack", { title: t("panels:agentSettings.aiStack.title") });
  const read = readWords(agents.map(agent => agent.observedAt).filter(at => at !== null).sort()[0] ?? null, now, t);
  const status = refreshing ? t("limits.refreshing") : read;
  return <>
    <Button ref={trigger} variant="ghost" size="bar" data-limits-trigger
      aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(value => !value)}
      className={cn("w-auto min-w-0 gap-4 px-2 narrow:w-auto narrow:min-w-9", stopped && "pr-3")}>
      {/* Words end flush with their box, while a mark or a ring has air inside its own: a button ending in the time keeps
          a wider right edge, so the time does not sit against it. */}
      {bar.map(limit => <BarAgent key={limit.agent.adapter} limit={limit} />)}
      {stopped && <>
        <span className="hidden text-sm whitespace-nowrap text-error @min-[60rem]:inline">{stoppedWords(stopped, now, i18n.language, t)}</span>
        <span className="text-sm whitespace-nowrap text-error @min-[60rem]:hidden">{stoppedWords(stopped, now, i18n.language, t, true)}</span>
      </>}
    </Button>
    {/* The heading's line is as high as its button, so the box is shorter over it: the title stands as far from the top
        edge as from the side. The button's box is wider than its mark, so it is pulled out to end the mark where the
        percents under it end (a phone's sheet closes with × beside it, and keeps it in). */}
    {open && <Popup open onOpenChange={setOpen} label={t("limits.title")} align="end" className="w-88 p-4 pt-3" anchorRef={trigger}
      heading={<span className="flex min-w-0 items-center gap-2">
        {/* One line at every width and in every language: the title and the buttons keep their room, and when the read
            time has too little it is cut (whole in its tooltip and to a screen reader), so a refresh never moves the height. */}
        <span className="flex-none whitespace-nowrap">{t("limits.title")}</span>
        <span aria-live="polite" title={status ?? undefined}
          className="min-w-0 flex-1 truncate text-right text-xs font-normal text-muted">{status}</span>
        <span className="flex flex-none items-center gap-1">
          <Button variant="ghost" size="icon" data-limits-refresh aria-label={t("limits.refresh")} title={t("limits.refresh")}
            disabled={refreshing} onClick={() => void refresh().catch(error =>
              notify.failure(error, { about: "limits", text: t("limits.refreshFailed"), from: trigger.current }))} className="size-7 text-muted hover:text-ink narrow:size-9">
            <Icon name="reload" className={cn("size-3.5", refreshing && "animate-spin")} /></Button>
          {/* The order that decides the agent the bar shows is set in the settings: the gear opens them onto it. */}
          <Button variant="ghost" size="icon" data-limits-settings aria-label={stackLabel} title={stackLabel}
            onClick={() => { setOpen(false); openSettings("ai", "tasksAi"); }} className="-mr-2 size-7 text-muted hover:text-ink narrow:mr-0 narrow:size-9">
            <Icon name="settings" className="size-3.5" /></Button>
        </span></span>}>
      <div data-limits-menu lang={i18n.language} className="pt-2">
        {agents.map(agent => <AgentBlock key={agent.adapter} agent={agent} stack={limits.data!.stack} now={now}
          shown={agent.adapter === shown.agent.adapter ? shownWindow : null} />)}
      </div>
    </Popup>}
  </>;
}
