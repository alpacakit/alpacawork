import { OrderTipBody, useOrderWord, useWaitedWord } from "@/features/reader/StartOrder";
import { useViewStore } from "@/state/view-store";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Task } from "@/data/types";
import { useConnection } from "@/data/connection";
import { usePeopleFor, useTaskIndexFor } from "@/data/queries";
import { capitalized, dayClock } from "@/domain/day-clock";
import { finishWords } from "@/domain/finish-words";
import type { PeopleIndex } from "@/domain/people";
import { representedWork, runningRunsSaid, saysRuns, saysStatus, shortLength, workLength } from "@/domain/row-status";
import { subtreeTokens, taskWorkTime, workTimeMs } from "@/domain/usage";
import { finishFactsFor } from "@/features/people/labels";
import { stoppable, turnReasonKey, turnSentence } from "@/features/reader/TurnReason";
import { causeSentence, type ErrorCause } from "@/domain/run-labels";
import { formatNoticeTime } from "@/domain/time";
import { resetMinute } from "@/domain/limits";
import { useNow } from "@/state/clock";
import { useOfflineShown } from "@/data/reach";
import { cn } from "@/lib/utils";

/** Choosing a task from a tip ends that tip before opening the reader. */
function followOrder(close: () => void, id: string) {
  close();
  useViewStore.getState().openReader(id);
}

type T = (key: string, options?: Record<string, unknown>) => string;
const length = (ms: number, t: T) => {
  const { unit, count } = shortLength(ms);
  return unit === "minutes" ? t("tree:status.length.minutes", { count }) : unit === "hours" ? t("tree:status.length.hours", { count })
    : t("tree:status.length.days", { count });
};

/**
 * The row's one time, at the end of its quiet line: while someone runs on it, how long agents have worked on it and
 * on every task under it, added up; else how long the task has been in its state. The working time is in the working
 * colour, as the stopwatch at the row's start whose time it is, so it reads apart from the expected report beside it;
 * any other usual time is quiet. A word that says the task
 * is not simply at work or waiting (queued, unknown state, not running or disconnected) is in ink, so the
 * rows to look at stand out without a colour of their own. Out of reach (`useOfflineShown`, not a subscription
 * still opening), a running task's time stands still at what was last received, in grey: it neither counts minutes it
 * cannot see nor says so on every row (the bar's one mark does).
 */
export function StatusTime({ task }: { task: Task }) {
  const { t } = useTranslation("tree");
  const now = useNow();
  const offline = useOfflineShown();
  // The time a running line ends at offline; online it runs to now, so the feed's arrivals change nothing here.
  const receivedAt = useConnection((state) => offline ? state.lastReceivedAt : null);
  const { status } = task.rowFacts;
  const order = useOrderWord(task);
  if (!saysRuns(task)) return null;
  // A task that waits for others to finish says which, in place of "Queued" (or of nothing, before it is asked to
  // work); a Run running, here or below it, an unclear state or a stop's time keep their place. Its press lists them by title.
  if (order && !representedWork(task) && (!status || status.kind === "queued")) return <TimeTip data={{ "data-row-status": "order" }} shown={order.shown} heading={t("reader:order.tip")}
    long={order.shown} body={close => <OrderTipBody items={order.items} onFollow={id => followOrder(close, id)} />} className="text-ink" />;
  if (representedWork(task) || status?.kind === "running") return <WorkTime task={task} at={offline ? receivedAt ?? null : undefined} />;
  if (!status || !saysStatus(task, status.kind)) return null;
  const [shown, long, quiet] = (() => {
    switch (status.kind) {
      case "queued": {
        const shown = t("status.queued");
        return [shown, shown, false];
      }
      case "unclear": {
        const shown = warningWord(task.rowFacts.warning, t);
        return [shown, shown, false];
      }
      case "since": {
        const shown = length(now - status.at, t);
        return [shown, t(task.rowFacts.kind?.kind === "stopped" || task.rowFacts.kind?.kind === "followup"
          ? "status.long.reason" : "status.long.since", { length: shown }), true];
      }
    }
  })();
  return <TimeTip data={{ "data-row-status": status.kind }} shown={shown} heading={status.kind === "since" ? t("status.tip.elapsed") : null}
    long={long} className={quiet ? "text-muted" : "text-ink"} />;
}

