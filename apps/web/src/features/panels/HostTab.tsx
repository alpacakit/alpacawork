import { apiError, errorText } from "@/data/client";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { heaviestText, type HostEpisode, type HostKind, type HostStatus } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { episodeReasons, formatGigabytes, formatPercent, formatVramFree, gpuModels, spanMinutes, sparkShape, type SparkPoint } from "@/domain/host";
import { calendarDayOffset, formatCalendarDate, formatClock } from "@/domain/time";
import { cn } from "@/lib/utils";
import { useMoveToTask } from "./use-move-to-task";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { ReadFailure } from "@/components/ui/loadable";
import { Message } from "@/components/ui/message";
import { modelLabel } from "@/domain/agent-label";

type Measured = Extract<HostStatus, { supported: true }>;
const HOUR = 3_600_000;
const SAMPLE = 10_000;
const iso = (at: number) => new Date(at).toISOString();

/**
 * Settings > Host status: is this machine keeping up, what is heavy now, and when was it tight before.
 * Read-only; the server samples every 10 s and this tab reads again at the same pace while it is open.
 */
export function HostTab() {
  const { t } = useTranslation("panels");
  const root = useWorkspaceInfo((info) => info.root);
  const status = useQuery({ ...resources.hostStatus(root), enabled: !!root });
  if (status.isError && !status.data) return <ReadFailure what={t("host.loadError")} error={status.error} retry={() => void status.refetch()} />;
  if (!status.data) return <RegionSkeleton shape="text" />;
  if (!status.data.supported) return <Message tone="info" title={t("host.unsupported", { platform: status.data.platform })} description={t("host.unsupportedHint")} />;
  return <Measured status={status.data} />;
}

type Sample = NonNullable<Measured["sample"]>;
type Gpu = Sample["gpus"][number];

function Measured({ status }: { status: Measured }) {
  const { t, i18n } = useTranslation("panels");
  const locale = i18n.language;
  const [openEpisode, setOpenEpisode] = useState<number | null>(null);
  const { facts, sample, current, limits } = status;
  const now = sample?.at ?? Date.now();
  const models = [...sample?.runs.slice(0, 3) ?? [], ...status.episodes.find(episode => episode.id === openEpisode)?.runs ?? []]
    .flatMap(run => run.model ? [run.model] : []);
  const gpus = sample?.gpus ?? [];
  return (
    <div data-host-status>
      {current
        ? <Message tone="caution" size="line" live className="mb-1" title={t("host.tight")}
          description={t("host.since", { time: formatClock(iso(current.start)), minutes: spanMinutes(current.start, now) })} />
        : !status.error && <p role="status" className="m-0 text-lg font-semibold">{t("host.calm")}</p>}
      {facts && <p className="m-0 mb-3 truncate text-xs text-muted">
        {[t("host.facts", { hostname: facts.hostname, cores: facts.cores, memory: formatGigabytes(facts.memoryBytes, locale) }),
          ...gpus.length ? [gpuModels(gpus)] : []].join(" · ")}</p>}
      {!sample ? <Message tone="waiting" size="line" live title={t("host.firstSample")} /> : <>
        <Tiles status={status} sample={sample} now={now} />
        <Heavy sample={sample} models={models} />
      </>}
      <Episodes episodes={status.episodes} now={now} limits={limits} models={models} open={openEpisode} setOpen={setOpenEpisode} />
      {status.error ? <Message tone="error" size="line" className="mt-4" title={t("host.error", { error: errorText(apiError(status.error)) })} />
        : <p className="mt-4 mb-0 text-xs text-soft">
          {sample ? t("host.updated", { time: new Date(sample.at).toLocaleTimeString(i18n.language, { hour: "numeric", minute: "2-digit", second: "2-digit", hourCycle: "h23" }) }) : ""}
        </p>}
    </div>
  );
}

/**
 * The last frame widens over what its row leaves empty, three across on a wide screen and two on a phone: 4 frames
 * end a row of three with one, 5 with two; an odd count ends a row of two with one.
 */
function lastSpan(count: number) {
  const wide = count % 3 === 1 ? "col-span-3" : count % 3 === 2 ? "col-span-2" : "";
  const narrow = count % 2 === 1 ? "narrow:col-span-2" : wide ? "narrow:col-span-1" : "";
  return cn(wide, narrow);
}

