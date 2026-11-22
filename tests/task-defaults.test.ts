/** What an owner or member starts on: the request's values, then the placement's, then the agent's task defaults, then the first value. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileAgentSetting } from '@alpacawork/contract/agent-settings';
import { resolveAgentSelection } from '@alpacawork/contract/agent-selection';

const claude = (defaults?: Record<string, string>) => compileAgentSetting('claude',
  { params: { model: ['opus', 'fable'], effort: ['medium', 'high', 'low'] }, ...defaults ? { defaults } : {} });

test('a task starts on the request, then the placement, then the task default, then the first value', () => {
  const compiled = claude({ model: 'fable', effort: 'high' });
  assert.deepEqual(resolveAgentSelection(compiled).values, { model: 'fable', effort: 'high' });
  assert.deepEqual(resolveAgentSelection(compiled, {}, { effort: 'low' }).values, { model: 'fable', effort: 'low' });
  assert.deepEqual(resolveAgentSelection(compiled, { model: 'opus' }, { effort: 'low' }).values, { model: 'opus', effort: 'low' });
  assert.deepEqual(resolveAgentSelection(claude()).values, { model: 'opus', effort: 'medium' });
});

test('a task default no longer among the values gives way to the first one', () => {
  assert.deepEqual(resolveAgentSelection(claude({ model: 'sonnet', effort: 'high' })).values, { model: 'opus', effort: 'high' });
});