/**
 * How many Runs run now on a Working row and under it, a square and its number just before the row's working time, in
 * grey: the time beside it is the one word of the row in the working colour. The server counts them, so a child no page
 * has loaded counts too. Out of reach it is what was last received. A reader hears it in words.
 */
export function RunningRuns({ task }: { task: Task }) {
  const { t } = useTranslation("tree");
  const count = runningRunsSaid(task);
  if (!count) return null;
  return <span data-row-running-runs={count} className="flex-none whitespace-nowrap tabular-nums text-muted">
    <span aria-hidden="true"><Icon name="runningRuns" className="mr-0.5 inline size-[0.7em] align-[-0.02em]" />{count}</span>
    <span className="sr-only">{t("status.runningRuns", { count })}</span>
  </span>;
}

/**
 * A running row's time, how long agents have worked on the task and the tasks under it, every Run of a responsible
 * or a worker counted whole (two at once count twice: it is what the work cost). Its press says the same total and the task's
 * own part. The walk under the task follows the data (domain/usage taskWorkTime), and the clock only adds the running Runs'
 * time to it, so a tick never walks the tree. Before any Run has started there is no time yet, and the row says it runs.
 */
/** `at`: out of reach, the time the work time stands at (the last receipt), or null when nothing was received. */
function WorkTime({ task, at }: { task: Task; at?: number | null }) {
  const { t } = useTranslation("tree");
  const index = useTaskIndexFor(task.id);
  const people = usePeopleFor(task.id, true);
  const times = useMemo(() => taskWorkTime(task.id, index, people.runsByTask), [task.id, index, people]);
  const ticking = useNow(), now = at ?? ticking, still = at !== undefined;
  const data = { "data-row-status": "running" } as const;
  if ((!times.subtree.doneMs && !times.subtree.runningSince.length) || at === null) {
    const empty = representedWork(task) ?? "running";
    const shown = t(`status.${empty}`);
    return <TimeTip data={{ "data-row-status": empty }} shown={shown} heading={null} long={shown} className={empty === "queued" && !still ? "text-ink" : "text-muted"} />;
  }
  const subtree = workTimeMs(times.subtree, now), own = workTimeMs(times.own, now);
  const parts = [{ key: "subtree", label: t("status.work.subtree"), value: workWords(subtree, t) },
    { key: "own", label: t("status.work.own"), value: workWords(own, t) }];
  return <TimeTip data={data} shown={workShort(subtree, t)} heading={t("status.work.heading")}
    long={parts.map(part => `${part.label} ${part.value}`).join(t("status.work.separator"))}
    body={<>
      <dl className="m-0 mt-2 grid grid-cols-[auto_auto] gap-x-5 gap-y-1">{parts.map(part => <div key={part.key} data-work-time={part.key} className="contents">
        <dt className="text-muted">{part.label}</dt><dd className="m-0 text-right font-medium tabular-nums">{part.value}</dd></div>)}</dl>
      <TokenLines task={task} />
    </>}
    className={still ? "text-muted" : "text-working"} />;
}

/**
 * The tokens the finished Runs used, on this task and under it: input and output first, the cache's reads and writes
 * after and quieter (reads run to many times the rest and would read as the cost). Runs still going count once they end.
 */
