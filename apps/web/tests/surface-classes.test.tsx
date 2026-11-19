import { expect, test } from "vitest";
import { cn } from "../src/lib/utils";

// A surface's hairline edge and its one shadow (styles.css) are names tailwind-merge does not know by itself:
// a caller's class has to replace the part's, so a swiped copy or a whole sheet draws no shadow, and one edge.
test("a caller's shadow-none replaces a surface's float", () => {
  expect(cn("shadow-float", "shadow-none")).toBe("shadow-none");
  expect(cn("shadow-none", "shadow-float")).toBe("shadow-float");
});

test("a hairline edge replaces the 1px edge and gives way to border-0, keeping the edge's colour", () => {
  expect(cn("rounded-md border border-lit-line shadow-float", "border-hairline")).toBe("rounded-md border-lit-line shadow-float border-hairline");
  expect(cn("border-hairline border-lit-line", "border-0 shadow-none")).toBe("border-lit-line border-0 shadow-none");
  expect(cn("border-t-hairline border-lit-line", "border-t-0")).toBe("border-lit-line border-t-0");
});
