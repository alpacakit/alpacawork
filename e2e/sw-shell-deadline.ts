/** Standalone PWA check. Build separately, then run through the shared e2e queue.
 * SW_DEADLINE_OUTPUT: fresh absolute evidence directory; SW_DEADLINE_NEXT_BUILD: optional complete public dir.
 * SW_DEADLINE_OLD_SW: optional archived, served worker (BUILD is rebound to synthetic fixture assets).
 * SW_DEADLINE_EXPECT=red checks deadline removal at both stalled HTTP boundaries.
 * SW_DEADLINE_MUTATE=1 serves a test-only 60s deadline with SW_DEADLINE_EXPECT=red.
 * Uses real HTTP + registered workers, never page.route or the production server.
 */
import { chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { start } from './server.ts';
import { createWebAssets } from '@alpacawork/backend/test-dist/receiver/web-assets.js';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { installedWorker } from './service-worker-lifecycle.ts';

const out = process.env.SW_DEADLINE_OUTPUT!;
assert(out && isAbsolute(out) && !existsSync(out), 'New absolute SW_DEADLINE_OUTPUT required');
assert(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required');
mkdirSync(out, { recursive: true });
const red = process.env.SW_DEADLINE_EXPECT === 'red';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Build = { version: string; files: string[]; precache: string[] };
function readBuild(source: string): Build {
  const match = source.match(/^const BUILD = (\{[^\n]+\});$/m);
  assert(match, 'Served worker must contain its injected BUILD');
  return JSON.parse(match[1]!);
}
const result: any = { at: new Date().toISOString(), node: process.version, pid: process.pid,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceSha: sha(readFileSync(import.meta.filename)), swSha: sha(readFileSync('apps/backend/public/sw.js')),
  expected: red ? 'red' : 'green', http: [], browser: [], phases: [], pids: [], errors: [], workers: [] };
writeFileSync(resolve(out, 'source-executed.ts'), readFileSync(import.meta.filename));
writeFileSync(resolve(out, 'built-sw.js'), readFileSync('apps/backend/public/sw.js'));
const save = () => writeFileSync(resolve(out, 'measurement.json'), JSON.stringify(result, null, 2));
let runtime: Awaited<ReturnType<typeof start>> | undefined, context: BrowserContext | undefined;
let candidateServer: Server | undefined, candidateOrigin = '', targetOrigin = '';
let mode = 'forward', phase = 'setup', marker = 'initial', activeVersion = '';
let servedWorker: string | undefined;
const sockets = new Set<Socket>(), upstreams = new Set<ReturnType<typeof httpRequest>>();
const heldTimers = new Set<ReturnType<typeof setTimeout>>();
const updateGate: (() => void)[] = [];
const proxy = createServer((req, res) => {
  const path = new URL(req.url!, 'http://localhost').pathname;
  const root = path === '/', requestMode = mode, requestMarker = marker;
  const record: any = { phase, mode: requestMode, marker: requestMarker, url: req.url, at: Date.now(), root,
    headers: req.headers, started: false, ended: false };
  result.http.push(record);
  res.on('close', () => { record.closedAt = Date.now(); save(); });
  if (path === '/sw.js' && servedWorker !== undefined) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' });
    record.started = record.ended = true; res.end(servedWorker); return;
  }
  const forward = () => {
    if (res.destroyed) return;
    // Only public files switch to the optional second build; fixture API/SSE stay on start().
    const publicFile = root || path === '/sw.js' || path === '/manifest.webmanifest' || path === '/mermaid-frame.html' ||
      path.startsWith('/assets/') || path.startsWith('/icons/');
    const target = candidateOrigin && publicFile ? candidateOrigin : targetOrigin;
    const headers = { ...req.headers, host: new URL(target).host, 'accept-encoding': 'identity' };
    if (headers.origin === result.origin) headers.origin = target;
    // HTML is given a long HTTP freshness lifetime below. Every repeated navigation must
    // still reach this real server, even with a fresh browser HTTP cache entry.
    if (root) { delete headers['if-none-match']; delete headers['if-modified-since']; }
    const upstream = httpRequest(new URL(req.url!, target), { method: req.method, headers }, reply => {
      record.status = reply.statusCode;
      if (root && requestMode === 'body-stall') {
        res.writeHead(reply.statusCode!, reply.headers); res.flushHeaders(); record.started = true;
        reply.once('data', bytes => { res.write(bytes.subarray(0, 32)); record.partialBytes = Math.min(32, bytes.length); save(); });
        return;
      }
      if (root && reply.statusCode === 200) {
        const chunks: Buffer[] = []; reply.on('data', chunk => chunks.push(chunk));
        reply.on('end', () => {
          const html = Buffer.concat(chunks).toString().replace('</head>', `<meta name="sw-deadline-http" content="${requestMarker}"></head>`);
          const bytes = requestMode === 'gzip' ? gzipSync(html) : Buffer.from(html);
          const outgoing = { ...reply.headers };
          for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'etag']) delete outgoing[key];
          Object.assign(outgoing, { 'cache-control': 'public, max-age=3600', etag: `"${sha(html)}"`,
            'content-length': bytes.length, 'x-sw-deadline-html': requestMarker });
          if (requestMode === 'gzip') outgoing['content-encoding'] = 'gzip';
          record.htmlSha = sha(html); record.build = outgoing['x-alpacawork-build'];
          res.writeHead(200, outgoing); record.started = record.ended = true; res.end(bytes);
        });
      } else {
        res.writeHead(reply.statusCode!, reply.headers); record.started = true;
        reply.on('end', () => { record.ended = true; }); reply.pipe(res);
      }
    });
    upstreams.add(upstream); upstream.once('close', () => upstreams.delete(upstream));
    upstream.on('error', error => { record.error = String(error); res.destroy(); });
    res.once('close', () => upstream.destroy()); req.pipe(upstream);
  };
  if (requestMode === 'update-gate' && path.startsWith('/assets/') && path.endsWith('.js')) {
    record.gated = true; updateGate.push(forward); save(); return;
  }
  if (root && requestMode === 'blackhole') { save(); return; }
  if (root && requestMode === 'disconnect') { res.destroy(); return; }
  if (root && ['503', '403'].includes(requestMode)) {
    record.status = Number(requestMode); record.started = record.ended = true;
    res.writeHead(Number(requestMode), { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('test HTTP ' + requestMode); return;
  }
  if (root && ['slow', 'late'].includes(requestMode)) {
    const timer = setTimeout(() => {
      heldTimers.delete(timer); record.lateAttemptAt = Date.now(); record.closedBeforeLate = res.destroyed;
      forward(); save();
    }, requestMode === 'slow' ? 1500 : 6500);
    heldTimers.add(timer); return;
  }
  forward();
});
proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
const seen = new Map<number, string>();
function identity(pid: number) { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ')[19]!; } catch { return null; } }
function recordPids() {
  const rows = execFileSync('ps', ['-u', String(process.getuid!()), '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const own = new Set([process.pid]); let count = 0;
  while (count !== own.size) { count = own.size; for (const [pid, parent] of rows) if (own.has(parent!)) own.add(pid!); }
  for (const pid of own) { const born = identity(pid); if (born) seen.set(pid, born); }
  result.pids = [...seen].map(([pid, born]) => ({ pid, born }));
}
async function closeContext(label: string) {
  await context?.tracing.stop({ path: resolve(out, label + '-trace.zip') });
  await context?.close(); context = undefined;
}
async function cleanup() {
  await context?.close(); context = undefined;
  for (const timer of heldTimers) clearTimeout(timer); heldTimers.clear();
  updateGate.length = 0;
  for (const socket of sockets) socket.destroy(); for (const upstream of upstreams) upstream.destroy();
  if (proxy.listening) await new Promise<void>(done => proxy.close(() => done()));
  if (candidateServer?.listening) { candidateServer.closeAllConnections(); await new Promise<void>(done => candidateServer!.close(() => done())); }
  await runtime?.stop(); runtime = undefined;
}
const expiry = setTimeout(() => { result.fatal = '240s runner deadline'; save(); void cleanup().finally(() => process.exit(1)); }, 240000);
process.once('SIGTERM', () => { result.fatal = 'SIGTERM'; save(); void cleanup().finally(() => process.exit(143)); });
process.once('uncaughtException', error => { result.fatal = String(error); save(); void cleanup().finally(() => process.exit(1)); });
async function openContext(label: string) {
  result.profiles ??= []; result.profiles.push(resolve(out, label + '-profile'));
  context = await chromium.launchPersistentContext(result.profiles.at(-1), { headless: true, serviceWorkers: 'allow',
    viewport: { width: 1280, height: 900 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', args: ['--no-sandbox'] });
  result.browserVersion = context.browser()?.version();
  context.on('page', page => page.on('pageerror', error => result.errors.push({ phase, error: String(error) })));
  context.on('request', req => result.browser.push({ kind: 'request', phase, at: Date.now(), url: req.url(), sw: !!req.serviceWorker() }));
  context.on('requestfailed', req => result.browser.push({ kind: 'failure', phase, at: Date.now(), url: req.url(), sw: !!req.serviceWorker(), error: req.failure() }));
  context.on('serviceworker', worker => {
    worker.on('console', message => result.workers.push({ phase, kind: message.type(), text: message.text() }));
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
}
async function worker(version = activeVersion): Promise<Worker> {
  // Active and waiting workers have the same scriptURL. Select by the actual executed BUILD.
  for (const candidate of context!.serviceWorkers()) {
    try { if (await candidate.evaluate('BUILD.version') === version) return candidate; } catch { /* A retiring worker has no execution context. */ }
  }
  throw new Error('No live worker for ' + version);
}
async function cacheState(version = activeVersion): Promise<any> {
  return (await worker(version)).evaluate(`(async()=>({build:BUILD,caches:await Promise.all((await caches.keys()).map(async name=>{
    const c=await caches.open(name);return {name,entries:await Promise.all((await c.keys()).map(async req=>{
      const r=await c.match(req);const bytes=await r.arrayBuffer();return {url:req.url,status:r.status,
        marker:new TextDecoder().decode(bytes).match(/name="sw-deadline-http" content="([^"]+)"/)?.[1],
        sha:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('')};}))};}))}))()`);
}
function buildCache(snapshot: any) { return snapshot.caches.find((c: any) => c.name === 'alpacawork-' + snapshot.build.version); }
function rootEntry(snapshot: any) { return buildCache(snapshot)?.entries.find((e: any) => e.url === result.origin + '/'); }
function startup(snapshot: any) {
  return buildCache(snapshot).entries.filter((e: any) => snapshot.build.precache.includes(new URL(e.url).pathname))
    .sort((a: any, b: any) => a.url.localeCompare(b.url));
}
async function savedMarker(expected: string) {
  await expect.poll(async () => rootEntry(await cacheState())?.marker, { timeout: 5000 }).toBe(expected);
}
async function navigate(name: string, nextMode = 'forward', offline = false, expectShell = true, trial = name, timeout = 8000) {
  phase = name; mode = nextMode;
  const p: any = { name, mode, offline, startedAt: Date.now() }; result.phases.push(p); save(); console.log(name);
  await context!.setOffline(offline);
  const page = await context!.newPage();
  const cdp = await context!.newCDPSession(page); await cdp.send('Network.enable'); await cdp.send('Page.enable');
  p.network = [];
  cdp.on('Network.responseReceived', e => p.network.push({ kind: 'response', at: Date.now(), type: e.type, ...e.response }));
  cdp.on('Network.loadingFailed', e => p.network.push({ kind: 'failure', at: Date.now(), ...e }));
  await page.addInitScript(() => {
    const observed: { shell: number | null; react: number | null } = (window as any).__startup = { shell: null, react: null };
    new MutationObserver(() => {
      if (document.getElementById('root') && observed.shell === null) observed.shell = performance.now();
      if (document.getElementById('root')?.childElementCount && observed.react === null) observed.react = performance.now();
    }).observe(document, { subtree: true, childList: true });
  });
  p.onlineBefore = await page.evaluate(() => navigator.onLine); assert.equal(p.onlineBefore, !offline);
  recordPids(); p.navigationAt = Date.now();
  // Distinct trials avoid queuing behind a held HTTP request; the freshness pair deliberately shares one URL.
  p.url = result.url + '&trial=' + encodeURIComponent(trial);
  try { const r = await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout }); p.response = { status: r?.status(), headers: r?.headers(), url: r?.url() }; p.domAt = Date.now(); }
  catch (error) { p.navigationError = String(error); }
  if (p.domAt && expectShell) {
    try { await page.waitForFunction(() => !!document.getElementById('root')?.childElementCount, null, { timeout: 4000 }); }
    catch (error) { p.renderError = String(error); }
  }
  p.cutoffAt = Date.now(); save();
  if (!p.domAt) await cdp.send('Page.stopLoading');
  p.page = await page.evaluate(() => ({ url: location.href, timeOrigin: performance.timeOrigin,
    controller: navigator.serviceWorker?.controller?.scriptURL, shell: !!document.getElementById('root'),
    react: !!document.getElementById('root')?.childElementCount, observation: (window as any).__startup,
    marker: document.querySelector('meta[name="sw-deadline-http"]')?.getAttribute('content'), text: document.body?.innerText.slice(0, 1200) }));
  p.shellMs = p.page.observation?.shell == null ? null : p.page.timeOrigin + p.page.observation.shell - p.navigationAt;
  p.reactMs = p.page.observation?.react == null ? null : p.page.timeOrigin + p.page.observation.react - p.navigationAt;
  await page.screenshot({ path: resolve(out, name + '.png'), timeout: 3000 }); save();
  if (expectShell) assert(p.domAt && p.page.shell && p.page.react, name + ': real app must start');
  return { page, p };
}
const registered = installedWorker;
async function naturallyActivate(version: string, oldVersion: string) {
  // No skipWaiting message, unregister, reload, or claim. Only controlled windows disappear.
  for (const page of context!.pages()) if (page.url().startsWith(result.origin)) await page.close();
  await expect.poll(async () => {
    try {
      return await (await worker(version)).evaluate(`(async()=>({state:self.registration.active?.state,
        waiting:!!self.registration.waiting,oldCache:(await caches.keys()).includes(${JSON.stringify('alpacawork-' + oldVersion)})}))()`);
    } catch { return null; }
  }, { timeout: 15000 }).toEqual({ state: 'activated', waiting: false, oldCache: false });
  activeVersion = version;
}
async function checkNoShell() {
  phase = 'remove-shell';
  await (await worker()).evaluate(`caches.open(CACHE).then(c=>c.delete('/'))`);
  marker = 'no-shell-network';
  const slow = await navigate('no-shell-beyond-five-seconds', 'late', false, true, undefined, 10000);
  assert(slow.p.shellMs >= 6300 && slow.p.page.marker === marker, 'without saved HTML, real network may finish after five seconds');
  await savedMarker(marker); result.noShellReplenished = await cacheState(); await slow.page.close();
  await (await worker()).evaluate(`caches.open(CACHE).then(c=>c.delete('/'))`);
  const empty = await navigate('no-shell-offline', 'forward', true, false);
  assert(!empty.p.page.react && empty.p.navigationError, 'uncached offline must not fake app success');
  await empty.page.close(); await context!.setOffline(false);
}
try {
  runtime = await start('0'); targetOrigin = runtime.origin;
  result.fixture = { root: runtime.root, origin: runtime.origin };
  const baseSource = await (await fetch(targetOrigin + '/sw.js')).text();
  const baseBuild = readBuild(baseSource); activeVersion = baseBuild.version;
  result.baseBuild = baseBuild; writeFileSync(resolve(out, 'served-current-sw.js'), baseSource);
  if (process.env.SW_DEADLINE_MUTATE === '1') {
    assert(red, 'Deadline mutation requires SW_DEADLINE_EXPECT=red');
    servedWorker = baseSource.replace('const NETWORK_DEADLINE_MS = 5000;', 'const NETWORK_DEADLINE_MS = 60000;');
    assert.notEqual(servedWorker, baseSource, 'Mutant must change the actual served deadline');
    result.mutation = { deadlineMs: 60000, swSha: sha(servedWorker) };
    writeFileSync(resolve(out, 'served-mutant-sw.js'), servedWorker);
  }
  await new Promise<void>(done => proxy.listen(0, '127.0.0.1', done));
  result.origin = `http://127.0.0.1:${(proxy.address() as any).port}`; result.url = result.origin + '/?agent=1';
  await openContext('current');
  const warm = await navigate('warm-online'); await registered(warm.page);
  assert.equal(await warm.page.evaluate(() => navigator.serviceWorker.controller), null, 'first install must not claim the open page');
  await warm.page.locator('[data-time-tree]').waitFor({ timeout: 10000 });
  result.initial = await cacheState(); await warm.page.close();
  marker = 'fresh-one';
  const first = await navigate('same-url-first', 'forward', false, true, 'freshness');
  assert(first.p.page.controller); assert.equal(first.p.page.marker, marker); await savedMarker(marker); await first.page.close();
  marker = 'fresh-two';
  const second = await navigate('same-url-second', 'forward', false, true, 'freshness');
  assert.equal(second.p.page.marker, marker, 'fresh HTTP cache must be revalidated, not reused silently');
  assert(result.http.some((r: any) => r.phase === 'same-url-second' && r.root && r.ended && r.marker === marker), 'repeat URL reached the real HTTP server');
  await savedMarker(marker); await second.page.close();
  marker = 'network-after-1500ms';
  const slow = await navigate('network-within-five-seconds', 'slow');
  assert(slow.p.shellMs >= 1400 && slow.p.shellMs < 4500 && slow.p.page.marker === marker, '1.5s response must display network HTML, not old one-second fallback');
  await savedMarker(marker); await slow.page.close();
  result.saved = await cacheState();
  const saved = marker;
  marker = 'must-not-replace-saved';
  for (const [name, networkMode, offline] of [ ['offline', 'forward', true], ['blackhole', 'blackhole', false],
    ['headers-body-stall', 'body-stall', false], ['deadline-late', 'late', false], ['connection-failure', 'disconnect', false], ['server-503', '503', false] ] as const) {
    const stalled = ['blackhole', 'body-stall'].includes(networkMode);
    const { page, p } = await navigate(name, networkMode, offline, !(red && stalled));
    if (red && stalled) {
      assert(!p.domAt || !p.page.react, 'deadline removal must fail startup through actual HTTP'); p.expectedRed = true;
    } else {
      assert(p.page.controller); assert.equal(p.page.marker, saved, name + ': saved HTML is displayed');
      if (['blackhole', 'body-stall', 'late'].includes(networkMode)) assert(p.shellMs >= 4800 && p.shellMs < 6800, 'HTML deadline is five seconds');
      if (offline || ['disconnect', '503'].includes(networkMode)) assert(p.shellMs < 4500, 'known failure does not wait for the deadline');
    }
    p.cache = await cacheState(); assert.deepEqual(startup(p.cache), startup(result.saved), 'failed navigation cannot replace saved startup set');
    if (!offline) {
      const request = result.http.find((r: any) => r.phase === name && r.root);
      assert(request, name + ': actual HTTP request reached fixture');
      if (networkMode === 'body-stall') assert(request.started && request.partialBytes > 0 && !request.ended, 'headers and incomplete real body arrived');
      if (!red && ['blackhole', 'body-stall', 'late'].includes(networkMode)) {
        await expect.poll(() => request.closedAt, { timeout: 1500 }).toBeTruthy();
        assert(request.closedAt - request.at < 6300, 'deadline abort closes the actual HTTP response');
      }
    }
    await page.close();
    if (red && networkMode === 'body-stall') break;
  }
  if (!red) {
    const refused = await navigate('client-403', '403', false, false);
    assert.equal(refused.p.response.status, 403); assert(!refused.p.page.react && refused.p.page.text.includes('test HTTP 403'));
    assert.deepEqual(startup(await cacheState()), startup(result.saved)); await refused.page.close();
    marker = 'recovered-gzip';
    const recovery = await navigate('online-recovery-gzip', 'gzip');
    assert.equal(recovery.p.page.marker, marker); assert.equal(recovery.p.response.headers['content-encoding'], 'gzip');
    await savedMarker(marker); await recovery.page.close();
    const recoveredOffline = await navigate('recovered-copy-offline', 'forward', true);
    assert.equal(recoveredOffline.p.page.marker, marker); await recoveredOffline.page.close();
    await context!.setOffline(false);
    {
      // Keep an old controlled client before exposing the new worker. Registration by
      // new HTML may itself trigger an update, so the install gate must precede it.
      const probe = await navigate('before-next-build');
      const before = await cacheState();
      const live = await probe.page.evaluate(() => { (window as any).__swDeadlineLive = 'unsaved-memory'; return { timeOrigin: performance.timeOrigin, href: location.href }; });
      phase = 'build-update'; mode = 'update-gate'; marker = 'next-build-network';
      const nextDirectory = process.env.SW_DEADLINE_NEXT_BUILD ?? resolve(out, 'next-public');
      assert(isAbsolute(nextDirectory), 'SW_DEADLINE_NEXT_BUILD must be an absolute complete public directory');
      if (!process.env.SW_DEADLINE_NEXT_BUILD) {
        cpSync('apps/backend/public', nextDirectory, { recursive: true });
        const nextHtml = resolve(nextDirectory, 'index.html');
        writeFileSync(nextHtml, readFileSync(nextHtml, 'utf8').replace('</head>', '<!-- second HTML build --></head>'));
      }
      result.nextBuildInput = { directory: nextDirectory, syntheticHtmlOnly: !process.env.SW_DEADLINE_NEXT_BUILD };
      // Serve the second build through the actual product asset handler, without replacing public/.
      const assets = createWebAssets(runtime.root, nextDirectory);
      candidateServer = createServer((req, res) => {
        if (!assets(new URL(req.url!, 'http://localhost').pathname, req.headers, res)) res.writeHead(404).end();
      });
      await new Promise<void>(done => candidateServer!.listen(0, '127.0.0.1', done));
      candidateOrigin = `http://127.0.0.1:${(candidateServer.address() as any).port}`;
      const nextSource = await (await fetch(candidateOrigin + '/sw.js')).text(), next = readBuild(nextSource);
      assert.notEqual(next.version, activeVersion, 'next directory must identify a different build');
      writeFileSync(resolve(out, 'served-next-sw.js'), nextSource); result.nextBuild = next;
      // The old worker already knows its own startup graph. Hold next-build JS until install is released.
      phase = 'next-build-install';
      await probe.page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
      await expect.poll(() => updateGate.length, { timeout: 10000 }).toBeGreaterThan(0);
      result.duringIncompleteInstall = await cacheState(); assert.deepEqual(startup(result.duringIncompleteInstall), startup(before));
      assert.equal(await probe.page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.installing?.state), 'installing');
      mode = 'forward'; for (const release of updateGate.splice(0)) release();
      await probe.page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed', null, { timeout: 15000 });
      result.waiting = await cacheState(next.version);
      assert.equal(await (await worker()).evaluate('BUILD.version'), baseBuild.version);
      assert.deepEqual(startup(await cacheState()), startup(before), 'complete waiting build must preserve old cache until clients close');
      const nextDisplay = await navigate('next-build-network-display');
      assert.equal(nextDisplay.p.page.marker, marker); assert.equal(nextDisplay.p.response.headers['x-alpacawork-build'], next.version);
      result.beforeUpdate = await cacheState(); assert.deepEqual(startup(result.beforeUpdate), startup(before), 'different-build HTML is displayed without overwriting old saved set');
      await nextDisplay.page.close();
      await context!.setOffline(true); await context!.setOffline(false);
      await probe.page.waitForTimeout(1500);
      assert.deepEqual(await probe.page.evaluate(() => ({ timeOrigin: performance.timeOrigin, href: location.href })), live);
      assert.equal(await probe.page.evaluate(() => (window as any).__swDeadlineLive), 'unsaved-memory', 'install and reconnect must not auto reload open page');
      const oldOffline = await navigate('waiting-old-copy-offline', 'forward', true);
      assert.equal(oldOffline.p.page.marker, rootEntry(before).marker); await oldOffline.page.close();
      await context!.setOffline(false);
      await naturallyActivate(next.version, baseBuild.version);
      result.updated = await cacheState();
      const entries = buildCache(result.updated).entries;
      for (const path of next.precache) assert(entries.some((e: any) => new URL(e.url).pathname === path && e.status === 200), 'installed startup asset ' + path);
      const updatedOffline = await navigate('new-build-offline', 'forward', true);
      assert(updatedOffline.p.page.controller); assert.equal(updatedOffline.p.page.marker, 'next-build-network');
      await updatedOffline.page.close();
    }
    await context!.setOffline(false); await checkNoShell();
    await closeContext('current'); candidateOrigin = '';
    if (process.env.SW_DEADLINE_OLD_SW) {
      assert(isAbsolute(process.env.SW_DEADLINE_OLD_SW), 'SW_DEADLINE_OLD_SW must name archived served worker evidence');
      const original = readFileSync(process.env.SW_DEADLINE_OLD_SW, 'utf8');
      const archivedBuild = readBuild(original);
      const legacy = { ...baseBuild, version: 'sw-deadline-legacy-' + sha(original).slice(0, 12) };
      servedWorker = original.replace(/^const BUILD = \{[^\n]+\};$/m, 'const BUILD = ' + JSON.stringify(legacy) + ';');
      result.legacy = { path: process.env.SW_DEADLINE_OLD_SW, originalSha: sha(original), originalBuild: archivedBuild.version,
        reboundBuild: legacy, scope: 'Archived old worker logic with synthetic current startup assets; not a copy of deployed offline cache or production data.' };
      writeFileSync(resolve(out, 'legacy-original-sw.js'), original); writeFileSync(resolve(out, 'legacy-rebound-sw.js'), servedWorker);
      activeVersion = legacy.version; marker = 'legacy-installed'; mode = 'forward';
      await openContext('legacy');
      const oldWarm = await navigate('legacy-warm-online'); await registered(oldWarm.page);
      await oldWarm.page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
      const oldCache = await cacheState();
      marker = 'legacy-slow-network';
      const oldSlow = await navigate('legacy-one-second-deadline', 'slow');
      assert(oldSlow.p.shellMs >= 800 && oldSlow.p.shellMs < 2500 && oldSlow.p.page.marker === 'legacy-installed', 'archived old worker keeps its one-second deadline');
      await oldSlow.page.close();
      marker = 'legacy-new-online-html';
      const oldDisplay = await navigate('legacy-displays-new-html');
      assert.equal(oldDisplay.p.page.marker, marker); assert.deepEqual(startup(await cacheState()), startup(oldCache), 'old worker never overwrites its saved HTML with online new build');
      const originTime = await oldWarm.page.evaluate(() => performance.timeOrigin);
      servedWorker = undefined; marker = 'migration-installed'; phase = 'legacy-update';
      await oldWarm.page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
      await oldWarm.page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed', null, { timeout: 15000 });
      assert.deepEqual(startup(await cacheState()), startup(oldCache));
      assert.equal(await oldWarm.page.evaluate(() => performance.timeOrigin), originTime, 'old open page is not reloaded during migration');
      const oldFallback = await navigate('legacy-waiting-offline', 'forward', true);
      assert.equal(oldFallback.p.page.marker, 'legacy-installed'); await oldFallback.page.close(); await context!.setOffline(false);
      await naturallyActivate(baseBuild.version, legacy.version);
      result.legacy.activated = await cacheState();
      const migrated = await navigate('legacy-migrated-offline', 'forward', true);
      assert(migrated.p.page.controller); assert.equal(migrated.p.page.marker, 'migration-installed'); await migrated.page.close();
      await closeContext('legacy');
    } else result.legacySkipped = 'Set SW_DEADLINE_OLD_SW to archived served worker evidence; no production worker is hard-coded.';
  }
  assert.deepEqual(result.errors, []);
  result.assertions = red ? 'expected red observed at both real HTTP boundaries' : 'passed';
} catch (error) { result.fatal = error instanceof Error ? error.stack : String(error); process.exitCode = 1; save(); }
finally {
  recordPids();
  try { await closeContext('final'); } catch (error) { result.traceError = String(error); process.exitCode = 1; }
  await cleanup(); clearTimeout(expiry);
  result.cleanup = { at: new Date().toISOString(), proxyListening: proxy.listening, candidateListening: candidateServer?.listening ?? false, timers: heldTimers.size,
    pids: [...seen].map(([pid, born]) => ({ pid, born, self: pid === process.pid, runningSameProcess: identity(pid) === born })) };
  save(); console.log(JSON.stringify({ assertions: result.assertions, fatal: result.fatal, nextBuildSkipped: result.nextBuildSkipped, legacySkipped: result.legacySkipped,
    phases: result.phases.map((p: any) => ({ name: p.name, shellMs: p.shellMs, reactMs: p.reactMs, marker: p.page?.marker, expectedRed: p.expectedRed })) }, null, 2));
}
