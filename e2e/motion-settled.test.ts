import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excludedAmbientPulse, motionHasSettled } from './motion-settled.ts';
test('only source-identified ambient pulses are excluded', () => {
  const placeholder = { state: 'running', endTime: Infinity, name: 'motion-pulse', placeholder: true };
  assert.equal(excludedAmbientPulse(placeholder), true);
  assert.equal(motionHasSettled([placeholder], true), true);
  assert.equal(motionHasSettled([placeholder], false), false);
  const live = { state: 'running', endTime: Infinity, name: 'motion-pulse', liveMark: true };
  assert.equal(motionHasSettled([live], true), true);
  assert.equal(motionHasSettled([live], false), false);
  assert.equal(motionHasSettled([{ ...live, name: 'motion-spin' }], true), false);
  const step = { state: 'running', endTime: Infinity, name: 'motion-pulse', runningStep: true };
  assert.equal(motionHasSettled([step], true), true);
  assert.equal(motionHasSettled([step], false), false);
  assert.equal(motionHasSettled([{ ...step, name: 'motion-spin' }], true), false);
  for (const name of ['mark-weave-turn', 'mark-weave-dot']) {
    const mark = { state: 'running', endTime: Infinity, name, workMark: true };
    assert.equal(motionHasSettled([mark], true), true);
    assert.equal(motionHasSettled([mark], false), false);
    assert.equal(motionHasSettled([{ ...mark, workMark: false }], true), false);
  }
  const delivery = { state: 'running', endTime: Infinity, name: 'motion-pulse', deliveryStatus: true };
  assert.equal(motionHasSettled([delivery], true), true);
  assert.equal(motionHasSettled([delivery], false), false);
  assert.equal(motionHasSettled([{ ...delivery, name: 'motion-spin' }], true), false);
  assert.equal(motionHasSettled([delivery, { state: 'running', endTime: 200, name: 'motion-rise' }], true), false);
  for (const name of ['motion-spin', 'motion-pulse', 'progress-flow', null]) {
    assert.equal(motionHasSettled([{ state: 'running', endTime: Infinity, name: name ?? undefined, placeholder: false }], true), false);
  }
  for (const state of ['running', 'paused', 'unknown']) {
    assert.equal(motionHasSettled([placeholder, { state, endTime: 180 }], true), false);
    assert.equal(motionHasSettled([{ ...placeholder, state, endTime: null }], true), false);
  }
});
