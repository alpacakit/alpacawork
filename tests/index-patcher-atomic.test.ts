import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectionVersion } from '@alpacawork/contract/control';
import { IndexPatcher, type PatchSource } from '@alpacawork/backend/test-dist/receiver/index-rows.js';

function source(version: number, fail?: 'row' | 'meta'): PatchSource {
  const empty = () => ({ upsert: {}, remove: [] });
  return {
    rev: version, generation: 'synthetic', pv: version as ProjectionVersion, candidates: ['T2', 'T3'],
    row: id => {
      if (fail === 'row' && id === 'T3') throw new Error('Synthetic row read failed');
      return { id, title: `Version ${version}` } as never;
    },
    placements: id => id === 'T2' ? [{ id: version === 1 ? 'PL2' : 'PL3', revision: version }] as never : [],
    runs: id => id === 'T2' ? [{ id: version === 1 ? 'R2' : 'R3', revision: version }] as never : [],
    home: id => id === 'T2' && version === 1 ? { row: { taskId: id, section: 'work' }, after: null } as never : undefined,
    children: id => id === 'T2' && version === 1 ? { live: 1, finished: 0 } as never : undefined,
    counts: { closed: { root: { finished: version } }, home: { root: { review: version } },
      tasks: { root: version }, all: { running: version } } as never,
    requiredPv: { view: empty(), history: empty(), page: empty(), timeline: empty(), search: empty() },
    meta: { root: `/workspace/${version}`, attachmentBytes: version,
      host: fail === 'meta' ? { toJSON() { throw new Error('Synthetic metadata encoding failed'); } } : null } as never,
  };
}

test('a failed patch leaves every memo at the last successful publication for retry', () => {
  const patcher = new IndexPatcher(), oracle = new IndexPatcher();
  patcher.patch(source(1)); oracle.patch(source(1));
  assert.throws(() => patcher.patch(source(2, 'row')), /Synthetic row read failed/);
  const retried = patcher.patch(source(2));
  assert.deepEqual(retried, oracle.patch(source(2)), 'retry includes the first Task and its removed/added owned records');
  assert(retried!.tasks.upsert.some(row => row.id === 'T2'));
  assert.deepEqual(retried!.placements.remove, ['PL2']);
  assert.deepEqual(retried!.runs.remove, ['R2']);
  assert.deepEqual(retried!.home.remove, ['T2']);

  // This fault arrives after task, count-map, counts.all and earlier metadata writes.
  assert.throws(() => patcher.patch(source(3, 'meta')), /Synthetic metadata encoding failed/);
  const lateRetry = patcher.patch(source(3));
  assert.deepEqual(lateRetry, oracle.patch(source(3)), 'late retry also restores count summaries and metadata');
  assert(lateRetry!.counts.all);
  assert.equal(lateRetry!.meta.root, '/workspace/3');
  assert.equal(patcher.patch(source(3)), null);
});
