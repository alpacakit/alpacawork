import type { CardInput, Figure } from "./card";
import { CARD_H, CARD_W } from "./card-size";

/**
 * The card's drawing: a pure function from what the card says (`CardInput`) and how it looks (`CardLook`) to plain
 * SVG, so the picture on the page is the picture that is saved, and it needs nothing from the page (its colours sRGB,
 * its mark inline).
 */
const PAD = 64;
/** The baselines: the head line, the lead number, and the rule under it. */
const HEAD_Y = 94, HERO_Y = 410, RULE_Y = 462;
/**
 * The small words (the head line, the numbers' names) and the brand, sized to stay legible when the card is shown at a
 * third of its width, as a timeline shows it.
 */
const SMALL = 33, BRAND_SIZE = 31, BRAND_MARK = 42;

/** The colours of one theme, as tokens.css gives them (read on the page), in sRGB. `grass`: the calendar's five levels. */
export type CardPalette = { bg: string; ink: string; muted: string; line: string; grass: [string, string, string, string, string] };
/**
 * `measure`: a text's width in the card's font at a size and weight, so a long name or number takes a smaller size where
 * its room is narrow. `bearing`: how far right of where it is set a text's first glyph begins to be drawn, so a large
 * number or name starts on the card's left edge however large it is (a 236px "1" stands well right of its origin).
 */
type Gauge = (text: string, size: number, weight: number) => number;
export type CardLook = { palette: CardPalette; font: string; icon: string; measure: Gauge; bearing: Gauge };

