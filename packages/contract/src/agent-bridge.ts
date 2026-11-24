/** The built-in bridges' stdin/stdout boundary. Provider-specific objects never cross it. */
import { z } from 'zod';
import { tokenCountersSchema } from './run-contract.js';
import type { RunFailure } from './run-failure.js';

export const agentUsageSchema = z.object({ scope: z.enum(['conversation', 'run']), counters: tokenCountersSchema }).strict();
export type AgentUsage = z.infer<typeof agentUsageSchema>;
/** Compact the conversation before this instruction: the agent summarizes its history with its own model. `instructions`
 * is what the summary should keep in focus, for an agent that takes it (AdapterDescription.compaction). */
export type CompactionRequest = { instructions: string | null };
export type BridgeInstruction = { id: string; text: string; compact?: CompactionRequest };
export type BridgeEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'input.accepted' | 'input.taken'; id: string }
  | { type: 'input.not_sent'; id: string; message: string; evidence: 'transfer_not_started' }
  | { type: 'input.uncertain'; id: string; message: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: AgentUsage | null }
  /** `cause`: the bridge recognized the agent's own report that its plan or the model ran out (see RunFailure). */
  | { type: 'turn.failed'; error: { message: string; cause?: RunFailure['cause'] } }
  | { type: 'error'; message: string }
  /** How the compaction an instruction asked for ended, before that instruction's turn; neither is a turn. */
  | { type: 'compaction.completed' }
  | { type: 'compaction.failed'; message: string }
  | { type: 'item.started' | 'item.completed'; item: { type: string; [key: string]: unknown } };
