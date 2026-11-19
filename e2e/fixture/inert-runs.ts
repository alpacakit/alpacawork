/** Saved synthetic Runs must not inherit an executable from captured history. Check before serve. */
import assert from 'node:assert/strict';
import type { RunRecord } from '@alpacawork/contract/run';

export function assertInertFixtureRuns(runs: Pick<RunRecord, 'id' | 'launch'>[]) {
  for (const run of runs) {
    assert.deepEqual(run.launch.argv, ['/usr/bin/false'], `Saved synthetic Run ${run.id} must be inert before serve`);
    assert.equal(run.launch.path, '/usr/bin:/bin', `Saved synthetic Run ${run.id} must use the inert fixture path`);
  }
}
