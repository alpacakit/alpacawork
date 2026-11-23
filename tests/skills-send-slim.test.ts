import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { ControlStore } from '@alpacawork/db';
import { Problem } from '@alpacawork/core';
import { InstalledSkillsStore, managedSkillsRoot } from '@alpacawork/core/installed-skills';
import { coordinatorMessageInputSchema } from '@alpacawork/contract/coordinator';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { assertManagedSkillsVersion } from '@alpacawork/backend/test-dist/coordinator/managed-skills-version.js';
import { skillsUpdateCommand } from '@alpacawork/backend/test-dist/installation/skills-update-command.js';
import { main as updateSkills } from '@alpacawork/backend/test-dist/installation/skills-update.js';
import type { SkillWriteRequest } from '@alpacawork/backend/test-dist/installation/skills.js';
import { installed } from './helpers/managed-skills-fixture.ts';
import { callerWorkspace, NO_AGENT_CONFIG } from './coordinator-caller.fixture.ts';

test('skill invocations must match the first admission even when the client retries an earlier message', async t => {
  const w = callerWorkspace(t), url = await w.start();
  const owner = new CoordinatorConversation(w.root), conversationId = owner.read().id;
  const post = (input: { id: string; text: string }) => fetch(new URL('/api/coordinator/messages', url), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, conversationId, attachments: [], skills: ['demo-skill'] }),
  });
  const accepted = { id: randomUUID(), text: '/demo-skill keep my words' };
  const first = await post(accepted);
  assert.equal(first.status, 200, await first.text());

  const config = parse(NO_AGENT_CONFIG);
  config.agents['codex-team'] = config.agents.codex;
  config.coordinatorAiStack = [{ agent: 'codex-team', values: {} }];
  writeFileSync(join(w.root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
  assert.equal(owner.read().nextLaunch?.agent, 'codex-team');

  const retry = { id: randomUUID(), text: accepted.text };
  for (const text of [retry.text, `$demo-skill-extra ${retry.text}`]) {
    const refusal = await post({ ...retry, text });
    assert.equal(refusal.status, 409);
    assert.deepEqual((await refusal.json()).error.reason, { kind: 'coordinator_ai_changed' });
    assert.ok(!owner.read().turns.some(turn => turn.id === retry.id));
  }

  const replay = await post(accepted);
  assert.equal(replay.status, 200, await replay.text());
  const corrected = await post({ ...retry, text: '$demo-skill keep my words' });
  assert.equal(corrected.status, 200, await corrected.text());
  const store = new ControlStore(w.root, { busyTimeoutMs: 1000 }, true);
  try {
    const count = (id: string) => store.read(db => db.prepare('SELECT count(*) AS n FROM runs WHERE request_id = ?').get(id)!.n);
    assert.equal(count(accepted.id), 1);
    assert.equal(count(retry.id), 1);
  } finally { store.close(); }
});

test('version refusal has no admission effects; local v2 update then explicit send admits once; replay stays idempotent', async t => {
  const f = mkdtempSync(join(tmpdir(), 'skills-send-slim-'));
  t.after(() => rmSync(f, { recursive: true, force: true }));
  const skill = await installed(f, ['alpacawork']);
  const priorHome = process.env.HOME; process.env.HOME = skill.home;
  t.after(() => { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; });
  const w = callerWorkspace(t), owner = new CoordinatorConversation(w.root), conversation = owner.read();
  const input = coordinatorMessageInputSchema.parse({ conversationId: conversation.id, id: randomUUID(), text: '/alpacawork keep my words',
    skills: ['alpacawork'], attachments: [] });
  const counts = () => {
    const db = new ControlStore(w.root, { busyTimeoutMs: 1000 }, true);
    try { return db.read(db => ['requests', 'runs', 'tasks', 'task_log'].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n)); }
    finally { db.close(); }
  };
  const before = counts();
  assert.throws(() => owner.ask(input), (error: unknown) => {
    assert.ok(error instanceof Problem); assert.equal(error.reason?.kind, 'managed_skills_version');
    assert.ok(error.message.includes(skillsUpdateCommand(packageVersion))); return true;
  });
  assert.deepEqual(counts(), before);
  // Unmanaged skills continue through ordinary admission, irrespective of the managed receipt's version.
  assert.doesNotThrow(() => owner.ask({ ...input, id: randomUUID(), text: '/my-local-skill keep my words', skills: ['my-local-skill'] }));
  const receiptFile = join(skill.skills, '.alpacawork/installed.json');
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  receipt.skills[0].source.version = packageVersion;
  const manifest = join(skill.release, 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: packageVersion }));
  const op = randomUUID(), calls: SkillWriteRequest[] = [];
  receipt.operationId = op;
  await updateSkills(['--operation-id', op], { release: skill.release, createWriter: ({ root }) => {
    assert.equal(root, skill.skills);
    return { install: async request => {
      calls.push(request); writeFileSync(receiptFile, JSON.stringify(receipt));
      return { kind: 'committed', operationId: request.operationId, receipt };
    } };
  } });
  assert.equal(calls.length, 1); assert.equal(calls[0]!.version, 2); assert.equal(calls[0]!.operationId, op);
  assert.equal(calls[0]!.release, skill.release);
  assert.deepEqual(calls[0]!.intent.place, ['alpacawork', 'alpacawork-betterquality']);
  assert.deepEqual(calls[0]!.intent.remove, []);
  const afterUpdate = counts(); assert.deepEqual(afterUpdate.map(Number), before.map((n, i) => Number(n) + (i < 2 ? 1 : 0)));
  // Editing installed content and unrelated source facts never causes compatibility rejection.
  writeFileSync(join(skill.skills, 'alpacawork/SKILL.md'), 'Edited local skill content');
  assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork'], skill.home, packageVersion));
  const accepted = owner.ask(input); assert.equal(accepted.turns.filter(turn => turn.id === input.id).length, 1);
  assert.deepEqual(counts().map(Number), afterUpdate.map((n, i) => Number(n) + (i < 2 ? 1 : 0)));
  receipt.skills[0].source.version = '9.0.0'; writeFileSync(receiptFile, JSON.stringify(receipt));
  assert.equal(owner.ask(input).turns.filter(turn => turn.id === input.id).length, 1);
  assert.deepEqual(counts().map(Number), afterUpdate.map((n, i) => Number(n) + (i < 2 ? 1 : 0)));
});

