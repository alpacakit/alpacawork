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

/** JSON text of any value, however deep: the native writer, else one that keeps its own stack (it never calls itself). */
export function jsonText(value: unknown, indent = 2): string {
  try { return JSON.stringify(value, null, indent) ?? ''; } catch { /* too deep for the native writer */ }
  const out: string[] = [];
  const stack: { entries: [string | null, unknown][]; at: number; close: string }[] = [];
  const open = (each: unknown) => {
    if (each !== null && typeof each === 'object') {
      const array = Array.isArray(each);
      out.push(array ? '[' : '{');
      stack.push({ entries: array ? (each as unknown[]).map(item => [null, item]) : Object.entries(each as object), at: 0, close: array ? ']' : '}' });
    } else out.push(JSON.stringify(each) ?? 'null');
  };
  open(value);
  while (stack.length) {
    const frame = stack.at(-1)!;
    if (frame.at === frame.entries.length) { out.push(frame.close); stack.pop(); continue; }
    const [key, each] = frame.entries[frame.at]!;
    if (frame.at++) out.push(',');
    if (key !== null) out.push(`${JSON.stringify(key)}:`);
    open(each);
  }
  return out.join('');
}
/**
 * A change list said as a person reads it (each file's change, a blank line between), with where each file's heading
 * ends in that text: how many headings a text cut from its end still shows is counted from these, never searched for.
 */
export function fileChangesText(changes: readonly unknown[]): { text: string; headingEnds: number[] } {
  const parts: string[] = [], headingEnds: number[] = [];
  let at = 0;
  for (const change of changes.map(record)) {
    // Where the heading ends is its whole length: a line break in a file's name does not end it.
    const part = fileChangeText(change), heading = fileChangeHeading(change).length;
    if (parts.length) at += 2;
    headingEnds.push(at + heading);
    parts.push(part); at += part.length;
  }
  return { text: parts.join('\n\n'), headingEnds };
}
/** How many headings a text of `length` characters, cut from the end of a change list's text, shows whole. */
export const headingsShown = (headingEnds: readonly number[], length: number) => {
  let shown = 0;
  while (shown < headingEnds.length && headingEnds[shown]! <= length) shown++;
  return shown;
};
/** A file change said as a person reads it: what was done to which path (and where it moved), then its diff. */
export function fileChangeText(change: Record<string, unknown>): string {
  return [fileChangeHeading(change), typeof change.diff === 'string' && change.diff ? change.diff : ''].filter(Boolean).join('\n');
}
/** A file change's heading, whole: what was done to which path (and where it moved), a line break in a name kept in it. */
function fileChangeHeading(change: Record<string, unknown>): string {
  const kind = change.kind !== null && typeof change.kind === 'object' ? change.kind as Record<string, unknown> : {};
  const done = typeof change.kind === 'string' ? change.kind : typeof kind.type === 'string' ? kind.type : 'change';
  const moved = typeof kind.move_path === 'string' ? ` → ${kind.move_path}` : '';
  return `${done}: ${String(change.path)}${moved}`;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const texts = (value: unknown) => Array.isArray(value)
  ? value.map(record).filter(block => block.type === 'text' || block.type === 'inputText').flatMap(block => typeof block.text === 'string' ? [block.text] : []).join('\n')
  : '';
/**
 * The fields of an item a person reads (what it ran, got back or changed), and how each is said as text: the same
 * text the step shows opened, whether the field arrives as text or as structure. Every other field says what the step
 * is and how it went (its ID, type, state, exit code, a file's path and kind) and is never cut or changed.
 */
export const ITEM_READABLE: Record<string, (value: unknown) => string> = {
  aggregatedOutput: value => typeof value === 'string' ? value : jsonText(value),
  command: value => typeof value === 'string' ? value : jsonText(value),
  prompt: value => typeof value === 'string' ? value : jsonText(value),
  query: value => typeof value === 'string' ? value : jsonText(value),
  text: value => typeof value === 'string' ? value : jsonText(value),
  arguments: value => typeof value === 'string' ? value : jsonText(value),
  action: value => typeof value === 'string' ? value : jsonText(value),
  changes: value => typeof value === 'string' ? value : fileChangesText(Array.isArray(value) ? value : []).text,
  result: value => {
    if (typeof value === 'string') return value;
    const result = record(value);
    return texts(value) || texts(result.content) || (result.structuredContent === undefined || result.structuredContent === null ? ''
      : jsonText(result.structuredContent));
  },
  contentItems: value => typeof value === 'string' ? value : texts(value) || jsonText(value),
  error: value => typeof value === 'string' ? value : typeof record(value).message === 'string' ? record(value).message as string : jsonText(value),
};
const utf8 = new TextEncoder();
/** Room kept for the counts of what was cut, one per readable field at most. */
const CLIPPED_ROOM = 1024;
/** Room a change list leaves for the texts beside it when it is too long to keep whole. */
const CHANGE_LIST_TEXT_ROOM = 256 * 1024;
/** The bytes `text` takes once written as a JSON string. */
const writtenBytes = (text: string) => utf8.encode(JSON.stringify(text)).length;
/** `text` cut from its end to at most `bytes` as written (and the step text limit), and the code points it lost. */
function cutText(text: string, bytes: number): { text: string; lost: number } {
  let keep = Math.min(text.length, RUN_STEP_FULL_TEXT_LIMIT);
  if (writtenBytes(text.slice(0, keep)) > bytes) {
    let low = 0, high = keep;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (writtenBytes(text.slice(0, mid)) <= bytes) low = mid; else high = mid - 1;
    }
    keep = low;
  }
  const kept = clipRunText(text, keep);
  let lost = 0;
  for (const _ of text.slice(kept.length)) lost++;
  return { text: kept, lost };
}
/**
 * A line a bridge writes, kept under BRIDGE_LINE_BYTES whatever it holds, so no line voids a Run's outcome. One that
 * fits is written as it is. Else what a person reads is said as text (ITEM_READABLE; a tool event's input and output
 * already are), what says what the step is and how it went is kept whole, and the room left is shared among the texts,
 * each cut from its end; how much each lost goes with that field alone (an item's `clipped`, a text's `omitted`). A
 * change list keeps each file's path and kind as they were (as many as fit), its text going in `changesText`; a result
 * keeps whether it was an error in `resultIsError`. A line still too long after that falls to the last guard (leastOf),
 * so no content makes a line worse than main's.
 */
