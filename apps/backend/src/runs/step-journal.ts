/**
 * A Run's step journal (RUN_FILES.steps): when each step started and ended, kept as it happens by the Run's manager,
 * which reads the agent's output while it runs. The index of steps (run-steps.ts) reads the output again whenever
 * someone opens it, and can say what a step was but not when; the journal is the one record of when.
 *
 * Each start and end is appended once. A step is named by the number of the output line that started it and its tool
 * call ID, so reading the output again from its start (a new manager for the same output) appends only what the journal
 * does not hold yet: a time written once is never replaced.
 */
import { appendFileSync, closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { RUN_FILES, RUN_STEP_TEXT_LIMIT, RUN_TOOL_ID_LIMIT, clipRunText, stepJournalEntrySchema,
  type StepFingerprint, type StepJournalEntry, type StepOutput, type StepTimeSource } from '@alpacawork/contract/run';
import { optionalRunFile, readWholeRunFile } from './files.js';
import type { ActivityEvent } from './activity-events.js';
import { stepInputDocument } from '../agents/adapters/activity.js';

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Text with what changes from one run of the same thing to the next replaced; numbers too unless `numbers` keeps them. */
const replaced = (text: string, numbers = false) => replacedIds(text).replace(/\b\d+\b/g, number => numbers ? number : '<n>');
const replacedIds = (text: string) => text
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
  .replace(/(^|[\s"'=:(])(?:~|\$\w+|\$\{\w+\})?\/[^\s"';|&)]*/gm, '$1<path>')
  .replace(/\b[0-9a-f]{7,64}\b/gi, hex => /[a-f]/i.test(hex) && /\d/.test(hex) ? '<hash>' : hex)
  .replace(/\b[TRPAQ]\d+\b/g, '<id>');

/**
 * What a step ran, with what changes from one run of the same thing to the next replaced, so the same command run
 * again reads as the same: absolute paths (where it ran included), UUIDs, long hex digests, task, Run and project IDs,
 * and numbers. `body` is a digest of the whole input so replaced (its numbers kept), when it has more than its first line (a heredoc's
 * text, a script), so two runs of the same first line with different bodies stay apart.
 */
export function stepFingerprint(input: string): StepFingerprint | null {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  const newline = text.indexOf('\n'), first = newline === -1 ? text : text.slice(0, newline);
  return { line: clipRunText(replaced(first), RUN_STEP_TEXT_LIMIT), body: newline === -1 ? null : short(replaced(text, true)) };
}

/** What came back, as a size and a digest; `whole` false when the agent cut it, so the digest covers its start only. */
function stepOutput(output: { text: string; omitted: number } | undefined): StepOutput | null {
  if (!output || (!output.text && !output.omitted)) return null;
  return { chars: output.text.length + output.omitted, digest: short(output.text), whole: output.omitted === 0 };
}

/**
 * The journal's entries as written, skipping a line that cannot be read (a torn last line after a crash; the next
 * append starts on a line of its own). Read whole: about 200 bytes a step event.
 */
export function readStepJournal(folder: string): StepJournalEntry[] {
  const bytes = optionalRunFile(() => readWholeRunFile(folder, RUN_FILES.steps));
  if (!bytes) return [];
  return bytes.toString('utf8').split('\n').flatMap(line => {
    if (!line) return [];
    try {
      const parsed = stepJournalEntrySchema.safeParse(JSON.parse(line));
      return parsed.success ? [parsed.data] : [];
    } catch { return []; }
  });
}

const key = (event: StepJournalEntry['event'], line: number, id: string) => `${event}\0${line}\0${id}`;

/** Appends to one Run's journal what the output says of its steps, each start and end once. */
export class StepJournal {
  /** The step a tool call's ID names now, by the line that started it: an ID used again after its end starts another. */
  private readonly open = new Map<string, number>();
  private held: Set<string> | null = null;
  private failed = false;

  constructor(private readonly folder: string) {}

  /** One adapter event read from output line `line`, read at `read` (ISO). */
  observe(event: ActivityEvent, line: number, read: string): void {
    if (this.failed) return;
    const { kind, id } = event;
    if ((kind !== 'tool_start' && kind !== 'tool_end') || typeof id !== 'string' || !id || id.length > RUN_TOOL_ID_LIMIT) return;
    const source: StepTimeSource = event.at === read ? 'read' : 'row';
    if (kind === 'tool_start' || !this.open.has(id)) {
      if (kind === 'tool_start' && this.open.has(id)) return;
      if (kind === 'tool_start' && (typeof event.toolName !== 'string' || !event.toolName)) return;
      this.open.set(id, line);
      const document = event.call ? stepInputDocument(event.call) : undefined;
      this.append({ event: 'start', line, id, at: event.at, source,
        fingerprint: stepFingerprint(document ?? event.input?.text ?? event.detail?.text ?? ''),
        parent: typeof event.parent === 'string' && event.parent && event.parent.length <= RUN_TOOL_ID_LIMIT ? event.parent : null });
      if (kind === 'tool_start') return;
    }
    const started = this.open.get(id)!;
    this.open.delete(id);
    this.append({ event: 'end', line: started, id, at: event.at, source,
      state: event.outcome?.unknown ? 'unknown' : event.outcome?.failed ? 'failed' : 'done',
      output: stepOutput(event.outcome?.output ?? (event.outcome?.result.text ? { text: event.outcome.result.text, omitted: 0 } : undefined)) });
  }

  /** The steps still open when the agent's turn ended end with it, at the time the end was read. */
  settle(state: 'done' | 'failed' | 'unknown', read: string): void {
    for (const [id, line] of this.open) this.append({ event: 'end', line, id, at: read, source: 'read', state, output: null });
    this.open.clear();
  }

  private append(entry: StepJournalEntry): void {
    this.held ??= new Set(readStepJournal(this.folder).map(held => key(held.event, held.line, held.id)));
    const name = key(entry.event, entry.line, entry.id);
    if (this.held.has(name)) return;
    try {
      const fd = openSync(`${this.folder}/${RUN_FILES.steps}`, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND, 0o600);
      try {
        // A line torn by a crash is closed first, so this entry is a line of its own.
        const size = fstatSync(fd).size, last = Buffer.alloc(1);
        const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
        appendFileSync(fd, (torn ? '\n' : '') + JSON.stringify(entry) + '\n');
      } finally { closeSync(fd); }
      this.held.add(name);
    } catch (error) {
      // The journal is a record beside the Run, not part of it: a Run goes on without it, and says so once.
      this.failed = true;
      console.error('Step journal could not be written', error);
    }
  }
}
