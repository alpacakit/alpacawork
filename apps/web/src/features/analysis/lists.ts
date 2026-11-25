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

export function listTitle(list: ListPlace): string {
  if (list.value === "questions") return word("until.questionsList");
  if (list.value === "prs") return word("until.prsList");
  if (list.set === "used" && list.value) return word(COLUMN[list.value]);
  return word({ passed: "tasks.passed", reworked: "tasks.reworked", stopped: "tasks.stopped", accepted: "tasks.accepted", finished: "tasks.finished", used: "usage.tasks" }[list.set]);
}
/**
 * The unit of a list's count: tasks, said as a count of them (件) or, for the AI's use, as tasks; none in a language that
 * writes no count word (`unit.countWords`).
 */
export const listUnit = (list: ListPlace, count: number) => word("unit.countWords") === "no" ? ""
  : list.set === "used" ? word("unit.taskCount", { count }) : word("unit.tasks", { count });
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
