

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { publicSetupSuite } from './helpers/public-setup-fixture.ts';

const s = publicSetupSuite();
const { fixture, publicFixture, hash, evidence } = s;

// Each HOME mode and each workspace state is covered once; the setup flow does not depend on their combination.
for (const [existing, mode] of [[false, 0o775], [true, 0o750]] as const) test(`${existing ? 'existing' : 'new'} setup uses ordinary permissions with HOME ${mode.toString(8)} and preserves failed-start resume`, { skip: process.platform !== 'linux' && '/proc port range and a linux-x64-glibc fixture image' }, async t => {
  const f = publicFixture(t); chmodSync(f.home, mode);
  const port = await f.reserveServicePort();
  if (existing) s.copySetupWorkspace(join(f.home, 'alpacawork'));
  const config = join(f.home, '.config/alpacawork'); mkdirSync(config, { recursive: true, mode: 0o700 }); chmodSync(config, 0o775);
  mkdirSync(dirname(f.releases), { recursive: true, mode: 0o700 }); mkdirSync(f.releases, { mode: 0o775 }); chmodSync(f.releases, 0o775);
  const acl = process.env.PUBLIC_SETUP_PERMISSION_ACL === '1';
  const aclText = () => { const out = spawnSync('/usr/bin/getfacl', ['-cpn', f.releases], { encoding: 'utf8' }); assert.equal(out.status, 0, out.stderr); return out.stdout; };
  if (acl) { const out = spawnSync('/usr/bin/setfacl', ['-m', 'u:65534:rwx', f.releases], { encoding: 'utf8' }); assert.equal(out.status, 0, out.stderr); }
  const beforeAcl = acl ? aclText() : null;
  const cancelled = await f.run('cancel', ['setup']); assert.equal(cancelled.status, 0); assert.equal(lstatSync(f.releases).mode & 0o777, 0o775);
  assert.equal(lstatSync(config).mode & 0o777, 0o775); assert.deepEqual(readdirSync(config), []);
  if (acl) assert.equal(aclText(), beforeAcl, 'cancellation preserves actual ACL too');
  assert.doesNotMatch(cancelled.transcript, /chmod|remove group\/other write/);
  writeFileSync(join(f.home, 'fail-start'), ''); const failed = await f.run('enter', ['setup']); assert.notEqual(failed.status, 0);
  assert.equal(lstatSync(f.releases).mode & 0o777, 0o775); assert.equal(lstatSync(f.home).mode & 0o777, mode);
  assert.equal(lstatSync(config).mode & 0o777, 0o775);
  const afterAcl = acl ? aclText() : null;
  if (acl) assert.equal(afterAcl, beforeAcl);
  evidence({ kind: 'permission-acl-mask', homeMode: mode.toString(8), beforeAcl, afterAcl });
  const recordPath = join(f.home, '.config/alpacawork/installation.json'), record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.service.port, port);
  const operationId = f.journal().request.operationId;
  rmSync(join(f.home, 'fail-start')); const resumed = await f.run('enter', ['setup']); await f.ready(resumed);
  assert.equal(f.receipt().operationId, operationId);
  const repeated = await f.run('enter', ['setup']); await f.ready(repeated);
  assert.equal(repeated.payload!.url, resumed.payload!.url); assert.equal(resumed.payload!.port, record.service.port);
  assert.notEqual(f.receipt().operationId, operationId, 'completed setup starts a new request');
  assert.deepEqual(JSON.parse(readFileSync(recordPath, 'utf8')).service, record.service);
  assert.equal(lstatSync(recordPath).mode & 0o777, 0o600);
  evidence({ kind: 'ordinary-directory-permissions', homeMode: mode.toString(8), releasesMode: (lstatSync(f.releases).mode & 0o777).toString(8), configMode: (lstatSync(config).mode & 0o777).toString(8), recordMode: (lstatSync(recordPath).mode & 0o777).toString(8), operationId, url: resumed.payload!.url, status: 200 });
});
