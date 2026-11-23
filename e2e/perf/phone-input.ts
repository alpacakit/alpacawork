/** What a key costs in the phone's input, on the common synthetic workspace. The same script runs against any built
 * checkout (`--release`), so before and after differ only in the product. Counts per key (commits, components drawn,
 * storage writes, reads) are the primary result on this shared machine; times only from alternating runs.
 *
 *   node e2e/perf/phone-input.ts --release <built checkout> --out <new dir> [--rounds 1] [--throttles 4,6]
 *     [--surfaces conversation,reply] [--feeds still,live] [--inputs latin,ime] [--renders] [--cpu] [--prefill 0] [--update-ms 2000]
 *
 * This is Chrome's emulation of a phone (390 wide, touch, CPU throttled), not a phone: no real keyboard, no real IME.
 * `--renders` walks the fibers on each commit and `--cpu` samples the page: both cost CPU, so read only their counts from
 * those runs and take times from a run without them. Component names need a `--mode profiling` build.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { commandHeaders } from '../../tests/helpers/command-fetch.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

const { values: args } = parseArgs({ options: {
  release: { type: 'string' }, out: { type: 'string' }, rounds: { type: 'string', default: '1' }, throttles: { type: 'string', default: '4,6' },
  surfaces: { type: 'string', default: 'conversation,reply' }, feeds: { type: 'string', default: 'still,live' }, inputs: { type: 'string', default: 'latin,ime' },
  renders: { type: 'boolean', default: false }, cpu: { type: 'boolean', default: false }, prefill: { type: 'string', default: '0' }, 'update-ms': { type: 'string', default: '2000' },
  seed: { type: 'string', default: 'synthetic-v1' }, keys: { type: 'string', default: '60' }, 'expire-minutes': { type: 'string', default: '40' },
  'shot': { type: 'string' }, 'settle-ms': { type: 'string' }, bursts: { type: 'boolean', default: false },
} });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out), keyCount = Number(args.keys), prefill = Number(args.prefill);
mkdirSync(out, { recursive: true });
const expiry = setTimeout(() => { console.error('phone-input expired'); process.exit(3); }, Number(args['expire-minutes']) * 60_000);

type Probe = {
  key: number; keys: { at: number; painted: number | null }[]; commits: number[]; drawn: number[]; names: Record<string, number>;
  events: { name: string; start: number; delay: number; processing: number; duration: number; id: number }[];
  long: { start: number; duration: number }[]; loaf: { duration: number; blocking: number; scripts: { who: string; ms: number }[] }[];
  shown: Record<string, number>; storage: Record<string, { writes: number; bytes: number; ms: number }>; idb: Record<string, number>; reads: Record<string, number>; frames: number[]; last: number;
};
declare global { interface Window { phoneProbe: Probe } }

const installProbe = (page: Page, walk: boolean) => page.addInitScript((walkFibers: boolean) => {
  const blank = () => ({ key: -1, keys: [], commits: [], drawn: [], names: {}, events: [], long: [], loaf: [], shown: {}, storage: {}, idb: {}, reads: {}, frames: [], last: 0 });
  const probe: Probe = window.phoneProbe = blank() as Probe;
  (window as any).phoneProbeReset = () => { const next = blank(); for (const name of Object.keys(next) as (keyof Probe)[]) (probe as any)[name] = (next as any)[name]; };
  const frame = (at: number) => { if (probe.last) probe.frames.push(at - probe.last); probe.last = at; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  // Where a window's time goes without a round trip through the debugger: these only count.
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (name: string, value: string) {
    const began = performance.now();
    const answer = set.call(this, name, value);
    const row = probe.storage[name] ??= { writes: 0, bytes: 0, ms: 0 };
    row.writes++; row.bytes += value.length; row.ms += performance.now() - began;
    return answer;
  };
  for (const method of ['put', 'add', 'delete'] as const) {
    const original = IDBObjectStore.prototype[method] as (...rest: unknown[]) => IDBRequest;
    (IDBObjectStore.prototype as any)[method] = function (this: IDBObjectStore, ...rest: unknown[]) {
      const name = `${this.name}.${method}`; probe.idb[name] = (probe.idb[name] ?? 0) + 1;
      return original.apply(this, rest);
    };
  }
  const read = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    probe.reads[url.pathname] = (probe.reads[url.pathname] ?? 0) + 1;
    return read.call(this, input, init);
  };
  try { new PerformanceObserver(list => { for (const each of list.getEntries() as any[]) probe.events.push({ name: each.name, start: each.startTime, delay: each.processingStart - each.startTime, processing: each.processingEnd - each.processingStart, duration: each.duration, id: each.interactionId ?? 0 }); })
    .observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit); } catch { /* unsupported */ }
  try { new PerformanceObserver(list => { for (const each of list.getEntries()) probe.long.push({ start: each.startTime, duration: each.duration }); }).observe({ type: 'longtask' }); } catch { /* unsupported */ }
  try { new PerformanceObserver(list => { for (const each of list.getEntries() as any[]) probe.loaf.push({ duration: each.duration, blocking: each.blockingDuration,
    scripts: (each.scripts ?? []).map((script: any) => ({ who: `${script.invoker ?? script.invokerType}${script.sourceFunctionName ? ` ${script.sourceFunctionName}` : ''}`, ms: script.duration })) }); })
    .observe({ type: 'long-animation-frame' }); } catch { /* unsupported */ }
  // One key: its first event opens it, and the frame after it says the letter has been drawn.
  const opened = (event: Event) => {
    if (event.type === 'beforeinput' && probe.keys[probe.key] && probe.keys[probe.key]!.painted === null) return;
    probe.key++;
    const row = { at: event.timeStamp, painted: null as number | null };
    probe.keys.push(row);
    requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { row.painted = performance.now(); channel.port1.close(); }; channel.port2.postMessage(0); });
  };
  document.addEventListener('keydown', opened, true);
  // When each update's words first stand on the screen, for how long an update waited to be shown.
  const WORDS = /Measured report (\d+)/;
  const look = (text: string | null | undefined) => { const found = text && WORDS.exec(text); if (found) probe.shown[found[1]!] ??= Date.now(); };
  new MutationObserver(records => { for (const record of records) {
    if (record.type === 'characterData') look(record.target.textContent);
    else for (const node of record.addedNodes) look(node.textContent);
  } }).observe(document, { subtree: true, childList: true, characterData: true });
  const named = (type: any): string => typeof type === 'function' ? type.displayName || type.name || 'Anonymous' : type?.displayName || (type?.type || type?.render ? named(type.type || type.render) : 'Anonymous');
  const at = () => Math.max(probe.key, 0);
  const visit = (fiber: any) => {
    if ([0, 1, 11, 14, 15].includes(fiber.tag) && (!fiber.alternate || fiber.flags & 1)) {
      const name = named(fiber.type); probe.names[name] = (probe.names[name] ?? 0) + 1; probe.drawn[at()] = (probe.drawn[at()] ?? 0) + 1;
    }
    if (fiber.alternate && fiber.alternate.child === fiber.child) return;
    for (let child = fiber.child; child; child = child.sibling) visit(child);
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: { renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
    inject() { return 1; }, onCommitFiberRoot(_id: number, root: any) { probe.commits[at()] = (probe.commits[at()] ?? 0) + 1; if (walkFibers) visit(root.current); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {} } });
}, walk);

