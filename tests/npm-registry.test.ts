import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fetchNpmMetadata as fetchActual } from '../apps/backend/test-dist/release/npm-registry.js';
import type { NpmMetadataRequest, NpmMetadataResult } from '../apps/backend/src/release/npm-registry.ts';

// Optional bounded proof artifact for author/reviewer runs; no product logging path.
const evidence: unknown[] = [];
after(async () => {
  if (process.env.ALPACAWORK_NPM_ADAPTER_EVIDENCE) {
    await writeFile(process.env.ALPACAWORK_NPM_ADAPTER_EVIDENCE, JSON.stringify({
      node: process.version, npmCli, testPid: process.pid, events: evidence,
    }, null, 2));
  }
});
async function fetchNpmMetadata(request: NpmMetadataRequest): Promise<NpmMetadataResult> {
  const started = Date.now();
  const result = await fetchActual(request);
  evidence.push({ input: { packageName: request.packageName, selector: request.selector,
    deadlineMs: request.deadlineMs, fetchTimeoutMs: request.fetchTimeoutMs,
    maxStdoutBytes: request.maxStdoutBytes }, elapsedMs: Date.now() - started,
    result: result.ok ? { ...result, metadata: { name: result.metadata.name, version: result.metadata.version,
      alpacawork: result.metadata.alpacawork, futureField: result.metadata.futureField } } : result });
  return result;
}

const name = '@example-fixture/app';
const custom = { metadataVersion: 1, summary: ['synthetic'], schema: { fullHistory: ['fixture'] }, unknownFuture: { keep: true } };
const npmCli = process.env.ALPACAWORK_TEST_NPM_CLI ?? resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
const success = (result: NpmMetadataResult) => {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result;
};
function failure(result: NpmMetadataResult, kind?: string) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error('unreachable');
  if (kind) assert.equal(result.error.kind, kind);
  return result.error;
}

