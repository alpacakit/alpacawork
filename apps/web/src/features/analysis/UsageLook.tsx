import { useTranslation } from "react-i18next";
import { daysBetween, delta, format, type Kind } from "./format";
import { BreakdownTable } from "./BreakdownTable";
import { BucketSwitch, cell, useFinishedParts, type Open } from "./TasksLook";
import { BarChart, ChartGroup, DayAxis, inSpanOf, Lead, Leads, Legend, lineTop, Parts, Row, RowName, spanMost, useLineLabel, useScale, type DayList, type RowSay } from "./rows";
import { Compare, Num, RulesBox, RulesToggle, Section, Seg, Square, Value, useChoices, type UsageGroup } from "./parts";
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
export function UsageLook({ view, tasks, days, open, zone }: {
  view: UsageView; tasks: TasksView | null; days: Days; open: Open; zone: string;
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
    <Lead name={<><Square className="bg-working" />{t("usage.tokens")}<RulesToggle /></>} value={<Value big kind="tokens" value={tokens(now)} onOpen={() => open({ set: "used", value: "tokens" })} />}
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
  // Amounts a bin: the token total (output, input and cache), run time and launches; and the finished tasks they went to.
  const amount = { tokens: (i: number) => tokens(points[i]!.counts), runMs: (i: number) => points[i]!.counts.runMs, launches: (i: number) => points[i]!.counts.launches };
  type Amount = keyof typeof amount;
  const kinds: Record<Amount, Kind> = { tokens: "tokens", runMs: "hours", launches: "times" };
  const finishedOn = (i: number) => taskPoints?.[i]?.counts.finished ?? 0;
  const steady = (i: number) => finishedOn(i) >= 10;
  const perFinished = (key: Amount) => points.map((_, i) => taskPoints && finishedOn(i) ? amount[key](i) / finishedOn(i) : null);
  const unitOf = (kind: Kind, top: number): [number, string, boolean] => {
    const steps = t("unit.scales", { returnObjects: true }) as unknown as { at: number; unit: string }[];
    const step = kind === "tokens" && Array.isArray(steps) ? steps.find(each => top >= each.at) ?? null : null;
    return kind === "hours" ? [HOUR, t("unit.hours"), false] : step ? [step.at, step.unit, false] : [1, kind === "times" ? t("unit.times", { count: 2 }) : "", true];
  };
  // Both scales are the chosen span's: a larger bin or point outside it is cut at the top, and marked so.
  const inSpan = inSpanOf(points, days);
  const largest = (key: Amount) => spanMost(points, days, amount[key]);
  const scaleArgs = (key: Amount) => { const [unit, name, wholeOnly] = unitOf(kinds[key], largest(key)); return [largest(key), unit, name, wholeOnly] as const; };
  const scales = {
    finished: useScale(spanMost(points, days, finishedOn), 1, t("unit.tasks", { count: 2 }), true),
    tokens: useScale(...scaleArgs("tokens")), runMs: useScale(...scaleArgs("runMs")), launches: useScale(...scaleArgs("launches")),
  };
  const lineLabel = useLineLabel();
  const overlay = (key: Amount) => { const values = perFinished(key), top = lineTop(values, steady, inSpan);
    return { values, top, label: lineLabel(kinds[key] as "tokens" | "hours" | "times", top), faint: (i: number) => !steady(i) }; };
  const overlays = taskPoints ? { tokens: overlay("tokens"), runMs: overlay("runMs"), launches: overlay("launches") } : null;
  const finishedParts = useFinishedParts();
  const onBin = (set: Parameters<Open>[0]["set"], value: Parameters<Open>[0]["value"]) => (bin: { from: string; to: string }) => ({ set, value, from: bin.from, to: bin.to });
  const finishedBase = (i: number) => t("window.finished", { count: finishedOn(i) });
  const perLine = (key: Amount) => overlays ? { name: t("line.perFinished"), base: finishedBase,
    value: (i: number) => { const v = perFinished(key)[i]; return v === null || v === undefined ? "—" : format(kinds[key], v); } } : undefined;
  const first = taskPoints ? 1 : 0;
  const say: RowSay[] = [
    ...taskPoints ? [{ name: t("tasks.finished"), total: (i: number) => format("tasks", finishedOn(i)), list: onBin("finished", null),
      parts: (i: number) => finishedParts(taskPoints[i]!.counts) }] : [],
    { name: t("usage.tokens"), total: i => format("tokens", amount.tokens(i)), list: onBin("used", "tokens"), line: perLine("tokens"),
      parts: i => { const c = points[i]!.counts.tokens;
        return [{ color: "", name: t("usage.output"), value: format("tokens", c.output), list: c.output ? onBin("used", "output") : undefined },
          { color: "", name: t("usage.input"), value: format("tokens", c.input), list: c.input ? onBin("used", "input") : undefined },
          { color: "", name: t("usage.cache"), value: format("tokens", c.cache), list: c.cache ? onBin("used", "cache") : undefined }]; } },
    { name: t("usage.runMs"), total: i => format("hours", amount.runMs(i)), list: onBin("used", "runMs"), line: perLine("runMs") },
    { name: t("usage.launches"), total: i => format("times", amount.launches(i)), list: onBin("used", "launches"), line: perLine("launches"),
      parts: i => [{ color: "", name: t("usage.newConversations"), value: format("plain", points[i]!.counts.newConversations),
        list: points[i]!.counts.newConversations ? onBin("used", "newConversations") : undefined }] },
  ];
  // The span's amounts per finished task on the left, against the span before.
  const spanPer = (value: number, base: number | undefined) => base ? value / base : null;
  const perNow = (key: "tokens" | "runMs" | "launches") => spanPer(key === "tokens" ? tokens(now) : now[key], finished?.finished);
  const perBefore = (key: "tokens" | "runMs" | "launches") => before ? spanPer(key === "tokens" ? tokens(before) : before[key], tasks?.counts.previous?.finished) : null;
  const perEntry = (key: "tokens" | "runMs" | "launches") => {
    const value = perNow(key), previous = perBefore(key);
    return taskPoints ? { name: t("line.perFinished"), value: <b className="font-semibold">{value === null ? "—" : format(kinds[key], value)}</b>,
      gap: value !== null && previous !== null ? <span className="text-muted">{delta(kinds[key], value, previous)}</span> : null } : undefined;
  };
  const part = (kind: Kind, value: number, list: Parameters<Open>[0]) => <Value small kind={kind} value={value} onOpen={() => open(list)} />;
  const openDay = (list: DayList) => open({ set: list.set, value: list.value, group: list.group ?? null, member: list.member ?? null, days: { from: list.from, to: list.to } });
  const rows = <ChartGroup bins={points} span={days} today={today} bucket={bucket} rows={say} open={openDay}>
    <div key={grow}>
      {taskPoints && finished && <Row left={<>
        <Num className="" label={t("tasks.finished")} kind="tasks" value={finished.finished} previous={tasks?.counts.previous?.finished ?? null} length={length}
          onOpen={() => open({ set: "finished", value: null })} />
        <Parts items={[
          { color: "bg-done", name: t("outcome.passed"), value: part("tasks", finished.passed, { set: "passed", value: "lead" }) },
          { color: "bg-reworked", name: t("outcome.reworked"), value: part("tasks", finished.reworked, { set: "reworked", value: "lead" }) },
          { color: "bg-stopped-part", name: t("outcome.stopped"), value: part("tasks", finished.stopped, { set: "stopped", value: null }) }]} />
      </>}>
        <BarChart row={0} height="h-22 narrow:h-18" scale={scales.finished} grow
          values={i => [["bg-done", taskPoints[i]!.counts.passed], ["bg-reworked", taskPoints[i]!.counts.reworked], ["bg-stopped-part", taskPoints[i]!.counts.stopped]]} />
        <DayAxis />
      </Row>}
      <Row left={<>
        <Num className="" label={t("usage.tokens")} kind="tokens" value={tokens(now)} previous={before ? tokens(before) : null} length={length}
          onOpen={() => open({ set: "used", value: "tokens" })} />
        <Parts items={[
          { color: "", name: t("usage.output"), value: part("tokens", now.tokens.output, { set: "used", value: "output" }) },
          { color: "", name: t("usage.input"), value: part("tokens", now.tokens.input, { set: "used", value: "input" }) },
          { color: "", name: t("usage.cache"), value: part("tokens", now.tokens.cache, { set: "used", value: "cache" }) }]} line={perEntry("tokens")} />
      </>}>
        <BarChart row={first} height="h-30 narrow:h-22" scale={scales.tokens} tone="working" grow overlay={overlays?.tokens} values={i => [["", amount.tokens(i)]]} />
      </Row>
      <Row left={<>
        <Num className="" label={t("usage.runMs")} kind="hours" value={now.runMs} previous={before?.runMs ?? null} length={length}
          onOpen={() => open({ set: "used", value: "runMs" })} />
        <Parts line={perEntry("runMs")} />
      </>}>
        <BarChart row={first + 1} height="h-20 narrow:h-16" scale={scales.runMs} tone="working" grow overlay={overlays?.runMs} values={i => [["", amount.runMs(i)]]} />
      </Row>
      <Row left={<>
        <Num className="" label={t("usage.launches")} kind="times" value={now.launches} previous={before?.launches ?? null} length={length}
          onOpen={() => open({ set: "used", value: "launches" })} />
        <Parts items={[{ color: "", name: t("usage.newConversations"), value: part("plain", now.newConversations, { set: "used", value: "newConversations" }) }]}
          line={perEntry("launches")} />
      </>}>
        <BarChart row={first + 2} height="h-20 narrow:h-16" scale={scales.launches} tone="working" grow overlay={overlays?.launches} values={i => [["", amount.launches(i)]]} />
        <DayAxis />
      </Row>
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
      <p><b>{t("def.perFinishedName")}</b>{t("colon")}{t("def.perFinishedText")}</p>
      <p><b>{t("def.dayName")}</b>{t("colon")}{zone}</p>
      <Legend />
    </RulesBox>}
    <BucketSwitch />
    {rows}
    <Breakdown view={view} group={usageGroup} days={days} open={open} choose={next => choose({ usageGroup: next, all: false })} />
  </>;
}

