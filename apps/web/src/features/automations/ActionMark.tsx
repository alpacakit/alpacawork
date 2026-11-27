import { useTranslation } from "react-i18next";
import type { Facts } from "./shape";

/**
 * Whether it calls an AI (which costs the AI's use) or only runs its program here, as the home's waiting rows mark it,
 * so a glance down them tells which spend an AI.
 */
export function ActionMark({ facts }: { facts: Pick<Facts, "ai"> }) {
  const { t } = useTranslation("automations");
  const ai = facts.ai.length > 0;
  const label = t(ai ? "mark.ai" : "mark.program");
  return <span data-automation-kind={ai ? "ai" : "program"} title={label} aria-label={label}
    className="inline-flex h-4.5 min-w-5 flex-none items-center justify-center rounded-xs bg-hover px-1 text-micro font-semibold text-muted">{ai ? "AI" : "›_"}</span>;
}
