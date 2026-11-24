import { useTranslation } from "react-i18next";
import { daysBetween, format, type Kind } from "./format";
import { BarPanel } from "./charts";
import { BreakdownTable } from "./BreakdownTable";
import { cell } from "./TasksLook";
import { Num, RulesBox, RulesToggle, Section, Seg, useChoices, type UsageGroup, type UsageMetric } from "./parts";
import type { UsageCounts, UsageView } from "./contract";
import type { ListPlace } from "./place";

type Days = { from: string; to: string };
type Open = (list: Omit<ListPlace, "group" | "member"> & Partial<Pick<ListPlace, "group" | "member">>) => void;

/** Each value of the AI's use: how it is read from the counts, and how it is written. */
const METRICS: Record<UsageMetric, { read: (counts: UsageCounts) => number; kind: Kind }> = {
  launches: { read: c => c.launches, kind: "times" },
  runMs: { read: c => c.runMs, kind: "hours" },
  newConversations: { read: c => c.newConversations, kind: "plain" },
  output: { read: c => c.tokens.output, kind: "tokens" },
  input: { read: c => c.tokens.input, kind: "tokens" },
  cache: { read: c => c.tokens.cache, kind: "tokens" },
};
const RUNS: UsageMetric[] = ["launches", "runMs", "newConversations"], TOKENS: UsageMetric[] = ["output", "input", "cache"];
/** The scale of the use chart: its values in the unit its largest bar is written in. */
function chartUnit(kind: Kind, largest: number, say: (key: string, options?: Record<string, unknown>) => string): [number, string] {
  if (kind === "hours") return [3_600_000, say("unit.hours")];
  if (kind === "tokens") {
    const scales = say("unit.scales", { returnObjects: true }) as unknown as { at: number; unit: string }[];
    const scale = Array.isArray(scales) ? scales.find(each => largest >= each.at) ?? scales[scales.length - 1] : undefined;
    return scale ? [scale.at, scale.unit] : [1, ""];
  }
  return [1, kind === "times" ? say("unit.times", { count: 2 }) : ""];
}

/**
 * What the AI spent in the span, the tasks still at work included: its launches, how long it ran and the conversations
 * it began, then its tokens; the chart draws one of them over the record; then the same broken down.
 */
