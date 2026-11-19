import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problemReasonSchema } from '../packages/core/dist/reasons.js';

test('business reasons preserve null and selection recovery at the public boundary', () => {
  assert.deepEqual(problemReasonSchema.parse({ kind: 'invalid_selection', name: 'model', value: null }),
    { kind: 'invalid_selection', name: 'model', value: null });
  const problems = [{ key: 'model', previous: null, candidates: ['current'], reason: 'null_required', recovery: 'select_value' }];
  const reason = problemReasonSchema.parse({ kind: 'selection_required', problems });
  assert.equal(reason.kind, 'selection_required');
  if (reason.kind !== 'selection_required') throw new Error('Unexpected reason');
  assert.deepEqual(reason.problems, problems);
  assert.equal(problemReasonSchema.safeParse({ kind: 'agent_unavailable' }).success, true);
  assert.equal(problemReasonSchema.safeParse({ kind: 'new_conversation_required', previous: 'claude', current: 'codex' }).success, true);
});
