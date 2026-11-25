import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, chmodSync, writeFileSync, readFileSync, readlinkSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertManagedSkillsVersion } from '@alpacawork/backend/test-dist/coordinator/managed-skills-version.js';
import { skillsUpdateCommand } from '@alpacawork/backend/test-dist/installation/skills-update-command.js';
import { InstalledSkillsStore } from '@alpacawork/core/installed-skills';
import { Problem } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { installationSkillsRoot } from '@alpacawork/backend/test-dist/installation/setup.js';
import { skillWriteResultSchema } from '@alpacawork/backend/test-dist/installation/skills.js';
import { assembleFixtureDistribution } from './helpers/distribution-fixture.ts';
import { installed, openTree } from './helpers/managed-skills-fixture.ts';
import { callerWorkspace } from './coordinator-caller.fixture.ts';
import { coordinatorMessageInputSchema } from '@alpacawork/contract/coordinator';

// A tiny synthetic packaged release. No registry, service or provider is involved.
const caller = pathToFileURL(resolve('apps/backend/dist/installation/skills-update.js')).href;
function syntheticRelease(root: string, skillsUpdate: string) {
  const release = join(root, 'release'), home = join(root, 'home'), bin = join(root, 'bin');
  for (const path of [release, bin, join(home, '.agents/skills'), join(release, 'node_modules/@alpacawork'), join(release, 'apps/backend/dist/installation')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  cpSync(resolve('apps/launcher'), join(release, 'bin'), { recursive: true });
  chmodSync(join(release, 'bin/alpacawork.mjs'), 0o700);
  symlinkSync(resolve('packages/core'), join(release, 'node_modules/@alpacawork/core'));
  writeFileSync(join(release, 'apps/backend/dist/package-version.js'),
    `export { readPackageVersion } from ${JSON.stringify(pathToFileURL(resolve('apps/backend/dist/package-version.js')).href)};\n`);
  const source = 'a'.repeat(40), format = 'b'.repeat(64);
  writeFileSync(join(release, 'SOURCE'), source); writeFileSync(join(release, 'FORMAT'), format);
  writeFileSync(join(release, 'package.json'), JSON.stringify({ name: 'alpacawork', version: '0.3.0', type: 'module', alpacawork: { source, format, targets: ['linux-x64-glibc', 'darwin-arm64'] } }));
  // The opt-in add-on ships too, but an update must not place it where nobody chose it.
  for (const name of ['alpacawork', 'alpacawork-betterquality', 'alpacawork-modelpickoptimization']) {
    mkdirSync(join(release, 'skills', name), { recursive: true }); writeFileSync(join(release, 'skills', name, 'SKILL.md'), 'Synthetic skill');
  }
  writeFileSync(join(release, 'apps/backend/dist/installation/skills-update.js'), skillsUpdate);
  return { release, home, bin };
}
// The stubbed writer plus a fake npx show what reaches the caller.
test('the refusal command reaches the public launcher and v2 caller literally; failed operation resumes under its printed ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-public-cli-'));
  try {
    const { release, home, bin } = syntheticRelease(root, `
import {main as update} from ${JSON.stringify(caller)};
import {appendFileSync} from 'node:fs';
export const main = (args, input) => update(args, {...input, createWriter: ({root}) => ({install: async request => {
 appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({root,request})+'\\n');
 if(process.env.FIXTURE_FAIL) throw new Error('synthetic interruption');
 return {kind:'committed',operationId:request.operationId,receipt:{version:2,state:'complete',operationId:request.operationId,request:{release:request.release,...request.intent},skills:[{name:'alpacawork',source:{version:'0.3.0'}}]}};
}})});
`), calls = join(root, 'calls.jsonl');
    writeFileSync(join(bin, 'npx'), `#!${process.execPath}
const fs = require('node:fs'); const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_NPX,JSON.stringify(args)+'\\n');
if(args[0]!=='--yes'||args[1]!=='--package=alpacawork@0.3.0'||args[2]!=='alpacawork')process.exit(90);
const child=spawnSync(process.env.FIXTURE_LAUNCHER,args.slice(3),{env:process.env,encoding:'utf8'});
process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');if(child.error)throw child.error;process.exit(child.status??91);
`, { mode: 0o700 });
    const env = { ...process.env, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
      ALPACAWORK_RUN_CLI: '/usr/bin/false', FIXTURE_CALLS: calls, FIXTURE_NPX: join(root, 'npx.jsonl'), FIXTURE_LAUNCHER: join(release, 'bin/alpacawork.mjs'), COREPACK_ENABLE_NETWORK: '0' };
    // Execute exactly the string that admission presents to the person.
    const command = skillsUpdateCommand('0.3.0');
    const failed = spawnSync('/bin/sh', ['-c', command], { env: { ...env, FIXTURE_FAIL: '1' }, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /synthetic interruption/);
    const op = /Skills update operation: ([0-9a-f-]+)\./.exec(failed.stderr)![1]!;
    const resumed = spawnSync('/bin/sh', ['-c', `${command} --operation-id ${op}`], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(resumed.status, 0, resumed.stderr); assert.equal(JSON.parse(resumed.stdout).operationId, op);
    const requests = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].root, join(home, '.agents/skills'));
    assert.deepEqual(requests[0].request, { version: 2, operationId: op, release,
      intent: { place: ['alpacawork', 'alpacawork-betterquality'], remove: [] } });
    assert.deepEqual(JSON.parse(readFileSync(env.FIXTURE_NPX, 'utf8').split('\n')[0]!), ['--yes', '--package=alpacawork@0.3.0', 'alpacawork', 'skills', 'update', '--package-version', '0.3.0']);
    const invalid = spawnSync('/bin/sh', ['-c', `${command} --server http://example.invalid`], { env, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Usage:/);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const config of ['.claude']) test(`skills update with the real writer links every placed skill from ~/${config}/skills, reports a path it left alone, and leaves a HOME without ~/${config} alone`, () => {
  const root = mkdtempSync(join(tmpdir(), 'skills-agent-links-'));
  try {
    const { release, home } = syntheticRelease(root, `export { main } from ${JSON.stringify(caller)};\n`), linked = join(home, config, 'skills');
    const update = (lang: string) => spawnSync(process.execPath, [join(release, 'bin/alpacawork.mjs'), 'skills', 'update', '--package-version', '0.3.0'], { encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ALPACAWORK_RUN_CLI: '/usr/bin/false', LANG: lang, LC_ALL: '', LC_MESSAGES: '' } });
    const none = update('en'); assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(JSON.parse(none.stdout).receipt.skills.map((skill: { name: string }) => skill.name), ['alpacawork', 'alpacawork-betterquality']);
    assert.equal(existsSync(join(home, config)), false); assert.doesNotMatch(none.stderr, /Link not created/);
    // The agent arrives later, with the person's own copy of one add-on already in its folder.
    mkdirSync(join(linked, 'alpacawork-betterquality'), { recursive: true }); writeFileSync(join(linked, 'alpacawork-betterquality/SKILL.md'), 'my own copy');
    for (const lang of ['en', 'ja']) {
      const kept = update(lang); assert.equal(kept.status, 0, kept.stderr);
      assert.equal(readlinkSync(join(linked, 'alpacawork')), join(home, '.agents/skills/alpacawork'));
      assert.equal(readFileSync(join(linked, 'alpacawork/SKILL.md'), 'utf8'), 'Synthetic skill');
      assert.equal(readFileSync(join(linked, 'alpacawork-betterquality/SKILL.md'), 'utf8'), 'my own copy');
      assert(kept.stderr.includes(join(linked, 'alpacawork-betterquality') + (lang === 'ja' ? '：リンク未作成・既存の内容を保持' : ': Link not created; existing content preserved')), kept.stderr);
      skillWriteResultSchema.parse(JSON.parse(kept.stdout));
    }
    rmSync(join(linked, 'alpacawork-betterquality'), { recursive: true });
    const placed = update('en'); assert.equal(placed.status, 0, placed.stderr); assert.doesNotMatch(placed.stderr, /Link not created/);
    assert.equal(readlinkSync(join(linked, 'alpacawork-betterquality')), join(home, '.agents/skills/alpacawork-betterquality'));
    assert.deepEqual(readdirSync(linked).sort(), ['alpacawork', 'alpacawork-betterquality']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the literal public command uses the real writer and installation root; update alone does not send, explicit resend admits once', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = { root: mkdtempSync(join(tmpdir(), 'skills-real-bundle-')) };
  t.after(() => { openTree(f.root); rmSync(f.root, { recursive: true, force: true }); });
  const home = join(f.root, 'home'), bin = join(f.root, 'bin');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(bin);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'), XDG_CACHE_HOME: join(home, '.cache'),
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, ALPACAWORK_RUN_CLI: '/usr/bin/false', COREPACK_ENABLE_NETWORK: '0' };
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const) {
    const prior = process.env[key]; process.env[key] = env[key];
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
  }
  const release = join(f.root, 'independent-release');
  assembleFixtureDistribution(resolve('.'), join(f.root, 'build'), release, undefined, built => {
    writeFileSync(join(built, 'skills/alpacawork/SKILL.md'), 'fixture skill');
  });
  const launcher = join(release, 'bin/alpacawork.mjs'), log = join(f.root, 'npx.jsonl');
  writeFileSync(join(bin, 'npx'), `#!${process.execPath}
const fs=require('node:fs'),{spawnSync}=require('node:child_process');const args=process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_NPX,JSON.stringify(args)+'\\n');
if(args[0]!=='--yes'||args[1]!=='--package=alpacawork@${packageVersion}'||args[2]!=='alpacawork')process.exit(90);
const child=spawnSync(process.env.FIXTURE_LAUNCHER,args.slice(3),{env:process.env,encoding:'utf8',timeout:15000});
process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');if(child.error)throw child.error;process.exit(child.status??91);
`, { mode: 0o700 });
  const run = (command: string) => spawnSync('/bin/sh', ['-c', command], {
    env: { ...env, FIXTURE_NPX: log, FIXTURE_LAUNCHER: launcher }, encoding: 'utf8', timeout: 20000,
  });
  // A source checkout without a receipt is allowed. This scenario starts with an installed older skill.
  await installed(f.root, ['alpacawork']);
  const w = callerWorkspace(t), owner = new CoordinatorConversation(w.root), conversation = owner.read();
  const input = coordinatorMessageInputSchema.parse({ conversationId: conversation.id, id: randomUUID(), text: '/alpacawork original instruction', skills: ['alpacawork'], attachments: [] });
  const counts = () => { const db = new ControlStore(w.root, { busyTimeoutMs: 1000 }, true);
    try { return db.read(db => ['requests', 'runs', 'tasks', 'task_log'].map(table => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n))); } finally { db.close(); } };
  const before = counts(); let command = '';
  assert.throws(() => owner.ask(input), (error: unknown) => {
    assert.ok(error instanceof Problem); assert.equal(error.reason?.kind, 'managed_skills_version');
    if (error.reason?.kind === 'managed_skills_version') command = error.reason.command;
    return true;
  });
  assert.equal(command, skillsUpdateCommand(packageVersion)); assert.deepEqual(counts(), before);
  const result = run(command); assert.equal(result.status, 0, result.stderr);
  const committed = skillWriteResultSchema.parse(JSON.parse(result.stdout));
  const root = installationSkillsRoot(env), stored = new InstalledSkillsStore(root).read()!.receipt;
  assert.equal(root, join(home, '.agents/skills')); assert.deepEqual(stored, committed.receipt);
  assert.ok(stored.state === 'complete'); assert.equal(stored.skills.find(skill => skill.name === 'alpacawork')!.source.version, packageVersion);
  assert.equal(readFileSync(join(root, 'alpacawork/SKILL.md'), 'utf8'), 'fixture skill');
  assert.deepEqual(counts(), before); // Updating never POSTs/admits a request or reserves a Run.
  const replay = run(`${command} --operation-id ${committed.operationId}`);
  assert.equal(replay.status, 0, replay.stderr); assert.deepEqual(JSON.parse(replay.stdout), committed); assert.deepEqual(counts(), before);
  const accepted = owner.ask(input); assert.equal(accepted.turns.filter(turn => turn.id === input.id).length, 1);
  const afterSend = before.map((value, index) => value + (index < 2 ? 1 : 0)); assert.deepEqual(counts(), afterSend);
  assert.equal(owner.ask(input).turns.filter(turn => turn.id === input.id).length, 1); assert.deepEqual(counts(), afterSend);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8').split('\n')[0]!), ['--yes', `--package=alpacawork@${packageVersion}`, 'alpacawork', 'skills', 'update', '--package-version', packageVersion]);
});