export function UsageLook({ view, days, open, pick, zone }: { view: UsageView; days: Days; open: Open; pick: (days: Days) => void; zone: string }) {
  const { t } = useTranslation("analysis");
  const { bucket, usageGroup, metric, grow, rules } = useChoices();
  const choose = useChoices(state => state.choose);
  const length = daysBetween(days.from, days.to);
  const now = view.counts.value, before = view.counts.previous;
  const num = (key: UsageMetric) => <Num key={key} label={t(`usage.${key}`)} kind={METRICS[key].kind} value={METRICS[key].read(now)}
    previous={before ? METRICS[key].read(before) : null} length={length} onOpen={() => open({ set: "used", value: key })} />;

  const bins = view.series.points;
  const chosen = METRICS[metric];
  const largest = Math.max(0, ...bins.map(point => chosen.read(point.counts)));
  const [unit, unitName] = chartUnit(chosen.kind, largest, t);

  const group = usageGroup, rows = view.breakdown?.rows ?? [];
  const member = (key: string) => ({ group, member: key });
  const counted = group === "skill" || group === "tool" || group === "mcp";
  const columns = group === "skill" ? [t("usage.launches"), t("usage.tasks")]
    : counted ? [t("usage.calls"), t("usage.launches"), t("usage.tasks")]
      : [t("usage.launches"), t("usage.runMs"), t("usage.newConversations"), t("usage.output"), t("usage.input"), t("usage.cache"), t("usage.tasks")];
  const table = rows.map(row => {
    const c = row.counts, tasks = cell("plain", c.tasks, () => open({ set: "used", value: "launches", ...member(row.key) }));
    const launches = cell("times", c.launches, () => open({ set: "used", value: "launches", ...member(row.key) }));
    const cells = group === "skill" ? [launches, tasks]
      : counted ? [cell("times", row.calls ?? 0, () => open({ set: "used", value: "calls", ...member(row.key) })), launches, tasks]
        : [...[...RUNS, ...TOKENS].map(key => cell(METRICS[key].kind, METRICS[key].read(c), () => open({ set: "used", value: key, ...member(row.key) }))), tasks];
    return { key: row.key, name: row.label, bar: counted && group !== "skill" ? row.calls ?? 0 : c.launches, cells };
  });
  const tallied = view.breakdown?.tallied;

  return <>
    <div className="flex flex-wrap gap-x-10 gap-y-5 narrow:block">
      <div>
        <div className="flex h-5 items-center text-xs text-soft">{t("usage.includesWorking")}<RulesToggle /></div>
        <div className="flex flex-wrap gap-x-6 gap-y-5 narrow:grid narrow:grid-cols-2 narrow:gap-x-3 narrow:gap-y-4">{RUNS.map(num)}</div>
      </div>
      <div className="narrow:mt-4">
        <div className="flex h-5 items-center text-xs text-soft">{t("usage.tokens")}</div>
        <div className="flex flex-wrap gap-x-6 gap-y-5 narrow:grid narrow:grid-cols-2 narrow:gap-x-3 narrow:gap-y-4">{TOKENS.map(num)}</div>
      </div>
    </div>
    {rules && <RulesBox>
      <p><b>{t("def.launchName")}</b>{t("colon")}{t("def.launchText")}</p>
      <p><b>{t("def.runName")}</b>{t("colon")}{t("def.runText")}</p>
      <p><b>{t("def.inputName")}</b>{t("colon")}{t("def.inputText")}</p>
      <p><b>{t("def.conversationName")}</b>{t("colon")}{t("def.conversationText")}</p>
      <p><b>{t("def.skillName")}</b>{t("colon")}{t("def.skillText")}<span className="ms-4" /><b>{t("def.toolName")}</b>{t("colon")}{t("def.toolText")}</p>
      {now.tokensUnknown > 0 && <p>{t("def.tokensUnknown", { count: now.tokensUnknown })}</p>}
      <p><b>{t("def.dayName")}</b>{t("colon")}{zone}</p>
    </RulesBox>}
    <div key={grow} className="mt-6">
      <div className="mb-2 flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1">
        <Seg className="me-auto" label={t("chart.value")} value={metric} onChange={next => choose({ metric: next, grow: grow + 1 })}
          items={[...RUNS, ...TOKENS].map(key => [key, t(`usage.${key}`)] as const)} />
        <Seg label={t("bucket.label")} value={bucket} onChange={next => choose({ bucket: next, grow: grow + 1 })}
          items={[["day", t("bucket.day")], ["week", t("bucket.week")], ["month", t("bucket.month")]]} />
      </div>
      <BarPanel bins={bins} bucket={bucket} span={days} today={view.head.today} onPick={pick} grow unit={unit} unitName={unitName}
        wholeOnly={unit === 1} values={at => [["bg-muted", chosen.read(bins[at]!.counts)]]}
        tipOf={at => `${t(`usage.${metric}`)} ${format(chosen.kind, chosen.read(bins[at]!.counts))}`} />
    </div>
    <Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={group} onChange={next => choose({ usageGroup: next as UsageGroup, all: false })}
      items={(["model", "agent", "skill", "tool", "mcp"] as const).map(key => [key, t(`usage.by.${key}`)] as const)} />}>
      <BreakdownTable id={`usage-${group}`} head={t(`usage.heads.${group}`)} columns={columns} rows={table} />
      {counted && tallied && tallied.runs < tallied.of && <p className="mt-2 text-xs text-soft">{t("breakdown.tallied", tallied)}</p>}
    </Section>
  </>;
}
