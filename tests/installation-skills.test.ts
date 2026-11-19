/** Real overwrite writer: edits are intentionally replaced, other skills are independent. */
import assert from 'node:assert/strict';
import fs, { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { skillWriterFixture } from './helpers/skill-writer-fixture.ts';
import { ManagedSkillsWriter, SkillWriteFailure } from '../apps/backend/test-dist/installation/skills.js';
import { finishSetupSkills, newSetupSkills, readSetupSkills, saveSetupSkills } from '../apps/backend/test-dist/installation/setup-skills.js';
import { assertManagedSkillsVersion } from '../apps/backend/test-dist/coordinator/managed-skills-version.js';

const cleanStage = (f: ReturnType<typeof skillWriterFixture>) => assert.deepEqual(readdirSync(join(f.root, '..')).sort(), ['skills']);
function causeMessages(error: unknown): string {
 return error instanceof Error ? error.message + '\n' + causeMessages(error.cause) : '';
}

test('overwrite removes obsolete files, preserves custom skills and completes with only one record', async t => {
 const f = skillWriterFixture(t); f.put();
 mkdirSync(join(f.root, 'custom')); writeFileSync(join(f.root, 'custom/SKILL.md'), 'custom');
 writeFileSync(join(f.root, 'alpacawork/obsolete.txt'), 'local edits');
 const request = f.request(), result = await f.writer.install(request);
 assert.equal(result.kind, 'committed'); assert.equal(result.operationId, request.operationId);
 assert.equal(f.store().read()?.receipt.state, 'complete');
 assert.equal(f.read(), readFileSync(join(f.release, 'skills/alpacawork/SKILL.md'), 'utf8'));
 assert.equal(fs.existsSync(join(f.root, 'alpacawork/obsolete.txt')), false);
 assert.equal(readFileSync(join(f.root, 'custom/SKILL.md'), 'utf8'), 'custom');
 assert.deepEqual(readdirSync(join(f.root, '.alpacawork')).sort(), ['install.lock', 'installed.json']);
 cleanStage(f);
 assert.deepEqual(await new ManagedSkillsWriter({ root: f.root }).install(request), result);
 assert.equal('inspect' in f.writer, false);
});

for (const newOperation of [false, true]) test(`partial same-version overwrite refuses send and restarts from source (new operation: ${newOperation})`, async t => {
 const f = skillWriterFixture(t);
 const intent = { place: ['alpacawork', 'alpacawork-betterquality'] as const, remove: [] };
 await f.writer.install(f.request({ place: [...intent.place], remove: [] }));
 const home = join(f.root, '../..'), version = JSON.parse(readFileSync(join(f.release, 'package.json'), 'utf8')).version;
 assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork'], home, version));
 const request = f.request({ place: [...intent.place], remove: [] }), rename = fs.renameSync;
 const hook = t.mock.method(fs, 'renameSync', (from, to) => {
  if (String(from).includes('.alpacawork-skill-stage-') && String(to).endsWith('/alpacawork-betterquality'))
   throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
  return rename(from, to);
 }); syncBuiltinESMExports();
 try { await assert.rejects(f.writer.install(request), e => e instanceof SkillWriteFailure && causeMessages(e).includes('synthetic ENOSPC')); }
 finally { hook.mock.restore(); syncBuiltinESMExports(); }
 const receipt = f.store().read()!.receipt;
 assert.equal(receipt.state, 'installing'); assert.equal('previous' in receipt, false);
 assert.throws(() => assertManagedSkillsVersion(['alpacawork'], home, version), /alpacawork@/);
 cleanStage(f);
 const retry = { ...request, operationId: newOperation ? randomUUID() : request.operationId };
 const complete = await new ManagedSkillsWriter({ root: f.root }).install(retry);
 assert.equal(complete.receipt.operationId, retry.operationId);
 assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork'], home, version)); cleanStage(f);
});

test('untouched addons retain edits and origin across interruption; remove is explicit', async t => {
 const f = skillWriterFixture(t);
 const first = await f.writer.install(f.request({ place: ['alpacawork', 'alpacawork-betterquality'], remove: [] }));
 f.put('alpacawork-betterquality', 'keep addon edits');
 await f.store().session(s => s.begin({ ...f.request().intent, operationId: randomUUID(), release: f.release }));
 const pending = f.store().read()!.receipt;
 assert.deepEqual(pending.skills[1], first.receipt.skills[1]);
 const next = await f.writer.install(f.request());
 assert.deepEqual(next.receipt.skills[1], first.receipt.skills[1]);
 assert.equal(readFileSync(join(f.root, 'alpacawork-betterquality/SKILL.md'), 'utf8'), 'keep addon edits');
 const removed = await f.writer.install(f.request({ place: [], remove: ['alpacawork-betterquality'] }));
 assert.deepEqual(removed.receipt.skills.map(s => s.name), ['alpacawork']);
 assert.equal(fs.existsSync(join(f.root, 'alpacawork-betterquality')), false);
});

test('invalid final selections and unmanaged names refuse before bytes change', async t => {
 const f = skillWriterFixture(t);
 await assert.rejects(f.writer.install(f.request({ place: ['alpacawork-betterquality'], remove: [] })), SkillWriteFailure);
 assert.equal(f.store().read(), null);
 await f.writer.install(f.request()); const before = f.store().read();
 await assert.rejects(f.writer.install(f.request({ place: [], remove: ['alpacawork'] })), SkillWriteFailure);
 assert.deepEqual(f.store().read(), before);
 await assert.rejects(f.writer.install({ ...f.request(), intent: { place: ['custom'] as any, remove: [] } }));
 assert.equal(fs.existsSync(join(f.root, 'custom')), false);
});

test('installation reads only the package version and copies selected directories, leaving integrity to acquisition', async t => {
 const f = skillWriterFixture(t), originalRead = fs.readFileSync, originalScan = fs.readdirSync;
 const reads: string[] = [], scans: string[] = [];
 const readHook = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
  if (typeof args[0] === 'string' && args[0].startsWith(f.release + '/')) reads.push(args[0].slice(f.release.length + 1));
  return Reflect.apply(originalRead, fs, args);
 });
 const scanHook = t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
  if (String(args[0]).startsWith(f.release)) scans.push(String(args[0]).slice(f.release.length));
  return Reflect.apply(originalScan, fs, args);
 }); syncBuiltinESMExports();
 const request = f.request();
 try { await f.writer.install(request); await f.writer.install(request); }
 finally { readHook.mock.restore(); scanHook.mock.restore(); syncBuiltinESMExports(); }
 assert.equal(scans.includes(''), false);
 assert.ok(scans.every(path => path.startsWith('/skills/alpacawork')));
 assert.deepEqual(reads, ['package.json', 'package.json']);
});

