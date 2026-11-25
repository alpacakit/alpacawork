import { addDays, daysBetween } from "./format";
import { LIST_SETS, PERIODS, TASK_GROUPS, TASK_VALUES, USAGE_GROUPS, USAGE_VALUES, type Group, type ListSet, type ListValue, type Period } from "./contract";

/**
 * Where the analysis stands, as the URL says it (`face=analysis`): which look (tasks, or the AI's use), which span of
 * days, and what is open over it — a list of the tasks behind one number or the share card. Task panels above this face belong to reader navigation.
 */
export type Look = "tasks" | "usage";
/** A span: one of the named periods ending today, or whole days chosen on a chart or stepped to. */
export type Span = { period: Period } | { from: string; to: string };
/** A list: the tasks of one number. `group`/`member`: the row of a breakdown it was opened from. */
/**
 * A list: the tasks of one number. `group`/`member`: the row of a breakdown it was opened from. `days`: the bin of a
 * chart it was opened from (its own days, whatever span is chosen); none for a number of the span.
 */
export type ListPlace = { set: ListSet; value: ListValue | null; group: Group | null; member: string | null; days?: { from: string; to: string } | null };
/**
 * The share card's days: how long a span (a week, four weeks, the whole record) and the day it ends on, the one the
 * analysis showed when the card was opened (null: today). Another length keeps the day, the whole record's included.
 */
export const CARD_PERIODS = ["7d", "28d", "all"] as const;
export type CardPeriod = typeof CARD_PERIODS[number];
export type CardSpan = { length: CardPeriod; end: string | null };
/** `card`: the share card open over the analysis, and its days. */
export type AnalysisPlace = { look: Look; span: Span; list: ListPlace | null; card: CardSpan | null };

export const DEFAULT_SPAN: Span = { period: "7d" };
export const analysisHome = (look: Look = "tasks", span: Span = DEFAULT_SPAN): AnalysisPlace => ({ look, span, list: null, card: null });

/** A day the URL names, when it is one on the calendar (2026-13-18 is not). */
const isDay = (value: string | undefined): value is string =>
  !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
/** Whole days the URL names as `from~to`, or null. */
const readDays = (value: string | null) => { const [from, to] = value?.split("~") ?? []; return isDay(from) && isDay(to) && from <= to ? { from, to } : null; };
const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null => list.find(item => item === value) ?? null;

export function spanText(span: Span): string {
  return "period" in span ? span.period : `${span.from}~${span.to}`;
}
export function readSpan(value: string | null): Span {
  const period = oneOf(PERIODS, value);
  if (period) return { period };
  return readDays(value) ?? DEFAULT_SPAN;
}
export const sameSpan = (a: Span, b: Span) => spanText(a) === spanText(b);

type Values = { get: (key: string) => string | null };
/** The analysis the URL names, or null on the list of tasks. */
export function readAnalysis(url: Values): AnalysisPlace | null {
  if (url.get("face") !== "analysis") return null;
  const look: Look = url.get("look") === "usage" ? "usage" : "tasks";
  const set = oneOf(LIST_SETS, url.get("list"));
  const list: ListPlace | null = set ? {
    set, value: oneOf<ListValue>([...TASK_VALUES, ...USAGE_VALUES], url.get("measure")),
    group: oneOf<Group>([...TASK_GROUPS, ...USAGE_GROUPS], url.get("group")), member: url.get("member"),
    days: readDays(url.get("bin")),
  } : null;
  // A row needs its breakdown; a breakdown without a row is the whole of one that is counted from launches (skills,
  // tools, MCP: every launch that used one).
  if (list && (list.group === null ? list.member !== null : list.member === null && !WHOLE_GROUPS.has(list.group))) { list.group = null; list.member = null; }
  const card = url.get("card");
  return { look, span: readSpan(url.get("span")), list, card: card === null ? null : readCard(card) };
}

/** The breakdowns whose whole has a list of its own (every launch that used any of them). */
const WHOLE_GROUPS = new Set<Group>(["skill", "tool", "mcp"]);
export const ANALYSIS_KEYS = ["face", "look", "span", "list", "measure", "group", "member", "bin", "card"] as const;
/** The URL's values for a place, in one order, the defaults left out. */
export function analysisValues(place: AnalysisPlace | null): [typeof ANALYSIS_KEYS[number], string][] {
  if (!place) return [];
  const out: [typeof ANALYSIS_KEYS[number], string][] = [["face", "analysis"]];
  if (place.look !== "tasks") out.push(["look", place.look]);
  if (!sameSpan(place.span, DEFAULT_SPAN)) out.push(["span", spanText(place.span)]);
  if (place.list) {
    out.push(["list", place.list.set]);
    if (place.list.value) out.push(["measure", place.list.value]);
    if (place.list.days) out.push(["bin", `${place.list.days.from}~${place.list.days.to}`]);
    if (place.list.group) out.push(["group", place.list.group]);
    if (place.list.group && place.list.member !== null) out.push(["member", place.list.member]);
  }
  if (place.card) out.push(["card", place.card.end ? `${place.card.length}~${place.card.end}` : place.card.length]);
  return out;
}

