import type { ComponentProps } from "react";
import type { ModelLabel } from "@/domain/agent-label";
import { cn } from "@/lib/utils";

/**
 * Every narrow agent label gives space to effort first; only the name may be ellipsized. It is cut across only:
 * cut all round, a small step's tight line cut its g and p off below.
 */
export function AgentLabel({ label, className, ...props }: ComponentProps<"span"> & { label: ModelLabel }) {
  return <span {...props} title={label.full} aria-label={label.full}
    className={cn("inline-grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)_auto] items-baseline", className)}>
    <span data-agent-name className="min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap">{label.name}</span>
    <span data-agent-effort className="whitespace-nowrap">{label.suffix}</span>
  </span>;
}
