import { memo } from "react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { daysBetween, delta, format, tokenColumn, unitOf as unitWord, type Kind } from "./format";
import { BreakdownTable } from "./BreakdownTable";
import { cell, head, useFinishedParts, type Open } from "./TasksLook";
import { BarChart, ChartGroup, DayAxis, inSpanOf, Lead, Leads, lineTop, Parts, Row, RowName, spanMost, useLineLabel, useScale, type DayList, type RowSay } from "./rows";
import { ReadPart, useReadSet, ChartHead, Compare, Num, Rule, RuleCard, Rules, rowName, Section, Seg, Value, useChoices, type UsageGroup } from "./parts";
import { tokenTotal, type TasksView, type UsageCounts, type UsageView } from "./contract";
import type { Span } from "./place";
import { useBreakdown, useNear } from "./data";
import { useViewStore } from "@/state/view-store";
import { LaunchControls, launchesParts, launchesSay, useLaunches, type LaunchAnswers } from "./Launches";

type Days = { from: string; to: string };
const HOUR = 3_600_000;

const tokens = tokenTotal;
/** Each value of the AI's use: how it is read from the counts, how it is written, and its list. */
const VALUES = {
  output: { read: (c: UsageCounts) => c.tokens.output, kind: "tokens" },
  input: { read: (c: UsageCounts) => c.tokens.input, kind: "tokens" },
  cache: { read: (c: UsageCounts) => c.tokens.cache, kind: "tokens" },
  runMs: { read: (c: UsageCounts) => c.runMs, kind: "hours" },
  launches: { read: (c: UsageCounts) => c.launches, kind: "times" },
  newConversations: { read: (c: UsageCounts) => c.newConversations, kind: "conversations" },
} as const satisfies Record<string, { read: (c: UsageCounts) => number; kind: Kind }>;
type ValueKey = keyof typeof VALUES;

/**
 * What the AI spent in the span, the tasks still at work included. Four numbers lead (tokens, run time, launches, and
 * the finished tasks they went to), each against the span before and the whole record. Then the finished tasks and every
 * value as a row on the same days, then the same broken down. Skills, tools and MCP are counted from the day counting
 * began: the days before it lie hatched.
 */
