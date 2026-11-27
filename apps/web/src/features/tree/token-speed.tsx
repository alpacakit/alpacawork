/**
 * Live output speed on the In progress rows: each row's number and last minute's bars in a column at the title column's
 * end, before the time; the heading's total agents and speed; on a phone, the speed in the row's end words.
 *
 * The numbers come from each running Run's output ledger (`activity.output`), summed by runOutputSpeed. Only the speed
 * cells follow the clock: each reads the workspace once a second and re-renders only when what it shows has changed,
 * so a tick neither re-renders the rows nor changes any layout (every number sits in a fixed-width slot).
 */
import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { OUTPUT_BARS, runOutputSpeed, type RunOutputSpeed } from "@alpacawork/contract/run";
import { AgentMark } from "@/components/ui/agent-mark";
import { useServerSettings } from "@/data/queries";
import { agentKind } from "@/domain/agent-mark";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Task } from "@/data/types";
import { useWorkspaceSelector, useWorkspaceStore, type WorkspaceData } from "@/data/workspace-store";
import { runningRunsSaid } from "@/domain/row-status";
import { cn } from "@/lib/utils";

/** The one second clock the speed cells share, in Unix seconds as the ledgers count; it runs only while a cell shows. */
let second = Math.floor(Date.now() / 1000);
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribeSecond(listener: () => void) {
  listeners.add(listener);
  if (!timer) second = Math.floor(Date.now() / 1000);
  timer ??= setInterval(() => {
    second = Math.floor(Date.now() / 1000);
    for (const each of listeners) each();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}

/** The Runs a row's speed sums: its own running Runs and those under it; none on a row that says no agents run. */
function rowRunIds(task: Task, data: WorkspaceData): string[] {
  if (!runningRunsSaid(task)) return [];
  const own = (data.people.runsByTask.get(task.id) ?? []).filter((run) => run.state === "running").map((run) => run.id);
  return [...new Set([...own, ...(task.runsBelow ?? []).map(([id]) => id)])];
}

/**
 * The agents running on rows and under them, by agent name, most first (then by name). The server counts them, so a
 * Run no read has brought yet still counts: the count its Runs do not name stands under null.
 */
export function runningAgents(tasks: readonly Task[], data: WorkspaceData): [string | null, number][] {
  const counts = new Map<string | null, number>();
  for (const task of tasks) {
    let named = 0;
    for (const id of rowRunIds(task, data)) {
      const agent = data.people.runs.get(id)?.agent;
      if (!agent) continue;
      named++;
      counts.set(agent, (counts.get(agent) ?? 0) + 1);
    }
    const unnamed = runningRunsSaid(task) - named;
    if (unnamed > 0) counts.set(null, (counts.get(null) ?? 0) + unnamed);
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
}

/**
 * The In progress rows the bars share one scale over, so rows compare by eye: set by the heading after it renders. A
 * row drawn before the heading has set it reads the scale at the next second.
 */
let scaleTasks: readonly Task[] = [];
/** Each row's speed and the shared scale, worked out once per workspace state and second for every cell to read. */
let computed: { data: WorkspaceData; now: number; tasks: readonly Task[]; speeds: Map<string, RunOutputSpeed | null>; scale: number | null } | null = null;
function moment(data: WorkspaceData, now: number) {
  if (computed?.data !== data || computed.now !== now || computed.tasks !== scaleTasks)
    computed = { data, now, tasks: scaleTasks, speeds: new Map(), scale: null };
  return computed;
}
function rowSpeed(task: Task, data: WorkspaceData, now: number): RunOutputSpeed | null {
  const at = moment(data, now);
  if (!at.speeds.has(task.id)) {
    const ids = rowRunIds(task, data);
    at.speeds.set(task.id, ids.length ? runOutputSpeed(ids.map((id) => data.people.runs.get(id)?.activity?.output), now) : null);
  }
  return at.speeds.get(task.id)!;
}
function sharedScale(data: WorkspaceData, now: number) {
  const at = moment(data, now);
  if (at.scale === null) {
    let peak = 50;
    for (const task of scaleTasks) for (const bar of rowSpeed(task, data, now)?.bars ?? []) peak = Math.max(peak, bar);
    at.scale = Math.round(peak);
  }
  return at.scale;
}

const shown = (rate: number) => rate >= 100 ? Math.round(rate / 5) * 5 : Math.round(rate);
const formatRate = (rate: number) => rate >= 10_000 ? `${Math.round(rate / 1000)}k` : rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : String(rate);
/** What a cell shows, as one string: equal strings skip the re-render. Empty when none of its Runs is measured. */
function useSpeedKey(read: (data: WorkspaceData, now: number) => string) {
  const store = useWorkspaceStore();
  // Before the clock runs (a section just opened), read the time now rather than when it last stopped.
  return useSyncExternalStore(subscribeSecond, () => read(store.getState(), timer ? second : Math.floor(Date.now() / 1000)));
}

/** `live`: output counted in the 5 seconds ending now; otherwise the rate is the latest one held between model calls. */
type RowShown = { rate: number; live: boolean; bars: number[]; scale: number };
/** A minute of bars that counted nothing: what a row says while its agents have output nothing measured yet. */
const SILENT_BARS: readonly number[] = Array(OUTPUT_BARS).fill(0);
/**
 * A working row says 0 from its first moment, before its agents' first counted output arrives, so its speed never
 * stands empty while it works. A row with no agent running says nothing.
 */
const rowKey = (task: Task) => (data: WorkspaceData, now: number) => {
  const speed = rowSpeed(task, data, now);
  if (!speed) return runningRunsSaid(task)
    ? JSON.stringify({ rate: 0, live: false, bars: [...SILENT_BARS], scale: sharedScale(data, now) } satisfies RowShown) : "";
  const bars = speed.bars.map(shown);
  return JSON.stringify({ rate: shown(speed.rate), live: bars.at(-1)! > 0, bars, scale: sharedScale(data, now) } satisfies RowShown);
};

/**
 * A number in its fixed slot, right-aligned: in ink while output is counted now, the same ink faded while the latest
 * rate is held between model calls, and quiet at 0.
 */
function RateNumber({ rate, live, className }: { rate: number; live: boolean; className?: string }) {
  return <span className={cn("inline-block w-7 flex-none text-right tabular-nums", !rate ? "text-muted/50" : live ? "text-ink" : "text-ink/55", className)}>{formatRate(rate)}</span>;
}

/** The bars' slot, also the heading's unit's: 12 bars of 3px with 1px between. */
const BARS_WIDTH = 48, BARS_HEIGHT = 14;
/**
 * The last minute as 12 five-second bars in the working colour (the row's time's): older ones faint, the latest full,
 * standing on one faint baseline that is all a silent stretch shows. Its foot sits on the text's baseline.
 */
function MinuteBars({ bars, scale }: { bars: number[]; scale: number }) {
  return <svg width={BARS_WIDTH} height={BARS_HEIGHT} viewBox={`0 0 ${BARS_WIDTH} ${BARS_HEIGHT}`} aria-hidden="true" className="flex-none">
    <rect x={0} y={BARS_HEIGHT - 1} width={BARS_WIDTH - 1} height={1} className="fill-working" fillOpacity={0.25} />
    {bars.map((value, i) => {
      if (!value) return null;
      const top = Math.max(2, Math.round((value / scale) * BARS_HEIGHT));
      return <rect key={i} x={i * 4} y={BARS_HEIGHT - top} width={3} height={top} className="fill-working" fillOpacity={i === bars.length - 1 ? 1 : 0.45} />;
    })}
  </svg>;
}

function rowTip(t: (key: string, options?: Record<string, unknown>) => string, row: RowShown) {
  const peak = Math.max(...row.bars), mean = Math.round(row.bars.reduce((sum, bar) => sum + bar, 0) / row.bars.length);
  return t("speed.rowTip", { rate: formatRate(row.rate), mean: formatRate(mean), peak: formatRate(peak) });
}

/**
 * The speed column at the title column's end, before the row's time: a number and the minute's bars, or the number alone
 * beside a narrow list. Its width is its number's slot, the gap and the bars, and the room before the time (pr-2; a
 * step more, pr-3, beside a narrow list, where no bars stand between): nothing left over on either side.
 */
export const SPEED_LANE = 92;
const COMPACT_LANE = 40;
/** A list narrower than this (the detail open beside it) keeps its time strip's room with the number alone; under 600px there is no column. */
const FULL_LANE_SHEET = 900;
export const speedLane = (sheet: number) => sheet < FULL_LANE_SHEET ? COMPACT_LANE : SPEED_LANE;

/** One cell of the speed column, in every row and heading alike, so the numbers stand in one column. */
export function SpeedLane({ width, className, children }: { width: number; className?: string; children?: ReactNode }) {
  return <div data-speed-lane style={{ width }} className={cn("flex flex-none justify-end pr-2 text-xs", className)}>{children}</div>;
}

/**
 * A wide row's speed in the column: the number and the minute's bars, 0 over an empty baseline while it is silent.
 */
export function RowTokenSpeed({ task, compact }: { task: Task; compact: boolean }) {
  const { t } = useTranslation("tree");
  const key = useSpeedKey(rowKey(task));
  if (!key) return null;
  const row = JSON.parse(key) as RowShown;
  return <span data-token-speed title={rowTip(t, row)} className={cn("flex items-baseline whitespace-nowrap", compact ? "gap-1" : "gap-2")}>
    <RateNumber rate={row.rate} live={row.live} />
    {!compact && <MinuteBars bars={row.bars} scale={row.scale} />}
  </span>;
}

/** The section's total: the sum of the numbers its rows show (0 for a working row not measured yet), so the two always add up. */
const totalKey = (tops: readonly Task[]) => (data: WorkspaceData, now: number) => {
  let total = 0, measured = false;
  for (const task of tops) {
    const speed = rowSpeed(task, data, now);
    if (speed) { measured = true; total += shown(speed.rate); }
    else if (runningRunsSaid(task)) measured = true;
  }
  return measured ? String(total) : "";
};

/**
 * What the speed column means, behind a small mark in its heading: the card opens on a press, phones included, and
 * says that a 0 may only be an agent waiting on a command.
 */
function SpeedHelp({ bars, className }: { bars: boolean; className?: string }) {
  const { t } = useTranslation("tree");
  return <Popover>
    <PopoverTrigger data-speed-help aria-label={t("speed.help")} onClick={event => event.stopPropagation()}
      className={cn("relative inline-flex size-4 flex-none cursor-pointer items-center justify-center rounded-full text-muted outline-none before:absolute before:-inset-3 before:content-[''] pointer-fine:hover:bg-hover pointer-fine:hover:text-ink focus-visible:ring-2 focus-visible:ring-ink/40", className)}>
      <Icon name="help" className="size-3.5" /></PopoverTrigger>
    <PopoverContent align="end" className="w-64 p-3 text-xs font-normal" onClick={event => event.stopPropagation()}>
      <p className="m-0">{t("speed.helpSpeed")}</p>
      {bars && <p className="m-0 mt-1">{t("speed.helpBars")}</p>}
      <p className="m-0 mt-2 border-t border-rule pt-2">{t("speed.helpZero")}</p>
    </PopoverContent>
  </Popover>;
}

/**
 * The In progress heading's total in the speed column, with the unit that names the column below and the column's help
 * after it, so the help reads as the speed's and not as one more AI's mark; its number stands over the rows' numbers and
 * the unit where their bars do. Beside a narrow list the number alone (HeadingSpeedUnit says the rest).
 */
export function HeadingTokenSpeed({ tops, compact }: { tops: readonly Task[]; compact: boolean }) {
  const { t } = useTranslation("tree");
  useLayoutEffect(() => { scaleTasks = tops; }, [tops]);
  const key = useSpeedKey(totalKey(tops));
  if (!key) return null;
  return <span data-token-speed className={cn("flex items-baseline whitespace-nowrap font-normal", compact ? "gap-1" : "gap-2")}>
    <span title={t("speed.totalTip", { count: tops.length })} className="contents">
      <RateNumber rate={Number(key)} live className="font-medium" />
    </span>
    {!compact && <span style={{ width: BARS_WIDTH }} className="flex flex-none items-center gap-1 text-[11px] text-muted">
      <span title={t("speed.totalTip", { count: tops.length })}>{t("speed.unit")}</span>
      <SpeedHelp bars />
    </span>}
  </span>;
}

/**
 * Beside a narrow list the speed column holds the numbers alone; the heading's short unit and the help stand in its
 * empty time column (RowTimeRoom), so no row keeps room for them.
 */
export function HeadingSpeedUnit({ tops }: { tops: readonly Task[] }) {
  const { t } = useTranslation("tree");
  if (!useSpeedKey(totalKey(tops))) return null;
  return <>
    <span title={t("speed.totalTip", { count: tops.length })} className="text-[10px] text-muted">{t("speed.perSecond")}</span>
    <SpeedHelp bars={false} />
  </>;
}

/** The time's slot after it on In progress rows: a fixed width so the squares line up whatever the time says. */
export const TIME_SLOT = "inline-block min-w-[3.75em] text-right narrow:min-w-[3.5em]";
/** The speed's slot on a phone, held while agents run so the columns stay put before a count arrives. */
const NARROW_SPEED_SLOT = "inline-block min-w-[5ch] text-right tabular-nums";

/** The most kinds of AI a row names; the rest are one "+count" of their agents. */
const KINDS_SHOWN = 3;
/** Where each kind stands, so an AI keeps its order from row to row; agents of no known kind come after them. */
const KIND_ORDER: readonly string[] = ["claude", "codex", "grok", "copilot", "pi"];

/**
 * Which AIs run and how many: each AI's logo with how many of it beside, on the text's line, past one ("✳2 ◎2 In"),
 * in the kinds' order and packed to the right, so they end where the heading's and every row's end, before the time;
 * past three kinds, a "+count" of the rest. Logos stand side by side as their makers draw them. Its press lists each
 * agent's count, and a reader hears the total and each agent's name and count. Runs no read has brought stand as the
 * square with their count.
 */
export function AgentCounts({ tasks }: { tasks: readonly Task[] }) {
  const { t } = useTranslation("tree");
  const settings = useServerSettings().data?.agents;
  const key = useWorkspaceSelector((data) => JSON.stringify(runningAgents(tasks, data)));
  const agents = JSON.parse(key) as [string | null, number][];
  if (!agents.length) return null;
  const total = agents.reduce((sum, [, count]) => sum + count, 0);
  const words = agents.map(([agent, count]) => `${agent ?? "?"} ${count}`).join(", ");
  const place = (agent: string | null) => {
    if (agent === null) return KIND_ORDER.length + 1;
    const at = KIND_ORDER.indexOf(agentKind(agent, settings?.[agent]?.adapter) ?? "");
    return at < 0 ? KIND_ORDER.length : at;
  };
  const ordered = [...agents].sort(([a], [b]) => place(a) - place(b));
  const shown = ordered.slice(0, KINDS_SHOWN), rest = ordered.slice(KINDS_SHOWN).reduce((sum, [, count]) => sum + count, 0);
  return <span data-agent-counts title={words} className="flex flex-none items-center gap-x-2.5 self-center whitespace-nowrap tabular-nums">
    <span className="sr-only">{`${t("status.runningRuns", { count: total })}: ${words}`}</span>
    {/* A logo and its count share one middle: the count's box is trimmed to its figures, so their middle is the logo's. */}
    {shown.map(([agent, count]) => <span key={agent ?? ""} data-agent aria-hidden="true" className="flex flex-none items-center gap-1">
      {agent === null ? <Icon name="runningRuns" className="size-[0.7em] text-muted" /> : <AgentMark name={agent} className="size-[1.05em]" />}
      {(count > 1 || agent === null) && <span className="text-[0.8em] font-medium text-ink/70 cap-box">{count}</span>}
    </span>)}
    {rest > 0 && <span aria-hidden="true" className="text-[0.8em] text-muted cap-box">+{rest}</span>}
  </span>;
}

/** The heading's agents in all, as the rows say theirs (with, on a phone, the total speed and the speed's help). */
export function HeadingAgents({ tops, narrow, timeApart }: { tops: readonly Task[]; narrow: boolean; timeApart?: boolean }) {
  const agents = tops.reduce((sum, task) => sum + runningRunsSaid(task), 0);
  if (!agents) return null;
  // The heading stands on the rows' grid: its agents over theirs, its total over their speeds, and on a phone the help
  // in the column the rows give their time (the heading has none).
  return <span data-heading-agents className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-xs font-normal tabular-nums text-muted">
    <AgentCounts tasks={tops} />
    {narrow && <NarrowTotal tops={tops} />}
    {narrow ? <span className={cn(TIME_SLOT, "self-center text-left")}><SpeedHelp bars={false} className="align-middle" /></span>
      : !timeApart && <span aria-hidden="true" className={cn(TIME_SLOT, "invisible")}>0</span>}
  </span>;
}

function NarrowTotal({ tops }: { tops: readonly Task[] }) {
  const { t } = useTranslation("tree");
  const key = useSpeedKey(totalKey(tops));
  return <span title={t("speed.totalTip", { count: tops.length })} className={NARROW_SPEED_SLOT}>
    {key && <><span className="font-medium text-ink">{formatRate(Number(key))}</span><span className="text-[0.85em]">{t("speed.perSecond")}</span></>}
  </span>;
}

/** On a phone, where the rows lie across the strips: the speed in its own slot after the square, 0 while silent. */
export function NarrowTokenSpeed({ task }: { task: Task }) {
  const { t } = useTranslation("tree");
  const key = useSpeedKey(rowKey(task));
  const row = key ? JSON.parse(key) as RowShown : null;
  return <span title={row ? rowTip(t, row) : undefined} className={NARROW_SPEED_SLOT}>
    {row && <><span className={row.rate ? "text-muted" : "text-muted/50"}>{formatRate(row.rate)}</span><span className="text-[0.85em] text-muted">{t("speed.perSecond")}</span></>}
  </span>;
}
