import type { AiRow } from '@alpacawork/contract';
import { compareRunIds, type CoordinatorRunRecord } from '@alpacawork/contract/run';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { compareRequestOrder, isUnfinished } from '@alpacawork/runs';
import { coordinatorLaunchSnapshot, type AgentsSettings } from '../agents-settings.js';
import { aiLaunchIdentity, distinctAiRows, sameAiLaunch } from '../ai-stack.js';

function preferResume(config: AgentsSettings, row: AiRow, path: string, previous: CoordinatorRunRecord | null) {
  if (previous) {
    try {
      const snapshot = coordinatorLaunchSnapshot(config, row.agent, 'resume', path, row.values, previous.launch);
      if (snapshot.ok) return snapshot;
    } catch (error) {
      if (!(error instanceof Problem) ||
        (error.reason?.kind !== 'selection_required' && error.reason?.kind !== 'new_conversation_required')) throw error;
    }
  }
  return coordinatorLaunchSnapshot(config, row.agent, 'start', path, row.values);
}

/** Choose the same row for admission, warm-up, the skill catalog and the projected conversation. */
export function coordinatorNextLaunch(config: AgentsSettings, runs: readonly CoordinatorRunRecord[], path = process.env.PATH ?? '') {
  const rows = distinctAiRows(config, config.coordinatorAiStack ?? []);
  const last = runs.filter(run => run.state === 'succeeded' || isUnfinished(run)).sort(compareRequestOrder).at(-1);
  const resumable = last && (last.session !== null || isUnfinished(last)) ? last : null;

  // A queued or joined turn didn't execute. Availability is the same observed stop cause the Run fallback uses.
  const executed = runs.filter(run => run.started_at !== null && run.state !== 'joined')
    .sort((a, b) => b.started_at!.localeCompare(a.started_at!) || compareRunIds(b, a))
    .map(run => ({ run, identity: aiLaunchIdentity(config, { agent: run.agent, values: run.launch.values }) }));
  const remaining = rows.filter(row => {
    const identity = aiLaunchIdentity(config, row);
    const latest = executed.find(entry => sameAiLaunch(entry.identity, identity))?.run;
    return !(latest?.state === 'failed' && latest.availability);
  });
  const candidates = remaining.length ? remaining : rows;

  let refusal: Problem | undefined;
  for (const [index, row] of candidates.entries()) {
    const previous = resumable?.agent === row.agent ? resumable : null;
    try {
      const snapshot = preferResume(config, row, path, previous);
      if (snapshot.ok) return { row, launch: snapshot.launch, restartArgv: snapshot.restartArgv, appliedValues: snapshot.appliedValues,
        continued: snapshot.mode === 'resume' ? previous : null, following: candidates.slice(index + 1) };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      refusal ??= error;
    }
  }
  return { row: null, error: refusal ?? new Problem(PROBLEM_CODE.invalidSettings,
    'Configure an AI for the coordinator in Settings → Server', undefined, { reason: { kind: 'no_configured_agents' } }) };
}
