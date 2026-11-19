import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import { withNextStep } from "../src/features/reader/recovery";

beforeAll(() => startI18n());

test("a reason without its own stop is ended before the next step, in either language", async () => {
  await i18n.changeLanguage("en");
  expect(withNextStep("Make them done first", "Fix the input.")).toBe("Make them done first. Fix the input.");
  expect(withNextStep("Already stopped.", "Fix the input.")).toBe("Already stopped. Fix the input.");
  await i18n.changeLanguage("ja");
  expect(withNextStep("先に完了にしてください", "入力を直してください。")).toBe("先に完了にしてください。入力を直してください。");
  expect(withNextStep("止まっています。", "入力を直してください。")).toBe("止まっています。入力を直してください。");
});