function TokenLines({ task }: { task: Task }) {
  const { t, i18n } = useTranslation("tree");
  const { tokens, unknown } = subtreeTokens(task.usage, task.usageBelow);
  if (!tokens) return null;
  const count = new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 });
  const rows = (keys: readonly (keyof typeof tokens)[], quiet = false) =>
    <dl className={cn("m-0 mt-1 grid grid-cols-[auto_auto] gap-x-5 gap-y-1", quiet && "text-muted")}>{keys.map(key =>
      <div key={key} data-work-token={key} className="contents">
        <dt className={quiet ? undefined : "text-muted"}>{t(`status.tokens.${key}`)}</dt>
        <dd className={cn("m-0 text-right tabular-nums", !quiet && "font-medium")}>{count.format(tokens[key])}</dd></div>)}</dl>;
  return <section data-work-tokens className="mt-3 border-t border-line pt-2">
    <p className="m-0 text-xs font-medium text-muted">{t("status.tokens.heading")}</p>
    {rows(["input", "output"])}
    <p className="m-0 mt-2 text-xs text-muted">{t("status.tokens.cache")}</p>
    {rows(["cacheRead", "cacheWrite"], true)}
    <p className="m-0 mt-2 text-xs text-muted">{t("status.tokens.scope")}</p>
    {unknown > 0 && <p className="m-0 text-xs text-muted">{t("status.tokens.unknown", { count: unknown })}</p>}
  </section>;
}

/** Work time as the row says it: minutes, then whole hours. It is an amount of work, not a span of the calendar, so it never turns into days. */
function workShort(ms: number, t: T) {
  const { unit, count } = workLength(ms);
  return unit === "minutes" ? t("tree:status.length.minutes", { count }) : t("tree:status.length.hours", { count });
}

/** The same in its press: hours and minutes, the minutes in two digits so the two lines' figures line up under each other. */
function workWords(ms: number, t: T) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  return minutes < 60 ? t("tree:status.work.minutes", { count: Math.max(1, minutes) })
    : t("tree:status.work.hours", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
}

/**
 * A row's time said short ("6m", a flag and "14:30"); a press, Enter or Space opens what it means in words, as the reader
 * says it. It is its own press, over the row's (z-1, never inside it), so it never opens the task too, and its hit area
 * reaches past its words (before:), up to the row's top and 1px under them, never into the title's line, so a press on
 * the title, even at its top edge, opens the task (e2e/row-time-tip.check.ts). While it is open a press anywhere else only closes it (modal), as do Esc, Back
 * (Popover, with the page's step, as every surface open for a moment), a turn of the wheel and a swipe.
 */
function TimeTip({ shown, mark, heading, long, body, className, data }: {
  shown: string;
  /** What the open tip shows under its heading when it is more than its long words (the work time's two lines); `long` still names the press. */
  body?: ReactNode | ((close: () => void) => ReactNode);
  /** What says the kind of time before its words (the expected report's flag), part of the press. */
  mark?: ReactNode;
  /** What the time is ("Elapsed", "Expected report"), over its words; none for a word that says itself. */
  heading: string | null;
  long: string; className?: string; data: Record<`data-${string}`, string>;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // A touch press outside closes it on its click (Radix), which a swipe never sends: the swipe closes it as it moves.
    for (const type of ["wheel", "touchmove"]) window.addEventListener(type, close, { passive: true });
    return () => { for (const type of ["wheel", "touchmove"]) window.removeEventListener(type, close); };
  }, [open]);
  // A word its long words only repeat ("Queued") has nothing to open.
  if (!heading && long === shown) return <span {...data} className={cn("flex-none whitespace-nowrap tabular-nums", className)}>{shown}</span>;
  return <Popover open={open} onOpenChange={setOpen} modal>
    <PopoverTrigger {...data} aria-label={heading ? `${heading}: ${long}` : long}
      className={cn("relative z-1 flex-none cursor-pointer rounded-sm whitespace-nowrap tabular-nums decoration-dotted underline-offset-3 outline-none",
        "before:absolute before:-inset-x-1 before:-top-2 before:-bottom-px before:content-[''] hover:underline focus-visible:ring-2 focus-visible:ring-ink/40 data-[state=open]:underline",
        className)}>
      {mark}{shown}
    </PopoverTrigger>
    <PopoverContent data-time-tip align="end" side="bottom" className="w-auto max-w-72 px-3 py-2 text-sm">
      {heading && <p className="text-xs font-medium text-muted">{heading}</p>}
      {typeof body === "function" ? body(() => setOpen(false)) : body ?? <p>{long}</p>}
    </PopoverContent>
  </Popover>;
}

