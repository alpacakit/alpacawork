/** The manager owns this rebuildable projection; stdout.log remains its source. */
import { RUN_FILES, RUN_NOTE_LIMIT, RUN_STEP_LIMIT, RUN_TOOL_ID_LIMIT, RUN_TOOL_NAME_LIMIT,
  clipRunText, runActivitySchema, type RunActivity, type RunStep } from '@alpacawork/contract/run';
import { mergeContext, type AgentContext, type ContextUpdate, type CompactionObservation } from '@alpacawork/contract/agent-context';
import { optionalRunFile, readRunFile, writeRunFile } from './files.js';
import { INLINE_MARKDOWN_LINK } from '@alpacawork/contract';
import { JsonlReader, STEP_LINE_LIMIT } from './readers/jsonl.js';
import type { AgentAdapter } from '../agents/adapters/types.js';
import { RecentWork, recentWorkName, runStepKind } from './recent-work.js';
import type { ActivityEvent } from './activity-events.js';
import { StepJournal, liveStepTime } from './step-journal.js';
import { OutputLedger } from './output-ledger.js';

// Leave room for escaped tool details and the bounded output ledger.
const ACTIVITY_FILE_LIMIT = 68 * 1024;
const MAX_ACTIVE_TOOLS = 128;
type ActiveTool = NonNullable<RunActivity['doing']>;
type Settled = Exclude<RunStep['state'], 'running'>;

const toolName = (value: unknown): string | null => typeof value === 'string' ? clipRunText(value, RUN_TOOL_NAME_LIMIT) || null : null;
const words = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
  if (!text) return null;
  // Keep a complete inline construct on the retained side of the display bound. Fenced code
  // may remain open: the shared renderer already draws an unfinished fence as code.
  let end = RUN_NOTE_LIMIT;
  const spans = new RegExp('`[^`\\n]+`|\\*\\*[^\\n]+?\\*\\*|' + INLINE_MARKDOWN_LINK.source, 'g');
  for (const match of text.matchAll(spans)) {
    if (match.index >= end) break;
    if (match.index + match[0].length > end) { end = match.index; break; }
  }
  return clipRunText(text, end).trimEnd() || null;
};

function stepFields(event: ActivityEvent, id: string, name: string) {
  const tool = toolName(event.stepTool) ?? name;
  return { id, at: event.at, tool, kind: runStepKind(tool, name, event.command ?? null),
    ...(event.detail ?? { text: '', more: 0 }), about: event.about ?? null };
}

/** Live tool identities are independent of the bounded display history. */
class WorkActivity {
  private readonly active = new Map<string, ActiveTool>();
  private readonly recent = new RecentWork();
  steps: RunStep[] = [];
  /** Every step start, end and settling seen, counted whatever `steps` keeps of them: that something changed. */
  events = 0;
  /** Steps begun (a tool call started, or reported whole without a start): only these say the Run took steps. */
  started = 0;

  get doing(): ActiveTool | null { return [...this.active.values()].at(-1) ?? null; }
  get hasActive(): boolean { return this.active.size > 0; }
  get label() { return this.recent.label; }
  advance(at: number): void { this.recent.advance(at); }

  observe(event: ActivityEvent): string | null {
    const { at, kind, id } = event;
    const name = toolName(event.toolName);
    if (kind === 'result' || kind === 'error' || kind === 'tool_start' || kind === 'tool_end') this.events++;
    if (kind === 'result' || kind === 'error') {
      this.reset(kind === 'result' ? 'done' : 'failed');
      return name;
    }
    if (kind !== 'tool_start' && kind !== 'tool_end') return name;
    if (typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) {
      this.reset();
      return name;
    }
    if (kind === 'tool_start') {
      if (!name) return name;
      if (this.active.size >= MAX_ACTIVE_TOOLS || this.active.has(id)) this.reset();
      const command = event.command ?? null;
      this.active.set(id, { at, toolName: name, command });
      const step = stepFields(event, id, name);
      this.recent.start(id, recentWorkName(step.kind, command), Date.parse(at));
      this.started++;
      this.push({ ...step, state: 'running', result: null });
      return name;
    }
    const active = this.active.get(id);
    if (active) {
      this.active.delete(id);
      this.recent.end(id, Date.parse(at));
    }
    const previous = this.steps.find(step => step.id === id);
    if (!previous && (active || !name)) return active?.toolName ?? name;
    const state = event.outcome?.failed ? 'failed' : 'done';
    const result = event.outcome?.result;
    const details = { state, result: result?.text ? result : null } as const;
    if (previous) {
      this.steps = this.steps.map(step => step !== previous ? step : {
        ...step, ...(step.text ? {} : event.detail), ...details,
      });
    } else if (name) {
      // Some bridge tools report a complete item without sending a start.
      this.started++;
      this.push({ ...stepFields(event, id, name), ...details });
    }
    return active?.toolName ?? name;
  }

  reset(state?: Settled): void {
    // Settling or dropping what is running changes those steps as an end would.
    if (this.steps.some(step => step.state === 'running')) this.events++;
    this.active.clear();
    this.recent.reset();
    // After a gap in stdout, unfinished items have no reliable outcome.
    this.steps = state
      ? this.steps.map(step => step.state === 'running' ? { ...step, state } : step)
      : this.steps.filter(step => step.state !== 'running');
  }

  private push(step: RunStep): void {
    const steps = [...this.steps.filter(previous => previous.id !== step.id), step];
    if (steps.length > RUN_STEP_LIMIT) {
      const settled = steps.findIndex(previous => previous.state !== 'running');
      steps.splice(Math.max(0, settled), 1);
    }
    this.steps = steps;
  }
}

