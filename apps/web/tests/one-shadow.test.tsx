import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { draw, shapeOf, type Look } from "../src/features/reader/answer-cue-view";
import { resting } from "../src/features/reader/answer-cue-motion";
import { stylesheet } from "./stylesheet";

// The site has one shadow (styles.css): one theme name, Tailwind's own named steps removed, and no shadow
// written beside it in a class, a style or a script. What a real browser draws is not checked.
const src = fileURLToPath(new URL("../src", `file://${__filename}`));
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.(tsx?|css)$/.test(name) ? [path] : [];
});

test("the theme names one shadow and takes Tailwind's own steps away", () => {
  expect(stylesheet).toMatch(/--shadow-\*: initial;/);
  expect(stylesheet).toMatch(/--inset-shadow-\*: initial;/);
  expect(stylesheet).toMatch(/--drop-shadow-\*: initial;/);
  expect([...stylesheet.matchAll(/^\s*(--shadow-[a-z-]+):/gm)].map((m) => m[1])).toEqual(["--shadow-float"]);
  expect(stylesheet).not.toMatch(/box-shadow\s*:/);
});

test("no part writes a shadow of its own", () => {
  const own = /\b(?:inset-|drop-)?shadow-(?:2xs|xs|sm|md|lg|xl|2xl|inner|\[)|--tw-shadow|box-shadow\s*:/;
  const found = files(src).filter((path) => !/[/\\]styles(\.css$|[/\\])/.test(path)).flatMap((path) =>
    readFileSync(path, "utf8").split("\n").map((line, at) => [`${path.slice(src.length + 1)}:${at + 1}`, line] as const))
    .filter(([, line]) => own.test(line)).map(([where]) => where);
  expect(found).toEqual([]);
  // A script sets a box-shadow only to take one away from a still copy, or to copy a surface's own, or for the
  // flash's ring (a line, not a shadow): lib/motion.ts and reader/departure.ts.
  const scripts = files(src).filter((path) => readFileSync(path, "utf8").includes("boxShadow")).map((path) => path.slice(src.length + 1)).sort();
  expect(scripts).toEqual(["features/reader/departure.ts", "lib/motion.ts"]);
});

test("the answered card's flying shape takes the one shadow, as much as it has lifted", () => {
  const look: Look = { tokens: [], ground: "white", background: "white", border: "red", radius: 8, content: [], padding: "0", gap: "0", weight: "400", color: "black", layout: {} };
  const shape = shapeOf("k", look, look);
  try {
    expect(shape.shape.classList.contains("shadow-float")).toBe(true);
    const box = { x: 50, y: 50, width: 100, height: 40 };
    draw(shape, resting(box, 0));
    expect(shape.shape.style.getPropertyValue("--lift")).toBe("0");
    expect(shape.shape.style.boxShadow).toBe("");
    draw(shape, { ...resting(box, 0), lift: 0.5 });
    expect(shape.shape.style.getPropertyValue("--lift")).toBe("0.5");
  } finally {
    shape.shape.remove();
  }
});
