import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { hasCode } from '@alpacawork/core';
import { RUN_FILES, runFolder, runNumber } from '@alpacawork/contract/run';
import { runIdSchema } from '@alpacawork/contract';
import { readControl } from '../control/task-store.js';
import { supportsTally, TallyParser, type Tally } from '../agents/adapters/tally.js';
import { RunStepIndex } from '../runs/run-steps.js';
import { runtimeAdapter } from '../agents/registry.js';
import { memberBasis, noOutputs, noProduced, stepTotals } from '../runs/step-evidence.js';
import { JsonlReader, STEP_LINE_LIMIT } from '../runs/readers/jsonl.js';
import { writeRunFile } from '../runs/files.js';
import { tallyEligible, TALLY_STDOUT_BYTES } from './tally-scope.js';
import { ordinaryFile, readRunTally } from './tally-file.js';

const BATCH_SIZE = 32;
const { root, tallySince } = workerData as { root: string; tallySince: number };
const port = parentPort!;
type TallyRun = { id: string; provider: string; adapter: string; session: string | null; cwd: string; memberReply: string | null };
const runSource = `SELECT 'R' || id AS id, json_extract(record,'$.agent') AS provider,
  json_extract(record,'$.launch.adapter') AS adapter, session_id AS session, json_extract(record,'$.cwd') AS cwd,
  CASE WHEN json_extract(record,'$.role')='worker' AND result_state='present' THEN substr(result,-2048) END AS memberReply
  FROM runs WHERE ${tallyEligible}`;
const pending = new Set<string>(), done = new Set<string>();
let history: TallyRun[] = [], recent: TallyRun[] = [], running = false, stopped = false;

function tally({ id, provider, adapter, session, cwd, memberReply }: TallyRun): Tally | undefined {
  const folder = runFolder(root, id);
  if (!lstatSync(dirname(folder)).isDirectory() || !lstatSync(folder).isDirectory()) return;
  const existing = readRunTally(folder);
  if (existing) return existing;

  const parser = new TallyParser(adapter, provider, session), reader = runtimeAdapter(adapter);
  const steps = reader && new RunStepIndex(folder, reader, cwd, false);
  let state: Tally['state'] = 'unsupported';
  if (supportsTally(adapter)) {
    try {
      state = ordinaryFile(join(folder, RUN_FILES.stdout), (fd, size) => {
        if (!size) return 'unsupported';
        const lines = new JsonlReader(() => steps?.unreadable(), STEP_LINE_LIMIT, reader?.skipOutputLine);
        const observe = (value: unknown, line: number) => { parser.observe(value); steps?.observeRow(value, line); };
        lines.readFd(fd, observe, TALLY_STDOUT_BYTES);
        if (size <= TALLY_STDOUT_BYTES) lines.finish(observe);
        return size > TALLY_STDOUT_BYTES || lines.rejection ? 'partial' : 'complete';
      });
    } catch (error) {
      if (!hasCode(error, 'ENOENT') && !hasCode(error, 'ELOOP')) throw error;
    }
  }
  const totals = steps ? stepTotals(steps.observations()) : { outputs: noOutputs(), produced: noProduced(), truncated: false };
  const result = parser.finish(state === 'complete' && totals.truncated ? 'partial' : state,
    { outputs: totals.outputs, produced: totals.produced, basis: memberBasis(memberReply ?? '') });
  writeRunFile(folder, RUN_FILES.tally, JSON.stringify(result));
  return result;
}

function loadPending() {
  const ids: string[] = [];
  for (const id of pending) {
    pending.delete(id);
    ids.push(id);
    if (ids.length === BATCH_SIZE) break;
  }
  try {
    return readControl(root, db => db.prepare(runSource + ' AND runs.id IN (SELECT value FROM json_each(?))')
      .all(tallySince, JSON.stringify(ids.map(runNumber))) as TallyRun[]);
  } catch {
    port.postMessage({ issue: ids.join(', ') });
    return [];
  }
}

function work() {
  if (stopped) return;
  if (!recent.length && pending.size) recent = loadPending();
  // Each turn works for 20 ms and sends at most a batch of tallies; a Run with no output to read costs little and
  // takes no place in the batch, so a record of many such Runs is gone through as fast as one of few.
  const batch: [string, Tally][] = [], until = performance.now() + 20;
  while (batch.length < BATCH_SIZE && (recent.length || !pending.size && history.length) && performance.now() < until) {
    const run = recent.pop() ?? history.pop()!;
    if (done.has(run.id)) continue;
    try {
      const value = tally(run);
      if (value) { done.add(run.id); batch.push([run.id, value]); }
    } catch (error) {
      // Usage remains available if a Run folder disappeared or could not be tallied.
      if (!hasCode(error, 'ENOENT')) port.postMessage({ issue: run.id });
    }
  }
  if (batch.length) port.postMessage({ batch });
  if (pending.size || recent.length || history.length) setTimeout(work, 20);
  else running = false;
}

function rescan() {
  history = readControl(root, db => db.prepare(runSource + " ORDER BY julianday(json_extract(record,'$.ended_at')), runs.id")
    .all(tallySince) as TallyRun[]).filter(run => !done.has(run.id));
}

port.on('message', (message: { stop?: true; rescan?: true; ids?: string[] }) => {
  if (message.stop) { stopped = true; port.close(); return; }
  if (message.rescan) rescan();
  for (const id of message.ids ?? []) if (runIdSchema.safeParse(id).success && !done.has(id)) pending.add(id);
  if (!running) { running = true; setImmediate(work); }
});
