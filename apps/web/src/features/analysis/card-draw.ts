import type { CardInput, Figure } from "./card";
import { CARD_H, CARD_W } from "./card-size";

/**
 * The card's drawing: a pure function from what the card says (`CardInput`) and how it looks (`CardLook`) to plain
 * SVG, so the picture on the page is the picture that is saved, and it needs nothing from the page (its colours sRGB,
 * its mark inline).
 */
const PAD = 64;
/**
 * The baselines, top to bottom: the head line, the lead's name, the lead number, the rule, the numbers under it and
 * their names. The card's ink starts as far below its top as it ends above its foot, and a block's name stands as close
 * to its number as the number below it stands to its own name.
 */
const HEAD_Y = 92, LABEL_Y = 214, HERO_Y = 412, RULE_Y = 470, REST_Y = 552, REST_LABEL_Y = 602;
/**
 * The sizes: the small words (the head line, the brand, the numbers' names), sized to stay legible when the card is
 * shown at a third of its width, as a timeline shows it; the lead's name; the lead number; the numbers under it.
 */
const SMALL = 30, LABEL = 38, HERO = 232, REST = 58, BRAND_MARK = 40, BRAND_GAP = 12;

/** The colours of one theme, as tokens.css gives them (read on the page), in sRGB. `grass`: the calendar's five levels. */
export type CardPalette = { bg: string; ink: string; muted: string; line: string; grass: [string, string, string, string, string] };
/**
 * `measure`: a text's width in the card's font at a size and weight, so a long name or number takes a smaller size where
 * its room is narrow. `ink`: where a text's drawn glyphs stand from where it is set: `left`, how far right its first
 * glyph begins (a 232px "1" stands well right of its origin); `ascent` and `descent`, how far above and below the
 * baseline they reach. With them a large text starts on the card's left edge, a unit stands on its number's baseline
 * (a Han character reaches below it), and the mark centres on its name's glyphs rather than on the font's box.
 */
type Gauge<T> = (text: string, size: number, weight: number) => T;
export type Ink = { left: number; ascent: number; descent: number };
export type CardLook = { palette: CardPalette; font: string; icon: string; measure: Gauge<number>; ink: Gauge<Ink> };

