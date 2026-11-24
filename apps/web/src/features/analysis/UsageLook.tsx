import { useTranslation } from "react-i18next";
import { daysBetween, format, type Kind } from "./format";
import { BreakdownTable } from "./BreakdownTable";
import { BucketSwitch, cell, type Open } from "./TasksLook";
import { BarChart, ChartGroup, DayAxis, Lead, Leads, Parts, Row, RowName, useScale } from "./rows";
import { Compare, Num, RulesBox, RulesToggle, Section, Seg, Value, useChoices, type UsageGroup } from "./parts";
import type { TasksView, UsageCounts, UsageView } from "./contract";

type Days = { from: string; to: string };
const HOUR = 3_600_000;

/** The token total a lead number says: output, input and the cache's reads and writes together. */
const tokens = (counts: UsageCounts) => counts.tokens.output + counts.tokens.input + counts.tokens.cache;
/** Each value of the AI's use: how it is read from the counts, how it is written, and its list. */
const VALUES = {
  output: { read: (c: UsageCounts) => c.tokens.output, kind: "tokens" },
  input: { read: (c: UsageCounts) => c.tokens.input, kind: "tokens" },
  cache: { read: (c: UsageCounts) => c.tokens.cache, kind: "tokens" },
  runMs: { read: (c: UsageCounts) => c.runMs, kind: "hours" },
  launches: { read: (c: UsageCounts) => c.launches, kind: "times" },
  newConversations: { read: (c: UsageCounts) => c.newConversations, kind: "plain" },
} as const satisfies Record<string, { read: (c: UsageCounts) => number; kind: Kind }>;
type ValueKey = keyof typeof VALUES;

/**
 * What the AI spent in the span, the tasks still at work included. Four numbers lead (tokens, run time, launches, and
 * the finished tasks they went to), each against the span before and the whole record. Then the finished tasks and every
 * value as a row on the same days, then the same broken down. Skills, tools and MCP are counted from the day counting
 * began: the days before it lie hatched.
 */
