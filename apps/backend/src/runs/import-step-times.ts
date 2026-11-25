/**
 * Step times for Runs from before they were kept as they happen (step-journal.ts), read afterwards from the agents' own
 * records of their conversations and written to each Run's step journal as `transcript` times.
 *
 * A Run's output names each step by its tool call ID, and the conversation's record names the same call with its times.
 * A conversation goes on across Runs (a resumed one is the same record), so its record is read once and each Run takes
 * the calls its own output names, within its own start and end. A step the Run's manager already kept a time of is
 * left as it is, and the journal keeps the first time written, so importing again adds nothing.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUN_FILES, isRunMoving, runFolder, type RunRecord } from '@alpacawork/contract/run';
import { RunStore } from '@alpacawork/runs';
import { runtimeAdapter } from '../agents/registry.js';
import { JsonlReader, STEP_LINE_LIMIT } from './readers/jsonl.js';
import { StepJournal, type StepTimeOf } from './step-journal.js';
import type { CallTime, ConversationCalls } from './transcripts/calls.js';
import { ClaudeTranscripts } from './transcripts/claude.js';
import { CodexTranscripts } from './transcripts/codex.js';

/**
 * Why a Run got no times. `running`: it has not ended (its manager times it). `agent_not_read`: its agent keeps no record
 * this reads. `no_conversation`: its record names no conversation. `no_output`: its output is gone. `output_unreadable`:
 * its output could not be read, or no line of it read as JSON. `no_steps`: its output lists no step (it ran no tool,
 * or its output is not in a form the agent's reader knows).
 * `transcript_missing`: the conversation's record is not on this PC (removed after the agent's retention period, or
 * kept elsewhere). `transcript_unreadable`: the record is there but not in a form this reads (the agent changed it).
 * `no_matching_calls`: the record reads, but no step of the Run could be matched to one run of its call within the
 * Run's time (none there, or its call ID used more than once). `write_failed`: the
 * Run's step journal could not be written.
 */
export const STEP_IMPORT_REASONS = ['running', 'agent_not_read', 'no_conversation', 'no_output', 'output_unreadable', 'no_steps',
  'transcript_missing', 'transcript_unreadable', 'no_matching_calls', 'write_failed'] as const;
export type StepImportReason = typeof STEP_IMPORT_REASONS[number];

/**
 * One Run's import: its steps (as run steps lists them), how many got a time from the record, the journal lines added
 * (would be, in a trial), and why it got none when it did not.
 */
export type RunStepImport = { run: string; task: string; agent: string; steps: number; timed: number; added: number;
  reason: StepImportReason | null };

/** Where the agents keep their records; by default where they keep them for this PC's person. */
export type TranscriptHomes = { claude: string; codex: readonly string[] };
export const defaultTranscriptHomes = (env: NodeJS.ProcessEnv = process.env, home = homedir()): TranscriptHomes => ({
  claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
  codex: env.CODEX_HOME ? [env.CODEX_HOME] : [join(home, '.codex-alpacawork'), join(home, '.codex')],
});

/** The readers of each agent's records, by the adapter that ran the Run. */
export type TranscriptReaders = Record<'claude' | 'codex', { calls(conversation: string): Promise<ConversationCalls> }>;
export const transcriptReaders = (homes: TranscriptHomes = defaultTranscriptHomes()): TranscriptReaders =>
  ({ claude: new ClaudeTranscripts(homes.claude), codex: new CodexTranscripts(homes.codex) });
/** What of a Run its import reads. */
export type ImportedRun = Pick<RunRecord, 'id' | 'task' | 'state' | 'session' | 'created_at' | 'started_at' | 'ended_at'> & { launch: Pick<RunRecord['launch'], 'adapter'> };

/** Imports the step times of every ended Task Run in workspace `root`; `write` false only counts them. */
export async function importStepTimes(root: string, options: { write: boolean; homes?: TranscriptHomes;
  onRun?: (result: RunStepImport) => void }): Promise<RunStepImport[]> {
  const readers = transcriptReaders(options.homes);
  const store = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
  if (!store) throw new Error(`No Run records in ${root}`);
  let runs: RunRecord[];
  try { runs = store.read().flatMap(record => record.role === 'coordinator' ? [] : [record]); } finally { store.close(); }
  const results: RunStepImport[] = [];
  for (const run of runs) {
    const result = await importRunSteps(runFolder(root, run.id), run, readers, options.write);
    results.push(result);
    options.onRun?.(result);
  }
  return results;
}

