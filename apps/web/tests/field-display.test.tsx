import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_FIELDS, fieldCatalog, renderContext, sizeNote } from "@alpacawork/contract";
import { i18n, startI18n } from "@alpacawork/i18n";
import en from "../../../packages/i18n/src/locales/en/ui.json" with { type: "json" };
import { shownCatalog, shownContext, shownField, shownSizeNote } from "@/domain/field-display";

beforeAll(() => { startI18n(); });
afterAll(async () => { await i18n.changeLanguage("en"); });

const goal = DEFAULT_FIELDS.find(def => def.id === "goal")!;
const values = { goal: "Ship it", policy: ["One step"], unknown_field: "x" };

describe("shipped field texts on screen", () => {
  it("the en catalog is the shipped text itself, so an English screen shows what agents read", () => {
    for (const def of DEFAULT_FIELDS) {
      const entry = (en.defaultField as unknown as Record<string, { title: string; hint?: string }>)[def.id]!;
      expect(entry.title).toBe(def.title);
      expect(entry.hint ?? "").toBe(def.hint);
    }
  });

  it("a shipped field's texts follow the screen's language; a workspace's own field shows as written", async () => {
    await i18n.changeLanguage("ja");
    expect(shownField(goal)).toMatchObject({ title: "ゴール", hint: expect.stringMatching(/^何がそろえば終わりか/) });
    await i18n.changeLanguage("en");
    expect(shownField(goal)).toMatchObject({ title: "Goal", hint: goal.hint });
    const own = { ...goal, id: "budget", title: "予算" };
    expect(shownField(own)).toBe(own);
  });

  it("size words follow the screen's language and match what agents read in English", async () => {
    const list = DEFAULT_FIELDS.find(def => def.id === "policy")!, decide = DEFAULT_FIELDS.find(def => def.id === "decide")!;
    await i18n.changeLanguage("ja");
    expect([shownSizeNote(goal), shownSizeNote(list), shownSizeNote(decide)])
      .toEqual(["60字ほど。", "1件60字ほど・5件まで。", "7件まで。"]);
    await i18n.changeLanguage("en");
    for (const def of DEFAULT_FIELDS) expect(shownSizeNote(def)).toBe(sizeNote(def));
  });

  it("the context tab rebuilds the server's text with shown titles, and keeps it when a field is unknown", async () => {
    const catalog = fieldCatalog([]);
    const context = renderContext(["goal", "policy"], { goal: "Ship it", policy: ["One step"] }, catalog);
    const view = { values: { goal: "Ship it", policy: ["One step"] }, fields: ["goal", "policy"], context };
    await i18n.changeLanguage("en");
    expect(shownContext(view, catalog)).toBe(context);
    await i18n.changeLanguage("ja");
    expect(shownContext(view, catalog)).toBe("## ゴール\nShip it\n\n## 方針\n- One step");
    expect(shownContext(view, null)).toBe(context);
    expect(shownContext({ ...view, values, fields: [...view.fields, "unknown_field"] }, catalog)).toBe(context);
    // The catalog the server checks with is never the shown one.
    expect(catalog.get("goal")!.title).toBe("Goal");
    expect(shownCatalog(catalog).get("goal")!.title).toBe("ゴール");
  });
});
