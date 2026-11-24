/** The manager owns this rebuildable projection; stdout.log remains its source. */
import { RUN_FILES, RUN_NOTE_LIMIT, RUN_STEP_LIMIT, RUN_STEP_TEXT_LIMIT, runActivitySchema, type RunActivity, type RunStep } from '@alpacawork/contract/run';
import { optionalRunFile, readRunFile, writeRunFile } from './files.js';
import { INLINE_MARKDOWN_LINK } from '@alpacawork/contract';
import { JsonlReader } from './readers/jsonl.js';
import type { AgentAdapter } from '../agents/adapters/types.js';
import { RecentWork, recentWorkName } from './recent-work.js';

const name = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value.slice(0, 128) : null;
const words = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return null;
  // Keep a complete inline construct on the retained side of the display bound. Fenced code
  // may remain open: the shared renderer already draws an unfinished fence as code.
  let end = RUN_NOTE_LIMIT;
  const spans = new RegExp('`[^`\\n]+`|\\*\\*[^\\n]+?\\*\\*|' + INLINE_MARKDOWN_LINK.source, 'g');
  for (const match of text.matchAll(spans)) {
    if (match.index < end && match.index + match[0].length > end) { end = match.index; break; }
  }
  const clipped = text.slice(0, end).trimEnd();
  if (!clipped) return null;
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped;
};
/** The first line that says something, cut to the display bound, and how many lines follow it. */
const firstLine = (value: unknown): { text: string; more: number } => {
  const lines = (typeof value === 'string' ? value : '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd());
  const at = Math.max(0, lines.findIndex(line => line.trim()));
  let text = (lines[at] ?? '').trim().slice(0, RUN_STEP_TEXT_LIMIT);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return { text, more: lines.slice(at + 1).filter(line => line.trim()).length };
};
export class OutputActivityReader {
  constructor(private readonly adapter: AgentAdapter, private readonly now = () => Date.now()) {
    this.recent = new RecentWork();
  }
  private readonly lines = new JsonlReader(() => this.clearWork());
  private readonly tools = new Map<string, NonNullable<RunActivity['doing']>>();
  private latest: RunActivity | null = null;
  private note: RunActivity['note'] = null;
  private steps: RunStep[] = [];
  private dirty = false;
  private readonly recent: RecentWork;
  private writtenRecent: string | undefined;

  poll(folder: string): void {
    this.lines.read(folder, value => this.accept(value), 8 * 1024 * 1024);
    this.recent.advance(this.now());
    this.flush(folder);
  }

  finish(folder: string): void {
    this.lines.finish(value => this.accept(value));
    this.clearWork();
    this.flush(folder);
  }

  private clearWork(): void {
    this.tools.clear();
    this.recent.reset();
    // Nothing is known to be going any more: a step that never said it ended is over all the same.
    if (this.steps.some(step => step.state === 'running')) {
      this.steps = this.steps.map(step => step.state === 'running' ? { ...step, state: 'done' } : step);
      if (this.latest) { this.latest = { ...this.latest, steps: this.steps }; this.dirty = true; }
    }
    if (this.latest?.doing) { this.latest = { ...this.latest, doing: null }; this.dirty = true; }
  }

  private doing(): RunActivity['doing'] { return [...this.tools.values()].at(-1) ?? null; }

  private accept(value: unknown): void {
    const event = this.project(value, new Date(this.now()).toISOString());
    if (event) { this.latest = event; this.dirty = true; }
  }

  private flush(folder: string): void {
    const recent = JSON.stringify(this.recent.label);
    if (recent !== this.writtenRecent) {
      writeRunFile(folder, RUN_FILES.recentWork, recent);
      this.writtenRecent = recent;
    }
    if (this.dirty) {
      writeRunFile(folder, RUN_FILES.activity, JSON.stringify(this.latest));
      this.dirty = false;
    }
  }

  private project(value: unknown, received: string): RunActivity | null {
    let projected: RunActivity | null = null;
    for (const event of this.adapter.activity(value, received)) {
      const { at, kind, id } = event;
      let toolName = name(event.toolName);
      if (kind === 'tool_start') {
        if (typeof id === 'string' && id.length <= 128 && toolName) {
          if (this.tools.size >= 128 || this.tools.has(id)) this.clearWork();
          this.tools.set(id, { at, toolName, command: event.command ?? null });
          this.recent.start(id, recentWorkName(toolName, event.command ?? null), Date.parse(at));
        } else this.clearWork();
        if (typeof id === 'string' && id.length <= 128 && toolName) {
          const about = firstLine(event.about).text;
          this.steps = [...this.steps.filter(step => step.id !== id), { id, at, tool: toolName, ...firstLine(event.detail), about: about || null,
            state: 'running' as const, result: null }].slice(-RUN_STEP_LIMIT);
        }
      }
      if (kind === 'tool_end' && typeof id === 'string') {
        const outcome = event.outcome, result = outcome ? firstLine(outcome.text) : null, late = firstLine(event.detail);
        this.steps = this.steps.map(step => step.id !== id ? step : { ...step, ...(step.text ? {} : late),
          state: outcome?.failed ? 'failed' : 'done', result: result?.text ? result : null });
      }
      if (kind === 'tool_end') {
        if (typeof id === 'string' && this.tools.has(id)) {
          toolName = this.tools.get(id)!.toolName; this.tools.delete(id); this.recent.end(id, Date.parse(at));
        } else this.clearWork();
      }
      if (kind === 'result' || kind === 'error') this.clearWork();
      const text = words(event.text);
      if (text) this.note = { at, text };
      projected = { at, kind, toolName, doing: this.doing(), note: this.note, steps: this.steps };
    }
    return projected;
  }
}

export function readRunActivity(folder: string): RunActivity | null {
  const bytes = optionalRunFile(() => readRunFile(folder, RUN_FILES.activity, 64 * 1024));
  if (!bytes) return null;
  try {
    const parsed = runActivitySchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