async function fixture(run: (f: {
  root: string; registryOrigin: string; request: NpmMetadataRequest;
  mode: (m: string) => void; requests: { url: string; accept?: string; authorization?: string }[];
  configure: (text: string) => Promise<void>;
  fake: (body: string) => Promise<NpmMetadataRequest>;
  checkClean: () => Promise<void>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'npm-adapter-test-'));
  let mode = 'normal';
  const requests: { url: string; accept?: string; authorization?: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests.push({ url: req.url!, accept: req.headers.accept, authorization: req.headers.authorization });
    if (mode === 'reset') { req.socket.destroy(); return; }
    if (mode === 'timeout') return;
    if (/^[45][0-9]{2}$/.test(mode)) {
      res.writeHead(Number(mode), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'synthetic secret TOKEN_SECRET /tmp/private.npmrc' })); return;
    }
    res.setHeader('content-type', 'application/json');
    if (mode === 'json') { res.end('{bad'); return; }
    const versions = Object.fromEntries(['1.0.0', '1.1.0'].map(version => [version, {
      name: mode === 'identity' ? 'other-package' : name,
      version: mode === 'version' ? 'bad-version' : version,
      alpacawork: custom, futureField: ['preserve', { nested: 42 }],
      description: mode === 'huge' ? 'x'.repeat(9 * 1024 * 1024) : 'synthetic fixture',
      dist: { tarball: 'https://invalid.example.test/never-fetch.tgz', integrity: 'sha512-synthetic' },
    }]));
    res.end(JSON.stringify({ name, _id: name, 'dist-tags': { latest: '1.1.0' }, versions }));
  });
  const lifetime = setTimeout(() => { server.closeAllConnections(); server.close(); }, 120000);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address === 'object');
    const registry = `http://127.0.0.1:${address.port}`;
    await mkdir(join(root, 'home'));
    await mkdir(join(root, 'temp'));
    await writeFile(join(root, '.npmrc'), '@example-fixture:registry=http://127.0.0.1:1/\n');
    await writeFile(join(root, 'global.npmrc'), '');
    const configure = (text: string) => writeFile(join(root, 'user.npmrc'), text);
    await configure(`registry=${registry}/\n`);
    const request: NpmMetadataRequest = {
      nodeExecutable: process.execPath, npmCli, packageName: name,
      selector: 'latest', userConfig: join(root, 'user.npmrc'), globalConfig: join(root, 'global.npmrc'),
      homeDirectory: join(root, 'home'), temporaryDirectory: join(root, 'temp'),
      environment: { PATH: '/usr/bin:/bin' },
      deadlineMs: 5000, fetchTimeoutMs: 600,
    };
    const checkClean = async () => assert.deepEqual(await readdir(join(root, 'temp')), []);
    const fake = async (body: string) => {
      const cli = join(root, 'fake-npm.cjs');
      // Real child process, including real error/exit/close and kernel PID lifecycle.
      await writeFile(cli, `setTimeout(()=>process.exit(124),10000).unref();const fs=require('node:fs');const args=process.argv.slice(2);
// Publish readiness only after every PID byte is complete, including when cancellation interrupts the writer.
const notifyPids=(path,pids)=>{const staged=path+'.'+process.pid+'.tmp';fs.writeFileSync(staged,JSON.stringify(pids));fs.renameSync(staged,path);};\n${body}`);
      return { ...request, npmCli: cli };
    };
    await run({ root, registryOrigin: registry, request, mode: m => { mode = m; }, requests, configure, fake, checkClean });
    await checkClean();
    evidence.push({ fixtureClosed: root, requests: requests.map(({ authorization, ...r }) => ({ ...r, authenticated: authorization !== undefined })), tempEntries: [] });
    assert.deepEqual(await readdir(join(root, 'home')), []);
  } finally {
    clearTimeout(lifetime);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test('npm registry: real bundled npm preserves full custom metadata and exact identity without tarball', async () => {
  await access(npmCli);
  await fixture(async ({ request, registryOrigin, requests, configure, checkClean }) => {
    const latest = success(await fetchNpmMetadata(request));
    assert.equal(latest.metadata.version, '1.1.0');
    assert.deepEqual(latest.metadata.alpacawork, custom);
    assert.deepEqual(latest.metadata.futureField, ['preserve', { nested: 42 }]);
    assert.equal(latest.identity.registryOrigin, registryOrigin);
    await checkClean();
    const exact = success(await fetchNpmMetadata({ ...request, selector: '1.0.0' }));
    assert.equal(exact.metadata.version, '1.0.0');
    // Scope routing and auth remain npm's responsibility; unrelated default origin is never contacted.
    await configure(`registry=http://127.0.0.1:1/\n@example-fixture:registry=${registryOrigin}/\n//127.0.0.1:${new URL(registryOrigin).port}/:_authToken=TOKEN_SECRET\n`);
    success(await fetchNpmMetadata(request));
    assert.equal(requests.at(-1)?.authorization, 'Bearer TOKEN_SECRET');
    assert.equal(requests.length, 3);
    assert(requests.every(r => !r.url.includes('tarball') && r.accept?.includes('application/json') && !r.accept.includes('install-v1')));
  });
});

test('npm registry: real HTTP failures, reset, timeout, invalid JSON and huge output cannot succeed', async t => {
  for (const mode of ['401', '404', '429', '500', '503', 'reset', 'timeout', 'json', 'huge']) {
    await t.test(mode, async () => fixture(async f => {
      f.mode(mode);
      const result = await fetchNpmMetadata(f.request);
      const error = failure(result);
      if (/^[45]/.test(mode)) assert.equal(error.httpStatus, Number(mode));
      if (mode === 'huge') assert.equal(error.kind, 'output_limit');
      assert.equal(f.requests.length, 1, 'retries must be zero');
      assert(!JSON.stringify(result).includes('TOKEN_SECRET'));
      assert(!JSON.stringify(result).includes('private.npmrc'));
    }));
  }
});

test('npm registry: success followed by disconnect never falls back to prior metadata', async () => fixture(async f => {
  success(await fetchNpmMetadata(f.request));
  await f.checkClean();
  const warm = join(f.root, 'warm-cache');
  await promisify(execFile)(process.execPath, [npmCli, 'view', name + '@latest', '--json',
    `--cache=${warm}`, `--registry=${f.registryOrigin}/`, `--@example-fixture:registry=${f.registryOrigin}/`, `--userconfig=${f.request.userConfig}`, `--globalconfig=${f.request.globalConfig}`,
    '--logs-max=0', '--update-notifier=false', '--fetch-retries=0', '--fetch-timeout=600'], {
      cwd: f.root, env: { HOME: f.request.homeDirectory, PATH: '/usr/bin:/bin' }, timeout: 5000,
    });
  assert((await readdir(warm)).includes('_cacache'));
  const beforeDisconnect = f.requests.length;
  evidence.push({ warmSeedRequests: beforeDisconnect - 1, cache: '_cacache present' });
  f.mode('reset');
  failure(await fetchNpmMetadata({ ...f.request, environment: { npm_config_cache: warm } }), 'process_failed');
  evidence.push({ disconnectRequests: f.requests.length - beforeDisconnect });
  assert.equal(f.requests.length, beforeDisconnect + 1);
}));

test('npm registry: rejects mismatching metadata identity from real npm', async () => fixture(async f => {
  f.mode('identity');
  failure(await fetchNpmMetadata(f.request), 'invalid_metadata');
  f.mode('version');
  failure(await fetchNpmMetadata(f.request), 'invalid_metadata');
}));

test('npm registry: rejects unsafe specs and origins before any request', async () => fixture(async f => {
  for (const packageName of ['file:/tmp/app', '../app', 'https://example.test/pkg', 'git+ssh://host/repo', '--registry=http://evil.test', 'a;touch sentinel', 'a$(touch sentinel)', 'a`touch sentinel`', '@scope/app@latest', '@scope/../app', 'a%2fb', 'a\nb', 'a\n', '.']) {
    failure(await fetchNpmMetadata({ ...f.request, packageName }), 'invalid_input');
  }
  for (const selector of ['*', '^1.0.0', 'v1.0.0', '1.0', '1.0.0;touch sentinel', '1.0.0-01', '1.0.0\n', '--json']) {
    failure(await fetchNpmMetadata({ ...f.request, selector }), 'invalid_input');
  }
  for (const registry of ['file:///tmp', 'ftp://127.0.0.1/', 'not a URL']) {
    await f.configure(`registry=${registry}\n`);
    failure(await fetchNpmMetadata(f.request), 'invalid_input');
  }
  failure(await fetchNpmMetadata({ ...f.request, nodeExecutable: 'node' }), 'invalid_input');
  failure(await fetchNpmMetadata({ ...f.request, npmCli: 'npm' }), 'invalid_input');
  assert.equal(f.requests.length, 0);
}));

test('npm registry: npmrc, environment, scoped and global settings route to the configured HTTP registry and preserve its path', async () => fixture(async f => {
  await f.configure('registry=http://127.0.0.1:1/\n');
  success(await fetchNpmMetadata({ ...f.request, environment: { npm_config_registry: f.registryOrigin + '/mirror/' } }));
  assert.equal(f.requests.at(-1)?.url, '/mirror/@example-fixture%2fapp');
  await f.configure(`registry=http://127.0.0.1:1/\n@example-fixture:registry=${f.registryOrigin}/scope/\n`);
  success(await fetchNpmMetadata({ ...f.request, environment: { npm_config_registry: 'http://127.0.0.1:1/' } }));
  assert.equal(f.requests.at(-1)?.url, '/scope/@example-fixture%2fapp');
  await f.configure('');
  await writeFile(f.request.globalConfig, `registry=${f.registryOrigin}/global/\n`);
  success(await fetchNpmMetadata(f.request));
  assert.equal(f.requests.at(-1)?.url, '/global/@example-fixture%2fapp');
}));

test('npm registry: no configured registry keeps npm public default without contacting it', async () => fixture(async f => {
  await f.configure('');
  const cli = await f.fake(`if(args.includes('config')) {
    const result=require('node:child_process').spawnSync(process.execPath,[${JSON.stringify(npmCli)},...args],{env:process.env,encoding:'utf8'});
    process.stdout.write(result.stdout);process.exit(result.status??1);
  } else {
    if(!args.includes('--registry=https://registry.npmjs.org/'))throw Error('wrong default');
    process.stdout.write(JSON.stringify({name:'@example-fixture/app',version:'1.0.0'}));
  }`);
  assert.equal(success(await fetchNpmMetadata(cli)).identity.registryOrigin, 'https://registry.npmjs.org');
  assert.equal(f.requests.length, 0);
}));

test('npm registry: spawn error, nonzero, JSON and identity faults have explicit outcomes', async () => fixture(async f => {
  failure(await fetchNpmMetadata({ ...f.request, nodeExecutable: join(f.root, 'missing-node') }), 'spawn_failed');
  for (const [body, kind] of [
    ['process.stdout.write("{bad");', 'invalid_json'],
    ['process.stdout.write("null");', 'invalid_metadata'],
    ['process.stdout.write(JSON.stringify({name:"@example-fixture/app",version:"2.0.0"}));', 'invalid_metadata'],
    ['process.stdout.write(JSON.stringify({name:"@example-fixture/app",version:"1.0.0"}));throw Error("SECRET");', 'process_failed'],
    ['process.stdout.write("X".repeat(50000));setInterval(()=>{},100);', 'output_limit'],
  ]) {
    const cli = await f.fake(`if(args.includes('config')){process.stdout.write(${JSON.stringify(f.registryOrigin)});}
      else {${body}}`);
    const result = await fetchNpmMetadata({ ...cli, selector: '1.0.0', maxStdoutBytes: 4096 });
    failure(result, kind);
    assert(!JSON.stringify(result).includes('SECRET'));
    await f.checkClean();
  }
}));

async function pidGone(file: string) {
  const pids = JSON.parse(await readFile(file, 'utf8')) as number[];
  evidence.push({ childPids: pids, observedAfterResult: true });
  for (const pid of pids) {
    // A killed descendant can briefly be a zombie pending init's reap on Linux.
    try {
      process.kill(pid, 0);
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      assert(stat.includes(') Z'), `PID ${pid} remains running`);
      evidence.push({ pid, state: 'zombie awaiting init reap' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      evidence.push({ pid, state: 'absent' });
    }
  }
}
async function waitFile(path: string, result: Promise<NpmMetadataResult>) {
  const started = performance.now(), end = started + 3000;
  let finished: NpmMetadataResult | undefined;
  void result.then(value => { finished = value; });
  while (performance.now() < end) {
    try { await access(path); return; } catch { /* bounded polling for real child readiness */ }
    if (finished) throw new Error(`child ended before readiness (${path}; ${JSON.stringify(finished)})`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`child readiness timeout (${path}; elapsed=${performance.now()-started}ms)`);
}

test('npm registry: PID readiness never publishes an incomplete child identity', async () => fixture(async f => {
  const ready = join(f.root, 'ready.json');
  const probe = `const fs=require('node:fs');const path=${JSON.stringify(ready)};
    try {if(fs.existsSync(path)){const ids=JSON.parse(fs.readFileSync(path,'utf8'));
      if(!Array.isArray(ids)||ids.length!==1||!Number.isSafeInteger(ids[0])||ids[0]<=1)process.exit(43);}}
    catch {process.exit(43);}`;
  const cli = await f.fake(`if(args.includes('config'))process.stdout.write(${JSON.stringify(f.registryOrigin)});
    else {
      const write=fs.writeFileSync;
      fs.writeFileSync=(path,bytes,...options)=>{
        write(path,'['); // An OS-visible partial write, observed before the writer can finish.
        // The metadata request's existing deadline owns the reader's lifetime too.
        const reader=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}]);
        if(reader.status===43)throw Error('PID readiness exposed incomplete JSON or invalid identity');
        if(reader.error||reader.signal||reader.status!==0)throw reader.error??Error('PID readiness reader did not complete successfully');
        write(path,bytes,...options);
      };
      notifyPids(${JSON.stringify(ready)},[process.pid]);
      process.stdout.write(JSON.stringify({name:'@example-fixture/app',version:'1.0.0'}));
    }`);
  success(await fetchNpmMetadata(cli));
  await pidGone(ready);
  await f.checkClean();
}));

test('npm registry: a child that exits before readiness reports its real result and leaves no temp', async () => fixture(async f => {
  const ready = join(f.root, 'never-ready.json');
  const cli = await f.fake('process.exit(42);');
  const controller = new AbortController();
  const result = fetchNpmMetadata({ ...cli, signal: controller.signal });
  try {
    await assert.rejects(waitFile(ready, result), /child ended before readiness.*process_failed/);
    failure(await result, 'process_failed');
    await f.checkClean();
  } finally { controller.abort(); await result; }
}));

test('npm registry: abort and deadline reap real child, descendants, pipes and temp', async () => fixture(async f => {
  for (const cancel of ['abort', 'deadline']) {
    const pidFile = join(f.root, `pids-${cancel}.json`);
    const cli = await f.fake(`const cp=require('node:child_process');
      const descendant=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(124),10000);setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});
      notifyPids(${JSON.stringify(pidFile)},[process.pid,descendant.pid]);
      process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    const controller = new AbortController();
    const result = fetchNpmMetadata({ ...cli, signal: controller.signal, deadlineMs: cancel === 'deadline' ? 400 : 5000 });
    try {
      await waitFile(pidFile, result);
      if (cancel === 'abort') controller.abort('SECRET reason');
      failure(await result, cancel === 'abort' ? 'aborted' : 'deadline');
      await pidGone(pidFile);
      await f.checkClean();
    } finally { controller.abort(); await result; }
  }
  const controller = new AbortController(); controller.abort();
  failure(await fetchNpmMetadata({ ...f.request, signal: controller.signal }), 'aborted');
}));

test('npm registry: abort during metadata and exit races settle once and leave no resources', async () => fixture(async f => {
  const ready = join(f.root, 'ready.json');
  const cli = await f.fake(`if(args.includes('config'))process.stdout.write(${JSON.stringify(f.registryOrigin)});
    else {notifyPids(${JSON.stringify(ready)},[process.pid]);
      process.stdout.write(JSON.stringify({name:'@example-fixture/app',version:'1.0.0'}));
      setTimeout(()=>{throw Error('SECRET late failure')},30);}`);
  const controller = new AbortController();
  let settlements = 0;
  const pending = fetchNpmMetadata({ ...cli, signal: controller.signal }).then(r => { settlements++; return r; });
  try {
    await waitFile(ready, pending); controller.abort();
    failure(await pending, 'aborted');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settlements, 1);
    await pidGone(ready);
    await f.checkClean();
  } finally { controller.abort(); await pending; }
}));

test('npm registry: isolates cwd, cache, logs, Node hooks and TLS without exposing secrets', async () => fixture(async f => {
  const observation = join(f.root, 'observed.json');
  const cli = await f.fake(`const cache=args.find(x=>x.startsWith('--cache=')).slice(8);
    const before=fs.existsSync(cache)?fs.readdirSync(cache):[];
    fs.writeFileSync(${JSON.stringify(observation)},JSON.stringify({args,cwd:process.cwd(),before,
      hooks:process.env.NODE_OPTIONS,nodePath:process.env.NODE_PATH,tls:process.env.NODE_TLS_REJECT_UNAUTHORIZED}));
    if(args.includes('config'))process.stdout.write(${JSON.stringify(f.registryOrigin)});
    else process.stdout.write(JSON.stringify({name:'@example-fixture/app',version:'1.0.0'}));`);
  success(await fetchNpmMetadata({ ...cli, environment: { NODE_OPTIONS: '--require=/must-not-execute', NODE_PATH: '/outside-checkout', NODE_TLS_REJECT_UNAUTHORIZED: '0' } }));
  const observed = JSON.parse(await readFile(observation, 'utf8'));
  assert.deepEqual(observed.before, []);
  assert.equal(observed.hooks, undefined); assert.equal(observed.nodePath, undefined); assert.equal(observed.tls, undefined);
  assert(observed.args.includes('--strict-ssl=true'));
  assert(observed.args.includes('--fetch-retries=0'));
  assert(observed.args.includes('--logs-max=0'));
  assert(observed.cwd.startsWith(f.request.temporaryDirectory));
}));

// A descendant outside the owned group is deliberately not a product cleanup target.
// This detects the original close-only hang, then the harness cleans only its recorded fixture PIDs.
test('npm registry: escaped pipe holders fail boundedly without claiming descendant cleanup', async t => {
  for (const [phase, cancel] of [['configuration', 'deadline'], ['configuration', 'abort'], ['metadata', 'deadline']] as const) {
    await t.test(`${phase}/${cancel}`, async () => fixture(async f => {
      const pidFile=join(f.root,`escaped-${phase}-${cancel}.json`);
      const cli=await f.fake(`const cp=require('node:child_process');
        if(${JSON.stringify(phase)}==='metadata'&&args.includes('config'))process.stdout.write(${JSON.stringify(f.registryOrigin)});
        else {const child=cp.spawn(process.execPath,['-e','setTimeout(()=>process.exit(124),10000);setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});
          notifyPids(${JSON.stringify(pidFile)},[process.pid,child.pid]);child.unref();
          process.stdout.write(args.includes('config')?${JSON.stringify(f.registryOrigin)}:JSON.stringify({name:'@example-fixture/app',version:'1.0.0'}));
          process.exit(0);}`);
      const controller=new AbortController(),started=performance.now();
      let settlements=0, pending:Promise<NpmMetadataResult>|undefined, ids:number[]=[];
      let waitTimer:ReturnType<typeof setTimeout>|undefined;
      try {
        pending=fetchNpmMetadata({...cli,signal:controller.signal,deadlineMs:cancel==='deadline'?300:5000})
          .then(result=>{settlements++;return result;});
        await waitFile(pidFile, pending);ids=JSON.parse(await readFile(pidFile,'utf8')) as number[];
        if(cancel==='abort')controller.abort('SECRET fixture');
        const result=await Promise.race([pending,new Promise<'unsettled'>(done=>{waitTimer=setTimeout(()=>done('unsettled'),1100);})]);
        assert.notEqual(result,'unsettled','API must settle before fixture descendant cleanup');
        if(result==='unsettled')throw new Error('unreachable');
        assert.equal(failure(result,'cleanup_failed').phase,'cleanup');
        const elapsedMs=performance.now()-started;
        assert(elapsedMs<1200,`bounded pipe cleanup took ${elapsedMs}ms`);
        assert.equal(settlements,1);
        process.kill(ids[1]!,0); // Remains alive: closing our pipes must not be reported as killing this process.
        await f.checkClean();
        evidence.push({escapedPipe:{phase,cancel,elapsedMs,pids:ids,result,settlements,
          tempCleanBeforeHarnessCleanup:true,escapedDescendantAlive:true}});
      } finally {
        clearTimeout(waitTimer);
        // Record product outcome before touching only our fixture's known descendants.
        if(ids.length===0)try{ids=JSON.parse(await readFile(pidFile,'utf8'));}catch{}
        for(const pid of ids)try{process.kill(pid,'SIGKILL');}catch{}
        await pending;
        // SIGKILL delivery/reaping is asynchronous; this is fixture cleanup, not product cleanup evidence.
        for(const pid of ids)for(let retry=0;retry<50;retry++) {
          try { process.kill(pid,0); const state=await readFile(`/proc/${pid}/stat`,'utf8').catch(()=>'');
            if(state.includes(') Z'))break;
          }catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')break;throw error;}
          await new Promise(done=>setTimeout(done,10));
        }
        await pidGone(pidFile);
      }
    }));
  }
});
