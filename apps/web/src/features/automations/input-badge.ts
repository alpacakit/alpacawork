import { useEffect } from "react";
import { automationInDraft, automationLeftDraft } from "@/features/coordinator/editor/draft";
import { useConversation } from "@/features/coordinator/coordinator";

/**
 * What the coordinator's input is pointed at from the automations: the one shown (its ID and name), the page asking for
 * a new one (`new`), or nothing. The one place this screen tells the input; the input's own badge (its words and how it
 * is sent) is the input's to draw (editor/draft.ts).
 */
export type AutomationBadgeTarget = { id: string; name: string | null } | "new" | null;

/**
 * Points the input at an automation, at a new one, or at none: a badge of any other comes off an input with nothing
 * written beside it, and the badge of the one shown goes into an input with nothing of the person's, once its name is
 * read (`name: null` until then: the other's badge comes off, and none goes in as a bare number).
 */
export function pointInputAt(target: AutomationBadgeTarget) {
  automationLeftDraft(target === null ? null : target === "new" ? "new" : target.id);
  if (target === "new") automationInDraft(target);
  else if (target !== null && target.name !== null) automationInDraft({ id: target.id, name: target.name });
}

/**
 * Away from the automations (another settings section, another face, or a page opened there), the input is pointed at
 * none, once its conversation's draft is there: a badge left from before, even from before a reload, comes off.
 */
export function useInputAwayFromAutomations(away: boolean) {
  const conversation = useConversation(state => state.conversation?.id);
  useEffect(() => { if (away && conversation) pointInputAt(null); }, [away, conversation]);
}
