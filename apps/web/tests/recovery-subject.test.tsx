// An unknown write's notice names a personal setting as its row does, in the language
// now, for every setting by one rule; a Task stays its ID and a write about no Task stays the settings.
import { beforeAll, expect, test } from "vitest";
import { activateLocale, startI18n } from "@alpacawork/i18n";
import { personalSettings } from "@alpacawork/contract";
import { recoverySubject } from "../src/features/reader/recovery";

beforeAll(async () => { startI18n(); await activateLocale("ja"); });
const personal = (label: string) => ({ path: "settings/set", response: "personal", label }) as never;

test("every registered personal setting is named by its label, never by its key", () => {
  for (const definition of personalSettings) {
    const subject = recoverySubject(personal(definition.key));
    expect(subject, definition.key).not.toBe(definition.key);
    expect(subject, definition.key).not.toBe("");
  }
  expect(recoverySubject(personal("update.confirm"))).toBe("アップデート前に確認する");
});

test("a Task keeps its ID, and a write about no Task is the settings", () => {
  expect(recoverySubject({ path: "task/report", response: "task", label: "T42" } as never)).toBe("T42");
  expect(recoverySubject({ path: "config/set", response: "settings", label: "" } as never)).toBe("設定");
});
