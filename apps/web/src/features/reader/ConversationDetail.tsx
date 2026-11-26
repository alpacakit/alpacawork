import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { contextPercent } from "@alpacawork/contract/agent-context";
import { Icon } from "@/components/ui/icon";
import { percentText, UsageRing } from "@/components/ui/usage-ring";
import { limitTone } from "@/domain/limits";
import { compactionCut } from "@/domain/context";
import type { ReportEvent } from "@/domain/report-events";
import { tokenText } from "@/domain/tokens";

/* Hallmark · component: History conversation row · genre: modern-minimal · theme: the app's own tokens (conversation, usage ring) */

type Conversation = NonNullable<ReportEvent["conversation"]>;
type Compacted = Extract<Conversation, { change: "compacted" }>;

/** The study that found a fresh, consolidated conversation does better than one that went astray (its §7.4). */
export const LOST_IN_CONVERSATION = "https://arxiv.org/abs/2505.06120";


/** How full the conversation was, as the context meter draws it: its ring and percent, or the tokens when no window is known. */
function Fill({ tokens, window, language }: { tokens: number; window: number | null; language: string }) {
  const percent = window ? contextPercent({ usedTokens: tokens, windowTokens: window })! : null;
  return <span className="inline-flex items-center gap-1 tabular-nums">
    <UsageRing percent={percent ?? 0} tone={limitTone(percent ?? 0)} open={percent === null} className="size-3.5" />
    {percent !== null ? percentText(percent) : tokenText(tokens)}</span>;
}

/** A started-anew row's one sentence of why, when the Run that started it says. */
function whyAnew(conversation: Extract<Conversation, { change: "new" }>, t: TFunction<"reader">): string | null {
  switch (conversation.because) {
    case "handoff": return conversation.report ? t("reportFeed.row.newBecause.handoffAt", { report: conversation.report }) : t("reportFeed.row.newBecause.handoff");
    case "asked": return t("reportFeed.row.newBecause.asked");
    case "another_ai": return t("reportFeed.row.newBecause.another_ai");
    case "unresumable": return t("reportFeed.row.newBecause.unresumable");
    default: return null;
  }
}

/**
 * A conversation row's line under its name, closed: why it started anew, or how full a compaction found and left the
 * conversation with what it cut (only before, on a record whose agent never said the after).
 */
export function conversationLine(conversation: Conversation, t: TFunction<"reader">, language: string): ReactNode {
  if (conversation.change === "new") return whyAnew(conversation, t);
  const { beforeTokens: before, afterTokens: after, windowTokens: window } = conversation;
  if (before === null && after === null) return null;
  const cut = compactionCut({ at: "", ...conversation });
  // One figure alone is named for which it is; both read as the change.
  const label = before === null ? "reportFeed.row.compactedTo" : after === null ? "reportFeed.row.compactedFrom" : "reportFeed.row.compactedFill";
  return <span data-compaction-fill className="inline-flex flex-wrap items-center gap-x-1.5">
    <span className="text-soft">{t(label)}</span>
    {before !== null && <Fill tokens={before} window={window} language={language} />}
    {before !== null && after !== null && <Icon name="arrowRight" className="size-3.5 text-muted" />}
    {after !== null && <Fill tokens={after} window={window} language={language} />}
    {cut !== null && cut > 0 && <span className="text-soft tabular-nums">{t("reportFeed.row.compactedCut", { tokens: tokenText(cut) })}</span>}
  </span>;
}

/**
 * What an opened conversation row says: what set a compaction off and what it does to the conversation, or what a
 * fresh start carries over and why starting afresh helps, with the study that found it.
 */
export function ConversationDetail({ conversation, t, language }: { conversation: Conversation; t: TFunction<"reader">; language: string }) {
  if (conversation.change === "new") return <div data-conversation-detail className="grid gap-2 text-sm">
    <p className="m-0">{t("reportFeed.conversation.startsFrom")}</p>
    {/* Why starting over helps, where the AI or the request chose it; not where another AI or a lost session forced it. */}
    {conversation.because !== "another_ai" && conversation.because !== "unresumable" && <p className="m-0 text-soft">{t("reportFeed.conversation.why")}{" "}
      <a href={LOST_IN_CONVERSATION} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-ink">{t("reportFeed.conversation.source")}</a></p>}
  </div>;
  return <div data-conversation-detail className="grid gap-2 text-sm">
    {conversation.trigger && <p className="m-0">{conversation.trigger === "agent" ? t("reportFeed.conversation.byAgent") : t("reportFeed.conversation.byRequest")}</p>}
    {/* The figures are the row's own line; what the agent never gave of them is said here. */}
    {(conversation.beforeTokens === null || conversation.afterTokens === null) && <p className="m-0">{fillSentence(conversation, t, language)}</p>}
    <p className="m-0 text-soft">{t("reportFeed.conversation.keeps")}</p>
  </div>;
}

/** What the agent never gave of a compaction's figures, in words. */
function fillSentence(conversation: Compacted, t: TFunction<"reader">, language: string): string {
  const { beforeTokens: before, afterTokens: after, windowTokens: window } = conversation;
  const figure = (tokens: number) => window ? percentText(contextPercent({ usedTokens: tokens, windowTokens: window })!) : tokenText(tokens);
  if (before !== null) return t("reportFeed.conversation.fillBefore", { before: figure(before) });
  if (before === null && after !== null) return t("reportFeed.conversation.fillAfter");
  return t("reportFeed.conversation.fillUnknown");
}
