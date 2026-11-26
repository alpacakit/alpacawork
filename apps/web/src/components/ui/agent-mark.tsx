import { memo } from "react";
import { useServerSettings } from "@/data/queries";
import { agentColor, agentKind, agentLetters, modelAgent } from "@/domain/agent-mark";
import { cn } from "@/lib/utils";
import { AGENT_LOGOS } from "./agent-logos";

/**
 * An agent's mark, one part for every place that names an agent: before its name where the name is written, or in its
 * place where there is no room (then `label` says the name). An agent of a kind with a logo (Claude, Codex, Grok,
 * Copilot) wears that logo; any other, a round badge of two letters in a colour of its own (domain/agent-mark). Its
 * size follows the text around it, so it sits on the line wherever it stands.
 */
export const AgentMark = memo(function AgentMark({ name, model, kind: given, label, className }: {
  /** The agent's name as configured (claude, codex, inkling), or a kind's own id where only the kind is known. */
  name?: string;
  /** Where only the model is known (History's tags, the analysis by model): the agent is read from it (modelAgent). */
  model?: string;
  /** The agent's kind when the place already knows it; otherwise it is read from the settings. */
  kind?: string;
  label?: boolean; className?: string;
}) {
  const { data } = useServerSettings();
  const agents = data?.agents;
  const who = name !== undefined ? { name, kind: agentKind(name, given ?? agents?.[name]?.adapter) } : model ? modelAgent(model, agents) : null;
  if (!who) return null;
  const logo = who.kind ? AGENT_LOGOS[who.kind] : undefined;
  const words = label ? name ?? model : undefined;
  const a11y = { role: words ? "img" : undefined, "aria-label": words, "aria-hidden": words ? undefined : true, title: words } as const;
  if (logo) return <svg data-agent-mark={who.kind} viewBox="0 0 24 24" fill="currentColor" {...a11y}
    className={cn("inline-block size-[1.15em] flex-none", className)}>
    {logo.map((path, i) => <path key={i} d={path.d} fill={path.fill} fillRule={path.fillRule} clipRule={path.clipRule} />)}
  </svg>;
  const letters = agentLetters(who.name);
  return <span data-agent-mark={letters} {...a11y} style={{ background: agentColor(who.name, who.kind) }}
    className={cn("inline-flex size-[1.25em] flex-none items-center justify-center rounded-full leading-none text-white select-none", className)}>
    <span data-letters={letters} className="text-[0.6em] font-bold tracking-[-0.02em] [text-box:trim-both_cap_alphabetic] before:content-[attr(data-letters)]" />
  </span>;
});
