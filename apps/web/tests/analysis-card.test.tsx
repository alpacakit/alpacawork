import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { CARD_DEFAULT, canPick, cardFacts, cardFileName, cardInput, cardPicks, cardPostText, cardWords, pick, type CardChoice } from "../src/features/analysis/card";
import { analysisValues, cardDays, cardSpanOf, readAnalysis } from "../src/features/analysis/place";
import { drawCard, type CardLook } from "../src/features/analysis/card-draw";
import type { TasksView, UsageView } from "../src/features/analysis/contract";
import { daysBetween } from "../src/features/analysis/format";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("ja"); });

const head = { timeZone: "Asia/Tokyo", today: "2026-11-25", firstDay: "2026-10-01", project: null,
  period: { from: "2026-11-19", to: "2026-11-25" }, previous: null };
const taskCounts = { passed: 900, reworked: 300, stopped: 128, doneUnaccepted: 0, accepted: 1200, finished: 1328, share: 0.75 };
const accepted = { leadMedianMs: null, submits: 0, questions: 0, prs: 412, time: { review: 0, answer: 0, ai: 0, other: 0 },
  waits: { away: 0, otherTasks: 0, thisTask: 0 }, answerItems: { total: 0, choice: 0, recommended: 0, recommendable: 0, other: 0, stop: 0, unmatched: 0 }, decisions: { total: 0, unclassifiedInstructions: 0, taken: [], causes: [], aspects: [], by: { user: { taken: [], causes: [], aspects: [] }, ai: { taken: [], causes: [], aspects: [] } } }, questionsReplaced: 0, noQuestions: 0, passedNoQuestions: 0,
  rounds: { first: { ms: 0, tokens: 0 }, later: { ms: 0, tokens: 0 } } };
const usageCounts = { launches: 3, runMs: 147.4 * 3_600_000, live: 0, newConversations: 1,
  tokens: { output: 24_000_000, input: 100_000_000, cache: 1_116_000_000 }, tokensUnknown: 0, tasks: 3 };
// What the analysis answers besides numbers (a project's ID and title) must never reach the card.
const tasks = { head: { ...head, project: "P9" }, counts: { value: taskCounts, previous: null }, accepted: { value: accepted, previous: null }, ever: null,
  series: { bucket: "day", points: [] }, grass: { from: "2026-09-28", finished: Array.from({ length: 63 }, (_, at) => at % 5) },
  breakdown: { by: "project", rows: [{ key: "P9", label: "Secret project", finished: 3, accepted: 3, passed: 3, share: null, leadMedianMs: null, submitsPerAccepted: null }] },
  activeWork: [], unfinished: { tasks: 0, time: { review: 0, answer: 0 }, waits: { away: 0, otherTasks: 0, thisTask: 0 } } } as TasksView;
const usage = { head, counts: { value: usageCounts, previous: null }, ever: null, series: { bucket: "day", points: [] },
  breakdown: { by: "model", since: null, counted: null, groups: null, series: null, rows: [
    { key: "a", label: "claude-opus-5-5-extended", model: { name: "claude-opus-5-5-extended" }, counts: usageCounts, calls: null },
    { key: "b", label: "opus", model: { name: "opus" }, counts: { ...usageCounts, launches: 1 }, calls: null }] } } as UsageView;

const now = <T,>(data: T) => ({ data, current: true });

test("a card is drawn only from answers for what is asked now: one still standing for another project or other days gives none", () => {
  expect(cardFacts(now(tasks), { data: tasks, current: false }, now(usage))).toBeUndefined();
  expect(cardFacts(now(tasks), now(tasks), null)).toBeUndefined();
  // No record says so at once, without waiting for an answer the card no longer needs (or never asked).
  const none = { ...tasks, head: { ...tasks.head, firstDay: null, period: null } };
  expect(cardFacts(now(none), null, null)).toBeNull();
  expect(cardFacts(now(tasks), now({ ...tasks, head: { ...tasks.head, period: null } }), null)).toBeNull();
});

test("a card uses measured totals and the most-used model across efforts", () => {
  const facts = cardFacts(now(tasks), now(tasks), now(usage))!;
  expect(facts).toMatchObject({ from: "2026-11-19", to: "2026-11-25", tokens: 1_240_000_000, finished: 1328, share: 0.75, prs: 412,
    model: "claude-opus-5-5-extended" });
  // Monday on top, the newest 13 weeks at most; days after today or before the record are not drawn.
  expect(facts.grass.length).toBeLessThanOrEqual(13);
  const input = cardInput(facts, { ...CARD_DEFAULT, numbers: ["finished", "share", "runMs", "prs"] });
  expect(input.hero).toMatchObject({ label: "トークン", figure: { value: "12.4", unit: "億" } });
  expect(input.rest.map(entry => `${entry.label} ${entry.figure.value}${entry.figure.unit}`)).toEqual(["終わったタスク 1,328件", "手直しなしで完了 75%", "AI の実行時間 147時間"]);
  expect(cardFileName(facts)).toBe("alpacawork-2026-11-19_2026-11-25.png");
});

