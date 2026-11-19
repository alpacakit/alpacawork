/**
 * A project's mark: a square in the project's colour with letters from its name. The letters are
 * not kept anywhere; the colour is the project's `settings.color`, six lowercase hex digits.
 */

/**
 * What a name may start with that is no letter: spaces, punctuation and symbols, and the marks and invisible characters
 * that come with them (an emoji's variation selector U+FE0F, a joiner U+200D, a zero-width space).
 */
const LEAD = /[\s\p{P}\p{S}\p{M}\p{C}]/u;
const ASCII_ALNUM = /^[A-Za-z0-9]$/;
const graphemes = new Intl.Segmenter();

/**
 * The letters a project's square carries: past any leading spaces and symbols, the first two of a run of ASCII letters
 * and digits (letters upper-cased: alpacawork → AL, 2024 plan → 20, Aéro → A), else the one character there
 * (éclair → é; e with a combining acute accent stays one grapheme); P when nothing is left.
 */
export function markLetters(name: string): string {
  let letters = "";
  for (const { segment } of graphemes.segment(name)) {
    if (!letters && [...segment].every((character) => LEAD.test(character))) continue;
    if (!ASCII_ALNUM.test(segment)) return letters.toUpperCase() || segment;
    letters += segment;
    if (letters.length === 2) return letters.toUpperCase();
  }
  return letters.toUpperCase() || "P";
}

/** `#rrggbb` from exactly six hex digits, with or without its `#`; null for anything else. */
export function sixDigitColor(text: string): string | null {
  const digits = /^#?([0-9a-f]{6})$/i.exec(text.trim())?.[1];
  return digits ? `#${digits.toLowerCase()}` : null;
}

/** `#rrggbb` from six hex digits or three (each doubled: abc → #aabbcc); null for anything else. */
export function shortOrFullColor(text: string): string | null {
  const three = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text.trim());
  return three ? `#${three.slice(1).map((digit) => digit + digit).join("").toLowerCase()}` : sixDigitColor(text);
}

const RGB_OFFSETS = [1, 3, 5] as const;

/** WCAG relative luminance of a `#rrggbb` colour. */
function luminance(color: string): number {
  const [r, g, b] = RGB_OFFSETS.map((at) => {
    const channel = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrastFromLuminances(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  return contrastFromLuminances(luminance(a), luminance(b));
}

/** The letters' colour on a square of `color`: white or black, whichever has the higher contrast, compared unrounded. */
export function inkOn(color: string): "#ffffff" | "#000000" {
  const background = luminance(color);
  return contrastFromLuminances(background, luminance("#ffffff")) >= contrastFromLuminances(background, luminance("#000000")) ? "#ffffff" : "#000000";
}

/** The often-used colours offered first (eight, at their dark-theme depth), in the order a new project takes them. */
export const MARK_SWATCHES = [
  { key: "navy", color: "#39659b" }, { key: "lime", color: "#b6b857" }, { key: "brown", color: "#8e5224" },
  { key: "violet", color: "#d597de" }, { key: "green", color: "#337344" }, { key: "indigo", color: "#84b2fd" },
  { key: "grape", color: "#715391" }, { key: "teal", color: "#31c8c9" },
] as const;

/** OKLab of a `#rrggbb` colour, to measure how far apart two colours look. */
function oklab(color: string): [number, number, number] {
  const [r, g, b] = RGB_OFFSETS.map((at) => {
    const channel = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/**
 * A new project's colour: the often-used colour farthest from every colour the projects already have (the nearest one
 * the farthest away); the first in order on a tie, so the first project takes navy.
 */
export function newProjectColor(used: readonly string[]): string {
  let best: string = MARK_SWATCHES[0].color, room = -1;
  if (!used.length) return best;
  const others = used.map(oklab);
  for (const { color } of MARK_SWATCHES) {
    const left = oklab(color);
    let nearest = Infinity;
    for (const other of others) {
      // A sparse hole previously spread as undefined into Math.min, making the minimum NaN.
      nearest = Math.min(nearest, other ? Math.hypot(left[0] - other[0], left[1] - other[1], left[2] - other[2]) : NaN);
    }
    if (nearest > room + 1e-9) { best = color; room = nearest; }
  }
  return best;
}
