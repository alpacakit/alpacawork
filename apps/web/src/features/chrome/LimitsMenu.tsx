import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useRefreshAgentLimits } from "@/data/queries";
import { notify } from "@/lib/notify";
import { Popup } from "@/components/ui/popup";
import { useFrameSelector } from "@/data/workspace-store";
import { resources } from "@/data/resources";
import { barLimit, besideModelWindow, limitTone, readWords, resetWords, windowLabel } from "@/domain/limits";
import { AGENT_NAMES } from "@/domain/agent-names";
import { useNow } from "@/state/clock";
import { cn } from "@/lib/utils";
import { TONE_FILL, TONE_TEXT, UsageRing, percentText } from "@/components/ui/usage-ring";

/* Hallmark · component: plan limits in the bar · genre: modern-minimal · theme: the app's own tokens (working, warn, error, line) */

/**
 * One window in the menu: its name, how full it is, and under them when it resets. The reset has the row's whole width,
 * so a long one (a weekday and a time, in any language) stays on its line.
 */
function WindowRow({ window, now, scoped }: { window: LimitWindow; now: number; scoped: boolean }) {
  const { t, i18n } = useTranslation("chrome");
  const tone = limitTone(window.usedPercent);
  const reset = resetWords(window.resetsAt, now, i18n.language, t);
  // The label's and the percent's boxes are trimmed to their letters (capitals over the baseline), so centring the line
  // centres what is drawn: the bar stands level with the words, not with their line boxes (which sit about 1px lower).
  return <li data-limit-window={window.kind} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-1.5">
    <span className="[text-box:trim-both_cap_alphabetic]">{windowLabel(window, t, scoped)}</span>
    <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-line">
      <span className={cn("block h-full rounded-full", TONE_FILL[tone])} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
    </span>
    <span className={cn("text-right font-medium tabular-nums [text-box:trim-both_cap_alphabetic]", TONE_TEXT[tone])}>{percentText(window.usedPercent)}</span>
    {reset && <span className="col-span-full text-xs text-muted">{reset}</span>}
  </li>;
}

/** An agent's windows under its name; one with none to show says why on its name's line (under it when the words are long). */
function AgentBlock({ agent, now }: { agent: AgentLimits; now: number }) {
  const { t } = useTranslation("chrome");
  const name = AGENT_NAMES[agent.adapter].short;
  const note = agent.state === "unsupported" ? t("limits.unsupported") : agent.state === "unavailable" ? t("limits.unavailable")
    : agent.windows.length === 0 ? t("limits.none") : null;
  return <section data-limit-agent={agent.adapter} aria-label={name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 not-first:border-t not-first:border-line">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="m-0 text-sm font-semibold">{name}</h3>
      {/* Whose limits these are: the account the agent is signed in as, cut to the menu's width (whole in the tooltip). */}
      {agent.account && <span data-limit-account className="min-w-0 max-w-full truncate text-xs text-muted" title={agent.account}>{agent.account}</span>}
      {note && <p className="m-0 text-sm text-muted">{note}</p>}
    </div>
    {!note && <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm">{agent.windows.map((window, at) =>
      <WindowRow key={at} window={window} now={now} scoped={besideModelWindow(window, agent.windows)} />)}</ul>}
  </section>;
}

/**
 * The bar's plan limits: the first agent tasks use, its fullest window (the one that stops it first) as a ring, its name
 * and a percent (the ring and the percent on a phone); "—" while its own are unknown. A press opens every agent's windows
 * with when each resets and the account each is signed in as. Nothing shows until some agent's limits are known.
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
  const shown = barLimit(agents);
  if (!shown) return null;
  const percent = shown.window?.usedPercent ?? 0;
  const tone = limitTone(percent);
  const name = AGENT_NAMES[shown.agent.adapter].short;
  const label = shown.window ? t("limits.barLabel", { agent: name, window: windowLabel(shown.window, t), percent: percentText(percent) })
    : t("limits.barUnknown", { agent: name });
  const read = readWords(agents.map(agent => agent.observedAt).filter(at => at !== null).sort()[0] ?? null, now, t);
  return <>
    <Button ref={trigger} variant="ghost" size="bar" data-limits-trigger data-tone={tone} aria-haspopup="dialog" aria-expanded={open}
      aria-label={label} title={label} onClick={() => setOpen(value => !value)} className="w-auto gap-1.5 px-2 narrow:w-auto narrow:px-2.5">
      <UsageRing percent={percent} tone={tone} />
      {/* Which agent and which of its windows the figure is: a computer has the room; a phone keeps the figure. The
          window's name goes first, where the buttons' side of the bar (AppBar BUTTONS) no longer holds it and it would
          take the search box's room. */}
      <span className="text-sm narrow:hidden">{name}</span>
      {shown.window && <span className="text-sm text-muted narrow:hidden @max-[64rem]:hidden">{windowLabel(shown.window, t)}</span>}
      <span className={cn("text-sm font-medium tabular-nums", shown.window ? TONE_TEXT[tone] : "text-muted")}>
        {shown.window ? percentText(percent) : "—"}</span>
    </Button>
    {open && <Popup open onOpenChange={setOpen} label={t("limits.title")} align="end" className="w-80 p-3" anchorRef={trigger}
      heading={<span className="flex items-center justify-between gap-3"><span>{t("limits.title")}</span>
        <span className="flex items-center gap-1 text-xs font-normal text-muted">
          <span aria-live="polite">{refreshing ? t("limits.refreshing") : read}</span>
          <Button variant="ghost" size="icon" data-limits-refresh aria-label={t("limits.refresh")} title={t("limits.refresh")}
            disabled={refreshing} onClick={() => void refresh().catch(error =>
              notify.failure(error, { about: "limits", text: t("limits.refreshFailed"), from: trigger.current }))} className="size-7 text-muted hover:text-ink narrow:size-9">
            <Icon name="reload" className={cn("size-3.5", refreshing && "animate-spin")} /></Button>
        </span></span>}>
      <div data-limits-menu lang={i18n.language}>
        {agents.map(agent => <AgentBlock key={agent.adapter} agent={agent} now={now} />)}
      </div>
    </Popup>}
  </>;
}