export class OutputActivityReader {
  /**
   * `reported` keeps a window named by the agent in the model's record; `compacted` is told each compaction the agent
   * says, with how full its conversation was before (the last fill read) and after.
   */
  constructor(private readonly adapter: AgentAdapter, private readonly now = () => Date.now(),
    private readonly reported: (update: ContextUpdate) => void = () => {},
    private readonly compacted: (fill: CompactionObservation, at: string) => void = () => {}, private readonly cwd?: string) {
    this.lines = new JsonlReader(() => this.resetWork(), STEP_LINE_LIMIT, adapter.skipActivityLine);
    this.modelOutput = adapter.modelOutputReader();
  }

  private readonly work = new WorkActivity();
  private readonly output = new OutputLedger();
  // The same lines the index of steps reads (STEP_LINE_LIMIT), so the steps counted here are the steps it lists.
  private readonly lines: JsonlReader;
  private readonly modelOutput: ReturnType<AgentAdapter['modelOutputReader']>;
  private latest: Pick<RunActivity, 'at' | 'kind' | 'toolName' | 'note'> | null = null;
  private context: AgentContext | null = null;
  private dirty = false;
  private writtenRecent: string | undefined;
  private writtenActivity: string | undefined;

  /** The Run's step journal, opened on the folder the first poll reads. */
  private journal: StepJournal | null = null;

  poll(folder: string): void {
    this.journal ??= new StepJournal(folder, this.cwd);
    this.lines.read(folder, (value, line) => this.accept(value, line), 8 * 1024 * 1024);
    const now = this.now();
    this.work.advance(now);
    this.flush(folder, now);
  }

  finish(folder: string, state: Settled = 'failed'): void {
    this.journal ??= new StepJournal(folder, this.cwd);
    try {
      this.lines.read(folder, (value, line) => this.accept(value, line, false));
      this.lines.finish((value, line) => this.accept(value, line, false));
      this.tellCompaction();
    } finally {
      const now = this.now(), read = new Date(now).toISOString();
      this.journal.settle(state, () => ({ at: read, source: 'observed' }));
      this.resetWork(state);
      if (this.output.discard()) this.dirty = true;
      this.flush(folder, now);
    }
  }

  /** A compaction whose fill after it is not known yet: told with the next fill read, or without one when the Run ends. */
  private pendingCompaction: { fill: CompactionObservation; at: string } | null = null;
  private tellCompaction(afterTokens: number | null = null): void {
    if (!this.pendingCompaction) return;
    this.compacted({ ...this.pendingCompaction.fill, afterTokens }, this.pendingCompaction.at);
    this.pendingCompaction = null;
  }

  private resetWork(state?: Settled): void {
    this.dirty ||= this.work.hasActive || this.work.steps.some(step => step.state === 'running');
    this.work.reset(state);
  }

  private accept(value: unknown, line: number, live = true): void {
    const now = this.now(), received = new Date(now).toISOString();
    if (live) {
      const second = Math.floor(now / 1000), output = this.modelOutput(value, second);
      if (output && this.output.observe(output, second)) {
        this.latest ??= { at: received, kind: 'output', toolName: null, note: null };
        this.dirty = true;
      }
    }
    const update = this.adapter.context(value);
    if (update) {
      // A compaction is told with the fill after it. An agent that does not say it (Codex) is told at its next model
      // call, whose fill is the compacted conversation's; one the Run ends before is told without it (finish).
      if (update.compacted) {
        this.tellCompaction();
        const fill = { beforeTokens: update.compactedFrom ?? this.context?.usedTokens ?? null, afterTokens: update.usedTokens ?? null, ...update.compactionDetails };
        if (fill.afterTokens === null) this.pendingCompaction = { fill, at: received };
        else this.compacted(fill, received);
      } else if (this.pendingCompaction && update.usedTokens != null) this.tellCompaction(update.usedTokens);
      this.context = mergeContext(this.context, update, received);
      if (update.windowTokens !== undefined) this.reported(update);
      // A context-only update leaves the latest work and words in place.
      this.latest ??= { at: received, kind: 'output', toolName: null, note: null };
      this.dirty = true;
    }
    for (const event of this.adapter.activity(value, received)) {
      this.journal?.observe(event, line, liveStepTime(event, received), live);
      if (live && (event.kind === 'tool_start' || event.kind === 'tool_end'))
        this.output.tool(Math.floor(Math.min(now, Date.parse(event.at)) / 1000), event.kind === 'tool_end');
      const name = this.work.observe(event);
      const text = words(event.text);
      const note = text ? { at: event.at, text } : this.latest?.note ?? null;
      this.latest = { at: event.at, kind: event.kind, toolName: name, note };
      this.dirty = true;
    }
  }

  private flush(folder: string, now: number): void {
    const recent = JSON.stringify(this.work.label);
    if (recent !== this.writtenRecent) {
      writeRunFile(folder, RUN_FILES.recentWork, recent);
      this.writtenRecent = recent;
    }
    if (this.dirty && this.latest) {
      const output = this.output.snapshot(Math.floor(now / 1000));
      const activity: RunActivity = { ...this.latest, doing: this.work.doing, context: this.context, steps: this.work.steps,
        stepEvents: this.work.events, stepsStarted: this.work.started, ...(output ? { output } : {}) };
      const serialized = JSON.stringify(activity);
      if (serialized !== this.writtenActivity) {
        writeRunFile(folder, RUN_FILES.activity, serialized);
        this.writtenActivity = serialized;
      }
      this.dirty = false;
    }
  }
}

export function readRunActivity(folder: string): RunActivity | null {
  const bytes = optionalRunFile(() => readRunFile(folder, RUN_FILES.activity, ACTIVITY_FILE_LIMIT));
  if (!bytes) return null;
  try {
    const parsed = runActivitySchema.safeParse(JSON.parse(bytes.toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
