import { useTranslation } from "react-i18next";
import { i18n } from "@alpacawork/i18n";
import type { SelectionProblem } from "@alpacawork/contract/agent-selection";

const row = (key: string) => key === "model" ? i18n.t("forms:responsibleForm.model") : key === "effort" ? i18n.t("forms:responsibleForm.effort") : key;
const value = (choice: string | null) => choice ?? i18n.t("forms:agentPicker.none");
/**
 * One previous value to choose again, in full (why, and the value): the picker's list and a refusal's reason
 * (selection_required) both say it. A conversation that cannot go on ends with `next`, what starts it anew where it is
 * said: by default only that it needs a new conversation, since a refusal may be about any conversation (a Task's
 * agent's has no button for it); the coordinator's picker names its own clear button.
 */
export function selectionProblemText(problem: SelectionProblem, next = i18n.t("forms:agentPicker.next.anew")): string {
  const words = { row: row(problem.key), previous: value(problem.previous), next };
  // Literal keys, so the extractor keeps each one.
  switch (problem.reason) {
    case "invalid_value": return i18n.t("forms:agentPicker.problem.invalid_value", words);
    case "null_required": return i18n.t("forms:agentPicker.problem.null_required", words);
    case "removed": return i18n.t("forms:agentPicker.problem.removed", words);
    case "unused": return i18n.t("forms:agentPicker.problem.unused", words);
  }
}

/** A launch row's name, a value (null is a written `-`, "none"), and a previous value to choose again, in the person's words:
 * `problem` says all (why, and the previous value); `brief` says only what to do, for a place one short line fits. */
const choiceText = Object.assign((choice: string | null) => value(choice), {
  row,
  problem: (problem: SelectionProblem) => selectionProblemText(problem,
    i18n.t("forms:agentPicker.next.clear", { action: i18n.t("ui:coordinatorCard.clear") })),
  /** The agent the send went to is no longer enabled in the settings. */
  gone: (agent: string) => i18n.t("forms:agentPicker.problem.gone", { agent }),
  brief: Object.assign((problem: SelectionProblem) => problem.recovery === "new_conversation"
    ? i18n.t("forms:agentPicker.brief.new_conversation", { action: i18n.t("ui:coordinatorCard.clear") })
    : i18n.t("forms:agentPicker.brief.select_value", { row: row(problem.key) }),
  { gone: () => i18n.t("forms:agentPicker.brief.gone") }),
});
export function useChoiceText() {
  useTranslation("forms"); // Drawn again when the language changes.
  return choiceText;
}
