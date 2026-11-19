import { afterEach, beforeAll, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { Caret } from "../src/components/ui/caret";

beforeAll(() => startI18n());
afterEach(() => cleanup());

test("the shared expansion cue rotates in place and is decorative", () => {
  const { container, rerender } = render(<Caret />);
  const cue = container.querySelector("[data-list-caret]");
  expect(cue?.getAttribute("aria-hidden")).toBe("true");
  expect(cue?.getAttribute("class")).not.toContain("rotate-90");
  rerender(<Caret open />);
  expect(cue?.getAttribute("class")).toContain("rotate-90");
});
