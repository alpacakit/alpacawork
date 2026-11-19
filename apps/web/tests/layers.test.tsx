import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ESCAPE_LAYER } from "@/lib/escape-layer";
import { stylesheet } from "./stylesheet";

const layer = Object.fromEntries([...stylesheet.matchAll(/--layer-([a-z-]+):\s*(\d+);/g)].map(([, name, value]) => [name!, Number(value)]));
const tag = (source: string) => [...source.matchAll(/\bz-(\[[^\]]+\]|\d+)/g)].map(([match]) => match);

describe("one order of the surfaces", () => {
  // Esc closes what is drawn on top first: the two tables keep one order for the surfaces they share.
  it("Esc closes in the order the surfaces are drawn", () => {
    const shared: [keyof typeof ESCAPE_LAYER, string][] =
      [["coordinator", "coordinator"], ["dialog", "dialog"], ["popup", "popover"], ["image", "image-viewer"]];
    for (const [[lowKey, lowLayer], [highKey, highLayer]] of shared.slice(1).map((high, at) => [shared[at]!, high] as const)) {
      expect(layer[lowLayer], lowLayer).toBeLessThan(layer[highLayer]!);
      expect(ESCAPE_LAYER[lowKey], lowKey).toBeLessThanOrEqual(ESCAPE_LAYER[highKey]);
    }
  });

  // The coordinator stands over the reader and under everything opened for a moment: another popup is never drawn
  // under it while it takes the presses.
  it("puts the coordinator over the reader and under what opens for a moment", () => {
    for (const under of ["bar", "reader"]) expect(layer[under], under).toBeLessThan(layer.coordinator!);
    for (const over of ["card", "toast", "edit-surface", "dialog", "popover", "image-viewer"]) expect(layer[over], over).toBeGreaterThan(layer.coordinator!);
  });

  it("orders the answered card's leaving copy between the reader and the coordinator", () => {
    expect(layer.reader).toBeLessThan(layer["flying-card"]!);
    expect(layer["flying-card"]).toBeLessThan(layer.coordinator!);
  });

  it("takes no layer from another by arithmetic", () => {
    const src = fileURLToPath(new URL("../src/", `file://${__filename}`));
    for (const file of readdirSync(src, { recursive: true, encoding: "utf8" }).filter(name => /\.(tsx?|css)$/.test(name)))
      expect(readFileSync(src + file, "utf8"), file).not.toMatch(/var\(--layer-[a-z-]+\)\s*[+-]/);
  });

  it("gives the coordinator and what opens from it no number of their own", () => {
    for (const file of ["features/coordinator/CoordinatorCard.tsx", "features/coordinator/editor/LabelEditor.tsx", "features/forms/AgentPicker.tsx"])
      expect(tag(readFileSync(fileURLToPath(new URL(`../src/${file}`, `file://${__filename}`)), "utf8")).filter(z => !/^z-(1|10)$/.test(z)), file).toEqual([]);
  });
});
