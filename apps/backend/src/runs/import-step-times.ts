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
import type { ConversationCalls } from './transcripts/calls.js';
import { ClaudeTranscripts } from './transcripts/claude.js';
import { CodexTranscripts } from './transcripts/codex.js';

/**
 * Why a Run got no times. `running`: it has not ended (its manager times it). `agent_not_read`: its agent keeps no record
 * this reads. `no_conversation`: its record names no conversation. `no_output`: its output is gone. `output_unreadable`:
 * its output could not be read, or no line of it read as a step.
 * `transcript_missing`: the conversation's record is not on this PC (removed after the agent's retention period, or
 * kept elsewhere). `transcript_unreadable`: the record is there but not in a form this reads (the agent changed it).
 * `no_matching_calls`: the record reads, but names none of the Run's steps within the Run's time. `write_failed`: the
 * Run's step journal could not be written.
 */
export const STEP_IMPORT_REASONS = ['running', 'agent_not_read', 'no_conversation', 'no_output', 'output_unreadable',
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
  const record = await readers[agent].calls(run.session.id);
  if (record.state === 'missing') return fail('transcript_missing');
  if (record.state === 'unreadable') return fail('transcript_unreadable');

  // A conversation's Runs follow one another, so a time between this Run's start and end is this Run's.
  const from = run.started_at ?? run.created_at, to = run.ended_at;
  const own = (times: readonly string[] | undefined) => times?.filter(at => at >= from && at <= to).sort()[0] ?? null;
  const journal = new StepJournal(folder, write);
  // A step the Run's manager kept any time of is left as it is, so its start and end never come from two clocks.
  const kept = new Map<string, boolean>(), timed = new Set<string>(), steps = new Set<string>();
  const timeOf: StepTimeOf = (event, line, id) => {
    const name = `${line}\0${id}`;
    if (!kept.has(name)) kept.set(name, journal.holds(line, id));
    const at = kept.get(name) ? null : own(record.calls.get(id)?.[event === 'start' ? 'started' : 'ended']);
    if (at) timed.add(name);
    return at ? { at, source: 'transcript' } : null;
  };
  // The output read as the Run's manager read it, so each step is named by the same output line and ID.
  const lines = new JsonlReader(() => {}, STEP_LINE_LIMIT);
  const accept = (value: unknown, line: number) => {
    for (const event of adapter.activity(value, to)) {
      const named = journal.observe(event, line, timeOf);
      if (named !== null) steps.add(`${named}\0${event.id}`);
    }
  };
  try { lines.read(folder, accept); lines.finish(accept); }
  catch { return fail('output_unreadable'); }
  // A step whose end the output does not say ends when the record says it did.
  journal.settle('unknown', timeOf);
  Object.assign(result, { steps: steps.size, timed: timed.size, added: journal.added });
  if (journal.broken) return fail('write_failed');
  if (!steps.size && lines.rejection) return fail('output_unreadable');
  if (steps.size && !timed.size && ![...kept.values()].some(Boolean)) return fail('no_matching_calls');
  return result;
}