const percentile = (values: number[], at: number) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * at))]!; };
const spread = (values: number[]) => ({ n: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9), max: percentile(values, 1) });
const sum = (values: number[]) => values.reduce((total, each) => total + each, 0);
const metricsOf = async (cdp: CDPSession) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(each => [each.name, each.value]));

/** serve in its own process, as in use. The caller stops it through `close`. */
async function serve(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
  const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((done, fail) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; const found = /http:\/\/[\w.:]+/.exec(text); if (found) done(found[0]); });
    child.once('exit', code => fail(new Error(`serve exited with ${code}: ${text}`)));
  });
  process.once('exit', () => child.kill('SIGKILL'));
  writeFileSync(join(out, 'serve.pid'), String(child.pid));
  // A fresh serve stops answering for many seconds shortly after it starts: that is the server's.
  const began = Date.now();
  let calm = Date.now();
  while (Date.now() - calm < 5000 && Date.now() - began < 45_000) {
    const asked = Date.now();
    await (await fetch(new URL('/api/task/view?task=T2', url))).text();
    if (Date.now() - asked > 300) calm = Date.now();
    await new Promise(done => setTimeout(done, 100));
  }
  return { url, close: () => new Promise<void>(done => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.kill('SIGTERM'); }) };
}

const LATIN = 'the quick brown fox jumps over the lazy dog and types on ';
/** Syllables as an IME grows them: each is one key's composition update, and a phrase ends in a commit. */
const PHRASES = ['きょうはてんきがいいです', 'にゅうりょくがおそいので', 'しらべてなおしてください', 'もじがすぐでるようにする', 'ほんばんのきろくもみます', 'かくにんをおねがいします'];

