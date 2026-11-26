import { memo } from "react";
import { useTranslation } from "react-i18next";
import { RegionSkeleton } from "@/components/ui/skeleton";
import { i18n } from "@alpacawork/i18n";
import { daysBetween, decimalText, delta, format, inUnit, parts, share, shareDelta, previousName, unitOf, type Kind } from "./format";
import { Grass } from "./charts";
import { BreakdownTable, type Cell } from "./BreakdownTable";
import { BarChart, binsKey, ChartGroup, DayAxis, inSpanOf, Lead, Leads, lineTop, Parts, Row, spanMost, useLineLabel, useScale, type DayList, type RowSay } from "./rows";
import { ReadPart, useReadSet, ChartHead, Compare, gapTone, Num, OPEN, OpenMark, Rule, RuleCard, Rules, rowName, Section, Seg, Value, tip, useChoices, type TaskGroup } from "./parts";
import type { ListSet, ListValue, TasksView } from "./contract";
import type { ListPlace, Span } from "./place";
import { useBreakdown, useChanges, useNear } from "./data";
import { Causes } from "./Causes";
import { Waits } from "./Waits";
import type { ChangeMark } from "./rows";
import type { ChangesView } from "./contract";
import { useViewStore } from "@/state/view-store";

type Days = { from: string; to: string };
export type Open = (list: Omit<ListPlace, "group" | "member"> & Partial<Pick<ListPlace, "group" | "member">>) => void;
const HOUR = 3_600_000;

/**
 * The tasks that finished in the span. Four numbers lead (through without fixes, finished, the median time until
 * accepted, related PRs), each against the span before and the whole record. Then every counted value as a row on the
 * same days: finished tasks (with the calendar), the share without fixes, and what it took until acceptance. Then the
 * same numbers broken down. Every number opens the tasks behind it.
 */
