

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawnSync } from 'node:child_process';

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { pathToFileURL } from 'node:url';

import { copyWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { isolatedServe } from './helpers/http-cli.ts';
import { installationTerminal } from './helpers/installation-terminal.ts';
import { publishRelease } from '@alpacawork/backend/test-dist/release/build.js';

import { publicSetupSuite } from './helpers/public-setup-fixture.ts';

const s = publicSetupSuite();
const { fixture, publicFixture, hash, evidence } = s;

test('new setup publishes before initialization, registers releases, and reuses the same release without reinitializing', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = fixture(t); const preview = s.owner.inspectSetup(f.request);
  assert.equal(preview.existing, false); assert.equal(existsSync(f.releases), false);
  const lines: string[] = [];
  const made = await s.owner.prepareSetup(f.request, s.owner.inspectSetup(f.request), line => lines.push(line)); made.unlock();
  assert.match(lines[0], /Importing installed application into .*\.stage-.*temporary stage:/);
  assert.equal(made.installation.releases, realpathSync(f.releases)); assert.equal(made.installation.workspace, join(f.home, 'alpacawork'));
  const database = join(made.installation.workspace, '.alpacawork/alpacawork.sqlite'), before = hash(database);
  const imageBefore = hash(join(made.release, 'DISTRIBUTION.json'));
  const again = await s.owner.prepareSetup(f.request, s.owner.inspectSetup(f.request), () => {}); again.unlock();
  assert.equal(again.release, made.release); assert.equal(hash(database), before); assert.equal(hash(join(made.release, 'DISTRIBUTION.json')), imageBefore);
  assert.deepEqual(readdirSync(f.releases).filter(name => name.startsWith('.stage-')), []);
  assert.equal(existsSync(join(f.releases, 'current')), false, 'preparation cannot claim service startup or complete setup');
});

test('explicit existing synthetic workspace is registered with DB and ordinary files intact', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = fixture(t), workspace = join(f.root, 'explicit-data'); copyWorkspace(s.original, workspace);
  writeFileSync(join(workspace, 'keep.txt'), 'keep this'); const db = join(workspace, '.alpacawork/alpacawork.sqlite'), before = hash(db);
  const request = { ...f.request, explicit: workspace, releases: join(workspace, 'releases') }; assert.equal(s.owner.inspectSetup(request).existing, true);
  const made = await s.owner.prepareSetup(request, s.owner.inspectSetup(request), () => {}); made.unlock();
  assert.equal(made.installation.workspace, workspace); assert.equal(hash(db), before); assert.equal(readFileSync(join(workspace, 'keep.txt'), 'utf8'), 'keep this');
});

test('refusing a live manual workspace preserves its real HTTP serve and never reaches the service manager', async t => {
  const f = fixture(t), workspace = join(f.root, 'live-data'); copyWorkspace(s.original, workspace);
  // prepareSetup runs in the unit library, whose declared core resolves to this checkout's same instance.
  const core = await import('@alpacawork/core');
  const previous = core.platform.service;
  const forbidden = () => { throw new Error('Preparation must not operate the service manager'); };
  core.platform.service = { observe: forbidden, register: forbidden, unregister: forbidden, known: forbidden, stop: forbidden, start: forbidden, restart: forbidden, restarts: forbidden };
  const live = await isolatedServe(workspace, undefined, f.env);
  try {
    const before = await fetch(new URL('/api/runtime/readiness', live.url)); assert.equal(before.status, 200);
    const beforeBody = await before.json();
    const request = { ...f.request, explicit: workspace };
    await assert.rejects(s.owner.prepareSetup(request, s.owner.inspectSetup(request), () => {}), /is used by a running server.*Choose another --workspace/);
    const after = await fetch(new URL('/api/runtime/readiness', live.url)); assert.equal(after.status, 200);
    const afterBody = await after.json(); assert.equal(afterBody.generation, beforeBody.generation); assert.equal(afterBody.workspace, workspace);
    assert.equal(live.child.exitCode, null); assert.equal(existsSync(join(f.releases, 'current')), false);
  } finally { await live.stop(); core.platform.service = previous; }
});

test('broken same-name release is preserved and cannot initialize or register a new workspace', async t => {
  const f = fixture(t), plan = s.owner.inspectSetup(f.request), bad = join(f.releases, plan.facts.source);
  mkdirSync(bad, { recursive: true }); writeFileSync(join(bad, 'keep'), 'incomplete release');
  await assert.rejects(s.owner.prepareSetup(f.request, s.owner.inspectSetup(f.request), () => {}), /did not complete/);
  assert.equal(readFileSync(join(bad, 'keep'), 'utf8'), 'incomplete release'); assert.equal(existsSync(plan.workspace), false);
  assert.equal(existsSync(join(f.home, '.config/alpacawork/installation.json')), false);
});

