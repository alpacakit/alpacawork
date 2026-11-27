import { automationEventKindSchema, automationEventSource, automationEvents } from "@alpacawork/contract/automation-program";
import type { TFunction } from "i18next";
import { clockText, dayFrom, scheduleShape } from "@/domain/automations";
import { launchName } from "@/domain/agent-label";
import { formatClock, formatLogTime } from "@/domain/time";
import type { Facts, Operation, Run } from "./shape";

/**
 * An automation said in the screen's words, made here from the facts the server took from its `config` and from its
 * runs: the AI that wrote the program writes none of these lines, so what the person reads of when it runs and what it
 * may use is what will be held to. Only what each function does is the AI's own words (its JSDoc).
 */
type T = TFunction<"automations">;
/** The same words by a key made at run time (i18next.config.ts keeps these keys). */
const say = (t: T, key: string, options?: Record<string, unknown>): string => (t as unknown as (key: string, options?: Record<string, unknown>) => string)(key, options);

/** The screen's own time zone: a schedule kept in another one says which. */
const screenZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** When a schedule runs: "Every day 9:00", "Weekdays 9:00", "Every 30 minutes"… */
export function scheduleText(t: T, cron: string, timezone: string): string {
  const shape = scheduleShape(cron);
  const times = "times" in shape ? shape.times.map(clockText).join(t("schedule.timesJoin")) : "";
  const text = shape.kind === "weekly" ? t("schedule.weekly", { days: shape.days.map(day => say(t, `weekday.${day}`)).join(t("schedule.daysJoin")), times })
    : shape.kind === "monthly" ? t("schedule.monthly", { day: shape.day, times })
    : shape.kind === "everyMinutes" ? t("schedule.everyMinutes", { count: shape.minutes })
    : shape.kind === "hourly" ? t("schedule.hourly", { minute: shape.minute })
    : shape.kind === "everyHours" ? t("schedule.everyHours", { count: shape.hours, minute: String(shape.minute).padStart(2, "0") })
    // A schedule of no shape the screen has words for is said by the cron it keeps, so two of them can be compared.
    : say(t, `schedule.${shape.kind}`, { times, cron: cron.trim() });
  return timezone === screenZone() ? text : t("schedule.zone", { text, zone: timezone });
}

/** The kinds of the PC's pressure, in the screen's words: "CPU・memory". */
export function pressureText(t: T, kinds: readonly string[]): string {
  return kinds.map(kind => say(t, `pressure.${kind}`)).join(t("pressure.join"));
}

const listOf = (value: unknown): string[] => typeof value === "string" ? [value] : Array.isArray(value) ? value.filter(item => typeof item === "string") : [];

/**
 * When it runs, as one sentence, from the kind of event and how `config` narrows it (`hook`: it has a receiving point):
 * its schedule, a task's state changing, words arriving on a task, a signal, or the PC's pressure.
 */
export function whenText(t: T, when: Facts["when"], timezone: string): string {
  const { where, textKey } = when;
  const kind = automationEventKindSchema.safeParse(when.event);
  if (!kind.success) return t("trigger.other", { event: when.event });
  const format = automationEvents[kind.data].textFormat;
  const join = t("trigger.or");
  switch (format) {
    case "schedule":
      return say(t, textKey, { text: scheduleText(t, typeof where.cron === "string" ? where.cron : "", timezone) });
    case "pressure":
      return say(t, textKey, { kinds: pressureText(t, listOf(where.kinds)) });
    case "state": {
      const to = listOf(where.to).map(state => say(t, `event.${state}`)).join(join);
      const from = listOf(where.from).map(state => say(t, `event.${state}`)).join(join);
      const text = from ? say(t, `${textKey}FromTo`, { from, to }) : say(t, textKey, { to });
      const skills = listOf(where.skills);
      return skills.length ? t("trigger.withSkills", { text, skills: skills.length === 1
        ? t("trigger.usedOne", { skill: skills[0] }) : t("trigger.usedAny", { skills: skills.join(join) }) }) : text;
    }
    case "message": {
      const by = where.by === "ai" ? "ai" : "human";
      const types = listOf(where.type);
      if (types.length === 1) return say(t, `${textKey}.${by}.${types[0]}`);
      const who = say(t, `trigger.who.${by}`);
      return types.length ? say(t, `${textKey}.many`, { who, kinds: types.map(type => say(t, `trigger.kind.${type}`)).join(join) })
        : say(t, `${textKey}.any`, { who });
    }
    default: return say(t, textKey);
  }
}

