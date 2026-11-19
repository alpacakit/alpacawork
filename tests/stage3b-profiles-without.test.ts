import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentProfile } from '../apps/backend/test-dist/agents-settings.js';
import { controlTreeSchema } from '../packages/contract/dist/control-contract.js';
import { defaultAgentSetting } from '../packages/contract/dist/agent-settings.js';

test('profiles preserve model-specific omissions without sharing mutable configuration', () => {
  const setting = { ...defaultAgentSetting('grok'), without: { 'grok-4.7': ['effort'] } };
  const profile = controlTreeSchema.shape.profiles.element.parse(agentProfile('grok', setting));
  assert.deepEqual(profile.without, setting.without);
  assert.deepEqual(Object.keys(profile.without), Object.keys(setting.without!));
  const model = Object.keys(profile.without)[0]!;
  const plain = agentProfile('claude', defaultAgentSetting('claude'));
  assert.deepEqual(controlTreeSchema.shape.profiles.element.parse(plain).without, {});
  setting.without![model]!.push('model');
  assert.deepEqual(profile.without[model], ['effort']);
});
