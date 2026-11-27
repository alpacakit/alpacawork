import type { ComponentProps } from "react";
import type { ModelLabel } from "@/domain/agent-label";
import { AgentMark } from "@/components/ui/agent-mark";
import { cn } from "@/lib/utils";

/**
 * Every narrow agent label gives space to effort first; only the name may be ellipsized. It is cut across only:
 * cut all round, a small step's tight line cut its g and p off below. The agent's mark stands before it (AgentMark):
 * from `agent` when the place knows who ran, else from the model the label names. It stands on the name's baseline and
 * is moved down by its overhang, so its middle is the capitals' middle whatever the line's height.
 */
export function AgentLabel({ label, agent, markClassName, className, ...props }: ComponentProps<"span"> & { label: ModelLabel; agent?: string; markClassName?: string }) {
  return <span {...props} title={label.full} aria-label={label.full}
    className={cn("inline-grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline", className)}>
    <AgentMark name={agent} model={agent ? undefined : label.name} className={cn("mr-[0.35em] translate-y-[0.22em] self-baseline", markClassName)} />
    <span data-agent-name className="col-start-2 min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap">{label.name}</span>
    <span data-agent-effort className="col-start-3 whitespace-nowrap">{label.suffix}</span>
  </span>;
}