/** Imports the step times of Run `run`, whose folder is `folder`. */
export async function importRunSteps(folder: string, run: ImportedRun, readers: TranscriptReaders, write: boolean): Promise<RunStepImport> {
  const result: RunStepImport = { run: run.id, task: run.task, agent: run.launch.adapter, steps: 0, timed: 0, added: 0, reason: null };
  const fail = (reason: StepImportReason) => ({ ...result, reason });
  // Only a Run that has ended has the whole of its time; one still waiting for review may go on.
  if (isRunMoving(run.state) || run.ended_at === null) return fail('running');
  const adapter = runtimeAdapter(run.launch.adapter), agent = run.launch.adapter;
  if (!adapter || (agent !== 'claude' && agent !== 'codex')) return fail('agent_not_read');
  if (!run.session) return fail('no_conversation');
  if (!existsSync(join(folder, RUN_FILES.stdout))) return fail('no_output');
  let record: ConversationCalls;
  try { record = await readers[agent].calls(run.session.id); } catch { return fail('transcript_unreadable'); }
  if (record.state === 'missing') return fail('transcript_missing');
  if (record.state === 'unreadable') return fail('transcript_unreadable');
  const calls = record.calls, ended = run.ended_at;

  /** The Run's output read as its manager read it, each step named by the same output line and ID as in its journal. */
  const read = (journal: StepJournal, timeOf: StepTimeOf) => {
    const lines = new JsonlReader(() => {}, STEP_LINE_LIMIT), named = new Map<string, string[]>();
    const accept = (value: unknown, line: number) => {
      for (const event of adapter.activity(value, ended)) {
        const step = journal.observe(event, line, timeOf), id = event.id as string;
        if (step === null) continue;
        const steps = named.get(id) ?? [];
        if (!steps.includes(`${step}`)) named.set(id, [...steps, `${step}`]);
      }
    };
    lines.read(folder, accept); lines.finish(accept);
    // A step whose end the output does not say ends when the record says it did.
    journal.settle('unknown', timeOf);
    return { named, rejected: lines.rejection !== null };
  };
  // First the steps alone: which steps each call ID names, in order.
  let steps: Map<string, string[]>, rejected: boolean;
  try { ({ named: steps, rejected } = read(new StepJournal(folder, false), () => null)); } catch { return fail('output_unreadable'); }
  result.steps = [...steps.values()].reduce((sum, each) => sum + each.length, 0);
  if (!result.steps) return fail(rejected ? 'output_unreadable' : 'no_steps');

  // A conversation's Runs follow one another, so a run of a call wholly between this Run's start and end is this
  // Run's. A step takes it when its call ID names that step alone in the Run and the record has that one run of it
  // there; an ID used again leaves which is which unknown, and none of its steps is written.
  const from = Date.parse(run.started_at ?? run.created_at), to = Date.parse(ended);
  const within = (at: number | null) => at === null || (at >= from && at <= to);
  const runOf = (id: string): CallTime | null => {
    const runs = (calls.get(id) ?? []).filter(time => within(time.startedAt) && within(time.endedAt));
    return runs.length === 1 && steps.get(id)?.length === 1 ? runs[0]! : null;
  };
  const journal = new StepJournal(folder, write), timed = new Set<string>();
  let live = false;
  // A step with a time its Run's manager kept as it happened is left as it is, so its start and end never come from
  // two clocks. One an earlier import began is completed only from the same run of the call.
  const timeOf: StepTimeOf = (event, line, id) => {
    if (journal.keptLive(line, id)) { live = true; return null; }
    const time = runOf(id);
    if (!time) return null;
    const held = (['start', 'end'] as const).map(each => journal.heldTime(each, line, id)?.at);
    if (held[0] !== undefined && Date.parse(held[0]) !== time.startedAt || held[1] !== undefined && Date.parse(held[1]) !== time.endedAt) return null;
    const at = event === 'start' ? time.startedAt : time.endedAt;
    if (at === null) return null;
    timed.add(`${line}\0${id}`);
    return { at: new Date(at).toISOString(), source: 'transcript' };
  };
  try { read(journal, timeOf); } catch { return fail('output_unreadable'); }
  Object.assign(result, { timed: timed.size, added: journal.added });
  if (journal.broken) return fail('write_failed');
  if (!timed.size && !live) return fail('no_matching_calls');
  return result;
}
