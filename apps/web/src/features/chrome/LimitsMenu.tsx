import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AgentLimits, LimitWindow } from "@alpacawork/contract/agent-limits";
import { Button } from "@/components/ui/button";
import { Popup } from "@/components/ui/popup";
import { useFrameSelector } from "@/data/workspace-store";
import { resources } from "@/data/resources";
import { barLimit, limitTone, readWords, resetWords, windowLabel, type LimitTone } from "@/domain/limits";
import { AGENT_NAMES } from "@/domain/agent-names";
import { useNow } from "@/state/clock";
import { cn } from "@/lib/utils";

/* Hallmark · component: plan limits in the bar · genre: modern-minimal · theme: the app's own tokens (working, warn, error, line) */

const TONE_TEXT: Record<LimitTone, string> = { normal: "", near: "text-warn", spent: "text-error" };
const TONE_FILL: Record<LimitTone, string> = { normal: "bg-working", near: "bg-warn", spent: "bg-error" };
const TONE_STROKE: Record<LimitTone, string> = { normal: "stroke-working", near: "stroke-warn", spent: "stroke-error" };
const percentText = (value: number) => `${Math.round(value)}%`;

/** A ring filled as far as the window is used: the bar's mark, wide or narrow. */
function Ring({ percent, tone }: { percent: number; tone: LimitTone }) {
  const r = 6, length = 2 * Math.PI * r;
  return <svg aria-hidden viewBox="0 0 16 16" className="size-4 flex-none -rotate-90">
    <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-line" />
    <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" strokeLinecap="round" className={TONE_STROKE[tone]}
      strokeDasharray={`${length * Math.min(100, percent) / 100} ${length}`} />
  </svg>;
}

/** One window's line in the menu: its name, how full it is, and when it resets. */
function WindowRow({ window, now, scoped }: { window: LimitWindow; now: number; scoped: boolean }) {
  const { t, i18n } = useTranslation("chrome");
  const tone = limitTone(window.usedPercent);
  const reset = resetWords(window.resetsAt, now, i18n.language, t);
  return <li data-limit-window={window.kind} className="grid grid-cols-[7.5rem_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-0.5">
    <span className="text-muted">{windowLabel(window, t, scoped)}</span>
    <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-line">
      <span className={cn("block h-full rounded-full", TONE_FILL[tone])} style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
    </span>
    <span className={cn("text-right font-medium tabular-nums", TONE_TEXT[tone])}>{percentText(window.usedPercent)}</span>
    {reset && <span className="col-start-2 col-end-4 text-xs text-muted">{reset}</span>}
  </li>;
}

function AgentBlock({ agent, now }: { agent: AgentLimits; now: number }) {
  const { t } = useTranslation("chrome");
  const name = AGENT_NAMES[agent.adapter].short;
  // Beside a model's own window, the account's says it covers every model.
  const scoped = agent.windows.some(window => window.model !== null);
  const note = agent.state === "unsupported" ? t("limits.unsupported") : agent.state === "unavailable" ? t("limits.unavailable")
    : agent.windows.length === 0 ? t("limits.none") : null;
  return <section data-limit-agent={agent.adapter} aria-label={name} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 not-first:border-t not-first:border-line">
    <h3 className="m-0 text-sm font-semibold">{name}</h3>
    {note ? <p className="m-0 text-sm text-muted">{note}</p>
      : <ul className="m-0 flex list-none flex-col gap-2.5 p-0 text-sm">{agent.windows.map((window, at) => <WindowRow key={at} window={window} now={now} scoped={scoped} />)}</ul>}
  </section>;
}

/**
 * The bar's plan limits: the first agent tasks use, its fullest window (the one that stops it first) as a ring, its name
 * and a percent (the ring and the percent on a phone); "—" while its own are unknown. A press opens every agent's windows with when each resets. Nothing shows until
 * some agent's limits are known.
 */
export function LimitsMenu() {
  const { t, i18n } = useTranslation("chrome");
  // The bar is drawn before the first index: the limits are read once it names the workspace.
  const root = useFrameSelector(data => data?.info.root ?? null);
  const limits = useQuery({ ...resources.agentLimits(root ?? ""), enabled: !!root });
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
      aria-label={label} title={label} onClick={() => setOpen(value => !value)} className="w-auto gap-1.5 px-2 narrow:w-auto narrow:px-1.5">
      <Ring percent={percent} tone={tone} />
      {/* Which agent and which of its windows the figure is: a computer has the room; a phone keeps the figure. */}
      <span className="text-sm narrow:hidden">{name}</span>
      {shown.window && <span className="text-sm text-muted narrow:hidden">{windowLabel(shown.window, t)}</span>}
      <span className={cn("text-sm font-medium tabular-nums", shown.window ? TONE_TEXT[tone] : "text-muted")}>
        {shown.window ? percentText(percent) : "—"}</span>
    </Button>
    {open && <Popup open onOpenChange={setOpen} label={t("limits.title")} align="end" className="w-80 p-3" anchorRef={trigger}
      heading={<span className="flex items-baseline justify-between gap-3"><span>{t("limits.title")}</span>
        {read && <span className="text-xs font-normal text-muted">{read}</span>}</span>}>
      <div data-limits-menu lang={i18n.language}>
        {agents.map(agent => <AgentBlock key={agent.adapter} agent={agent} now={now} />)}
      </div>
    </Popup>}
  </>;
}
