import { expect, test } from "vitest";
import { standing } from "../src/features/reader/ReaderEntries";

const tab = (key: string, on = false, related = false) => ({ key, on, ...related ? { related: key } : {} });
const widths = { task: 60, about: 100, analysis: 60, family: 120, more: 30, gap: 4, spacer: 8 };
const keys = (list: { key: string }[]) => list.map(entry => entry.key);

test("every tab stands when they fit; else those that fit from the start beside More, the shown one always among them", () => {
  const entries = [tab("task"), tab("about"), tab("analysis", true), tab("family", false, true)];
  // 60 + 4 + 100 + 4 + 60 + 12 (the gap before a related list) + 4 + 120
  expect(keys(standing(entries, widths, 364))).toEqual(["task", "about", "analysis", "family"]);
  expect(keys(standing(entries, widths, 363))).toEqual(["task", "about", "analysis"]);
  // Too narrow for Context too: Analysis, shown, keeps its place, Context goes into More.
  expect(keys(standing(entries, widths, 200))).toEqual(["task", "analysis"]);
  // Not yet measured: nothing is hidden.
  expect(keys(standing(entries, {}, 10))).toEqual(["task", "about", "analysis", "family"]);
});
