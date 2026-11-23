/** The services' own names for each kind of agent, untranslated: the product's full name and the short one a bar has room for. */
import type { BuiltinAdapterId } from "@alpacawork/contract/agent-adapters";

export const AGENT_NAMES: Record<BuiltinAdapterId, { product: string; short: string }> = {
  claude: { product: "Claude Code", short: "Claude" },
  codex: { product: "Codex", short: "Codex" },
  grok: { product: "Grok Build", short: "Grok" },
  pi: { product: "pi", short: "pi" },
  copilot: { product: "GitHub Copilot", short: "Copilot" },
};
