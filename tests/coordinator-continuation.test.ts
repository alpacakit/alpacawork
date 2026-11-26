import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import assert from 'node:assert/strict';
import type { AiRow } from '@alpacawork/contract';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { optionsBase } from '@alpacawork/contract/agent-adapters';
import { resolveAgentLaunchArgv } from '@alpacawork/contract/agent-launch';
import { stringify } from 'yaml';
import { coordinatorLaunchSnapshot, parseAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { automaticCoordinatorReset, coordinatorLaunchFor, coordinatorTurnNumber } from '@alpacawork/backend/test-dist/coordinator/continuation.js';

import { reserveCoordinatorReset, startCoordinatorReset } from '@alpacawork/backend/test-dist/coordinator/resets.js';

type Observation = Pick<CoordinatorRunRecord, 'state' | 'started_at' | 'ended_at' | 'availability' | 'session'>
  & { row: AiRow };
const iso = (at: number) => new Date(at).toISOString();

function historyFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'coordinator-continuation-'));
  initializeControlFixture(root);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const baseline = parseAgentsSettings(stringify({ agents: { sample: { adapter: 'claude', command: process.execPath } } }));
  const template = coordinatorLaunchSnapshot(baseline, 'sample', 'start', '/bin');
  assert.ok(template.ok);
  const db = store.connection;
  return { db, history(observations: readonly Observation[]) {
    const id = randomUUID();
    const runs = store.write(tx => {
      const at = iso(0);
      db.prepare('INSERT INTO coordinator_conversations(id,started_at,cleared_at) VALUES (?,?,?)').run(id, at, at);
      return observations.map(observation => {
        const requestId = randomUUID();
        tx.insertConversationRequest({ id: requestId, conversationId: id, headRunId: null, mode: 'new',
          body: 'Synthetic message', deliveryState: 'queued', submittedAt: observation.started_at ?? at });
        const run = tx.createCoordinatorRun({ conversationId: id, requestId, agent: observation.row.agent, resumes: null,
          session: observation.session, cwd: root, launch: { ...template.launch, values: observation.row.values },
          message: { context: null, intent: null, attachments: [] } }, 'Synthetic message');
        if (observation.state === 'queued') return run;
        tx.update({ ...run, state: 'running', started_at: observation.started_at });
        if (observation.state === 'succeeded' || observation.state === 'failed') tx.finish({ ...run, ...observationFields(observation) },
          observation.state === 'succeeded' ? { state: 'present', text: 'Synthetic reply' } : { state: 'missing', text: null });
        return tx.runtimeGet(run.id)!;
      });
    });
    return { id, runs };
  }, write: store.write.bind(store) };
}

function observationFields({ state, started_at, ended_at, availability }: Observation) {
  return { state, started_at, ended_at, ...(availability ? { availability } : {}), reason: state === 'failed' ? 'exit' as const : null };
}

