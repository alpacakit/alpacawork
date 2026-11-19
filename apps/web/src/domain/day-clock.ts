import { calendarDayOffset, formatCalendarDate, formatClock, sameCalendarDay } from "./time";

type Words = (key: string, options?: Record<string, unknown>) => string;

/**
 * Every timeline says a clock time one way, by its day: "15:40", "tomorrow 06:30",
 * "yesterday 16:51", "10/4 06:30", "2027/1/4 06:30". Words come from `people:clock.*`.
 * A time stands under a day (`base`): today in a list, the day divider above it in a task's timeline. On that day
 * it is the clock alone; on another it names its own day from today, so under yesterday's divider today's is "Today 02:01".
 */
export function dayClock(at: number, now: number, t: Words, locale: string, base = now): string {
  const clock = formatClock(new Date(at).toISOString());
  if (sameCalendarDay(at, base)) return t("clock.base", { clock });
  const days = calendarDayOffset(at, now);
  if (days === 0) return t("clock.today", { clock });
  if (days === 1) return t("clock.tomorrow", { clock });
  if (days === -1) return t("clock.yesterday", { clock });
  return t("clock.date", { date: formatCalendarDate(at, now, locale), clock });
}

/**
 * `dayClock` for a time that stands alone as a label (a row's time, a History row's time): it starts with a capital,
 * "Tomorrow 01:20". Inside a sentence the plain `dayClock` keeps the day word lowercase ("Expected report tomorrow 01:20").
 */
export function dayClockLabel(at: number, now: number, t: Words, locale: string, base = now): string {
  return capitalized(dayClock(at, now, t, locale, base));
}

/** A `dayClock` already said, as a label: its first letter a capital (no change in Japanese or a bare clock). */
export const capitalized = (said: string) => said.charAt(0).toUpperCase() + said.slice(1);

/** A day divider's words (no divider heads today): the day's name from today, if it has one, and its date with the weekday ("Yesterday", "Mon 10/26"). */
export function dayHeading(at: number, now: number, t: Words, locale: string): { name: string | null; date: string } {
  const days = calendarDayOffset(at, now);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(at));
  return { name: days === -1 ? t("day.yesterday") : days === 1 ? t("day.tomorrow") : null,
    date: t("day.date", { date: formatCalendarDate(at, now, locale), weekday }) };
}

/** An expected end, said to five minutes and rounded up, so the time does not tick every minute. */
export const roundEnd = (at: number) => Math.ceil(at / 300_000) * 300_000;
