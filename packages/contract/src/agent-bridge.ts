/** Built-in bridge stdin and stdout. Codex forwards app-server items; the other tool events carry bounded display previews. */
import { z } from 'zod';
import { tokenCountersSchema } from './run-contract.js';
import type { RunFailure } from './run-failure.js';
import { RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, runStepLineSchema } from './work-contract.js';

export const agentUsageSchema = z.object({ scope: z.enum(['conversation', 'run']), counters: tokenCountersSchema }).strict();
export type AgentUsage = z.infer<typeof agentUsageSchema>;
export type BridgeInstruction = { id: string; text: string };
const bridgeTool = {
  id: z.string().min(1).max(RUN_TOOL_ID_LIMIT),
  tool: z.enum(['command_execution', 'mcp_tool_call']),
  name: z.string().max(RUN_TOOL_NAME_LIMIT).nullable(),
};
export const bridgeToolEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool.started'), ...bridgeTool, detail: runStepLineSchema,
    about: z.string().max(RUN_STEP_TEXT_LIMIT).nullable() }).strict(),
  z.object({ type: z.literal('tool.completed'), ...bridgeTool, result: runStepLineSchema, failed: z.boolean() }).strict(),
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
  | { type: 'error'; message: string }
  | { type: 'item.started' | 'item.completed'; item: { type: string; [key: string]: unknown } };