export const TasksLook = memo(function TasksLook({ view, span, root, days, open, zone, live = true }: { view: TasksView; span: Span; root: HTMLElement | null;
  days: Days; open: Open; zone: string;
  /** False for the face's stand-in (FaceSkeleton): it reads nothing of its own. */
  live?: boolean }) {
  const { t } = useTranslation("analysis");
  const { bucket, taskGroup } = useChoices();
  const choose = useChoices(state => state.choose);
  const length = daysBetween(days.from, days.to);
  const now = view.counts.value, before = view.counts.previous;
  const accepted = view.accepted.value, acceptedBefore = view.accepted.previous;
  const whole = view.head.firstDay === days.from && view.head.today === days.to;
  const ever = whole ? null : view.ever;
  const time = accepted.time, you = time.review + time.answer, total = you + time.ai + time.other;
  const project = useViewStore(state => state.project);
  const changeRead = useChanges(project, span, live);
  // Another project's or span's changes are never drawn on these charts while this one's are read.
  const changes = useChangeMarks(changeRead.isPlaceholderData ? undefined : changeRead.data, view.head.timeZone);

  const countGap = before ? delta("tasks", now.passed, before.passed) : null;
  const shareGap = before ? shareDelta(now.share, before.share) : null;
  const leads = <Leads>
    <Lead name={t("tasks.passed")}
      value={<Value big kind="tasks" value={now.passed} onOpen={() => open({ set: "passed", value: "lead" })} />}
      // Under the number where the column is narrow; there the strip gives way (to 24px) before the share leaves the column.
      beside={now.accepted > 0 && <span className="inline-flex max-w-full min-w-0 items-center gap-2.5" {...tip(now.share === null ? t("chart.shareTipFew", now) : t("chart.shareTip", now))}>
        <span className="flex h-1.5 w-24 min-w-6 shrink gap-0.5 narrow:hidden">
          <i style={{ flex: now.passed }} className="block min-w-0.5 rounded-xs bg-done" />
          <i style={{ flex: now.reworked }} className="block min-w-0.5 rounded-xs bg-reworked" />
        </span>
        <button type="button" onClick={() => open({ set: "accepted", value: null })} className={OPEN}>
          <b className="text-heading font-semibold tabular-nums">{share(now.share)}</b><OpenMark /></button>
      </span>}
      compare={before && <div className="flex flex-wrap gap-x-2.5 text-xs text-soft">
        <span className="whitespace-nowrap">{previousName(length)} {format("tasks", before.passed)}{before.share !== null && `${t("sep")}${share(before.share)}`}</span>
        <b className="font-normal whitespace-nowrap text-muted">{countGap}
          {shareGap !== null && <>{t("sep")}<span className={gapTone(now.share!, before.share!, "up")}>{shareGap}</span></>}</b>
      </div>}
      ever={ever && `${format("tasks", ever.counts.passed)}${ever.counts.share !== null ? `${t("sep")}${share(ever.counts.share)}` : ""}`} />
    <Lead name={t("tasks.finished")} value={<Value big kind="tasks" value={now.finished} onOpen={() => open({ set: "finished", value: null })} />}
      compare={<Compare kind="tasks" value={now.finished} previous={before?.finished ?? null} length={length} />}
      ever={ever && format("tasks", ever.counts.finished)} />
    <Lead name={t("until.lead")} value={<Value big kind="hours" value={accepted.leadMedianMs} onOpen={() => open({ set: "accepted", value: "lead" })} />}
      compare={accepted.leadMedianMs === null ? null : <Compare kind="hours" value={accepted.leadMedianMs} previous={acceptedBefore?.leadMedianMs ?? null} length={length} />}
      ever={ever && ever.accepted.leadMedianMs !== null ? format("hours", ever.accepted.leadMedianMs) : null} />
    <Lead name={t("until.prs")} value={<Value big kind="prs" value={accepted.prs} onOpen={() => open({ set: "accepted", value: "prs" })} />}
      compare={<Compare kind="prs" value={accepted.prs} previous={acceptedBefore?.prs ?? null} length={length} />}
      ever={ever && format("prs", ever.accepted.prs)} />
  </Leads>;

  const points = view.series.points, today = view.head.today;
  const at = (i: number) => points[i]!;
  const spent = (i: number) => { const time = at(i).accepted.time; return [time.review + time.answer, time.ai, time.other] as const; };
  const total_ = (i: number) => spent(i).reduce((a, b) => a + b, 0);
  const steady = (i: number) => at(i).counts.accepted >= 10;
  const finishedParts = useFinishedParts();
  // The per-task lines: the share without fixes (of the tasks accepted), the median time, and checks and questions per task.
  const per = (amount: (i: number) => number) => points.map((p, i) => p.counts.accepted ? amount(i) / p.counts.accepted : null);
  const lines = {
    share: per(i => at(i).counts.passed), median: points.map(p => p.accepted.leadMedianMs),
    submits: per(i => at(i).accepted.submits), questions: per(i => at(i).accepted.questions),
  };
  // Both scales are the chosen span's: a larger bin or point outside it is cut at the top, and marked so.
  const inSpan = inSpanOf(points, days), most = (amount: (i: number) => number) => spanMost(points, days, amount);
  const tops = { median: lineTop(lines.median, steady, inSpan), submits: lineTop(lines.submits, steady, inSpan), questions: lineTop(lines.questions, steady, inSpan) };
  const scales = {
    finished: useScale(most(i => at(i).counts.finished), 1, unitOf("tasks"), true),
    total: useScale(most(total_), HOUR, t("unit.hours"), false),
    submits: useScale(most(i => at(i).accepted.submits), 1, unitOf("times"), true),
    questions: useScale(most(i => at(i).accepted.questions), 1, unitOf("questions"), true),
    prs: useScale(most(i => at(i).accepted.prs), 1, unitOf("prs"), true),
  };
  const faint = (i: number) => !steady(i), lineLabel = useLineLabel();
  const overlays = {
    share: { values: lines.share, top: 1, label: "100%", faint },
    median: { values: lines.median, top: tops.median, label: lineLabel("hours", tops.median), faint },
    submits: { values: lines.submits, top: tops.submits, label: lineLabel("times", tops.submits), faint },
    questions: { values: lines.questions, top: tops.questions, label: lineLabel("questions", tops.questions), faint },
  };
  const acceptedBase = (i: number) => t("window.accepted", { count: at(i).counts.accepted });
  const ratio = (value: number | null, kind: Kind) => value === null ? "—" : kind === "plain" ? share(value) : format(kind, value);
  const perText = (value: number | null, kind: "times" | "questions") => value === null ? "—" : inUnit(decimalText(value, 2), unitOf(kind));
  const share_ = (part: number, whole: number) => whole ? share(part / whole) : "";
  const onBin = (set: Parameters<Open>[0]["set"], value: Parameters<Open>[0]["value"]) => (bin: { from: string; to: string }) => ({ set, value, from: bin.from, to: bin.to });
  const say: RowSay[] = [
    { name: t("tasks.finished"), total: i => format("tasks", at(i).counts.finished), list: onBin("finished", null),
      parts: i => finishedParts(at(i).counts),
      // On fewer than ten accepted the share is not given (its point is hollow): the window says the counts instead.
      line: { name: t("chart.share"), value: i => { const c = at(i).counts;
        return c.share !== null ? share(c.share) : c.accepted ? t("window.passedOf", { count: c.accepted, passed: c.passed }) : "—"; },
        base: i => { const c = at(i).counts;
          return c.share === null && c.accepted ? t("tasks.few") : t("chart.shareTip", { accepted: c.accepted, passed: c.passed }); } } },
    { name: t("time.total"), total: i => format("hours", total_(i)), list: onBin("accepted", "lead"),
      parts: i => { const [y, a, o] = spent(i), all = total_(i);
        const day = (value: "you" | "ai" | "other", amount: number) => amount ? onBin("accepted", value) : undefined;
        return [{ color: "bg-turn", name: t("time.you"), value: format("hours", y), share: share_(y, all), list: day("you", y) },
          { color: "bg-working", name: t("time.ai"), value: format("hours", a), share: share_(a, all), list: day("ai", a) },
          { color: "bg-rest", name: t("time.other"), value: format("hours", o), share: share_(o, all), list: day("other", o) }]; },
      line: { name: t("line.median"), value: i => ratio(lines.median[i]!, "hours"), base: acceptedBase } },
    { name: t("until.submits"), total: i => format("times", at(i).accepted.submits), list: onBin("accepted", "submits"),
      line: { name: t("line.perTask"), value: i => perText(lines.submits[i]!, "times"), base: acceptedBase } },
    { name: t("until.questions"), total: i => format("questions", at(i).accepted.questions), list: onBin("accepted", "questions"),
      line: { name: t("line.perTask"), value: i => perText(lines.questions[i]!, "questions"), base: acceptedBase } },
    { name: t("until.prs"), total: i => format("prs", at(i).accepted.prs), list: onBin("accepted", "prs") },
  ];
  // A part of a row's whole on the left: its number, and (when there are any) its tasks, opened from anywhere on its line.
  const part = (kind: Kind, value: number, list: Parameters<Open>[0]) => ({ value: <Value small kind={kind} value={value} />, onOpen: value ? () => open(list) : undefined });
  // The per-task numbers of the span on the left, against the span before.
  const perSpan = (amount: number, base: number) => base ? amount / base : null;
  const submitsPer = perSpan(accepted.submits, now.accepted), submitsPerBefore = acceptedBefore && before ? perSpan(acceptedBefore.submits, before.accepted) : null;
  const questionsPer = perSpan(accepted.questions, now.accepted), questionsPerBefore = acceptedBefore && before ? perSpan(acceptedBefore.questions, before.accepted) : null;
  const gap = (value: number | null, previous: number | null, kind: "pt" | "hours" | "per", better?: "up" | "down") => {
    if (value === null || previous === null) return null;
    const text = kind === "pt" ? shareDelta(value, previous) : kind === "hours" ? delta("hours", value, previous) : perGap(value, previous);
    return <span className={gapTone(value, previous, better)}>{text}</span>;
  };
  const perGap = (value: number, previous: number) => { const g = Math.round((value - previous) * 100) / 100;
    return g === 0 ? t("same") : `${g > 0 ? "+" : "−"}${decimalText(Math.abs(g), 2)}`; };
  const openDay = (list: DayList) => open({ set: list.set, value: list.value, group: list.group ?? null, member: list.member ?? null, days: { from: list.from, to: list.to } });
  const rows = <ChartGroup bins={points} span={days} today={today} bucket={bucket} rows={say} open={openDay} changes={changes}>
    <div key={binsKey(points)}>
      {/* A row whose number is a lead's above says no span before again (the lead says it). */}
      <Row row={0} className="border-t-0" left={<>
        <Num className="" label={t("tasks.finished")} kind="tasks" value={now.finished} previous={null} length={length}
          onOpen={() => open({ set: "finished", value: null })} />
        <Parts items={[
          { color: "bg-done", name: t("outcome.passed"), ...part("tasks", now.passed, { set: "passed", value: "lead" }) },
          { color: "bg-reworked", name: t("outcome.reworked"), ...part("tasks", now.reworked, { set: "reworked", value: "lead" }) },
          { color: "bg-stopped-part", name: t("outcome.stopped"), ...part("tasks", now.stopped, { set: "stopped", value: null }) }]}
          line={{ name: t("chart.share"), value: <ShareValue value={now.share} onOpen={now.accepted ? () => open({ set: "accepted", value: null }) : undefined} />,
            gap: before && gap(now.share, before.share, "pt", "up") }} />
        <div className="mt-6 narrow:mt-4"><Grass from={view.grass.from} counts={view.grass.finished} firstDay={view.head.firstDay} today={today} span={days} /></div>
      </>}>
        <BarChart row={0} height="h-76 narrow:h-32" scale={scales.finished} grow overlay={overlays.share}
          values={i => [["bg-done", at(i).counts.passed, 0], ["bg-reworked", at(i).counts.reworked, 1], ["bg-stopped-part", at(i).counts.stopped, 2]]} />
        <DayAxis />
      </Row>
      <Row row={1} left={<>
        <Num className="" label={t("time.total")} kind="hours" value={total} previous={acceptedBefore ? acceptedBefore.time.review + acceptedBefore.time.answer + acceptedBefore.time.ai + acceptedBefore.time.other : null}
          length={length} onOpen={() => open({ set: "accepted", value: "lead" })} />
        <Parts items={[
          { color: "bg-turn", name: t("time.you"), ...part("hours", you, { set: "accepted", value: "you" }), share: share_(you, total) },
          { color: "bg-working", name: t("time.ai"), ...part("hours", time.ai, { set: "accepted", value: "ai" }), share: share_(time.ai, total) },
          { color: "bg-rest", name: t("time.other"), ...part("hours", time.other, { set: "accepted", value: "other" }), share: share_(time.other, total) }]}
          line={{ name: t("line.median"), value: <Value small kind="hours" value={accepted.leadMedianMs} onOpen={() => open({ set: "accepted", value: "lead" })} />,
            gap: gap(accepted.leadMedianMs, acceptedBefore?.leadMedianMs ?? null, "hours") }} />
        {/* Your turn, by where you were while it waited. */}
        {you > 0 && <><p className="mt-3 text-xs text-soft">{t("waits.title")}</p><Waits waits={accepted.waits} total={you} className="mt-1" /></>}
      </>}>
        <BarChart row={1} height="h-30 narrow:h-22" scale={scales.total} overlay={overlays.median}
          values={i => { const [y, a, o] = spent(i); return [["bg-turn", y, 0], ["bg-working", a, 1], ["bg-rest", o, 2]]; }} />
      </Row>
      <Row row={2} left={<>
        <Num className="" label={t("until.submits")} kind="times" value={accepted.submits} previous={acceptedBefore?.submits ?? null} length={length}
          onOpen={() => open({ set: "accepted", value: "submits" })} />
        <Parts line={{ name: t("line.perTask"), value: <PerValue value={submitsPer} unit={unitOf("times")} onOpen={() => open({ set: "accepted", value: "submits" })} />,
          gap: gap(submitsPer, submitsPerBefore, "per", "down") }} />
      </>}>
        <BarChart row={2} height="h-16 narrow:h-13" scale={scales.submits} tone="turn" overlay={overlays.submits} values={i => [["", at(i).accepted.submits]]} />
      </Row>
      <Row row={3} left={<>
        <Num className="" label={t("until.questions")} kind="questions" value={accepted.questions} previous={acceptedBefore?.questions ?? null} length={length}
          onOpen={() => open({ set: "accepted", value: "questions" })} />
        <Parts line={{ name: t("line.perTask"), value: <PerValue value={questionsPer} unit={unitOf("questions")} onOpen={() => open({ set: "accepted", value: "questions" })} />,
          gap: gap(questionsPer, questionsPerBefore, "per") }} />
      </>}>
        <BarChart row={3} height="h-16 narrow:h-13" scale={scales.questions} tone="turn" overlay={overlays.questions} values={i => [["", at(i).accepted.questions]]} />
      </Row>
      <Row row={4} left={<Num className="" label={t("until.prs")} kind="prs" value={accepted.prs} previous={null} length={length}
        onOpen={() => open({ set: "accepted", value: "prs" })} />}>
        <BarChart row={4} height="h-16 narrow:h-13" scale={scales.prs} tone="muted" values={i => [["", at(i).accepted.prs]]} />
        <DayAxis />
      </Row>
    </div>
  </ChartGroup>;

  return <>
    {leads}
    <ChartHead />
    {rows}
    <Causes accepted={accepted} open={open} />
    <TasksBreakdown span={span} root={root} open={open} />
    {/* Every name the look shows, in cards in the order the rows show them. */}
    <Rules>
      <RuleCard><Rule name={t("tasks.passed")}>{t("def.lead")}<ul><li>{t("def.one")}</li><li>{t("def.two")}</li><li>{t("def.three")}</li></ul>
        <p>{t("def.after")}</p></Rule></RuleCard>
      <RuleCard><Rule name={t("tasks.finished")}>{t("def.finishedTasksText")}</Rule>
        <Rule name={t("tasks.accepted")}>{t("def.acceptedText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("def.leadName")}>{t("def.leadText")}</Rule>
        <Rule name={t("time.you")}>{t("def.youText")}</Rule>
        <Rule name={t("time.ai")}>{t("def.aiText")}</Rule>
        <Rule name={t("time.other")}>{t("def.otherText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("until.submits")}>{t("def.submitsText")}</Rule>
        <Rule name={t("until.questions")}>{t("def.questionsText")}</Rule>
        <Rule name={t("def.perTaskName")}>{t("def.perTaskText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("def.prName")}>{t("def.prText")}</Rule>
        <Rule name={t("def.modelName")}>{t("def.modelText")}</Rule></RuleCard>
      <RuleCard><Rule name={t("def.everName")}>{t("def.everText")}</Rule>
        <Rule name={t("def.dayName")}>{zone}</Rule></RuleCard>
    </Rules>
  </>;
});

/**
 * The tasks broken down (by model, AI or project): read on its own when it comes near the screen, after the numbers
 * above it, so choosing another breakdown waits for this table alone.
 */
function TasksBreakdown({ span, root, open }: { span: Span; root: HTMLElement | null; open: Open }) {
  const { t } = useTranslation("analysis");
  const { bucket, taskGroup } = useChoices();
  const choose = useChoices(state => state.choose);
  const project = useViewStore(state => state.project);
  const [near, wanted] = useNear(root);
  const breakdownRead = useBreakdown("tasks", project, span, bucket, taskGroup, wanted);
  const breakdownSet = useReadSet("tasks-breakdown", [breakdownRead]);
  const answer = (breakdownSet.data?.[0] as typeof breakdownRead.data)?.breakdown, read = answer?.look === "tasks" ? answer : null, breakdownRows = read?.rows ?? [];
  const groupOf = (key: string) => ({ group: read?.by ?? taskGroup, member: key });
  return <div ref={near}><Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={taskGroup} onChange={next => choose({ taskGroup: next as TaskGroup, all: false })}
    items={[["model", t("tasks.by.model")], ["agent", t("tasks.by.agent")], ["project", t("tasks.by.project")]]} />}>
    <ReadPart set={breakdownSet} skeleton={<RegionSkeleton shape="analysisRows" />}>{() => <>
      <BreakdownTable tone="done" id={`tasks-${taskGroup}`} head={t(`tasks.by.${taskGroup}`)}
        columns={[head(t("tasks.cols.finished"), "tasks"), head(t("tasks.cols.accepted"), "tasks"), head(t("tasks.cols.passed"), "tasks"), t("chart.share"),
          head(t("tasks.cols.lead"), "hours"), t("tasks.cols.submits")]}
        rows={breakdownRows.map(row => ({ key: row.key,
          name: rowName(row, t("tasks.noAgent")), bar: row.finished, cells: [
          cell("tasks", row.finished, () => open({ set: "finished", value: null, ...groupOf(row.key) })),
          cell("tasks", row.accepted, () => open({ set: "accepted", value: null, ...groupOf(row.key) })),
          cell("tasks", row.passed, () => open({ set: "passed", value: "lead", ...groupOf(row.key) })),
          { text: share(row.share), tip: row.accepted && row.share === null ? t("tasks.few") : undefined,
            split: row.share !== null ? [row.passed, row.accepted - row.passed] : undefined,
            open: row.accepted ? () => open({ set: "accepted", value: null, ...groupOf(row.key) }) : undefined },
          row.leadMedianMs === null ? { text: "—" } : cell("hours", row.leadMedianMs, () => open({ set: "accepted", value: "lead", ...groupOf(row.key) })),
          row.submitsPerAccepted === null ? { text: "—" } : { text: decimalText(row.submitsPerAccepted, 2),
            open: () => open({ set: "accepted", value: "submits", ...groupOf(row.key) }) },
        ] }))} />
    </>}</ReadPart>
  </Section></div>;
}

/** The changes of what Runs ran under, by their local days and in words, as the charts' marks (`analysis changes`). */
function useChangeMarks(view: ChangesView | undefined, zone: string): ChangeMark[] {
  const { t } = useTranslation("analysis");
  if (!view) return [];
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  return view.changes.map(change => ({ day: day.format(new Date(change.at)), words: change.changes.map(each => changeWords(each, t)) }));
}
/**
 * One change in words: a skill or an instruction file by its name (its versions are digests, which say nothing), the
 * others from what to what.
 */
function changeWords(change: ChangesView["changes"][number]["changes"][number], t: (key: string, options?: Record<string, unknown>) => string) {
  const what = t(`change.${change.what}`);
  if (change.what === "skill" || change.what === "instruction-file")
    return t(change.from === null ? "change.added" : change.to === null ? "change.removed" : "change.updated", { what, name: change.name ?? "" });
  return t("change.fromTo", { what, from: change.from ?? "—", to: change.to ?? "—" });
}

/** A table's column heading with its unit once (none in a language that writes no count word). */
export const head = (name: string, kind: Parameters<typeof unitOf>[0]) => { const unit = unitOf(kind);
  return unit ? i18n.t("analysis:table.head", { name, unit }) : name; };

/**
 * A table cell of a count or hours: the number alone (its unit is in the column's heading), opening the tasks behind
 * it when there are any. (A token column is written by its own step, `tokenColumn`.)
 */
export function cell(kind: Exclude<Kind, "tokens">, value: number, open: () => void): Cell {
  return { text: parts(kind, value).value, open: value ? open : undefined };
}

/** The parts of a day's finished tasks, as its window says them under the total, in the colours they are drawn in. */
export function useFinishedParts() {
  const { t } = useTranslation("analysis");
  // Each part opens its own tasks of the bin's days, as the same part on the left opens the span's.
  const day = (set: ListSet, value: ListValue | null) => (bin: { from: string; to: string }) => ({ set, value, from: bin.from, to: bin.to });
  return (counts: { passed: number; reworked: number; stopped: number }) => [
    { color: "bg-done", name: t("outcome.passed"), value: format("tasks", counts.passed), list: counts.passed ? day("passed", "lead") : undefined },
    { color: "bg-reworked", name: t("outcome.reworked"), value: format("tasks", counts.reworked), list: counts.reworked ? day("reworked", "lead") : undefined },
    { color: "bg-stopped-part", name: t("outcome.stopped"), value: format("tasks", counts.stopped), list: counts.stopped ? day("stopped", null) : undefined }];
}

/** The share without fixes, large enough to read beside its name, opening the accepted tasks. */
function ShareValue({ value, onOpen }: { value: number | null; onOpen?: () => void }) {
  if (!onOpen || value === null) return <span className="inline-flex items-baseline gap-0.5"><b className="font-semibold tabular-nums">{share(value)}</b><i aria-hidden className="inline-block size-3 flex-none" /></span>;
  return <button type="button" onClick={onOpen} className={OPEN}><b className="font-semibold tabular-nums">{share(value)}</b><OpenMark /></button>;
}
/** An amount per task (two places), with its unit, opening its tasks. */
function PerValue({ value, unit, onOpen }: { value: number | null; unit: string; onOpen: () => void }) {
  if (value === null) return <span className="inline-flex items-baseline gap-0.5"><b className="font-semibold">—</b><i aria-hidden className="inline-block size-3 flex-none" /></span>;
  return <button type="button" onClick={onOpen} className={OPEN}>
    <b className="font-semibold tabular-nums">{decimalText(value, 2)}</b>{unit && <span className="text-xs text-muted">{unit}</span>}<OpenMark /></button>;
}
