import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placementSchema, controlRunSchema } from '../packages/contract/dist/control-contract.js';

test('placement continuation values preserve null and distinguish no Run from unreadable', () => {
  const schema = placementSchema.shape.previousValues;
  assert.equal(schema.parse(null), null);
  assert.equal(schema.parse(undefined), undefined);
  assert.deepEqual(schema.parse({ model: 'old', fast: null }), { model: 'old', fast: null });
  assert.deepEqual(controlRunSchema.shape.launchValues.parse({ fast: null }), { fast: null });
});
