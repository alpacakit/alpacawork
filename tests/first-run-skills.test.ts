import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { FirstRunSkills, skillInstallCommand } from '@alpacawork/backend/test-dist/installation/first-run-skills.js';
import { SKILL_OFFERS } from '@alpacawork/contract';
import { seedSetupSkill } from './helpers/setup-skill-fixture.ts';
import { ManagedSkillsWriter } from '@alpacawork/backend/test-dist/installation/skills.js';
import { InstalledSkillsStore } from '@alpacawork/core/installed-skills';
import type { FirstRunCommand } from '@alpacawork/backend/test-dist/installation/first-run-command.js';

async function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'first-run-skills-'))), home = join(base, 'home'), release = join(base, 'release');
  mkdirSync(home); mkdirSync(release); writeFileSync(join(release, 'package.json'), '{"version":"0.1.0"}');
  for (const name of ['alpacawork', 'alpacawork-betterquality']) {
    mkdirSync(join(release, 'skills', name), { recursive: true }); writeFileSync(join(release, 'skills', name, 'SKILL.md'), name);
  }
  t.after(() => rmSync(base, { recursive: true, force: true }));
  await seedSetupSkill(home, release);
  return { base, home, release, root: join(home, '.agents/skills'), env: { HOME: home, PATH: '' } };
}
async function settled(service: FirstRunSkills) {
  for (let at = 0; at < 400; at++) { const result = await service.status(); if (result.job?.finished) return result; await delay(5); }
  throw new Error('Skill job did not finish');
}

test('unknown and duplicate skill names start no processes and preserve the setup installation', async t => {
  const f = await fixture(t), calls: unknown[] = [];
  const service = new FirstRunSkills({ ...f, run: async (...args) => { calls.push(args); return ''; } });
  t.after(() => service.close());
  for (const names of [['unknown'], ['doyourjob;touch /tmp/no'], ['doyourjob', 'doyourjob'], []])
    assert.throws(() => service.install({ names }), { status: 400 });
  assert.throws(() => skillInstallCommand('unknown'), { status: 400 });
  assert.deepEqual(calls, []);
  assert.deepEqual(new InstalledSkillsStore(f.root).read()!.receipt.skills.map(item => item.name), ['alpacawork']);
  assert.deepEqual(skillInstallCommand('doyourjob'), ['--yes', 'skills@1.8.1', 'add', 'https://github.com/alpacakit/pocket-skills.git', '--global', '--agent', 'codex', '--skill', 'doyourjob', '--yes']);
});

test('selected bundled and repository skills share the update lock; private skills stay outside the managed receipt', async t => {
  const f = await fixture(t), writer = new ManagedSkillsWriter({ root: f.root });
  await writer.install({ version: 2, operationId: randomUUID(), release: f.release, intent: { place: ['alpacawork'], remove: [] } });
  mkdirSync(join(f.home, '.claude'));
  const calls: string[] = [];
  const run: FirstRunCommand = async (command, args, options) => {
    calls.push(args.includes('--list') ? 'probe' : command);
    assert.equal(options.env.DISABLE_TELEMETRY, '1');
    if (command === 'npx' && !args.includes('--list')) { const name = args[args.indexOf('--skill') + 1]!;
      mkdirSync(join(f.root, name), { recursive: true }); writeFileSync(join(f.root, name, 'SKILL.md'), 'external'); }
    return 'source reachable';
  };
  const service = new FirstRunSkills({ ...f, run }); t.after(() => service.close());
  let releaseLock!: () => void, locked!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const hold = new InstalledSkillsStore(f.root).session(async () => { locked(); await new Promise<void>(resolve => { releaseLock = resolve; }); });
  await acquired;
  const accepted = service.install({ names: ['alpacawork-betterquality', 'doyourjob'] }, 'replay-key');
  assert.equal(service.install({ names: ['alpacawork-betterquality', 'doyourjob'] }, 'replay-key').job.id, accepted.job.id);
  assert.throws(() => service.install({ names: ['askmeclearly'] }, 'replay-key'), { code: 'idempotency_conflict' });
  assert.throws(() => service.install({ names: ['askmeclearly'] }), { status: 409 });
  await delay(40); assert.equal(calls.includes('npx'), false, 'the same writer lock blocks external commands');
  releaseLock(); await hold;
  const result = await settled(service);
  assert.ok(result.job?.items.every(item => item.state === 'done'));
  const receipt = new InstalledSkillsStore(f.root).read()!.receipt;
  assert.deepEqual(receipt.skills.map(item => item.name), ['alpacawork', 'alpacawork-betterquality']);
  assert.equal(result.skills.find(item => item.name === 'doyourjob')?.claudeLink, 'ok');
  const count = calls.filter(cmd => cmd === 'npx').length;
  service.install({ names: ['doyourjob'] }); await settled(service);
  assert.equal(calls.filter(cmd => cmd === 'npx').length, count, 'installed selections are not overwritten');
});

