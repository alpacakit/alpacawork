import { RUN_STEP_TEXT_LIMIT, type RunStepLine } from './work-contract.js';

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

/** What a tool call ran, read or searched, as written: the human-readable argument when the tool gives it a named field. */
export function toolInputText(tool: unknown, raw: unknown): string | undefined {
  const input = record(raw);
  const detail = ((): unknown => {
    switch (tool) {
      case 'Bash': return input.command;
      case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return firstText(input.file_path, input.path, input.notebook_path);
      case 'Grep': return [input.pattern, firstText(input.path, input.glob)].filter(value => typeof value === 'string').join('  ');
      case 'Glob': return [input.pattern, input.path].filter(value => typeof value === 'string').join('  ');
      case 'WebSearch': case 'ToolSearch': return input.query;
      case 'WebFetch': return input.url;
      case 'Agent': case 'Task': return firstText(input.description, input.prompt);
      case 'Skill': return [input.skill, input.args].filter(value => typeof value === 'string').join(' ');
      default: return firstText(input.command, input.file_path, input.path, input.query, input.url) ?? toolArgumentText(raw);
    }
  })();
  return typeof detail === 'string' ? detail : undefined;
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
