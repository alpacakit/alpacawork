/** The manager owns this rebuildable projection; stdout.log remains its source. */
import { RUN_FILES, RUN_NOTE_LIMIT, runActivitySchema, runFolder, type ReadRunRecord, type RunActivity, type RunActivityView } from '@alpacawork/contract/run';
import { contextLimitsFor } from '../agents/context-limits.js';
import { mergeContext, type AgentContext, type ContextUpdate } from '@alpacawork/contract/agent-context';
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
export class OutputActivityReader {
  /** `reported`: what the agent said of its model's window or compaction point, for the model's own record. */
  constructor(private readonly adapter: AgentAdapter, private readonly now = () => Date.now(),
    private readonly reported: (update: ContextUpdate) => void = () => {}) {
    this.recent = new RecentWork();
  }
  private readonly lines = new JsonlReader(() => this.clearWork());
  private readonly tools = new Map<string, NonNullable<RunActivity['doing']>>();
  private latest: RunActivity | null = null;
  private note: RunActivity['note'] = null;
  /** The conversation's latest fill, merged from each row that says something of it. */
  private context: AgentContext | null = null;
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
    if (this.latest?.doing) { this.latest = { ...this.latest, doing: null }; this.dirty = true; }
  }

  private doing(): RunActivity['doing'] { return [...this.tools.values()].at(-1) ?? null; }

  private accept(value: unknown): void {
    const received = new Date(this.now()).toISOString();
    const update = this.adapter.context(value);
    if (update) {
      this.context = mergeContext(this.context, update, received);
      if (update.windowTokens !== undefined || update.compactAtTokens !== undefined) this.reported(update);
    }
    const event = this.project(value, received);
    if (event) { this.latest = event; this.dirty = true; }
    else if (update) {
      // A row that says only how full the conversation is keeps what the Run is doing and carries the new fill.
      this.latest = { ...this.latest ?? { at: received, kind: 'output', toolName: null, doing: null, note: this.note }, context: this.context };
      this.dirty = true;
    }
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
      }
      if (kind === 'tool_end') {
        if (typeof id === 'string' && this.tools.has(id)) {
          toolName = this.tools.get(id)!.toolName; this.tools.delete(id); this.recent.end(id, Date.parse(at));
        } else this.clearWork();
      }
      if (kind === 'result' || kind === 'error') this.clearWork();
      const text = words(event.text);
      if (text) this.note = { at, text };
      projected = { at, kind, toolName, doing: this.doing(), note: this.note, context: this.context };
    }
    return projected;
  }
}

/** A working Run's activity for the screen: its fill with its model's window and compaction point. */
export function readRunActivityView(root: string, run: Pick<ReadRunRecord, 'id' | 'agent' | 'launch'>): RunActivityView | null {
  const activity = readRunActivity(runFolder(root, run.id));
  if (!activity) return null;
  return { ...activity, context: activity.context && { ...activity.context, ...contextLimitsFor(root, run) } };
}

export function readRunActivity(folder: string): RunActivity | null {
  const bytes = optionalRunFile(() => readRunFile(folder, RUN_FILES.activity, 4096));
  if (!bytes) return null;
  try {
    const parsed = runActivitySchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
