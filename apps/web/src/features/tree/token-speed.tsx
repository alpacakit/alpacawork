/**
 * Live output speed on the In progress rows: each row's number and last minute's bars in a column at the title column's
 * end, before the time; the heading's total agents and speed; on a phone, the speed in the row's end words.
 *
 * The numbers come from each running Run's output ledger (`activity.output`), summed by runOutputSpeed. Only the speed
 * cells follow the clock: each reads the workspace once a second and re-renders only when what it shows has changed,
 * so a tick neither re-renders the rows nor changes any layout (every number sits in a fixed-width slot).
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { runOutputSpeed, type RunOutputSpeed } from "@alpacawork/contract/run";
import { Icon } from "@/components/ui/icon";
import type { Task } from "@/data/types";
import { useWorkspaceSelector, useWorkspaceStore, type WorkspaceData } from "@/data/workspace-store";
import { runningRunsSaid, shortLength } from "@/domain/row-status";
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
/** One minute of silence turns the bars into how long it has been silent. */
const IDLE_SECONDS = 60;

/** What a cell shows, as one string: equal strings skip the re-render. Empty when none of its Runs is measured. */
function useSpeedKey(read: (data: WorkspaceData, now: number) => string) {
  const store = useWorkspaceStore();
  // Before the clock runs (a section just opened), read the time now rather than when it last stopped.
  return useSyncExternalStore(subscribeSecond, () => read(store.getState(), timer ? second : Math.floor(Date.now() / 1000)));
}

