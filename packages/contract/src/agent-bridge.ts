/**
 * Built-in bridge stdin and stdout. Codex forwards app-server items; the other tool events carry bounded display previews,
 * and what the tool ran and got back as written, up to the limit a step's opened text has.
 */
import { z } from 'zod';
import { tokenCountersSchema } from './run-contract.js';
import type { RunFailure } from './run-failure.js';
import type { ContextUpdate } from './agent-context.js';
import { RUN_STEP_FULL_TEXT_LIMIT, RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT, runStepLineSchema, runStepTextSchema } from './work-contract.js';
import { clipRunText } from './work-preview.js';

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

/**
 * The fields of a provider item that the step reading takes (what it asked, how it went, what came back), by item; any
 * other field stays out of the bridge's output.
 */
const BRIDGE_ITEM_FIELDS = ['id', 'text', 'command', 'cwd', 'status', 'exitCode', 'aggregatedOutput', 'query', 'action', 'changes',
  'server', 'namespace', 'tool', 'name', 'arguments', 'result', 'error', 'contentItems', 'success', 'prompt', 'model',
  'receiverThreadIds', 'path'] as const;
/** How large one line a bridge writes may grow, whatever it holds: well under the 2 MiB a Run's outcome reader takes. */
export const BRIDGE_LINE_BYTES = 1024 * 1024;
/** The shortest a text is cut to while a line is too long: names and IDs stay whole. */
const SHORTEST_TEXT = 64;
type Clipped = Record<string, number>;
/** Every text in `value` cut to `limit` characters, the code points each lost counted in `clipped` by its path. */
function clipTexts(value: unknown, path: string, limit: number, clipped: Clipped): unknown {
  if (typeof value === 'string') {
    if (value.length <= limit) return value;
    const kept = clipRunText(value, limit);
    let left = 0;
    for (const _ of value.slice(kept.length)) left++;
    clipped[path] = (clipped[path] ?? 0) + left;
    return kept;
  }
  if (Array.isArray(value)) return value.map((each, at) => clipTexts(each, `${path}.${at}`, limit, clipped));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, clipTexts(each, path ? `${path}.${key}` : key, limit, clipped)]));
  return value;
}
const lineBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
/** What was cut said where the reading looks for it: an item's `clipped` by path, a tool event's text by its `omitted`. */
function sayClipped(event: Record<string, unknown>, clipped: Clipped): Record<string, unknown> {
  const cut = (prefix: string) => Object.entries(clipped).filter(([path]) => path === prefix || path.startsWith(`${prefix}.`));
  const said = { ...event };
  const item = said.item as Record<string, unknown> | undefined;
  if (item && typeof item === 'object') {
    const own = Object.fromEntries(cut('item').map(([path, count]) => [path.slice('item.'.length), count]));
    if (Object.keys(own).length) said.item = { ...item, clipped: { ...item.clipped as Clipped | undefined, ...own } };
  }
  for (const key of ['input', 'output']) {
    const text = said[key] as { text: string; omitted: number } | undefined;
    const lost = cut(`${key}.text`).reduce((sum, [, count]) => sum + count, 0);
    if (text && lost) said[key] = { ...text, omitted: text.omitted + lost };
  }
  return said;
}
/**
 * A line a bridge writes, kept under BRIDGE_LINE_BYTES whatever it holds, so no line voids a Run's outcome. One that
 * fits is written as it is. Else every text is cut shorter, halved each time, down to SHORTEST_TEXT; while it is still
 * too long, an item's structured fields, the largest first, are put as their JSON text and cut the same way. What was
 * cut is said by `sayClipped`, so a step opened says how much it left out.
 */
export function boundBridgeEvent(event: BridgeEvent): BridgeEvent {
  if (lineBytes(event) <= BRIDGE_LINE_BYTES) return event;
  let source = event as Record<string, unknown>;
  const fit = () => {
    for (let limit = RUN_STEP_FULL_TEXT_LIMIT; ; limit = Math.max(SHORTEST_TEXT, Math.floor(limit / 2))) {
      const clipped: Clipped = {};
      const said = sayClipped(clipTexts(source, '', limit, clipped) as Record<string, unknown>, clipped);
      if (lineBytes(said) <= BRIDGE_LINE_BYTES || limit === SHORTEST_TEXT) return said;
    }
  };
  let said = fit();
  const item = source.item as Record<string, unknown> | undefined;
  const structured = item ? Object.entries(item).filter(([, value]) => value !== null && typeof value === 'object')
    .sort(([, a], [, b]) => lineBytes(b) - lineBytes(a)).map(([key]) => key) : [];
  for (const key of structured) {
    if (lineBytes(said) <= BRIDGE_LINE_BYTES) break;
    source = { ...source, item: { ...source.item as Record<string, unknown>, [key]: JSON.stringify((source.item as Record<string, unknown>)[key]) } };
    said = fit();
  }
  return said as BridgeEvent;
}
/** A provider item as it crosses the bridge: its type (snake case) and the fields the step reading takes, as given. */
export function boundaryItem(type: string, item: Record<string, unknown>): BridgeItem {
  return { type, ...Object.fromEntries(BRIDGE_ITEM_FIELDS.filter(key => item[key] !== undefined).map(key => [key, item[key]])) };
}
/** How many characters the bridge cut from the texts under these fields of an item (boundBridgeEvent's `clipped`). */
export function clippedUnder(item: Record<string, unknown>, fields: readonly string[]): number {
  const clipped = item.clipped !== null && typeof item.clipped === 'object' ? item.clipped as Record<string, unknown> : {};
  return Object.entries(clipped).reduce((sum, [path, count]) =>
    fields.includes(path.split('.')[0]!) && typeof count === 'number' ? sum + count : sum, 0);
}