/** A warning beside the time, in ink, unless the status already says it. Cut before the title. */
export function StatusNotes({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation("tree");
  const { status, warning } = task.rowFacts;
  return warning && status?.kind !== "unclear"
    ? <span data-row-note className={cn("min-w-0 truncate whitespace-nowrap text-ink", className)}>{warningWord(warning, t)}</span>
    : null;
}

/**
 * When a task at work is expected to report, in a phone row's quiet line before its one time, as short as a time can be
 * said after a flag: "14:30" (by about then), "14:30+" (not before), "14:30 over" in ink once it has passed, or "?" while
 * the estimate waits for an update; nothing on an Awaiting review row (saysRuns, as the time view's band) or with no time.
 * Its press says it in the reader's words. The facts are the reader's and the band's (finishFactsFor), so a past estimate is
 * never said as ahead.
 */
export function ReportTime({ task, people, className }: { task: Task; people: PeopleIndex; className?: string }) {
  return saysRuns(task) ? <ReportWords task={task} people={people} className={className} /> : null;
}

/** Its own component, so only a row that may say a time follows the clock and walks the tasks under it. */
function ReportWords({ task, people, className }: { task: Task; people: PeopleIndex; className?: string }) {
  const { t } = useTranslation("tree");
  const { t: pt, i18n } = useTranslation("people");
  const index = useTaskIndexFor(task.id);
  const now = useNow();
  const facts = finishFactsFor(task.id, index, people, now);
  if (facts?.kind !== "estimate" && facts?.kind !== "subtree" && facts?.kind !== "pending") return null;
  const words = finishWords(facts, now, pt, i18n.language);
  const time = words.at === null ? "" : dayClock(words.at, now, pt, i18n.language);
  // Shown alone (or leading "{{time}}+"), the time starts with a capital: "Tomorrow 01:20".
  const label = capitalized(time);
  const over = words.tone === "late";
  const shown = facts.kind === "pending" ? t("status.report.pending.short")
    : over ? t("status.report.over", { time })
    : facts.kind === "subtree" && facts.open ? t("status.report.after", { time: label })
    : label;
  const long = facts.kind === "pending" ? t("status.report.pending.long") : words.long;
  return <TimeTip data={{ "data-row-report": over ? "over" : facts.kind }} shown={shown} heading={t("status.tip.report")} long={long}
    mark={<Icon name="flag" className="mr-0.5 inline size-3.5 align-[-0.15em]" />} className={cn(over ? "text-ink" : "text-muted", className)} />;
}

/**
 * On a row other tasks wait for, which ones, before its state notes; its press lists them by
 * title. Every section says it, the review's too: it is why finishing this row matters now.
 */
export function WaitedNote({ task, className }: { task: Task; className?: string }) {
  const { t } = useTranslation("tree");
  const waited = useWaitedWord(task);
  if (!waited) return null;
  // It gives way, cut with "…", before the title and the times do: it is a reason to look, not the row's name.
  return <span className={cn("min-w-0 shrink-[50] overflow-hidden text-ellipsis whitespace-nowrap", className)}>
    <TimeTip data={{ "data-row-waited": "" }} shown={waited.shown} heading={t("reader:order.waitedTip")} long={waited.shown}
      body={close => <OrderTipBody items={waited.items} onFollow={id => followOrder(close, id)} />} className="inline text-ink" />
  </span>;
}

/** A computer's one-line row's end, in the phone's quiet line's order: the children's count, what is so of its state, its one time. */
export function RowEnd({ task, childCount, id, className }: { task: Task; childCount: string | null; id?: string; className?: string }) {
  return <span id={id} data-row-end className={cn("flex min-w-0 shrink items-baseline gap-1.5 text-xs", className)}>
    {task.homeRow?.section === "error" && <RowKindWord task={task} />}
    {childCount && <RowChildren childCount={childCount} word={task.homeRow?.section === "error"} />}
    <WaitedNote task={task} />
    <StatusNotes task={task} />
    <RunningRuns task={task} />
    <StatusTime task={task} />
  </span>;
}

function RowChildren({ childCount, word }: { childCount: string; word: boolean }) {
  const { t } = useTranslation("tree");
  return <span data-row-progress className="flex-none tabular-nums text-muted">{word ? t("status.children", { progress: childCount }) : childCount}</span>;
}

/**
 * The kind of what waits on the reader, or why it stopped, in a word (the group's heading says that it waits); a turn's
 * reason is said in full on hover (its title) and in the reader. It gives way with "…" before the times at the line's end
 * do, and only after the counts and notes beside it have: its weight is so small that it gives up nothing while they can.
 * The line's weights still add up to at least one (the strut before the times), so once they are gone it does give way.
 */
export function RowKindWord({ task }: { task: Task }) {
  const { t } = useTranslation("tree");
  const { t: ut } = useTranslation("ui");
  const kind = task.rowFacts.kind;
  if (!kind) return null;
  if (kind.kind === "stopped" && kind.errorCause) return <CauseWord cause={kind.errorCause} />;
  const [word, long] = (() => {
    switch (kind.kind) {
      case "question": return [ut("turn.question")];
      case "review": return [t("row.review")];
      case "followup": return [t(`status.turn.${turnReasonKey(kind.turn)}`), turnSentence(kind.turn, ut, null, stoppable(task))];
      case "stopped": return [failureWord(kind.failure, t)];
    }
  })();
  return <span data-row-kind={kind.kind} title={long} className="min-w-0 shrink-[0.0001] truncate">{word}</span>;
}

/** A stopped run's recognized cause (a usage limit, a busy model) by its name; hover says it in full, with when a limit lifts. */
function CauseWord({ cause }: { cause: ErrorCause }) {
  const { t, i18n } = useTranslation("ui");
  const now = useNow();
  const name = t(`tree:status.cause.${CAUSE_WORD[cause.cause]}`);
  // A limit still in force says when it lifts, shortly ("11/29 10:00"), so the list alone tells whether to wait. The
  // name gives way with "…" on a narrow row; the time does not, as it is what the row is read for.
  const at = cause.resetsAt ? resetMinute(cause.resetsAt) : NaN;
  const until = at > now ? formatNoticeTime(new Date(at).toISOString(), i18n.language, new Date(now)) : null;
  return <span data-row-kind="stopped" data-row-cause={cause.cause} title={causeSentence(cause, t, now, i18n.language)}
    className="flex min-w-0 shrink-[0.0001] items-baseline gap-x-1">
    <span className="min-w-0 truncate">{name}</span>
    {until && <span data-row-until className="flex-none whitespace-nowrap">{t("tree:status.causeUntil", { when: until })}</span>}
  </span>;
}
const CAUSE_WORD: Record<ErrorCause["cause"], string> = { model_capacity: "modelCapacity", weekly_limit: "weeklyLimit", session_limit: "sessionLimit", model_limit: "modelLimit" };

/** A stopped run's reason in a word or two; the reader's history says it in full. */
function failureWord(failure: string, t: T): string {
  switch (failure) {
    case "conversation_busy": return t("tree:status.failure.conversationBusy");
    case "exit": return t("tree:status.failure.exit");
    case "launch": return t("tree:status.failure.launch");
    case "manager_lost": return t("tree:status.failure.managerLost");
    case "output": return t("tree:status.failure.output");
    case "no_report": return t("tree:status.failure.noReport");
    case "stopped": return t("tree:status.failure.stopped");
    case "timeout": return t("tree:status.failure.timeout");
    default: return t("tree:status.failure.unknown");
  }
}

function warningWord(warning: Task['rowFacts']['warning'], t: T): string {
  return warning === null || warning === 'unknown' ? t('tree:status.unclear') : failureWord(warning, t);
}