export function boundBridgeEvent(event: BridgeEvent): BridgeEvent {
  // Whatever goes wrong on the way (a structure too deep to write), the last guard still writes a line that fits.
  try { return cutReadable(event); } catch { return leastOf(event); }
}
function cutReadable(event: BridgeEvent): BridgeEvent {
  let line: string | null;
  try { line = JSON.stringify(event); } catch { line = null; }
  if (line !== null && utf8.encode(line).length <= BRIDGE_LINE_BYTES) return event;
  const said = { ...event } as Record<string, unknown>;
  // Each text to cut: where it is put back, how much room it needs, and where its loss is told.
  // A text is said once the change list is known, so the change list's text says the files the line keeps.
  const parts: { text: () => string; put: (text: string, lost: number) => void }[] = [];
  const item = record(said.item), clipped: Record<string, number> = {};
  let kept: Record<string, unknown> | null = null;
  if (said.item !== undefined) {
    kept = { ...item };
    for (const [field, readable] of Object.entries(ITEM_READABLE)) {
      if (!(field in item) || item[field] === undefined) continue;
      const name = field === 'changes' ? 'changesText' : field;
      if (field === 'changes' && Array.isArray(item.changes))
        kept.changes = item.changes.map(record).map(change => ({ path: change.path, kind: change.kind }));
      else delete kept[field];
      if (field === 'result' && record(item.result).isError === true) kept.resultIsError = true;
      const into = kept;
      const value = item[field];
      const put = (text: string, lost: number) => { into[name] = text; if (lost) clipped[name] = lost; else delete clipped[name]; };
      // The change list's text says the files the line keeps, and how many headings it shows whole goes with it
      // (changesShown), counted as it is cut.
      if (field === 'changes' && Array.isArray(value)) {
        let ends: number[] = [];
        parts.push({ text: () => { const said = fileChangesText(value.slice(0, (into.changes as unknown[]).length)); ends = said.headingEnds; return said.text; },
          put: (text, lost) => { put(text, lost); into.changesShown = headingsShown(ends, text.length); } });
      } else parts.push({ text: () => readable(value), put });
    }
    said.item = kept;
  }
  for (const key of ['input', 'output']) {
    const value = said[key] as { text: string; omitted: number } | undefined;
    if (value && typeof value.text === 'string')
      parts.push({ text: () => value.text, put: (text, lost) => { said[key] = { text, omitted: value.omitted + lost }; } });
  }
  // The room the texts may share: the line with every text empty is what is never cut (the clipped counts' room kept).
  for (const part of parts) part.put('', 0);
  // A change list too long for the line is read as text too: the files that fit are kept from its start, and how many
  // it holds (changeCount) is kept whole.
  if (kept && Array.isArray(kept.changes)) {
    const changes = kept.changes as unknown[], over = () => utf8.encode(JSON.stringify(said)).length + CLIPPED_ROOM > BRIDGE_LINE_BYTES - CHANGE_LIST_TEXT_ROOM;
    kept.changeCount = changes.length;
    if (over()) {
      let low = 0, high = changes.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        kept.changes = changes.slice(0, mid);
        if (over()) high = mid - 1; else low = mid;
      }
      kept.changes = changes.slice(0, low);
    }
  }
  const fixed = utf8.encode(JSON.stringify(said)).length + CLIPPED_ROOM;
  let room = Math.max(0, BRIDGE_LINE_BYTES - fixed);
  const order = parts.map(part => { const text = part.text(); return { part, text, bytes: writtenBytes(text) }; }).sort((a, b) => a.bytes - b.bytes);
  order.forEach(({ part, text: whole, bytes }, at) => {
    const share = Math.floor(room / (order.length - at));
    const { text, lost } = cutText(whole, Math.min(bytes, share));
    part.put(text, lost);
    room -= writtenBytes(text);
  });
  if (kept && Object.keys(clipped).length) kept.clipped = clipped;
  return lineBytes(said) <= BRIDGE_LINE_BYTES ? said as BridgeEvent : leastOf(event);
}
/** The bytes a line takes as written; one too deep to write at all is taken as too long. */
const lineBytes = (value: unknown) => {
  try { return utf8.encode(JSON.stringify(value)).length; } catch { return Number.POSITIVE_INFINITY; }
};
/** The ceiling of a Run's outcome reader for one line (its MAX_LINE): the last guard never writes past it. */
export const OUTCOME_LINE_BYTES = 2 * 1024 * 1024;
/** What a step is and how it went: kept whole by the last guard by name, however long. */
const IDENTITY_FIELDS = ['type', 'id', 'status', 'exitCode', 'success', 'resultIsError'];
/** Any other field short enough to keep whole in the last guard: a code, a name, a reason. */
const SHORT_FIELD_BYTES = 256;
const isShort = (value: unknown) => value === null || typeof value === 'boolean' || typeof value === 'number'
  || typeof value === 'string' && writtenBytes(value) <= SHORT_FIELD_BYTES;