/** What narrows it further, a line under it: only tasks I asked for; only words that hold a text; how a signal comes. */
export function whenNotes(t: T, when: Facts["when"], hook: boolean): string[] {
  const where = when.where;
  if (automationEventSource(when.event) === "signal") return [hook ? t("trigger.viaHook") : t("trigger.viaCli")];
  return [where.userRequestedOnly === true ? t("trigger.mine") : null,
    typeof where.contains === "string" ? t("trigger.contains", { text: where.contains }) : null,
    where.includeAutomated === true ? t("trigger.includeAutomated") : null].filter(line => line !== null);
}

/** The next run, in the screen's own time: "Next: tomorrow 9:00". */
export function nextText(t: T, next: string, now: Date, locale: string): string {
  const day = dayFrom(new Date(next), now);
  if (day !== "other") return say(t, `next.${day}`, { time: formatClock(next) });
  return t("next.other", { date: formatLogTime(next, locale) });
}

/** A span of minutes: "30 minutes", "2 hours", "1 hour 30 minutes". */
function minutesText(t: T, minutes: number): string {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (!hours) return t("duration.minutes", { count: rest });
  return rest ? t("duration.hoursMinutes", { hours, minutes: rest }) : t("duration.hours", { count: hours });
}

/**
 * The limits as one line: "Up to 10 a day · waits for the previous run". A signal waits for the previous run (signals
 * that come meanwhile run once together); anything else is skipped while the previous run's task goes on.
 */
export function limitsText(t: T, limits: Facts["limits"], event: string): string {
  const kind = automationEventKindSchema.safeParse(event);
  return [t("limits.perDay", { count: limits.perDay }),
    limits.cooldownMinutes ? t("limits.cooldown", { span: minutesText(t, limits.cooldownMinutes) }) : null,
    !limits.waitForPrevious ? null : kind.success && automationEvents[kind.data].coalesce ? t("limits.waitsForPrevious") : t("limits.waitForPrevious"),
    limits.until ? t("limits.until", { date: limits.until }) : null]
    .filter(Boolean).join(t("join"));
}

/** An AI row as the input names a model: its model and effort (`haiku(low)`). */
const aiName = (row: Facts["ai"][number]) => launchName(row.agent, { model: row.model, ...row.effort ? { effort: row.effort } : {} }).full;

/**
 * The AI it may use, as one line: what it asks in short ("judges with haiku(low), up to 20 a day") and whom it gives a
 * task to ("asks gpt-6.2-sol(medium)"). Nothing when it uses none.
 */
export function aiText(t: T, facts: Facts): string {
  if (!facts.ai.length) return t("ai.none");
  // Which is asked in short and which is given a task, where the server says it; else each by its name in the program.
  return facts.ai.map(row => row.use === "ask" ? t("ai.ask", { ai: aiName(row), count: facts.limits.aiCallsPerDay })
    : row.use === "task" ? t("ai.task", { ai: aiName(row) }) : t("ai.named", { name: row.name, ai: aiName(row) })).join(t("join"));
}

