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
import { runOutputSpeed, type RunOutputSpeed } from "@alpacawork/contract/run";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Task } from "@/data/types";
import { useWorkspaceStore, type WorkspaceData } from "@/data/workspace-store";
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
const rowKey = (task: Task) => (data: WorkspaceData, now: number) => {
  const speed = rowSpeed(task, data, now);
  if (!speed) return "";
  const bars = speed.bars.map(shown);
  return JSON.stringify({ rate: shown(speed.rate), live: bars.at(-1)! > 0, bars, scale: sharedScale(data, now) } satisfies RowShown);
};

/**
 * A number in its fixed slot, right-aligned: in ink while output is counted now, the same ink faded while the latest
 * rate is held between model calls, and quiet at 0.
 */
function RateNumber({ rate, live, className }: { rate: number; live: boolean; className?: string }) {
  return <span className={cn("inline-block w-8 flex-none text-right tabular-nums", !rate ? "text-muted/50" : live ? "text-ink" : "text-ink/55", className)}>{formatRate(rate)}</span>;
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
/** Beside a narrow list the bars' slot holds only the heading's unit, as wide on every row so the numbers line up. */
const UNIT_WIDTH = 24;

function rowTip(t: (key: string, options?: Record<string, unknown>) => string, row: RowShown) {
  const peak = Math.max(...row.bars), mean = Math.round(row.bars.reduce((sum, bar) => sum + bar, 0) / row.bars.length);
  return t("speed.rowTip", { rate: formatRate(row.rate), mean: formatRate(mean), peak: formatRate(peak) });
}

/** The speed column at the title column's end, before the time: a number and the minute's bars, or the number alone beside a narrow list. */
export const SPEED_LANE = 112;
const COMPACT_LANE = 72;
/** A list narrower than this (the detail open beside it) keeps its time strip's room with the number alone; under 600px there is no column. */
const FULL_LANE_SHEET = 900;
export const speedLane = (sheet: number) => sheet < FULL_LANE_SHEET ? COMPACT_LANE : SPEED_LANE;

/** One cell of the speed column, in every row and heading alike, so the numbers stand in one column. */
export function SpeedLane({ width, className, children }: { width: number; className?: string; children?: ReactNode }) {
  return <div data-speed-lane style={{ width }} className={cn("flex flex-none justify-end pr-3 text-xs", className)}>{children}</div>;
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
    {compact ? <span aria-hidden="true" style={{ width: UNIT_WIDTH }} className="flex-none" /> : <MinuteBars bars={row.bars} scale={row.scale} />}
  </span>;
}

/** The section's total: the sum of the numbers its rows show, so the two always add up. */
const totalKey = (tops: readonly Task[]) => (data: WorkspaceData, now: number) => {
  let total = 0, measured = false;
  for (const task of tops) {
    const speed = rowSpeed(task, data, now);
    if (speed) { measured = true; total += shown(speed.rate); }
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
 * The In progress heading's total in the speed column, with the unit that names the column below; its number stands
 * over the rows' numbers and the unit where their bars do (beside a narrow list, in the slot the rows keep empty).
 */
export function HeadingTokenSpeed({ tops, compact }: { tops: readonly Task[]; compact: boolean }) {
  const { t } = useTranslation("tree");
  useLayoutEffect(() => { scaleTasks = tops; }, [tops]);
  const key = useSpeedKey(totalKey(tops));
  if (!key) return null;
  return <span data-token-speed className={cn("flex items-baseline whitespace-nowrap font-normal", compact ? "gap-1" : "gap-2")}>
    <SpeedHelp bars={!compact} className="self-center" />
    <span title={t("speed.totalTip", { count: tops.length })} className={cn("flex items-baseline", compact ? "gap-1" : "gap-2")}>
    <RateNumber rate={Number(key)} live className="font-medium" />
    <span style={{ width: compact ? UNIT_WIDTH : BARS_WIDTH }} className={cn("flex-none text-muted", compact ? "text-[10px]" : "text-[11px]")}>{t("speed.unit")}</span>
    </span>
  </span>;
}

/** The agents' slot at a row's end: the square and its count, right-aligned in a fixed width so the squares line up. */
export const AGENT_SLOT = "inline-block min-w-[2.75em] text-right";
/** The time's slot after it on In progress rows: a fixed width so the squares line up whatever the time says. */
export const TIME_SLOT = "inline-block min-w-[4.5em] text-right narrow:min-w-[3.5em]";
/** The speed's slot on a phone, held while agents run so the columns stay put before a count arrives. */
const NARROW_SPEED_SLOT = "inline-block min-w-[5ch] text-right tabular-nums";

/** The heading's agents in all, in the rows' square slot (with, on a phone, the total speed after it). */
export function HeadingAgents({ tops, narrow }: { tops: readonly Task[]; narrow: boolean }) {
  const { t } = useTranslation("tree");
  const agents = tops.reduce((sum, task) => sum + runningRunsSaid(task), 0);
  if (!agents) return null;
  return <span data-heading-agents className="flex flex-none items-baseline gap-1.5 whitespace-nowrap text-xs font-normal tabular-nums text-muted">
    <span className={AGENT_SLOT}>
      <span aria-hidden="true"><Icon name="runningRuns" className="mr-0.5 inline size-[0.7em] align-[-0.02em]" />{agents}</span>
      <span className="sr-only">{t("status.runningRuns", { count: agents })}</span>
    </span>
    {narrow && <><SpeedHelp bars={false} className="self-center" /><NarrowTotal tops={tops} /></>}
    <span aria-hidden="true" className={cn(TIME_SLOT, "invisible")}>0</span>
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
