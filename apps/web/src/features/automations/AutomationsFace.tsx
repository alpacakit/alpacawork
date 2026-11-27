import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { PendingRegion, ReadFailure } from "@/components/ui/loadable";
import { TAB, TAB_ROW, TabLabel, TabMarker } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useWriteDisabled } from "@/data/queries";
import { groupOf, nameMark, type AutomationGroup } from "@/domain/automations";
import { formatClock, formatLogDay, formatLogTime } from "@/domain/time";
import { useNow } from "@/state/clock";
import { useNarrow, useViewStore } from "@/state/view-store";
import { useListNavigationSource } from "@/features/tree/list-navigation";
import { automationInDraft } from "@/features/coordinator/editor/draft";
import { attentionOf, useAllRuns, useAutomationsInView, useUpcoming } from "./data";
import { openAutomation, showAutomationsTab } from "./open";
import type { AutomationsPlace } from "./place";
import type { Automation, Run } from "./shape";
import { dayCounts, knownWords, nextText, outcomeWord, reasonText, runLine, whenText } from "./words";
import { RunTasks } from "./RunParts";

/**
 * The automations face, the whole screen below the bar: one table of every automation (its name, when it runs, its
 * last run, and how many of the last 7 days' matches went through), or the runs of all of them. One opens in the
 * reader's window beside the table, as a task does beside the list; the table narrows for it. An automation is a
 * program the AI wrote from the person's words and is never edited here: it is changed by asking in the input.
 */
