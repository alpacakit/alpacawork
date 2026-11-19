import { expect, test } from "vitest";
import { cn } from "../src/lib/utils";

// The size steps tailwind-merge does not have are sizes, not colours: beside a colour both stay, and a later size replaces them.
test("a size step and a colour both stay, and a later size replaces an earlier one", () => {
  expect(cn("text-ink", "text-md").split(" ").sort()).toEqual(["text-ink", "text-md"]);
  expect(cn("text-md", "text-sm")).toBe("text-sm");
  expect(cn("text-sm", "text-md")).toBe("text-md");
  expect(cn("text-done", "text-seal").split(" ").sort()).toEqual(["text-done", "text-seal"]);
});
