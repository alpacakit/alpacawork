import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiRow } from '@alpacawork/contract';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { optionsBase } from '@alpacawork/contract/agent-adapters';
import { resolveAgentLaunchArgv } from '@alpacawork/contract/agent-launch';
import { stringify } from 'yaml';
import { parseAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { coordinatorNextLaunch } from '@alpacawork/backend/test-dist/coordinator/continuation.js';

test('the next coordinator turn follows the saved order and the latest observed limits', () => {
  const row = (agent: string, model: string): AiRow => ({ agent, values: { model, effort: null } });
  const first = row('first', 'one'), second = row('second', 'two'), revised = row('second', 'one'), last = row('last', 'one');
  const task = row('task', 'two'), unavailable = row('unavailable', 'one');
  const setting = { adapter: 'claude', command: process.execPath, params: { model: ['one', 'two'], effort: [] } };
  const agents = { first: setting, second: setting, last: setting, task: setting,
    unavailable: { ...setting, command: '/nonexistent-alpacawork-fixture-command' } };
  const run = (id: number, row: AiRow, cause?: 'session_limit' | 'model_capacity') => ({
    id: `R${id}`, agent: row.agent, state: cause ? 'failed' : 'succeeded',
    started_at: new Date(id * 1000).toISOString(), session: { provider: row.agent, id: 'thread' },
    launch: { adapter: 'claude', values: row.values }, ...(cause ? { availability: { cause } } : {}),
  }) as CoordinatorRunRecord;
  const limited = run(1, first, 'session_limit'), resumed = run(2, second);
  const priorEffort = run(3, { agent: 'second', values: { model: 'two', effort: 'low' } });
  const withoutEffort = { ...agents, second: { ...setting, params: { model: ['one', 'two'] },
    options: { base: optionsBase('claude'), start: '--model {model} --session-id {session}', resume: '--model {model} --resume {session}' } } };
  const noEffort = { agent: second.agent, values: { model: 'two' } };
  const oldModel = { agent: second.agent, values: { model: 'one' } };
  const startModelOnly = { ...withoutEffort, second: { ...withoutEffort.second,
    options: { ...withoutEffort.second.options, resume: '--resume {session}' } } };
  const suppressedEffort = { ...agents, first: { ...setting, params: { ...setting.params, effort: ['low', 'high'] }, without: { one: ['effort'] } } };
  const low = { agent: first.agent, values: { model: 'one', effort: 'low' } };
  const high = { agent: first.agent, values: { model: 'one', effort: 'high' } };
  const cases = [
    { name: 'new conversation', rows: [first, second, last], runs: [], selected: first, continued: null, following: [second, last] },
    { name: 'current fallback', rows: [first, second, last], runs: [limited, resumed], selected: second, continued: resumed, following: [last] },
    { name: 'new row above the exhausted one', rows: [last, first, second], runs: [limited, resumed], selected: last, continued: null, following: [second] },
    { name: 'moving an untried row first', rows: [last, second], runs: [resumed], selected: last, continued: null, following: [second] },
    { name: 'new values for the same agent', rows: [revised, last], runs: [resumed], selected: revised, continued: resumed, following: [last], modelArg: 'one' },
    { name: 'a changed model that resume cannot pass starts a new session', profiles: startModelOnly, rows: [noEffort, last],
      runs: [run(3, oldModel)], selected: noEffort, continued: null, following: [last], modelArg: 'two' },
    { name: 'resume can keep the same model without an option for it', profiles: startModelOnly, rows: [noEffort, last],
      runs: [run(2, noEffort)], selected: noEffort, continued: run(2, noEffort), following: [last] },
    { name: 'a duplicate exhausted row with a different suppressed value', profiles: suppressedEffort,
      rows: [low, second, high], runs: [run(1, low, 'session_limit'), resumed], selected: second, continued: resumed, following: [] },
    { name: 'reordering equivalent rows does not retry an exhausted launch', profiles: suppressedEffort,
      rows: [high, second, low], runs: [run(1, low, 'session_limit'), resumed], selected: second, continued: resumed, following: [] },
    { name: 'all rows exhausted', rows: [first, second], runs: [limited, run(4, second, 'model_capacity')], selected: first, continued: null, following: [second] },
    { name: 'a more recent success clears a recorded limit', rows: [first, second], runs: [limited, run(5, first)], selected: first, continued: run(5, first), following: [second] },
    { name: 'an exhausted row and an unavailable current agent are skipped', rows: [first, unavailable, last],
      runs: [limited, run(2, unavailable)], selected: last, continued: null, following: [] },
    { name: 'removed effort starts a new session on the same agent', profiles: withoutEffort, rows: [noEffort, last],
      runs: [priorEffort], selected: noEffort, continued: null, following: [last] },
    { name: 'empty stack', rows: [], runs: [resumed], selected: null, continued: null, following: [] },
    { name: 'no stack', rows: undefined, runs: [], selected: null, continued: null, following: [] },
  ];
  for (const { name, profiles, rows, runs, selected, continued, following, modelArg } of cases) {
    const settings = parseAgentsSettings(stringify({ agents: profiles ?? agents, aiStack: [task], coordinatorAiStack: rows }, { aliasDuplicateObjects: false }));
    const next = coordinatorNextLaunch(settings, runs, '/bin');
    assert.deepEqual(next.row, selected, name);
    if (next.row === null) continue;
    assert.deepEqual(next.continued, continued, name);
    assert.deepEqual(next.launch.values, selected?.values, name);
    assert.deepEqual(next.following, following, name);
    if (modelArg) {
      const argv = resolveAgentLaunchArgv(next.launch, { session: 'fixture-session' });
      assert.equal(argv[argv.indexOf('--model') + 1], modelArg, name);
    }
  }
});
