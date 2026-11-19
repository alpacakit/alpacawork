import { apiError, errorText } from "@/data/client";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { heaviestText, type HostEpisode, type HostKind, type HostStatus } from "@alpacawork/contract";
import { Button } from "@/components/ui/button";
import { FieldHint } from "@/components/ui/field";
import { useWorkspaceInfo } from "@/data/queries";
import { resources } from "@/data/resources";
import { episodeReasons, formatGigabytes, formatPercent, spanMinutes, sparkShape, type SparkPoint } from "@/domain/host";
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

function Measured({ status }: { status: Measured }) {
  const { t, i18n } = useTranslation("panels");
  const locale = i18n.language;
  const [openEpisode, setOpenEpisode] = useState<number | null>(null);
  const { facts, sample, current, limits } = status;
  const load = sample?.load?.[0];
  const loadText = load === undefined ? "—"
    : new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(load);
  const diskLimit = new Intl.NumberFormat(locale, { style: "unit", unit: "gigabyte", maximumFractionDigits: 0 })
    .format(limits.diskFreeBytes / 1024 ** 3);
  const tight = new Set<HostKind>(current?.kinds ?? []);
  const now = sample?.at ?? Date.now();
  const models = [...sample?.runs.slice(0, 3) ?? [], ...status.episodes.find(episode => episode.id === openEpisode)?.runs ?? []]
    .flatMap(run => run.model ? [run.model] : []);
  return (
    <div data-host-status>
      {facts && <FieldHint>{t("host.facts", { hostname: facts.hostname, os: facts.os, cores: facts.cores, memory: formatGigabytes(facts.memoryBytes, locale) })}</FieldHint>}
      {current
        ? <Message tone="caution" size="line" live className="mt-type-close mb-3" title={t("host.tight")}
          description={t("host.since", { time: formatClock(iso(current.start)), minutes: spanMinutes(current.start, now) })} />
        : !status.error && <p role="status" className="mt-type-close mb-3 text-md font-semibold">{t("host.calm")}</p>}
      {!sample ? <Message tone="waiting" size="line" live title={t("host.firstSample")} /> : <>
        <Meter label={t("host.cpu")} value={formatPercent(sample.cpu, locale)} tight={tight.has("cpu")}
          line={<Spark points={status.history.map((point) => ({ at: point.at, value: point.cpu }))} window={{ from: now - HOUR, to: now }}
            line={limits.cpu} tightBelow={false} step={SAMPLE} />}
          note={t("host.cpuNote", { load: loadText, cores: facts?.cores ?? "—" })} limit={t("host.limitPercent", { value: limits.cpu })} />
        <Meter label={t("host.memory")} value={formatPercent(100 * sample.memory.availableBytes / sample.memory.totalBytes, locale)} tight={tight.has("memory")}
          line={<Spark points={status.history.map((point) => ({ at: point.at, value: point.memoryFreePercent }))} window={{ from: now - HOUR, to: now }}
            line={limits.memoryFreePercent} tightBelow step={SAMPLE} />}
          note={t("host.memoryNote", { swap: formatGigabytes(sample.memory.swapUsedBytes, locale), free: formatGigabytes(sample.memory.availableBytes, locale) })}
          limit={t("host.limitPercent", { value: limits.memoryFreePercent })} />
        <Meter label={t("host.disk")} value={formatGigabytes(sample.disk.freeBytes, locale)} tight={tight.has("disk")}
          note={t("host.diskNote", { total: formatGigabytes(sample.disk.totalBytes, locale) })} limit={t("host.limitBytes", { value: diskLimit })} />
        <Meter label={t("host.runs")} value={<>{sample.runs.length}{status.parallel !== null &&
          <span className="text-sm font-normal text-muted"> / {status.parallel}</span>}</>} tight={false} />
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

function Meter({ label, value, tight, line, note, limit }: { label: string; value: ReactNode; tight: boolean; line?: ReactNode; note?: string; limit?: string }) {
  return (
    <div data-host-meter className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 border-t border-line py-2">
      <span>{label}</span>
      <span className={cn("text-md font-medium tabular-nums", tight && "text-warn")}>{value}</span>
      {line && <div className="col-span-2 mt-1">{line}</div>}
      {(note || limit) && <div className="col-span-2 flex flex-wrap gap-x-2 text-xs text-muted">
        <span className="whitespace-nowrap">{note}</span><span className="ml-auto whitespace-nowrap">{limit}</span>
      </div>}
    </div>
  );
}

const SPARK_WIDTH = 354;
function Spark({ points, window, line, tightBelow, step, height = 28 }: { points: readonly SparkPoint[]; window: { from: number; to: number };
  line: number; tightBelow: boolean; step: number; height?: number }) {
  const shape = sparkShape(points, window, line, tightBelow, SPARK_WIDTH, height, step);
  return (
    <svg aria-hidden viewBox={`0 0 ${SPARK_WIDTH} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      {shape.bands.map((band, index) => <rect key={index} x={band.x} y={0} width={band.width} height={height} className="fill-strain" />)}
      <line x1={0} x2={SPARK_WIDTH} y1={shape.lineY} y2={shape.lineY} className="stroke-soft" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {shape.paths.map((path, index) => <path key={index} d={path} fill="none" className="stroke-ink" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
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

function Heavy({ sample, models }: { sample: NonNullable<Measured["sample"]>; models: readonly string[] }) {
  const { t, i18n } = useTranslation("panels");
  const top = sample.runs.slice(0, 3), rest = sample.runs.slice(3);
  const sum = (key: "cpu" | "memoryBytes") => rest.some(run => run[key] === null) ? null : rest.reduce((total, run) => total + run[key]!, 0);
  return (
    <section aria-labelledby="host-heavy">
      <Heading id="host-heavy" title={t("host.heavy")} note={t("host.heavyNote")} />
      {!sample.runs.length && <Message tone="empty" size="line" icon="runningRuns" className="border-t border-line py-2" title={t("host.noRuns")} />}
      {top.map((run) => <RunRow key={run.runId} run={run} mark={run.runId} cpu={run.cpu} memory={run.memoryBytes}
        detail={runDetail(run, heaviestText(run.heaviest), t("host.worker"), models)} />)}
      <div data-host-outside className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2.5 border-t border-line py-1.5">
        <span className="text-muted">{t("host.outside")}</span>
        <span className="text-right tabular-nums">{formatPercent(sample.outside.cpu, i18n.language)} · {formatGigabytes(sample.outside.memoryBytes, i18n.language)}</span>
        {sample.outside.names.length > 0 &&
          <span className="col-span-2 truncate text-xs text-muted">{t("host.outsideNames", { names: sample.outside.names.join(" · ") })}</span>}
      </div>
      {rest.length > 0 && <p className="m-0 border-t border-line py-2 text-sm text-muted">
        {t("host.moreRuns", { count: rest.length, cpu: formatPercent(sum("cpu"), i18n.language), memory: formatGigabytes(sum("memoryBytes"), i18n.language) })}</p>}
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
        <span className="tabular-nums">{span}<span aria-hidden className="ml-1 text-xs text-soft">{open ? "⌄" : "›"}</span></span>
        <span className="text-right text-sm text-warn">{reasons}</span>
        <span className="col-span-2 truncate text-xs text-muted">{who}</span>
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