/** `live`: output counted in the 5 seconds ending now; otherwise the rate is the latest one held between model calls. */
type RowShown = { rate: number; live: boolean; bars: number[]; scale: number; idle: number };
/** `idle` is kept only as shown (whole minutes, from one minute up), so a silent row does not re-render every second. */
const rowKey = (task: Task) => (data: WorkspaceData, now: number) => {
  const speed = rowSpeed(task, data, now);
  if (!speed) return "";
  const idle = speed.idleSeconds >= IDLE_SECONDS ? Math.floor(speed.idleSeconds / 60) * 60 : 0;
  const bars = speed.bars.map(shown);
  return JSON.stringify({ rate: shown(speed.rate), live: bars.at(-1)! > 0, bars, scale: sharedScale(data, now), idle } satisfies RowShown);
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

function useIdleWords() {
  const { t } = useTranslation("tree");
  return (seconds: number) => {
    const { unit, count } = shortLength(seconds * 1000);
    const length = unit === "minutes" ? t("status.length.minutes", { count }) : unit === "hours" ? t("status.length.hours", { count })
      : t("status.length.days", { count });
    return t("speed.idle", { length });
  };
}

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

/** A wide row's speed in the column; after a minute of silence, how long it has been silent in place of the bars. */
export function RowTokenSpeed({ task, compact }: { task: Task; compact: boolean }) {
  const { t } = useTranslation("tree");
  const idleWords = useIdleWords();
  const key = useSpeedKey(rowKey(task));
  if (!key) return null;
  const row = JSON.parse(key) as RowShown;
  const idle = row.idle >= IDLE_SECONDS;
  // While silent the bars keep their baseline and the words take the number's place, so the column does not jump.
  return <span data-token-speed title={idle && compact ? idleWords(row.idle) : rowTip(t, row)} className={cn("flex items-baseline whitespace-nowrap", compact ? "gap-1" : "gap-2")}>
    {idle ? <span className="text-muted">{compact ? t("speed.idleShort") : idleWords(row.idle)}</span> : <RateNumber rate={row.rate} live={row.live} />}
    {compact ? <span aria-hidden="true" style={{ width: UNIT_WIDTH }} className="flex-none" /> : <MinuteBars bars={idle ? [] : row.bars} scale={row.scale} />}
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
 * The In progress heading's total in the speed column, with the unit that names the column below; its number stands
 * over the rows' numbers and the unit where their bars do (beside a narrow list, in the slot the rows keep empty).
 */
export function HeadingTokenSpeed({ tops, compact }: { tops: readonly Task[]; compact: boolean }) {
  const { t } = useTranslation("tree");
  useLayoutEffect(() => { scaleTasks = tops; }, [tops]);
  const key = useSpeedKey(totalKey(tops));
  if (!key) return null;
  return <span data-token-speed title={t("speed.totalTip", { count: tops.length })} className={cn("flex items-baseline whitespace-nowrap font-normal", compact ? "gap-1" : "gap-2")}>
    <RateNumber rate={Number(key)} live className="font-medium" />
    <span style={{ width: compact ? UNIT_WIDTH : BARS_WIDTH }} className={cn("flex-none text-muted", compact ? "text-[10px]" : "text-[11px]")}>{t("speed.unit")}</span>
  </span>;
}

/** The time's slot after it on In progress rows: a fixed width so the squares line up whatever the time says. */
export const TIME_SLOT = "inline-block min-w-[4.5em] text-right narrow:min-w-[3.5em]";
/** The speed's slot on a phone, held while agents run so the columns stay put before a count arrives. */
const NARROW_SPEED_SLOT = "inline-block min-w-[5ch] text-right tabular-nums";

/** Room kept for the "+count" that stands for the agents left out. */
const REST_WIDTH = 20, AGENT_GAP = 10;

/**
 * Which agents run and how many: each agent's name and its count, most first, so a row says "claude 2  codex 1" at a
 * glance. It takes the room the row leaves it: the names that do not fit stand as one "+count" of their agents (none
 * fitting, the square and the total), and its press lists them all. A count no loaded Run names keeps the square. Read
 * as words, it is the total and then each agent's count.
 */
export function AgentCounts({ tasks }: { tasks: readonly Task[] }) {
  const { t } = useTranslation("tree");
  const key = useWorkspaceSelector((data) => JSON.stringify(runningAgents(tasks, data)));
  const agents = JSON.parse(key) as [string | null, number][];
  const box = useRef<HTMLSpanElement>(null);
  // How many names fit; all of them while measuring, after the agents or the row's width change.
  const [fit, setFit] = useState({ key, count: agents.length });
  const measuring = fit.key !== key || fit.count >= agents.length;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !measuring) return;
    const widths = [...el.querySelectorAll<HTMLElement>("[data-agent]")].map((item) => item.offsetWidth);
    let count = widths.length;
    if (el.scrollWidth > el.clientWidth + 1) {
      let used = REST_WIDTH;
      count = 0;
      while (count < widths.length && used + widths[count]! + AGENT_GAP <= el.clientWidth) used += widths[count++]! + AGENT_GAP;
    }
    if (fit.key !== key || fit.count !== count) setFit({ key, count });
  });
  // Measure again when the row's width changes, or when what stands beside it (a time that arrives) squeezes it.
  useLayoutEffect(() => {
    // The title column's cell on a computer (its row's width does not follow the column), the heading, or a phone's row.
    const el = box.current, row = el?.closest("[data-row-label], h2, li");
    if (!el || !row || typeof ResizeObserver === "undefined") return;
    let width = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === width && el.scrollWidth <= el.clientWidth + 1) return;
      width = row.clientWidth;
      setFit((was) => ({ key: was.key, count: Number.MAX_SAFE_INTEGER }));
    });
    observer.observe(row);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  if (!agents.length) return null;
  const total = agents.reduce((sum, [, count]) => sum + count, 0);
  const words = agents.map(([agent, count]) => `${agent ?? "?"} ${count}`).join(", ");
  const named = measuring ? agents : agents.slice(0, fit.count);
  const rest = agents.slice(named.length).reduce((sum, [, count]) => sum + count, 0);
  return <span ref={box} data-agent-counts title={words} className="flex min-w-0 shrink items-baseline gap-2.5 overflow-hidden whitespace-nowrap tabular-nums">
    <span className="sr-only">{`${t("status.runningRuns", { count: total })}: ${words}`}</span>
    {named.map(([agent, count]) => <span key={agent ?? ""} data-agent aria-hidden="true" className="flex-none">
      {agent === null ? <Icon name="runningRuns" className="mr-0.5 inline size-[0.7em] align-[-0.02em] text-muted" />
        : <span className="mr-1 text-muted">{agent}</span>}
      <span className="text-ink/80">{count}</span>
    </span>)}
    {rest > 0 && <span aria-hidden="true" className="flex-none text-muted">
      {named.length ? `+${rest}` : <><Icon name="runningRuns" className="mr-0.5 inline size-[0.7em] align-[-0.02em]" />{rest}</>}
    </span>}
  </span>;
}

/** The heading's agents in all, as the rows say theirs (with, on a phone, the total speed after it). */
export function HeadingAgents({ tops, narrow }: { tops: readonly Task[]; narrow: boolean }) {
  const agents = tops.reduce((sum, task) => sum + runningRunsSaid(task), 0);
  if (!agents) return null;
  return <span data-heading-agents className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap text-xs font-normal tabular-nums text-muted">
    <AgentCounts tasks={tops} />
    {narrow && <NarrowTotal tops={tops} />}
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

/** On a phone, where the rows lie across the strips: the speed in its own slot after the square; after a minute of silence, that it is silent. */
export function NarrowTokenSpeed({ task }: { task: Task }) {
  const { t } = useTranslation("tree");
  const key = useSpeedKey(rowKey(task));
  const row = key ? JSON.parse(key) as RowShown : null;
  return <span title={row ? rowTip(t, row) : undefined} className={NARROW_SPEED_SLOT}>
    {row && (row.idle >= IDLE_SECONDS ? <span className="text-muted/70">{t("speed.idleShort")}</span>
      : <><span className={row.rate ? "text-muted" : "text-muted/50"}>{formatRate(row.rate)}</span><span className="text-[0.85em] text-muted">{t("speed.perSecond")}</span></>)}
  </span>;
}
