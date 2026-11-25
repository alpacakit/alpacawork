import { i18n } from "@alpacawork/i18n";
import { grassLevels } from "./charts";
import { addDays, dateLabel, daysBetween, parts as written, shareParts, spoken, text, type Parts } from "./format";
import { tokenTotal, type TasksView, type UsageView } from "./contract";
import type { Answer } from "./data";

/**
 * The share card: what of the analysis goes on it, and how it is written. A card says numbers, the name of the model
 * used most and days, nothing else: what reaches a drawing is `CardFacts`, which has no room for a task's title, its
 * words, a project or a task's ID. Every number is one the analysis commands counted, written as the analysis writes it.
 */
export type CardFacts = {
  from: string; to: string;
  tokens: number; finished: number; share: number | null; runMs: number; prs: number;
  /** The name of the most-used model across all launch efforts. */
  model: string | null;
  /** The finished-task calendar's latest weeks (13 at most), oldest first, Monday on top: each day's level (0–4), null outside the record. */
  grass: (number | null)[][];
};

/** The numbers a card can lead with, and those it can carry under it (the one leading is not carried twice). */
export const HEROES = ["tokens", "finished", "share"] as const;
export const NUMBERS = ["tokens", "finished", "share", "runMs", "prs", "model"] as const;
export type Hero = typeof HEROES[number];
export type CardNumber = typeof NUMBERS[number];
/** How many numbers ride under the one leading. The calendar is not one of them. */
export const CARD_LIMIT = 3;
const GRASS_WEEKS = 13;

/** What the person chose for their card, kept on this device. `theme`: null until chosen (the app's own then). */
export type CardChoice = { hero: Hero; numbers: CardNumber[]; grass: boolean; theme: "dark" | "light" | null };
export const CARD_DEFAULT: CardChoice = { hero: "tokens", numbers: ["finished", "share", "model"], grass: true, theme: null };

/**
 * The card's facts (`analysis tasks` and `analysis usage` by model, for its days) from the answers for what is asked now
 * (the project, the days), each waited for only while the card still needs it: null as soon as one says there is no
 * record (the analysis's own answer for the project, or the tasks' for the days); undefined while one still needed is on
 * its way, an answer for what was asked before standing in for it included, so a card is never drawn from another
 * project's or other days' numbers.
 */
export function cardFacts(record: Answer<TasksView> | null, tasksAnswer: Answer<TasksView> | null,
  usageAnswer: Answer<UsageView> | null): CardFacts | null | undefined {
  if (record?.current && record.data.head.firstDay === null) return null;
  if (!tasksAnswer?.current) return undefined;
  const tasks = tasksAnswer.data, days = tasks.head.period;
  if (!days) return null;
  if (!usageAnswer?.current) return undefined;
  const usage = usageAnswer.data;
  // The most-used model is the first row of the usage's breakdown by model, as its table shows it first.
  const model = usage.breakdown?.by === "model" ? usage.breakdown.rows[0]?.model?.name ?? null : null;
  return { from: days.from, to: days.to, tokens: tokenTotal(usage.counts.value), finished: tasks.counts.value.finished,
    share: tasks.counts.value.share, runMs: usage.counts.value.runMs, prs: tasks.accepted.value.prs, model,
    grass: grassWeeks(tasks.grass, tasks.head) };
}

/** The calendar's latest weeks, each day by the levels the analysis's calendar takes over the whole record. */
function grassWeeks(grass: TasksView["grass"], head: { today: string; firstDay: string | null }): (number | null)[][] {
  const level = grassLevels(grass.finished), columns = Math.ceil(grass.finished.length / 7), weeks: (number | null)[][] = [];
  for (let column = Math.max(0, columns - GRASS_WEEKS); column < columns; column++) weeks.push([0, 1, 2, 3, 4, 5, 6].map(row => {
    const at = column * 7 + row, day = addDays(grass.from, at);
    return at >= grass.finished.length || day > head.today || head.firstDay !== null && day < head.firstDay ? null : level(grass.finished[at]!);
  }));
  return weeks;
}

/** Whether a number has a value to show: a share needs ten accepted, a model a launch. */
export const shown = (facts: CardFacts, key: CardNumber) => key === "share" ? facts.share !== null : key === "model" ? facts.model !== null : true;