export function UsageLook({ view, tasks, days, open, pick, zone }: {
  view: UsageView; tasks: TasksView | null; days: Days; open: Open; pick: (days: Days) => void; zone: string;
}) {
  const { t } = useTranslation("analysis");
  const { bucket, usageGroup, grow, rules } = useChoices();
  const choose = useChoices(state => state.choose);
  const length = daysBetween(days.from, days.to);
  const now = view.counts.value, before = view.counts.previous;
  const whole = view.head.firstDay === days.from && view.head.today === days.to;
  const ever = whole ? null : view.ever, taskEver = whole ? null : tasks?.ever ?? null;
  const finished = tasks?.counts.value ?? null;

  const leads = <Leads>
    <Lead name={<>{t("usage.tokens")}<RulesToggle /></>} value={<Value big kind="tokens" value={tokens(now)} onOpen={() => open({ set: "used", value: "tokens" })} />}
      compare={<Compare kind="tokens" value={tokens(now)} previous={before ? tokens(before) : null} length={length} />}
      ever={ever && format("tokens", tokens(ever))} />
    <Lead name={t("usage.runMs")} value={<Value big kind="hours" value={now.runMs} onOpen={() => open({ set: "used", value: "runMs" })} />}
      compare={<Compare kind="hours" value={now.runMs} previous={before?.runMs ?? null} length={length} />}
      ever={ever && format("hours", ever.runMs)} />
    <Lead name={t("usage.launches")} value={<Value big kind="times" value={now.launches} onOpen={() => open({ set: "used", value: "launches" })} />}
      compare={<Compare kind="times" value={now.launches} previous={before?.launches ?? null} length={length} />}
      ever={ever && format("times", ever.launches)} />
    {finished && <Lead name={t("tasks.finished")} value={<Value big kind="tasks" value={finished.finished} onOpen={() => open({ set: "finished", value: null })} />}
      compare={<Compare kind="tasks" value={finished.finished} previous={tasks?.counts.previous?.finished ?? null} length={length} />}
      ever={taskEver && format("tasks", taskEver.counts.finished)} />}
  </Leads>;

  const points = view.series.points, today = view.head.today;
  const taskPoints = tasks?.series.points.length === points.length ? tasks.series.points : null;
  const largest = (key: ValueKey) => Math.max(0, ...points.map(p => VALUES[key].read(p.counts)));
  const scaleOf = (key: ValueKey) => {
    const kind = VALUES[key].kind, top = largest(key);
    const steps = t("unit.scales", { returnObjects: true }) as unknown as { at: number; unit: string }[];
    const step = kind === "tokens" && Array.isArray(steps) ? steps.find(each => top >= each.at) ?? null : null;
    return kind === "hours" ? [HOUR, t("unit.hours"), false] as const
      : step ? [step.at, step.unit, false] as const
        : [1, kind === "times" ? t("unit.times", { count: 2 }) : "", true] as const;
  };
  const scale = (key: ValueKey) => { const [unit, name, wholeOnly] = scaleOf(key); return [largest(key), unit, name, wholeOnly] as const; };
  const scales = {
    finished: useScale(Math.max(0, ...(taskPoints ?? []).map(p => p.counts.finished)), 1, t("unit.tasks", { count: 2 }), true),
    output: useScale(...scale("output")), input: useScale(...scale("input")), cache: useScale(...scale("cache")),
    runMs: useScale(...scale("runMs")), launches: useScale(...scale("launches")), newConversations: useScale(...scale("newConversations")),
  };
  const names: Record<ValueKey, string> = { output: t("usage.outputTokens"), input: t("usage.inputTokens"), cache: t("usage.cache"),
    runMs: t("usage.runMs"), launches: t("usage.launches"), newConversations: t("usage.newConversations") };
  const order: ValueKey[] = ["output", "input", "cache", "runMs", "launches", "newConversations"];
  const lines = [
    ...taskPoints ? [{ name: t("tasks.finished"), value: (i: number) => format("tasks", taskPoints[i]!.counts.finished) }] : [],
    ...order.map(key => ({ name: names[key], value: (i: number) => format(VALUES[key].kind, VALUES[key].read(points[i]!.counts)) })),
  ];
  const first = taskPoints ? 1 : 0;
  const part = (kind: Kind, value: number, list: Parameters<Open>[0]) => <Value small kind={kind} value={value} onOpen={() => open(list)} />;
  const rows = <ChartGroup bins={points} span={days} today={today} bucket={bucket} pick={pick} lines={lines}>
    <div key={grow}>
      {taskPoints && finished && <Row left={<>
        <RowName>{t("tasks.finished")}</RowName>
        <Parts items={[
          { color: "bg-done", name: t("outcome.passed"), value: part("tasks", finished.passed, { set: "passed", value: "lead" }) },
          { color: "bg-reworked", name: t("outcome.reworked"), value: part("tasks", finished.reworked, { set: "reworked", value: "lead" }) },
          { color: "bg-stopped", name: t("outcome.stopped"), value: part("tasks", finished.stopped, { set: "stopped", value: null }) }]} />
      </>}>
        <BarChart row={0} height="h-22 narrow:h-18" scale={scales.finished} grow
          values={i => [["bg-done", taskPoints[i]!.counts.passed], ["bg-reworked", taskPoints[i]!.counts.reworked], ["bg-stopped", taskPoints[i]!.counts.stopped]]} />
        <DayAxis />
      </Row>}
      {/* Every row says its own value for the span, those the lead numbers say too: a row is read the same way everywhere. */}
      {order.map((key, at) => <Row key={key} left={<Num className="" label={names[key]} kind={VALUES[key].kind} value={VALUES[key].read(now)} previous={before ? VALUES[key].read(before) : null} length={length}
          onOpen={() => open({ set: "used", value: key })} />}>
        <BarChart row={first + at} height={key === "newConversations" ? "h-14 narrow:h-11" : "h-16 narrow:h-12"} scale={scales[key]} grow
          values={i => [["bg-muted", VALUES[key].read(points[i]!.counts)]]} />
        {at === order.length - 1 && <DayAxis />}
      </Row>)}
    </div>
  </ChartGroup>;

  return <>
    {leads}
    {rules && <RulesBox>
      <p><b>{t("def.tokensName")}</b>{t("colon")}{t("def.tokensText")}</p>
      <p><b>{t("def.launchName")}</b>{t("colon")}{t("def.launchText")}</p>
      <p><b>{t("def.runName")}</b>{t("colon")}{t("def.runText")}</p>
      <p><b>{t("def.inputName")}</b>{t("colon")}{t("def.inputText")}</p>
      <p><b>{t("def.conversationName")}</b>{t("colon")}{t("def.conversationText")}</p>
      <p><b>{t("def.skillName")}</b>{t("colon")}{t("def.skillText")}<span className="ms-4" /><b>{t("def.toolName")}</b>{t("colon")}{t("def.toolText")}</p>
      <p><b>{t("def.finishedName")}</b>{t("colon")}{t("def.finishedText")}<span className="ms-4" /><b>{t("def.everName")}</b>{t("colon")}{t("def.everText")}</p>
      {now.tokensUnknown > 0 && <p>{t("def.tokensUnknown", { count: now.tokensUnknown })}</p>}
      <p><b>{t("def.dayName")}</b>{t("colon")}{zone}</p>
    </RulesBox>}
    <BucketSwitch />
    {rows}
    <Breakdown view={view} group={usageGroup} days={days} open={open} pick={pick} choose={next => choose({ usageGroup: next, all: false })} />
  </>;
}