test('a retry cannot mark an unfinished addon complete by leaving it untouched', async t => {
 const f = skillWriterFixture(t);
 await f.writer.install(f.request());
 await f.store().session(s => s.begin({ operationId: randomUUID(), release: f.release, place: ['alpacawork-betterquality'], remove: [] }));
 await assert.rejects(f.writer.install(f.request()), e => e instanceof SkillWriteFailure && causeMessages(e).includes('unfinished'));
 assert.equal(f.store().read()!.receipt.state, 'installing');
 const removed = await f.writer.install(f.request({ place: ['alpacawork'], remove: ['alpacawork-betterquality'] }));
 assert.deepEqual(removed.receipt.skills.map(s => s.name), ['alpacawork']);
});

for (const phase of ['stage-flush', 'receipt-rename', 'receipt-flush'] as const) test(`writer reports ${phase} failure truthfully and retry succeeds`, async t => {
 const f = skillWriterFixture(t); await f.writer.install(f.request());
 const request = f.request(), sync = fs.fsyncSync, rename = fs.renameSync;
 let injected = false;
 const receiptFile = join(f.root, '.alpacawork/installed.json');
 const syncing = t.mock.method(fs, 'fsyncSync', (fd: number) => {
  const info = fs.fstatSync(fd);
  const saved = JSON.parse(readFileSync(receiptFile, 'utf8')), state = saved.state;
  if (!injected && (phase === 'stage-flush' && info.isFile() && state === 'installing' &&
      fs.existsSync(join(f.root, '../.alpacawork-skill-stage-skills/alpacawork/SKILL.md')) ||
      phase === 'receipt-flush' && info.isDirectory() && state === 'complete' && saved.operationId === request.operationId)) {
   injected = true; throw Object.assign(new Error(`synthetic ${phase}`), { code: 'EIO' });
  }
  return sync(fd);
 });
 const renaming = t.mock.method(fs, 'renameSync', (from, to) => {
  if (!injected && phase === 'receipt-rename' && String(to) === receiptFile &&
      JSON.parse(readFileSync(from, 'utf8')).state === 'complete') {
   injected = true; throw Object.assign(new Error(`synthetic ${phase}`), { code: 'ENOSPC' });
  }
  return rename(from, to);
 }); syncBuiltinESMExports();
 try {
  await assert.rejects(f.writer.install(request), e => e instanceof SkillWriteFailure && causeMessages(e).includes(`synthetic ${phase}`));
 } finally { syncing.mock.restore(); renaming.mock.restore(); syncBuiltinESMExports(); }
 assert.equal(injected, true); cleanStage(f);
 assert.equal(f.store().read()!.receipt.state, phase === 'receipt-flush' ? 'complete' : 'installing');
 assert.equal((await f.writer.install(request)).kind, 'committed');
});


