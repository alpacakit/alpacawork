/**
 * Step times for Runs from before they were kept as they happen (step-journal.ts), read afterwards from the agents' own
 * records of their conversations and written to each Run's step journal as `transcript` times.
 *
 * A Run's output names each step by its tool call ID, and the conversation's record names the same call with its times.
 * A conversation goes on across Runs (a resumed one is the same record), so its record is read once and each Run takes
 * the calls its own output names, within its own start and end. The journal keeps the first time written for each
 * step, so a step the Run's manager already timed keeps that time, and importing again adds nothing.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RUN_FILES, isRunMoving, runFolder, type RunRecord } from '@alpacawork/contract/run';
import { RunStore } from '@alpacawork/runs';
import { runtimeAdapter } from '../agents/registry.js';
import { JsonlReader, STEP_LINE_LIMIT } from './readers/jsonl.js';
import { StepJournal, type StepTime } from './step-journal.js';
import type { CallTimes, ConversationCalls } from './transcripts/calls.js';
import { ClaudeTranscripts } from './transcripts/claude.js';
import { CodexTranscripts } from './transcripts/codex.js';

/**
 * Why a Run got no times. `running`: it has not ended (its manager times it). `agent_not_read`: its agent keeps no record
 * this reads. `no_conversation`: its record names no conversation. `no_output`: its output is gone.
 * `transcript_missing`: the conversation's record is not on this PC (removed after the agent's retention period, or
 * kept elsewhere). `transcript_unreadable`: the record is there but not in a form this reads (the agent changed it).
 * `no_matching_calls`: the record reads, but names none of the Run's steps within the Run's time. `write_failed`: the
 * Run's step journal could not be written.
 */
export const STEP_IMPORT_REASONS = ['running', 'agent_not_read', 'no_conversation', 'no_output', 'transcript_missing',
  'transcript_unreadable', 'no_matching_calls', 'write_failed'] as const;
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

/** How far a call's time may lie outside its Run's start and end and still be the Run's (clocks read at different moments). */
const SLACK_MS = 60_000;

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
  if (isRunMoving(run.state)) return fail('running');
  const adapter = runtimeAdapter(run.launch.adapter), agent = run.launch.adapter;
  if (!adapter || (agent !== 'claude' && agent !== 'codex')) return fail('agent_not_read');
  if (!run.session) return fail('no_conversation');
  if (!existsSync(join(folder, RUN_FILES.stdout))) return fail('no_output');
  const record = await readers[agent].calls(run.session.id);
  if (record.state === 'missing') return fail('transcript_missing');
  if (record.state === 'unreadable') return fail('transcript_unreadable');

  const from = Date.parse(run.started_at ?? run.created_at) - SLACK_MS, to = Date.parse(run.ended_at ?? run.created_at) + SLACK_MS;
  const within = (at: string | null): StepTime | null => {
    if (at === null) return null;
    const ms = Date.parse(at);
    return ms >= from && ms <= to ? { at, source: 'transcript' } : null;
  };
  const journal = new StepJournal(folder, write);
  const steps = new Set<string>(), timed = new Set<string>();
  // The output read as the Run's manager read it, so each step is named by the same output line and ID.
  const lines = new JsonlReader(() => {}, STEP_LINE_LIMIT);
  const accept = (value: unknown, line: number) => {
    for (const event of adapter.activity(value, run.ended_at ?? run.created_at)) {
      if ((event.kind !== 'tool_start' && event.kind !== 'tool_end') || typeof event.id !== 'string') continue;
      const call: CallTimes | undefined = record.calls.get(event.id);
      const time = within(event.kind === 'tool_start' ? call?.startedAt ?? null : call?.endedAt ?? null);
      const started = journal.observe(event, line, time, within(call?.startedAt ?? null));
      if (started === null) continue;
      steps.add(`${started}\0${event.id}`);
      if (time) timed.add(`${started}\0${event.id}`);
    }
  };
  lines.read(folder, accept);
  lines.finish(accept);
  Object.assign(result, { steps: steps.size, timed: timed.size, added: journal.added });
  if (journal.broken) return fail('write_failed');
  if (steps.size && !timed.size) return fail('no_matching_calls');
  return result;
}