/**
 * The AI's use broken down. Skills, tools and MCP are counted from the day counting began (`since`): their chart stands
 * over the table, the days before that day hatched and that day named in ink on the axis; a span wholly before it has no
 * record, and no table.
 */
function Breakdown({ view, group, days, open, pick, choose }: {
  view: UsageView; group: UsageGroup; days: Days; open: Open; pick: (days: Days) => void; choose: (next: UsageGroup) => void;
}) {
  const { t } = useTranslation("analysis");
  const { bucket } = useChoices();
  const breakdown = view.breakdown, rows = breakdown?.rows ?? [];
  const by = (breakdown?.by as UsageGroup | undefined) ?? group;
  const member = (key: string) => ({ group: by, member: key });
  const counted = by === "skill" || by === "tool" || by === "mcp";
  const since = breakdown?.since ?? null;
  const before = counted && (since === null || days.to < since);
  const columns = by === "skill" ? [t("usage.launches"), t("usage.tasks")]
    : counted ? [t("usage.calls"), t("usage.launches"), t("usage.tasks")]
      : [t("usage.launches"), t("usage.runMs"), t("usage.newConversations"), t("usage.output"), t("usage.input"), t("usage.cache"), t("usage.tasks")];
  const table = rows.map(row => {
    const c = row.counts, tasks = cell("plain", c.tasks, () => open({ set: "used", value: "launches", ...member(row.key) }));
    const launches = cell("times", c.launches, () => open({ set: "used", value: "launches", ...member(row.key) }));
    const cells = by === "skill" ? [launches, tasks]
      : counted ? [cell("times", row.calls ?? 0, () => open({ set: "used", value: "calls", ...member(row.key) })), launches, tasks]
        : [...(["launches", "runMs", "newConversations", "output", "input", "cache"] as const).map(key =>
          cell(VALUES[key].kind, VALUES[key].read(c), () => open({ set: "used", value: key, ...member(row.key) }))), tasks];
    return { key: row.key, name: row.label, bar: counted && by !== "skill" ? row.calls ?? 0 : c.launches, cells };
  });
  const name = by === "skill" ? t("usage.skillLaunches") : t("usage.calls");
  const read = (value: { calls: number; launches: number }) => by === "skill" ? value.launches : value.calls;
  const series = breakdown?.series ?? null, points = view.series.points;
  const scale = useScale(Math.max(0, ...(series ?? []).map(value => value ? read(value) : 0)), 1, t("unit.times", { count: 2 }), true);
  const sinceAt = since ? points.findIndex(point => point.to >= since) : -1;
  const chart = counted && since && series && series.length === points.length && <ChartGroup bins={points} span={days} today={view.head.today} bucket={bucket} pick={pick}
    lines={[{ name, value: i => series[i] ? format("times", read(series[i]!)) : t("chart.notCounted") }]}>
    <Row className="mb-2" left={before ? <><RowName>{name}</RowName><p className="mt-1 text-soft">{t("usage.none")}</p></>
      : <Num className="" label={name} kind="times" value={breakdown?.counted ? read(breakdown.counted.value) : 0}
        previous={breakdown?.counted?.previous ? read(breakdown.counted.previous) : null} length={daysBetween(days.from, days.to)} />}>
      <BarChart row={0} height="h-16 narrow:h-12" scale={scale} uncounted={i => series[i] === null}
        partial={i => points[i]!.from < since && points[i]!.to >= since} values={i => [["bg-muted", series[i] ? read(series[i]!) : 0]]} />
      <DayAxis strong={sinceAt >= 0 ? { at: sinceAt, day: since } : null} />
    </Row>
  </ChartGroup>;
  return <Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={group} onChange={next => choose(next as UsageGroup)}
    items={(["model", "agent", "skill", "tool", "mcp"] as const).map(key => [key, t(`usage.by.${key}`)] as const)} />}>
    {chart}
    {counted && since === null ? <p className="text-soft">{t("usage.none")}</p>
      : !before && <BreakdownTable id={`usage-${group}`} head={t(`usage.heads.${group}`)} columns={columns} rows={table} />}
  </Section>;
}
