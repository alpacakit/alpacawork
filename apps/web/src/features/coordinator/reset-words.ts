import type { TFunction } from "i18next";
import { i18n } from "@alpacawork/i18n";
import type { AiRow } from "@alpacawork/contract";
import type { CoordinatorResetReason } from "@/data/coordinator";
import { launchName, modelLabel } from "@/domain/agent-label";

/** A large count as the reader's language says it short: 20万 in Japanese, 200K in English. */
export const compactCount = (value: number) => new Intl.NumberFormat(i18n.language, { notation: "compact" }).format(value);

/** Two AIs by their models; by model and effort when the models are the same. */
function aiNames(from: AiRow, to: AiRow) {
  const label = (row: AiRow) => modelLabel(launchName(row.agent, row.values).full);
  const before = label(from), after = label(to);
  return before.name === after.name ? { from: before.full, to: after.full } : { from: before.name, to: after.name };
}

/**
 * Why the coordinator started again, as its line in the conversation says it; none when the person asked for it (they
 * know why). Every way it starts again says it the same way, so a reader learns one line.
 */
export function resetReason(reason: CoordinatorResetReason, t: TFunction<"ui">): string | null {
  switch (reason.kind) {
    case "asked": return null;
    case "context": return !reason.over ? t("coordinatorCard.reset.reason.context")
      : "tokens" in reason.over ? t("coordinatorCard.reset.reason.contextTokens", { tokens: compactCount(reason.over.tokens) })
      : t("coordinatorCard.reset.reason.contextPercent", { percent: reason.over.percent });
    case "another_ai": return reason.from && reason.to ? t("coordinatorCard.reset.reason.anotherAiNamed", aiNames(reason.from, reason.to))
      : t("coordinatorCard.reset.reason.anotherAi");
    case "fallback": return t("coordinatorCard.reset.reason.fallback");
    case "recovered": return t("coordinatorCard.reset.reason.recovered");
    case "unresumable": return t("coordinatorCard.reset.reason.unresumable");
  }
}
