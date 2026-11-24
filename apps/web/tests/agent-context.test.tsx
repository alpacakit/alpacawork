import { expect, test } from "vitest";
import type { AgentContext } from "@alpacawork/contract/agent-context";
import { contextFigure } from "../src/domain/context";

const at = "2026-11-24T00:00:00.000Z";
const context = (usedTokens: number | null, windowTokens: number | null): AgentContext =>
  ({ usedTokens, windowTokens, compactAtTokens: null, compacted: usedTokens === null, observedAt: at });

test("a conversation's ring reads its share of the window, open without one and waiting just after a compaction", () => {
  expect(contextFigure(context(394_250, 475_000))).toMatchObject({ open: false, waiting: false, tone: "near" });
  expect(contextFigure(context(394_250, 475_000)).percent).toBeCloseTo(83, 0);
  expect(contextFigure(context(48_000, null))).toEqual({ percent: null, tone: "normal", open: true, waiting: false });
  expect(contextFigure(context(null, 272_000))).toEqual({ percent: null, tone: "normal", open: false, waiting: true });
});