test('a conflicting Claude link is preserved and returned as a failed selected row', async t => {
  const f = await fixture(t); mkdirSync(join(f.home, '.claude/skills/doyourjob'), { recursive: true });
  const marker = join(f.home, '.claude/skills/doyourjob/SKILL.md'); writeFileSync(marker, 'personal content');
  const calls: string[] = [], service = new FirstRunSkills({ ...f, run: async (cmd, args) => { calls.push(args.includes('--list') ? 'probe' : cmd); return ''; } });
  t.after(() => service.close()); service.install({ names: ['doyourjob'] });
  const result = await settled(service);
  assert.deepEqual(result.job?.items.map(item => item.state === 'failed' && item.reason), ['link_conflict']);
  assert.equal(calls.includes('npx'), false); assert.equal(readFileSync(marker, 'utf8'), 'personal content');
});

test('installer timeout terminates a child group even when a descendant ignores TERM', { skip: process.platform !== 'linux' }, async t => {
  const { runFirstRunCommand } = await import('@alpacawork/backend/test-dist/installation/first-run-command.js');
  const f = await fixture(t), pidFile = join(f.base, 'child-pid');
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000);`;
  await assert.rejects(runFirstRunCommand(process.execPath, ['-e', parent, pidFile], { env: f.env, timeout: 300 }), { kind: 'timeout' });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  // SIGKILL delivery and the kernel's transition to a zombie are asynchronous.
  for (let tries = 0; tries < 50; tries++) {
    let state: string | null;
    try { state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[0]!; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; state = null; }
    if (state === null || state === 'Z') return;
    await delay(5);
  }
  assert.fail('a running installer descendant remains');
});

test('shutdown cancels a job waiting behind the shared update lock without starting its installer', async t => {
  const f = await fixture(t); mkdirSync(f.root, { recursive: true });
  let releaseLock!: () => void, acquired!: () => void;
  const held = new Promise<void>(resolve => { acquired = resolve; });
  const holder = new InstalledSkillsStore(f.root).session(async () => { acquired(); await new Promise<void>(resolve => { releaseLock = resolve; }); });
  await held;
  let started = false;
  const service = new FirstRunSkills({ ...f, run: async (_cmd, args) => { if (!args.includes('--list')) started = true; return ''; } });
  try {
    service.install({ names: ['doyourjob'] });
    await Promise.race([service.close(), delay(500).then(() => { throw new Error('shutdown waited for an unrelated installation'); })]);
    assert.equal(started, false);
  } finally { releaseLock(); await holder; await service.close(); }
});


test('listing skills never starts commands, including concurrent reads during an approved install', async t => {
  const f = await fixture(t);
  let complete!: () => void, calls = 0;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const service = new FirstRunSkills({ ...f, run: async () => { calls++; await pending; return ''; } });
  t.after(() => service.close());
  const reads = await Promise.all(Array.from({ length: 8 }, () => service.status()));
  assert.equal(calls, 0);
  assert.ok(reads.every(read => read.skills.filter(skill => SKILL_OFFERS.some(offer => offer.name === skill.name && offer.from.kind === 'repo')).every(skill => skill.available === 'unknown')));
  service.install({ names: ['doyourjob'] });
  try {
    const progress = await Promise.race([service.status(), delay(100).then(() => { throw new Error('Progress waited for an installer'); })]);
    assert.equal(progress.job?.finished, false);
    assert.equal(progress.skills.find(skill => skill.name === 'doyourjob')?.available, 'unknown');
  } finally { complete(); }
  await settled(service);
  assert.equal(calls, 1, 'only the explicit installation starts a command');
});


test('a Claude skills folder linked to the shared root already exposes installed skills', async t => {
  const f = await fixture(t); mkdirSync(join(f.root, 'doyourjob'), { recursive: true });
  writeFileSync(join(f.root, 'doyourjob/SKILL.md'), 'existing');
  mkdirSync(join(f.home, '.claude')); symlinkSync(f.root, join(f.home, '.claude/skills'), 'dir');
  let calls = 0;
  const service = new FirstRunSkills({ ...f, run: async () => { calls++; return ''; } });
  t.after(() => service.close());
  assert.equal((await service.status()).skills.find(skill => skill.name === 'doyourjob')?.claudeLink, 'ok');
  service.install({ names: ['doyourjob'] });
  assert.equal((await settled(service)).job?.items[0]?.state, 'done');
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(f.root, 'doyourjob/SKILL.md'), 'utf8'), 'existing');
});


test('a missing setup skill returns a recovery action for the selected bundled skill', async t => {
  for (const missing of ['files', 'record']) {
    const f = await fixture(t); rmSync(join(f.root, missing === 'files' ? 'alpacawork' : '.alpacawork/installed.json'), { recursive: true });
    const service = new FirstRunSkills({ ...f, locale: () => 'ja', run: async () => { throw new Error('No process is needed'); } });
    t.after(() => service.close()); service.install({ names: ['alpacawork-betterquality'] });
    const item = (await settled(service)).job!.items[0]!;
    assert.equal(item.state, 'failed');
    assert.ok(item.state === 'failed' && item.detail?.includes('alpacawork setup'));
  }
});


test('an installer that writes no files leaves no link, and a broken skill cannot break the listing', async t => {
  for (const sharedFolder of [false, true]) {
    const f = await fixture(t); mkdirSync(join(f.home, '.claude'));
    if (sharedFolder) symlinkSync(f.root, join(f.home, '.claude/skills'), 'dir');
    const service = new FirstRunSkills({ ...f, run: async () => '' });
    t.after(() => service.close()); service.install({ names: ['doyourjob'] });
    assert.equal((await settled(service)).job!.items[0]!.state, 'failed');
    assert.equal(lstatSync(join(f.home, '.claude/skills/doyourjob'), { throwIfNoEntry: false }), undefined);
    symlinkSync(join(f.root, 'doyourjob'), join(f.root, 'doyourjob'), 'dir');
    const listed = await service.status();
    assert.equal(listed.skills.length, SKILL_OFFERS.length);
    assert.equal(listed.skills.find(skill => skill.name === 'doyourjob')?.installed, false);
  }
});


test('owned links with a missing destination can be reinstalled, while a self link stays a conflict', async t => {
  const f = await fixture(t); mkdirSync(join(f.home, '.claude/skills'), { recursive: true });
  for (const name of ['doyourjob', 'alpacawork-betterquality']) symlinkSync(join(f.root, name), join(f.home, '.claude/skills', name), 'dir');
  let calls = 0;
  const service = new FirstRunSkills({ ...f, run: async () => {
    calls++; mkdirSync(join(f.root, 'doyourjob')); writeFileSync(join(f.root, 'doyourjob/SKILL.md'), 'synthetic'); return '';
  } });
  t.after(() => service.close()); service.install({ names: ['doyourjob', 'alpacawork-betterquality'] });
  assert.ok((await settled(service)).job!.items.every(item => item.state === 'done'));
  assert.equal(calls, 1);
  rmSync(join(f.root, 'doyourjob'), { recursive: true });
  symlinkSync(join(f.root, 'doyourjob'), join(f.root, 'doyourjob'), 'dir');
  assert.equal((await service.status()).skills.find(skill => skill.name === 'doyourjob')?.claudeLink, 'conflict');
  service.install({ names: ['doyourjob'] });
  const item = (await settled(service)).job!.items[0]!;
  assert.ok(item.state === 'failed' && item.reason === 'link_conflict');
  assert.equal(calls, 1);
});