type Text = { holder: Record<string, unknown>; key: string; text: string };
/** The fields of `from` the last guard keeps in `into`: short ones whole, long texts set aside in `texts` to be cut. */
function keepShort(from: Record<string, unknown>, into: Record<string, unknown>, texts: Text[], longTexts: readonly string[] | 'all'): void {
  for (const [key, value] of Object.entries(from)) {
    if (IDENTITY_FIELDS.includes(key) && (value === null || typeof value !== 'object') || isShort(value)) into[key] = value;
    else if (typeof value === 'string' && (longTexts === 'all' || longTexts.includes(key))) texts.push({ holder: into, key, text: value });
  }
}
/** Each text in `texts` cut from its end so the line fits `limit`, the room shared among them. */
function shareRoom(line: Record<string, unknown>, texts: readonly Text[], limit: number): void {
  for (const { holder, key } of texts) holder[key] = '';
  let room = Math.max(0, limit - lineBytes(line));
  [...texts].sort((a, b) => a.text.length - b.text.length).forEach(({ holder, key, text }, at) => {
    holder[key] = cutText(text, Math.floor(room / (texts.length - at))).text;
    room -= writtenBytes(holder[key] as string);
  });
}
/**
 * The last guard, for a line still too long however its readable fields were cut. An item is written as main writes it
 * (its type, ID, command and text, those texts cut) with its short fields kept whole, so its state, exit code and
 * whether it failed still say how it went, marked `detailsDropped` so the step says its details could not be kept. Any
 * other line keeps its short fields, and those of the records it holds (a failure's reason), its long texts cut.
 *
 * The line always fits: under BRIDGE_LINE_BYTES once its texts are cut; when what is never cut (an ID) is too long for
 * that, its texts go, then its other fields, then its mark, so it is never longer than main's least line and never
 * past the outcome reader's OUTCOME_LINE_BYTES while main's would not be.
 */
function leastOf(event: BridgeEvent): BridgeEvent {
  const source = event as Record<string, unknown>, texts: Text[] = [];
  let line: Record<string, unknown>, holder: Record<string, unknown>;
  if (source.item !== undefined) {
    const item = record(source.item);
    holder = {};
    keepShort(item, holder, texts, ['command', 'text']);
    if (record(item.result).isError === true) holder.resultIsError = true;
    holder.detailsDropped = true;
    line = { type: source.type, item: holder };
  } else {
    line = holder = {};
    keepShort(source, line, texts, 'all');
    for (const [key, value] of Object.entries(source)) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const kept: Record<string, unknown> = {};
      keepShort(value as Record<string, unknown>, kept, texts, 'all');
      line[key] = kept;
    }
    holder.detailsDropped = true;
  }
  shareRoom(line, texts, BRIDGE_LINE_BYTES - CLIPPED_ROOM);
  if (lineBytes(line) <= BRIDGE_LINE_BYTES) return line as BridgeEvent;
  // What is never cut is itself too long: keep only what main keeps, then its mark only while it still fits.
  const id = (source.item !== undefined ? record(source.item) : source).id;
  const least: Record<string, unknown> = { type: holder.type ?? source.type, ...id !== undefined ? { id } : {} };
  const marked = source.item !== undefined ? { type: source.type, item: { ...least, detailsDropped: true } } : { ...least, detailsDropped: true };
  if (lineBytes(marked) <= OUTCOME_LINE_BYTES) return marked as BridgeEvent;
  return (source.item !== undefined ? { type: source.type, item: least } : least) as BridgeEvent;
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
