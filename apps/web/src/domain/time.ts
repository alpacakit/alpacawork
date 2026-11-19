/** ISO timestamps are displayed in the browser's time zone. */
const two = (value: number) => String(value).padStart(2, "0");
const clockOf = (date: Date) => `${two(date.getHours())}:${two(date.getMinutes())}`;
const dayOf = (date: Date, locale: string) =>
  new Intl.DateTimeFormat(locale, { month: "long", day: "numeric" }).format(date);
const logTimeOf = (date: Date) => `${two(date.getMonth() + 1)}/${two(date.getDate())} ${clockOf(date)}`;
const sameDayOf = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Calendar comparisons use the reader's local day, including across DST and year boundaries. */
export function sameCalendarDay(at: number, other: number): boolean {
  return sameDayOf(new Date(at), new Date(other));
}

export function calendarDayOffset(at: number, other: number): number {
  const a = new Date(at), b = new Date(other);
  return (Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 86_400_000;
}

/** A date says its year only when it differs from the reference year's. */
export function formatCalendarDate(at: number, reference: number): string {
  const date = new Date(at), today = new Date(reference);
  return `${date.getFullYear() !== today.getFullYear() ? `${date.getFullYear()}/` : ""}${date.getMonth() + 1}/${date.getDate()}`;
}

/** "14:12" */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return clockOf(date);
}

/** "14:12" on the day of `now`, otherwise "09/25 14:12" (notification rows). */
export function formatNoticeTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return sameDayOf(date, now) ? clockOf(date) : logTimeOf(date);
}

/** "09/25 14:12" (history entries) */
export function formatLogTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return logTimeOf(date);
}

/** The localized month and day followed by a 24-hour clock time. */
export function formatDayTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return " ";
  return `${dayOf(date, locale)} ${clockOf(date)}`;
}

/** Whole minutes from `iso` to `now`; null when the time is not known or lies ahead. */
export function minutesSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return null;
  // The shared clock ticks every 30 seconds, so what happened since its last tick is newer than its now: just now.
  return Math.max(0, Math.floor((now - start) / 60_000));
}
