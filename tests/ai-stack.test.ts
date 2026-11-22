import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { aiRows, freezeAiStack } from '@alpacawork/backend/test-dist/ai-stack.js';

const config = parseAgentsSettings(`
agents:
  claude:
    params:
      model: [opus, fable]
  codex: {}
aiStack:
  - agent: claude
    values: {model: opus}
  - agent: codex
    values: {}
`);

test('only explicitly named rows can add a model, duplicates are tried once, and stop cuts off configured rows', () => {
  const normal = aiRows(config);
  const named = aiRows(config, [{ agent: 'claude', values: { model: 'fable' } }, { agent: 'claude' }]);
  const stopped = aiRows(config, [{ agent: 'claude', values: { model: 'fable' } }, 'stop'], [{ agent: 'codex' }]);
  assert.deepEqual(normal.map(row => row.agent), ['claude', 'codex']);
  assert.equal(normal[0]!.values.model, 'opus');
  assert.equal(named[1]!.values.model, 'opus');
  assert.deepEqual(freezeAiStack(config, named[0]!, named)?.map(row => [
    row.agent, row.values.model === 'fable',
  ]), [['claude', true], ['claude', false], ['codex', false]]);
  assert.deepEqual(freezeAiStack(config, stopped[0]!, stopped)?.map(row => row.values.model), ['fable']);
});