/** The numbers, one small frame each: CPU, memory, each GPU, disk and the Runs. */
function Tiles({ status, sample, now }: { status: Measured; sample: Sample; now: number }) {
  const { t, i18n } = useTranslation("panels");
  const locale = i18n.language;
  const { limits, parallel } = status;
  const tight = new Set<HostKind>(status.current?.kinds ?? []);
  const window = { from: now - HOUR, to: now };
  const gpus = sample.gpus;
  const tiles: ReactNode[] = [
    <Tile key="cpu" label={t("host.cpu")} value={formatPercent(sample.cpu, locale)} tight={tight.has("cpu")}
      chart={<Spark points={status.history.map((point) => ({ at: point.at, value: point.cpu }))} window={window}
        line={limits.cpu} tightBelow={false} step={SAMPLE} live />} />,
    <Tile key="memory" label={t("host.memory")} value={formatPercent(100 * sample.memory.availableBytes / sample.memory.totalBytes, locale)}
      side={formatGigabytes(sample.memory.availableBytes, locale)} tight={tight.has("memory")}
      chart={<Spark points={status.history.map((point) => ({ at: point.at, value: point.memoryFreePercent }))} window={window}
        line={limits.memoryFreePercent} tightBelow step={SAMPLE} live />} />,
    ...gpus.map((gpu, index) => <GpuTile key={gpu.id} gpu={gpu} label={gpus.length > 1 ? t("host.gpuNumbered", { index }) : t("host.gpu")} />),
    <Tile key="disk" label={t("host.disk")} value={formatGigabytes(sample.disk.freeBytes, locale)} side={`/ ${formatGigabytes(sample.disk.totalBytes, locale)}`}
      tight={tight.has("disk")}
      chart={<Bar share={100 * (1 - sample.disk.freeBytes / sample.disk.totalBytes)} tick={100 * (1 - limits.diskFreeBytes / sample.disk.totalBytes)}
        tight={tight.has("disk")} className="mt-2" />} />,
    <Tile key="runs" label={t("host.runs")} tight={false}
      value={<>{sample.runs.length}{parallel !== null && <span className="text-sm font-normal text-muted"> / {parallel}</span>}</>}
      chart={parallel !== null && <Bar share={100 * sample.runs.length / parallel} className="mt-2" />} />,
  ];
  const span = lastSpan(tiles.length);
  return (
    <div className="grid grid-cols-3 gap-2 narrow:grid-cols-2">
      {tiles.map((tile, index) => index === tiles.length - 1 && span ? <div key="last" className={cn("grid", span)}>{tile}</div> : tile)}
    </div>
  );
}

/** One GPU: how busy it is, its VRAM taken and free, and what holds the most of it. Parts the machine cannot read are left out. */
function GpuTile({ gpu, label }: { gpu: Gpu; label: string }) {
  const { t, i18n } = useTranslation("panels");
  const locale = i18n.language;
  const users = gpu.users?.map(user => [user.taskId, user.name, formatGigabytes(user.memoryBytes, locale)].filter(Boolean).join(" ")).join(" · ");
  return <Tile label={label} value={formatPercent(gpu.utilization, locale)} tight={false} gpu={gpu.id} note={users || undefined}
    chart={gpu.memory && <>
      <Bar share={100 * gpu.memory.usedBytes / gpu.memory.totalBytes} className="mt-2" />
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-xs whitespace-nowrap">
        <span className="text-muted">{t("host.vramFree")}</span><span className="tabular-nums">{formatVramFree(gpu.memory, locale)}</span>
      </div>
    </>} />;
}

function Tile({ label, value, side, tight, chart, note, gpu }: { label: string; value: ReactNode; side?: string; tight: boolean;
  chart?: ReactNode; note?: string; gpu?: string }) {
  return (
    <div data-host-meter data-host-gpu={gpu} className="flex min-w-0 flex-col rounded-lg border border-line px-3 pt-2 pb-2.5">
      <span className="truncate text-xs text-muted">{label}</span>
      <span className={cn("truncate text-xl font-semibold tabular-nums", tight && "text-warn")}>{value}
        {side && <span className="ml-1.5 text-sm font-normal text-muted">{side}</span>}</span>
      {chart && <div className="mt-0.5">{chart}</div>}
      {note && <span title={note} className="mt-1 truncate text-xs text-muted">{note}</span>}
    </div>
  );
}

