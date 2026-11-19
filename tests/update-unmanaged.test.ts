/** Source releases have no setup record. Exercise the real update Owners without registry/service mocks. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { releaseFixture } from './helpers/release-fixture.ts';
import { backendUnitLibrary } from './helpers/backend-unit-library.ts';
import { createOriginal, copyWorkspace, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';

test('unmanaged source startup/status/discovery are quiet while explicit updates and damaged records remain explicit', { timeout: 45_000 }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'update-source-'))), home = join(root, 'home'), workspace = join(root, 'workspace');
  mkdirSync(home, { mode: 0o700 });
  const source = createOriginal({ tasks: 14, logs: 19, runs: 7, seed: 'update-source' }, join(root, 'cache')).root;
  copyWorkspace(source, workspace);
  t.after(() => { removeWorkspace(workspace); removeWorkspace(source); rmSync(root, { recursive: true, force: true }); });
  const image = releaseFixture(root).image, output = backendUnitLibrary(resolve('.'), join(root, 'library'), image);
  const script = `
    import assert from 'node:assert/strict';
    import {existsSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
    import {dirname,join} from 'node:path';
    import {pathToFileURL} from 'node:url';
    const load=p=>import(pathToFileURL(join(${JSON.stringify(output)},p)).href),workspace=${JSON.stringify(workspace)};
    const runtime=await load('release/update-runtime.js'),status=await load('release/update-status.js');
    const controller=await load('release/update-controller.js'),discovery=await load('release/update-discovery.js');
    const operation=await load('release/update-operation.js');
    const installation=await load('installation/store.js');
    const path=installation.installationPath(process.env);
    assert.equal(runtime.updateRuntime(workspace),null);
    assert.deepEqual(status.updateStatus(workspace),{kind:'none'});
    await controller.resumeKnownUpdates(workspace);
    let network=0;globalThis.fetch=()=>{network++;throw new Error('Unexpected registry request');};
    const errors=[],stop=discovery.monitorUpdates(workspace,e=>errors.push(String(e)));
    await new Promise(setImmediate);await stop();assert.equal(network,0);assert.deepEqual(errors,[]);
    assert.throws(()=>runtime.resolveUpdateRuntime(workspace),/deploy <from>/);
    await assert.rejects(operation.confirmUpdate(workspace,{opId:'x',candidateId:'x',reviewDigest:'x'}),/deploy <from>/);
    assert.equal(existsSync(path),false);assert.equal(existsSync(join(process.env.HOME,'.agents')),false);
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,'{broken');
    assert.throws(()=>runtime.updateRuntime(workspace),/installation/i);
    assert.equal(status.updateStatus(workspace).kind,'attention');
    await assert.rejects(controller.resumeKnownUpdates(workspace));
    rmSync(path);
    process.env.ALPACAWORK_MANAGED_RELEASES=${JSON.stringify(join(image, '..'))};
    assert.throws(()=>runtime.updateRuntime(workspace),/does not match the installation record/);delete process.env.ALPACAWORK_MANAGED_RELEASES;
    const state=join(${JSON.stringify(image)},'..','.updates','state.json');mkdirSync(dirname(state),{recursive:true});
    writeFileSync(state,JSON.stringify({version:2,operation:{unknown:true},offer:null,lastResult:null}));
    assert.throws(()=>runtime.updateRuntime(workspace));
    assert.equal(status.updateStatus(workspace).kind,'attention');
    const manifest=JSON.parse((await import('node:fs')).readFileSync(${JSON.stringify(resolve('tests/fixtures/npm-candidate-manifest.json'))},'utf8'));
    const candidate={version:1,candidateId:'known',registryOrigin:'http://127.0.0.1:9',packageName:manifest.name,exactVersion:manifest.version,
      tarball:'http://127.0.0.1:9/a.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64'),metadataDigest:'a'.repeat(64),
      edition:'production',facts:manifest.alpacawork,engines:manifest.engines,environment:{managedNodeVersion:process.version,target:'linux-x64-glibc',edition:'production'},
      expectedActive:${JSON.stringify(image)},changes:'unknown'};
    writeFileSync(state,JSON.stringify({version:3,offer:null,lastResult:null,operation:{opId:'known',workspace,candidate,reviewDigest:'a'.repeat(64),
      skills:{root:join(process.env.HOME,'.agents/skills'),place:['alpacawork']},phase:'fetching',controller:null,failure:null}}));
    assert.throws(()=>runtime.updateRuntime(workspace),/does not match the installation record/,'known valid operation cannot become an unmanaged installation');
    rmSync(state);
    const journal=await load('release/journal.js');
    journal.saveJournal({releases:${JSON.stringify(join(image,'..'))},workspace},{version:4,opId:'aborted-without-skills',workspace,
      old:${JSON.stringify(image)},target:${JSON.stringify(image)},previous:null,phase:'aborted',schema:null,skillsWriteStarted:false});
    assert.throws(()=>runtime.updateRuntime(workspace),/does not match the installation record/,'a journal still proves management before skills start');
    console.log(JSON.stringify({unmanaged:true,noNetwork:true,brokenRecordProtected:true,managedAbsenceProtected:true,unknownOperationProtected:true}));
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
  const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', script], { timeout: 30_000, encoding: 'utf8',
    env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), COREPACK_ENABLE_NETWORK: '0' } });
  assert.equal(JSON.parse(stdout.trim()).unmanaged, true);
});