const original = createOriginal({ ...profiles.perf, seed: args.seed }, join(process.env.HOME!, '.cache/alpacawork-fixtures'));
const browser = await chromium.launch();
const results: Record<string, unknown>[] = [];
let scale: Record<string, number> = {};
const save = () => writeFileSync(join(out, 'results.json'), JSON.stringify({ release, keyCount, updateMs: Number(args['update-ms']), prefill, renders: args.renders, cpu: args.cpu, at: new Date().toISOString(), scale, results }, null, 1));
const posted = new Map<string, number>();
const cpuTotals: Record<string, Record<string, number>> = {}, inclusive: Record<string, Record<string, number>> = {};

const settle = async (page: Page, quiet = 1500, limit = 20_000) => {
  const began = Date.now();
  let lastCommits = -1, lastAt = Date.now();
  while (Date.now() - began < limit) {
    const commits = await page.evaluate(() => window.phoneProbe.commits.reduce((total, each) => total + (each ?? 0), 0));
    if (commits !== lastCommits) { lastCommits = commits; lastAt = Date.now(); }
    if (Date.now() - lastAt >= quiet) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

/** The key's cadence is a phone thumb's. */
async function typeKeys(page: Page, cdp: CDPSession, kind: string, count: number) {
  const cadence = kind === 'ime' ? 180 : 150;
  let expected = '';
  // People stop to think: with --bursts, a pause of 0.7 to 1.9s after every 5 to 12 keys, the same each run.
  // The next key does not wait for the page to take this one: a held page gets them queued, as from a thumb.
  const sending: Promise<unknown>[] = [];
  let sinceRest = 0, rest = 0;
  const rested = async () => {
    if (!args.bursts || ++sinceRest < 5 + (rest * 7) % 8) return;
    sinceRest = 0; rest++;
    await page.waitForTimeout(700 + (rest * 400) % 1300);
  };
  // No keys: what the updates cost by themselves over the time the keys would take.
  if (kind === 'none') { await page.waitForTimeout(count * cadence); return expected; }
  if (kind === 'latin') {
    for (let n = 0; n < count; n++) {
      const char = LATIN[n % LATIN.length]!;
      const began = Date.now();
      sending.push(page.keyboard.type(char));
      expected += char;
      await page.waitForTimeout(Math.max(0, cadence - (Date.now() - began)));
      await rested();
    }
    await Promise.all(sending);
    return expected;
  }
  let sent = 0;
  for (let p = 0; sent < count; p++) {
    const phrase = PHRASES[p % PHRASES.length]!;
    for (let n = 1; n <= phrase.length && sent < count; n++, sent++) {
      const began = Date.now();
      // An Android keyboard's key: keydown 229, then the composition grows.
      sending.push(cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 229, key: 'Process', code: '' }),
        cdp.send('Input.imeSetComposition', { text: phrase.slice(0, n), selectionStart: n, selectionEnd: n }),
        cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 229, key: 'Process', code: '' }));
      await page.waitForTimeout(Math.max(0, cadence - (Date.now() - began)));
      await rested();
    }
    sending.push(cdp.send('Input.insertText', { text: phrase }));
    expected += phrase;
    await page.waitForTimeout(cadence);
  }
  await Promise.all(sending);
  return expected;
}