/** A thin bar: how much of something is taken, with a tick where it turns tight. */
function Bar({ share, tick, tight = false, className }: { share: number; tick?: number; tight?: boolean; className?: string }) {
  const percent = (value: number) => `${Math.max(0, Math.min(100, value))}%`;
  return (
    <div aria-hidden className={cn("relative h-1.5 rounded-full bg-line", className)}>
      <div className={cn("h-full rounded-full", tight ? "bg-warn" : "bg-ink")} style={{ width: percent(share) }} />
      {tick !== undefined && <div className="absolute -top-0.5 -bottom-0.5 w-px bg-soft" style={{ left: percent(tick) }} />}
    </div>
  );
}

const SPARK_WIDTH = 354;
/** A line over its window with what it has taken tinted, the limit dashed, and (`live`) a dot at the newest value. */
function Spark({ points, window, line, tightBelow, step, height = 30, live = false }: { points: readonly SparkPoint[]; window: { from: number; to: number };
  line: number; tightBelow: boolean; step: number; height?: number; live?: boolean }) {
  const shape = sparkShape(points, window, line, tightBelow, SPARK_WIDTH, height, step);
  return (
    <svg aria-hidden viewBox={`0 0 ${SPARK_WIDTH} ${height}`} preserveAspectRatio="none" className="block w-full overflow-visible" style={{ height }}>
      {shape.bands.map((band, index) => <rect key={index} x={band.x} y={0} width={band.width} height={height} className="fill-strain" />)}
      {shape.areas.map((area, index) => <path key={index} d={area} className="fill-usage" />)}
      <line x1={0} x2={SPARK_WIDTH} y1={height - 0.5} y2={height - 0.5} className="stroke-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={0} x2={SPARK_WIDTH} y1={shape.lineY} y2={shape.lineY} className="stroke-soft" strokeDasharray="2 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {shape.paths.map((path, index) => <path key={index} d={path} fill="none" className="stroke-ink" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
      {live && shape.last && <line x1={shape.last.x} x2={shape.last.x} y1={shape.last.y} y2={shape.last.y} className="stroke-ink" strokeWidth={5}
        strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** A Run's name: its Task's title, or the coordinator's in the screen's language (the server sends no title for a Run without a Task). */
const runName = (run: { taskId: string | null; title: string }, coordinator: string) => run.taskId === null ? coordinator : run.title;
/** A Run's second line: who runs it and its heaviest command; a worker is named so two Runs of one Task can be told apart. */
function runDetail(run: { model: string | null; role: string }, heaviest: string, worker: string, models: readonly string[]) {
  const model = modelLabel(run.model ?? "", models);
  const text = (name: string) => [name, heaviest, run.role === "worker" ? worker : ""].filter(Boolean).join(" · ");
  return { short: text(model.short), full: text(model.full) };
}

/** One Run's row: its name, what it takes, and its second line; pressing it opens its Task. */
function RunRow({ run, cpu, memory, detail, mark }: { run: { taskId: string | null; title: string }; cpu: number | null; memory: number | null; detail: ReturnType<typeof runDetail>; mark?: string }) {
  const { t, i18n } = useTranslation("panels");
  const moveTo = useMoveToTask();
  return (
    <Button variant="ghost" data-host-run={mark} onClick={() => { if (run.taskId !== null) moveTo(run.taskId); }}
      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline justify-stretch gap-x-2.5 gap-y-0 rounded-none border-t border-line px-0 py-1.5 text-left text-base whitespace-normal">
      <span className="truncate">{run.taskId !== null && <span className="mr-1.5 text-muted tabular-nums">{run.taskId}</span>}{runName(run, t("ui:role.coordinator"))}</span>
      <span className="text-right tabular-nums">{formatPercent(cpu, i18n.language)} · {formatGigabytes(memory, i18n.language)}</span>
      <span title={detail.full} aria-label={detail.full} className="col-span-2 truncate text-xs text-muted">{detail.short}</span>
    </Button>
  );
}

/**
 * What takes the machine now, heaviest first: the three heaviest Runs and everything outside alpacawork in one order,
 * then the other Runs together. CPU and memory each keep a column, so the numbers read down the rows.
 */
function Heavy({ sample, models }: { sample: Sample; models: readonly string[] }) {
  const { t, i18n } = useTranslation("panels");
  const moveTo = useMoveToTask();
  const top = sample.runs.slice(0, 3), rest = sample.runs.slice(3);
  const sum = (key: "cpu" | "memoryBytes") => rest.some(run => run[key] === null) ? null : rest.reduce((total, run) => total + run[key]!, 0);
  const columns = "grid-cols-[minmax(0,1fr)_3.25rem_4.5rem] items-baseline gap-x-2";
  const row = cn("grid w-full border-t border-line py-1.5 text-left", columns);
  const numbers = (cpu: number | null, memory: number | null) => <>
    <span className="text-right tabular-nums">{formatPercent(cpu, i18n.language)}</span>
    <span className="text-right tabular-nums">{formatGigabytes(memory, i18n.language)}</span></>;
  const rows = [...top.map(run => ({ run, cpu: run.cpu, memory: run.memoryBytes })), { run: null, cpu: sample.outside.cpu, memory: sample.outside.memoryBytes }]
    .sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1) || (b.memory ?? -1) - (a.memory ?? -1));
  return (
    <section aria-labelledby="host-heavy">
      <h3 className={cn("mt-8 mb-2 grid text-base font-semibold", columns)}>
        <span id="host-heavy">{t("host.heavy")}</span>
        <span className="text-right text-xs font-normal text-muted">{t("host.cpu")}</span>
        <span className="text-right text-xs font-normal text-muted">{t("host.memoryColumn")}</span></h3>
      {!sample.runs.length && <Message tone="empty" size="line" icon="runningRuns" className="border-t border-line py-2" title={t("host.noRuns")} />}
      {rows.map(({ run }) => {
        if (!run) return <div key="outside" data-host-outside className={row}>
          <span>{t("host.outside")}</span>
          {numbers(sample.outside.cpu, sample.outside.memoryBytes)}
          {sample.outside.names.length > 0 &&
            <span className="col-span-3 truncate text-xs text-muted">{t("host.outsideNames", { names: sample.outside.names.join(" · ") })}</span>}
        </div>;
        const detail = runDetail(run, heaviestText(run.heaviest), t("host.worker"), models);
        return <Button key={run.runId} variant="ghost" data-host-run={run.runId} onClick={() => { if (run.taskId !== null) moveTo(run.taskId); }}
          className={cn(row, "justify-stretch gap-y-0 rounded-none px-0 text-base whitespace-normal")}>
          <span className="truncate">{run.taskId !== null && <span className="mr-1.5 text-muted tabular-nums">{run.taskId}</span>}{runName(run, t("ui:role.coordinator"))}</span>
          {numbers(run.cpu, run.memoryBytes)}
          <span title={detail.full} aria-label={detail.full} className="col-span-3 truncate text-xs text-muted">{detail.short}</span>
        </Button>;
      })}
      {rest.length > 0 && <div data-host-more className={cn(row, "text-sm text-muted")}>
        <span>{t("host.moreRuns", { count: rest.length })}</span>{numbers(sum("cpu"), sum("memoryBytes"))}</div>}
    </section>
  );
}

function Heading({ id, title, note }: { id: string; title: string; note: string }) {
  return <h3 id={id} className="mt-8 mb-2 flex items-baseline justify-between gap-2 text-base font-semibold">
    {title}<span className="text-xs font-normal text-muted">{note}</span></h3>;
}

/** "Today 13:02" / "Yesterday 22:40" / "10/12 10:15" */
function useWhen() {
  const { t, i18n } = useTranslation("panels");
  return (at: number, now: number) => {
    const offset = calendarDayOffset(at, now);
    const day = offset === 0 ? t("host.today") : offset === -1 ? t("host.yesterday") : formatCalendarDate(at, now, i18n.language);
    return `${day} ${formatClock(iso(at))}`;
  };
}

type Limits = Measured["limits"];
function Episodes({ episodes, now, limits, models, open, setOpen }: { episodes: HostEpisode[]; now: number; limits: Limits; models: readonly string[];
  open: number | null; setOpen: (id: number | null) => void }) {
  const { t } = useTranslation("panels");
  return (
    <section aria-labelledby="host-episodes">
      <Heading id="host-episodes" title={t("host.episodes")} note={t("host.episodesNote")} />
      {!episodes.length && <Message tone="empty" size="line" icon="history" className="border-t border-line py-2" title={t("host.noEpisodes")} description={t("host.noEpisodesHint")} />}
      {episodes.map((episode) => <Episode key={episode.id} episode={episode} now={now} limits={limits}
        models={models} open={open === episode.id} onToggle={() => setOpen(open === episode.id ? null : episode.id)} />)}
    </section>
  );
}

function Episode({ episode, now, limits, models, open, onToggle }: { episode: HostEpisode; now: number; limits: Limits; models: readonly string[]; open: boolean; onToggle: () => void }) {
  const { t, i18n } = useTranslation("panels");
  const when = useWhen();
  const span = episode.end === null ? t("host.ongoing", { from: when(episode.start, now) })
    : t("host.span", { from: when(episode.start, now), to: formatClock(iso(episode.end)), minutes: spanMinutes(episode.start, episode.end) });
  const reasons = episodeReasons(episode, i18n.language).map((reason) => reason.kind === "cpu" ? t("host.reasonCpu", { value: reason.value })
    : reason.kind === "memory" ? t("host.reasonMemory", { value: reason.value }) : t("host.reasonDisk", { value: reason.value })).join(" · ");
  const who = [t("host.runCount", { count: episode.runs.length }),
    ...episode.runs.slice(0, 3).map((run) => [run.taskId ?? runName(run, t("ui:role.coordinator")), run.heaviest].filter(Boolean).join(" "))].join(" · ");
  return (
    <div data-host-episode={episode.id} className={cn("border-t border-line", open && "-mx-6 bg-hover px-6 pb-3 narrow:-mx-4.5 narrow:px-4.5")}>
      <Button variant="ghost" aria-expanded={open} onClick={onToggle}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline justify-stretch gap-x-2.5 gap-y-0 rounded-none px-0 py-2 text-left text-base whitespace-normal hover:bg-transparent">
        <span className="truncate whitespace-nowrap tabular-nums">{span}</span>
        <span aria-hidden className="text-xs text-soft">{open ? "⌄" : "›"}</span>
        <span className="col-span-2 truncate text-sm text-muted">
          <span className={episode.end === null ? "text-warn" : "text-ink"}>{reasons}</span> · {who}</span>
      </Button>
      {open && <EpisodeDetail episode={episode} now={now} limits={limits} models={models} />}
    </div>
  );
}

function EpisodeDetail({ episode, now, limits, models }: { episode: HostEpisode; now: number; limits: Limits; models: readonly string[] }) {
  const { t } = useTranslation("panels");
  const root = useWorkspaceInfo((info) => info.root);
  // Id 0 is an open episode the server could not record; it has no minute values.
  const minutes = useQuery({ ...resources.hostEpisode(root, episode.id, episode.end), enabled: !!root && episode.id > 0 });
  // The line follows the first measure that was tight: CPU at its minute peaks, memory at its minute lows.
  const kind = episode.kinds[0]!;
  const points: SparkPoint[] = (minutes.data?.minutes ?? []).map((row) => ({ at: row.at,
    value: kind === "cpu" ? row.cpuMax : row.memoryFreeMin }));
  const end = episode.end ?? now;
  return (
    <div className="mt-1">
      {kind !== "disk" && minutes.data && <>
        <Spark points={points} window={{ from: minutes.data.from, to: minutes.data.to }} line={kind === "cpu" ? limits.cpu : limits.memoryFreePercent}
          tightBelow={kind === "memory"} step={60_000} height={56} />
        <div className="flex justify-between text-xs text-soft tabular-nums">
          <span>{formatClock(iso(minutes.data.from))}</span><span>{kind === "cpu" ? t("host.lineCpu") : t("host.lineMemory")}</span><span>{formatClock(iso(minutes.data.to))}</span>
        </div>
      </>}
      <Heading id={`host-episode-${episode.id}`} title={t("host.episodeRuns")} note={t("host.episodeRunsNote")} />
      {!episode.runs.length && <Message tone="empty" size="line" icon="runningRuns" className="border-t border-line py-2" title={t("host.noRuns")} />}
      {episode.runs.map((run) => {
        const whole = run.firstSeen <= episode.start + SAMPLE && run.lastSeen >= end - SAMPLE;
        const presence = whole ? t("host.whole", { minutes: spanMinutes(episode.start, end) })
          : t("host.from", { time: formatClock(iso(run.firstSeen)) });
        const detail = runDetail(run, run.heaviest ?? "", t("host.worker"), models);
        return <RunRow key={run.runId} run={run} cpu={run.cpuPeak} memory={run.memoryPeakBytes}
          detail={{ short: [detail.short, presence].join(" · "), full: [detail.full, presence].join(" · ") }} />;
      })}
    </div>
  );
}
