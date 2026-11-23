import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stylesheet } from "./stylesheet";

const src = fileURLToPath(new URL("../src/", `file://${__filename}`));
const sources = readdirSync(src, { recursive: true, encoding: "utf8" }).filter(name => /\.tsx?$/.test(name))
  .map(file => [file, readFileSync(src + file, "utf8")] as const);
const STEPS = ["micro", "xs", "sm", "base", "md", "lg", "xl", "seal", "display", "display-compact"];
const steppedLineHeight = new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(text-(?:${STEPS.join("|")})/[^\\s"'\\x60]+)`, "g");

/**
 * What in a part's source sets a size, a line height or a letter spacing other than by choosing a step: a named or
 * numbered `leading-*`/`tracking-*`, a step with a line height after a slash (`text-base/7`), a size in brackets
 * (`text-[15px]`, `text-[length:…]`), a bracketed property (`[line-height:1.7]`), or a value written into a style. A
 * style that copies another element's measured value (`lineHeight: style.lineHeight`) is a copy, not a value.
 */
export function ownType(text: string): string[] {
  const found = [
    ...text.matchAll(/(?<![\w-])(?:[\w-]+:)*((?:leading|tracking)-[^\s"'`]+)/g),
    ...text.matchAll(steppedLineHeight),
    ...text.matchAll(/(?<![\w-])(?:[\w-]+:)*(text-\[[^\]]*\])/g),
    ...text.matchAll(/(\[(?:font-size|line-height|letter-spacing|font):[^\]]*\])/g),
    ...text.matchAll(/\b((?:fontSize|lineHeight|letterSpacing|font)\s*:\s*(?:["'`]|\d))/g),
    ...text.matchAll(/(\.style\.(?:fontSize|lineHeight|letterSpacing|font)\s*=\s*(?:["'`]|\d))/g),
    ...text.matchAll(/(@apply[^;]*\b(?:leading|tracking)-[^\s;]+)/g),
    ...text.matchAll(/(setProperty\(\s*["'](?:font-size|line-height|letter-spacing)["'])/g),
  ].map(match => match[1]!);
  return found.filter(name => !/^text-\[(?:var\(--|#|color:)/.test(name));
}

/**
 * What may still set its own: a label's box and the marks laid over a picture or a corner (one line, as tall as their
 * letters).
 */
const OWN = new Map([
  ["features/coordinator/label-style.ts", ["leading-none"]],
  ["features/tree/TimeTree.tsx", ["leading-none"]],
  ["features/reader/TaskMedia.tsx", ["leading-none"]],
]);
/** The stylesheet's own type declarations: the body's step, the external link's mark (a size of the letter it follows), the
 * label's strut (the text's size). */
const SHEET = [
  "font: var(--text-base) / var(--text-base--line-height) var(--font-sans)",
  "letter-spacing: var(--text-base--letter-spacing)",
  "font-size: 0.85em",
  "font-size: var(--label-text-size)",
  "line-height: normal",
];

describe("type steps", () => {
  it("gives every size step its line height and letter spacing, in one place", () => {
    for (const step of STEPS) {
      expect(stylesheet, step).toMatch(new RegExp(`--text-${step}:`));
      expect(stylesheet, step).toMatch(new RegExp(`--text-${step}--line-height:`));
      expect(stylesheet, step).toMatch(new RegExp(`--text-${step}--letter-spacing:`));
      // Sizes in rem follow the reader's own text size; a line height is a bare ratio and a letter spacing em, so both
      // follow the size.
      expect(stylesheet, step).toMatch(new RegExp(`--text-${step}:\\s*(?:[\\d.]+rem|clamp\\([\\d.]+rem, [\\d.]+vw, [\\d.]+rem\\));`));
      expect(stylesheet, step).toMatch(new RegExp(`--text-${step}--line-height:\\s*(?:calc\\(\\d+ / \\d+\\)|1);`));
      expect(stylesheet, step).toMatch(new RegExp(`--text-${step}--letter-spacing:\\s*-?[\\d.]+em;`));
    }
    // Tailwind's own names are taken away, and none is named again.
    expect(stylesheet).toMatch(/--leading-\*:\s*initial;/);
    expect(stylesheet).toMatch(/--tracking-\*:\s*initial;/);
    expect(stylesheet).not.toMatch(/--leading-(?!\*)[a-z]+:/);
    expect(stylesheet).not.toMatch(/--tracking-(?!\*)[a-z]+:/);
  });

  it("finds each way a part could set its own", () => {
    for (const written of ["leading-tight", "narrow:leading-[1.7]", "tracking-wide", "text-base/7", "text-display-compact/7", "text-[15px]", "text-[length:15px]",
      "[line-height:1.7]", "[letter-spacing:0.02em]", "fontSize: 13", "lineHeight: \"20px\"", "el.style.letterSpacing = \"1px\"",
      "style.setProperty(\"line-height\", \"2\")", "font: \"15px/2 sans-serif\"", "@apply leading-none;"])
      expect(ownType(`<p className="m-0 ${written}" />`), written).not.toEqual([]);
    for (const step of ["text-base", "text-xs tabular-nums", "text-[var(--ink)]", "lineHeight: style.lineHeight"])
      expect(ownType(`<p className="${step}" />`), step).toEqual([]);
  });

  it("leaves size, line height and letter spacing to the step in every part", () => {
    for (const [file, text] of sources)
      expect(ownType(text).filter(name => !OWN.get(file)?.includes(name)), file).toEqual([]);
  });

  it("writes no type of its own in the stylesheet, out of the theme", () => {
    const rules = stylesheet.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@theme\s*\{[\s\S]*?\n\}/, "");
    const declared = [...rules.matchAll(/(?:^|[;{\s])((?:font-size|line-height|letter-spacing|font)\s*:\s*[^;]+);/g)].map(match => match[1]!.trim());
    // Each of the stylesheet's own once, where it is said: a second `line-height: normal` elsewhere is a value of its own.
    expect([...declared].sort()).toEqual([...SHEET].sort());
    expect(rules).not.toMatch(/@apply[^;]*\b(?:leading|tracking)-/);
  });
});