test('only skills the receipt records are version-checked; an incomplete receipt still refuses them', async t => {
  const f = mkdtempSync(join(tmpdir(), 'skills-send-missing-')); t.after(() => rmSync(f, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertManagedSkillsVersion(['custom'], f, '1.2.3'));
  // No receipt: a bundled skill placed by hand belongs to whoever placed it.
  assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork'], f, '1.2.3'));
  const skill = await installed(f, ['alpacawork']);
  // The receipt records alpacawork only: a hand-placed alpacawork-betterquality passes while alpacawork is checked.
  mkdirSync(join(skill.skills, 'alpacawork-betterquality'));
  writeFileSync(join(skill.skills, 'alpacawork-betterquality/SKILL.md'), 'Hand-placed skill');
  assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork-betterquality'], skill.home, '2.0.0'));
  assert.throws(() => assertManagedSkillsVersion(['alpacawork-betterquality', 'alpacawork'], skill.home, '2.0.0'), (error: unknown) =>
    error instanceof Problem && error.reason?.kind === 'managed_skills_version' && error.reason.skill === 'alpacawork' && error.reason.currentVersion === '1.2.3');
  await skill.store.session(session => { session.begin({ operationId: randomUUID(), place: ['alpacawork'], remove: [], release: skill.release }); });
  assert.throws(() => assertManagedSkillsVersion(['alpacawork'], skill.home, '1.2.3'), /alpacawork@1.2.3/);
  assert.throws(() => skillsUpdateCommand('1.0.0;echo bad'), /Invalid/);
});

test('version guidance propagates ordinary I/O faults and errors without relabelling them as missing', t => {
  const home = mkdtempSync(join(tmpdir(), 'skills-version-fault-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(managedSkillsRoot(home), { recursive: true, mode: 0o700 });
  const denied = Object.assign(new Error('synthetic permission fault'), { code: 'EACCES' });
  const io = Object.assign(new Error('synthetic I/O fault'), { code: 'EIO' });
  let fault: Error = denied;
  t.mock.method(InstalledSkillsStore.prototype, 'read', () => { throw fault; });
  for (const expected of [denied, io, new Error('read receipt', { cause: io }),
    new Error('read receipt', { cause: Object.assign(new Error('synthetic missing cause'), { code: 'ENOENT' }) })]) {
    fault = expected;
    assert.throws(() => assertManagedSkillsVersion(['alpacawork'], home, '1.2.3'), error => error === expected);
  }
});

test('without a receipt nothing is checked, while an unreadable receipt still refuses', t => {
  const home = mkdtempSync(join(tmpdir(), 'skills-source-send-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork'], home));
  assert.doesNotThrow(() => assertManagedSkillsVersion(['alpacawork'], home, '0.3.0'));
  const control = join(managedSkillsRoot(home), '.alpacawork');
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, 'installed.json'), '{broken');
  assert.throws(() => assertManagedSkillsVersion(['alpacawork'], home), (error: unknown) => error instanceof Error && error.message.includes(`alpacawork@${packageVersion}`));
});