/**
 * The AI's use broken down. Skills, tools and MCP are counted from the day counting began (`since`): their chart stands
 * over the table, the days before that day hatched and that day named in ink on the axis; a span wholly before it has no
 * record, and no table.
 */
function Breakdown({ view, group, days, open, choose }: {
  view: UsageView; group: UsageGroup; days: Days; open: Open; choose: (next: UsageGroup) => void;
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
  const scale = useScale(spanMost(points, days, i => series?.[i] ? read(series[i]!) : 0), 1, t("unit.times", { count: 2 }), true);
  const sinceAt = since ? points.findIndex(point => point.to >= since) : -1;
  const valueOf = by === "skill" ? "launches" as const : "calls" as const;
  const chart = counted && since && series && series.length === points.length && <ChartGroup bins={points} span={days} today={view.head.today} bucket={bucket}
    rows={[{ name, total: i => series[i] ? format("times", read(series[i]!)) : t("chart.notCounted"),
      // A bin before counting began has no tasks to open.
      list: (bin, at) => series[at] === null ? null : { set: "used", value: valueOf, group: by, member: null, from: bin.from, to: bin.to } }]}
    open={list => open({ set: list.set, value: list.value, group: list.group ?? null, member: null, days: { from: list.from, to: list.to } })}>
    <Row className="mb-2" left={before ? <><RowName>{name}</RowName><p className="mt-1 text-soft">{t("usage.none")}</p></>
      : <Num className="" label={name} kind="times" value={breakdown?.counted ? read(breakdown.counted.value) : 0}
        previous={breakdown?.counted?.previous ? read(breakdown.counted.previous) : null} length={daysBetween(days.from, days.to)}
        onOpen={() => open({ set: "used", value: by === "skill" ? "launches" : "calls", group: by, member: null })} />}>
      <BarChart row={0} height="h-16 narrow:h-12" scale={scale} uncounted={i => series[i] === null}
        partial={i => points[i]!.from < since && points[i]!.to >= since} tone="working" values={i => [["", series[i] ? read(series[i]!) : 0]]} />
      <DayAxis strong={sinceAt >= 0 ? { at: sinceAt, day: since } : null} />
    </Row>
  </ChartGroup>;
  return <Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={group} onChange={next => choose(next as UsageGroup)}
    items={(["model", "agent", "skill", "tool", "mcp"] as const).map(key => [key, t(`usage.by.${key}`)] as const)} />}>
    {chart}
    {counted && since === null ? <p className="text-soft">{t("usage.none")}</p>
      : !before && <BreakdownTable tone="working" id={`usage-${group}`} head={t(`usage.heads.${group}`)} columns={columns} rows={table} />}
  </Section>;
}
