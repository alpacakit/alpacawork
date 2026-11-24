import { useTranslation } from "react-i18next";
import { daysBetween, delta, format, parts, share, shareDelta, previousName, type Kind } from "./format";
import { Grass } from "./charts";
import { BreakdownTable, type Cell } from "./BreakdownTable";
import { BarChart, ChartGroup, DayAxis, Lead, Leads, LineChart, Parts, Row, RowName, useScale } from "./rows";
import { Compare, Num, RulesBox, RulesToggle, Section, Seg, Square, Value, tip, useChoices, type TaskGroup } from "./parts";
import type { TasksView } from "./contract";
import type { ListPlace } from "./place";

type Days = { from: string; to: string };
export type Open = (list: Omit<ListPlace, "group" | "member"> & Partial<Pick<ListPlace, "group" | "member">>) => void;
const HOUR = 3_600_000;

/**
 * The tasks that finished in the span. Four numbers lead (through without fixes, finished, the median time until
 * accepted, related PRs), each against the span before and the whole record. Then every counted value as a row on the
 * same days: finished tasks (with the calendar), the share without fixes, and what it took until acceptance. Then the
 * same numbers broken down. Every number opens the tasks behind it.
 */
export function TasksLook({ view, days, open, zone }: { view: TasksView; days: Days; open: Open; zone: string }) {
  const { t } = useTranslation("analysis");
  const { bucket, taskGroup, grow, rules } = useChoices();
  const choose = useChoices(state => state.choose);
  const length = daysBetween(days.from, days.to);
  const now = view.counts.value, before = view.counts.previous;
  const accepted = view.accepted.value, acceptedBefore = view.accepted.previous;
  const whole = view.head.firstDay === days.from && view.head.today === days.to;
  const ever = whole ? null : view.ever;
  const time = accepted.time, you = time.review + time.answer, total = you + time.ai + time.other;

  const countGap = before ? delta("tasks", now.passed, before.passed) : null;
  const shareGap = before ? shareDelta(now.share, before.share) : null;
  const leads = <Leads>
    <Lead name={<><Square className="bg-done" />{t("tasks.passed")}<RulesToggle /></>}
      value={<Value big kind="tasks" value={now.passed} onOpen={() => open({ set: "passed", value: "lead" })} />}
      beside={now.accepted > 0 && <span className="inline-flex items-center gap-2.5" {...tip(now.share === null ? t("chart.shareTipFew", now) : t("chart.shareTip", now))}>
        <span className="flex h-1.5 w-24 gap-0.5 narrow:hidden">
          <i style={{ flex: now.passed }} className="block min-w-0.5 rounded-xs bg-done" />
          <i style={{ flex: now.reworked }} className="block min-w-0.5 rounded-xs bg-reworked" />
        </span>
        <button type="button" onClick={() => open({ set: "accepted", value: null })}
          className="text-lg font-semibold underline decoration-lit-line underline-offset-4 hover:decoration-ink">{share(now.share)}</button>
      </span>}
      compare={<div className="flex flex-wrap gap-x-2.5 text-xs text-soft">
        {before ? <><span className="whitespace-nowrap">{previousName(length)} {format("tasks", before.passed)}{before.share !== null && `${t("sep")}${share(before.share)}`}</span>
          <b className="font-normal whitespace-nowrap text-muted">{shareGap === null ? countGap : `${countGap === t("same") ? countGap : t("unit.join", { value: countGap, unit: t("unit.tasks", { count: 2 }) })}${t("sep")}${shareGap}`}</b></>
          : t("previous.none", { span: previousName(length) })}
      </div>}
      ever={ever && `${format("tasks", ever.counts.passed)}${ever.counts.share !== null ? `${t("sep")}${share(ever.counts.share)}` : ""}`} />
    <Lead name={t("tasks.finished")} value={<Value big kind="tasks" value={now.finished} onOpen={() => open({ set: "finished", value: null })} />}
      compare={<Compare kind="tasks" value={now.finished} previous={before?.finished ?? null} length={length} />}
      ever={ever && format("tasks", ever.counts.finished)} />
    <Lead name={t("until.lead")} value={<Value big kind="hours" value={accepted.leadMedianMs} onOpen={() => open({ set: "accepted", value: "lead" })} />}
      compare={accepted.leadMedianMs === null ? null : <Compare kind="hours" value={accepted.leadMedianMs} previous={acceptedBefore?.leadMedianMs ?? null} length={length} />}
      ever={ever && ever.accepted.leadMedianMs !== null ? format("hours", ever.accepted.leadMedianMs) : null} />
    <Lead name={t("until.prs")} value={<Value big kind="plain" value={accepted.prs} onOpen={() => open({ set: "accepted", value: "prs" })} />}
      compare={<Compare kind="plain" value={accepted.prs} previous={acceptedBefore?.prs ?? null} length={length} />}
      ever={ever && format("plain", ever.accepted.prs)} />
  </Leads>;

  const points = view.series.points, today = view.head.today;
  const at = (i: number) => points[i]!;
  const median = (i: number) => at(i).accepted.leadMedianMs;
  const spent = (i: number) => { const time = at(i).accepted.time; return [time.review + time.answer, time.ai, time.other] as const; };
  const scales = {
    finished: useScale(Math.max(0, ...points.map(p => p.counts.finished)), 1, t("unit.tasks", { count: 2 }), true),
    share: { top: 1, label: "100%" },
    median: useScale(Math.max(0, ...points.map(p => p.accepted.leadMedianMs ?? 0)), HOUR, t("unit.hours"), false),
    total: useScale(Math.max(0, ...points.map((_, i) => spent(i).reduce((a, b) => a + b, 0))), HOUR, t("unit.hours"), false),
    submits: useScale(Math.max(0, ...points.map(p => p.accepted.submits)), 1, t("unit.times", { count: 2 }), true),
    questions: useScale(Math.max(0, ...points.map(p => p.accepted.questions)), 1, t("unit.tasks", { count: 2 }), true),
    prs: useScale(Math.max(0, ...points.map(p => p.accepted.prs)), 1, "", true),
  };
  const shareWords = (i: number) => { const c = at(i).counts;
    return c.share !== null ? share(c.share) : c.accepted ? t("chart.fewShare", { passed: c.passed, accepted: c.accepted }) : "—"; };
  const lines = [
    { name: t("tasks.finished"), value: (i: number) => format("tasks", at(i).counts.finished) },
    { name: t("chart.share"), value: shareWords },
    { name: t("until.lead"), value: (i: number) => median(i) === null ? "—" : format("hours", median(i)!) },
    { name: t("time.total"), value: (i: number) => format("hours", spent(i).reduce((a, b) => a + b, 0)) },
    { name: t("until.submits"), value: (i: number) => format("times", at(i).accepted.submits) },
    { name: t("until.questions"), value: (i: number) => format("tasks", at(i).accepted.questions) },
    { name: t("until.prs"), value: (i: number) => format("plain", at(i).accepted.prs) },
  ];
  const part = (kind: Kind, value: number, list: Parameters<Open>[0]) => <Value small kind={kind} value={value} onOpen={() => open(list)} />;
  const rows = <ChartGroup bins={points} span={days} today={today} bucket={bucket} lines={lines}>
    <div key={grow}>
      <Row left={<>
        <RowName>{t("tasks.finished")}</RowName>
        <Parts items={[
          { color: "bg-done", name: t("outcome.passed"), value: part("tasks", now.passed, { set: "passed", value: "lead" }) },
          { color: "bg-reworked", name: t("outcome.reworked"), value: part("tasks", now.reworked, { set: "reworked", value: "lead" }) },
          { color: "bg-stopped", name: t("outcome.stopped"), value: part("tasks", now.stopped, { set: "stopped", value: null }) }]} />
        <div className="mt-6 narrow:mt-4"><Grass from={view.grass.from} counts={view.grass.finished} firstDay={view.head.firstDay} today={today} span={days} /></div>
      </>}>
        <BarChart row={0} height="h-52 narrow:h-24" scale={scales.finished} grow
          values={i => [["bg-done", at(i).counts.passed], ["bg-reworked", at(i).counts.reworked], ["bg-stopped", at(i).counts.stopped]]} />
        <DayAxis />
      </Row>
      <Row left={<>
        <RowName>{t("chart.share")}</RowName>
        <div className="mt-1 flex items-baseline gap-2 text-xs text-muted">{t("tasks.accepted")}{part("tasks", now.accepted, { set: "accepted", value: null })}</div>
      </>}>
        <LineChart row={1} height="h-18 narrow:h-14" scale={scales.share} color="done"
          values={points.map(p => p.counts.accepted ? p.counts.passed / p.counts.accepted : null)} faint={i => at(i).counts.accepted < 10} />
      </Row>
      <Row left={<><h3 className="mb-3 text-sm font-semibold">{t("until.title")}</h3>
        <Num className="" label={t("until.lead")} kind="hours" value={accepted.leadMedianMs} previous={acceptedBefore?.leadMedianMs ?? null} length={length}
          onOpen={() => open({ set: "accepted", value: "lead" })} /></>}>
        <LineChart row={2} height="h-18 narrow:h-14" scale={scales.median} color="muted" values={points.map(p => p.accepted.leadMedianMs)} />
      </Row>
      <Row left={<>
        <RowName>{t("time.total")}</RowName>
        <Value kind="hours" value={total} onOpen={() => open({ set: "accepted", value: "lead" })} />
        <Parts items={[
          { color: "bg-turn", name: t("time.you"), value: part("hours", you, { set: "accepted", value: "you" }) },
          { color: "bg-working", name: t("time.ai"), value: part("hours", time.ai, { set: "accepted", value: "ai" }) },
          { color: "bg-rest", name: t("time.other"), value: part("hours", time.other, { set: "accepted", value: "other" }) }]} />
      </>}>
        <BarChart row={3} height="h-26 narrow:h-20" scale={scales.total}
          values={i => { const [y, a, o] = spent(i); return [["bg-turn", y], ["bg-working", a], ["bg-rest", o]]; }} />
      </Row>
      <Row left={<Num className="" label={t("until.submits")} kind="times" value={accepted.submits} previous={acceptedBefore?.submits ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "submits" })} />}>
        <BarChart row={4} height="h-14 narrow:h-11" scale={scales.submits} values={i => [["bg-muted", at(i).accepted.submits]]} />
      </Row>
      <Row left={<Num className="" label={t("until.questions")} kind="tasks" value={accepted.questions} previous={acceptedBefore?.questions ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "questions" })} />}>
        <BarChart row={5} height="h-14 narrow:h-11" scale={scales.questions} values={i => [["bg-muted", at(i).accepted.questions]]} />
      </Row>
      <Row left={<Num className="" label={t("until.prs")} kind="plain" value={accepted.prs} previous={acceptedBefore?.prs ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "prs" })} />}>
        <BarChart row={6} height="h-14 narrow:h-11" scale={scales.prs} values={i => [["bg-muted", at(i).accepted.prs]]} />
        <DayAxis />
      </Row>
    </div>
  </ChartGroup>;

  const breakdownRows = view.breakdown?.rows ?? [];
  const groupOf = (key: string) => ({ group: view.breakdown?.by ?? taskGroup, member: key });
  const breakdown = <Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={taskGroup} onChange={next => choose({ taskGroup: next as TaskGroup, all: false })}
    items={[["model", t("tasks.by.model")], ["agent", t("tasks.by.agent")], ["project", t("tasks.by.project")]]} />}>
    <BreakdownTable id={`tasks-${taskGroup}`} head={t(`tasks.by.${taskGroup}`)}
      columns={[t("tasks.cols.finished"), t("tasks.cols.accepted"), t("tasks.cols.passed"), t("tasks.cols.share"), t("tasks.cols.lead"), t("tasks.cols.submits")]}
      rows={breakdownRows.map(row => ({ key: row.key,
        // A task no AI was given (no owner Run) has the server's key `unknown` for its model and AI kind.
        name: row.key === "unknown" && taskGroup !== "project" ? t("tasks.noAgent") : row.label, bar: row.finished, cells: [
        cell("tasks", row.finished, () => open({ set: "finished", value: null, ...groupOf(row.key) })),
        cell("tasks", row.accepted, () => open({ set: "accepted", value: null, ...groupOf(row.key) })),
        cell("tasks", row.passed, () => open({ set: "passed", value: "lead", ...groupOf(row.key) })),
        { text: share(row.share), tip: row.accepted && row.share === null ? t("tasks.few") : undefined,
          open: row.accepted ? () => open({ set: "accepted", value: null, ...groupOf(row.key) }) : undefined },
        row.leadMedianMs === null ? { text: "—" } : cell("hours", row.leadMedianMs, () => open({ set: "accepted", value: "lead", ...groupOf(row.key) })),
        row.submitsPerAccepted === null ? { text: "—" } : { text: row.submitsPerAccepted.toFixed(2), unit: t("unit.times", { count: 2 }),
          open: () => open({ set: "accepted", value: "submits", ...groupOf(row.key) }) },
      ] }))} />
  </Section>;

  return <>
    {leads}
    {rules && <RulesBox>
      <p>{t("def.lead")}</p>
      <ul><li>{t("def.one")}</li><li>{t("def.two")}</li><li>{t("def.three")}</li></ul>
      <p>{t("def.after")}</p>
      <p><b>{t("def.modelName")}</b>{t("colon")}{t("def.modelText")}<span className="ms-4" /><b>{t("def.leadName")}</b>{t("colon")}{t("def.leadText")}</p>
      <p><b>{t("def.prName")}</b>{t("colon")}{t("def.prText")}<span className="ms-4" /><b>{t("def.everName")}</b>{t("colon")}{t("def.everText")}</p>
      <p><b>{t("def.dayName")}</b>{t("colon")}{zone}</p>
    </RulesBox>}
    <BucketSwitch />
    {rows}
    {breakdown}
  </>;
}

/** The step of time of every chart, once, over the right of the first row. */
export function BucketSwitch() {
  const { t } = useTranslation("analysis");
  const { bucket, grow } = useChoices();
  return <div className="mt-8 mb-2 flex justify-end">
    <Seg label={t("bucket.label")} value={bucket} onChange={next => useChoices.getState().choose({ bucket: next, grow: grow + 1 })}
      items={[["day", t("bucket.day")], ["week", t("bucket.week")], ["month", t("bucket.month")]]} />
  </div>;
}

/** A table cell of a value: the number, its unit small, opening the tasks behind it when there are any. */
export function cell(kind: Kind, value: number, open: () => void): Cell {
  const written = parts(kind, value);
  return { text: written.value, unit: written.unit, open: value ? open : undefined };
}
