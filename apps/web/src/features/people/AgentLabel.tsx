import type { ComponentProps } from "react";
import type { ModelLabel } from "@/domain/agent-label";
import { AgentMark } from "@/components/ui/agent-mark";
import { TextMark } from "@/components/ui/text-mark";
import { cn } from "@/lib/utils";

/**
 * Every narrow agent label gives space to effort first; only the name may be ellipsized. It is cut across only:
 * cut all round, a small step's tight line cut its g and p off below. The agent's mark stands before it (AgentMark):
 * from `agent` when the place knows who ran, else from the model the label names, centred on the name's capitals
 * (TextMark). Without `mark` (History, where a mark on every row draws the eye from what was said) the name stands alone. The name and the effort are boxed to their capitals (cap-box), so the label is as tall as its mark: a row
 * that centres it centres the letters, and one that lines it up on a baseline lines up the name's.
 */
export function AgentLabel({ label, agent, mark = true, markClassName, className, ...props }: ComponentProps<"span"> & { label: ModelLabel; agent?: string; mark?: boolean; markClassName?: string }) {
  return <span {...props} title={label.full} aria-label={label.full}
    className={cn("inline-grid min-w-0 max-w-full grid-cols-[auto_minmax(0,1fr)_auto] items-baseline", className)}>
    {mark && <TextMark className={markClassName}><AgentMark name={agent} model={agent ? undefined : label.name} className="mr-[0.35em]" /></TextMark>}
    <span data-agent-name className="col-start-2 min-w-0 cap-truncate">{label.name}</span>
    <span data-agent-effort className="col-start-3 cap-box whitespace-nowrap">{label.suffix}</span>
  </span>;
}
