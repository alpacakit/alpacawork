/** The built-in bridges' stdin/stdout boundary. Provider-specific objects never cross it. */
import { z } from 'zod';
import { tokenCountersSchema } from './run-contract.js';

export const agentUsageSchema = z.object({ scope: z.enum(['conversation', 'run']), counters: tokenCountersSchema }).strict();
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type BridgeInstruction = { id: string; text: string };
export type BridgeEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'input.accepted' | 'input.taken'; id: string }
  | { type: 'input.not_sent'; id: string; message: string; evidence: 'transfer_not_started' }
  | { type: 'input.uncertain'; id: string; message: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: AgentUsage | null }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'error'; message: string }
  | { type: 'item.started' | 'item.completed'; item: { type: string; [key: string]: unknown } };