const esc = (text: string) => text.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const text = (x: number, y: number, size: number, weight: number, fill: string, body: string, more = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${more}>${body}</text>`;
/** The size a text takes so it is no wider than `room`, at most `size`. */
const fit = (look: CardLook, words: string, size: number, weight: number, room: number) =>
  Math.max(1, Math.floor(Math.min(size, size * room / Math.max(1, look.measure(words, size, weight)))));

/**
 * A number and its unit on one baseline, the unit small beside it; a model's name in words, a step smaller, its effort
 * small after it as a unit is. Each takes a smaller size where it would be wider than `room`.
 */
function figure(look: CardLook, x: number, y: number, size: number, item: Figure, room: number) {
  const base = item.words ? Math.round(size * 0.72) : size, weight = item.words ? 700 : 750;
  // The unit beside the lead number is a third of it, so the number leads and a broad glyph (億) does not compete.
  const unitShare = base >= 120 ? 0.36 : 0.6, gap = item.words || item.spaced ? 0.25 : 0.05;
  const wide = look.measure(item.value, base, weight) + (item.unit ? base * gap + look.measure(item.unit, base * unitShare, 700) : 0);
  const at = Math.max(1, Math.floor(Math.min(base, base * room / Math.max(1, wide))));
  // A model's effort is a step lighter than its name, as a unit is beside its number but quieter still.
  const unit = item.unit ? `<tspan font-size="${Math.round(at * unitShare)}" font-weight="${item.words ? 500 : 700}" dx="${Math.round(at * gap)}">${esc(item.unit)}</tspan>` : "";
  const spacing = item.words ? `letter-spacing="-0.5"` : `letter-spacing="${(-at * 0.025).toFixed(1)}" font-variant-numeric="tabular-nums"`;
  return text(edge(look, x, item.value, at, weight), y, at, weight, look.palette.ink, esc(item.value) + unit, spacing);
}

/** Where a large text starts so that its first glyph is drawn on `x` (a large glyph's own left space is wide). */
const edge = (look: CardLook, x: number, words: string, size: number, weight: number) => Math.round(x - look.bearing(words, size, weight));

/** Whose numbers these are: the mark and the name, small, ending at `x`. */
function brand(look: CardLook, x: number, y: number) {
  const size = BRAND_MARK, name = "alpacawork", wide = look.measure(name, BRAND_SIZE, 700);
  return `<image href="${look.icon}" x="${Math.round(x - wide - 14 - size)}" y="${Math.round(y - size * 0.8)}" width="${size}" height="${size}"/>`
    + text(x, y, BRAND_SIZE, 700, look.palette.ink, name, `text-anchor="end" letter-spacing="-0.2"`);
}
/** What the numbers are of and for which days, on one line: the words in ink, the days and their count after them. */
function head(look: CardLook, input: CardInput, room: number) {
  const line = `${input.kicker}    ${input.span}   ${input.days}`;
  const size = fit(look, line, SMALL, 650, room);
  return text(PAD, HEAD_Y, size, 500, look.palette.muted, `<tspan font-weight="650" fill="${look.palette.ink}">${esc(input.kicker)}</tspan>`
    + `<tspan dx="${Math.round(size * 0.6)}">${esc(input.span)}</tspan><tspan dx="${Math.round(size * 0.55)}">${esc(input.days)}</tspan>`);
}
/** The calendar, whole weeks with Monday on top, its newest column ending at `right`; its width. */
/**
 * The calendar, whole weeks with Monday on top, its newest column ending at `right` and its foot on `bottom`; its width.
 * A day outside the record (before it began, after today) is a small dot, as the analysis's calendar draws it, so the
 * weeks stand whole.
 */
function grass(look: CardLook, weeks: (number | null)[][], right: number, bottom: number, pitch: number) {
  const cell = pitch * 0.8, left = right - weeks.length * pitch + (pitch - cell);
  let out = "";
  weeks.forEach((week, column) => week.forEach((level, row) => {
    const x = left + column * pitch, y = bottom - (7 - row) * pitch + (pitch - cell);
    if (level === null) {
      out += `<circle cx="${(x + cell / 2).toFixed(1)}" cy="${(y + cell / 2).toFixed(1)}" r="${(cell * 0.1).toFixed(1)}" fill="${look.palette.line}"/>`;
      return;
    }
    out += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell.toFixed(1)}" height="${cell.toFixed(1)}" rx="${(cell * 0.2).toFixed(1)}" fill="${look.palette.grass[level]}"/>`;
  }));
  return { svg: out, width: weeks.length * pitch - (pitch - cell) };
}
const frame = (look: CardLook, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" `
  + `height="${CARD_H}" font-family="${esc(look.font)}"><rect width="${CARD_W}" height="${CARD_H}" fill="${look.palette.bg}"/>${body}</svg>`;

/** One number leads, its name over it, the calendar beside it when chosen; up to three ride under a line. */
export function drawCard(input: CardInput, look: CardLook): string {
  const brandRoom = look.measure("alpacawork", BRAND_SIZE, 700) + 14 + BRAND_MARK + 32;
  let body = head(look, input, CARD_W - PAD * 2 - brandRoom) + brand(look, CARD_W - PAD, HEAD_Y);
  // The calendar stands beside the number alone, as tall as its figures, its foot on their line.
  const cal = input.grass?.length ? grass(look, input.grass, CARD_W - PAD, HERO_Y, 25) : null;
  const heroRoom = CARD_W - PAD * 2 - (cal ? cal.width + 48 : 0);
  const heroLabel = fit(look, input.hero.label, 40, 650, heroRoom);
  // The lead's name is large enough that its first glyph's own left space shows: it starts on the edge as the number does.
  body += text(edge(look, PAD, input.hero.label, heroLabel, 650), 200, heroLabel, 650, look.palette.ink, esc(input.hero.label));
  body += figure(look, PAD, HERO_Y, 236, input.hero.figure, heroRoom);
  if (cal) body += cal.svg;
  // The rule as far below the lead's line as the figures under it stand below the rule.
  body += `<rect x="${PAD}" y="${RULE_Y}" width="${CARD_W - PAD * 2}" height="1.5" fill="${look.palette.line}"/>`;
  const step = (CARD_W - PAD * 2) / 3;
  input.rest.forEach((entry, at) => {
    const x = Math.round(PAD + at * step), room = step - 40;
    body += figure(look, x, RULE_Y + 86, 60, entry.figure, room)
      + (() => { const size = fit(look, entry.label, SMALL, 500, room);
        return text(x, RULE_Y + 140, size, 500, look.palette.muted, esc(entry.label)); })();
  });
  return frame(look, body);
}
