import { expect, test } from "vitest";
import type { ContextView } from "@alpacawork/contract/agent-context";
import { contextFigure } from "../src/domain/context";

const at = "2026-11-24T00:00:00.000Z";
const context = (usedTokens: number | null, windowTokens: number | null): ContextView =>
  ({ usedTokens, windowTokens, compacted: usedTokens === null, observedAt: at, windowFrom: windowTokens === null ? null : "reported" });

test("a conversation's ring reads its share of the window, open without one and waiting just after a compaction", () => {
  expect(contextFigure(context(394_250, 475_000))).toMatchObject({ open: false, waiting: false, tone: "near" });
  expect(contextFigure(context(394_250, 475_000)).percent).toBeCloseTo(83, 0);
  expect(contextFigure(context(48_000, null))).toEqual({ percent: null, tone: "normal", open: true, waiting: false });
  expect(contextFigure(context(null, 272_000))).toEqual({ percent: null, tone: "normal", open: false, waiting: true });
});

test("a typed window keeps its digits, an emptied field falls back, and a model no longer listed stays to be cleared", async () => {
  const { contextModelKeys, editContext } = await import("../src/features/panels/AgentSettingsContext");
  const draft = (values: string, context?: Record<string, { window?: number }>) => ({ id: "a", name: "codex", params: [{ id: "p", key: "model", values }], context });
  expect(contextModelKeys(draft("gpt-6.2-sol, gpt-6.1-terra") as never)).toEqual(["gpt-6.2-sol", "gpt-6.1-terra"]);
  expect(contextModelKeys(draft("") as never)).toEqual(["-"]);
  // A Run that may choose no model has its own row, last.
  expect(contextModelKeys(draft("-, gpt-6.2-sol") as never)).toEqual(["gpt-6.2-sol", "-"]);
  expect(contextModelKeys(draft("gpt-6.2-sol", { "gpt-5": { window: 1 } }) as never)).toEqual(["gpt-6.2-sol", "gpt-5"]);
  const typed = editContext(undefined, "gpt-6.2-sol", "300,000");
  expect(typed).toEqual({ "gpt-6.2-sol": { window: 300_000 } });
  expect(editContext(typed, "gpt-6.2-sol", "")).toBeUndefined();
});
