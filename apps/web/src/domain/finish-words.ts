import type { Tone } from "@/components/ui/tone";
import { isFinished } from "@alpacawork/contract/branch";
import type { HomeSection } from "@alpacawork/contract";
import type { TaskState } from "@/data/types";
import type { TaskEstimate } from "./estimate";
import { dayClock, roundEnd } from "./day-clock";
import { calendarDayOffset, formatClock } from "./time";
import { childrenOf, type TaskIndex } from "./tasks";

/**
 * When a task reports, said one way ("Expected report" form) on the card, the list's time view, the
 * reader's estimate and History. Words come from `people:finish.*`.
 */
export type FinishFacts =
  | { kind: "estimate"; estimate: TaskEstimate } | { kind: "unknown"; working: boolean } | { kind: "pending" }
  | { kind: "reported"; at: number | null; turn: boolean } | { kind: "stopped" } | { kind: "done"; at: number }
  | { kind: "subtree"; at: number; count: number; open: number };
/** Said quietly, as your turn (a report waits for your review), past its estimate, or stopped by an error. */
type FinishTone = Extract<Tone, "quiet" | "turn" | "late" | "error">;
/**
 * `at` is the time the words name; `ends` marks a projected report time, which the time view draws a way to. `brief` says
 * it in a time's width, for the time view's future band: the time alone, or how far past it is, or that it is a "not
 * before" time; never the state, which the row's icon already says. Its clock names no day ("00:55", not "tomorrow 00:55"):
 * `briefDays` is how many days from today that clock is, which the band marks small beside it ("+1").
 */
export type FinishWords = { short: string; long: string; tone: FinishTone; at: number | null; ends: boolean; brief: string; briefDays: number };
type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * The expected report as it is shown: rounded up to five minutes. It is an estimate, so it is said
 * no finer than five minutes and never earlier than the work clock says; the same clock time is then
 * named when it has passed, with how far past it is, so "Expected report 15:40" becomes "15:40, about 5 minutes overdue" (about as wide as
 * before, so no line grows) and not another time; the long words say it is the estimate that was passed.
 */
const expectedReport = (estimate: TaskEstimate, now: number) => roundEnd(now + estimate.remainingMinutes * 60_000);

/** How far past an estimate it is, as roughly as the estimate is said: five minutes, then hours, then days. */
function overAmount(at: number, now: number): { unit: "minutes" | "hours" | "days"; count: number } {
  const minutes = (now - at) / 60_000;
  if (minutes < 57.5) return { unit: "minutes", count: Math.max(5, Math.round(minutes / 5) * 5) };
  if (minutes < 23.5 * 60) return { unit: "hours", count: Math.round(minutes / 60) };
  return { unit: "days", count: Math.round(minutes / (24 * 60)) };
}

/** The same, in the "about N minutes" words. */
function overBy(at: number, now: number, t: T): string {
  const { unit, count } = overAmount(at, now);
  return unit === "minutes" ? t("finish.overBy.minutes", { count }) : unit === "hours" ? t("finish.overBy.hours", { count })
    : t("finish.overBy.days", { count });
}

/**
 * Whether a task's end is its agents' to say: it is at work, or not started (the responsible above starts it), by its
 * position (the server's taskPosition), whatever any one placement's Run says. Any other task (awaiting review or an
 * answer, an error to handle, held, idle) waits on the user to go on, so it says no report time of its own and adds none to
 * the tasks above it.
 */
export const countsEstimate = (position: HomeSection | null) => position === "doing" || position === "todo";

/**
 * What is known about a task's end, from its state, position and records. A task whose end is its agents'
 * (countsEstimate) says its estimate, or that it has none; a member's Run that needs attention does not stop it. Any other
 * unfinished task says only its review or a stop, else nothing (null), and is a wait in the tasks above it.
 */
export function finishFacts({ state, position, interrupted, working, estimate, since, turn = false }: {
  state: TaskState; position: HomeSection | null; interrupted: boolean; working: boolean; estimate: TaskEstimate | null;
  since: number | null; turn?: boolean;
}): FinishFacts | null {
  if (state === "done") return since === null ? null : { kind: "done", at: since };
  if (countsEstimate(position)) {
    if (!estimate) return { kind: "unknown", working };
    return estimate.pending ? { kind: "pending" } : { kind: "estimate", estimate };
  }
  if (interrupted) return { kind: "stopped" };
  if (state === "waiting") return { kind: "reported", at: since, turn };
  return null;
}

/** A task the user lets go on, by its facts (finishFacts): no estimate above it covers it, at any depth. */
const waitsOnUser = (facts: FinishFacts | null): facts is Extract<FinishFacts, { kind: "reported" | "stopped" }> | null =>
  facts === null || facts.kind === "reported" || facts.kind === "stopped";

