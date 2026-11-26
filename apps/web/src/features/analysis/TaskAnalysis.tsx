import { useTranslation } from "react-i18next";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { useViewStore } from "@/state/view-store";
import { cn } from "@/lib/utils";
import { useFindings, useTrace, useUnitValues } from "./data";
import { duration, format, instant } from "./format";
import { ReadPart, Square, tip, useReadSet } from "./parts";
import { Timeline } from "./Timeline";
import { Waits } from "./Waits";
import type { Finding, FindingsView, TraceMark, TraceView, UnitValues } from "./contract";

/**
 * A task's Analysis tab: why it cost what it did, from the three axes down to the scene. Its three axes in one line (the
 * time it took, its tokens, the reviews until accepted) with where the user was while it waited; each review round's
 * time and tokens; the causes (the places worth a look, the user's fixes by kind); then the timeline, entered from a
 * cause. Every number is an analysis answer (`analysis task`, `trace`, `findings`, `at`), the ones an AI reads.
 */
export function TaskAnalysisPane({ task }: { task: string }) {
  const values = useUnitValues(task), findings = useFindings(task), trace = useTrace(task, null, false);
  const set = useReadSet(`task-analysis:${task}`, [values, findings, trace]);
  return <div data-task-analysis className="pb-10">
    <ReadPart set={set} skeleton={<RegionSkeleton shape="analysisTask" />}>{([unit, found, overview]) =>
      <Body task={task} values={unit as UnitValues} findings={found as FindingsView} trace={overview as TraceView} />}
    </ReadPart>
  </div>;
}

