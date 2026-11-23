/** One measurement of what the person waits for on the common synthetic workspace: opening, reopening, opening a task,
 * typing, watching updates arrive, scrolling and leaving the screen alone. The same script runs against any built checkout
 * (`--release`), so before and after differ only in the product. Counts (requests, bytes, commits, renders, coverage) are the
 * primary result on this shared machine; run times only as alternating rounds (`--rounds`, one checkout at a time).
 *
 *   node e2e/perf/front-scenes.ts --release <built checkout> --out <new dir> [--rounds 3] [--throttle 4] [--widths 1440,390]
 *     [--scenes cold,warm,open,type,type-live,live,live-list,scroll,idle,tick,read-scroll,search,type-long,timeline,conversation,conversation-history]
 *     (live also measures updates of the open task as live-open) [--strips] [--renders] [--coverage] [--seed synthetic-v1]
 *
 * `--turns <n>` fills the conversation. `--retained` collects garbage after each window and reads the heap. `--callers` names who spent each JSON.stringify (a stack per call, so counts only). `--renders` walks the fibers on each commit and `--coverage` runs V8 precise coverage: both cost CPU, so read only their
 * counts from those runs and take times from a run without them. Component names need a `--mode profiling` build.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { openControlDatabase } from '@alpacawork/db';
import { commandHeaders } from '../../tests/helpers/command-fetch.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

const { values: args } = parseArgs({ options: {
  release: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '3' }, throttle: { type: 'string', default: '4' },
  widths: { type: 'string', default: '1440,390' }, scenes: { type: 'string', default: 'cold,warm,open,type,live,scroll,idle' },
  renders: { type: 'boolean', default: false }, coverage: { type: 'boolean', default: false }, seed: { type: 'string', default: 'synthetic-v1' },
  cache: { type: 'string' }, cpu: { type: 'boolean', default: false }, callers: { type: 'boolean', default: false }, retained: { type: 'boolean', default: false }, turns: { type: 'string', default: '0' }, 'timeline-limit': { type: 'string' },
  strips: { type: 'boolean', default: false },
} });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out), throttle = Number(args.throttle);
const scenes = new Set(args.scenes.split(',')), turns = Number(args.turns);
mkdirSync(out, { recursive: true });
const expiry = setTimeout(() => { console.error('front-scenes expired'); process.exit(3); }, 30 * 60_000);

type Tally = { stringify: number; stringified: number; parse: number; parsed: number; stores: number; stored: number; loads: number; loaded: number };
type Probe = { commits: number; renders: Record<string, number>; rendered: number; tally: Tally; loaf: { duration: number; blocking: number }[];
  events: { name: string; duration: number; delay: number }[]; frames: number[]; last: number };
declare global { interface Window { frontProbe: Probe } }

const installProbe = (page: Page, walk: boolean) => page.addInitScript(({ walkFibers, attribute }: { walkFibers: boolean; attribute: boolean }) => {
  const probe: Probe = window.frontProbe = { commits: 0, renders: {}, rendered: 0, tally: { stringify: 0, stringified: 0, parse: 0, parsed: 0, stores: 0, stored: 0, loads: 0, loaded: 0 }, loaf: [], events: [], frames: [], last: 0 };
  // Calls and characters do not shake with the machine's load: what JSON and web storage cost, counted where they are spent.
  const { stringify, parse } = JSON, { setItem, getItem } = Storage.prototype;
  const callers: Record<string, [number, number]> = (window as any).frontCallers = {};
  const blame = (size: number) => { const frames = new Error().stack!.split('\n').slice(3, 6).map(line => /at (\S+)/.exec(line)?.[1] ?? '?').join(' < '); const row = callers[frames] ??= [0, 0]; row[0]++; row[1] += size; };
  JSON.stringify = function (...args: Parameters<typeof stringify>) { const text = stringify.apply(JSON, args); probe.tally.stringify++; probe.tally.stringified += text?.length ?? 0; if (attribute) blame(text?.length ?? 0); return text; } as typeof stringify;
  // Each passes what it was given straight on, so what it throws or coerces stays the platform's; only a real string counts its length.
  const lengthOf = (value: unknown) => typeof value === 'string' ? value.length : 0;
  JSON.parse = function (...args: Parameters<typeof parse>) { probe.tally.parse++; probe.tally.parsed += lengthOf(args[0]); return parse.apply(JSON, args); } as typeof parse;
  Storage.prototype.setItem = function (this: Storage, ...args: Parameters<Storage['setItem']>) { setItem.apply(this, args); probe.tally.stores++; probe.tally.stored += lengthOf(args[1]); };
  Storage.prototype.getItem = function (this: Storage, ...args: Parameters<Storage['getItem']>) { const value = getItem.apply(this, args); probe.tally.loads++; probe.tally.loaded += lengthOf(value); return value; };
  const frame = (at: number) => { if (probe.last) probe.frames.push(at - probe.last); probe.last = at; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  try { new PerformanceObserver(list => { for (const each of list.getEntries() as any[]) probe.loaf.push({ duration: each.duration, blocking: each.blockingDuration }); })
    .observe({ type: 'long-animation-frame', buffered: true }); } catch { /* unsupported */ }
  try { new PerformanceObserver(list => { for (const each of list.getEntries() as any[]) probe.events.push({ name: each.name, duration: each.duration, delay: each.processingStart - each.startTime }); })
    .observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit); } catch { /* unsupported */ }
  const named = (type: any): string => typeof type === 'function' ? type.displayName || type.name || 'Anonymous' : type?.displayName || (type?.type || type?.render ? named(type.type || type.render) : 'Anonymous');
  const visit = (fiber: any) => {
    if ([0, 1, 11, 14, 15].includes(fiber.tag) && (!fiber.alternate || fiber.flags & 1)) {
      const name = named(fiber.type); probe.renders[name] = (probe.renders[name] || 0) + 1; probe.rendered++;
    }
    if (fiber.alternate && fiber.alternate.child === fiber.child) return;
    for (let child = fiber.child; child; child = child.sibling) visit(child);
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: { renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
    inject() { return 1; }, onCommitFiberRoot(_id: number, root: any) { probe.commits++; if (walkFibers) visit(root.current); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {} } });
}, { walkFibers: walk, attribute: !!args.callers });

