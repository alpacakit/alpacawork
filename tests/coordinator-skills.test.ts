import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync, readFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coordinatorSkills } from '@alpacawork/backend/test-dist/coordinator/skills.js';
import { parseToml } from '@alpacawork/backend/test-dist/coordinator/skill-catalog/toml.js';
import { coordinatorCwd } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { compileAgentSetting, defaultAgentSetting } from '@alpacawork/contract/agent-settings';
import { resolveLaunchArgv } from '@alpacawork/contract/launch-options';
import { prepareCoordinatorLaunch } from '@alpacawork/contract/agent-launch';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'skill-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), workspace = join(root, 'repo', 'sub'), cwd = coordinatorCwd(workspace),
    config = join(root, 'claude'), codex = join(root, 'codex');
  const put = (path: string, body: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); return path; };
  for (const path of [home, cwd, config, codex, join(root, '.git'), join(root, 'repo', '.git')]) mkdirSync(path, { recursive: true });
  put(join(codex, 'skills/.system/.codex-system-skills.marker'), 'fixture-system');
  const skill = (folder: string, name: string, description = 'One line', extra = '') => put(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody.\n`);
  // The admitted adapter is explicit: these fixtures name it beside the profile, never from argv.
  const input = (profile = 'claude', argv = profile === 'claude' ? ['claude', '-p'] : ['alpacawork-agent', 'codex', '--json']) =>
    ({ profile, adapter: profile === 'codex' ? 'codex' as const : 'claude' as const, root: workspace, argv, session: null, env: { HOME: home, CLAUDE_CONFIG_DIR: config, CODEX_HOME: codex, PATH: process.env.PATH } });
  return { root, home, cwd, config, codex, put, skill, input };
}

test('Claude reads personal, parent project, symlinks, folded YAML and namespaced legacy commands; personal wins', async t => {
  const f = fixture(t);
  f.skill(join(f.config, 'skills/same'), 'same', 'Personal wins');
  f.skill(join(f.root, 'repo/.claude/skills/same'), 'same', 'Project loses');
  f.skill(join(f.root, 'repo/.claude/skills/parent'), 'parent', '>\n  Folded\n  description');
  const target = join(f.root, 'linked'); f.skill(target, 'linked'); symlinkSync(target, join(f.config, 'skills/link'));
  f.skill(join(f.config, 'skills/hidden'), 'hidden', 'Hidden', 'user-invocable: false\n');
  f.skill(join(f.config, 'skills/manual'), 'manual', 'Manual', 'disable-model-invocation: true\n');
  f.skill(join(f.config, 'skills/masked'), 'masked', 'Personal hidden', 'user-invocable: false\n');
  f.skill(join(f.root, 'repo/.claude/skills/masked'), 'masked', 'Project hidden by personal');
  f.skill(join(f.config, 'skills/nested/deep'), 'not-loaded');
  f.put(join(f.config, 'commands/group/old.md'), '---\ndescription: Old command\n---\nBody');
  f.put(join(f.config, 'commands/plain.md'), 'Do the task now.\n\nMore body.');
  const result = await coordinatorSkills(f.input());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.skills.map(s => s.name), ['group:old', 'linked', 'parent', 'plain', 'same']);
  assert.equal(result.skills.find(s => s.name === 'same')!.description, 'Personal wins');
  assert.equal(result.skills.find(s => s.name === 'parent')!.description, 'Folded description');
});

test('a skill is its name: edits, link retargeting and neighbours leave it, removal and settings say what is true; no successful TTL is reused', async t => {
  const f = fixture(t), folder = join(f.config, 'skills/one'); f.skill(folder, 'one');
  const before = await coordinatorSkills(f.input()); assert.equal(before.status, 'ready');
  assert.deepEqual(before.skills, [{ name: 'one', description: 'One line', invocation: '/' }]);
  f.skill(folder, 'one', 'Changed'); const changed = await coordinatorSkills(f.input());
  assert.deepEqual(changed.skills, [{ name: 'one', description: 'Changed', invocation: '/' }]);
  f.skill(join(f.config, 'skills/neighbour'), 'neighbour');
  assert.deepEqual((await coordinatorSkills(f.input())).skills.map(s => s.name), ['neighbour', 'one']);
  rmSync(join(f.config, 'skills/neighbour'), { recursive: true });
  f.put(join(f.config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'unknown@market': true } }));
  assert.deepEqual(await coordinatorSkills(f.input()), { status: 'unavailable', profile: 'claude', skills: [], reason: 'plugins' });
  f.put(join(f.config, 'settings.json'), '{}'); rmSync(folder, { recursive: true });
  const empty = await coordinatorSkills(f.input()); assert.equal(empty.status, 'ready'); assert.equal(empty.skills.length, 0);
  const a = join(f.root, 'a'), b = join(f.root, 'b'); f.skill(a, 'alias'); f.skill(b, 'alias', 'Other');
  symlinkSync(a, folder); assert.equal((await coordinatorSkills(f.input())).skills[0]!.description, 'One line'); rmSync(folder); symlinkSync(b, folder);
  assert.equal((await coordinatorSkills(f.input())).skills[0]!.description, 'Other');
});

test('a very long line in a neighbour\'s header costs next to nothing', async t => {
  const f = fixture(t); f.skill(join(f.config, 'skills/keep'), 'keep');
  f.put(join(f.config, 'skills/wide/SKILL.md'), `---\nname: wide\ndescription: a${' '.repeat(240 * 1024)}b\n---\nBody\n`);
  const started = performance.now(), result = await coordinatorSkills(f.input());
  assert.deepEqual(result.skills.map(s => s.name), ['keep', 'wide']);
  assert.ok(performance.now() - started < 5000, `${performance.now() - started} ms`);
});

test('an entry the CLI cannot read is absent on its own; one it can read in spite of its form keeps its name', async t => {
  const f = fixture(t);
  for (const base of [join(f.config, 'skills'), join(f.codex, 'skills')]) {
    f.skill(join(base, 'keep'), 'keep');
    mkdirSync(base, { recursive: true }); symlinkSync(join(f.root, 'missing'), join(base, 'dangling'));
    mkdirSync(join(base, 'dangling-definition')); symlinkSync(join(f.root, 'missing'), join(base, 'dangling-definition/SKILL.md'));
    symlinkSync(join(base, 'loop'), join(base, 'loop'));
    chmodSync(f.skill(join(base, 'unreadable'), 'unreadable'), 0);
    chmodSync(f.skill(join(base, 'closed'), 'closed'), 0o044);
    f.put(join(base, 'malformed/SKILL.md'), '---\nname: malformed\ndescription: [never closed\n---\n');
    f.put(join(base, 'oversized/SKILL.md'), `---\nname: oversized\ndescription: big\n---\n${'x'.repeat(256 * 1024)}`);
    f.put(join(base, 'plain/SKILL.md'), 'No frontmatter');
  }
  assert.deepEqual((await coordinatorSkills(f.input())).skills.map(s => [s.name, s.description]), [['keep', 'One line'], ['malformed', '[never closed'], ['oversized', 'big'], ['plain', 'No frontmatter']]);
  assert.deepEqual((await coordinatorSkills(f.input('codex'))).skills.map(s => [s.name, s.description]), [['keep', 'One line'], ['malformed', '[never closed'], ['oversized', 'big']]);
});

test('a malformed personal definition keeps its name against a project namesake; one the CLI cannot read gives it up', async t => {
  const f = fixture(t), project = join(f.root, 'repo/.claude/skills');
  f.put(join(f.config, 'skills/kept/SKILL.md'), '---\nname: kept\ndescription: [personal\n---\n'); f.skill(join(project, 'kept'), 'kept', 'Project');
  f.put(join(f.config, 'skills/hidden/SKILL.md'), '---\nname: hidden\ndescription: d\nuser-invocable: "false"\n---\n'); f.skill(join(project, 'hidden'), 'hidden', 'Project');
  chmodSync(f.skill(join(f.config, 'skills/closed'), 'closed', 'Personal'), 0o044); f.skill(join(project, 'closed'), 'closed', 'Project');
  mkdirSync(join(f.config, 'skills'), { recursive: true }); symlinkSync(join(f.root, 'missing'), join(f.config, 'skills/dangling')); f.skill(join(project, 'dangling'), 'dangling', 'Project');
  f.skill(join(f.config, 'skills/both'), 'both', 'A skill'); f.put(join(f.config, 'commands/both.md'), '---\ndescription: A command\n---\nBody');
  assert.deepEqual((await coordinatorSkills(f.input())).skills.map(s => [s.name, s.description]),
    [['both', 'A skill'], ['closed', 'Project'], ['dangling', 'Project'], ['kept', '[personal']]);
});

test('both CLIs’ plain single-line colon descriptions are read as strings, and a value only quoting can save is quoted', async t => {
  const f = fixture(t); const path = f.skill(join(f.config, 'skills/one'), 'one', 'Video craft: generate and revise');
  assert.equal((await coordinatorSkills(f.input())).skills[0]!.description, 'Video craft: generate and revise');
  for (const [text, description] of [['---\nname: one\ndescription: [broken\n---\n', '[broken'], ['---\nname: one\nname: one\ndescription: value\n---\n', 'value'], ['---\nname: one\ndescription: !!js/function function() {}\n---\n', 'function() {}'], ['No frontmatter', 'No frontmatter']] as const) {
    f.put(path, text); const result = await coordinatorSkills(f.input()); assert.equal(result.status, 'ready'); assert.deepEqual(result.skills.map(s => s.name), ['one']); assert.ok(result.skills[0]!.description.includes(description), result.skills[0]!.description);
  }
});

test('unsupported launch flags and active configuration layers never advertise a partial catalog', async t => {
  const f = fixture(t); f.skill(join(f.config, 'skills/one'), 'one');
  for (const flag of ['--disable-slash-commands', '--bare', '--safe-mode', '--settings', '--setting-sources', '--add-dir', '--plugin-dir', '--agent', '--unknown'])
    assert.equal((await coordinatorSkills(f.input('claude', ['claude', '-p', flag, '/tmp/value']))).status, 'unavailable', flag);
  for (const flag of ['-c', '--config', '--profile', '--enable', '--disable'])
    assert.equal((await coordinatorSkills(f.input('codex', ['alpacawork-agent', 'codex', flag, 'skills=false']))).status, 'unavailable', flag);
  const settings = join(f.root, 'repo/.claude/settings.local.json'); f.put(settings, JSON.stringify({ enabledPlugins: { active: true } }));
  assert.equal((await coordinatorSkills(f.input())).status, 'unavailable');
  f.put(settings, '{}'); f.put(join(f.config, 'managed-settings.json'), '{}');
  assert.equal((await coordinatorSkills(f.input()) as any).reason, 'managed');
});

test('agent launch flags control skill discovery; --settings is refused', async t => {
  const f = fixture(t); f.skill(join(f.config, 'skills/one'), 'one'); f.skill(join(f.codex, 'skills/one'), 'one');
  // Catalog discovery receives the effective argv of the admitted launch.
  const launch = (agent: 'claude' | 'codex') => {
    const compiled = compileAgentSetting(agent, defaultAgentSetting(agent));
    const start = prepareCoordinatorLaunch(compiled, { mode: 'start', path: '/synthetic' }).launch;
    const resume = prepareCoordinatorLaunch(compiled, { mode: 'resume', path: '/synthetic', previous: { adapter: agent, values: {} } }).launch;
    const argv = (launch: typeof start) => resolveLaunchArgv(launch.argv, launch.values, { session: 'synthetic-session', result: 'catalog-result' });
    return { start: argv(start), resume: argv(resume) };
  };
  const names = async (profile: string, argv: string[], session: string | null = null) => {
    const result = await coordinatorSkills({ ...f.input(profile, argv), session });
    assert.equal(result.status, 'ready', `${argv.join(' ')}: ${JSON.stringify(result)}`);
    return result.skills.map(skill => skill.name);
  };
  const plain = await names('claude', ['claude', '-p']);
  assert.deepEqual(await names('claude', launch('claude').start), plain);
  assert.deepEqual(await names('claude', launch('claude').resume), plain);
  assert.deepEqual(await names('claude', ['claude', '-p', '--permission-mode', 'dontAsk', '--disallowedTools', 'Write', 'Edit',
    '--tools', 'Skill', 'Read']), plain);
  const codex = await names('codex', ['alpacawork-agent', 'codex', '--json']);
  assert.deepEqual(await names('codex', launch('codex').start), codex);
  assert.deepEqual(await names('codex', launch('codex').resume, '01234567-0123-0123-0123-0123456789ab'), codex);
  for (const tools of [['Bash,Read,Grep,Glob'], ['Skill'], ['Bash', 'Grep']])
    assert.deepEqual(await coordinatorSkills(f.input('claude', ['claude', '-p', '--tools', ...tools])),
      { status: 'unavailable', profile: 'claude', skills: [], reason: 'launch' }, tools.join(' '));
  assert.equal((await coordinatorSkills(f.input('claude', [...launch('claude').start, '--settings', '/tmp/value']))).status,
    'unavailable');
});

test('a pinned Codex executable preserves its skill catalog while unknown options stay refused', async t => {
  const f = fixture(t); f.skill(join(f.codex, 'skills/one'), 'one');
  const argv = ['alpacawork-agent', 'codex', '--command', '/synthetic/codex', '--json'];
  const catalog = await coordinatorSkills(f.input('codex', argv));
  assert.equal(catalog.status, 'ready');
  assert.deepEqual(catalog.skills.map(skill => skill.name), ['one']);
  assert.deepEqual(await coordinatorSkills(f.input('codex', [...argv, '--unknown-option'])),
    { status: 'unavailable', profile: 'codex', skills: [], reason: 'launch' });
});

test('discovery runs from the coordinator\'s own folder below the workspace, so the workspace\'s project skills are found', async t => {
  const f = fixture(t);
  const workspace = f.input().root;
  f.skill(join(workspace, '.claude/skills/workspace'), 'workspace');
  const result = await coordinatorSkills(f.input());
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.skills.map(skill => skill.name), ['workspace']);
});

test('Codex uses declared homes, system definitions, personal and repository sources, canonical aliases and disablement', async t => {
  const f = fixture(t); const folder = join(f.codex, 'skills/home'); f.skill(folder, 'home');
  f.skill(join(f.codex, 'skills/.system/system'), 'system');
  const personal = join(f.home, '.agents/skills/personal'); f.skill(personal, 'personal');
  symlinkSync(personal, join(f.codex, 'skills/alias'));
  f.skill(join(f.root, 'repo/.agents/skills/project'), 'project');
  let result = await coordinatorSkills(f.input('codex')); assert.equal(result.status, 'ready');
  assert.deepEqual(result.skills.map(s => s.name), ['home', 'personal', 'project', 'system']);
  assert.ok(result.skills.every(s => s.invocation === '$'));
  f.put(join(f.codex, 'config.toml'), `[[skills.config]]\npath = ${JSON.stringify(join(f.codex, 'skills/alias/SKILL.md'))}\nenabled = false\n`);
  result = await coordinatorSkills(f.input('codex')); assert.equal(result.status, 'ready'); assert.equal(result.skills.some(s => s.name === 'personal'), false);
  assert.equal((await coordinatorSkills(f.input('codex', ['alpacawork-agent', 'codex', '-m', 'synthetic-model', '-c', 'model_reasoning_effort=high', '-c', 'service_tier=fast', '-s', 'danger-full-access', '--skip-git-repo-check', '--json', '-o', 'catalog-result']))).status, 'ready');
  f.put(join(f.codex, 'config.toml'), '[plugins."enabled@market"]\nenabled = true\n');
  assert.equal((await coordinatorSkills(f.input('codex')) as any).reason, 'plugins');
});

test('a Codex duplicate name alone is not offered; an uninitialized system catalog and invalid TOML refuse the complete result', async t => {
  const f = fixture(t); f.skill(join(f.codex, 'skills/one'), 'same'); f.skill(join(f.home, '.agents/skills/two'), 'same'); f.skill(join(f.codex, 'skills/alone'), 'alone');
  assert.deepEqual((await coordinatorSkills(f.input('codex'))).skills.map(s => s.name), ['alone']);
  rmSync(join(f.home, '.agents'), { recursive: true }); rmSync(join(f.codex, 'skills/.system'), { recursive: true });
  assert.equal((await coordinatorSkills(f.input('codex')) as any).reason, 'system');
  f.put(join(f.codex, 'skills/.system/.codex-system-skills.marker'), 'fixture');
  f.put(join(f.codex, 'config.toml'), 'skills = [broken'); assert.equal((await coordinatorSkills(f.input('codex'))).status, 'unavailable');
});

test('a cycle ends where it starts; a dangling location and too many entries end the read', async t => {
  const f = fixture(t); const root = join(f.config, 'commands'); mkdirSync(root); symlinkSync(root, join(root, 'cycle'));
  assert.deepEqual((await coordinatorSkills(f.input())).skills, []); rmSync(root, { recursive: true });
  symlinkSync(join(f.root, 'missing'), root); assert.equal((await coordinatorSkills(f.input())).status, 'unavailable'); rmSync(root);
  mkdirSync(root);
  for (let n = 0; n < 4100; n++) f.put(join(root, `${n}.txt`), 'ignored');
  assert.equal((await coordinatorSkills(f.input()) as any).reason, 'limit');
});

test('catalog reads and send-time revalidation call no process or network API, even with hooks, MCP, auth and update settings', async t => {
  const f = fixture(t); f.skill(join(f.config, 'skills/one'), 'one');
  f.put(join(f.config, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'must never execute' }] }] }, apiKeyHelper: 'must never execute', extraKnownMarketplaces: { remote: { source: { source: 'git', url: 'https://invalid.example' } } } }));
  const fail = () => assert.fail('A catalog read attempted a process or network operation');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) t.mock.method(childProcess, name, fail);
  t.mock.method(http, 'request', fail); t.mock.method(https, 'request', fail); t.mock.method(globalThis, 'fetch', fail);
  for (const name of ['writeFileSync', 'mkdirSync', 'symlinkSync', 'renameSync', 'unlinkSync', 'rmSync'] as const) t.mock.method(fs, name, fail);
  for (const name of ['writeFile', 'mkdir', 'symlink', 'rename', 'unlink', 'rm'] as const) t.mock.method(fsPromises, name, fail);
  syncBuiltinESMExports();
  try {
    const first = await coordinatorSkills(f.input()); assert.equal(first.status, 'ready');
    const revalidated = await coordinatorSkills(f.input()); assert.equal(revalidated.status, 'ready'); assert.deepEqual(revalidated.skills, first.skills);
    assert.equal((await coordinatorSkills(f.input('codex'))).status, 'ready');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('supported TOML tables, array tables, quoting and comments are data; unsupported or broken syntax is rejected', () => {
  const result = parseToml('model = "x" # comment\n[projects."/repo"]\ntrust_level = "trusted"\n[[skills.config]]\npath = "/one/SKILL.md"\nenabled = false\n[[skills.config]]\npath = \'/two/SKILL.md\'\nenabled = true\n');
  assert.equal(result.projects['/repo'].trust_level, 'trusted'); assert.equal(result.skills.config.length, 2); assert.equal(result.skills.config[0].enabled, false);
  for (const value of ['x = !execute', 'x = [', 'x = 1\nx = 2', '[x]\na=1\n[x]\nb=2', 'x = 00']) assert.throws(() => parseToml(value));
});

test('default and original-thread Codex homes use the runtime owner without preparing or writing configuration', async t => {
  const f = fixture(t); const source = join(f.home, '.codex'), target = join(f.home, '.codex-alpacawork');
  f.put(join(source, 'auth.json'), '{}');
  for (const path of [source, target]) f.put(join(path, 'skills/.system/.codex-system-skills.marker'), 'fixture');
  f.skill(join(source, 'skills/source'), 'source'); f.skill(join(target, 'skills/isolated'), 'isolated');
  const input = f.input('codex'); delete (input.env as any).CODEX_HOME;
  assert.deepEqual((await coordinatorSkills(input)).skills.map(s => s.name), ['isolated']);
  const session = '01234567-0123-0123-0123-0123456789ab'; f.put(join(source, `sessions/2026/rollout-${session}.jsonl`), '{}');
  assert.deepEqual((await coordinatorSkills({ ...input, session })).skills.map(s => s.name), ['source']);
  assert.equal(readFileSync(join(source, 'auth.json'), 'utf8'), '{}');
  f.put(join(source, 'config.toml'), 'model = "fixture"\n'); symlinkSync(join(source, 'config.toml'), join(target, 'config.toml'));
  const workspace = join(f.home, 'workspace'); mkdirSync(workspace);
  assert.deepEqual((await coordinatorSkills({ ...input, root: workspace })).skills.map(s => s.name), ['isolated']);
  const old = (await coordinatorSkills(input)).skills;
  assert.deepEqual((await coordinatorSkills({ ...input, argv: ['alpacawork-agent', 'codex', '--json', 'resume', '--', session], session: '00000000-0000-0000-0000-000000000000' })).skills, old);
});

test('real CLI metadata agrees in isolated HOME/config with sockets denied, no model input, hooks and MCP neutralized', { timeout: 60000 }, async t => {
  const { existsSync } = await import('node:fs');
  const available = (name: string) => (process.env.PATH ?? '').split(':').some(path => existsSync(join(path, name)));
  if (process.platform !== 'linux' || !['strace', 'claude', 'codex'].every(available)) return t.skip('requires Linux strace and the installed comparison CLIs');
  const f = fixture(t), trace = join(f.root, 'network.trace');
  try {
    const result = await new Promise<string>((resolve, reject) => childProcess.execFile('strace', ['-f', '-s', '300', '-o', trace, '-e', 'trace=socket,connect,execve', '-e', 'inject=socket:error=EAFNOSUPPORT', '-e', 'inject=connect:error=ENETUNREACH', process.execPath, 'tests/fixtures/skill-catalog-contrast.mjs', join(f.root, 'contrast')], { timeout: 55000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH } }, (error, stdout, stderr) => error ? reject(new Error(`${error.message}\n${stderr}\n${stdout}`)) : resolve(stdout)));
    const report = JSON.parse(result); t.diagnostic(JSON.stringify({ claudeCount: report.claude.length, codexCount: report.codex.length, worktreeCount: report.worktreeCount, directoryDisableCount: report.directoryDisableCount, hooks: report.hooks, network: report.network, modelInput: report.modelInput })); assert.equal(report.hooks, 'not executed'); assert.equal(report.modelInput, false);
    assert.ok(report.claude.length >= 5); assert.ok(report.codex.length >= 4);
    const syscalls = readFileSync(trace, 'utf8').split('\n').filter(line => /\b(?:socket|connect)\(/.test(line));
    assert.ok(syscalls.every(line => line.includes('INJECTED') || line.includes('<unfinished ...>')));
  } finally {
    const pids = join(f.root, 'contrast/pids');
    if (existsSync(pids)) for (const value of readFileSync(pids, 'utf8').trim().split('\n')) try { process.kill(-Number(value), 'SIGKILL'); } catch {}
  }
});


test('Codex keeps skills with Claude-only invocation flags and with policy metadata, as it lists them', async t => {
  const f = fixture(t); f.skill(join(f.codex, 'skills/explicit-codex'), 'explicit-codex', 'Explicit use', 'user-invocable: false\ndisable-model-invocation: true\n');
  const result = await coordinatorSkills(f.input('codex')); assert.equal(result.status, 'ready'); assert.deepEqual(result.skills.map(skill => skill.name), ['explicit-codex']);
  f.skill(join(f.codex, 'skills/uncertain'), 'uncertain', 'Unknown policy', 'policy:\n  allow_implicit_invocation: false\n');
  assert.deepEqual((await coordinatorSkills(f.input('codex'))).skills.map(skill => skill.name), ['explicit-codex', 'uncertain']);
});


test('explicit adapter context finds the same catalog for a renamed binary and rejects unknown discovery overrides', async t => {
  const f = fixture(t);
  f.skill(join(f.config, 'skills/native'), 'native');
  f.skill(join(f.codex, 'skills/bridge'), 'bridge');
  const native = { ...f.input('alias', ['/synthetic/renamed-binary', '-m', 'synthetic-model', '-p']), adapter: 'claude' as const };
  const ready = await coordinatorSkills(native);
  assert.equal(ready.status, 'ready'); assert.ok(ready.skills.some(skill => skill.name === 'native'));
  const bridge = { ...f.input('alias', ['/synthetic/another-binary', 'codex', '-c', 'service_tier=fast']), adapter: 'codex' as const };
  assert.equal((await coordinatorSkills(bridge)).status, 'ready');
  assert.deepEqual(await coordinatorSkills({ ...native, argv: [...native.argv, '--settings', '/synthetic/settings'] }),
    { status: 'unavailable', profile: 'alias', skills: [], reason: 'launch' });
  assert.deepEqual(await coordinatorSkills({ ...bridge, argv: [...bridge.argv, '-c', 'skills.config=[]'] }),
    { status: 'unavailable', profile: 'alias', skills: [], reason: 'launch' });
  assert.equal((await coordinatorSkills({ ...bridge, adapter: 'grok' })).status, 'unavailable');
});

test('adapter skills accept contract-prepared Codex fast and verbosity without widening discovery', async t => {
 const f = fixture(t); f.skill(join(f.codex, 'skills/bridge'), 'bridge');
 const setting = defaultAgentSetting('codex');
 setting.params.verbosity = ['high'];
 setting.options = { base: 'a'.repeat(64),
  start: '[-m {model}] [-c service_tier={fast}] [-c model_verbosity={verbosity}] -o {result}',
  resume: '[-m {model}] [-c service_tier={fast}] [-c model_verbosity={verbosity}] resume -o {result} -- {session}' };
 for (const mode of ['start', 'resume'] as const) {
  const admission: Parameters<typeof prepareCoordinatorLaunch>[1] = mode === 'start'
   ? { mode, path: '/synthetic', explicit: { fast: 'fast' } }
   : { mode, path: '/synthetic', explicit: { fast: 'fast' }, previous: { adapter: 'codex', values: {} } };
  const launch = prepareCoordinatorLaunch(compileAgentSetting('codex', setting), admission).launch;
  assert.ok(launch.argv.includes('service_tier={fast}'));
  assert.ok(launch.argv.includes('model_verbosity={verbosity}'));
  const input = { ...f.input('codex', resolveLaunchArgv(launch.argv, launch.values, { result: 'catalog-result', session: 'session' })), adapter: 'codex' as const, session: mode === 'resume' ? 'session' : null };
  const result = await coordinatorSkills(input);
  assert.equal(result.status, 'ready'); assert.ok(result.skills.some(skill => skill.name === 'bridge'));
  for (const override of ['skills.config=[]', 'model_unknown={verbosity}', 'model_verbosity={session}', 'model_verbosity={bad-name}']) {
   const rejected = await coordinatorSkills({ ...input, argv: [...input.argv, '-c', override] });
   assert.deepEqual(rejected, { status: 'unavailable', profile: 'codex', skills: [], reason: 'launch' });
  }
 }
});
