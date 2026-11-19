import { backendUnitLibrary } from './backend-unit-library.ts';
import type { UpdateRuntime } from '../../apps/backend/src/release/update-runtime.ts';
import { prepareUpdateFixtureRuntime, writeUpdateServiceAdapter, stopUpdateFixtureProcesses } from './update-service.ts';
/** Dedicated synthetic managed installation with the actual emitted backend. No scope override. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { preserveTestFailure } from './failure-workspace.ts';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, lstatSync,
  writeFileSync, symlinkSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platform } from '@alpacawork/core';
import { randomUUID } from 'node:crypto';
import { createOriginal, copyWorkspace, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';
import { assembleFixtureDistribution,fixtureSource } from './distribution-fixture.ts';

export async function managedUpdateFixture(t: TestContext, options:{prepare?:(built:string)=>void; repo?:string}={}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'managed-update-'))), repo = options.repo ?? resolve('.');
  const sha = fixtureSource(repo);
  const built = join(root, 'build'), releases = join(root, 'releases'), release = join(releases, sha), workspace = join(root, 'workspace'), home = join(root, 'home');
  mkdirSync(built); mkdirSync(releases); mkdirSync(home, { mode: 0o700 });
  const source = createOriginal({ tasks: 14, logs: 19, runs: 7, seed: 'managed-update' }, join(root, 'fixture-cache')).root;
  copyWorkspace(source, workspace);
  writeFileSync(join(workspace,'config.yaml'),readFileSync(join(workspace,'config.yaml'),'utf8')+'limits:\n  automatic_per_placement: 0\n');
  const cleanup: (() => unknown)[] = [];
  t.after(async () => {
    try { await preserveTestFailure(t, workspace); }
    finally { for (const stop of cleanup.reverse()) await stop(); removeWorkspace(workspace); removeWorkspace(source); rmSync(root, { recursive: true, force: true }); }
  });
  const { ordinaryFiles, internalLinks } = assembleFixtureDistribution(repo,built,release,sha,built=>{prepareUpdateFixtureRuntime(built,root);options.prepare?.(built);});
  symlinkSync(sha, join(releases, 'current'));
  const journal = { version: 4, skillsWriteStarted: false, opId: randomUUID(), workspace, old: null as string | null, target: release, previous: null,
    phase: 'committed', schema: 16 };
  const saveJournal = () => writeFileSync(join(releases, 'switch.json'), JSON.stringify(journal), { mode: 0o600 }); saveJournal();
  const writer={root:join(home,'.agents/skills')},skills=writer.root,control=join(skills,'.alpacawork');
  const installationEnvironment={HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share'),XDG_STATE_HOME:join(home,'.local/state'),XDG_CACHE_HOME:join(home,'.cache'),PATH:dirname(process.execPath)+':/usr/bin:/bin'};
  const library=join(root,'unit-library'),output=backendUnitLibrary(repo,library,release);
  const setup=await import(pathToFileURL(join(output,'installation/setup.js')).href);
  await setup.registerInstallation({cwd:root,env:installationEnvironment,explicit:workspace},releases);
  const definition=await setup.inspectInstallationService(releases,workspace,installationEnvironment,'synthetic-update.service');
  await setup.recordInstallationService(releases,workspace,definition,installationEnvironment);
  const sharedService=setup.readInstallationService({workspace,releases,env:installationEnvironment});assert.deepEqual(sharedService.definition,definition);assert(sharedService.port>0);
  function installReadFixture() {
    mkdirSync(control, { recursive: true, mode: 0o700 }); mkdirSync(join(skills, 'alpacawork'), { recursive: true, mode: 0o700 });
    writeFileSync(join(skills, 'alpacawork/SKILL.md'), '# synthetic selected skill\n', { mode: 0o600 });
    const receipt = { version: 2, state: 'complete', operationId: randomUUID(),
      request: { release, place: ['alpacawork'], remove: [] },
      skills: [{ name: 'alpacawork', source: { version: '1.0.0' } }] };
    writeFileSync(join(control, 'install.lock'), '', { mode: 0o600 });
    writeFileSync(join(control, 'installed.json'), JSON.stringify(receipt), { mode: 0o600 });
    return receipt;
  }
  installReadFixture();
  const adapter=writeUpdateServiceAdapter(root),runtimeFile=join(root,'update-runtime.json'),mockNpm=join(root,'unavailable-npm.mjs'),npmTemporary=join(root,'npm-tmp');mkdirSync(npmTemporary,{mode:0o700});
  writeFileSync(mockNpm,'process.exit(1);');
  const runtime:UpdateRuntime={place:{say:()=>{},releases,workspace,service:'synthetic-update.service'},registry:{nodeExecutable:process.execPath,npmCli:mockNpm,
   packageName:'alpacawork',selector:'latest',userConfig:join(root,'user.npmrc'),globalConfig:join(root,'global.npmrc'),homeDirectory:home,
   environment:{PATH:'/usr/bin:/bin',TMPDIR:npmTemporary},temporaryDirectory:npmTemporary,deadlineMs:5000},
   environment:{managedNodeVersion:process.version,edition:'production',target:'linux-x64-glibc'},
   writer};
  writeFileSync(runtime.registry.userConfig,'registry=http://127.0.0.1:9/\n');writeFileSync(runtime.registry.globalConfig,'');
  const configureUpdate=(patch:Partial<UpdateRuntime>&{failRestart?:string[];faults?:{enospc?:string[];killInstall?:string[];partialSkill?:string[]}})=>{Object.assign(runtime,patch);writeFileSync(runtimeFile,JSON.stringify({...runtime,installationEnvironment,definition}));};configureUpdate({});
  cleanup.push(()=>stopUpdateFixtureProcesses(root));
  copyFileSync(join(output,'release/update-runtime.js'),join(output,'release/update-runtime-owner.js'));
  writeFileSync(join(output,'release/update-runtime.js'),`import {readFileSync} from 'node:fs';import{updateRuntime as owner}from'./update-runtime-owner.js';export function updateRuntime(workspace){const f=JSON.parse(readFileSync(${JSON.stringify(runtimeFile)},'utf8'));const runtime=owner(workspace,f.installationEnvironment);return runtime?{...runtime,registry:f.registry}:null;}export function resolveUpdateRuntime(workspace){const runtime=updateRuntime(workspace);if(!runtime)throw new Error('Fixture requires managed update');return runtime;}`);
  const imageRuntime = await import(pathToFileURL(join(output, 'release/location.js')).href);
  assert.equal(imageRuntime.thisRelease(), release);
  const operation = await import(pathToFileURL(join(output, 'release/update-operation.js')).href) as typeof import('../../apps/backend/src/release/update-operation.ts');
  const candidate = await import(pathToFileURL(join(output, 'release/npm-candidate.js')).href) as typeof import('../../apps/backend/src/release/npm-candidate.ts');
  const records = await import(pathToFileURL(join(output, 'release/npm-records.js')).href) as typeof import('../../apps/backend/src/release/npm-records.ts');
  const processes: { pid: number; started: string; deadline: string; cwd:string; command:string; args:string[]; exitCode?: number | null; signal?: string | null; stopAudit?: unknown }[] = [];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ALPACAWORK_'))), ...installationEnvironment, ALPACAWORK_MANAGED_RELEASES:releases,NODE_OPTIONS:'--import='+adapter, ALPACAWORK_SERVER: process.env.ALPACAWORK_SERVER ?? 'http://127.0.0.1:9',
    ALPACAWORK_FAILURE_EVIDENCE_DIR: process.env.ALPACAWORK_FAILURE_EVIDENCE_DIR };
  let server: ChildProcess | undefined, url = '', serverLog = '';
  async function stop() {
    if (!server) return;
    const child = server; server = undefined;
    const record = processes.find(item => item.pid === child.pid)!;
    // Keep direct-child exit and pipe closure separate: an escaped pipe holder is not a service PID.
    const waitFor = async (event: 'exit' | 'close', ms: number) => {
      if (event === 'exit' && (child.exitCode !== null || child.signalCode !== null)) return true;
      if (event === 'close' && child.stdout?.closed && child.stderr?.closed) return true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try { await once(child, event, { signal: controller.signal }); return true; }
      catch (error) { if (!controller.signal.aborted) throw error; return false; }
      finally { clearTimeout(timer); }
    };
    if (child.exitCode === null && child.signalCode === null) {
      const started = platform.run.started(child.pid!);
      let ended = started === null;
      if (!ended) {
        assert.equal(started, record.started);
        if (process.platform === 'linux') {
          try {
            const cwd = realpathSync(`/proc/${child.pid}/cwd`); assert.equal(cwd, record.cwd);
            const fds = readdirSync(`/proc/${child.pid}/fd`).flatMap(name => {
              try { return [{ fd: name, path: realpathSync(`/proc/${child.pid}/fd/${name}`) }]; } catch { return []; }
            });
            record.stopAudit = { cwd, fds, maps: readFileSync(`/proc/${child.pid}/maps`, 'utf8') };
          } catch (error) {
            // A killed direct child can become a zombie before Node delivers its exit event.
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
            let state: string | undefined;
            try { state = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[0]; }
            catch (missing) {
              if (!(missing instanceof Error) || !('code' in missing) || missing.code !== 'ENOENT') throw missing;
              state = 'gone';
            }
            // Linux can remove cwd while the killed child is still crossing its exit state.
            // It remains our direct child with the checked incarnation; await its actual exit below.
            ended = state === 'Z' || state === 'X' || state === 'gone';
            record.stopAudit = { state, alreadyEnded: ended, cwdDisappeared: true };
          }
        }
      }
      if (!ended) child.kill('SIGTERM');
      if (!await waitFor('exit', 10000)) {
        assert.equal(platform.run.started(child.pid!), record.started, 'only the recorded service incarnation may be killed');
        child.kill('SIGKILL');
        assert.equal(await waitFor('exit', 5000), true, 'synthetic service did not exit after KILL');
      }
    }
    const pipesClosed = await waitFor('close', 250);
    record.stopAudit = { ...record.stopAudit as object, pipesClosed };
    if (!pipesClosed) {
      // Close only our read ends; this does not claim that a pipe descendant was terminated.
      child.stdout?.destroy(); child.stderr?.destroy();
    }
    record.exitCode = child.exitCode; record.signal = child.signalCode;
  }
  cleanup.push(stop);
  async function start(servingWorkspace = workspace, imports: string[] = []) {
    assert.equal(server, undefined);
    let previous: string | undefined;
    try { previous = JSON.parse(readFileSync(join(servingWorkspace, '.alpacawork/connection.json'), 'utf8')).generation; } catch {}
    url = '';
    const childEnv:NodeJS.ProcessEnv={...env},normal=servingWorkspace===workspace,cwd=normal?definition.workingDirectory:repo;
    if(!normal){delete childEnv.ALPACAWORK_MANAGED_RELEASES;childEnv.XDG_CONFIG_HOME=join(root,'manual-config');}
    const args=normal?definition.args:[join(release,'apps/backend/dist/backend.js'),'--workspace',servingWorkspace,'workspace','serve','--port','0'];
    server = spawn(normal?definition.executable:process.execPath, [...imports.flatMap(file => ['--import', file]), ...args],
      { env:childEnv,cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const child = server; child.stdout!.on('data', bytes => { serverLog += bytes; }); child.stderr!.on('data', bytes => { serverLog += bytes; });
    processes.push({ pid: child.pid!, started: platform.run.started(child.pid!) ?? 'unknown',cwd,
      command:normal?definition.executable:process.execPath,args:[...imports.flatMap(file=>['--import',file]),...args],
      deadline: new Date(Date.now() + 600000).toISOString() });
    const expiry = setTimeout(() => { if (platform.run.started(child.pid!) === processes.find(item => item.pid === child.pid)?.started) child.kill('SIGTERM'); }, 600000);
    child.once('exit', () => clearTimeout(expiry));
    // This is fixture startup, not an update latency assertion. Keep its real publication bounded under parallel suites.
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      assert.equal(child.exitCode, null, serverLog);
      try { const connection = JSON.parse(readFileSync(join(servingWorkspace, '.alpacawork/connection.json'), 'utf8'));
        if (connection.generation !== previous && connection.runManager === join(realpathSync(join(releases,'current')), 'apps/backend/dist/run-manager.js')) { url = connection.url; break; }
      } catch { /* Wait for this real backend's atomic connection publication. */ }
      await new Promise(done => setTimeout(done, 25));
    }
    assert.ok(url, serverLog);
  }
  async function call(path: string, input?: object, headers: Record<string, string> = {}) {
    const response = await fetch(new URL(path, url), { method: input ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers },
      ...(input && { body: JSON.stringify(input) }), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() as any,url:response.url };
  }
  /** Publication assertions require a quiescent acquisition, including a resend whose old failure is still visible. */
  async function awaitUpdateControllers(opId:string) {
    const trace=join(root,'spawn-requests.jsonl');
    const alive=(row:{childPid?:number;childStarted?:string|null})=>{
      if(!row.childPid||!row.childStarted||platform.run.started(row.childPid)!==row.childStarted)return false;
      if(process.platform!=='linux')return true;
      try{return !['Z','X'].includes(readFileSync('/proc/'+row.childPid+'/stat','utf8').split(') ')[1]!.split(' ')[0]!);}catch{return false;}
    };
    for(const end=Date.now()+10000;Date.now()<end;){
      const rows=existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.args.includes(opId)):[];
      if(!rows.some(alive))return;
      await new Promise(done=>setTimeout(done,20));
    }
    throw new Error('Synthetic acquisition controller did not finish for '+opId);
  }
  function image(path: string): Record<string, string> {
    const entries: Record<string, string> = {};
    const walk = (folder: string) => { for (const name of readdirSync(folder)) {
      const file = join(folder, name), info = lstatSync(file);
      entries[file.slice(path.length)] = [info.mode, info.dev, info.ino, info.nlink, info.size, info.mtimeMs,
        info.isFile() ? readFileSync(file).toString('base64') : 'directory'].join(':');
      if (info.isDirectory()) walk(file);
    } }; walk(path); return entries;
  }
  return { library, output, root, source, release, releases, workspace, home, skills, control, journal, saveJournal, operation, candidate, records,
    start, stop, call, image, processes, installReadFixture, cleanup, configureUpdate, runtimeFile, adapter, runtime,
    definition,port:sharedService.port,installationEnvironment,awaitUpdateControllers,evidence: () => ({ root, release, thisRelease: imageRuntime.thisRelease(), ordinaryFiles, internalLinks, processes, definition,serverLog }) };
}
