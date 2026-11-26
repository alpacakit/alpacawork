import { i18n } from "@alpacawork/i18n";
import { isTokenUnit, tokenNumber, tokenParts, tokenStep, tokenText } from "@/domain/tokens";

/**
 * How the analysis writes its numbers, one way everywhere: a value and its unit apart (the unit drawn small beside it),
 * and the gap to the span before in the same unit, with no word for it ("+23", "−0.3", or "same" when it rounds away).
 * Every number here is one the server counted; this only writes it.
 */
export type Parts = { value: string; unit: string; tight?: boolean };
/**
 * What a number counts, and so its unit: things (tasks, PRs, conversations: 件), events (times, questions: 回), people,
 * hours, tokens, or a bare number. A language whose names already say what is counted (English) writes no count word.
 */
export type Kind = "tasks" | "times" | "prs" | "conversations" | "people" | "questions" | "plain" | "hours" | "tokens";
const COUNT_WORD = { tasks: "unit.tasks", times: "unit.times", prs: "unit.prs", conversations: "unit.conversations", people: "unit.people", questions: "unit.questions" } as const;

const word = (key: string, options?: Record<string, unknown>) => i18n.t(`analysis:${key}`, options);
const locale = () => i18n.resolvedLanguage ?? i18n.language ?? "en";
/**
 * What a language writes with, made or read once for it (a formatter, its steps, whether it writes count words): a chart
 * writes every day's numbers and dates to size its legend, and making a formatter or reading a text costs far more than
 * using one (`toLocaleString` with options makes a formatter each time). The texts are all loaded with the language.
 */
const madeOnce = new Map<string, unknown>();
const once = <T,>(key: string, make: (language: string) => T): T => {
  const language = locale(), at = `${language}\u0000${key}`;
  if (!madeOnce.has(at)) madeOnce.set(at, make(language));
  return madeOnce.get(at) as T;
};
const numbers = (min: number | undefined, max: number | undefined) =>
  once(`number ${min} ${max}`, language => new Intl.NumberFormat(language, { minimumFractionDigits: min, maximumFractionDigits: max }));
const whole = (value: number) => numbers(undefined, undefined).format(Math.round(value));
/** A number to fixed places, in the screen's language (1.39, 1,39). */
export const decimalText = (value: number, digits: number) => fixed(value, digits);
/** A number in the screen's language (not the browser's), to two places at most. */
export const numberText = (value: number) => numbers(undefined, 2).format(value);
const fixed = (value: number, digits: number) => numbers(digits, digits).format(value);
const HOUR = 3_600_000;

/** Large token counts are written as the whole app writes them (domain/tokens): k・M・B, in every language. */
const scaleOf = tokenStep;
/** A token count as a sentence says it: as everywhere else ("1.2B"). */
export const spoken = tokenText;

/**
 * Hours: to one place under ten, whole from ten. The places are chosen by the value as it rounds (9.96 is 10, not
 * 10.0), so every number of ten or more is written whole.
 */
const hourValue = (hours: number) => { const tenth = Math.round(hours * 10) / 10; return tenth >= 10 ? whole(hours) : fixed(tenth, 1); };

export function parts(kind: Kind, value: number): Parts {
  switch (kind) {
    case "tasks": case "times": case "prs": case "conversations": case "people": case "questions":
      return { value: whole(value), unit: countWord(kind, value) };
    case "plain": return { value: whole(value), unit: "" };
    case "hours": return { value: hourValue(value / HOUR), unit: word("unit.hours") };
    case "tokens": {
      const { value: number, unit } = tokenParts(value);
      return unit ? { value: number, unit, tight: true } : { value: whole(value), unit: "" };
    }
  }
}
export const text = ({ value, unit, tight }: Parts) => !unit ? value : isTokenUnit(unit) ? `${value}${unit}`
  : word(tight ? "unit.joinTight" : "unit.join", { value, unit });
/** A value written by hand (a per-task number, a scale's top) with a unit that may be none. */
export const inUnit = (value: string, unit: string) => text({ value, unit });
/**
 * The word a count is written with (件, 回; 个, 次), or none in a language whose names already say what is counted
 * (`unit.countWords`: "no", as English: "Finished tasks 84", not "84 tasks").
 */
const countWord = (kind: keyof typeof COUNT_WORD, count: number) => writesCountWords() ? word(COUNT_WORD[kind], { count }) : "";
const writesCountWords = () => once("countWords", () => word("unit.countWords") !== "no");
/** A kind's unit alone, as a table's heading or a chart's scale says it once ("" for a count in a language that writes none). */
export const unitOf = (kind: "tasks" | "times" | "prs" | "conversations" | "people" | "questions" | "hours") =>
  kind === "hours" ? word("unit.hours") : countWord(kind, 2);
export const format = (kind: Kind, value: number) => text(parts(kind, value));
/**
 * A number already written with its unit ("962.0M", "1.5 h"), parted again into the number and what
 * follows it, so the unit can be drawn at the body's step beside a large number. Words with no number stay whole.
 */
export function splitFigure(written: string): { value: string; unit: string } {
  // The number ends on a digit (its groups and places inside it), so a space before a unit is not the number's.
  const match = /^([+\u2212-]?\d(?:[\d.,\u00a0\u202f\u2009 ]*\d)?)\s*(.*)$/.exec(written);
  return match ? { value: match[1]!, unit: match[2]! } : { value: written, unit: "" };
}