async function measure(page: Page, cdp: CDPSession, work: () => Promise<string>, editorText: () => Promise<string>, scene: string) {
  await page.evaluate(() => (window as any).phoneProbeReset());
  const before = await metricsOf(cdp), began = performance.now();
  if (args.cpu) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const expected = await work();
  if (args.cpu) {
    const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[] } };
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    // Keep the sampled stacks, so source-map attribution can be independently checked.
    writeFileSync(join(out, `cpu-${scene.replaceAll('/', '-')}-${results.length}.cpuprofile`), JSON.stringify(profile));
    const totals = cpuTotals[scene] ??= {};
    profile.samples.forEach((id, at) => { const frame = nodes.get(id)!.callFrame;
      const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()?.replace(/-[\w-]{8}\.js$/, '') ?? ''}:${frame.lineNumber}`;
      totals[key] = (totals[key] ?? 0) + (profile.timeDeltas[at] ?? 0) / 1000; });
    writeFileSync(join(out, 'cpu.json'), JSON.stringify(Object.fromEntries(Object.entries(cpuTotals).map(([name, rows]) => [name, Object.entries(rows).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([fn, ms]) => [fn, Math.round(ms)])])), null, 1));
    // Inclusive time: a function's own and everything it called, once per stack, to say what a whole piece of work costs.
    const parents = new Map<number, number>();
    for (const node of profile.nodes as { id: number; children?: number[] }[]) for (const child of node.children ?? []) parents.set(child, node.id);
    const whole = inclusive[scene] ??= {};
    profile.samples.forEach((id, at) => {
      const seen = new Set<string>();
      for (let node: number | undefined = id; node !== undefined; node = parents.get(node)) {
        const frame = nodes.get(node)!.callFrame, key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()?.replace(/-[\w-]{8}\.js$/, '') ?? ''}:${frame.lineNumber}`;
        if (!seen.has(key)) { seen.add(key); whole[key] = (whole[key] ?? 0) + (profile.timeDeltas[at] ?? 0) / 1000; }
      }
    });
    writeFileSync(join(out, 'inclusive.json'), JSON.stringify(Object.fromEntries(Object.entries(inclusive).map(([name, rows]) => [name, Object.entries(rows).sort((a, b) => b[1] - a[1]).slice(0, 150).map(([fn, ms]) => [fn, Math.round(ms)])])), null, 1));
  }
  const wallMs = performance.now() - began;
  await page.waitForTimeout(args['settle-ms'] ? Number(args['settle-ms']) : 400);
  const after = await metricsOf(cdp);
  const probe = await page.evaluate(() => window.phoneProbe);
  const delta = (name: string) => (after[name]! - before[name]!) * 1000;
  const typedKeys = probe.keys.filter(key => key.painted !== null);
  const keyToPaint = typedKeys.map(key => key.painted! - key.at);
  const eventsNamed = (...names: string[]) => probe.events.filter(each => names.includes(each.name));
  const keyEvents = eventsNamed('keydown', 'beforeinput', 'input', 'compositionupdate', 'compositionstart', 'keyup');
  const scripts: Record<string, number> = {};
  for (const frame of probe.loaf) for (const script of frame.scripts) scripts[script.who] = (scripts[script.who] ?? 0) + script.ms;
  const commits = [...probe.commits].map(each => each ?? 0), drawn = [...probe.drawn].map(each => each ?? 0);
  const n = Math.max(typedKeys.length, 1);
  const text = await editorText();
  const shownAfter = Object.entries(probe.shown).flatMap(([n, at]) => posted.has(n) ? [at - posted.get(n)!] : []);
  return {
    shownAfter: spread(shownAfter), shownOf: posted.size,
    wallMs, keys: typedKeys.length, textOk: text.replace(/\s+/g, '').endsWith(expected.replace(/\s+/g, '')),
    keyToPaint: spread(keyToPaint), over100: keyToPaint.filter(ms => ms > 100).length, over200: keyToPaint.filter(ms => ms > 200).length,
    overThreshold: keyEvents.length,
    delay: spread(keyEvents.map(each => each.delay)), processing: spread(keyEvents.map(each => each.processing)), eventDuration: spread(keyEvents.map(each => each.duration)),
    byEvent: Object.fromEntries(['keydown', 'beforeinput', 'input', 'compositionupdate', 'keyup'].map(name => { const rows = eventsNamed(name); return [name, { over16: rows.length, delayP90: percentile(rows.map(each => each.delay), 0.9), processingP90: percentile(rows.map(each => each.processing), 0.9), durationP90: percentile(rows.map(each => each.duration), 0.9) }]; })),
    commitsPerKey: sum(commits) / n, commitsP50: percentile(commits, 0.5), drawnPerKey: sum(drawn) / n, drawnP50: percentile(drawn, 0.5),
    names: Object.fromEntries(Object.entries(probe.names).sort((a, b) => b[1] - a[1]).slice(0, 60)),
    long: { count: probe.long.length, totalMs: sum(probe.long.map(each => each.duration)), maxMs: percentile(probe.long.map(each => each.duration), 1) },
    loaf: { count: probe.loaf.length, totalMs: sum(probe.loaf.map(each => each.duration)), blockingMs: sum(probe.loaf.map(each => each.blocking)) },
    loafScripts: Object.fromEntries(Object.entries(scripts).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([who, ms]) => [who, Math.round(ms)])),
    storage: probe.storage, idb: probe.idb, reads: probe.reads, frameP90: percentile(probe.frames, 0.9), frameMax: percentile(probe.frames, 1),
    taskMs: delta('TaskDuration'), scriptMs: delta('ScriptDuration'), layoutMs: delta('LayoutDuration'), styleMs: delta('RecalcStyleDuration'),
    taskPerKeyMs: delta('TaskDuration') / n, domNow: await page.evaluate(() => document.getElementsByTagName('*').length),
  };
}