test("at most three ride under the lead; a share under ten accepted can neither lead nor be chosen", () => {
  const facts = cardFacts(now(tasks), now(tasks), now(usage))!;
  const full: CardChoice = { ...CARD_DEFAULT, numbers: ["finished", "share", "model"] };
  expect(canPick(full, facts, "prs")).toBe(false);
  expect(canPick(full, facts, "share")).toBe(true);
  expect(cardPicks(pick(full, facts, "share"), facts).rest).toEqual(["finished", "model"]);
  // Another lead: it leaves the numbers under it, the tokens may ride there.
  expect(cardPicks({ ...full, hero: "finished", numbers: ["tokens", "finished", "share"] }, facts)).toMatchObject({ hero: "finished", rest: ["tokens", "share"] });
  const few = { ...facts, share: null };
  expect(cardPicks({ ...full, hero: "share" }, few)).toMatchObject({ hero: "tokens", rest: ["finished", "model"] });
  expect(canPick(full, few, "share")).toBe(false);
});

test("the card holds only what it is given, and a long model name stays inside its column", () => {
  const facts = cardFacts(now(tasks), now(tasks), now(usage))!;
  const width = (words: string, size: number) => words.length * size * 0.6;
  const look: CardLook = { palette: { bg: "#000000", ink: "#ffffff", muted: "#cccccc", line: "#333333", grass: ["#111111", "#222222", "#333333", "#444444", "#555555"] },
    font: "sans-serif", icon: "data:image/png;base64,", measure: width, ink: () => ({ left: 0, ascent: 0, descent: 0 }) };
  const input = cardInput(facts, { ...CARD_DEFAULT, hero: "finished" });
  const svg = drawCard(input, look);
  for (const out of [svg, cardWords(input), cardFileName(facts)]) expect(out).not.toMatch(/Secret|P9|opus\(|T\d/);
  // The model's name stays within a third of the card, less the gap.
  const line = [...new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("text")].find(text => text.textContent!.startsWith("claude-opus"))!;
  const drawn = [...line.childNodes].reduce((sum, node) => {
    const size = Number((node instanceof Element ? node : line).getAttribute("font-size"));
    return sum + width(node.textContent!, size) + Number(node instanceof Element ? node.getAttribute("dx") ?? 0 : 0);
  }, 0);
  expect(drawn).toBeLessThanOrEqual((1200 - 128) / 3 - 40);
  expect(cardWords(input)).toContain("claude-opus-5-5-extended");
});

test("Japanese writes a card's tokens in 万・億, a count rounding up to the next word in it; other languages keep k・M・B", async () => {
  const facts = cardFacts(now(tasks), now(tasks), now(usage))!;
  const tokens = (count: number) => { const each = cardInput({ ...facts, tokens: count }, { ...CARD_DEFAULT, hero: "finished", numbers: ["tokens"] }).rest[0]!.figure; return `${each.value}${each.unit}`; };
  expect([9_876, 9_999.6, 12_345, 99_995_000, 13_812_345_678, 999_950_000_000].map(tokens)).toEqual(["9,876", "1万", "1.23万", "1億", "138億", "1兆"]);
  await i18n.changeLanguage("en");
  try { expect(tokens(13_812_345_678)).toBe("13.8B"); } finally { await i18n.changeLanguage("ja"); }
});

test("the card's days are a length and the day the analysis ended on: another length keeps the day, a day opens a week", () => {
  expect(cardSpanOf({ period: "today" })).toEqual({ length: "7d", end: null });
  expect(cardSpanOf({ from: "2026-11-18", to: "2026-11-18" })).toEqual({ length: "7d", end: "2026-11-18" });
  const stepped = cardSpanOf({ from: "2026-11-12", to: "2026-11-18" });
  const whole = { ...stepped, length: "all" as const }, week = { ...whole, length: "7d" as const };
  expect(cardDays(whole, "2026-10-01")).toEqual({ from: "2026-10-01", to: "2026-11-18" });
  expect(cardDays(week, "2026-10-01")).toEqual({ from: "2026-11-12", to: "2026-11-18" });
  // The URL keeps both: a reload or Back finds the same days.
  const place = readAnalysis(new URLSearchParams("face=analysis&card=28d~2026-11-18"))!;
  expect(place.card).toEqual({ length: "28d", end: "2026-11-18" });
  expect(readAnalysis(new URLSearchParams(new URLSearchParams(analysisValues(place)).toString()))!.card).toEqual(place.card);
});

test("the post begins with the lead number in a sentence of its own, over the card's days or, for the whole record, so far", () => {
  const facts = cardFacts(now(tasks), now(tasks), now(usage))!;
  const post = (hero: CardChoice["hero"], whole = false) => cardPostText(facts, { ...CARD_DEFAULT, hero }, whole);
  expect(post("tokens")).toContain("12.4億トークン");
  expect(post("finished")).toContain("1,328");
  expect(post("share")).toContain("75%");
  for (const hero of ["tokens", "finished", "share"] as const) {
    expect(post(hero)).toMatch(/7.*#alpacawork$/);
    // The whole record is not said in days.
    expect(post(hero, true)).not.toContain(String(daysBetween(facts.from, facts.to)) + "日");
    expect(post(hero, true)).not.toEqual(post(hero));
  }
  expect(post("tokens")).not.toMatch(/Secret|P9/);
});