/** A time of one task: minutes under an hour as it rounds (59.6 minutes is an hour), else hours. */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? word("unit.join", { value: whole(minutes), unit: word("unit.minutes") }) : format("hours", ms);
}

/**
 * How a column of token counts is written: every value in the step of the column's largest (k・M・B), said
 * once in the column's heading (`unit`), so the values of one column read alike. A value too small to show in that
 * step is written as under its smallest place ("<0.1"), never as 0 (only none is 0).
 */
export function tokenColumn(values: number[]): { unit: string; write: (value: number) => string } {
  const scale = scaleOf(Math.max(0, ...values));
  if (!scale) return { unit: "", write: whole };
  return { unit: scale.unit, write: value => {
    if (!value) return whole(0);
    // A step's own places, and one more where the column's values are under ten of it (0.3M, not 0M).
    const digits = Math.max(scale.digits, Math.max(0, ...values) / scale.at < 10 ? 1 : 0);
    const written = tokenNumber(value / scale.at, digits);
    return value > 0 && !/[1-9]/.test(written) ? `<${tokenNumber(10 ** -digits, digits)}` : written;
  } };
}

/** How a gap is written in a kind: its size in the kind's own unit, which for tokens is the larger value's step. */
function gapValue(kind: Kind, gap: number, larger: number): string {
  // Like tokens, the gap has the places of the larger value (160時間, −1), not of its own size.
  if (kind === "hours") return Math.round(larger / HOUR * 10) / 10 >= 10 ? whole(gap / HOUR) : fixed(gap / HOUR, 1);
  if (kind !== "tokens") return whole(gap);
  const scale = scaleOf(larger);
  // The gap has the places its value has (9.9B, +2.0B), so the two read alike.
  return scale ? `${tokenNumber(gap / scale.at, scale.digits)}${scale.unit}` : whole(gap);
}
/** The gap from the span before: a sign and its size, or "same" when it is zero as written. */
export function delta(kind: Kind, current: number, previous: number): string {
  const gap = current - previous, written = gapValue(kind, Math.abs(gap), Math.max(current, previous));
  if (!/[1-9]/.test(written)) return word("same");
  return `${gap > 0 ? "+" : "−"}${written}`;
}
/** A share as a whole percent, its number and its sign apart. */
export const shareParts = (value: number): Parts => ({ value: String(Math.round(value * 100)), unit: "%", tight: true });
/** A share: a whole percent; none (—) when the server gives none (fewer than ten accepted). */
export const share = (value: number | null) => value === null ? "—" : `${shareParts(value).value}${shareParts(value).unit}`;
/** A gap between two shares, in points, when both are given. */
export function shareDelta(current: number | null, previous: number | null): string | null {
  if (current === null || previous === null) return null;
  const gap = Math.round(current * 100) - Math.round(previous * 100);
  return gap === 0 ? word("same") : `${gap > 0 ? "+" : "−"}${Math.abs(gap)}${word("unit.points")}`;
}

/* ── days: the server's local calendar days (YYYY-MM-DD), written as they are ── */
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
export const addDays = (day: string, count: number) => { const at = utc(day); at.setUTCDate(at.getUTCDate() + count); return at.toISOString().slice(0, 10); };
export const daysBetween = (from: string, to: string) => Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000) + 1;
/** Monday 0 … Sunday 6. */
export const weekday = (day: string) => (utc(day).getUTCDay() + 6) % 7;
const fmt = (options: Intl.DateTimeFormatOptions, zone = "UTC") =>
  once(`date ${zone} ${JSON.stringify(options)}`, language => new Intl.DateTimeFormat(language, { ...options, timeZone: zone }));
export const dateLabel = (day: string) => fmt({ dateStyle: "medium" }).format(utc(day));
export const dayLabel = (day: string) => fmt({ month: "numeric", day: "numeric" }).format(utc(day));
export const monthLabel = (day: string) => fmt({ month: "short" }).format(utc(day));
export const weekdayLabel = (day: string) => fmt({ weekday: "short" }).format(utc(day));
export const dayWithWeekday = (day: string) => word("day", { day: dayLabel(day), weekday: weekdayLabel(day) });
export const spanLabel = (from: string, to: string) => from === to ? dayWithWeekday(from) : word("range", { from: dayWithWeekday(from), to: dayWithWeekday(to) });
/** An instant, as the day and the clock in the server's zone. */
export const instant = (iso: string, zone: string) =>
  `${fmt({ month: "numeric", day: "numeric" }, zone).format(new Date(iso))} ${fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, zone).format(new Date(iso))}`;
/** The span before, by its length. */
export const previousName = (length: number) => length === 1 ? word("previous.day") : word("previous.days", { count: length });

/** The line under a number: the same span just before and the gap, or that there is no record of it. */
/** The line under a number: the same span just before and the gap; null when there is none to compare with (nothing is said). */
export function comparison(kind: Kind, current: number, previous: number | null, length: number): { before: string; gap: string | null } | null {
  if (previous === null) return null;
  return { before: `${previousName(length)} ${format(kind, previous)}`, gap: delta(kind, current, previous) };
}

/** Round marks on a scale (0, 10, 20…), at most five, never a half where only wholes are counted. */
export function ticks(max: number, unit: number, wholeOnly: boolean): number[] {
  const m = max / unit || 1, power = 10 ** Math.floor(Math.log10(m));
  const step = [0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map(x => x * power).filter(s => !wholeOnly || s >= 1 && s % 1 === 0).find(s => m / s <= 4) ?? power * 10;
  const top = Math.ceil(m / step - 1e-9) * step, out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6 * unit);
  return out;
}