test('setup forwards the unchanged v2 request to the common writer and keeps its readiness journal', async t => {
 const f = skillWriterFixture(t), request = f.request();
 const saved = newSetupSkills('/synthetic/workspace', f.root, request), messages: string[] = [];
 saveSetupSkills(f.release, saved);
 await finishSetupSkills(f.release, saved, f.writer, line => messages.push(line));
 assert.deepEqual(readSetupSkills(f.release), saved);
 assert.equal(f.store().read()!.receipt.operationId, request.operationId);
 assert.equal(f.store().read()!.receipt.state, 'complete');
 assert.deepEqual(messages, ['Managed skills installed.']);
});

for (const change of ['release', 'version', 'selection', 'required-removal'] as const) test(`same operation ID refuses a different final result before mutation (${change})`, async t => {
 const f = skillWriterFixture(t), request = f.request();
 await f.writer.install(request);
 const before = f.store().read(), bytes = f.read();
 let replay = request;
 if (change === 'release') {
  const release = join(f.release, '../other-distribution'); fs.cpSync(f.release, release, { recursive: true });
  const file = join(release, 'package.json'), pkg = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...pkg, version: '2.0.0' }));
  replay = { ...request, release };
 } else if (change === 'version') writeFileSync(join(f.release, 'package.json'), JSON.stringify({ version: '2.0.0' }));
 else replay = { ...request, intent: change === 'selection'
  ? { place: ['alpacawork', 'alpacawork-betterquality'], remove: [] }
  : { place: [], remove: ['alpacawork'] } };
 await assert.rejects(f.writer.install(replay), SkillWriteFailure);
 assert.deepEqual(f.store().read(), before); assert.equal(f.read(), bytes);
 assert.equal(fs.existsSync(join(f.root, 'alpacawork-betterquality')), false); cleanStage(f);
});

test('same operation ID refuses a different selection even when the final version table is identical', async t => {
 const f = skillWriterFixture(t), request = f.request({ place: ['alpacawork', 'alpacawork-betterquality'], remove: [] });
 await f.writer.install(request); const before = f.store().read();
 f.put('alpacawork', 'keep edits on an identical completed replay');
 await assert.rejects(f.writer.install({ ...request, intent: { place: ['alpacawork'], remove: [] } }), SkillWriteFailure);
 assert.deepEqual(f.store().read(), before);
 assert.equal(f.read(), 'keep edits on an identical completed replay'); cleanStage(f);
});

for (const change of ['release', 'selection', 'version'] as const) test(`an unfinished operation ID refuses a changed request or table (${change})`, async t => {
 const f = skillWriterFixture(t), request = f.request({ place: ['alpacawork', 'alpacawork-betterquality'], remove: [] });
 // Start the actual Store transition without placing bytes, as after a writer interruption.
 f.put();
 await f.store().session(s => s.begin({ operationId: request.operationId, release: request.release, ...request.intent }));
 const before = f.store().read(), bytes = f.read();
 let replay = request;
 if (change === 'release') {
  const release = join(f.release, '../same-version-distribution'); fs.cpSync(f.release, release, { recursive: true });
  replay = { ...request, release };
 } else if (change === 'selection') replay = { ...request, intent: { place: ['alpacawork'], remove: [] } };
 else writeFileSync(join(f.release, 'package.json'), JSON.stringify({ version: '2.0.0' }));
 await assert.rejects(f.writer.install(replay), SkillWriteFailure);
 assert.deepEqual(f.store().read(), before); assert.equal(f.read(), bytes); cleanStage(f);
});

