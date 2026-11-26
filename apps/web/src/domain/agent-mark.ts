import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type BuiltinAdapterId } from "@alpacawork/contract/agent-adapters";

/**
 * An agent's mark where its kind has no logo (components/ui/agent-logos): a round badge with two letters from the agent's
 * name, in a colour of its kind or its name. The round shape keeps it apart from a project's square.
 */

/** Each kind's colour: agents of one kind (claude and claude-chrome) share it, and their letters tell them apart. */
const KIND_COLOR: Record<BuiltinAdapterId, string> = {
  claude: "#d97757", codex: "#3f8f7a", grok: "#7c8594", pi: "#8b6fd6", copilot: "#3f7fd9",
};
/** A name of no known kind takes one of these, the same one every time. */
const OTHER_COLORS = ["#b0855a", "#5f9aa8", "#a7708f", "#7e9a5c"];

/** The kind an agent's name runs, from its setting's `adapter`, or its own name when that is a kind's (claude, codex). */
export function agentKind(name: string, adapter: string | undefined): BuiltinAdapterId | null {
  const kind = adapter ?? name;
  return (BUILTIN_ADAPTER_IDS as readonly string[]).includes(kind) ? kind as BuiltinAdapterId : null;
}

export function agentColor(name: string, kind: BuiltinAdapterId | null): string {
  if (kind) return KIND_COLOR[kind];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return OTHER_COLORS[hash % OTHER_COLORS.length]!;
}

/** Each kind's letters, as setup shows the kinds: an agent named after its kind wears them. */
export const KIND_LETTERS: Record<BuiltinAdapterId, string> = { claude: "Cl", codex: "Cx", grok: "Gk", copilot: "Gh", pi: "Pi" };

/**
 * Two letters for an agent: its kind's when it is named after it (claude → Cl, codex → Cx); otherwise from its own name,
 * the first letters of its first two words (claude-chrome → CC) or the first two of one word (inkling → In), so two
 * agents of one kind, sharing a colour, stay apart.
 */
export function agentLetters(name: string): string {
  if (name in KIND_LETTERS) return KIND_LETTERS[name as BuiltinAdapterId];
  const words = name.split(/[-_\s]+/).filter(Boolean);
  if (words.length > 1) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const word = words[0] ?? "?";
  return word[0]!.toUpperCase() + (word[1] ?? "");
}

type Agents = Readonly<Record<string, { adapter?: string; params?: Readonly<Record<string, readonly string[]>> }>>;
/** The model families each kind's models are named after, for a model no setting lists. */
const MODEL_FAMILIES: readonly [RegExp, BuiltinAdapterId][] = [
  [/^(claude|opus|sonnet|haiku|fable)\b/i, "claude"], [/^(gpt|o\d|codex)\b/i, "codex"], [/^grok\b/i, "grok"],
];

/**
 * Who a model name says ran, for a place that knows only the model (History's tags, the analysis by model): the kind
 * whose models it is among or is named after, else the agent whose setting offers it; null when nothing says. A place
 * that knows the Run's agent names it instead.
 */
export function modelAgent(model: string, agents: Agents | undefined): { name: string; kind: BuiltinAdapterId | null } | null {
  const bare = model.replace(/\(.*\)$/, "").replace(/^[^/]+\//, "");
  // A kind's own models and families first: another kind's agent offering them (Copilot running a Claude model) does
  // not make every Run of that model its own.
  for (const kind of BUILTIN_ADAPTER_IDS)
    if (AGENT_ADAPTERS[kind].defaultParams.model?.includes(bare) || Object.hasOwn(AGENT_ADAPTERS[kind].contextDefaults, bare))
      return { name: kind, kind };
  const family = MODEL_FAMILIES.find(([pattern]) => pattern.test(bare))?.[1];
  if (family) return { name: family, kind: family };
  for (const [name, setting] of Object.entries(agents ?? {}))
    if (setting.params?.model?.includes(bare)) return { name, kind: agentKind(name, setting.adapter) };
  return null;
}
