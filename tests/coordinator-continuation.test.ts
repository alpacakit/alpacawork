import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiRow } from '@alpacawork/contract';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { stringify } from 'yaml';
import { parseAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { freezeAiStack } from '@alpacawork/backend/test-dist/ai-stack.js';
import { coordinatorNextLaunch } from '@alpacawork/backend/test-dist/coordinator/continuation.js';

test('the next coordinator turn keeps its configured row or starts at the first usable one', () => {
  const row = (agent: string, model: string): AiRow => ({ agent, values: { model, effort: null } });
  const first = row('first', 'one'), second = row('second', 'two'), revised = row('second', 'one'), last = row('last', 'one');
  const task = row('task', 'two'), unavailable = row('unavailable', 'one');
  const setting = { adapter: 'claude', command: process.execPath, params: { model: ['one', 'two'], effort: [] } };
  const agents = { first: setting, second: setting, last: setting, task: setting,
    unavailable: { ...setting, command: '/nonexistent-alpacawork-fixture-command' } };
  const run = { id: 'R2', agent: second.agent, state: 'succeeded', session: { provider: second.agent, id: 'thread' },
    launch: { adapter: 'claude', values: second.values } } as CoordinatorRunRecord;
  const cases = [
    { name: 'new conversation', rows: [first, second, last], runs: [], selected: first, continued: null, following: [second, last] },
    { name: 'current fallback', rows: [first, second, last], runs: [run], selected: second, continued: run, following: [last] },
    { name: 'current fallback without a session', rows: [first, second, last], runs: [{ ...run, session: null }], selected: second, continued: null, following: [last] },
    { name: 'new values for the same agent', rows: [revised, last], runs: [run], selected: revised, continued: run, following: [last] },
    { name: 'different agent', rows: [first], runs: [run], selected: first, continued: null, following: [] },
    { name: 'first agent has no executable', rows: [unavailable, second, last], runs: [], selected: second, continued: null, following: [last] },
    { name: 'empty stack', rows: [], runs: [run], selected: null, continued: null, following: [] },
    { name: 'no stack', rows: undefined, runs: [], selected: null, continued: null, following: [] },
  ];
  for (const { name, rows, runs, selected, continued, following } of cases) {
    const settings = parseAgentsSettings(stringify({ agents, aiStack: [task], coordinatorAiStack: rows }, { aliasDuplicateObjects: false }));
    const next = coordinatorNextLaunch(settings, runs, '/bin');
    assert.deepEqual(next.row, selected, name);
    if (next.row === null) continue;
    assert.equal(next.continued, continued, name);
    assert.deepEqual(next.launch.values, selected?.values, name);
    assert.deepEqual(freezeAiStack(settings, next.row, next.following), following.length ? [selected, ...following] : undefined, name);
  }
});