type NetworkEntry = { path: string; type: string; bytes: number; cached: boolean; done: boolean };
const watchNetwork = async (cdp: CDPSession) => {
  await cdp.send('Network.enable');
  const entries = new Map<string, NetworkEntry>();
  let streamed = 0;
  cdp.on('Network.requestWillBeSent', event => { const url = new URL(event.request.url);
    if (url.protocol.startsWith('http')) entries.set(event.requestId, { path: url.pathname, type: event.type ?? 'Other', bytes: 0, cached: false, done: false }); });
  cdp.on('Network.requestServedFromCache', event => { const entry = entries.get(event.requestId); if (entry) entry.cached = true; });
  let refused = 0;
  cdp.on('Network.responseReceived', event => { const entry = entries.get(event.requestId); if (entry && event.response.fromDiskCache) entry.cached = true;
    if (entry && event.response.status >= 400) refused++; });
  // The feed is a fetch that stays open: its data is reported only once its content is asked to stream.
  let messages = 0;
  cdp.on('Network.responseReceived', event => { if (entries.get(event.requestId)?.path === '/api/events') void cdp.send('Network.streamResourceContent', { requestId: event.requestId }).catch(() => {}); });
  cdp.on('Network.dataReceived', event => { if (entries.get(event.requestId)?.path === '/api/events') { messages++; streamed += event.dataLength; } });
  cdp.on('Network.loadingFinished', event => { const entry = entries.get(event.requestId); if (entry) { entry.bytes = event.encodedDataLength; entry.done = true; } });
  return { reset: () => { entries.clear(); streamed = 0; messages = 0; refused = 0; }, read: () => {
    const list = [...entries.values()].filter(each => each.path !== '/api/events');
    const api = list.filter(each => each.path.startsWith('/api/')), assets = list.filter(each => !each.path.startsWith('/api/'));
    const byPath: Record<string, number> = {};
    for (const each of api) byPath[each.path] = (byPath[each.path] ?? 0) + 1;
    return { requests: list.length, apiRequests: api.length, apiBytes: api.reduce((sum, each) => sum + each.bytes, 0), assetRequests: assets.length,
      assetBytes: assets.reduce((sum, each) => sum + each.bytes, 0), streamMessages: messages, streamBytes: streamed, refused, byPath };
  } };
};

const metricsOf = async (cdp: CDPSession) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(each => [each.name, each.value]));
const percentile = (values: number[], at: number) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))]!; };

