import { useTranslation } from "react-i18next";
import type { AnalysisDays, AnalysisUsageCounts } from "@alpacawork/contract/analysis";
import { addDays, daysBetween } from "./format";
import { TasksLook } from "./TasksLook";
import { UsageLook } from "./UsageLook";
import { useChoices } from "./parts";
import type { Bucket, Period, TasksView, UsageSeriesView, UsageView } from "./contract";
import type { LaunchAnswers } from "./Launches";
import type { Look, Span } from "./place";

/**
 * The face's place while its answers are read: the look itself, drawn from a stand-in answer with every part a usual
 * answer has (the span before, the whole record, a share, cache among the tokens), each word and mark a pale block
 * (`[data-face-skeleton]`, surfaces.css). Its numbers, rows and charts stand where the answer's will, on a computer and a
 * phone alike, so nothing moves when it comes. It is said as the app's other waits are (RegionSkeleton: a status that is
 * loading); the stand-in look inside it is out of reach and unread.
 */
export function FaceSkeleton({ look, span, bucket }: { look: Look; span: Span; bucket: Bucket }) {
  const { t } = useTranslation("ui");
  const { tasks, usage, days, series } = standIn(span, bucket);
  const none = () => {};
  return <div role="status" aria-label={t("loading")} aria-busy="true" data-skeleton="analysis" data-face-skeleton>
    <div inert>{look === "tasks" ? <TasksLook view={tasks} span={span} root={null} days={days} open={none} zone="" />
      : <UsageLook view={usage} span={span} root={null} tasks={tasks} days={days} open={none} zone="" series={series} />}</div>
  </div>;
}

const today = () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const LENGTH: Record<Period, number> = { today: 1, "7d": 7, "28d": 28, all: 0 };

/** A stand-in answer for the span: the record a little longer than two spans, every count above zero. */
function standIn(span: Span, bucket: Bucket) {
  const last = "to" in span ? span.to : today();
  const length = "from" in span ? daysBetween(span.from, span.to) : LENGTH[span.period];
  const whole = "period" in span && span.period === "all";
  const firstDay = addDays(last, -Math.max(2 * length + 6, 27));
  const days: AnalysisDays = whole ? { from: firstDay, to: last } : { from: addDays(last, 1 - length), to: last };
  const previous = whole ? null : { from: addDays(days.from, -length), to: addDays(days.from, -1) };
  const head = { timeZone: "UTC", today: last, firstDay, project: null, period: days, previous };
  const counts = { passed: 8, reworked: 2, stopped: 1, accepted: 10, finished: 11, share: 0.8 };
  const accepted = { leadMedianMs: 3_600_000, submits: 12, questions: 3, prs: 4, time: { review: 3_600_000, answer: 600_000, ai: 7_200_000, other: 1_800_000 } };
  const used: AnalysisUsageCounts = { launches: 120, runMs: 36_000_000, live: 0, newConversations: 12,
    tokens: { output: 1_000_000, input: 2_000_000, cache: 40_000_000 }, tokensUnknown: 0, tasks: 11 };
  const points: { from: string; to: string; complete: boolean }[] = [];
  for (let day = firstDay; day <= last; day = addDays(day, bucket === "day" ? 1 : bucket === "week" ? 7 : 30))
    points.push({ from: day, to: day, complete: true });
  const tasks: TasksView = { head, counts: { value: counts, previous: previous && counts }, accepted: { value: accepted, previous: previous && accepted },
    ever: whole ? null : { counts, accepted }, series: { bucket, points: points.map(point => ({ ...point, counts, accepted })) },
    grass: { from: firstDay, finished: Array.from({ length: daysBetween(addDays(firstDay, -6), last) }, () => 1) }, breakdown: null };
  const usage: UsageView = { head, counts: { value: used, previous: previous && used }, ever: whole ? null : used,
    series: { bucket, points: points.map(point => ({ ...point, counts: used })) }, breakdown: null };
  // The launches by three models, as the usual answer stacks them (whatever the chart is coloured by: the stand-in's
  // groups are named alike either way, and their names are blocks).
  const groups = ["a", "b", "c"].map((key, at) => ({ key, label: key, value: key, total: 60 - at * 20 }));
  const seriesOf = (by: "model" | "effort"): UsageSeriesView => ({ head, filters: { model: null, effort: null, effortMissing: false },
    metric: { id: "launches", unit: "runs", aggregation: "sum" }, bucket, by, total: 120, groups,
    points: points.map(point => ({ ...point, total: 120, counts: [[0, 60], [1, 40], [2, 20]] as [number, number][] })) });
  const by = useChoices.getState().launchBy, series: LaunchAnswers = [seriesOf(by), seriesOf(by), seriesOf(by)];
  return { tasks, usage, days, series };
}
