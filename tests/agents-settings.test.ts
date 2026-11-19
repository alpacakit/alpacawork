import type { AgentSetting } from '@alpacawork/contract';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { CONFIG_FILE } from '@alpacawork/raw';
import { AGENTS_TEMPLATE, launchSnapshot, parseAgentsSettings as parseSettings, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { DEFAULT_LIMITS } from '@alpacawork/contract';
import { agentEnvironment } from '@alpacawork/backend/test-dist/runs/env.js';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';

function parseAgentsSettings(text: string) {
  const config = parseSettings(text);
  for (const setting of (Object.values(config.agents) as AgentSetting[])) setting.command = '/usr/bin/false';
  return config;
}

test('config.yaml template provides built-in profiles and all default limits', () => {
  const config = parseAgentsSettings(AGENTS_TEMPLATE);
  assert.deepEqual(config.limits, DEFAULT_LIMITS);
  assert.deepEqual(Object.keys(config.agents), ['claude', 'codex']);
  assert.deepEqual(parseAgentsSettings('agents: {}').limits, DEFAULT_LIMITS);
  assert.equal(parseAgentsSettings('agents: {}').limits.parallel, 8);
  assert.equal(parseAgentsSettings('limits: {run_minutes: 0}\nagents: {}').limits.parallel, 8);
  assert.equal(parseAgentsSettings('limits: {run_minutes: 0.02}\nagents: {}').limits.run_minutes, 0.02);
  assert.equal(parseAgentsSettings('agents: {}').limits.coordinator_run_minutes, 30);
  assert.equal(parseAgentsSettings('limits: {coordinator_run_minutes: 45, coordinator_command_seconds: 10}\nagents: {}').limits.coordinator_run_minutes, 45);
  assert.throws(() => parseAgentsSettings('limits: {coordinator_turn_minutes: 45}\nagents: {}'), /Invalid config.yaml:[\s\S]*coordinator_turn_minutes/);
});

const rejects: [string, string][] = [
  ['unknown top-level key', 'other: true\nagents: {}'],
  ['unknown limits key', 'limits: {other: 1}\nagents: {}'],
  ['unknown agent key', 'agents: {codex: {params: {}, other: true}}'],
  ['duplicate key', 'agents: {}\nagents: {}'],
  ['duplicate nested key', 'agents: {fake: {start: [node], start: [node]}}'],
  ['bad agent name', 'agents: {Bad: {start: [node]}}'],
  ['missing agents', 'limits: {}'],
  ['YAML warning', 'agents: !unknown {}'],
  ['YAML syntax', 'agents: ['],
];
for (const [name, yaml] of rejects) test(`config.yaml rejects ${name}`, () => {
  assert.throws(() => parseAgentsSettings(yaml), error => {
    assert.equal((error as { code: string }).code, 'invalid_settings');
    assert.match((error as Error).message, /Invalid config.yaml: .+/); return true;
  });
});
for (const [key, values] of Object.entries({ parallel: [0, 1.5], depth: [0, 1.5], children_per_run: [0, 1.5], automatic_per_placement: [-1, 1.5], run_minutes: [-1, Infinity, NaN], attachment_mib: [0, 1.5, 501], coordinator_run_minutes: [0, 1.5], coordinator_command_seconds: [0, -1, 1.5] }))
  for (const value of values) test(`config.yaml rejects limits.${key}=${value}`, () => {
    assert.throws(() => parseAgentsSettings(stringify({ limits: { [key]: value }, agents: {} })), { code: 'invalid_settings' });
  });

test('config.yaml reads through FileWriter: missing, oversized, and invalid UTF-8 are errors', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-agents-'))), file = join(root, CONFIG_FILE);
  try {
    const check = () => { const result = readAgentsSettings(root); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, 'invalid_settings'); };
    check();
    writeFileSync(file, ' '.repeat(1024 * 1024 + 1)); check();
    writeFileSync(file, Buffer.from([0xff])); check();
    writeFileSync(file, AGENTS_TEMPLATE); assert.equal(readAgentsSettings(root).ok, true);
    writeFileSync(file, 'agents: {}');
    const settings = readAgentsSettings(root); assert.equal(settings.ok, true);
    if (settings.ok) assert.equal(settings.config.limits.parallel, 8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('launch snapshot checks lookup and previous conversation, and detaches admission from settings', () => {
  const config = parseAgentsSettings(stringify({ agents: { fake: fixtureAgentSetting('codex') } }));
  assert.deepEqual(launchSnapshot(config, 'missing', 'start', '/bin'), { ok: false, code: 'not_found' });
  assert.deepEqual(launchSnapshot(config, 'constructor', 'start', '/bin'), { ok: false, code: 'not_found' });
  assert.deepEqual(launchSnapshot(config, 'fake', 'resume', '/bin'), { ok: false, code: 'not_resumable' });
  const result = launchSnapshot(config, 'fake', 'start', '/bin'); assert.ok(result.ok);
  const saved = structuredClone(result.launch);
  config.agents.fake.params.model[0] = 'synthetic-replacement';
  assert.deepEqual(result.launch, saved);
  assert.equal(result.launch.path, '/bin');
});

test('agents read config.yaml beside this PC\'s code locations, one per project Task (\'\' turns it off); extracts are no longer there', () => {
  const config = parseAgentsSettings(`projects:\n  P2: {cwd: /work/alp}\n  P3: {cwd: ''}\n${AGENTS_TEMPLATE}`);
  assert.deepEqual(config, parseAgentsSettings(AGENTS_TEMPLATE));
  assert.throws(() => parseAgentsSettings(`projects:\n  alp: {cwd: /work/alp}\n${AGENTS_TEMPLATE}`), /invalid_settings|Invalid config/);
  assert.throws(() => parseAgentsSettings(`projects:\n  P2: {cwd: work/alp}\n${AGENTS_TEMPLATE}`), /absolute/);
  assert.throws(() => parseAgentsSettings(`extracts: []\n${AGENTS_TEMPLATE}`), /extracts/);
});
test('environment selection keeps basic empty values and LC_ names and only explicitly admitted extra names', () => {
  const input = { HOME: '', LC_CUSTOM: '', OPENAI_API_KEY: 'synthetic', OTHER: 'private', PATH: 'old' };
  assert.deepEqual(agentEnvironment(input, 'new', undefined, ['OPENAI_API_KEY']),
    { HOME: '', LC_CUSTOM: '', OPENAI_API_KEY: 'synthetic', PATH: 'new' });
  assert.equal(input.PATH, 'old');
});

test('selected nullable values survive snapshotting and removed previous choices require reselection', () => {
  const setting = fixtureAgentSetting('codex');
  setting.params.model = ['synthetic-one', 'synthetic-two'];
  const config = parseAgentsSettings(stringify({ agents: { fake: setting } }));
  const chosen = launchSnapshot(config, 'fake', 'start', '/bin', { model: 'synthetic-two', fast: null }); assert.ok(chosen.ok);
  const before = structuredClone(chosen.launch);
  config.agents.fake.params.model = ['synthetic-one'];
  assert.throws(() => launchSnapshot(config, 'fake', 'resume', '/bin', {}, chosen.launch),
    error => (error as { reason?: { kind: string } }).reason?.kind === 'selection_required');
  const resumed = launchSnapshot(config, 'fake', 'resume', '/bin', { model: 'synthetic-one' }, chosen.launch); assert.ok(resumed.ok);
  assert.equal(resumed.launch.values.fast, null);
  assert.deepEqual(chosen.launch, before);
});

test('command seconds defaults and explicit values are parsed by the config owner', () => {
  assert.equal(parseAgentsSettings('agents: {}').limits.coordinator_command_seconds, 10);
  assert.equal(parseAgentsSettings('limits: {coordinator_command_seconds: 5}\nagents: {}').limits.coordinator_command_seconds, 5);
});