/** What a run of it costs, as far as the last 7 days say: per short question, and that a task's cost is its own. */
export function aiCostText(t: T, facts: Facts): string | null {
  if (!facts.ai.length) return null;
  const asks = facts.ai.filter(row => row.use !== "task"), tasks = facts.ai.some(row => row.use !== "ask");
  if (!asks.length) return t("ai.costTask");
  const cost = asks.map(row => row.costHint?.perCallUsd).find(value => value !== undefined);
  // No estimate: said only where the AI rows' use is known (else it is unknown whether any is asked in short).
  if (cost === undefined) return asks.every(row => row.use === "ask") ? t("ai.costNone") : null;
  return [t("ai.costAsk", { usd: usd(cost) }), tasks ? t("ai.costTaskApart") : null].filter(Boolean).join(t("sentence"));
}

/** A sum in US dollars, as short as it reads: $0.0002, $0.12, $3. */
export const usd = (value: number) => value >= 1 ? value.toFixed(2).replace(/\.00$/, "") : value >= 0.01 ? value.toFixed(2) : value.toPrecision(1);

/** Where it may reach out of this PC, and how many tasks one run may make: "Sends to hooks.slack.com · up to 1 task a run". */
export function outsideText(t: T, facts: Facts): string {
  const hosts = facts.outside.map(destination => destination.host ?? t("outside.notEntered", { name: destination.name }));
  // A program that reaches the network itself does so whatever it names to send to: said beside it.
  const reaches = !!facts.directNetwork;
  return [hosts.length ? t("outside.sends", { hosts: hosts.join(t("trigger.or")) }) : reaches ? null : t("outside.none"),
    reaches ? t("outside.direct") : null,
    facts.limits.tasksPerRun ? t("outside.tasks", { count: facts.limits.tasksPerRun }) : t("outside.noTasks")].filter(Boolean).join(t("join"));
}

/** A run's outcome in a word: asked (made a task for an AI), done, failed, skipped, running (where), stopped. */
export function outcomeWord(t: T, run: Pick<Run, "state" | "phase" | "tasks">): string {
  if (run.state === "done") return run.tasks.length ? t("runs.state.asked") : t("runs.state.done");
  if (run.state === "running" && run.phase) return say(t, `phase.${run.phase}`);
  return say(t, `runs.state.${run.state}`);
}

/**
 * A run's line, after its outcome word: what `run` reported it did, why it was skipped (what `trigger` said, or the
 * limit it met), or why it failed. Null when there is nothing more to say (waiting, running).
 */
export function runLine(t: T, run: Pick<Run, "state" | "summary" | "trigger" | "reasonKind" | "reasonText" | "error" | "folded">): string | null {
  const folded = run.folded ? t("runs.folded", { count: run.folded + 1 }) : "";
  if (run.state === "done" || run.state === "stopped" && run.summary) return run.summary;
  if (run.state === "skipped") {
    const why = run.trigger && !run.trigger.run ? t("runs.rejected", { reason: run.trigger.reason }) : reasonText(t, run);
    return why && `${why}${folded}`;
  }
  if (run.state === "failed" || run.state === "stopped") return reasonText(t, run);
  return null;
}

/** Why a run did not go through, in words the screen has for the server's kind, else the server's own sentence. */
export function reasonText(t: T, run: Pick<Run, "reasonKind" | "reasonText"> & { error?: Run["error"] }): string | null {
  // That the program failed says nothing a person can act on: what it wrote itself says why (the server keeps it as
  // the run's reason); a failure the server names (the AI unavailable, the time limit) is said in the screen's words.
  if (run.reasonKind && GENERAL_FAILURES.has(run.reasonKind)) return run.error?.message || run.reasonText || t("runs.reason.other");
  const code = run.error?.code;
  return (run.reasonKind && reasonWords(t, run.reasonKind)) || (code && reasonWords(t, code)) || run.reasonText || run.error?.message || (run.reasonKind ? t("runs.reason.other") : null);
}
const GENERAL_FAILURES = new Set(["program_failed", "error", "failed"]);

