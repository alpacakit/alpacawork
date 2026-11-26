import type { RunSummary } from '@alpacawork/contract/run-summary';
import { isRunMoving, runFolder, type RunRecord } from '@alpacawork/contract/run';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { RunStore } from '@alpacawork/runs';
import { supportsTally, type Tally } from '../agents/adapters/tally.js';
import { runStepIndexOf, type RunStepIndex } from '../runs/run-steps.js';
import { noOutputs, noProduced, stepRepeats, testObservations } from '../runs/step-evidence.js';
import { readRunTally } from './tally-file.js';
import { readTallyScope, TALLY_STDOUT_BYTES } from './tally-scope.js';

function summaryEligible(run: RunRecord, since: number | null): boolean {
  return since !== null && run.state !== 'joined' && supportsTally(run.launch.adapter) && run.started_at !== null &&
    Date.parse(run.started_at) >= since && (run.ended_at === null || Date.parse(run.ended_at) >= since);
}

function summaryState(run: RunRecord, eligible: boolean, tally: Tally | null): RunSummary['state'] {
  if (isRunMoving(run.state) && (run.started_at === null ? supportsTally(run.launch.adapter) : eligible))
    return 'pending';
  if (!eligible || run.pids.agent === null) return 'unsupported';
  return tally?.state ?? 'pending';
}

/** The shared tally and coverage of its step evidence. The caller chooses how to present them. */
export function readRunSummaryFacts(root: string, run: RunRecord, since: number | null) {
  const eligible = summaryEligible(run, since);
  const tally = eligible ? readRunTally(runFolder(root, run.id)) : null;
  const state = summaryState(run, eligible, tally);
  return {
    tally, canReadStepEvidence: tally !== null && state !== 'unsupported',
    summary: { state, basis: tally?.basis ?? [], outputs: tally?.outputs ?? noOutputs(), produced: tally?.produced ?? noProduced() },
  };
}

export function readSummaryStepIndex(root: string, run: RunRecord) {
  return runStepIndexOf(root, run, TALLY_STDOUT_BYTES);
}

/** Use the same prefix when a consumer already has a full index for step times. */
export function summaryObservations(index: RunStepIndex | null) {
  return index?.observations(TALLY_STDOUT_BYTES) ?? [];
}

export async function readRunSummary(root: string, id: string): Promise<RunSummary> {
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 });
  let run;
  try { run = store?.runtimeGet(id); } finally { store?.close(); }
  if (!run || run.role === 'coordinator')
    throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', { run: id }, { reason: { kind: 'run_does_not_exist' } });

  const { summary, tally, canReadStepEvidence } = readRunSummaryFacts(root, run, readTallyScope(root));
  const index = canReadStepEvidence ? await readSummaryStepIndex(root, run) : null;
  return { ...summary, run: run.id,
    tools: tally?.tools ?? {}, mcp: tally?.mcp ?? {}, skills: tally?.skills ?? {}, subagentTools: tally?.subagentTools ?? 0,
    tests: testObservations(summaryObservations(index)).map(item => item.test),
    repeats: stepRepeats(summaryObservations(index)),
    compactions: run.compactions ?? [], newConversation: run.newConversation ?? null };
}
