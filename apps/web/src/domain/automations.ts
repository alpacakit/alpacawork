import type { Automation } from "@/features/automations/shape";

/**
 * The rules the automation screens read an automation by: when it runs by the clock, in words the screen writes itself
 * (the AI that wrote it never writes them), and which group of the table it stands in.
 */

/** A time of day, as the cron's minute and hour fields name it. */
export type Clock = { hour: number; minute: number };

/**
 * When a schedule runs, as one of the shapes the screen has words for. A cron of any other shape is `custom`: the
 * screen then says only that it runs at set times, and the next runs show when.
 */
export type ScheduleShape =
  | { kind: "daily"; times: Clock[] }
  | { kind: "weekdays"; times: Clock[] }
  | { kind: "weekends"; times: Clock[] }
  | { kind: "weekly"; days: number[]; times: Clock[] }
  | { kind: "monthly"; day: number; times: Clock[] }
  | { kind: "everyMinutes"; minutes: number }
  | { kind: "hourly"; minute: number }
  | { kind: "everyHours"; hours: number; minute: number }
  | { kind: "custom" };

const NUMBER = /^\d+$/;
const number = (field: string, max: number): number | null => NUMBER.test(field) && Number(field) <= max ? Number(field) : null;
/** A comma list of plain numbers within `max`, sorted and without repeats; null when any part is not one. */
function numbers(field: string, max: number): number[] | null {
  const parts = field.split(",").map(part => number(part, max));
  return parts.every(part => part !== null) ? [...new Set(parts as number[])].sort((a, b) => a - b) : null;
}
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
/** A day of the week by its number (0 Sunday … 7 Sunday again) or its three-letter name. */
const weekDay = (field: string): number | null => {
  const named = DAY_NAMES.indexOf(field.toUpperCase());
  return named >= 0 ? named : number(field, 7);
};
/** The days of the week a field names (0 Sunday … 6 Saturday; 7 is Sunday too), ranges included. */
function weekDays(field: string): number[] | null {
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const [from, to] = part.split("-");
    const start = weekDay(from ?? ""), end = to === undefined ? start : weekDay(to);
    if (start === null || end === null || end < start) return null;
    for (let day = start; day <= end; day++) days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}
const sameDays = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((day, at) => day === b[at]);

/** The shape of a five-field cron (minute, hour, day of month, month, day of week). */
export function scheduleShape(cron: string): ScheduleShape {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return { kind: "custom" };
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  if (month !== "*") return { kind: "custom" };
  const every = /^\*\/(\d+)$/;
  if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const step = every.exec(minute);
    // A step starts again at each hour: only one that divides the hour runs evenly every so many minutes.
    if (step && Number(step[1]) >= 1 && 60 % Number(step[1]) === 0) return { kind: "everyMinutes", minutes: Number(step[1]) };
    if (minute === "*") return { kind: "everyMinutes", minutes: 1 };
    const at = number(minute, 59);
    return at === null ? { kind: "custom" } : { kind: "hourly", minute: at };
  }
  const minutes = numbers(minute, 59);
  if (!minutes) return { kind: "custom" };
  const hourStep = every.exec(hour);
  if (hourStep && dayOfMonth === "*" && dayOfWeek === "*" && minutes.length === 1 && Number(hourStep[1]) >= 1 && 24 % Number(hourStep[1]) === 0)
    return { kind: "everyHours", hours: Number(hourStep[1]), minute: minutes[0]! };
  const hours = numbers(hour, 23);
  if (!hours) return { kind: "custom" };
  const times = hours.flatMap(at => minutes.map(m => ({ hour: at, minute: m })));
  if (dayOfMonth === "*" && dayOfWeek === "*") return { kind: "daily", times };
  if (dayOfWeek === "*") {
    const day = number(dayOfMonth, 31);
    return day !== null && day >= 1 ? { kind: "monthly", day, times } : { kind: "custom" };
  }
  if (dayOfMonth !== "*") return { kind: "custom" };
  const days = weekDays(dayOfWeek);
  if (!days) return { kind: "custom" };
  if (days.length === 7) return { kind: "daily", times };
  if (sameDays(days, [1, 2, 3, 4, 5])) return { kind: "weekdays", times };
  if (sameDays(days, [0, 6])) return { kind: "weekends", times };
  return { kind: "weekly", days, times };
}

/** A time of day as the screen writes it: 9:00, 13:30. */
export const clockText = ({ hour, minute }: Clock) => `${hour}:${String(minute).padStart(2, "0")}`;

/** The groups of the automations table, in its order: those asking for a look, those on, then drafts and those off. */
export type AutomationGroup = "attention" | "on" | "rest";
type Grouped = Pick<Automation, "enabled" | "attention">;
export const groupOf = (automation: Grouped): AutomationGroup =>
  automation.attention.length ? "attention" : automation.enabled ? "on" : "rest";

/**
 * The mark beside an automation's name, when it is not simply on: never turned on (a draft), off, or on with a new
 * version waiting to be turned on.
 */
export type NameMark = "draft" | "off" | "awaiting";
export function nameMark(automation: Pick<Automation, "enabled" | "everEnabled" | "awaitingEnable">): NameMark | null {
  if (automation.awaitingEnable) return "awaiting";
  if (automation.enabled) return null;
  return automation.everEnabled ? "off" : "draft";
}

/** Which day a time falls on, from `now`, in the screen's own time zone: today, tomorrow, or another date. */
export function dayFrom(at: Date, now: Date): "today" | "tomorrow" | "other" {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  return days === 0 ? "today" : days === 1 ? "tomorrow" : "other";
}

/** Whether a project's automations show while the list is narrowed to `project` (null: every project). */
export function inProject(automationProject: string, project: string | null,
  projects: readonly { id: string; parentId: string | null }[]): boolean {
  if (project === null) return true;
  let at: string | null = automationProject;
  const seen = new Set<string>();
  while (at !== null && !seen.has(at)) {
    if (at === project) return true;
    seen.add(at);
    at = projects.find(item => item.id === at)?.parentId ?? null;
  }
  return false;
}
