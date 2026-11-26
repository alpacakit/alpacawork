import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentsText, adapterCatalog } from '../packages/contract/dist/server-settings.js';
import { compileAgentSetting, defaultAgentSetting } from '../packages/contract/dist/agent-settings.js';
import { prepareAgentLaunch, prepareCoordinatorLaunch } from '../packages/contract/dist/agent-launch.js';
import { invocationSchema, PROTOCOL } from '../packages/contract/dist/run-protocol.js';
import { runRecordSchema, coordinatorRunRecordSchema } from '../packages/contract/dist/run-contract.js';
import { requestInputSchema } from '../packages/contract/dist/control-contract.js';

test('new YAML is strict and preserves ordering and disabled settings', () => {
  const result = checkAgentsText('agents:\n  codex:\n    enabled: false\n    params:\n      model: [gpt-6.1-sol]\n      effort: [high]\n      fast: ["-", fast]\n');
  assert.ok(result.agents);
  assert.deepEqual(Object.keys(result.agents), ['codex']);
  assert.equal(result.agents.codex!.enabled, false);
  assert.equal(checkAgentsText('agents:\n  codex:\n    start: [codex]\n').agents, null);
  assert.ok(adapterCatalog().find(a => a.id === 'codex')?.optionsBase.match(/^[0-9a-f]{64}$/));
});

test('Run, protocol and request share nullable selections and launch shape', () => {
  const compiled = compileAgentSetting('codex', defaultAgentSetting('codex'));
  const launch = prepareAgentLaunch(compiled, { mode: 'start', path: '/tmp', explicit: { fast: null } }).launch;
  const base = { id: 'R1', task: 'T1', placementId: 'p', requestId: 'q', agent: 'codex', role: 'worker', resumes: null,
    continues: false, session: null, caller: null, cwd: '/tmp', launch, state: 'queued', reason: null, into: null,
    stop_requested: false, exit: null, usage: null, created_at: '2026-11-05T00:00:00Z', started_at: null, ended_at: null,
    pids: { manager: null, agent: null } };
  assert.equal(PROTOCOL, 1);
  assert.equal(runRecordSchema.safeParse(base).success, true);
  assert.equal(invocationSchema.safeParse({ launch, mode: 'start', session: null }).success, true);
  assert.equal(runRecordSchema.safeParse({ ...base, launch: { ...launch, read: null } }).success, false);
  assert.equal(requestInputSchema.shape.selected.safeParse({ fast: null }).success, true);
  const coord = prepareCoordinatorLaunch(compiled, { mode: 'resume', path: '/tmp', previous: { adapter: 'codex', values: launch.values } });
  const coordinator = { ...base, task: null, placementId: null, caller: null, role: 'coordinator',
    conversationId: '11111111-1111-4111-8111-111111111111', message: { context: null, attachments: [], intent: null },
    launch: coord.launch };
  assert.equal(coordinatorRunRecordSchema.safeParse(coordinator).success, true);
  assert.equal(invocationSchema.safeParse({ launch: coord.launch, mode: 'resume', session: null }).success, true);
});
