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
/**
 * A mark set in running text (a table's name, a line of words): a step over the text, its middle on the capitals'
 * middle, and a little room before the name.
 */
export const INLINE_MARK = "me-[0.4em] inline-block size-[1.07em] align-[-0.2em]";

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
  const a11y = { role: words ? "img" : undefined, "aria-label": words, "aria-hidden": words ? undefined : true } as const;
  // A drawing's own title is what a pointer's tip shows on it.
  const tip = words && <title>{words}</title>;
  if (logo) return <svg data-agent-mark={who.kind} viewBox="0 0 24 24" fill="currentColor" {...a11y}
    className={cn("inline-block size-[1.15em] flex-none", className)}>
    {tip}
    {logo.map((path, i) => <path key={i} d={path.d} fill={path.fill} fillRule={path.fillRule} clipRule={path.clipRule} />)}
  </svg>;
  const letters = agentLetters(who.name);
  // One drawing, circle and letters: the letters' middle is the circle's (their capitals' middle at 0.35em below the
  // centre line), whatever font the page has.
  return <svg data-agent-mark={letters} viewBox="0 0 24 24" {...a11y} className={cn("inline-block size-[1.15em] flex-none select-none", className)}>
    {tip}
    <circle cx={12} cy={12} r={12} fill={agentColor(who.name, who.kind)} />
    <text x={12} y={12} dy="0.35em" textAnchor="middle" fontSize={13} fontWeight={600} fill="#fff" letterSpacing={-0.4}>{letters}</text>
  </svg>;
});
