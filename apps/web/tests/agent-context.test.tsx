import { expect, test } from "vitest";
import type { ContextView } from "@alpacawork/contract/agent-context";
import { contextFigure } from "../src/domain/context";

const at = "2026-11-24T00:00:00.000Z";
const context = (usedTokens: number | null, windowTokens: number | null): ContextView =>
  ({ usedTokens, windowTokens, compactAtTokens: null, compacted: usedTokens === null, observedAt: at,
    windowFrom: windowTokens === null ? null : "reported", compactAtFrom: null });

test("a conversation's ring reads its share of the window, open without one and waiting just after a compaction", () => {
  expect(contextFigure(context(394_250, 475_000))).toMatchObject({ open: false, waiting: false, tone: "near" });
  expect(contextFigure(context(394_250, 475_000)).percent).toBeCloseTo(83, 0);
  expect(contextFigure(context(48_000, null))).toEqual({ percent: null, tone: "normal", open: true, waiting: false });
  expect(contextFigure(context(null, 272_000))).toEqual({ percent: null, tone: "normal", open: false, waiting: true });
});

test("a typed limit keeps its digits, an emptied field falls back to the agent's or the shipped figure, and no model chosen is `-`", async () => {
  const { contextModelKeys, editContext } = await import("../src/features/panels/AgentSettingsContext");
  const draft = (values: string) => ({ id: "a", name: "codex", params: [{ id: "p", key: "model", values }] });
  expect(contextModelKeys(draft("gpt-6.2-sol, gpt-6.1-terra") as never)).toEqual(["gpt-6.2-sol", "gpt-6.1-terra"]);
  expect(contextModelKeys(draft("") as never)).toEqual(["-"]);
  const typed = editContext(undefined, "gpt-6.2-sol", "window", "300,000");
  expect(typed).toEqual({ "gpt-6.2-sol": { window: 300_000 } });
  expect(editContext(typed, "gpt-6.2-sol", "window", "")).toBeUndefined();
});