test('packaged launcher transports setup arguments and refuses non-terminal input without changing HOME', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, t => {
  const f = fixture(t), workspace = join(f.root, 'existing'); mkdirSync(workspace); writeFileSync(join(workspace, 'keep'), 'untouched');
  for (const args of [['setup'], ['setup', '--workspace', workspace], ['--workspace', workspace, 'setup'], [`--workspace=${workspace}`, 'setup'], ['setup', `--workspace=${workspace}`, '--releases', join(f.root, 'custom releases')]]) {
    const out = spawnSync(process.execPath, [join(s.image, 'bin/alpacawork.mjs'), ...args], { cwd: f.root, env: f.env, encoding: 'utf8', timeout: 15_000, input: '\n' });
    assert.ifError(out.error); assert.notEqual(out.status, 0); assert.match(out.stderr + out.stdout, /Run setup from a terminal/);
    assert(!/ready|https?:\/\//.test(out.stdout)); assert.deepEqual(readdirSync(f.home), []);
  }
  assert.equal(readFileSync(join(workspace, 'keep'), 'utf8'), 'untouched');
});

test('setup yes aliases preserve sudo and agent Run refusals without changing HOME', t => {
  const f = fixture(t);
  for (const flag of ['-y', '--yes']) for (const denied of [
    { SUDO_USER: 'synthetic-user' }, { SUDO_UID: '1000' },
    { ALPACAWORK_RUN: 'Rsynthetic' }, { ALPACAWORK_RUN_TOKEN: 'synthetic-token' },
  ]) {
    const out = spawnSync(process.execPath, [join(s.image, 'bin/alpacawork.mjs'), 'setup', flag], {
      cwd: f.root, env: { ...f.env, ...denied }, encoding: 'utf8', timeout: 15_000,
    });
    assert.ifError(out.error); assert.notEqual(out.status, 0);
    assert.match(out.stderr, 'SUDO_USER' in denied || 'SUDO_UID' in denied ? /without sudo/ : /not from an agent Run/);
    assert.deepEqual(readdirSync(f.home), []);
  }
});

test('changed selection after confirmation stops before publishing or initializing', async t => {
  const f = fixture(t), approved = s.owner.inspectSetup(f.request);
  await assert.rejects(s.owner.prepareSetup({ ...f.request, releases: join(f.root, 'different-releases') }, approved, () => {}), /selection changed/);
  assert.equal(existsSync(f.releases), false); assert.equal(existsSync(approved.workspace), false);
});

test('manual serve refusal offers another workspace before intentional conversion', () => {
  assert.match(s.owner.setupFailureAdvice(new Error('Another serve writer owns this workspace')), /Choose another --workspace/);
  assert.equal(s.owner.setupFailureAdvice(new Error('ordinary failure')), 'ordinary failure');
});

test('new workspace rejects releases at itself or below before writing', async t => {
  for (const existingEmpty of [false, true]) for (const nested of [false, true]) {
    const f = fixture(t), workspace = join(f.root, 'new-data');
    if (existingEmpty) mkdirSync(workspace);
    const request = { ...f.request, explicit: workspace, releases: nested ? join(workspace, 'releases') : workspace };
    assert.throws(() => s.owner.inspectSetup(request), /separate releases folder outside the new workspace/);
    assert.deepEqual(existsSync(workspace) ? readdirSync(workspace) : [], []);
    assert.equal(existsSync(join(f.home, '.config')), false);
    assert.equal(existsSync(request.releases) && nested, false);
  }
});

test('workspace path prefix siblings remain usable and the inspected state reaches confirmation', { skip: process.platform !== 'linux' && 'runs a linux-x64-glibc fixture image (Koffi native)' }, async t => {
  const f = fixture(t), workspace = join(f.root, 'foo');
  const request = { ...f.request, explicit: workspace, releases: join(f.root, 'foobar') };
  const observations = { service: 'User service (observed separately)', agents: ['codex'], skills: [] };
  for (const existing of [false, true]) {
    const plan = s.owner.inspectSetup(request); assert.equal(plan.existing, existing);
    for (const lang of ['ja', 'en']) {
      const terminal = installationTerminal('\r'); terminal.value.env = { LANG: lang };
      const approval = await s.owner.confirmSetup(plan, observations, terminal.value);
      assert.equal(approval.approved, true);
      if (!approval.approved) throw new Error('Expected terminal approval');
      assert.equal(approval.request.existing, existing); assert.equal(approval.request.workspace, workspace);
      assert(terminal.shown().includes(workspace));
    }
    if (!existing) { const prepared = await s.owner.prepareSetup(request, plan, () => {}); prepared.unlock(); }
  }
});

test('nonempty setup paths give setup advice and recorded releases conflicts show the exact recorded path', async t => {
  const f = fixture(t), workspace = join(f.root, 'occupied'); mkdirSync(workspace); writeFileSync(join(workspace, 'keep'), 'keep');
  assert.throws(() => s.owner.inspectSetup({ ...f.request, explicit: workspace }), /Choose an empty folder.*setup again/);
  assert.equal(readFileSync(join(workspace, 'keep'), 'utf8'), 'keep'); assert.equal(existsSync(f.releases), false);
  // Register an existing synthetic DB without importing another distribution for this read-only conflict check.
  const existing = join(f.root, 'existing'); copyWorkspace(s.original, existing); mkdirSync(f.releases, { recursive: true });
  const installation = await import(pathToFileURL(join(s.library,'installation/setup.js')).href);
  await installation.registerInstallation({ ...f.request, explicit: existing }, f.releases);
  assert.throws(() => s.owner.inspectSetup({ ...f.request, releases: join(f.root, 'wrong-releases') }), error => {
    assert(error instanceof Error); assert(error.message.includes(`recorded releases ${f.releases}`)); return true;
  });
});

test('mkdir and release-lock failures lead with a concrete action and keep the original reason', async t => {
  const f = fixture(t), parent = join(f.root, 'readonly'); mkdirSync(parent); chmodSync(parent, 0o500);
  const request = { ...f.request, releases: join(parent, 'releases') }, plan = s.owner.inspectSetup(request);
  try {
    await assert.rejects(s.owner.prepareSetup(request, plan, () => {}), error => {
      assert(error instanceof Error); assert.match(error.message, /^Check write permission/); assert.match(error.message, /Reason: .*EACCES/); assert(error.cause); return true;
    });
  } finally { chmodSync(parent, 0o700); }
  assert.equal(existsSync(plan.workspace), false);
  mkdirSync(f.releases, { recursive: true });
  const layout = await import(pathToFileURL(join(s.library,'release/layout.js')).href), release = layout.holdReleases(f.releases);
  try {
    const request = { ...f.request, releases: f.releases };
    await assert.rejects(s.owner.prepareSetup(request, s.owner.inspectSetup(request), () => {}), error => {
      assert(error instanceof Error); assert.match(error.message, /^Wait for the release operation/); assert.match(error.message, /Reason: Another release operation/); return true;
    });
  } finally { release(); }
});

test('publication failure removes only its own known stage and leaves unrelated interrupted stages', async t => {
  const f = fixture(t); mkdirSync(f.releases, { recursive: true }); const unknown = join(f.releases, '.stage-unknown'); mkdirSync(unknown); writeFileSync(join(unknown, 'keep'), 'keep');
  const plan = s.owner.inspectSetup(f.request); let known: string;
  await assert.rejects(publishRelease(f.releases, { source: plan.facts.source, edition: plan.facts.edition, targets: plan.facts.targets }, () => {}, async stage => {
    known = stage; throw new Error('controlled producer fault');
  }), /controlled producer fault/);
  assert.equal(existsSync(known!), false); assert.equal(readFileSync(join(unknown, 'keep'), 'utf8'), 'keep');
});

test('live HOME protection rejects changed records skills definitions requests and releases', async t => {
  const f = fixture(t), paths = ['.config/alpacawork/installation.json', '.config/systemd/user/alpacawork.service', '.agents/skills/alpacawork/SKILL.md', '.local/share/alpacawork/releases/setup-skills.json', '.local/share/alpacawork/releases/immutable-code.js', 'alpacawork/.alpacawork/alpacawork.sqlite', 'alpacawork/.alpacawork/alpacawork.sqlite-wal'];
  for (const p of paths) { mkdirSync(dirname(join(f.home, p)), { recursive: true }); writeFileSync(join(f.home, p), 'before'); }
  const config = join(f.root, 'negative.json'), output = join(f.root, 'negative-result.json');
  const script = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; for (const path of process.argv.slice(2)) writeFileSync(join(process.argv[1],path),'changed'); console.log('Enter to start / Ctrl-C to cancel'); process.stdin.once('data',()=>process.stdin.pause());`;
  writeFileSync(config, JSON.stringify({ home: f.home, cwd: f.root, env: f.env, output, answer: 'enter', runtimeOwnedPaths: ['alpacawork/.alpacawork/host.sqlite-shm'], command: [process.execPath, '--input-type=module', '-e', script, f.home, ...paths] }));
  const out = spawnSync(process.execPath, [resolve('tests/helpers/setup-terminal.ts'), config], { encoding: 'utf8', env: f.env }); assert.equal(out.status, 0, out.stderr);
  const measured = JSON.parse(readFileSync(output, 'utf8')); assert.deepEqual(measured.protectedChanges.map((c: any) => c.path).sort(), paths.sort());
  assert.throws(() => assert.deepEqual(measured.protectedChanges, [])); evidence({ kind: 'negative-protected-boundary', paths, changes: measured.protectedChanges });
});

test('setup cannot normalize HOME or its parents as a supplied releases directory', async t => {
  const f = fixture(t); chmodSync(f.home, 0o775);
  for (const releases of [f.home, f.root]) assert.throws(() => s.owner.inspectSetup({ ...f.request, releases }), /separate from HOME/);
  assert.equal(lstatSync(f.home).mode & 0o777, 0o775); assert.deepEqual(readdirSync(f.home), []);
});
