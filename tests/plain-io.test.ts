import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
/** Ordinary permissions, logical installation identity and concurrent immutable publication. Synthetic inputs only. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeInstallation, registerInstallation, inspectInstallationService, recordInstallationService, readInstallationService } from '@alpacawork/backend/test-dist/installation/setup.js';
import { InstallationStore, installationPath, workspaceIdentity } from '@alpacawork/backend/test-dist/installation/store.js';
import { cleanCliEnv } from './helpers/http-cli.ts';

for (const mode of [0o750, 0o775]) test(`umask 002 and HOME ${mode.toString(8)} accept existing product permissions and the same DB identity on a new inode`, async t => {
  const area = mkdtempSync(join(tmpdir(), 'plain-io-')), home = join(area, 'home');
  t.after(() => rmSync(area, { recursive: true, force: true }));
  mkdirSync(home, { mode }); chmodSync(home, mode);
  const env = cleanCliEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config') }); delete env.SUDO_USER; delete env.SUDO_UID;
  const store = new InstallationStore(installationPath(env)), request = { cwd: area, env, detectedAgents: [] };
  const umask = process.umask(0o002);
  try {
    const made = await initializeInstallation(request, store), root = made.root, id = workspaceIdentity(root);
    const releases = join(home, 'releases'); mkdirSync(releases, { mode: 0o775 }); chmodSync(releases, 0o775);
    chmodSync(root, 0o775); chmodSync(join(home, '.config/alpacawork'), 0o775);
    chmodSync(store.path, 0o664); chmodSync(join(home, '.config/alpacawork/installation.lock'), 0o664);
    const registered = await registerInstallation(request, releases, store);
    assert.equal(registered.workspaceIdentity, id); assert.equal(registered.version, 4);
    const definition = await inspectInstallationService(releases, root, env);
    await recordInstallationService(releases, root, definition, env);
    const original = join(area, 'original'); renameSync(root, original); cpSync(original, root, { recursive: true });
    assert.notEqual(statSync(root).ino, statSync(original).ino);
    assert.equal(readInstallationService({ workspace: root, releases, env }).installation.workspaceIdentity, id);
    assert.equal(statSync(home).mode & 0o777, mode); assert.equal(statSync(releases).mode & 0o777, 0o775);
    assert.equal(statSync(join(home, '.config/alpacawork')).mode & 0o777, 0o775);
    const saved = readFileSync(store.path), db = new DatabaseSync(join(root, '.alpacawork/alpacawork.sqlite'));
    try { db.prepare('UPDATE workspace_identity SET id=?').run(randomUUID()); } finally { db.close(); }
    assert.throws(() => readInstallationService({ workspace: root, releases, env }), /workspace identity changed/);
    assert.deepEqual(readFileSync(store.path), saved);
  } finally { process.umask(umask); }
});

test('simultaneous publishers keep one complete record and report every conflicting request', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plain-publication-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = `import {publishImmutable,ImmutableConflict} from '@alpacawork/core';
    const [root,value,start]=process.argv.slice(1);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Number(start)-Date.now())));
    try {publishImmutable(root,'same.json',value);console.log('saved');}
    catch(error){if(!(error instanceof ImmutableConflict))throw error;console.log('conflict');}`;
  const start = String(Date.now() + 1200);
  const completed = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, String(index).repeat(2048), start], { timeout: 10_000 });
    let output = '', errors = '';
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(errors)));
  })));
  const results = completed.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  assert.equal(results.filter(result => result === 'saved').length, 1);
  assert.equal(results.filter(result => result === 'conflict').length, 5);
  assert.match(readFileSync(join(root, 'same.json'), 'utf8'), /^([0-5])\1{2047}$/);
});
