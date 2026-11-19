import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinatorConversationSchema } from '../packages/contract/dist/coordinator-contract.js';
import { placementSchema, controlRunSchema } from '../packages/contract/dist/control-contract.js';

test('continued conversation values preserve null and distinguish no Run from unreadable', () => {
  for (const schema of [coordinatorConversationSchema.shape.previousValues, placementSchema.shape.previousValues]) {
    assert.equal(schema.parse(null), null);
    assert.equal(schema.parse(undefined), undefined);
    assert.deepEqual(schema.parse({ model: 'old', fast: null }), { model: 'old', fast: null });
  }
  assert.deepEqual(controlRunSchema.shape.launchValues.parse({ fast: null }), { fast: null });
});
