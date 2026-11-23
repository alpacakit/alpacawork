import { isDeepStrictEqual } from 'node:util';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { compareRequestOrder, isUnfinished } from '@alpacawork/runs';
import { coordinatorLaunchSnapshot, type AgentsSettings } from '../agents-settings.js';

/** Choose the same row for admission, warm-up, the skill catalog and the projected conversation. */
export function coordinatorNextLaunch(config: AgentsSettings, runs: readonly CoordinatorRunRecord[], path = process.env.PATH ?? '') {
  const rows = config.coordinatorAiStack ?? [];
  const last = runs.filter(run => run.state === 'succeeded' || isUnfinished(run)).sort(compareRequestOrder).at(-1);
  // A sessionless Run can still establish the conversation's current row.
  const resumable = last && (last.session !== null || isUnfinished(last)) ? last : null;
  const current = rows.findIndex(row => row.agent === last?.agent && isDeepStrictEqual(row.values, last.launch.values));
  const order = rows.map((_, index) => index);
  if (current > 0) order.unshift(...order.splice(current, 1));

  let refusal: Problem | undefined;
  for (const index of order) {
    const row = rows[index]!;
    const continued = resumable?.agent === row.agent ? resumable : null;
    try {
      const snapshot = coordinatorLaunchSnapshot(config, row.agent, continued ? 'resume' : 'start', path, row.values, continued?.launch);
      if (snapshot.ok) return { row, launch: snapshot.launch, restartArgv: snapshot.restartArgv, continued, following: rows.slice(index + 1) };
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      refusal ??= error;
    }
  }
  return { row: null, error: refusal ?? new Problem(PROBLEM_CODE.invalidSettings,
    'Configure an AI for the coordinator in Settings → Server', undefined, { reason: { kind: 'no_configured_agents' } }) };
}