/**
 * Says nothing of a task's end beyond what the tasks under it say: its end is its agents', but it has no estimate and
 * nobody placed on it works on its own.
 */
const defers = (facts: FinishFacts) => facts.kind === "unknown" && !facts.working;

/**
 * When a task reports, from its own facts (`factsOf`, finishFacts) and those of the unfinished tasks under it. A task that
 * waits on the user, or is done, speaks for itself (its review, stop or end) or says nothing. Otherwise every unfinished
 * task, itself included, is one of three: an estimate, counted as a time; a wait on the user, an end left unsaid; or one
 * whose end is its agents' without an estimate, an end left unsaid unless an estimate above it covers it, and said by the
 * tasks under it when nobody works on it and some are unfinished. It says the latest time: past only once that latest one
 * has passed too, else "not before" while an end is left unsaid (`open`, how many are). With no time under it, it says
 * only that its own estimate waits for an update; its working or waiting state is its icon's.
 */
export function finishOf(id: string, { index, factsOf, now }: {
  index: TaskIndex; factsOf: (id: string) => FinishFacts | null; now: number;
}): FinishFacts | null {
  const own = factsOf(id);
  // Nothing unfinished is under a finished task (the finished-branch rule).
  if (waitsOnUser(own) || own.kind === "done") return own;
  const unfinished = (taskId: string) => childrenOf(taskId, index).filter(kid => !isFinished(kid.state));
  const kids = unfinished(id);
  if (!kids.length) return own;
  // The expected report times, and the ends left unsaid; they are gathered apart, so a time never hides an unsaid end.
  let count = 0, latest: number | undefined, open = 0;
  // An invalid time is counted but names no time.
  const addEnd = (at: number) => { count++; if (at > (latest ?? -Infinity)) latest = at; };
  /** One task's end; `covered` while an estimate above it speaks for its work. Every task is walked so every estimate counts. */
  const visit = (facts: FinishFacts | null, below: { id: string }[], covered: boolean) => {
    if (facts?.kind === "estimate") addEnd(expectedReport(facts.estimate, now));
    else if (waitsOnUser(facts)) open++;
    else if (!covered && !(defers(facts) && below.length)) open++;
    for (const kid of below) visit(factsOf(kid.id), unfinished(kid.id), covered || facts?.kind === "estimate");
  };
  visit(own, kids, false);
  if (latest === undefined) return own.kind === "pending" ? own : null;
  if (latest <= now) return { kind: "subtree", at: latest, count, open: 0 };
  return { kind: "subtree", at: latest, count, open };
}

export function finishWords(facts: FinishFacts, now: number, t: T, locale: string): FinishWords {
  const clock = (at: number) => dayClock(at, now, t, locale);
  const bare = (at: number) => formatClock(new Date(at).toISOString());
  const said = (short: string, tone: FinishTone = "quiet", at: number | null = null, long = short, ends = false,
    brief = at === null ? short : bare(at), briefDays = at === null ? 0 : calendarDayOffset(at, now)) =>
    ({ short, long, tone, at, ends, brief, briefDays });
  const bandOver = (at: number) => t("finish.bandOver", { length: overBy(at, now, t) });
  switch (facts.kind) {
    case "done": return said(t("finish.done", { time: clock(facts.at) }), "quiet", facts.at);
    case "stopped": return said(t("finish.stopped"), "error");
    case "reported": return facts.at === null ? said(t("finish.review"), facts.turn ? "turn" : "quiet") : said(t("finish.reported", { time: clock(facts.at) }), facts.turn ? "turn" : "quiet", facts.at);
    case "unknown": return said(t("finish.unknown"));
    case "pending": return said(t("finish.pending"));
    case "subtree": {
      const time = clock(facts.at), after = t("finish.after", { time }), afterBrief = t("finish.after", { time: bare(facts.at) });
      return facts.at <= now
        ? said(t("finish.over", { time, length: overBy(facts.at, now, t) }), "late", facts.at,
          t("finish.long.subtreeOver", { time, length: overBy(facts.at, now, t) }), false, bandOver(facts.at), 0)
        // "Not before" is no expected report, so the time view draws no end for it.
        : facts.open ? said(after, "quiet", facts.at, t("finish.long.after", { count: facts.open, time }), false, afterBrief)
        : said(t("finish.end", { time }), "quiet", facts.at, t("finish.long.subtree", { count: facts.count, time }), true);
    }
    case "estimate": {
      const at = expectedReport(facts.estimate, now);
      const minutes = { total: facts.estimate.minutes, used: Math.floor(facts.estimate.usedMinutes), time: clock(at), length: overBy(at, now, t) };
      return at <= now ? said(t("finish.over", minutes), "late", at, t("finish.long.over", minutes), false, bandOver(at), 0)
        : said(t("finish.end", { time: clock(at) }), "quiet", at, t("finish.long.end", minutes), true);
    }
  }
}