try {
  const throttles = args.throttles.split(',').map(Number), surfaces = args.surfaces.split(','), feeds = args.feeds.split(','), inputs = args.inputs.split(',');
  for (let round = 0; round < Number(args.rounds); round++) {
    const root = join(out, `workspace-${round}`);
    rmSync(root, { recursive: true, force: true });
    copyWorkspace(original.root, root);
    const app = await serve(root);
    const url = new URL('?agent=1', app.url).toString();
    const post = (path: string, data: unknown) => fetch(new URL(path, app.url), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
    const held = await (await fetch(new URL('/api/workspace/live', app.url))).text();
    const index = JSON.parse(held) as { tasks: unknown[]; placements: unknown[]; runs: unknown[] };
    scale = { indexBytes: held.length, tasks: index.tasks.length, placements: index.placements.length, runs: index.runs.length };
    let updateN = 0;
    const update = async (task: string) => {
      const { task: current } = await (await fetch(new URL(`/api/task/view?task=${task}`, app.url))).json();
      const n = updateN++;
      // A report and a change the list shows take turns: the title says when the update reached the screen.
      const response = n % 2 ? await post('/api/commands/task/update', { task, title: `Measured report ${n}`, expectedTaskHash: current.hash })
        : await post('/api/commands/task/comment', { task, title: `Reported ${n}`, description: `Measured body ${n}.`, expectedTaskHash: current.hash });
      if (!response.ok) throw new Error(`Update ${task}: ${response.status} ${await response.text()}`);
      if (n % 2) posted.set(String(n), Date.now());
    };
    try {
      for (const throttle of throttles) for (const surface of surfaces) for (const feed of feeds) for (const input of inputs) {
        const scene = `${surface}/${feed}/${input}/x${throttle}`;
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(60_000);
          await installProbe(page, args.renders);
          const cdp = await context.newCDPSession(page);
          await cdp.send('Performance.enable');
          await page.goto(url);
          await page.locator('[data-read]').first().waitFor();
          await settle(page);
          const ids = await page.locator('[data-read]').evaluateAll(rows => [...new Set(rows.map(row => row.getAttribute('data-read')!))].slice(0, 6));
          if (surface === 'reply') {
            await page.locator(`[data-read="${ids[0]}"]`).first().click();
            await page.locator('aside[data-reader-mode] header [data-reader-task-id]').first().waitFor();
            await settle(page);
          }
          await page.locator('[data-coordinator-write]').click();
          const field = page.locator('[data-one-input]');
          await field.waitFor();
          await field.click();
          if (prefill) { await page.keyboard.insertText(LATIN.repeat(Math.ceil(prefill / LATIN.length)).slice(0, prefill)); await page.waitForTimeout(300); }
          await settle(page);
          await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          await settle(page, 1000);
          posted.clear();
          let live = feed === 'live', updates = 0;
          // The phone taken out of a pocket: the page stood frozen while the work went on, and the person types at once.
          if (feed === 'return') {
            await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
            for (; updates < 6; updates++) { await update(ids[updates % ids.length]!); await new Promise(done => setTimeout(done, 1000)); }
            await cdp.send('Page.setWebLifecycleState', { state: 'active' });
            // Coming back this way fires no visibility change in a headless page; a phone's does, and the feed reconnects.
            await page.evaluate(() => document.dispatchEvent(new Event('resume')));
          }
          const feeding = live ? (async () => { while (live) { await update(ids[updates++ % ids.length]!); await new Promise(done => setTimeout(done, Number(args['update-ms']))); } })() : Promise.resolve();
          const result = await measure(page, cdp, async () => { const typed = await typeKeys(page, cdp, input, keyCount); live = false; await feeding; return typed; }, () => field.innerText(), scene);
          live = false;
          await feeding;
          if (args.shot) await page.screenshot({ path: join(args.shot, `${scene.replaceAll('/', '-')}-r${round}.png`) });
          results.push({ round, scene, surface, feed, input, throttle, updates, ...result });
          save();
          console.error(`[phone-input] ${scene} r${round}: paint p50 ${Math.round(result.keyToPaint.p50 ?? -1)} p90 ${Math.round(result.keyToPaint.p90 ?? -1)} commits/key ${result.commitsPerKey.toFixed(1)} drawn/key ${result.drawnPerKey.toFixed(0)} writes ${JSON.stringify(Object.fromEntries(Object.entries(result.storage).map(([k, v]) => [k.slice(-14), v.writes])))} idb ${JSON.stringify(result.idb)} text ${result.textOk}`);
        } finally { await context.close(); }
      }
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
