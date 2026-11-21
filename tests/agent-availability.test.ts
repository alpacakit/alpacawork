import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultAgentSetting, agentSettingSchemaFor, type AgentSetting, type AgentAvailability } from '@alpacawork/contract';
import { AGENT_ADAPTERS, optionsBase } from '@alpacawork/contract/agent-adapters';
import { inspectAgent, inspectAgents, commandPrefix } from '@alpacawork/backend/test-dist/agents/availability.js';
import { initialAgentsTemplate, parseAgentsSettings, launchSnapshot, coordinatorLaunchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';
import { inspectSetupAgents } from '@alpacawork/backend/test-dist/installation/setup-ai.js';
import { launchArgv } from '@alpacawork/backend/test-dist/runs/launch-agent.js';

import { syntheticStatusBridge } from './helpers/agent-inspection.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agent-availability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const script = (name: string, status: number) => {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\nif(process.argv[2]==='--version')console.log('synthetic 1');else if(process.argv.slice(2).join(' ')==='login status'||process.argv.slice(2).join(' ')==='auth status')process.exit(${status});else process.exit(99);\n`, { mode: 0o700 });
    return path;
  };
  return { root, bin, script, environment: { cwd: root, env: { PATH: bin, HOME: root }, bridge: syntheticStatusBridge(root) } };
}
test('creation lists only confirmed sign-in; signed-out and uncheckable executables are left to the setup screen', async t => {
  const f = fixture(t); f.script('claude', 0); f.script('codex', 1); f.script('grok', 0);
  const agents = await inspectSetupAgents(f.environment);
  assert.deepEqual(agents.map(a => [a.id, a.status]), [['claude', 'ready'], ['codex', 'signed_out'], ['grok', 'unknown']]);
  const settings = parseAgentsSettings(initialAgentsTemplate(agents));
  assert.deepEqual((Object.entries(settings.agents) as [string, AgentSetting][]).map(([name, agent]) => [name, agent.enabled !== false]), [['claude', true]]);
  f.script('codex', 42);
  assert.equal((await inspectAgent('codex', undefined, f.environment)).status, 'unknown');
});
test('admission fixes native and bridge paths including restart; a missing explicit target cannot fall back', async t => {
  const f = fixture(t), native = f.script('claude', 0), external = f.script('codex', 0);
  const settings = parseAgentsSettings(initialAgentsTemplate(await inspectSetupAgents(f.environment)));
  const first = launchSnapshot(settings, 'codex', 'start', f.bin); assert.ok(first.ok);
  assert.deepEqual(first.launch.argv.slice(0, 4), ['alpacawork-agent', 'codex', '--command', external]);
  const resume = coordinatorLaunchSnapshot(settings, 'codex', 'resume', f.bin, {}, first.launch); assert.ok(resume.ok);
  assert.deepEqual(resume.restartArgv?.slice(0, 4), first.launch.argv.slice(0, 4));
  assert.equal(launchSnapshot(settings, 'claude', 'start', f.bin).launch?.argv[0], native);
  const saved = structuredClone(first.launch);
  settings.agents.codex!.command = join(f.root, 'missing');
  assert.throws(() => launchSnapshot(settings, 'codex', 'start', f.bin), /not found.*missing/i);
  assert.deepEqual(first.launch, saved);
  const observed = await inspectAgent('codex', settings.agents.codex, f.environment);
  assert.equal(observed.status, 'not_found'); assert.equal(observed.candidates[0]?.path, external);
  const literal = join(f.root, '{model}');
  assert.equal(launchArgv({ launch: { ...saved, argv: [...commandPrefix('codex', literal), '-o', '{result}'] }, session: null }, f.root)[3], literal);
});
test('configuration rejects relative paths, arguments and bundled commands independently of editable options', () => {
  for (const [id, command] of [['codex', 'relative'], ['codex', '/bin/codex --help'], ['copilot', '/bin/copilot']] as const)
    assert.equal(agentSettingSchemaFor(id).safeParse({ ...defaultAgentSetting(id), command }).success, false);
  assert.equal(agentSettingSchemaFor('codex').safeParse({ ...defaultAgentSetting('codex'), command: '/path with spaces/codex' }).success, true);
  assert.equal(agentSettingSchemaFor('codex').safeParse({ ...defaultAgentSetting('codex'), options: { base: optionsBase('codex'),
    start: '[--command /tmp/codex] ' + AGENT_ADAPTERS.codex.options.start, resume: AGENT_ADAPTERS.codex.options.resume } }).success, false);
});
test('the real bridge entry starts the supplied executable and rejects a missing path even with a PATH candidate', async t => {
  const f = fixture(t), explicit = join(f.root, 'chosen');
  writeFileSync(explicit, `#!${process.execPath}\nconsole.error('chosen executable started');process.exit(1);\n`, { mode: 0o700 });
  f.script('codex', 0);
  const cli = join(import.meta.dirname, '../apps/agent-cli/dist/cli.js');
  const run = (command: string) => spawnSync(process.execPath, [cli, 'codex', '--command', command], { input: '', encoding: 'utf8', env: { ...f.environment.env, CODEX_HOME: join(f.root, 'dedicated-codex') }, timeout: 5000 });
  assert.match(run(explicit).stderr, /chosen executable started/);
  const missing = run(join(f.root, 'missing'));
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /not found.*missing/i);
  assert.equal(AGENT_ADAPTERS.copilot.command, null);
});

test('one deadline bounds all hung targets, shares probes across profiles and reaps every child', async t => {
  const f = fixture(t), log = join(f.root, 'checks.jsonl');
  const source = `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({pid:process.pid,argv:process.argv.slice(1)})+'\\n');setInterval(()=>{},1000);\n`;
  for (const name of ['claude', 'codex', 'grok', 'pi']) writeFileSync(join(f.bin, name), source, { mode: 0o700 });
  const bridge = join(f.root, 'hung-bridge.cjs'); writeFileSync(bridge, source);
  f.environment.bridge = [process.execPath, bridge];
  const started = performance.now();
  const result = await inspectAgents({ first: { ...defaultAgentSetting('claude'), adapter: 'claude' },
    second: { ...defaultAgentSetting('claude'), adapter: 'claude' }, codex: defaultAgentSetting('codex') }, f.environment, 500);
  assert.ok(performance.now() - started < 2000, 'the whole check must not accumulate per-command waits');
  for (const agent of [...Object.values(result.detected), ...Object.values(result.availability)] as AgentAvailability[]) assert.equal(agent.status, 'unknown');
  const rows = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const keys = rows.map(row => JSON.stringify(row.argv));
  assert.equal(new Set(keys).size, keys.length, 'a target/operation is probed only once across detected and saved profiles');
  assert.ok(rows.length > 1, 'multiple real synthetic processes reached the deadline');
  for (const row of rows) assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' });
});
