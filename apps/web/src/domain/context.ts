/** How a conversation's context fill is said beside its agent (contract: agent-context). */
import { contextPercent, type AgentContext } from "@alpacawork/contract/agent-context";
import { limitTone, type LimitTone } from "./limits";

export type ContextFigure = {
  /** Percent of the window, when both the fill and the window are known. */
  percent: number | null;
  tone: LimitTone;
  /** No window to measure against (an agent that names none): the ring is drawn open and the figure is the tokens. */
  open: boolean;
  /** The fill is unknown right now (just after a compaction). */
  waiting: boolean;
};

/** The ring's reading; the same 80% rule as the plan limits. */
export function contextFigure(context: AgentContext): ContextFigure {
  const percent = contextPercent(context);
  return { percent, tone: limitTone(percent ?? 0), open: context.windowTokens === null, waiting: context.usedTokens === null };
}
