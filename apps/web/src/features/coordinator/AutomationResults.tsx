import { Trans, useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { openAutomation } from "@/features/automations/open";
import type { CoordinatorTurn } from "@/data/coordinator";
import { Icon } from "@/components/ui/icon";

type Change = NonNullable<CoordinatorTurn["result"]>["automations"][number];

/**
 * What the coordinator saved of automations for the messages of one exchange (its own and those that joined it), under
 * its reply: each automation it created or edited, from the server's record of the change, never from the reply's
 * words. A change to another automation than the message's badge named says so.
 */
export function AutomationResults({ turns }: { turns: readonly CoordinatorTurn[] }) {
  const { t } = useTranslation("ui");
  const lines = turns.flatMap(turn => (turn.result?.automations ?? []).map(change => ({ change, badge: turn.automation })));
  if (!lines.length) return null;
  const other = (change: Change, badge: string | undefined) => change.badgeMatch !== "mismatch" ? null
    : badge === "new" ? t("coordinatorCard.automationResult.notNew") : t("coordinatorCard.automationResult.notBadge", { id: badge });
  return <ul data-coordinator-automations className="m-0 mt-type-close list-none p-0 text-xs text-muted">
    {lines.map(({ change, badge }) => {
      const note = other(change, badge);
      return <li key={`${change.automationId}:${change.revision}`} data-automation-change={change.kind} data-automation={change.automationId}
        data-badge-match={change.badgeMatch} className="flex items-center gap-1.5">
        <Icon name={note ? "caution" : "check"} className={note ? "size-3.5 flex-none text-warn" : "size-3.5 flex-none"} />
        {/* Its ID opens it in the settings, as a task's ID in a reply opens the task. */}
        <span><Trans t={t} i18nKey={change.kind === "created" ? "coordinatorCard.automationResult.created" : "coordinatorCard.automationResult.edited"}
          values={{ id: change.automationId }} components={{ open: <Button variant="ref" data-automation-open={change.automationId} onClick={() => openAutomation(change.automationId)} /> }} />
          {note && <span className="text-warn">{note}</span>}</span>
      </li>;
    })}
  </ul>;
}