/** The hottest functions of a window by self time, with `--cpu`: where its script time went, not how long it took. */
const cpuTotals: Record<string, Record<string, number>> = {}, cpuWithin: Record<string, Record<string, number>> = {};
async function profiled<T>(cdp: CDPSession, name: string, work: () => Promise<T>) {
  if (!args.cpu) return work();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await cdp.send('Profiler.start');
  const value = await work();
  const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const totals = cpuTotals[name] ??= {};
  profile.samples.forEach((id, at) => { const frame = nodes.get(id)!.callFrame;
    const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()?.replace(/-[\w-]{8}\.js$/, '') ?? ''}:${frame.lineNumber}`;
    totals[key] = (totals[key] ?? 0) + (profile.timeDeltas[at] ?? 0) / 1000; });
  // Self time names the hot leaf; with-callees names the function to change. A recursive function counts once along a path.
  const within = cpuWithin[name] ??= {};
  const selfOf = new Map<number, number>();
  profile.samples.forEach((id, at) => selfOf.set(id, (selfOf.get(id) ?? 0) + (profile.timeDeltas[at] ?? 0) / 1000));
  const keyOf = (node: typeof profile.nodes[number]) => `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url.split('/').pop()?.replace(/-[\w-]{8}\.js$/, '') ?? ''}:${node.callFrame.lineNumber}`;
  const walk = (id: number, path: Set<string>): number => {
    const node = nodes.get(id)!, key = keyOf(node), fresh = !path.has(key);
    if (fresh) path.add(key);
    let total = selfOf.get(id) ?? 0;
    for (const child of node.children ?? []) total += walk(child, path);
    if (fresh) { path.delete(key); within[key] = (within[key] ?? 0) + total; }
    return total;
  };
  walk(profile.nodes[0]!.id, new Set());
  const top = (totals: Record<string, Record<string, number>>, count: number) => Object.fromEntries(Object.entries(totals).map(([scene, rows]) =>
    [scene, Object.entries(rows).sort((a, b) => b[1] - a[1]).slice(0, count).map(([fn, ms]) => [fn, Math.round(ms)])]));
  writeFileSync(join(out, 'cpu.json'), JSON.stringify(top(cpuTotals, 60), null, 1));
  writeFileSync(join(out, 'cpu-within.json'), JSON.stringify(top(cpuWithin, 150), null, 1));
  return value;
}
async function windowOf<T>(page: Page, cdp: CDPSession, network: Awaited<ReturnType<typeof watchNetwork>>, work: () => Promise<T>, reloads = false) {
  network.reset();
  await page.evaluate(() => { for (const key of Object.keys((window as any).frontCallers)) delete (window as any).frontCallers[key]; Object.assign(window.frontProbe, { commits: 0, renders: {}, rendered: 0, tally: { stringify: 0, stringified: 0, parse: 0, parsed: 0, stores: 0, stored: 0, loads: 0, loaded: 0 }, loaf: [], events: [], frames: [], last: 0 }); });
  // A reload starts the page's counters again.
  const before = reloads ? {} : await metricsOf(cdp), began = performance.now();
  const detail = await work();
  const wallMs = performance.now() - began;
  return { wallMs, detail, ...(await readWindow(page, cdp, network, before)) };
}
async function readWindow(page: Page, cdp: CDPSession, network: Awaited<ReturnType<typeof watchNetwork>>, before: Record<string, number>) {
  const after = await metricsOf(cdp);
  // Live objects right after the window, not whatever garbage it left: only with --retained, because a full collection stops the page.
  const retained = args.retained ? await cdp.send('HeapProfiler.collectGarbage').then(() => metricsOf(cdp)).then(metrics => metrics.JSHeapUsedSize) : undefined;
  const delta = (name: string) => (after[name]! - (before[name] ?? 0));
  const probe = await page.evaluate(() => { const { commits, renders, rendered, tally, loaf, events, frames } = window.frontProbe; const callers = Object.entries((window as any).frontCallers as Record<string, [number, number]>).sort((a, b) => b[1][1] - a[1][1]).slice(0, 30); for (const key of Object.keys((window as any).frontCallers)) delete (window as any).frontCallers[key]; return { commits, renders, rendered, tally, callers, loaf, events, frames }; });
  const input = probe.events.filter(each => ['keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup'].includes(each.name));
  const keys = probe.events.filter(each => ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'].includes(each.name));
  return { network: network.read(), commits: probe.commits, rendered: probe.rendered, tally: probe.tally, ...(args.callers ? { callers: probe.callers } : {}),
    renders: Object.fromEntries(Object.entries(probe.renders).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    taskMs: delta('TaskDuration') * 1000, scriptMs: delta('ScriptDuration') * 1000, layoutMs: delta('LayoutDuration') * 1000, styleMs: delta('RecalcStyleDuration') * 1000,
    layouts: delta('LayoutCount'), styles: delta('RecalcStyleCount'), heapBytes: after.JSHeapUsedSize, retainedBytes: retained, nodes: after.Nodes, domNow: await page.evaluate(() => document.getElementsByTagName('*').length),
    longFrames: probe.loaf.length, longFrameMs: probe.loaf.reduce((sum, each) => sum + each.duration, 0), blockingMs: probe.loaf.reduce((sum, each) => sum + each.blocking, 0),
    inputEvents: input.length, inputP50: percentile(input.map(each => each.duration), 0.5), inputP90: percentile(input.map(each => each.duration), 0.9), inputMax: percentile(input.map(each => each.duration), 1),
    keyEvents: keys.length, keyP50: percentile(keys.map(each => each.duration), 0.5), keyP90: percentile(keys.map(each => each.duration), 0.9), keyMax: percentile(keys.map(each => each.duration), 1),
    frameP90: percentile(probe.frames, 0.9), frameMax: percentile(probe.frames, 1), frames: probe.frames.length };
}

/** serve in its own process, as in use: its reads must not stall this script's clock. The caller stops it through `close`. */
async function serve(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
  const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((done, fail) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; const found = /http:\/\/[\w.:]+/.exec(text); if (found) done(found[0]); });
    child.once('exit', code => fail(new Error(`serve exited with ${code}: ${text}`)));
  });
  process.once('exit', () => child.kill('SIGKILL'));
  const cpuMs = () => { const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1]!.split(' '); return (Number(fields[11]) + Number(fields[12])) * 10; };
  // A fresh serve stops answering for many seconds shortly after it starts (17s here on this workspace): that is the server's,
  // and it would fall into whichever scene came first. Wait until it has answered at once for 5s in a row, 45s at most.
  const began = Date.now();
  let calm = Date.now();
  while (Date.now() - calm < 5000 && Date.now() - began < 45_000) {
    const asked = Date.now();
    await (await fetch(new URL('/api/task/view?task=T2', url))).text();
    if (Date.now() - asked > 300) calm = Date.now();
    await new Promise(done => setTimeout(done, 100));
  }
  return { url, cpuMs, close: () => new Promise<void>(done => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.kill('SIGTERM'); }) };
}
const original = createOriginal({ ...profiles.perf, seed: args.seed }, args.cache ?? join(process.env.HOME!, '.cache/alpacawork-fixtures'));
/** The common fixture's ended Runs have zero duration. Only the disposable timeline copy adds drawable intervals. */
function timelineIntervals(root: string) {
  const db = openControlDatabase(root, { busyTimeoutMs: 1000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    const update = db.prepare('UPDATE runs SET record=? WHERE id=?');
    for (const row of db.prepare('SELECT id, record FROM runs').all()) {
      const run = JSON.parse(String(row.record));
      const start = Date.parse('2026-11-02T09:00:00Z') + Number(row.id) % 20 * 30_000;
      Object.assign(run, { created_at: new Date(start - 60_000).toISOString(), started_at: new Date(start).toISOString(), ended_at: new Date(start + 20 * 60_000).toISOString() });
      update.run(JSON.stringify(run), Number(row.id));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}
const browser = await chromium.launch();
const results: { round: number; width: number; scene: string; [key: string]: unknown }[] = [];
const save = () => writeFileSync(join(out, 'results.json'), JSON.stringify({ release, throttle, renders: args.renders, coverage: args.coverage,
  turns, strips: args.strips, scenes: [...scenes], cpu: args.cpu, callers: args.callers, retained: args.retained,
  fixture: { key: original.key, counts: original.counts, seed: args.seed, timelineIntervals: scenes.has('timeline') }, at: new Date().toISOString(), results }, null, 1));

const fresh = async (width: number) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 700, isMobile: width < 700, locale: 'en-US', timezoneId: 'Asia/Tokyo' });
  return context;
};
const attach = async (context: BrowserContext) => {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await installProbe(page, args.renders);
  if (turns) {
    // A long conversation, always mounted even folded: the synthetic workspace has none. Its answers name Tasks, as real ones do.
    const conversation = { id: 'front-scenes', nextLaunch: { agent: 'claude', values: {} }, warm: 'none', busy: false, cancelled: [], turns: Array.from({ length: turns }, (_, i) => ({
      id: `turn-${i}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), ask: `Measured request ${i} about T2 and T3`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
      answer: `### Answer ${i}\nT2 goes on after T3, **checked**.\n\n- First point\n- Second point\n`, answeredAt: new Date(Date.UTC(2026, 9, 1, 0, i, 30)).toISOString() })) };
    await page.route('**/api/coordinator', async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), conversation } }); });
    await page.route('**/api/coordinator/warm', route => route.fulfill({ json: conversation }));
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const network = await watchNetwork(cdp);
  // To compare page sizes without another build.
  if (args['timeline-limit']) await page.route('**/api/task/timeline?**', route => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', args['timeline-limit']!);
    return route.continue({ url: url.toString() });
  });
  return { page, cdp, network };
};
const firstRow = (page: Page) => page.locator('[data-read]').first();
/** Waits for no React commit for `quiet` ms; this is not a network-idle guarantee. */
const settle = async (page: Page, quiet = 1500, limit = 15_000) => {
  const began = Date.now();
  let lastCommits = -1, lastAt = Date.now();
  while (Date.now() - began < limit) {
    const commits = await page.evaluate(() => window.frontProbe.commits);
    if (commits !== lastCommits) { lastCommits = commits; lastAt = Date.now(); }
    if (Date.now() - lastAt >= quiet) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

try {
  for (let round = 0; round < Number(args.rounds); round++) for (const width of args.widths.split(',').map(Number)) {
    const root = join(out, `workspace-${round}-${width}`);
    rmSync(root, { recursive: true, force: true });
    copyWorkspace(original.root, root);
    if (scenes.has('timeline')) timelineIntervals(root);
    const app = await serve(root);
    const url = new URL(args.strips ? '?agent=1&strip=on' : '?agent=1', app.url).toString();
    let serverAt = app.cpuMs();
    const record = (scene: string, data: Record<string, unknown>) => { const server = app.cpuMs(); results.push({ round, width, scene, serverCpuMs: server - serverAt, ...data }); serverAt = app.cpuMs(); save(); console.error(`[front-scenes] round ${round} ${width} ${scene}`); };
    try {
      const context = await fresh(width);
      const { page, cdp, network } = await attach(context);
      if (args.coverage) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: true }); }
      const before = await metricsOf(cdp), began = performance.now();
      network.reset();
      await page.goto(url);
      await firstRow(page).waitFor();
      const firstRowMs = performance.now() - began, atFirstRow = { network: network.read(), commits: await page.evaluate(() => window.frontProbe.commits) };
      const script = await page.evaluate(() => performance.getEntriesByType('navigation').map(each => { const nav = each as PerformanceNavigationTiming; return { domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd }; })[0]);
      const paints = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('paint').map(each => [each.name, each.startTime])));
      await settle(page);
      if (scenes.has('cold')) record('cold', { firstRowMs, atFirstRow, script, paints, ...(await readWindow(page, cdp, network, before)) });
      if (args.coverage) {
        const { result } = await cdp.send('Profiler.takePreciseCoverage') as { result: { url: string; functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[] };
        const rows = [] as { path: string; size: number; used: number }[];
        for (const script of result) {
          if (!script.url.includes('/assets/')) continue;
          const body = await (await fetch(script.url)).text();
          const covered = new Uint8Array(body.length).fill(1);
          // Ranges nest and the inner one wins: walking them in the order given leaves each byte with its innermost count.
          for (const fn of script.functions) for (const range of fn.ranges) covered.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset);
          rows.push({ path: new URL(script.url).pathname, size: body.length, used: covered.reduce((sum, each) => sum + each, 0) });
        }
        writeFileSync(join(out, `coverage-${round}-${width}.json`), JSON.stringify(rows, null, 1));
        await cdp.send('Profiler.stopPreciseCoverage');
      }
      if (scenes.has('warm')) {
        const reload = await windowOf(page, cdp, network, async () => {
          const start = performance.now();
          await page.reload();
          await firstRow(page).waitFor();
          const firstRowMs = performance.now() - start;
          await settle(page);
          return { firstRowMs };
        }, true);
        record('warm', reload);
      }
      if (scenes.has('open')) {
        await settle(page);
        const ids = await page.locator('[data-read]').evaluateAll(rows => rows.map(row => row.getAttribute('data-read')!).slice(0, 8));
        const opens: unknown[] = [];
        for (const id of ids) {
          const press = await windowOf(page, cdp, network, () => profiled(cdp, 'open', async () => {
            const start = performance.now();
            await page.locator(`[data-read="${id}"]`).first().click();
            await page.locator(`aside[data-reader-mode] header [data-reader-task-id]:text-is("${id}")`).waitFor();
            const headerMs = performance.now() - start;
            await page.locator('aside[data-reader-mode] [data-report-feed]').first().waitFor().catch(() => undefined);
            const feedMs = performance.now() - start;
            await settle(page, 800);
            return { id, headerMs, feedMs };
          }));
          opens.push(press);
          if (await page.locator('[data-read]').first().isHidden().catch(() => true)) {
            await page.keyboard.press('Escape');
            await page.locator('aside[data-reader-mode]').waitFor({ state: 'hidden', timeout: 5000 }).catch(async () => { await page.goBack(); });
            await page.waitForTimeout(400);
          }
        }
        record('open', { opens });
        if (await page.locator('aside[data-reader-mode]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
      }
      if (scenes.has('type')) {
        await settle(page);
        const typed = await windowOf(page, cdp, network, () => profiled(cdp, 'type', async () => {
          const start = performance.now();
          await page.locator('[data-coordinator-write]').click();
          await page.locator('[data-one-input]').waitFor();
          const openMs = performance.now() - start;
          await page.locator('[data-one-input]').click();
          await page.keyboard.type('The quick brown fox jumps over the lazy dog', { delay: 60 });
          await page.waitForTimeout(600);
          return { openMs };
        }));
        record('type', typed);
        await page.reload(); await firstRow(page).waitFor();
      }
      if (scenes.has('live')) {
        await settle(page);
        const [openId, ...others] = await page.locator('[data-read]').evaluateAll(rows => rows.map(row => row.getAttribute('data-read')!).slice(0, 6));
        await page.locator(`[data-read="${openId}"]`).first().click();
        await page.locator('aside[data-reader-mode] header [data-reader-task-id]').first().waitFor();
        await settle(page);
        const post = (path: string, data: unknown) => fetch(new URL(path, app.url), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
        const update = async (task: string, n: number) => {
          const { task: current } = await (await fetch(new URL(`/api/task/view?task=${task}`, app.url))).json();
          const response = await post('/api/task/comment', { task, title: `Measured report ${n}`, description: `Measured report body ${n}.`, expectedTaskHash: current.hash });
          if (!response.ok) throw new Error(`Update ${task}: ${response.status} ${await response.text()}`);
        };
        const live = await windowOf(page, cdp, network, () => profiled(cdp, 'live', async () => {
          const list = [openId!, ...others];
          for (let n = 0; n < 20; n++) { await update(list[n % list.length]!, n); await page.waitForTimeout(500); }
          await settle(page, 1200);
          return { updates: 20 };
        }));
        record('live', live);
        // The person watches one task and its own reports arrive.
        const own = await windowOf(page, cdp, network, () => profiled(cdp, 'live-open', async () => {
          for (let n = 0; n < 10; n++) { await update(openId!, 100 + n); await page.waitForTimeout(500); }
          await settle(page, 1200);
          return { updates: 10 };
        }));
        record('live-open', own);
        await page.keyboard.press('Escape'); await page.waitForTimeout(400);
      }
      if (scenes.has('live-list')) {
        // Nothing open, every section unfolded: what an update costs the list itself.
        await settle(page);
        for (const head of await page.locator('[data-time-tree] button[aria-expanded="false"]').all()) await head.click().catch(() => undefined);
        await settle(page);
        const rows = await page.locator('[data-read]').count();
        const ids = await page.locator('[data-read]').evaluateAll(all => all.map(row => row.getAttribute('data-read')!).slice(0, 6));
        const post = (path: string, data: unknown) => fetch(new URL(path, app.url), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
        const listed = await windowOf(page, cdp, network, () => profiled(cdp, 'live-list', async () => {
          for (let n = 0; n < 20; n++) {
            const task = ids[n % ids.length]!;
            const { task: current } = await (await fetch(new URL(`/api/task/view?task=${task}`, app.url))).json();
            const response = await post('/api/task/comment', { task, title: `Listed report ${n}`, description: `Listed body ${n}.`, expectedTaskHash: current.hash });
            if (!response.ok) throw new Error(`Update ${task}: ${response.status}`);
            await page.waitForTimeout(500);
          }
          await settle(page, 1200);
          return { updates: 20, rows };
        }));
        record('live-list', listed);
      }
      if (scenes.has('type-long')) {
        // A long draft already in the box, then the same words as `type`. What each key costs grows with the draft here.
        await settle(page);
        await page.locator('[data-coordinator-write]').click();
        await page.locator('[data-one-input]').waitFor();
        await page.locator('[data-one-input]').click();
        // In one go: 9,000 characters is under what the box turns into an attachment.
        await page.keyboard.insertText('A line of a long message that a person pasted into the box, with some words in it. '.repeat(107));
        await settle(page, 1200);
        record('type-long', await windowOf(page, cdp, network, () => profiled(cdp, 'type-long', async () => {
          await page.keyboard.type('The quick brown fox jumps over the lazy dog', { delay: 60 });
          await page.waitForTimeout(600);
          return { keys: 43 };
        })));
        await page.reload(); await firstRow(page).waitFor();
      }
      if (scenes.has('type-live')) {
        // Typing while updates arrive: the wait a person feels if a read holds the page.
        await settle(page);
        if (await page.locator('aside[data-reader-mode]').count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
        const ids = await page.locator('[data-read]').evaluateAll(all => all.map(row => row.getAttribute('data-read')!).slice(0, 6));
        const post = (path: string, data: unknown) => fetch(new URL(path, app.url), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
        await page.locator('[data-coordinator-write]').click();
        await page.locator('[data-one-input]').waitFor();
        await page.locator('[data-one-input]').click();
        await settle(page);
        const typedLive = await windowOf(page, cdp, network, () => profiled(cdp, 'type-live', async () => {
          const updates = (async () => { for (let n = 0; n < 16; n++) {
            const task = ids[n % ids.length]!;
            const { task: current } = await (await fetch(new URL(`/api/task/view?task=${task}`, app.url))).json();
            await post('/api/task/comment', { task, title: `Typed report ${n}`, description: `Typed body ${n}.`, expectedTaskHash: current.hash });
            await page.waitForTimeout(800);
          } })();
          for (let n = 0; n < 4; n++) await page.keyboard.type('The quick brown fox jumps over the lazy dog ', { delay: 60 });
          await updates;
          await settle(page, 1200);
          return { updates: 16, keys: 176 };
        }));
        record('type-live', typedLive);
        await page.reload(); await firstRow(page).waitFor();
      }
      if (scenes.has('scroll')) {
        await settle(page);
        const box = await firstRow(page).boundingBox();
        const scrolled = await windowOf(page, cdp, network, async () => {
          if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let n = 0; n < 30; n++) { await page.mouse.wheel(0, n < 15 ? 300 : -300); await page.waitForTimeout(80); }
          await page.waitForTimeout(400);
          return { steps: 30 };
        });
        record('scroll', scrolled);
      }
      if (scenes.has('timeline')) {
        await page.goto(new URL('?agent=1&strip=on', app.url).toString());
        await firstRow(page).waitFor();
        const period = page.locator('[data-time-period] select');
        await period.waitFor({ state: 'visible' });
        await settle(page);
        record('timeline-fit', await windowOf(page, cdp, network, () => profiled(cdp, 'timeline-fit', async () => {
          await period.selectOption('all');
          await settle(page, 1200);
          return { scale: await period.inputValue(), strips: await page.locator('[data-time-strip]').count() };
        })));
        const sheet = page.locator('[data-time-tree]');
        record('timeline-pan-zoom', await windowOf(page, cdp, network, () => profiled(cdp, 'timeline-pan-zoom', async () => {
          // One step from All time can still fit the entire folded chronology. Choose a concrete period first.
          await period.selectOption('1800000'); await settle(page, 800);
          await sheet.focus(); await page.keyboard.press('+'); await page.waitForTimeout(350);
          const scale = await period.inputValue();
          if (scale === 'all') throw new Error(`Timeline zoom did not leave All time: ${page.url()} ${JSON.stringify(await sheet.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth })))}`);
          const box = await sheet.boundingBox();
          if (!box) throw new Error('Timeline has no scroll area');
          await page.mouse.move(box.x + box.width - 35, box.y + Math.min(180, box.height / 2));
          const beforePan = await sheet.evaluate(el => el.scrollLeft);
          await page.mouse.wheel(-180, 0); await page.waitForTimeout(350);
          const afterPan = await sheet.evaluate(el => el.scrollLeft);
          if (Math.abs(afterPan - beforePan) < 1) throw new Error('Timeline did not pan');
          await page.mouse.wheel(180, 0); await page.waitForTimeout(200);
          await sheet.focus(); await page.keyboard.press('-'); await page.keyboard.press('0');
          await settle(page, 1200);
          return { scale, beforePan, afterPan, restored: await period.inputValue() };
        })));
        await page.reload(); await firstRow(page).waitFor();
      }
      if (scenes.has('conversation') || scenes.has('conversation-history')) {
        await settle(page);
        const scene = scenes.has('conversation-history') ? 'conversation-history' : 'conversation';
        record(scene, await windowOf(page, cdp, network, () => profiled(cdp, scene, async () => {
          await page.locator('[data-coordinator-expand]').first().click();
          const area = page.locator('[data-coordinator-panel] [data-card-scroll]').first();
          await area.waitFor({ state: 'visible' });
          await settle(page, 800);
          if (scene === 'conversation-history') {
            await page.locator('[data-earlier="folded"] > button').first().click();
            await settle(page, 800);
            if (await page.locator('[data-earlier]').count()) throw new Error('Conversation history entrance did not disappear');
            if (await page.locator('[data-coordinator-turn]').count() < turns) throw new Error('Conversation history did not open');
          }
          const box = await area.boundingBox();
          if (!box) throw new Error('Conversation has no scroll area');
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          for (let n = 0; n < 12; n++) { await page.mouse.wheel(0, n < 6 ? -300 : 300); await page.waitForTimeout(80); }
          await settle(page, 800);
          return { turns, shown: await page.locator('[data-coordinator-turn]').count() };
        })));
        await page.reload(); await firstRow(page).waitFor();
      }
      if (scenes.has('idle')) {
        await settle(page);
        record('idle', await windowOf(page, cdp, network, () => profiled(cdp, 'idle', async () => { await page.waitForTimeout(20_000); return { seconds: 20 }; })));
      }
      if (scenes.has('tick')) {
        // Two ticks of the shared clock with nothing else going on: what a screen left open pays for its elapsed times.
        await settle(page);
        record('tick', await windowOf(page, cdp, network, () => profiled(cdp, 'tick', async () => { await page.waitForTimeout(62_000); return { seconds: 62 }; })));
      }
      if (scenes.has('read-scroll')) {
        // The first row's feed, wheel over it (its length is in `reports`): what each scroll event of a person reading costs.
        await settle(page);
        const ids = await page.locator('[data-read]').evaluateAll(rows => rows.map(row => row.getAttribute('data-read')!).slice(0, 8));
        await page.locator(`[data-read="${ids[0]}"]`).first().click();
        await page.locator('aside[data-reader-mode] [data-report-feed]').first().waitFor();
        await settle(page, 1200);
        const reports = await page.locator('[data-report-key]').count();
        const box = await page.locator('aside[data-reader-mode] [data-report-feed]').first().boundingBox();
        if (box) await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 200, 700));
        record('read-scroll', { reports, ...(await windowOf(page, cdp, network, () => profiled(cdp, 'read-scroll', async () => {
          for (let n = 0; n < 60; n++) { await page.mouse.wheel(0, n < 30 ? 240 : -240); await page.waitForTimeout(50); }
          await page.waitForTimeout(400);
          return { steps: 60 };
        }))) });
        await page.reload(); await firstRow(page).waitFor();
      }
      if (scenes.has('search')) {
        // Type a word common in the synthetic titles, then leave the result on the screen for a few updates of nothing.
        await settle(page);
        // A narrow screen folds the field away: no field on the screen is said, not measured as if searched.
        const field = page.locator('[data-search-input]:visible').first();
        if (!await field.count()) record('search', { skipped: 'no search field on the screen' });
        else record('search', await windowOf(page, cdp, network, () => profiled(cdp, 'search', async () => {
          await field.click({ timeout: 5000 });
          await page.keyboard.type('report task', { delay: 120 });
          await settle(page, 1500);
          return { keys: 11 };
        })));
        await page.reload(); await firstRow(page).waitFor();
      }
      await context.close();
    } finally {
      await app.close();
      removeWorkspace(root);
    }
  }
} finally {
  save();
  await browser.close();
  clearTimeout(expiry);
}
