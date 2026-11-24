import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { daysBetween, delta, format, parts, share, shareDelta, previousName, type Kind } from "./format";
import { BarPanel, Grass, RatePanel, SplitBar } from "./charts";
import { BreakdownTable, type Cell } from "./BreakdownTable";
import { Num, RulesBox, RulesToggle, Section, Seg, Square, Value, tip, useChoices, type TaskGroup } from "./parts";
import type { TasksView } from "./contract";
import type { ListPlace } from "./place";

type Days = { from: string; to: string };
type Open = (list: Omit<ListPlace, "group" | "member"> & Partial<Pick<ListPlace, "group" | "member">>) => void;

/**
 * The tasks that finished in the span: one number leads (how many went through without a fix, and their share of those
 * accepted); the others stand a step back and name the chart's colours. Then what it took until acceptance, and the
 * same numbers broken down. Every number opens the tasks behind it.
 */
export function TasksLook({ view, days, open, pick, zone }: { view: TasksView; days: Days; open: Open; pick: (days: Days) => void; zone: string }) {
  const { t } = useTranslation("analysis");
  const { bucket, taskGroup, grow, rules } = useChoices();
  const choose = useChoices(state => state.choose);
  const length = daysBetween(days.from, days.to);
  const now = view.counts.value, before = view.counts.previous;
  const accepted = view.accepted.value, acceptedBefore = view.accepted.previous;
  const time = accepted.time, you = time.review + time.answer, total = you + time.ai + time.other;

  const countGap = before ? delta("tasks", now.passed, before.passed) : null;
  const shareGap = before ? shareDelta(now.share, before.share) : null;
  const lead = <div>
    <div className="flex items-center text-xs whitespace-nowrap text-muted"><Square className="bg-done" />{t("tasks.passed")}<RulesToggle /></div>
    <div className="mt-0.5 flex items-baseline gap-5">
      <Value big kind="tasks" value={now.passed} onOpen={() => open({ set: "passed", value: "lead" })} />
      {now.accepted > 0 && <span className="inline-flex items-center gap-2.5"
        {...tip(now.share === null ? t("chart.shareTipFew", now) : t("chart.shareTip", now))}>
        <span className="flex h-1.5 w-40 gap-0.5 narrow:w-30">
          <i style={{ flex: now.passed }} className="block min-w-0.5 rounded-xs bg-done" />
          <i style={{ flex: now.reworked }} className="block min-w-0.5 rounded-xs bg-reworked" />
        </span>
        <b className="text-lg font-semibold">{share(now.share)}</b>
      </span>}
    </div>
    <div className="text-xs whitespace-nowrap text-soft">
      {before ? <>{previousName(length)} {format("tasks", before.passed)}{before.share !== null && `${t("sep")}${share(before.share)}`}
        <b className="ms-2.5 font-normal text-muted">{shareGap === null ? countGap : `${countGap === t("same") ? countGap : t("unit.join", { value: countGap, unit: t("unit.tasks", { count: 2 }) })}${t("sep")}${shareGap}`}</b></>
        : t("previous.none", { span: previousName(length) })}
    </div>
  </div>;

  const minor = <div className="mt-5 flex flex-wrap gap-x-6 gap-y-5 narrow:grid narrow:grid-cols-2 narrow:gap-x-3 narrow:gap-y-4">
    <Num label={t("tasks.reworked")} square="bg-reworked" kind="tasks" value={now.reworked} previous={before?.reworked ?? null} length={length} onOpen={() => open({ set: "reworked", value: "lead" })} />
    <Num label={t("tasks.stopped")} square="bg-stopped" kind="tasks" value={now.stopped} previous={before?.stopped ?? null} length={length} onOpen={() => open({ set: "stopped", value: null })} />
    <Num label={t("tasks.accepted")} kind="tasks" value={now.accepted} previous={before?.accepted ?? null} length={length} onOpen={() => open({ set: "accepted", value: null })} />
    <Num label={t("tasks.finished")} kind="tasks" value={now.finished} previous={before?.finished ?? null} length={length} onOpen={() => open({ set: "finished", value: null })} />
  </div>;

  const bins = view.series.points;
  const today = view.head.today;
  const charts = <div key={grow} className="mt-6">
    <div className="mb-2 flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1">
      <span className="me-auto text-xs text-muted">{t("chart.share")}</span>
      <Seg label={t("bucket.label")} value={bucket} onChange={next => choose({ bucket: next, grow: grow + 1 })}
        items={[["day", t("bucket.day")], ["week", t("bucket.week")], ["month", t("bucket.month")]]} />
    </div>
    <RatePanel bins={bins} bucket={bucket} span={days} today={today} onPick={pick} points={bins.map(point => point.counts)} />
    <div className="mb-2 text-xs text-muted">{t("chart.finished")}</div>
    <BarPanel bins={bins} bucket={bucket} span={days} today={today} onPick={pick} grow unit={1} unitName={t("unit.tasks", { count: 2 })} wholeOnly
      values={at => { const c = bins[at]!.counts; return [["bg-done", c.passed], ["bg-reworked", c.reworked], ["bg-stopped", c.stopped]]; }}
      tipOf={at => { const c = bins[at]!.counts; return t("chart.finishedTip", { total: c.finished, passed: c.passed, reworked: c.reworked, stopped: c.stopped }); }} />
  </div>;

    const until = <Section title={t("until.title")}>
    <div className="flex flex-wrap gap-x-6 gap-y-5 narrow:grid narrow:grid-cols-2 narrow:gap-x-3 narrow:gap-y-4">
      <Num label={t("until.lead")} kind="hours" value={accepted.leadMedianMs} previous={acceptedBefore?.leadMedianMs ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "lead" })} />
      <Num label={t("until.submits")} kind="times" value={accepted.submits} previous={acceptedBefore?.submits ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "submits" })} />
      <Num label={t("until.questions")} kind="tasks" value={accepted.questions} previous={acceptedBefore?.questions ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "questions" })} />
      <Num label={t("until.prs")} kind="tasks" value={accepted.prs} previous={acceptedBefore?.prs ?? null} length={length}
        onOpen={() => open({ set: "accepted", value: "prs" })} />
    </div>
    {total > 0 && <div className="mt-7">
      <div className="text-xs text-muted">{t("time.total", { time: format("hours", total) })}</div>
      <SplitBar className="my-2" parts={[
        { color: "bg-turn", value: time.review, words: `${t("time.review")} ${format("hours", time.review)}` },
        { color: "bg-turn", value: time.answer, words: `${t("time.answer")} ${format("hours", time.answer)}` },
        { color: "bg-working", value: time.ai, words: `${t("time.ai")} ${format("hours", time.ai)}` },
        { color: "bg-rest", value: time.other, words: `${t("time.other")} ${format("hours", time.other)}` }]} />
      <div className="flex gap-0.5 narrow:flex-wrap narrow:gap-y-1">
        {([["you", you, "bg-turn"], ["ai", time.ai, "bg-working"], ["other", time.other, "bg-rest"]] as const).map(([key, value, color], at) =>
          <button key={key} type="button" style={{ flex: `${value} 1 0` }} onClick={() => open({ set: "accepted", value: key })}
            className={cn("flex min-w-max items-center rounded-xs whitespace-nowrap text-muted hover:underline hover:underline-offset-4 narrow:flex-none!", at < 2 && "pe-4")}>
            <Square className={color} />{t(`time.${key}`)}<b className="ms-1.5 font-semibold text-ink underline decoration-lit-line underline-offset-4">{format("hours", value)}</b>
          </button>)}
      </div>
    </div>}
  </Section>;

  const rows = view.breakdown?.rows ?? [];
  // The breakdown the rows were counted by, which is the one chosen unless another is being read.
  const groupOf = (key: string) => ({ group: view.breakdown?.by ?? taskGroup, member: key });
  const breakdown = <Section title={t("breakdown.title")} aside={<Seg label={t("breakdown.title")} value={taskGroup} onChange={next => choose({ taskGroup: next as TaskGroup, all: false })}
    items={[["model", t("tasks.by.model")], ["agent", t("tasks.by.agent")], ["project", t("tasks.by.project")]]} />}>
    <BreakdownTable id={`tasks-${taskGroup}`} head={t(`tasks.by.${taskGroup}`)}
      columns={[t("tasks.cols.finished"), t("tasks.cols.accepted"), t("tasks.cols.passed"), t("tasks.cols.share"), t("tasks.cols.lead"), t("tasks.cols.submits")]}
      rows={rows.map(row => ({ key: row.key,
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
    <div className="flex flex-wrap items-start gap-x-18 gap-y-6 narrow:gap-6">
      <div>{lead}{minor}</div>
      <Grass from={view.grass.from} counts={view.grass.finished} firstDay={view.head.firstDay} span={days} onPick={pick} />
    </div>
    {/* Under the numbers, so opening it moves none of them. */}
    {rules && <RulesBox>
      <p>{t("def.lead")}</p>
      <ul><li>{t("def.one")}</li><li>{t("def.two")}</li><li>{t("def.three")}</li></ul>
      <p>{t("def.after")}</p>
      <p><b>{t("def.modelName")}</b>{t("colon")}{t("def.modelText")}<span className="ms-4" /><b>{t("def.leadName")}</b>{t("colon")}{t("def.leadText")}</p>
      <p><b>{t("def.prName")}</b>{t("colon")}{t("def.prText")}<span className="ms-4" /><b>{t("def.dayName")}</b>{t("colon")}{zone}</p>
    </RulesBox>}
    {charts}
    {until}
    {breakdown}
  </>;
}

/** A table cell of a value: the number, its unit small, opening the tasks behind it when there are any. */
export function cell(kind: Kind, value: number, open: () => void): Cell {
  const written = parts(kind, value);
  return { text: written.value, unit: written.unit, open: value ? open : undefined };
}