/** The screen's words for a server's reason kind: `limit:tasks.create` says the operation whose limit it met. */
export function reasonWords(t: T, kind: string): string | null {
  if (kind === "limit:ai.ask") return t("runs.reason.limitAsk");
  if (kind === "limit:tasks.create") return t("runs.reason.limitTasks");
  if (kind.startsWith("limit:")) return t("runs.reason.limit", { name: kind.slice("limit:".length) });
  return knownWords(t, `runs.reason.${kind}`);
}

/** The screen's words for a key made from a server's kind, or null when it has none (a kind newer than the screen). */
export function knownWords(t: T, key: string): string | null {
  const words = say(t, key);
  return words && words !== key && !words.endsWith(key) ? words : null;
}

/** One day's runs counted: how many its event matched, how many went on to `run`, how many were skipped. */
export function dayCounts(runs: readonly Pick<Run, "state" | "kind" | "folded">[]): { matched: number; ran: number; skipped: number; failed: number } {
  const real = runs.filter(run => run.kind === "real");
  const weight = (run: Pick<Run, "folded">) => 1 + (run.folded ?? 0);
  const count = (states: readonly Run["state"][]) => real.filter(run => states.includes(run.state)).reduce((sum, run) => sum + weight(run), 0);
  return { matched: count(["done", "failed", "running", "stopped", "skipped", "waiting"]), ran: count(["done", "failed", "running", "stopped"]),
    skipped: count(["skipped"]), failed: count(["failed"]) };
}

/** An operation the program asked of alpacawork, in words: "made task T52 and asked gpt-6.2-sol(medium)", "sent to hooks.slack.com". */
export function operationText(t: T, operation: Operation, facts?: Facts): string {
  const input = (operation.input ?? {}) as Record<string, unknown>;
  if (operation.failed) {
    const why = operation.code ? reasonWords(t, operation.code) ?? operation.code : null;
    const what = operation.name === "tasks.create" ? t("operation.createFailed", { title: typeof input.title === "string" ? input.title : "" })
      : operation.name === "send" || operation.name === "fetch" ? t("operation.sendFailed", { host: operation.target ?? "" })
      : t("operation.otherFailed", { name: operation.name });
    return why ? `${what}${t("colon")}${why}` : what;
  }
  const result = (operation.result ?? {}) as Record<string, unknown>;
  if (operation.name === "tasks.create") {
    const id = typeof result.id === "string" ? result.id : operation.target, title = typeof input.title === "string" ? input.title : "";
    const row = facts?.ai.find(each => each.name === input.ai);
    if (operation.replaced) return row ? t("operation.wouldCreateAsk", { title, ai: aiName(row) }) : t("operation.wouldCreate", { title });
    return row ? t("operation.createAsk", { task: id, ai: aiName(row) }) : t("operation.create", { task: id });
  }
  if (operation.name === "ai.ask") {
    const answer = typeof result.reason === "string" ? result.reason : typeof result.answer === "string" ? result.answer : "";
    return t("operation.ask", { model: operation.usage?.model ?? input.ai ?? "", answer });
  }
  if (operation.name === "send" || operation.name === "fetch")
    return operation.replaced ? t("operation.wouldSend", { host: operation.target ?? "" }) : t("operation.sent", { host: operation.target ?? "" });
  if (operation.name === "tasks.comment") return operation.replaced ? t("operation.wouldComment", { task: operation.target ?? "" }) : t("operation.comment", { task: operation.target ?? "" });
  if (operation.name === "disable") return t("operation.disable");
  return t("operation.other", { name: operation.name });
}

/** The one line a sender on this PC runs to send it a signal. */
export const signalCommand = (id: string) => `alpacawork automation signal --automation ${id} --key <KEY> --data-file <FILE>`;

/**
 * A call to its receiving point, as a caller writes it: the URL read from the caller's secret value (never written into
 * a script), a key for each occurrence (a call sent again with it counts once), retried when it did not get through.
 */
export const hookCall = (id: string) =>
  `curl -X POST --retry 5 --retry-connrefused "$ALPACA_${id}_URL" -H 'Content-Type: application/json' -H 'Idempotency-Key: <KEY>' --data @<FILE>`;
