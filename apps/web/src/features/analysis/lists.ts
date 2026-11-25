import { i18n } from "@alpacawork/i18n";
import { duration, format } from "./format";
import type { ListValue } from "./contract";
import type { ListPlace } from "./place";

/**
 * What a list says of itself: its title (the number it was opened from), the name of its column (what each task's
 * value is) and how a value is written. Without a value the column says how each task went.
 */
const word = (key: string, options?: Record<string, unknown>) => i18n.t(`analysis:${key}`, options);

const COLUMN: Record<ListValue, string> = {
  lead: "def.leadName", submits: "until.submits", questions: "until.questions", prs: "until.prs",
  you: "time.you", ai: "time.ai", other: "time.other",
  launches: "usage.launches", runMs: "usage.runMs", newConversations: "usage.newConversations",
  tokens: "usage.tokens", output: "usage.output", input: "usage.input", cache: "usage.cache", calls: "usage.calls",
};
const USAGE = new Set<ListValue>(["launches", "runMs", "newConversations", "tokens", "output", "input", "cache", "calls"]);

/** What a list lists (the number it was opened from): a count's own name, or, for an amount of the AI's use, the tasks it went to. */
export function listTitle(list: ListPlace): string {
  if (list.value === "questions") return word("until.questionsList");
  if (list.value === "prs") return word("until.prsList");
  if (list.set === "used" && list.value) return word("list.usedTitle", { name: word(COLUMN[list.value]) });
  return word({ passed: "tasks.passed", reworked: "tasks.reworked", stopped: "tasks.stopped", accepted: "tasks.accepted", finished: "tasks.finished", used: "usage.tasks" }[list.set]);
}
/**
 * A list's heading: what it lists, then how many tasks, apart ("出力のタスク・3件", "Output · 3 tasks"). The count
 * always says it counts tasks, in English too (which writes no count word elsewhere): beside a name like "Output" a
 * bare number would read as the amount.
 */
export const listHeading = (list: ListPlace, count: number) => `${listTitle(list)}${word("sep")}${word("list.count", { count, n: count.toLocaleString(i18n.resolvedLanguage ?? "en") })}`;
export const listColumn = (list: ListPlace) => list.value ? word(COLUMN[list.value]) : word("list.outcome");
export const usageValue = (value: ListValue | null) => value !== null && USAGE.has(value);

export function writeValue(value: ListValue, amount: number): string {
  switch (value) {
    case "lead": case "you": case "ai": case "other": case "runMs": return duration(amount);
    case "submits": case "launches": case "calls": return format("times", amount);
    case "questions": return format("questions", amount);
    case "prs": return format("prs", amount);
    case "newConversations": return format("conversations", amount);
    case "tokens": case "output": case "input": case "cache": return format("tokens", amount);
  }
}

/**
 * Whether a list shows the column of the day each task finished, decided by what the list is, never by the rows read
 * so far: it is left out only from a list of the tasks that finished (or were accepted, or stopped) on one day, where
 * every row's day is that day. A list of the AI's use (tasks it worked on in the days) always shows it.
 */
export const showsDays = (list: Pick<ListPlace, "set">, days: { from: string; to: string } | null) =>
  list.set === "used" || !days || days.from !== days.to;
