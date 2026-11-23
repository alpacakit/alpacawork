/* Hallmark · component: coordinator AI · genre: modern-minimal (utilitarian) · theme: the app's tokens
 * states: default · hover · focus · active · disabled · warning (none can run)
 */
import { useTranslation } from "react-i18next";
import type { CoordinatorNextLaunch } from "@alpacawork/contract/coordinator";
import { Icon } from "@/components/ui/icon";
import { launchName, modelLabel } from "@/domain/agent-label";
import { AgentLabel } from "@/features/people/AgentLabel";
import { openSettings } from "@/state/dialog-store";
import { cn } from "@/lib/utils";

/**
 * The AI the input's next message goes to (the conversation's `nextLaunch`), said in the send row: its model and effort
 * only, since it is chosen in the settings, not here. Pressed, it opens them onto the input's AI stack. With none that
 * can run (`next` null), the same place says so in the warning colour and leads there too; the send waits meanwhile.
 * `className`: the row's own look for it (one of its quiet tools).
 */
export function CoordinatorAi({ next, className }: { next: CoordinatorNextLaunch | null; className?: string }) {
  const { t } = useTranslation("ui");
  const label = next ? modelLabel(launchName(next.agent, next.values).full) : null;
  // Its name in full for a reader and a pointer's tip; what is shown is the model alone (where a role name would go).
  const named = label ? t("coordinatorCard.ai.label", { ai: label.full }) : t("coordinatorCard.ai.none");
  return <button type="button" data-coordinator-ai={next ? "" : "none"} title={named} aria-label={named}
    onClick={() => openSettings("ai", "coordinatorAi")}
    className={cn("inline-flex self-start min-h-control-xs min-w-0 max-w-full cursor-pointer items-center gap-1.5 narrow:gap-1 rounded-sm border border-line bg-lit px-2 text-sm text-ink hover:bg-hover active:bg-line",
      className, !label && "text-warn hover:text-warn")}>
    <Icon name={label ? "agent" : "caution"} className={cn("size-3.5 flex-none", label ? "text-muted" : "text-warn")} />
    {label ? <AgentLabel label={label} className="narrow:inline narrow:[&>*]:inline narrow:[&>[data-agent-name]]:whitespace-normal" />
      : <span className="truncate">{t("coordinatorCard.ai.setUp")}</span>}
  </button>;
}