test('skills-only and application updates preserve installed private add-ons and their recorded versions', async t => {
  const root = mkdtempSync(join(tmpdir(), 'skills-private-retained-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { release, home } = syntheticRelease(root, `export { main } from ${JSON.stringify(caller)};\n`);
  const skills = join(home, '.agents/skills'), store = new InstalledSkillsStore(skills);
  const privateNames = ['alpacawork-majority', 'alpacawork-try-and-keep'] as const;
  const all = ['alpacawork', 'alpacawork-betterquality', ...privateNames] as const;
  await store.session(session => {
    session.begin({ operationId: randomUUID(), release, place: [...all], remove: [] });
    for (const name of all) {
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, name, 'SKILL.md'), 'installed content for ' + name);
    }
    session.commit();
  });
  const check = () => {
    assert.doesNotThrow(() => assertManagedSkillsVersion(privateNames, home, '0.4.0'));
    const receipt = store.read()!.receipt;
    assert.deepEqual(receipt.skills.map(skill => skill.name), [...all]);
    for (const name of privateNames) {
      assert.equal(readFileSync(join(skills, name, 'SKILL.md'), 'utf8'), 'installed content for ' + name);
      assert.equal(receipt.skills.find(skill => skill.name === name)!.source.version, '0.3.0');
    }
  };
  const result = spawnSync(process.execPath, [join(release, 'bin/alpacawork.mjs'), 'skills', 'update', '--package-version', '0.3.0'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, HOME: home, ALPACAWORK_RUN_CLI: '/usr/bin/false' },
  });
  assert.equal(result.status, 0, result.stderr); check();
  assert.equal(readFileSync(join(skills, 'alpacawork-betterquality/SKILL.md'), 'utf8'), 'Synthetic skill');
  const { completeUpdateSkills } = await import('@alpacawork/backend/test-dist/release/update-skills.js');
  const { updateTarget } = await import('@alpacawork/backend/test-dist/release/update-record.js');
  const releases = join(root, 'releases'), workspace = join(root, 'workspace');
  mkdirSync(releases); mkdirSync(join(workspace, '.alpacawork'), { recursive: true });
  // An operation accepted by the previous release may still include all four names.
  const operation = { opId: randomUUID(), workspace, skills: { root: skills, place: [...all] },
    candidate: { facts: { source: 'a'.repeat(40) }, edition: 'production' } };
  const target = updateTarget(releases, operation as Parameters<typeof updateTarget>[1]);
  cpSync(release, target, { recursive: true });
  const manifest = join(target, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: '0.4.0' }));
  await completeUpdateSkills({ releases, workspace } as Parameters<typeof completeUpdateSkills>[0], {
    version: 4, opId: operation.opId, workspace, old: release, target, previous: null,
    phase: 'target_ready', skillsWriteStarted: false, schema: null,
  }, operation as Parameters<typeof completeUpdateSkills>[2]);
  check();
  assert.equal(store.read()!.receipt.skills.find(skill => skill.name === 'alpacawork')!.source.version, '0.4.0');
});