test('the next coordinator turn follows the saved order and the latest observed limits', t => {
  const fixture = historyFixture(t);
  const row = (agent: string, model: string): AiRow => ({ agent, values: { model, effort: null } });
  const first = row('first', 'one'), second = row('second', 'two'), revised = row('second', 'one'), last = row('last', 'one');
  const task = row('task', 'two'), unavailable = row('unavailable', 'one');
  const setting = { adapter: 'claude', command: process.execPath, params: { model: ['one', 'two'], effort: [] } };
  const agents = { first: setting, second: setting, last: setting, task: setting,
    unavailable: { ...setting, command: '/nonexistent-alpacawork-fixture-command' } };
  const run = (id: number, row: AiRow, cause?: 'session_limit' | 'model_capacity'): Observation => ({
    row, state: cause ? 'failed' : 'succeeded', started_at: iso(id * 1000), ended_at: iso(id * 1000 + 1),
    session: { provider: row.agent, id: 'thread' }, ...(cause ? { availability: { cause } } : {}),
  });
  const limited = run(1, first, 'session_limit'), resumed = run(2, second);
  const failed = { ...run(2, first), state: 'failed' } as const;
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
    { name: 'leaving the limited primary for a spare', rows: [first, second, last], runs: [limited],
      selected: second, continued: null, following: [last], reset: 'fallback' },
    { name: 'returning from a spare when the primary limit clears', rows: [first, second, last], runs: [limited, resumed],
      selected: first, continued: null, following: [second, last], reset: 'recovered', now: 3_602_000 },
    { name: 'the same AI cannot resume after ordinary failure', rows: [first, second], runs: [failed],
      selected: first, continued: null, following: [second], reset: 'unresumable' },
    { name: 'current fallback', rows: [first, second, last], runs: [limited, resumed], selected: second, continued: resumed, following: [last] },
    { name: 'new row above the exhausted one', rows: [last, first, second], runs: [limited, resumed], selected: last, continued: null, following: [second], reset: 'recovered' },
    { name: 'moving an untried row first', rows: [last, second], runs: [resumed], selected: last, continued: null, following: [second], reset: 'recovered' },
    { name: 'new values for the same agent', rows: [revised, last], runs: [resumed], selected: revised, continued: null, following: [last], modelArg: 'one', reset: 'another_ai' },
    { name: 'a changed model that resume cannot pass starts a new session', profiles: startModelOnly, rows: [noEffort, last],
      runs: [run(3, oldModel)], selected: noEffort, continued: null, following: [last], modelArg: 'two', reset: 'another_ai' },
    { name: 'resume can keep the same model without an option for it', profiles: startModelOnly, rows: [noEffort, last],
      runs: [run(2, noEffort)], selected: noEffort, continued: run(2, noEffort), following: [last] },
    { name: 'a duplicate exhausted row with a different suppressed value', profiles: suppressedEffort,
      rows: [low, second, high], runs: [run(1, low, 'session_limit'), resumed], selected: second, continued: resumed, following: [] },
    { name: 'reordering equivalent rows does not retry an exhausted launch', profiles: suppressedEffort,
      rows: [high, second, low], runs: [run(1, low, 'session_limit'), resumed], selected: second, continued: resumed, following: [] },
    { name: 'all rows exhausted', rows: [first, second], runs: [limited, run(4, second, 'model_capacity')], selected: first, continued: null, following: [second], reset: 'recovered' },
    { name: 'a success with equivalent effective values clears a limit behind the current head',
      profiles: suppressedEffort, rows: [low, second], runs: [run(1, low, 'session_limit'), run(2, high), run(3, second)],
      selected: low, continued: null, following: [second], reset: 'recovered' },
    { name: 'an unrelated success leaves the limit in force',
      rows: [first, second, last], runs: [limited, run(2, { ...first, values: { model: 'two', effort: null } }), resumed],
      selected: second, continued: resumed, following: [last] },
    { name: 'queued work does not replace the running or answered predecessor', rows: [second, last],
      runs: [resumed, { ...run(3, last), state: 'queued' as const, started_at: null, ended_at: null }],
      selected: second, continued: resumed, following: [last] },
    { name: 'a more recent success clears a recorded limit', rows: [first, second], runs: [limited, run(5, first)], selected: first, continued: run(5, first), following: [second] },
    { name: 'an exhausted row and an unavailable current agent are skipped', rows: [first, unavailable, last],
      runs: [limited, run(2, unavailable)], selected: last, continued: null, following: [], reset: 'another_ai' },
    { name: 'the primary cannot launch', rows: [unavailable, second], runs: [run(1, unavailable)],
      selected: second, continued: null, following: [], reset: 'fallback' },
    { name: 'replacing an AI that is no longer in the stack', rows: [first, last], runs: [resumed],
      selected: first, continued: null, following: [last], reset: 'another_ai' },
    { name: 'removed effort starts a new session on the same agent', profiles: withoutEffort, rows: [noEffort, last],
      runs: [priorEffort], selected: noEffort, continued: null, following: [last], reset: 'unresumable' },
    { name: 'empty stack', rows: [], runs: [resumed], selected: null, continued: null, following: [] },
  ];
  for (const { name, profiles, rows, runs, selected, continued, following, modelArg, reset, now = 60_000 } of cases) {
    const settings = parseAgentsSettings(stringify({ agents: profiles ?? agents, aiStack: [task], coordinatorAiStack: rows }, { aliasDuplicateObjects: false }));
    const history = fixture.history(runs);
    const next = coordinatorLaunchFor(fixture.db, settings, history.id, null, '/bin', now);
    assert.deepEqual(next.row, selected, name);
    if (next.row === null) {
      assert.equal(next.error.reason?.kind, 'no_configured_agents', name);
      continue;
    }
    assert.equal(next.continued?.id ?? null, continued ? history.runs[runs.findIndex(run => run.started_at === continued.started_at && run.row === continued.row)]?.id : null, name);
    assert.equal(next.kind === 'start' ? next.reset?.kind : undefined, reset, name);
    assert.deepEqual(next.launch.values, selected?.values, name);
    assert.deepEqual(next.following, following, name);
    if (modelArg) {
      const argv = resolveAgentLaunchArgv(next.launch, { session: 'fixture-session' });
      assert.equal(argv[argv.indexOf('--model') + 1], modelArg, name);
    }
  }
});

