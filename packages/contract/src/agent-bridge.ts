/** The built-in bridges' stdin/stdout boundary. Provider-specific objects never cross it. */
import { z } from 'zod';
import { tokenCountersSchema } from './run-contract.js';
import type { RunFailure } from './run-failure.js';
import type { ContextUpdate } from './agent-context.js';

export const agentUsageSchema = z.object({ scope: z.enum(['conversation', 'run']), counters: tokenCountersSchema }).strict();
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type BridgeInstruction = { id: string; text: string };
export type BridgeItem = { type: string; [key: string]: unknown };
export type BridgeEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'input.accepted' | 'input.taken'; id: string }
  | { type: 'input.not_sent'; id: string; message: string; evidence: 'transfer_not_started' }
  | { type: 'input.uncertain'; id: string; message: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: AgentUsage | null }
  /** `cause`: the bridge recognized the agent's own report that its plan or the model ran out (see RunFailure). */
  | { type: 'turn.failed'; error: { message: string; cause?: RunFailure['cause'] } }
  /** How full the main conversation is, as the agent last said (contextUpdateSchema). */
  | { type: 'context.updated'; context: ContextUpdate }
  | { type: 'error'; message: string }
  | { type: 'item.started' | 'item.completed'; item: BridgeItem };