function Body({ task, values, findings, trace }: { task: string; values: UnitValues; findings: FindingsView; trace: TraceView }) {
  const { t } = useTranslation("analysis");
  const zone = trace.head.timeZone;
  const choose = (finding: Finding) => {
    useViewStore.getState().setScene({ finding: finding.id, at: finding.at });
    document.querySelector("[data-timeline]")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return <>
    <Axes values={values} task={task} />
    <Rounds values={values} />
    <section className="mt-8">
      <h3 className="mb-1 text-heading font-semibold">{t("task.causes")}</h3>
      <p className="mb-3 text-xs text-soft">{t("task.causesNote")}</p>
      <Findings findings={findings.findings} zone={zone} onChoose={choose} />
      <Fixes marks={trace.marks} zone={zone} />
    </section>
    <Timeline task={task} trace={trace} findings={findings.findings} />
  </>;
}

/** The three axes in one line, each its name over its value, and under them where the user was while it waited. */
function Axes({ values, task }: { values: UnitValues; task: string }) {
  const { t } = useTranslation("analysis");
  const row = values.unit, lead = row.finishedAt ? Date.parse(row.finishedAt) - Date.parse(row.requestedAt) : null;
  const tokens = values.usage.tokens.output + values.usage.tokens.input + values.usage.tokens.cache;
  const you = values.time.review + values.time.answer, waits = values.waits;
  const times = format("times", values.submits);
  const reviews = row.outcome === "stopped" ? t("task.stopped", { times }) : row.outcome ? t("task.accepted", { times }) : t("task.open", { times });
  return <section>
    {values.unit.id !== task && <p className="mb-2 text-xs text-soft">{t("task.ofRequest", { id: values.unit.id })}</p>}
    <dl className="grid grid-cols-3 gap-x-4 gap-y-3 narrow:grid-cols-2">
      <Axis name={t("task.time")} value={duration(lead ?? values.time.review + values.time.answer + values.time.ai + values.time.other)} />
      <Axis name={t("task.tokens")} value={format("tokens", tokens)} />
      <Axis name={t("task.reviews")} value={reviews} />
    </dl>
    {you > 0 && <div className="mt-3 text-xs text-muted">
      <span className="inline-flex items-center"><Square className="bg-turn" />{t("time.you")} <b className="ms-1 font-semibold text-ink">{duration(you)}</b></span>
      <Waits waits={waits} total={you} className="mt-1" />
    </div>}
  </section>;
}
const Axis = ({ name, value }: { name: string; value: string }) =>
  <div className="min-w-0"><dt className="text-xs text-muted">{name}</dt><dd className="text-[1.375rem] leading-tight font-semibold tabular-nums">{value}</dd></div>;

/** Each review round's time and tokens as two rows of small bars, so the round that cost the most stands out. */
function Rounds({ values }: { values: UnitValues }) {
  const { t } = useTranslation("analysis");
  const rounds = values.rounds;
  if (rounds.length < 2) return null;
  const most = { ms: Math.max(...rounds.map(r => r.ms), 1), tokens: Math.max(...rounds.map(r => r.tokens), 1) };
  const bars = (key: "ms" | "tokens", color: string, write: (value: number) => string) =>
    <div className="flex h-16 items-end gap-1">{rounds.map((round, at) =>
      <div key={at} className="flex h-full min-w-0 flex-1 flex-col justify-end" data-tip-tap=""
        {...tip(`${t("task.round", { n: at + 1 })}${t("sep")}${write(round[key])}${t("sep")}${t("range", { from: instant(round.from, values.head.timeZone), to: instant(round.to, values.head.timeZone) })}`)}>
        <span className="mb-0.5 truncate text-center text-[0.6875rem] text-soft tabular-nums">{write(round[key])}</span>
        <i style={{ height: `${Math.max(2, round[key] / most[key] * 100)}%` }} className={cn("block max-h-[calc(100%-1rem)] rounded-t-xs", color)} />
      </div>)}</div>;
  return <section className="mt-8">
    <h3 className="mb-3 text-heading font-semibold">{t("task.rounds")}</h3>
    <p className="mb-1 text-xs text-muted">{t("task.time")}</p>
    {bars("ms", "bg-turn", duration)}
    <p className="mt-3 mb-1 text-xs text-muted">{t("task.tokens")}</p>
    {bars("tokens", "bg-working", value => format("tokens", value))}
    <div className="mt-1 flex gap-1">{rounds.map((_, at) => <span key={at} className="flex-1 text-center text-[0.6875rem] text-soft">{at + 1}</span>)}</div>
    <p className="mt-2 text-xs text-soft">{t("task.roundsNote")}</p>
  </section>;
}

/** The places worth a look, the longest first: each its rule, its size and what it stands on; pressing one opens its scene. */
function Findings({ findings, zone, onChoose }: { findings: Finding[]; zone: string; onChoose: (finding: Finding) => void }) {
  const { t } = useTranslation("analysis");
  const chosen = useViewStore(state => state.scene?.finding ?? null);
  if (!findings.length) return <p className="text-soft">{t("task.noFindings")}</p>;
  return <ol className="divide-y divide-rule border-y border-rule">{findings.map((finding, at) =>
    <li key={finding.id}><button type="button" data-finding={finding.id} aria-current={chosen === finding.id || undefined} onClick={() => onChoose(finding)}
      className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 rounded-sm py-2 text-start hover:bg-hover aria-[current]:bg-hover">
      <span className="text-xs text-soft tabular-nums">{at + 1}</span>
      <span className="min-w-0">
        <span className="font-semibold">{t(`rule.${finding.rule}`)}</span>
        <span className="ms-2 text-xs text-soft">{instant(finding.at, zone)}</span>
        <span className="block truncate text-xs text-muted">{evidenceWords(finding, t)}</span>
      </span>
      <span className="text-end font-semibold whitespace-nowrap tabular-nums">
        {finding.count !== null && <span className="me-2 font-normal text-muted">{format("times", finding.count)}</span>}{duration(finding.durationMs)}</span>
    </button></li>)}</ol>;
}
/** What a finding stands on, as words: an instruction's first line, else the records it names. */
function evidenceWords(finding: Finding, t: (key: string, options?: Record<string, unknown>) => string) {
  const line = finding.evidence.find(each => "log" in each && each.firstLine) as { firstLine: string } | undefined;
  if (line) return `「${line.firstLine}」`;
  return finding.evidence.map(each => "run" in each ? each.step !== undefined ? `${each.run}.s${each.step}` : each.run
    : "question" in each ? t("task.question", { task: each.task }) : each.task).join(t("sep"));
}

/** The user's fixes to the task and those under it, by the kinds of fix their senders named, most first. */
function Fixes({ marks, zone }: { marks: TraceMark[]; zone: string }) {
  const { t } = useTranslation("analysis");
  const fixes = marks.filter((mark): mark is Extract<TraceMark, { kind: "instruction" }> => mark.kind === "instruction" && mark.label?.kind === "fix");
  if (!fixes.length) return null;
  const kinds = new Map<string, typeof fixes>();
  for (const mark of fixes) for (const kind of mark.label!.fixes) kinds.set(kind, [...kinds.get(kind) ?? [], mark]);
  const order = [...kinds].sort((a, b) => b[1].length - a[1].length);
  return <div className="mt-6">
    <h4 className="mb-2 text-xs font-normal text-soft">{t("task.fixes", { count: fixes.length })}</h4>
    {order.map(([kind, items]) => <div key={kind} className="mb-3">
      <p className="flex items-center font-semibold"><Square className="bg-reworked" />{t(`fix.${kind}`)}<span className="ms-1.5 font-normal text-muted">×{items.length}</span></p>
      <ul className="mt-1 divide-y divide-rule border-t border-rule ps-4">{items.map(mark =>
        <li key={mark.id} className="flex items-baseline gap-3 py-1.5 text-base">
          <span dir="auto" className="min-w-0 flex-1 truncate">{mark.firstLine ? `「${mark.firstLine}」` : t("task.noWords")}</span>
          <button type="button" className="text-xs whitespace-nowrap text-soft underline-offset-4 hover:text-ink hover:underline"
            onClick={() => useViewStore.getState().setScene({ finding: null, at: mark.at })}>{instant(mark.at, zone)}</button>
        </li>)}</ul>
    </div>)}
  </div>;
}