test('an unsaved coordinator stack uses one row with the default agent starting values', t => {
  const fixture = historyFixture(t), history = fixture.history([]);
  const claude = { command: process.execPath };
  const codex = { command: process.execPath };
  const agents = { skipped: { adapter: 'claude', enabled: false }, claude, codex };
  const aiStack = [{ agent: 'codex', values: { model: 'gpt-6.2-astra', effort: 'medium', fast: 'fast' } }];
  const codexStart = { agent: 'codex', values: { model: 'gpt-6.2-sol', effort: 'low', fast: null } };
  const claudeStart = { agent: 'claude', values: { model: 'opus', effort: 'low' } };
  const claudeMedium = { agent: 'claude', values: { model: 'opus', effort: 'medium' } };
  const cases = [
    { name: 'uses the agent from the task stack with its own starting values', config: { agents, aiStack }, selected: codexStart },
    { name: 'uses the first enabled agent without a task stack', config: { agents }, selected: claudeStart },
    { name: 'uses the first enabled agent with an empty task stack', config: { agents, aiStack: [] }, selected: claudeStart },
    { name: 'keeps the starting effort when low is not offered',
      config: { agents: { claude: { ...claude, params: { effort: ['medium', 'high'] } } } }, selected: claudeMedium },
    { name: 'keeps the latent starting value when the first model does not use effort',
      config: { agents: { claude: { ...claude, without: { opus: ['effort'] } } } }, selected: claudeMedium },
    { name: 'no enabled agents', config: { agents: { skipped: agents.skipped } }, selected: null },
  ];
  for (const { name, config, selected } of cases) {
    const settings = parseAgentsSettings(stringify(config));
    const next = coordinatorLaunchFor(fixture.db, settings, history.id, null, '/bin');
    assert.deepEqual(next.row, selected, name);
    if (next.row === null) {
      assert.equal(next.error.reason?.kind, 'no_configured_agents', name);
    } else {
      assert.deepEqual(next.launch.values, selected?.values, name);
      assert.deepEqual(next.following, [], name);
    }
  }
});

test('the automatic reset uses a known fill', () => {
  const limits = { coordinator_reset_tokens: 200_000, coordinator_reset_percent: 50 };
  const at = '2026-11-01T00:00:00Z';
  const context = (usedTokens: number | null, windowTokens: number | null) =>
    ({ observedAt: at, usedTokens, windowTokens, windowFrom: null, compacted: false });
  assert.equal(automaticCoordinatorReset(context(null, 100), limits), null);
  assert.equal(automaticCoordinatorReset(context(49, 100), limits), null);
  assert.deepEqual(automaticCoordinatorReset(context(50, 100), limits), { kind: 'context', over: { percent: 50 } });
  assert.equal(automaticCoordinatorReset(context(199_999, null), limits), null);
  assert.deepEqual(automaticCoordinatorReset(context(200_000, null), limits), { kind: 'context', over: { tokens: 200_000 } });

});

test('the DB decision keeps a plan limit only until the reported reset or the default cooldown', t => {
  const fixture = historyFixture(t);
  const primary = { agent: 'first', values: {} }, spare = { agent: 'second', values: {} };
  const setting = { adapter: 'claude', command: process.execPath, params: {} };
  const config = parseAgentsSettings(stringify({ agents: { first: setting, second: setting }, coordinatorAiStack: [primary, spare] },
    { aliasDuplicateObjects: false }));
  const at = '2026-11-01T00:00:00Z', reset = '2026-11-01T00:10:00Z';
  const failed = { row: config.coordinatorAiStack![0]!, state: 'failed', started_at: at, ended_at: at, session: null } as const;
  for (const [history, until] of [
    [fixture.history([{ ...failed, availability: { cause: 'session_limit', resetsAt: reset } }]), Date.parse(reset)],
    [fixture.history([{ ...failed, availability: { cause: 'session_limit' } }]), Date.parse(at) + 3_600_000],
  ] as const) {
    assert.equal(coordinatorLaunchFor(fixture.db, config, history.id, null, '/bin', until - 1).row?.agent, 'second');
    assert.equal(coordinatorLaunchFor(fixture.db, config, history.id, null, '/bin', until).row?.agent, 'first');
  }
});

test('a pending reset prevents resuming and its first turn defines the next segment', t => {
  const fixture = historyFixture(t);
  const settings = parseAgentsSettings(stringify({ agents: { sample: { adapter: 'claude', command: process.execPath, params: {} } },
    coordinatorAiStack: [{ agent: 'sample', values: {} }] }));
  const row = settings.coordinatorAiStack![0]!;
  const history = fixture.history([
    { row, state: 'succeeded', started_at: iso(1000), ended_at: iso(1500), session: { provider: 'sample', id: 'earlier' } },
    { row, state: 'queued', started_at: null, ended_at: null, session: { provider: 'sample', id: 'later' } },
  ]);
  const [previous, first] = history.runs;
  assert.ok(previous?.role === 'coordinator' && first?.role === 'coordinator');
  const turn = coordinatorTurnNumber(fixture.db, first.requestId);
  const decide = (before: number | null) => coordinatorLaunchFor(fixture.db, settings, history.id, before, '/bin');
  assert.equal(decide(turn).continued?.id, previous.id);
  const pending = fixture.write(() => reserveCoordinatorReset(fixture.db, history.id, { kind: 'asked' }, iso(2000)));
  const resetting = decide(turn);
  assert.equal(resetting.kind, 'start');
  assert.equal(resetting.reset?.kind, 'asked');
  fixture.write(tx => {
    startCoordinatorReset(fixture.db, pending, first);
    tx.update({ ...first, state: 'running', started_at: iso(2000) });
  });
  assert.equal(decide(turn).continued, null);
  assert.equal(decide(null).continued?.id, first.id);
});
