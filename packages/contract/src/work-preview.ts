import { RUN_STEP_FULL_TEXT_LIMIT, RUN_STEP_TEXT_LIMIT, type RunStepLine, type RunStepText } from './work-contract.js';

export function clipRunText(value: string, limit: number): string {
  const prefix = value.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/** Keep one visible line and count the remaining breaks with constant working space. */
export function previewRunLine(value: unknown): RunStepLine {
  if (typeof value !== 'string') return { text: '', more: 0 };
  const trimmed = value.trim();
  const breaks = /\r\n|[\r\n]/g;
  const first = breaks.exec(trimmed);
  let more = 0;
  if (first) {
    more = 1;
    while (breaks.exec(trimmed)) more++;
  }
  return { text: clipRunText(trimmed.slice(0, first?.index).trimEnd(), RUN_STEP_TEXT_LIMIT), more };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const firstText = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value !== '');

export function toolArgumentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value == null) return undefined;
  // An opaque argument that cannot be serialized can still be omitted from the preview.
  try { return JSON.stringify(value); } catch { return undefined; }
}

/** A tool call's main argument: the fields that say what it ran, read or searched, in the order they are said. */
function mainFields(tool: unknown, input: Record<string, unknown>): string[] {
  const first = (...keys: string[]) => keys.filter(key => typeof input[key] === 'string' && input[key] !== '').slice(0, 1);
  const named = (...keys: string[]) => keys.filter(key => typeof input[key] === 'string');
  switch (tool) {
    case 'Bash': return named('command');
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return first('file_path', 'path', 'notebook_path');
    case 'Grep': return [...named('pattern'), ...first('path', 'glob')];
    case 'Glob': return named('pattern', 'path');
    case 'WebSearch': case 'ToolSearch': return named('query');
    case 'WebFetch': return named('url');
    case 'Agent': case 'Task': return first('description', 'prompt');
    case 'Skill': return named('skill', 'args');
    default: return first('command', 'file_path', 'path', 'query', 'url');
  }
}
const SEPARATOR: Record<string, string> = { Grep: '  ', Glob: '  ', Skill: ' ' };
/** Tools whose main argument is named: without it they ran nothing worth a line. */
const NAMED = new Set(['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'WebSearch', 'ToolSearch', 'WebFetch', 'Agent', 'Task', 'Skill']);
/** What a tool call ran, read or searched, as written: the human-readable argument when the tool gives it a named field. */
export function toolInputText(tool: unknown, raw: unknown): string | undefined {
  const input = record(raw), keys = mainFields(tool, input);
  if (!keys.length) return NAMED.has(String(tool)) ? undefined : toolArgumentText(raw);
  return keys.map(key => input[key] as string).join(SEPARATOR[String(tool)] ?? '');
}
/** One field of a tool's input as written: a text of several lines under its name, anything else after it. */
function field(key: string, value: unknown): string {
  if (typeof value === 'string') return value.includes('\n') ? `${key}:\n${value}` : `${key}: ${value}`;
  let text: string | undefined;
  try { text = JSON.stringify(value, null, 2); } catch { text = undefined; }
  return `${key}: ${text ?? String(value)}`;
}
/**
 * An input to read in full: its main argument as written, then every other field by name, each text with its own lines.
 * A field with no value says nothing and is left out.
 */
export function inputDocument(main: string | undefined, fields: Record<string, unknown>): string {
  const rest = Object.entries(fields).filter(([, value]) => value !== undefined && value !== null && !(Array.isArray(value) && !value.length))
    .map(([key, value]) => field(key, value));
  return [main ?? '', rest.join('\n')].filter(Boolean).join('\n\n');
}
/**
 * A tool call's whole input as written, to read in full (inputDocument): an edit's old and new text, a read's range.
 * The agent's words for a command are said apart, so they are not repeated.
 */
export function toolInputDocument(tool: unknown, raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return toolArgumentText(raw);
  const input = record(raw), main = mainFields(tool, input), said = tool === 'Bash' || typeof input.command === 'string' ? ['description'] : [];
  return inputDocument(main.length ? toolInputText(tool, raw) : undefined,
    Object.fromEntries(Object.entries(input).filter(([key]) => !main.includes(key) && !said.includes(key))));
}
/** A step's text to read in full, up to the limit; `omitted` counts the characters (code points) left out, before it too. */
export function fullRunText(value: string, omitted = 0): RunStepText {
  const text = clipRunText(value, RUN_STEP_FULL_TEXT_LIMIT);
  let left = 0;
  for (const _ of value.slice(text.length)) left++;
  return { text, omitted: omitted + left };
}
/** A tool call on one line: the first line of its input, and the agent's own words for a command. */
export function previewToolInput(tool: unknown, raw: unknown): { detail: RunStepLine; about: string | null } {
  const input = record(raw);
  const about = tool === 'Bash' || typeof input.command === 'string' ? previewRunLine(input.description).text || null : null;
  return { detail: previewRunLine(toolInputText(tool, raw)), about };
}

/** Take only text from a tool result's content blocks. */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.map(record).filter(block => block.type === 'text' || block.type === 'inputText')
    .flatMap(block => typeof block.text === 'string' ? [block.text] : []).join('\n');
}