test('completed replay uses request and version table without inspecting changed source bytes', async t => {
 const f = skillWriterFixture(t), request = f.request();
 const committed = await f.writer.install(request);
 f.put('alpacawork', 'keep edits on the same completed request');
 writeFileSync(join(f.release, 'skills/alpacawork/SKILL.md'), 'changed bytes belong to distribution acquisition');
 assert.deepEqual(await f.writer.install(request), committed);
 assert.equal(f.read(), 'keep edits on the same completed request'); cleanStage(f);
});

test('edits made after confirmation are overwritten from the selected distribution', async t => {
 const f = skillWriterFixture(t), request = f.request();
 await f.writer.install(f.request());
 f.put('alpacawork', 'local edit after request was prepared');
 await f.writer.install(request);
 assert.equal(f.read(), readFileSync(join(f.release, 'skills/alpacawork/SKILL.md'), 'utf8')); cleanStage(f);
});

for (const config of ['.claude']) test(`placed skills are linked from ~/${config}/skills and removed skills unlinked; a HOME without ~/${config} gets none`, async t => {
 const f = skillWriterFixture(t), home = join(f.root, '../..'), linked = join(home, config, 'skills');
 await f.writer.install(f.request());
 assert.equal(fs.existsSync(join(home, config)), false);
 // The person's own copy at an add-on's path is never replaced or removed.
 mkdirSync(join(linked, 'alpacawork-majority'), { recursive: true }); writeFileSync(join(linked, 'alpacawork-majority/SKILL.md'), 'my own copy');
 const all = f.request({ place: ['alpacawork', 'alpacawork-betterquality', 'alpacawork-majority'], remove: [] });
 await f.writer.install(all);
 for (const name of ['alpacawork', 'alpacawork-betterquality']) {
  assert.equal(fs.readlinkSync(join(linked, name)), join(f.root, name));
  assert.equal(readFileSync(join(linked, name, 'SKILL.md'), 'utf8'), `# ${name}\n`);
 }
 assert.equal(readFileSync(join(linked, 'alpacawork-majority/SKILL.md'), 'utf8'), 'my own copy');
 // A completed replay writes no bytes and still restores a missing link.
 fs.unlinkSync(join(linked, 'alpacawork')); await f.writer.install(all);
 assert.equal(fs.readlinkSync(join(linked, 'alpacawork')), join(f.root, 'alpacawork'));
 await f.writer.install(f.request({ place: ['alpacawork'], remove: ['alpacawork-betterquality', 'alpacawork-majority'] }));
 assert.deepEqual(readdirSync(linked).sort(), ['alpacawork', 'alpacawork-majority']);
 assert.equal(fs.lstatSync(join(linked, 'alpacawork-majority')).isDirectory(), true);
 assert.equal(readFileSync(join(linked, 'alpacawork-majority/SKILL.md'), 'utf8'), 'my own copy'); cleanStage(f);
});

test('a writer told that setup found an agent command creates that agent\'s skills folder', async t => {
 const f = skillWriterFixture(t), home = join(f.root, '../..');
 await new ManagedSkillsWriter({ root: f.root, detected: ['claude'] }).install(f.request());
 assert.equal(fs.readlinkSync(join(home, '.claude/skills/alpacawork')), join(f.root, 'alpacawork'));
});

test('an agent skills folder that cannot hold the link keeps the installation unfinished until it is fixed', async t => {
 const f = skillWriterFixture(t), home = join(f.root, '../..'), blocked = join(home, '.claude/skills');
 mkdirSync(join(home, '.claude'), { recursive: true }); writeFileSync(blocked, 'not a folder');
 const request = f.request();
 await assert.rejects(f.writer.install(request), e => e instanceof SkillWriteFailure && causeMessages(e).includes('EEXIST'));
 assert.equal(f.store().read()!.receipt.state, 'installing'); assert.equal(readFileSync(blocked, 'utf8'), 'not a folder');
 fs.rmSync(blocked); assert.equal((await f.writer.install(request)).kind, 'committed');
 assert.equal(fs.readlinkSync(join(blocked, 'alpacawork')), join(f.root, 'alpacawork'));
});
