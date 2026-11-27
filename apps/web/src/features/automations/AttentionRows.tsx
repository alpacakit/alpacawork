import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatLogTime } from "@/domain/time";
import { useViewStore } from "@/state/view-store";
import { useAutomationsAttention } from "./data";
import { openAutomation } from "./open";
import { ActionMark } from "./ActionMark";

/** How many automations ask for a look on the home list (its waiting section counts them with its tasks). */
export const useHomeAttention = () => useAutomationsAttention().length;

/**
 * Automations that ask for a look, as rows of the home's waiting section, ahead of its tasks: whether it calls an AI,
 * its ID and name, and what asks with its time (a failure in red). A press opens it in the reader's window over the
 * home, as a task's row does: the home stays under it.
 */
export function AutomationAttentionRows({ width, edge }: { width: CSSProperties; edge: string | false }) {
  const { t, i18n } = useTranslation("automations");
  const items = useAutomationsAttention();
  const open = useViewStore(state => state.automation?.id ?? null);
  if (!items.length) return null;
  return <ul data-home-automations className="m-0 list-none p-0">{items.map(({ automation, kind, at }) =>
    <li key={automation.id} data-home-automation={automation.id} className="border-b border-rule">
      <button type="button" style={width} aria-current={open === automation.id ? "true" : undefined} onClick={() => openAutomation(automation.id)}
        className={cn("sticky left-0 flex min-h-9 w-full items-center gap-2 bg-bg pr-2 pl-list-text text-start hover:bg-row-hover aria-[current=true]:bg-hover narrow:min-h-11 narrow:flex-wrap narrow:gap-y-0 narrow:py-1.5", edge)}>
        <ActionMark facts={automation.latest.facts} />
        <span className="flex-none text-sm text-muted tabular-nums">{automation.id}</span>
        {/* On a phone the name keeps the row's width and what asks goes below it, rather than cutting the name short. */}
        <span dir="auto" className="min-w-0 flex-1 truncate text-sm narrow:basis-[calc(100%-5rem)]">{automation.name}</span>
        <span className={cn("flex-none text-sm narrow:basis-full narrow:ps-7", kind === "awaiting_enable" ? "text-muted" : "text-error")}>{t(`attention.${kind}`)}
          {kind !== "awaiting_enable" && <>{" "}<span className="tabular-nums">{formatLogTime(at, i18n.language)}</span></>}</span>
      </button>
    </li>)}</ul>;
}
