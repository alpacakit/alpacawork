import type { AgentSetting } from '@alpacawork/contract';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { initialPlacementValues } from '../apps/backend/test-dist/control/placement-launch-values.js';
import { optionsBase, AGENT_ADAPTERS } from '../packages/contract/dist/agent-adapters.js';
import { AGENTS_TEMPLATE, parseAgentsSettings as parseSettings, launchSnapshot, coordinatorLaunchSnapshot, assignedSession, agentFields } from '../apps/backend/test-dist/agents-settings.js';
import { resolveLaunchArgv } from '../packages/contract/dist/launch-options.js';

function parseAgentsSettings(text: string) {
  const config = parseSettings(text);
  for (const setting of (Object.values(config.agents) as AgentSetting[])) setting.command = '/usr/bin/false';
  return config;
}

test('config selection is captured for admission and later settings cannot change it', () => {
  const config = parseAgentsSettings(AGENTS_TEMPLATE);
  assert.deepEqual(Object.keys(config.agents), ['claude', 'codex']);
  config.agents.codex!.params.model!.unshift('synthetic-new-model');
  const text = stringify({ agents: config.agents });
  const saved = parseAgentsSettings(text);
  const choices = agentFields('codex', saved.agents.codex!);
  assert.equal(choices.find(choice => choice.key === 'model')!.initial, 'synthetic-new-model');
  const result = launchSnapshot(saved, 'codex', 'start', '/bin', { fast: null });
  assert.ok(result.ok);
  const launch = result.launch;
  assert.ok(resolveLaunchArgv(launch.argv, launch.values, { result: '/tmp/result' }).includes('synthetic-new-model'));
  saved.agents.codex!.params.model!.shift();
  assert.equal(launch.values.model, 'synthetic-new-model');
  assert.throws(() => launchSnapshot(saved, 'codex', 'resume', '/bin', {}, launch), (error: any) => error.reason?.kind === 'selection_required');
  assert.throws(() => launchSnapshot(saved, 'claude', 'resume', '/bin', {}, launch), (error: any) => error.reason?.kind === 'new_conversation_required');
  saved.agents.codex!.enabled = false;
  assert.throws(() => launchSnapshot(saved, 'codex', 'start', '/bin'), (error: any) => error.reason?.kind === 'agent_unavailable');
  assert.equal(assignedSession(launch, 'codex'), null);
  const claude = coordinatorLaunchSnapshot(saved, 'claude', 'start', '/bin');
  assert.ok(claude.ok);
  assert.equal(claude.restartArgv, null);
  assert.ok(assignedSession(claude.launch, 'claude'));
  assert.equal(parseAgentsSettings(stringify({ agents: { codex: saved.agents.codex } })).agents.codex!.enabled, false);
});


test('a new conversation recovers when a placement initial value was removed', () => {
  const config = parseAgentsSettings(AGENTS_TEMPLATE);
  const original = config.agents.codex!;
  original.params.extra = ['old-extra'];
  original.options = { base: optionsBase('codex'),
    start: `${AGENT_ADAPTERS.codex.options.start} [--extra {extra}]`,
    resume: `${AGENT_ADAPTERS.codex.options.resume} [--extra {extra}]` };
  const log = [{ kind: 'placement_changed', placementId: 'p1', placementRevision: 1,
    placementEffect: 'member', launchValues: { extra: 'old-extra' } }] as any;
  const initial = initialPlacementValues(log, 'p1', []);
  const first = launchSnapshot(config, 'codex', 'start', '/bin', {}, { values: initial! });
  assert.ok(first.ok);
  assert.equal(first.launch.values.extra, 'old-extra');
  delete original.params.extra;
  original.options = { base: optionsBase('codex'), ...AGENT_ADAPTERS.codex.options };
  const unstarted = initialPlacementValues(log, 'p1', []);
  assert.throws(() => launchSnapshot(config, 'codex', 'start', '/bin', {}, { values: unstarted! }),
    (error: any) => error.reason?.kind === 'selection_required' && error.reason.problems[0]?.recovery === 'new_conversation');
  const reset = initialPlacementValues(log, 'p1', [], 'new');
  assert.equal(reset, undefined);
  const recovered = launchSnapshot(config, 'codex', 'start', '/bin', { model: 'gpt-6.2-astra' }, reset === undefined ? undefined : { values: reset });
  assert.ok(recovered.ok);
  assert.equal(recovered.launch.values.model, 'gpt-6.2-astra');
  assert.equal(Object.hasOwn(recovered.launch.values, 'extra'), false);
  assert.deepEqual(initialPlacementValues(log, 'p1', []), { extra: 'old-extra' });
  assert.throws(() => launchSnapshot(config, 'codex', 'resume', '/bin', {}, first.launch),
    (error: any) => error.reason?.kind === 'selection_required' && error.reason.problems[0]?.recovery === 'new_conversation');
  const newInitial = initialPlacementValues(log, 'p1', [{ placementId: 'p1' }]);
  assert.equal(newInitial, undefined);
  const fresh = launchSnapshot(config, 'codex', 'start', '/bin', {}, newInitial === undefined ? undefined : { values: newInitial });
  assert.ok(fresh.ok);
  assert.equal(Object.hasOwn(fresh.launch.values, 'extra'), false);
});