const esc = (text: string) => text.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
const text = (x: number, y: number, size: number, weight: number, fill: string, body: string, more = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${more}>${body}</text>`;
/** The size a text takes so it is no wider than `room`, at most `size`. */
const fit = (look: CardLook, words: string, size: number, weight: number, room: number) =>
  Math.max(1, Math.floor(Math.min(size, size * room / Math.max(1, look.measure(words, size, weight)))));
/** Where a text starts so that its first glyph is drawn on `x` (a large glyph's own left space is wide). */
const edge = (look: CardLook, x: number, words: string, size: number, weight: number) => Math.round(x - look.ink(words, size, weight).left);
const tracking = (size: number, share: number) => `letter-spacing="${(size * share).toFixed(1)}"`;

/**
 * A number and its unit on one baseline, the unit smaller and a step lighter beside it, its glyphs standing on the
 * number's baseline; a model's name in words, a step smaller, its effort small after it as a unit is. Each takes a
 * smaller size where it would be wider than `room`.
 */
function figure(look: CardLook, x: number, y: number, size: number, item: Figure, room: number) {
  const base = item.words ? Math.round(size * 0.72) : size, weight = item.words ? 650 : 700;
  // The unit beside the lead number is a third of it, so the number leads and a broad glyph (M, 億) does not compete.
  const unitShare = item.words ? 0.6 : base >= 120 ? 0.36 : 0.56, gap = item.words || item.spaced ? 0.22 : 0.04;
  // Large figures close up a little, as display type does; the names keep their own spacing.
  const track = item.words ? -0.01 : base >= 120 ? -0.012 : -0.01;
  const unitWeight = item.words ? 500 : 600;
  const wide = look.measure(item.value, base, weight) + item.value.length * base * track
    + (item.unit ? base * gap + look.measure(item.unit, base * unitShare, unitWeight) : 0);
  const at = Math.max(1, Math.floor(Math.min(base, base * room / Math.max(1, wide))));
  const unitSize = Math.round(at * unitShare);
  // A unit's glyphs stand on the number's line: a Han character (億, 件) reaches below the baseline, so it is lifted by as much.
  const lift = item.unit && !item.words ? Math.round(look.ink(item.unit, unitSize, unitWeight).descent) : 0;
  const unit = item.unit ? `<tspan font-size="${unitSize}" font-weight="${unitWeight}" dx="${Math.round(at * gap)}"${lift > 0 ? ` dy="${-lift}"` : ""} letter-spacing="0">${esc(item.unit)}</tspan>` : "";
  return text(edge(look, x, item.value, at, weight), y, at, weight, look.palette.ink, esc(item.value) + unit, tracking(at, track));
}

/**
 * Whose numbers these are: the mark and the name, ending at `x`, the name on the head line's baseline and the mark
 * centred on the name's drawn glyphs (from its ascenders to its descender), not on the font's box.
 */
function brand(look: CardLook, x: number, y: number) {
  const name = "alpacawork", wide = look.measure(name, SMALL, 700), glyphs = look.ink(name, SMALL, 700);
  const middle = y - (glyphs.ascent - glyphs.descent) / 2;
  return `<image href="${look.icon}" x="${Math.round(x - wide - BRAND_GAP - BRAND_MARK)}" y="${(middle - BRAND_MARK / 2).toFixed(1)}" width="${BRAND_MARK}" height="${BRAND_MARK}"/>`
    + text(x, y, SMALL, 700, look.palette.ink, name, `text-anchor="end" letter-spacing="-0.3"`);
}
const brandWidth = (look: CardLook) => look.measure("alpacawork", SMALL, 700) + BRAND_GAP + BRAND_MARK;
/** What the numbers are of in ink, then for which days and how many, quieter, on one line. */
function head(look: CardLook, input: CardInput, room: number) {
  const size = fit(look, `${input.kicker}  ${input.span}  ${input.days}`, SMALL, 600, room);
  return text(edge(look, PAD, input.kicker, size, 650), HEAD_Y, size, 400, look.palette.muted,
    `<tspan font-weight="650" fill="${look.palette.ink}">${esc(input.kicker)}</tspan>`
    + `<tspan dx="${Math.round(size * 0.75)}">${esc(input.span)}</tspan><tspan dx="${Math.round(size * 0.5)}">${esc(input.days)}</tspan>`);
}
/**
 * The calendar, whole weeks with Monday on top, its newest column ending at `right`, its foot on `bottom` and its seven
 * rows as tall as `height`; its width. A day outside the record (before it began, after today) is a small dot, as the
 * analysis's calendar draws it, so the weeks stand whole.
 */
function grass(look: CardLook, weeks: (number | null)[][], right: number, bottom: number, height: number) {
  const pitch = height / (7 - 0.2), cell = pitch * 0.8, left = right - weeks.length * pitch + (pitch - cell);
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

/**
 * One number leads, its name over it, the calendar beside it when chosen; up to three ride under a line, each in a
 * third of the card. With none under it, the lead stands in the middle of the room under the head line.
 */
export function drawCard(input: CardInput, look: CardLook): string {
  let body = head(look, input, CARD_W - PAD * 2 - brandWidth(look) - 48) + brand(look, CARD_W - PAD, HEAD_Y);
  const drop = input.rest.length ? 0 : Math.round((CARD_H - REST_LABEL_Y + RULE_Y - HERO_Y) / 2);
  const heroY = HERO_Y + drop;
  // The calendar stands beside the number alone, as tall as its figures, its foot on their line.
  const figures = look.ink("0123456789", HERO, 700).ascent;
  const cal = input.grass?.length ? grass(look, input.grass, CARD_W - PAD, heroY, figures) : null;
  const heroRoom = CARD_W - PAD * 2 - (cal ? cal.width + 56 : 0);
  const heroLabel = fit(look, input.hero.label, LABEL, 600, heroRoom);
  body += text(edge(look, PAD, input.hero.label, heroLabel, 600), LABEL_Y + drop, heroLabel, 600, look.palette.ink, esc(input.hero.label));
  body += figure(look, PAD, heroY, HERO, input.hero.figure, heroRoom);
  if (cal) body += cal.svg;
  if (!input.rest.length) return frame(look, body);
  body += `<rect x="${PAD}" y="${RULE_Y}" width="${CARD_W - PAD * 2}" height="1.5" fill="${look.palette.line}"/>`;
  const step = (CARD_W - PAD * 2) / 3;
  input.rest.forEach((entry, at) => {
    const x = Math.round(PAD + at * step), room = step - 40;
    const size = fit(look, entry.label, SMALL, 400, room);
    body += figure(look, x, REST_Y, REST, entry.figure, room)
      + text(edge(look, x, entry.label, size, 400), REST_LABEL_Y, size, 400, look.palette.muted, esc(entry.label));
  });
  return frame(look, body);
}
