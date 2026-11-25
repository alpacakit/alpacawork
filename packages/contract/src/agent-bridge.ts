/**
 * Built-in bridge stdin and stdout. Codex forwards app-server items; the other tool events carry bounded display previews,
 * and what the tool ran and got back as written, up to the limit a step's opened text has.
 */
import { z } from 'zod';
import { tokenCountersSchema } from './run-contract.js';
import type { RunFailure } from './run-failure.js';
import type { ContextUpdate } from './agent-context.js';
import { RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, runStepLineSchema, runStepTextSchema } from './work-contract.js';

export const agentUsageSchema = z.object({ scope: z.enum(['conversation', 'run']), counters: tokenCountersSchema }).strict();
export type AgentUsage = z.infer<typeof agentUsageSchema>;
/** Compact the conversation before this instruction: the agent summarizes its history with its own model. `instructions`
 * is what the summary should keep in focus, for an agent that takes it (AdapterDescription.compaction). */
export type CompactionRequest = { instructions: string | null };
export type BridgeInstruction = { id: string; text: string; compact?: CompactionRequest };
export type BridgeItem = { type: string; [key: string]: unknown };
const bridgeTool = {
  id: z.string().min(1).max(RUN_TOOL_ID_LIMIT),
  tool: z.enum(['command_execution', 'mcp_tool_call']),
  name: z.string().max(RUN_TOOL_NAME_LIMIT).nullable(),
};
export const bridgeToolEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool.started'), ...bridgeTool, detail: runStepLineSchema,
    about: z.string().max(RUN_STEP_TEXT_LIMIT).nullable(), input: runStepTextSchema.optional() }).strict(),
  z.object({ type: z.literal('tool.completed'), ...bridgeTool, result: runStepLineSchema, failed: z.boolean(),
    output: runStepTextSchema.optional() }).strict(),
]);
export type BridgeToolEvent = z.infer<typeof bridgeToolEventSchema>;

export type BridgeEvent =
  | BridgeToolEvent
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
  /** How the compaction an instruction asked for ended, before that instruction's turn; neither is a turn. */
  | { type: 'compaction.completed' }
  | { type: 'compaction.failed'; message: string }
  | { type: 'item.started' | 'item.completed'; item: BridgeItem };