/** What goes on the card: the number leading (tokens when the one chosen has no value), then up to three of those chosen. */
export function cardPicks(choice: CardChoice, facts: CardFacts): { hero: Hero; rest: CardNumber[]; grass: boolean } {
  const hero = shown(facts, choice.hero) ? choice.hero : "tokens";
  const rest = NUMBERS.filter(key => key !== hero && choice.numbers.includes(key) && shown(facts, key)).slice(0, CARD_LIMIT);
  return { hero, rest, grass: choice.grass && facts.grass.length > 0 };
}
/** Whether a number can be pressed on or off: one on the card always; another while it has a value and there is room. */
export const canPick = (choice: CardChoice, facts: CardFacts, key: CardNumber) => {
  const rest = cardPicks(choice, facts).rest;
  return rest.includes(key) || shown(facts, key) && rest.length < CARD_LIMIT;
};
/** The choice with a number pressed: off when it is on the card, else on. */
export function pick(choice: CardChoice, facts: CardFacts, key: CardNumber): CardChoice {
  const on = cardPicks(choice, facts).rest.includes(key);
  return { ...choice, numbers: on ? choice.numbers.filter(each => each !== key) : [...choice.numbers.filter(each => each !== key), key] };
}

/**
 * A number as the card writes it: its value and its unit apart. A model's name is text. `spaced` indicates a space
 * between the number and its unit (534 tasks).
 */
export type Figure = Parts & { words?: boolean; spaced?: boolean };
const parts = (kind: Parameters<typeof written>[0], value: number): Figure => {
  const each = written(kind, value);
  return { ...each, spaced: !!each.unit && text(each) !== `${each.value}${each.unit}` };
};
export function cardFigure(facts: CardFacts, key: CardNumber): Figure | null {
  switch (key) {
    case "tokens": return parts("tokens", facts.tokens);
    case "finished": return parts("tasks", facts.finished);
    case "share": return facts.share === null ? null : shareParts(facts.share);
    case "runMs": return parts("hours", facts.runMs);
    case "prs": return parts("plain", facts.prs);
    case "model": return facts.model === null ? null : { value: facts.model, unit: "", words: true };
  }
}

const say = (key: string, options?: Record<string, unknown>) => i18n.t(`analysis:${key}`, options);
/** A number's name on the card. */
export const cardLabel = (key: CardNumber) => ({
  tokens: say("usage.tokens"), finished: say("tasks.finished"), share: say("card.passed"),
  runMs: say("card.runMs"), prs: say("card.prs"), model: say("card.model"),
})[key];

/** Everything a drawing writes, already in words: it reads nothing else. */
export type CardInput = {
  kicker: string; span: string; days: string;
  hero: { label: string; figure: Figure };
  rest: { label: string; figure: Figure }[];
  grass: (number | null)[][] | null;
};
export function cardInput(facts: CardFacts, choice: CardChoice): CardInput {
  const picks = cardPicks(choice, facts);
  const entry = (key: CardNumber) => ({ label: cardLabel(key), figure: cardFigure(facts, key)! });
  return {
    kicker: say("card.kicker"),
    span: facts.from === facts.to ? dateLabel(facts.from) : say("range", { from: dateLabel(facts.from), to: dateLabel(facts.to) }),
    days: say("card.days", { count: daysBetween(facts.from, facts.to) }),
    hero: entry(picks.hero), rest: picks.rest.map(entry), grass: picks.grass ? facts.grass : null,
  };
}

/** A figure as words: its unit after it, with a space where the language puts one. */
const figureWords = (figure: Figure) => figure.unit ? `${figure.value}${figure.spaced || figure.words ? " " : ""}${figure.unit}` : figure.value;
/** What the card says, in the order it is read, for those who hear it rather than see it. */
export const cardWords = (input: CardInput) => [`${input.kicker} ${input.span} ${input.days}`,
  ...[input.hero, ...input.rest].map(entry => `${entry.label} ${figureWords(entry.figure)}`)].join(", ");

/**
 * The first words of the person's post on X, in their own voice: one sentence a lead number makes (tokens of work handed
 * to AI, tasks it finished, the share done without rework), over the card's days ("these 7 days") or the whole record
 * ("so far"), then the tag. Only what the card shows: no task, project or title. They are the person's to change.
 */
export function cardPostText(facts: CardFacts, choice: CardChoice, whole: boolean): string {
  const hero = cardPicks(choice, facts).hero, days = daysBetween(facts.from, facts.to);
  const value = hero === "tokens" ? spoken(facts.tokens) : hero === "finished" ? written("plain", facts.finished).value : `${shareParts(facts.share!).value}%`;
  const sentence = {
    tokens: whole ? say("card.postTokensAll", { value }) : say("card.postTokens", { value, days }),
    finished: whole ? say("card.postFinishedAll", { value, count: facts.finished }) : say("card.postFinished", { value, days, count: facts.finished }),
    share: whole ? say("card.postShareAll", { value }) : say("card.postShare", { value, days }),
  }[hero];
  return `${sentence} #alpacawork`;
}

/** The card's file: alpacawork-<first day>_<last day>.png. */
export const cardFileName = (facts: Pick<CardFacts, "from" | "to">) => `alpacawork-${facts.from}_${facts.to}.png`;
