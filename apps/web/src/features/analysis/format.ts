import { i18n } from "@alpacawork/i18n";

/**
 * How the analysis writes its numbers, one way everywhere: a value and its unit apart (the unit drawn small beside it),
 * and the gap to the span before in the same unit, with no word for it ("+23", "−0.3", or "same" when it rounds away).
 * Every number here is one the server counted; this only writes it.
 */
export type Parts = { value: string; unit: string; tight?: boolean };
export type Kind = "tasks" | "times" | "plain" | "hours" | "tokens";

const word = (key: string, options?: Record<string, unknown>) => i18n.t(`analysis:${key}`, options);
const locale = () => i18n.resolvedLanguage ?? i18n.language ?? "en";
const whole = (value: number) => Math.round(value).toLocaleString(locale());
/** A number to fixed places, in the screen's language (1.39, 1,39). */
export const decimalText = (value: number, digits: number) => fixed(value, digits);
/** A number in the screen's language (not the browser's), to two places at most. */
export const numberText = (value: number) => value.toLocaleString(locale(), { maximumFractionDigits: 2 });
const fixed = (value: number, digits: number) => value.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
const HOUR = 3_600_000;

/** Large token counts are written in the language's own steps (万・億, or K・M・B), the first step they reach. */
type Scale = { at: number; unit: string; digits: number };
const scales = (): Scale[] => {
  const list = i18n.t("analysis:unit.scales", { returnObjects: true }) as unknown;
  return Array.isArray(list) ? list as Scale[] : [];
};
const scaleOf = (value: number) => scales().find(scale => value >= scale.at) ?? null;

/** Hours, to one place under ten. */
const hourValue = (hours: number) => hours >= 10 ? whole(hours) : fixed(hours, 1);

export function parts(kind: Kind, value: number): Parts {
  switch (kind) {
    case "tasks": return { value: whole(value), unit: word("unit.tasks", { count: value }) };
    case "times": return { value: whole(value), unit: word("unit.times", { count: value }) };
    case "plain": return { value: whole(value), unit: "" };
    case "hours": return { value: hourValue(value / HOUR), unit: word("unit.hours") };
    case "tokens": {
      const scale = scaleOf(value);
      return scale ? { value: fixed(value / scale.at, scale.digits), unit: scale.unit, tight: true } : { value: whole(value), unit: "" };
    }
  }
}
export const text = ({ value, unit, tight }: Parts) => unit ? word(tight ? "unit.joinTight" : "unit.join", { value, unit }) : value;
export const format = (kind: Kind, value: number) => text(parts(kind, value));

/** A time of one task: minutes under an hour, else hours. */
export function duration(ms: number): string {
  return ms < HOUR ? word("unit.join", { value: whole(ms / 60_000), unit: word("unit.minutes") }) : format("hours", ms);
}

/** How a gap is written in a kind: its size in the kind's own unit, which for tokens is the larger value's step. */
function gapValue(kind: Kind, gap: number, larger: number): string {
  // Like tokens, the gap has the places of the larger value (160時間, −1), not of its own size.
  if (kind === "hours") return larger / HOUR >= 10 ? whole(gap / HOUR) : fixed(gap / HOUR, 1);
  if (kind !== "tokens") return whole(gap);
  const scale = scaleOf(larger);
  // The gap has the places its value has (99.7億, +20.4億), so the two read alike.
  return scale ? word("unit.joinTight", { value: fixed(gap / scale.at, scale.digits), unit: scale.unit }) : whole(gap);
}
/** The gap from the span before: a sign and its size, or "same" when it is zero as written. */
export function delta(kind: Kind, current: number, previous: number): string {
  const gap = current - previous, written = gapValue(kind, Math.abs(gap), Math.max(current, previous));
  if (!/[1-9]/.test(written)) return word("same");
  return `${gap > 0 ? "+" : "−"}${written}`;
}
/** A share: a whole percent; none (—) when the server gives none (fewer than ten accepted). */
export const share = (value: number | null) => value === null ? "—" : `${Math.round(value * 100)}%`;
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
const fmt = (options: Intl.DateTimeFormatOptions, zone = "UTC") => new Intl.DateTimeFormat(locale(), { ...options, timeZone: zone });
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
