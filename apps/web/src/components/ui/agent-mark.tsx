import { memo, type CSSProperties } from "react";
import { useServerSettings } from "@/data/queries";
import { agentColor, agentKind, agentLetters } from "@/domain/agent-mark";
import { cn } from "@/lib/utils";

/**
 * An agent's round mark (domain/agent-mark), one part for every place that names an agent: before its name where the
 * name is written, or in its place where there is no room (then `label` says the name). Its size follows the text
 * around it (1.25em), so it sits on the line wherever it stands.
 */
export const AgentMark = memo(function AgentMark({ name, label, className }: { name: string; label?: boolean; className?: string }) {
  const { data } = useServerSettings();
  const kind = agentKind(name, data?.agents?.[name]?.adapter);
  const letters = agentLetters(name);
  const style: CSSProperties = { background: agentColor(name, kind) };
  return <span data-agent-mark={letters} role={label ? "img" : undefined} aria-label={label ? name : undefined}
    aria-hidden={label ? undefined : true} title={label ? name : undefined} style={style}
    className={cn("inline-flex size-[1.35em] flex-none items-center justify-center rounded-full leading-none text-white select-none", className)}>
    <span data-letters={letters} className="text-[0.62em] font-bold tracking-[-0.02em] [text-box:trim-both_cap_alphabetic] before:content-[attr(data-letters)]" />
  </span>;
});