/** What is open over the analysis, bottom first: the stack Back and × take away one at a time. */
export function analysisSurfaces(place: AnalysisPlace | null): string[] {
  if (!place) return [];
  const out: string[] = [];
  if (place.list) out.push(`list:${analysisValues({ ...place, card: null }).filter(([key]) => key !== "face" && key !== "look" && key !== "span").map(pair => pair.join("=")).join("&")}`);
  if (place.card) out.push("card");
  return out;
}
/** The place with only its `depth` bottom layers open. */
export function belowLayer(place: AnalysisPlace, depth: number): AnalysisPlace {
  const layers = analysisSurfaces(place).slice(0, Math.max(0, depth)).map(surface => surface.split(":")[0]);
  return { ...place, list: layers.includes("list") ? place.list : null, card: layers.includes("card") ? place.card : null };
}
/**
 * Whether going from one analysis to another is a step of its own, besides a layer opening (which every surface is):
 * coming to the analysis or leaving it, and choosing another span. Another look is not.
 */
export function analysisMoved(before: AnalysisPlace | null, after: AnalysisPlace | null): boolean {
  if (!before || !after) return before !== after;
  return !sameSpan(before.span, after.span);
}

/** The whole days of a span, by the server's today and its first day of records. */
export function spanDays(span: Span, today: string, firstDay: string | null): { from: string; to: string } {
  if (!("period" in span)) return { from: span.from, to: span.to };
  const back = { today: 0, "7d": 6, "28d": 27 }[span.period as Exclude<Period, "all">];
  return { from: back === undefined ? firstDay ?? today : addDays(today, -back), to: today };
}
/**
 * The span as the commands take it: a named period ending today as it is; whole days as a named period of the same
 * length ending on their last day, else as the days themselves.
 */
export function spanQuery(span: Span): Record<string, string> {
  if ("period" in span) return { period: span.period };
  const length = daysBetween(span.from, span.to);
  const period = length === 1 ? "today" : length === 7 ? "7d" : length === 28 ? "28d" : null;
  return period ? { period, end: span.to } : { from: span.from, to: span.to };
}
/** The span `length` days before or after, kept within the record. */
export function stepSpan(days: { from: string; to: string }, direction: -1 | 1): { from: string; to: string } {
  const length = daysBetween(days.from, days.to);
  return { from: addDays(days.from, direction * length), to: addDays(days.to, direction * length) };
}

/** The named periods and how many days before today each starts (`all` from the first day of records). */
export const PERIOD_BACK: { period: Period; back: number | null }[] = [{ period: "today", back: 0 }, { period: "7d", back: 6 }, { period: "28d", back: 27 }, { period: "all", back: null }];
/**
 * A span as it is kept: whole days that end today and are as long as a named period are that period, so the period's
 * switch shows chosen and the URL stays short.
 */
export function settleSpan(days: { from: string; to: string }, today: string): Span {
  if (days.to !== today) return days;
  const length = daysBetween(days.from, days.to);
  const preset = PERIOD_BACK.find(each => each.back !== null && each.back + 1 === length);
  return preset ? { period: preset.period } : days;
}
/**
 * The place a number of an answer opens: its list, in the span that answer was counted for (`head.period`), so the
 * number and the tasks behind it always agree, even while another span is being read.
 */
export function listOnAnswer(place: AnalysisPlace, head: { period: { from: string; to: string } | null; today: string; firstDay: string | null }, list: ListPlace): AnalysisPlace {
  const shown = head.period, chosen = spanDays(place.span, head.today, head.firstDay);
  const span = !shown || shown.from === chosen.from && shown.to === chosen.to ? place.span : settleSpan(shown, head.today);
  return { ...place, span, list, card: null };
}

/**
 * The span the arrows move to: the span chosen now, a length of it earlier or later (whatever answer is still on screen),
 * kept within the record; null where there is nothing that way.
 */
export function stepChosen(span: Span, head: { today: string; firstDay: string | null }, direction: -1 | 1): Span | null {
  const next = stepSpan(spanDays(span, head.today, head.firstDay), direction);
  if (direction < 0 ? !head.firstDay || next.from < head.firstDay : next.to > head.today) return null;
  return settleSpan(next, head.today);
}

/** The card's days as the URL says them: a length, and after `~` the day it ends on when that is not today. */
function readCard(value: string): CardSpan {
  const [length, end] = value.split("~");
  return { length: oneOf(CARD_PERIODS, length ?? null) ?? "7d", end: isDay(end) ? end : null };
}
/** The card's days as the analysis shows them: its length (a week for a day or any other length) and its last day. */
export function cardSpanOf(span: Span): CardSpan {
  if ("period" in span) return { length: span.period === "today" ? "7d" : span.period, end: null };
  return { length: daysBetween(span.from, span.to) === 28 ? "28d" : "7d", end: span.to };
}
/**
 * The days the card is counted for: its length ending on its day. The whole record ending on a day is asked as the days
 * from the record's first (`firstDay`, null while unknown: not yet asked).
 */
export function cardDays(card: CardSpan, firstDay: string | null): Span | null {
  if (!card.end) return { period: card.length };
  if (card.length !== "all") return { from: addDays(card.end, card.length === "7d" ? -6 : -27), to: card.end };
  return firstDay ? { from: firstDay < card.end ? firstDay : card.end, to: card.end } : null;
}