export function AutomationsFace({ place }: { place: AutomationsPlace }) {
  const { t } = useTranslation("automations");
  const { list } = useAutomationsInView();
  const writeDisabled = useWriteDisabled();
  return <section data-automations data-list-scroll aria-label={t("list.title")} className="@container scroll-pb-(--list-foot) pane-scroll flex min-h-0 flex-1 flex-col overflow-auto px-6 pt-5 pb-(--list-foot) narrow:px-3 narrow:pt-3">
    <div className="max-w-[1180px]">
      {/* One line: the title, the table or the runs, today's counts, and asking for a new one (a phone puts the counts below). */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        <h3 className="m-0 text-lg font-semibold narrow:sr-only">{t("list.title")}</h3>
        <div role="group" aria-label={t("list.views")} className={cn(TAB_ROW, "-mx-1")}>
          <TabMarker current='[aria-current="true"]' />
          {(["list", "runs"] as const).map(tab => <button key={tab} type="button" data-automations-tab={tab} aria-current={place.tab === tab ? "true" : undefined}
            onClick={() => showAutomationsTab(tab)} className={cn(TAB, "aria-[current=true]:font-semibold aria-[current=true]:text-ink narrow:min-h-11")}>
            <TabLabel>{t(tab === "list" ? "list.tabList" : "list.tabRuns")}</TabLabel></button>)}
        </div>
        {list && <p data-automations-today className="m-0 text-sm text-muted narrow:order-last narrow:basis-full">
          {[t("list.todayAi", { count: list.today.ai }), t("list.todayOutside", { count: list.today.outside })].join(t("join"))}</p>}
        <Button variant="outline" data-automation-new disabled={writeDisabled} className="ms-auto narrow:min-h-11"
          onClick={() => automationInDraft("new", { pressed: true })}><Icon name="plus" className="size-3.5" />{t("list.new")}</Button>
      </div>
      {place.tab === "runs" ? <AllRuns /> : <AutomationTable />}
    </div>
  </section>;
}

/**
 * The table, grouped: those asking for a look (a run failed, it went off by itself, a new version waits), those on,
 * then drafts and those off. Its columns are set in rem so the head and every row line up; the name takes up to 22rem.
 * Narrowed by the window beside it, the 7 days' column goes first; on a phone each one is two lines.
 */
function AutomationTable() {
  const { t } = useTranslation("automations");
  const { automations, failed, retry } = useAutomationsInView();
  const open = useViewStore(state => state.automation?.id ?? null);
  const groups = useMemo(() => {
    const by: Record<AutomationGroup, Automation[]> = { attention: [], on: [], rest: [] };
    for (const automation of automations ?? []) by[groupOf(automation)].push(automation);
    return by;
  }, [automations]);
  // The window's ‹ › go along the rows in the order drawn.
  const ids = useMemo(() => [...groups.attention, ...groups.on, ...groups.rest].map(automation => automation.id), [groups]);
  useListNavigationSource(useMemo(() => ({ ids, open: (id: string) => openAutomation(id) }), [ids]));
  if (failed && !automations) return <ReadFailure what={t("list.failed")} error={failed} retry={retry} />;
  if (!automations) return <PendingRegion pending shape="time" />;
  if (!automations.length) return <Message tone="empty" size="line" title={t("list.empty")} />;
  return <div data-automation-table role="table" aria-label={t("list.title")}>
    <div role="row" className={cn(ROW_GRID, "border-b border-rule pb-1.5 text-xs text-muted narrow:hidden")}>
      <span role="columnheader" className="col-start-2">{t("column.name")}</span>
      <span role="columnheader">{t("column.when")}</span>
      <span role="columnheader">{t("column.last")}</span>
      <span role="columnheader" className={WEEK_COLUMN}>{t("column.week")}</span>
    </div>
    {(["attention", "on", "rest"] as const).map(group => groups[group].length > 0 &&
      <div key={group} role="rowgroup" data-automation-group={group}>
        <h4 role="row" className="m-0 flex items-center gap-2 pt-4 pb-1.5 text-sm font-semibold">
          <span aria-hidden className={cn("size-2 rounded-[2px]", group === "attention" ? "bg-error" : group === "on" ? "bg-ink" : "bg-muted")} />
          <span role="rowheader">{t(`group.${group}`)}</span><span className="font-normal text-muted tabular-nums">{groups[group].length}</span>
        </h4>
        {groups[group].map(automation => <AutomationRow key={automation.id} automation={automation} open={automation.id === open} />)}
      </div>)}
  </div>;
}

/** The table's columns: a dot, the name, when, the last run, the last 7 days. The last goes first where room is short. */
const ROW_GRID = "grid grid-cols-[1.25rem_minmax(0,22rem)_minmax(0,16rem)_minmax(0,1fr)_9rem] items-baseline gap-x-4 @max-[60rem]:grid-cols-[1.25rem_minmax(0,22rem)_minmax(0,14rem)_minmax(0,1fr)] narrow:grid-cols-[1rem_minmax(0,1fr)_auto] narrow:gap-x-2";
const WEEK_COLUMN = "@max-[60rem]:hidden";

/**
 * One automation, one line: its state as a dot (red only for a failure), its ID and name with what it is when not
 * simply on (a draft, off, a new version waiting), when it runs, its last run (a failure in red with why, beside it;
 * one by the clock says when it runs next), and of the last 7 days' matches how many went through.
 */
function AutomationRow({ automation, open }: { automation: Automation; open: boolean }) {
  const { t } = useTranslation("automations");
  const narrow = useNarrow();
  const facts = automation.latest.facts;
  const mark = nameMark(automation);
  const attention = attentionOf(automation);
  const failed = attention?.kind === "failed" || attention?.kind === "disabled";
  return <div role="row" data-automation-row={automation.id} aria-current={open ? "true" : undefined}
    className={cn(ROW_GRID, "relative border-b border-rule py-2.5 hover:bg-row-hover aria-[current=true]:bg-hover narrow:py-2")}>
    <StateDot automation={automation} failed={failed} />
    <span role="cell" className="flex min-w-0 items-baseline gap-1.5">
      <span className="flex-none text-xs text-muted tabular-nums">{automation.id}</span>
      {/* The whole row opens it; the name is its button, so a screen reader hears what opens. */}
      <button type="button" data-automation-open={automation.id} onClick={() => openAutomation(automation.id)}
        className="min-w-0 truncate text-start font-medium narrow:line-clamp-2 narrow:whitespace-normal after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
        <span dir="auto">{automation.name}</span></button>
      {mark && <span data-automation-mark={mark} className="flex-none rounded-xs border border-line px-1 text-xs whitespace-nowrap text-muted">{t(`mark.${mark}`)}</span>}
    </span>
    {!narrow && <span role="cell" className="truncate text-sm text-muted">{whenText(t, facts.when, facts.limits.timezone)}</span>}
    <LastRun automation={automation} failure={failed ? attention : null} narrow={narrow} />
    {!narrow && <span role="cell" className={WEEK_COLUMN}><WeekBar automation={automation} /></span>}
  </div>;
}

/** Its state as a dot: red while a failure asks for a look, dark when on, grey while a new version waits, hollow when not on. */
function StateDot({ automation, failed }: { automation: Automation; failed: boolean }) {
  const { t } = useTranslation("automations");
  const kind = failed ? "failed" : automation.awaitingEnable ? "awaiting" : automation.enabled ? "on" : "off";
  return <span role="cell" aria-label={t(`dot.${kind}`)} className="flex self-center">
    <span data-automation-dot={kind} className={cn("size-2 rounded-full", { failed: "bg-error", awaiting: "bg-muted", on: "bg-ink", off: "border-[1.5px] border-muted" }[kind])} />
  </span>;
}

/**
 * The last run: its time and outcome ("09:33 failed · why", the outcome alone in red), or, for one by the clock that is
 * on, when it runs next. On a phone, why it failed is a line of its own under the name.
 */
function LastRun({ automation, failure: failed, narrow }: { automation: Automation; failure: Automation["attention"][number] | null; narrow: boolean }) {
  const { t, i18n } = useTranslation("automations");
  const now = new Date(useNow());
  const last = automation.lastRun;
  let failure = failed;
  const upcoming = useUpcoming(automation, automation.enabled);
  // A failure asking for a look is said by the run that failed, whatever runs came after it.
  // A run going on now is said as that, not by the failure before it.
  const going = !!last && (last.state === "running" || last.state === "waiting");
  if (going) failure = null;
  const why = failure && (failure.kind === "disabled" && automation.disabledReason && knownWords(t, `reason.${automation.disabledReason}`) || reasonText(t, failure));
  if (!last && !upcoming && !failure) return <span role="cell" className="text-sm text-muted">—</span>;
  const head = failure ? <><span className="tabular-nums">{formatLogTime(failure.at, i18n.language)}</span>{" "}
      <span className="font-semibold text-error">{t("runs.state.failed")}</span></>
    : automation.enabled && upcoming && !going ? <span className="text-ink">{nextText(t, upcoming, now, i18n.language)}</span>
    : last && <><span className="tabular-nums">{formatLogTime(last.at, i18n.language)}</span>{" "}
      <span className="text-ink">{outcomeWord(t, last)}</span></>;
  return <>
    <span role="cell" data-automation-last className="min-w-0 truncate text-sm text-muted">{head}
      {why && !narrow && <span className="@max-[60rem]:hidden">{t("join")}{why}</span>}</span>
    {why && narrow && <span data-automation-failed-why className="col-start-2 col-end-4 text-sm text-muted">{why}</span>}
  </>;
}

/**
 * Of the last 7 days' matches, how many went through: a thin bar and "4/6". It lets one that matches but rarely goes
 * through stand out down the column (0/9).
 */
function WeekBar({ automation }: { automation: Automation }) {
  const { t } = useTranslation("automations");
  if (!automation.week) return <span className="text-sm text-muted">—</span>;
  const { matched, done } = automation.week;
  if (!matched) return <span className="text-sm text-muted">—</span>;
  return <span data-automation-week className="flex items-center gap-2 text-sm text-muted tabular-nums" aria-label={t("column.weekValue", { done, matched })}>
    <span aria-hidden className="h-1 w-11 overflow-hidden rounded-full bg-hover"><span className="block h-full rounded-full bg-ink" style={{ width: `${Math.round(done / matched * 100)}%` }} /></span>
    {done}/{matched}
  </span>;
}

/**
 * The runs of every automation in view, a line each, newest first under each day's counts; above them, the next runs
 * by the clock. A run opens its automation's runs in the window.
 */
function AllRuns() {
  const { t, i18n } = useTranslation("automations");
  const { automations } = useAutomationsInView();
  // Every project's in one read; one project's, each of its automations' own.
  const project = useViewStore(state => state.project);
  const runs = useAllRuns(useMemo(() => project === null ? null : (automations ?? []).map(automation => automation.id), [project, automations]));
  const now = useNow();
  const named = new Map((automations ?? []).map(automation => [automation.id, automation]));
  const upcoming = (automations ?? []).flatMap(automation => {
    const next = automation.enabled ? automation.next.find(at => Date.parse(at) > now) : undefined;
    return next ? [{ automation, at: next }] : [];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const shown = (runs.data ?? []).filter(run => named.has(run.automationId));
  const days = groupByDay(shown, i18n.language);
  return <div data-automation-runs-all>
    {upcoming.length > 0 && <section aria-labelledby="automations-next" className="mb-5 border-b border-rule pb-3">
      <h4 id="automations-next" className="m-0 mb-1.5 text-sm font-semibold">{t("recent.next")}</h4>
      <ul className="m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0 text-sm">{upcoming.map(({ automation, at }) =>
        <li key={automation.id}><span className="tabular-nums">{formatLogTime(at, i18n.language)}</span>{" "}
          <button type="button" className="hover:underline" onClick={() => openAutomation(automation.id)}>
            <span className="text-xs text-muted tabular-nums">{automation.id}</span> {automation.name}</button></li>)}</ul>
    </section>}
    <h4 className="m-0 mb-1 text-sm font-semibold">{t("recent.runs")}</h4>
    {runs.error && !runs.data ? <ReadFailure what={t("runs.failed")} error={runs.error} retry={() => runs.refetch()} />
      : !runs.data || !automations ? <PendingRegion pending shape="reports" />
      : !shown.length ? <Message tone="empty" size="line" title={t("recent.none")} />
      : days.map(day => <DayRuns key={day.day} day={day.day} runs={day.runs} named={named} />)}
  </div>;
}

/** Runs by the day they happened, as the screen writes a day (11/27). */
export function groupByDay(runs: readonly Run[], locale: string) {
  const days: { day: string; runs: Run[] }[] = [];
  for (const run of runs) {
    const day = formatLogDay(run.at, locale);
    if (days.at(-1)?.day !== day) days.push({ day, runs: [] });
    days.at(-1)!.runs.push(run);
  }
  return days;
}

/** One day's runs, with that day's counts: those that ran, those skipped, those that failed. */
function DayRuns({ day, runs, named }: { day: string; runs: Run[]; named: Map<string, Automation> }) {
  const { t } = useTranslation("automations");
  const counts = dayCounts(runs);
  return <section className="mb-2">
    <h5 className="m-0 flex items-baseline gap-3 border-b border-rule py-2 text-sm font-semibold">{day}
      <span className="font-normal text-muted">{[counts.failed ? t("runs.ranFailed", { count: counts.ran, failed: counts.failed }) : t("runs.ran", { count: counts.ran }),
        t("runs.skipped", { count: counts.skipped })].join(t("join"))}</span></h5>
    <ul className="m-0 list-none p-0">{runs.map(run => <AllRunsLine key={`${run.automationId}:${run.number}`} run={run} automation={named.get(run.automationId)!} />)}</ul>
  </section>;
}

function AllRunsLine({ run, automation }: { run: Run; automation: Automation }) {
  const { t } = useTranslation("automations");
  const line = runLine(t, run);
  const failed = run.state === "failed";
  return <li data-automation-run={`${run.automationId}:${run.number}`} className="relative grid grid-cols-[3.5rem_minmax(0,14rem)_4.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-b border-rule py-2 text-sm hover:bg-row-hover narrow:grid-cols-[3rem_minmax(0,1fr)_auto] narrow:py-2.5">
    <span className="tabular-nums">{formatClock(run.at)}</span>
    <button type="button" onClick={() => openAutomation(run.automationId, "log")} className="min-w-0 truncate text-start after:absolute after:inset-0 after:content-['']">
      <span className="text-xs text-muted tabular-nums">{automation.id}</span> {automation.name}</button>
    <span className={cn("text-xs", failed ? "font-semibold text-error" : "text-muted")}>{outcomeWord(t, run)}</span>
    <span className={cn("min-w-0 narrow:col-start-2 narrow:col-end-4", run.state === "skipped" && "text-muted")}>{line}<RunTasks run={run} /></span>
  </li>;
}