export const UsageLook = memo(function UsageLook({ view, span, root, tasks, days, open, zone, series, live = true }: {
  view: UsageView; span: Span; root: HTMLElement | null; tasks: TasksView | null; days: Days; open: Open; zone: string;
  /** The launches by model or effort: the whole record under the filter, without it, and the span under it. */
  series: LaunchAnswers;
  /** False in the face's stand-in (FaceSkeleton): nothing more is read. */
  live?: boolean;
}) {
  const { t } = useTranslation("analysis");
  const { bucket, usageGroup, grow } = useChoices();
  const choose = useChoices(state => state.choose);
  const length = daysBetween(days.from, days.to);
  const now = view.counts.value, before = view.counts.previous;
  const whole = view.head.firstDay === days.from && view.head.today === days.to;
  const ever = whole ? null : view.ever, taskEver = whole ? null : tasks?.ever ?? null;
  const finished = tasks?.counts.value ?? null;

  const leads = <Leads>
    <Lead name={t("usage.tokens")} value={<Value big kind="tokens" value={tokens(now)} onOpen={() => open({ set: "used", value: "tokens" })} />}
      note={now.tokens.cache > 0 && t("usage.cacheWithin", { value: format("tokens", now.tokens.cache) })}
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
  const launches = useLaunches(points, series, span, bucket, live);
  const taskPoints = tasks?.series.points.length === points.length ? tasks.series.points : null;
  // Amounts a bin: the token total (output, input and cache), run time and launches; and the finished tasks they went to.
  // The launches are the series' (under its filter) where they stand on the same bins, the use's otherwise.
  const amount = { tokens: (i: number) => tokens(points[i]!.counts), runMs: (i: number) => points[i]!.counts.runMs,
    launches: (i: number) => launches.ready ? launches.total(i) : points[i]!.counts.launches };
  type Amount = keyof typeof amount;
  const kinds: Record<Amount, Kind> = { tokens: "tokens", runMs: "hours", launches: "times" };
  const finishedOn = (i: number) => taskPoints?.[i]?.counts.finished ?? 0;
  const steady = (i: number) => finishedOn(i) >= 10;
  // Each amount per finished task, a bin, made once: a day's legend and every day's room read it by the bin.
  const perEach = (key: Amount) => points.map((_, i) => taskPoints && finishedOn(i) ? amount[key](i) / finishedOn(i) : null);
  const per = { tokens: perEach("tokens"), runMs: perEach("runMs"), launches: perEach("launches") };
  const perFinished = (key: Amount) => per[key];
  const unitOf = (kind: Kind, top: number): [number, string, boolean] => {
    const steps = t("unit.scales", { returnObjects: true }) as unknown as { at: number; unit: string }[];
    const step = kind === "tokens" && Array.isArray(steps) ? steps.find(each => top >= each.at) ?? null : null;
    return kind === "hours" ? [HOUR, t("unit.hours"), false] : step ? [step.at, step.unit, false] : [1, kind === "times" ? unitWord("times") : "", true];
  };
  // Both scales are the chosen span's: a larger bin or point outside it is cut at the top, and marked so.
  const inSpan = inSpanOf(points, days);
  const largest = (key: Amount) => spanMost(points, days, amount[key]);
  const scaleArgs = (key: Amount) => { const [unit, name, wholeOnly] = unitOf(kinds[key], largest(key)); return [largest(key), unit, name, wholeOnly] as const; };
  const scales = {
    finished: useScale(spanMost(points, days, finishedOn), 1, unitWord("tasks"), true),
    tokens: useScale(...scaleArgs("tokens")), runMs: useScale(...scaleArgs("runMs")), launches: useScale(...scaleArgs("launches")),
  };
  const lineLabel = useLineLabel();
  const overlay = (key: Amount) => { const values = perFinished(key), top = lineTop(values, steady, inSpan);
    return { values, top, label: lineLabel(kinds[key] as "tokens" | "hours" | "times", top), faint: (i: number) => !steady(i) }; };
  // Launches filtered to a model or an effort are not the launches of the tasks finished: no line over them.
  const overlays = taskPoints ? { tokens: overlay("tokens"), runMs: overlay("runMs"), launches: launches.isFiltered ? undefined : overlay("launches") } : null;
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
    launchesSay(launches, t("usage.launches"), launches.isFiltered ? undefined : perLine("launches"), launches.isFiltered ? undefined
      : i => [{ color: "", name: t("usage.newConversations"), value: format("conversations", points[i]!.counts.newConversations),
        list: points[i]!.counts.newConversations ? onBin("used", "newConversations") : undefined }]),
  ];
  // The span's amounts per finished task on the left, against the span before.
  const spanPer = (value: number, base: number | undefined) => base ? value / base : null;
  const perNow = (key: "tokens" | "runMs" | "launches") => spanPer(key === "tokens" ? tokens(now) : now[key], finished?.finished);
  const perBefore = (key: "tokens" | "runMs" | "launches") => before ? spanPer(key === "tokens" ? tokens(before) : before[key], tasks?.counts.previous?.finished) : null;
  const perEntry = (key: "tokens" | "runMs" | "launches") => {
    const value = perNow(key), previous = perBefore(key);
    return taskPoints ? { name: t("line.perFinished"), value: <><b className="font-semibold tabular-nums">{value === null ? "—" : format(kinds[key], value)}</b><i aria-hidden className="inline-block size-3 flex-none" /></>,
      gap: value !== null && previous !== null ? <span className="text-muted">{delta(kinds[key], value, previous)}</span> : null } : undefined;
  };
  // A part of a row's whole on the left: its number, and (when there are any) its tasks, opened from anywhere on its line.
  const part = (kind: Kind, value: number, list: Parameters<Open>[0]) => ({ value: <Value small kind={kind} value={value} />, onOpen: value ? () => open(list) : undefined });
  const openDay = (list: DayList) => open({ set: list.set, value: list.value, group: list.group ?? null, member: list.member ?? null, days: { from: list.from, to: list.to }, filter: list.filter ?? null });
  const rows = <ChartGroup bins={points} span={days} today={today} bucket={bucket} rows={say} open={openDay}>
    <div key={grow}>
      {/* Each row's number is a lead's above: the span before is said there, not again here. */}
      {taskPoints && finished && <Row row={0} className="border-t-0" left={<>
        <Num className="" label={t("tasks.finished")} kind="tasks" value={finished.finished} previous={null} length={length}
          onOpen={() => open({ set: "finished", value: null })} />
        <Parts items={[
          { color: "bg-done", name: t("outcome.passed"), ...part("tasks", finished.passed, { set: "passed", value: "lead" }) },
          { color: "bg-reworked", name: t("outcome.reworked"), ...part("tasks", finished.reworked, { set: "reworked", value: "lead" }) },
          { color: "bg-stopped-part", name: t("outcome.stopped"), ...part("tasks", finished.stopped, { set: "stopped", value: null }) }]} />
      </>}>
        <BarChart row={0} height="h-22 narrow:h-18" scale={scales.finished} grow
          values={i => [["bg-done", taskPoints[i]!.counts.passed, 0], ["bg-reworked", taskPoints[i]!.counts.reworked, 1], ["bg-stopped-part", taskPoints[i]!.counts.stopped, 2]]} />
        <DayAxis />
      </Row>}
      <Row row={first} className={first ? undefined : "border-t-0"} left={<>
        <Num className="" label={t("usage.tokens")} kind="tokens" value={tokens(now)} previous={null} length={length}
          onOpen={() => open({ set: "used", value: "tokens" })} />
        <Parts items={[
          { color: "", name: t("usage.output"), ...part("tokens", now.tokens.output, { set: "used", value: "output" }) },
          { color: "", name: t("usage.input"), ...part("tokens", now.tokens.input, { set: "used", value: "input" }) },
          { color: "", name: t("usage.cache"), ...part("tokens", now.tokens.cache, { set: "used", value: "cache" }) }]} line={perEntry("tokens")} />
      </>}>
        <BarChart row={first} height="h-30 narrow:h-22" scale={scales.tokens} tone="working" grow overlay={overlays?.tokens} values={i => [["", amount.tokens(i)]]} />
      </Row>
      <Row row={first + 1} left={<>
        <Num className="" label={t("usage.runMs")} kind="hours" value={now.runMs} previous={null} length={length}
          onOpen={() => open({ set: "used", value: "runMs" })} />
        <Parts line={perEntry("runMs")} />
      </>}>
        <BarChart row={first + 1} height="h-20 narrow:h-16" scale={scales.runMs} tone="working" grow overlay={overlays?.runMs} values={i => [["", amount.runMs(i)]]} />
      </Row>
      <Row row={first + 2} left={<>
        {/* While a filter's numbers come, those it replaces stand faint; the choices above them stay in reach. */}
        <div className={cn("transition-opacity duration-(--motion-base)", !launches.current && "opacity-50")}>
          <Num className="" label={t("usage.launches")} kind="times" value={launches.isFiltered ? launches.spanTotal : now.launches} previous={null} length={length}
            onOpen={() => open({ set: "used", value: "launches", filter: launches.filter })} />
        </div>
        <LaunchControls launches={launches} />
        <div className={cn("transition-opacity duration-(--motion-base)", !launches.current && "opacity-50")}><Parts items={[...launchesParts(launches, open), ...launches.isFiltered ? [] : [{ color: "", name: t("usage.newConversations"),
          ...part("conversations", now.newConversations, { set: "used", value: "newConversations" }) }]]}
          line={launches.isFiltered ? undefined : perEntry("launches")} /></div>
      </>}>
        {/* Each bin's launches stacked by model or effort, the most used at the foot; in one colour where the series does
            not stand on the same bins. */}
        <div className={cn("transition-opacity duration-(--motion-base)", !launches.current && "opacity-50")}>
          <BarChart row={first + 2} height="h-30 narrow:h-24" scale={scales.launches} tone={launches.ready ? undefined : "working"} grow overlay={overlays?.launches}
            values={i => launches.ready ? launches.parts(i).map(({ part, value }, at) => [part.color, value, at] as [string, number, number]) : [["", amount.launches(i)]]} />
        </div>
        <DayAxis />
      </Row>
    </div>
  </ChartGroup>;

  return <>
    {leads}
    <ChartHead />
    {rows}
    <Breakdown view={view} span={span} root={root} group={usageGroup} days={days} open={open} choose={next => choose({ usageGroup: next, all: false })} />
    {/* Every name the look shows, in cards in the order the rows show them. */}
    <Rules>
      <RuleCard><Rule name={t("def.tokensName")}>{t("def.tokensText")}{now.tokensUnknown > 0 && <p>{t("def.tokensUnknown", { count: now.tokensUnknown })}</p>}</Rule>
        <Rule name={t("usage.output")}>{t("def.outputText")}</Rule>
        <Rule name={t("def.inputName")}>{t("def.inputText")}</Rule>
        <Rule name={t("usage.cache")}>{t("def.cacheText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("def.runName")}>{t("def.runText")}</Rule>
        <Rule name={t("def.launchName")}>{t("def.launchText")}</Rule>
        <Rule name={t("def.conversationName")}>{t("def.conversationText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("def.finishedName")}>{t("def.finishedText")}</Rule>
        <Rule name={t("def.perFinishedName")}>{t("def.perFinishedText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("usage.tasks")}>{t("def.usedTasksText")}</Rule>
        <Rule name={t("def.skillName")}>{t("def.skillText")}</Rule>
        <Rule name={t("def.toolName")}>{t("def.toolText")}</Rule>
        <Rule name={t("usage.by.mcp")}>{t("def.mcpText")}</Rule>
        <Rule name={t("usage.calls")}>{t("def.callsText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("def.everName")}>{t("def.everText")}</Rule>
        <Rule name={t("def.dayName")}>{zone}</Rule></RuleCard>
    </Rules>
  </>;
});

/**
 * The AI's use broken down, read on its own when it comes near the screen (after the numbers above it), so choosing
 * another breakdown waits for this part alone. Skills, tools and MCP are counted from the day counting began (`since`):
 * their chart stands over the table, the days before that day hatched and that day named in ink on the axis; a span wholly before it has no
 * record, and no table.
 */
function Breakdown({ view, span, root, group, days, open, choose }: {
  view: UsageView; span: Span; root: HTMLElement | null; group: UsageGroup; days: Days; open: Open; choose: (next: UsageGroup) => void;
}) {
  const { t } = useTranslation("analysis");
  const { bucket } = useChoices();
  const project = useViewStore(state => state.project);
  const [near, wanted] = useNear(root);
  const breakdownRead = useBreakdown("usage", project, span, bucket, group, wanted);
  const breakdownSet = useReadSet("usage-breakdown", [breakdownRead]);
  const answer = (breakdownSet.data?.[0] as typeof breakdownRead.data)?.breakdown, breakdown = answer?.look === "usage" ? answer : null, rows = breakdown?.rows ?? [];
  const by = (breakdown?.by as UsageGroup | undefined) ?? group;
  const member = (key: string) => ({ group: by, member: key });
  const counted = by === "skill" || by === "tool" || by === "mcp";
  const since = breakdown?.since ?? null;
  const before = counted && (since === null || days.to < since);
  // Each column's unit is said once, in its heading: a token column's step (万, 億) is its largest value's.
  const tokenKeys = ["tokens", "output", "input", "cache"] as const;
  const tokenRead = { tokens, output: VALUES.output.read, input: VALUES.input.read, cache: VALUES.cache.read };
  const steps = Object.fromEntries(tokenKeys.map(key => [key, tokenColumn(rows.map(row => tokenRead[key](row.counts)))])) as Record<typeof tokenKeys[number], ReturnType<typeof tokenColumn>>;
  const tokenHead = (key: typeof tokenKeys[number]) => steps[key].unit ? t("table.head", { name: t(`usage.${key}`), unit: steps[key].unit }) : t(`usage.${key}`);
  // The model and the AI kind lead with the tokens, the use's first number above; the rest lead with their own count.
  const columns = by === "skill" ? [head(t("usage.launches"), "times"), head(t("usage.tasks"), "tasks")]
    : counted ? [head(t("usage.calls"), "times"), head(t("usage.launches"), "times"), head(t("usage.tasks"), "tasks")]
      : [...tokenKeys.map(tokenHead), head(t("usage.launches"), "times"), head(t("usage.runMs"), "hours"),
        head(t("usage.newConversations"), "conversations"), head(t("usage.tasks"), "tasks")];
  const table = rows.map(row => {
    const c = row.counts, tasks = cell("tasks", c.tasks, () => open({ set: "used", value: "launches", ...member(row.key) }));
    const launches = cell("times", c.launches, () => open({ set: "used", value: "launches", ...member(row.key) }));
    const tokenCell = (key: typeof tokenKeys[number]) => { const value = tokenRead[key](c);
      return { text: steps[key].write(value), open: value ? () => open({ set: "used", value: key, ...member(row.key) }) : undefined }; };
    const cells = by === "skill" ? [launches, tasks]
      : counted ? [cell("times", row.calls ?? 0, () => open({ set: "used", value: "calls", ...member(row.key) })), launches, tasks]
        : [...tokenKeys.map(tokenCell), ...(["launches", "runMs", "newConversations"] as const).map(key =>
          cell(VALUES[key].kind, VALUES[key].read(c), () => open({ set: "used", value: key, ...member(row.key) }))), tasks];
    return { key: row.key, name: rowName(row, t("tasks.noAgent")), bar: by === "skill" ? c.launches : counted ? row.calls ?? 0 : tokens(c), cells };
  });
  const name = by === "skill" ? t("usage.skillLaunches") : t("usage.calls");
  const read = (value: { calls: number; launches: number }) => by === "skill" ? value.launches : value.calls;
  const series = breakdown?.series ?? null, points = view.series.points;
  const scale = useScale(spanMost(points, days, i => series?.[i] ? read(series[i]!) : 0), 1, unitWord("times"), true);
  const sinceAt = since ? points.findIndex(point => point.to >= since) : -1;
  const valueOf = by === "skill" ? "launches" as const : "calls" as const;
  const chart = counted && since && series && series.length === points.length && <ChartGroup bins={points} span={days} today={view.head.today} bucket={bucket}
    rows={[{ name, total: i => series[i] ? format("times", read(series[i]!)) : t("chart.notCounted"),
      // A bin before counting began has no tasks to open.
      list: (bin, at) => series[at] === null ? null : { set: "used", value: valueOf, group: by, member: null, from: bin.from, to: bin.to } }]}
    open={list => open({ set: list.set, value: list.value, group: list.group ?? null, member: null, days: { from: list.from, to: list.to } })}>
    <Row row={0} className="mb-2" left={before ? <><RowName>{name}</RowName><p className="mt-1 text-soft">{t("usage.none")}</p></>
      : <Num className="" label={name} kind="times" value={breakdown?.counted ? read(breakdown.counted.value) : 0}
        previous={breakdown?.counted?.previous ? read(breakdown.counted.previous) : null} length={daysBetween(days.from, days.to)}
        onOpen={() => open({ set: "used", value: by === "skill" ? "launches" : "calls", group: by, member: null })} />}>
      <BarChart row={0} height="h-16 narrow:h-12" scale={scale} uncounted={i => series[i] === null}
        partial={i => points[i]!.from < since && points[i]!.to >= since} tone="working" values={i => [["", series[i] ? read(series[i]!) : 0]]} />
      <DayAxis strong={sinceAt >= 0 ? { at: sinceAt, day: since } : null} />
    </Row>
  </ChartGroup>;
  return <div ref={near}><Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={group} onChange={next => choose(next as UsageGroup)}
    items={(["model", "agent", "skill", "tool", "mcp"] as const).map(key => [key, t(`usage.by.${key}`)] as const)} />}>
    <ReadPart set={breakdownSet} skeleton={<RegionSkeleton shape="analysisRows" />}>{() => <>
      {chart}
      {counted && since === null ? <p className="text-soft">{t("usage.none")}</p>
        : !before && <BreakdownTable tone="working" id={`usage-${group}`} head={t(`usage.heads.${group}`)} columns={columns} rows={table} />}
    </>}</ReadPart>
  </Section></div>;
}
