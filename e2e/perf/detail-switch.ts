/** A list row pressed → the detail switched to it and readable, on the common synthetic workspace, with the cases that
 * weigh most: a long History, many children, many files, and an ordinary Task; each first seen (cold) and seen again (warm).
 * Each press is split into where its time went: the reads it waited on, main-thread script, style and layout, and the
 * motion that ran. The same script runs against any built checkout (`--release`), so before and after differ only there.
 *
 *   node --import ./e2e/guard-loader.mjs e2e/perf/detail-switch.ts --release <built checkout> --out <new dir>
 *     [--widths 1440,390] [--throttle 4] [--rounds 2] [--cpu]
 *
 * `--cpu` adds the hottest functions of each press (costs CPU: read times from a run without it). Run with an isolated
 * HOME: serve refuses a workspace other than the one this PC's installation record names.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { copyWorkspace, createOriginal, profiles } from '../../scripts/dev-fixtures/fixture.ts';

const { values: args } = parseArgs({ options: {
  release: { type: 'string' }, out: { type: 'string' }, widths: { type: 'string', default: '1440,390' },
  throttle: { type: 'string', default: '4' }, rounds: { type: 'string', default: '2' }, cpu: { type: 'boolean', default: false },
  cache: { type: 'string' },
} });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out), throttle = Number(args.throttle);
mkdirSync(out, { recursive: true });
const expiry = setTimeout(() => { console.error('detail-switch expired'); process.exit(3); }, 40 * 60_000);
const original = createOriginal({ ...profiles.perf, seed: 'synthetic-v1' }, args.cache ?? join(process.env.HOME!, '.cache/alpacawork-fixtures'));

type Press = { id: string; at: number; headerAt: number | null; bodyAt: number | null; readyAt: number | null; quietAt: number | null };
type Probe = { press: Press | null; commits: number; lastCommit: number; loaf: { start: number; duration: number; styleLayout: number; scripts: { ms: number; what: string }[] }[];
  motion: { at: number; what: string; ms: number }[] };
declare global { interface Window { switchProbe: Probe } }

/** The four kinds of Task, by number: the longest History in the fixture, and three it is given here (children, files). */
function chooseCases(root: string) {
  const db = new DatabaseSync(join(root, '.alpacawork/alpacawork.sqlite'), { readOnly: true });
  try {
    const number = (id: string) => `T${(db.prepare('SELECT number FROM tasks WHERE id = ?').get(id) as { number: number }).number}`;
    const longest = db.prepare('SELECT task_id id, COUNT(*) n FROM task_log GROUP BY task_id ORDER BY n DESC LIMIT 1').get() as { id: string; n: number };
    // Ordinary Tasks: active, with a median History, none a project.
    const ordinary = (db.prepare(`SELECT t.id FROM tasks t JOIN task_log l ON l.task_id = t.id WHERE t.kind = 'task' AND t.lifecycle = 'active'
      AND t.base_state IN ('doing', 'waiting', 'todo') GROUP BY t.id HAVING COUNT(*) BETWEEN 20 AND 40 ORDER BY t.number`).all() as { id: string }[]).map(row => number(row.id));
    const projects: Record<string, string> = Object.fromEntries(ordinary.map(task => [task, `P${(db.prepare('SELECT p.number FROM tasks t JOIN tasks p ON p.id = t.project_task_id WHERE t.number = ?').get(Number(task.slice(1))) as { number: number }).number}`]));
    return { history: number(longest.id), historyLogs: longest.n, ordinary, projects };
  } finally { db.close(); }
}

/** Gives one Task 40 children and another 60 files, through the CLI as a person does. */
function enrich(url: string, home: string, children: string, project: string, files: string) {
  const cli = (...argv: string[]) => execFileSync(process.execPath, [join(release, 'apps/cli/dist/cli.js'), '--server', url, ...argv],
    { env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_'))), HOME: home }, encoding: 'utf8' });
  const plan = join(home, 'children.json');
  writeFileSync(plan, JSON.stringify(Array.from({ length: 40 }, (_, n) => ({ title: `Measured child ${n + 1}` }))));
  // Only a Task's responsible makes its children: a person makes them beside it and moves them under it.
  const made = JSON.stringify(JSON.parse(cli('task', 'new', '--parent', project, '--no-from-user', '--plan-file', plan)));
  const ids = [...new Set(made.match(/"T\d+"/g)!.map(each => JSON.parse(each) as string))].filter(id => id !== children).slice(-40);
  for (const id of ids) {
    const hash = (JSON.parse(cli('task', 'get', '--task', id)) as { task: { hash: string } }).task.hash;
    cli('task', 'move', '--task', id, '--parent', children, '--expected-task-hash', hash);
  }
  const dir = join(home, 'files'), files_: { name: string; bytes: Buffer }[] = []; mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 60; n++) {
    const name = n % 3 === 0 ? `notes-${n}.md` : n % 3 === 1 ? `data-${n}.json` : `log-${n}.txt`;
    const file = join(dir, name);
    writeFileSync(file, n % 3 === 1 ? JSON.stringify({ n, rows: Array.from({ length: 20 }, (_, i) => ({ i, text: `row ${i}` })) }) : `# File ${n}\n\n${'Measured content line.\n'.repeat(40)}`);
    files_.push({ name, bytes: readFileSync(file) });
  }
  return files_;
}
/** Files are written as the screen writes them, a person's upload: the CLI writes only as a Run of the Task. */
async function upload(url: string, task: string, files: { name: string; bytes: Buffer }[]) {
  for (const { name, bytes } of files) {
    const response = await fetch(new URL(`/api/tasks/${task}/file?path=${encodeURIComponent(name)}`, url), { method: 'PUT', body: new Uint8Array(bytes),
      headers: { 'x-alpacawork-op-id': randomUUID(), 'X-Alpacawork-Content-Digest': createHash('sha256').update(bytes).digest('hex') } });
    if (!response.ok) throw new Error(`upload ${name}: ${response.status} ${await response.text()}`);
  }
}

async function serve(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
  const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((done, fail) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; const found = /http:\/\/[\w.:]+/.exec(text); if (found) done(found[0]); });
    child.once('exit', code => fail(new Error(`serve exited with ${code}: ${text}`)));
  });
  process.once('exit', () => child.kill('SIGKILL'));
  // A fresh serve can stall for seconds just after it starts: wait until it answers at once for 5s in a row.
  const began = Date.now(); let calm = Date.now();
  while (Date.now() - calm < 5000 && Date.now() - began < 45_000) {
    const asked = Date.now(); await (await fetch(new URL('/api/task/view?task=T2', url))).text();
    if (Date.now() - asked > 300) calm = Date.now();
    await new Promise(done => setTimeout(done, 100));
  }
  return { url, close: () => new Promise<void>(done => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.kill('SIGTERM'); }) };
}

const installProbe = (page: Page) => page.addInitScript(() => {
  const probe: Probe = window.switchProbe = { press: null, commits: 0, lastCommit: 0, loaf: [], motion: [] };
  const reader = () => document.querySelector('aside[data-reader-mode]');
  const frame = () => {
    const press = probe.press, now = performance.now();
    if (press) {
      const box = reader(), shown = box?.querySelector('header [data-reader-task-id]')?.textContent === press.id;
      if (shown) {
        press.headerAt ??= now;
        if (box!.querySelector('[data-report-key]')) press.bodyAt ??= now;
        if (box!.querySelector('[data-report-feed][data-history-ready="true"]')) press.readyAt ??= now;
      }
      // Quiet: readable, nothing moving, and no React commit for 300ms.
      if (press.readyAt && !press.quietAt && now - probe.lastCommit > 300
        && !document.getAnimations().some(each => each.playState === 'running')) press.quietAt = Math.max(probe.lastCommit, press.readyAt);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('pointerdown', event => {
    const row = event.target instanceof Element && event.target.closest('[data-read]');
    if (row) probe.press = { id: row.getAttribute('data-read')!, at: event.timeStamp, headerAt: null, bodyAt: null, readyAt: null, quietAt: null };
  }, true);
  try { new PerformanceObserver(list => { for (const each of list.getEntries() as any[]) probe.loaf.push({ start: each.startTime, duration: each.duration,
    styleLayout: each.styleAndLayoutStart ? each.startTime + each.duration - each.styleAndLayoutStart : 0,
    scripts: each.scripts.map((script: any) => ({ ms: script.duration, what: `${script.invokerType} ${script.invoker} ${script.sourceFunctionName}` })) }); })
    .observe({ type: 'long-animation-frame', buffered: false }); } catch { /* unsupported */ }
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (frames, options) {
    const ms = typeof options === 'number' ? options : Number(options?.duration ?? 0);
    probe.motion.push({ at: performance.now(), what: this.getAttributeNames().filter(name => name.startsWith('data-')).slice(0, 2).join(',') || this.tagName.toLowerCase(), ms });
    return animate.call(this, frames, options);
  };
  document.addEventListener('transitionrun', event => probe.motion.push({ at: performance.now(), what: `transition ${event.propertyName}`,
    ms: parseFloat(getComputedStyle(event.target as Element).transitionDuration) * 1000 || 0 }), true);
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: { renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
    inject() { return 1; }, onCommitFiberRoot() { probe.commits++; probe.lastCommit = performance.now(); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {} } });
});

const metricsOf = async (cdp: CDPSession) => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(each => [each.name, each.value]));
const quiet = async (page: Page, ms = 1200, limit = 15_000) => {
  const began = Date.now(); let last = -1, at = Date.now();
  while (Date.now() - began < limit) {
    const commits = await page.evaluate(() => window.switchProbe.commits);
    if (commits !== last) { last = commits; at = Date.now(); }
    if (Date.now() - at >= ms) return; await page.waitForTimeout(150);
  }
};

async function press(page: Page, cdp: CDPSession, id: string, narrow: boolean) {
  const row = page.locator(`[data-time-tree] [data-read="${id}"]`).first();
  await row.scrollIntoViewIfNeeded();
  await quiet(page, 800);
  await page.evaluate(() => { const probe = window.switchProbe; probe.press = null; probe.loaf = []; probe.motion = []; performance.clearResourceTimings(); });
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  if (args.cpu) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 250 }); await cdp.send('Profiler.start'); }
  const before = await metricsOf(cdp);
  if (narrow) await row.tap(); else await row.click();
  await page.waitForFunction(() => window.switchProbe.press?.quietAt, null, { timeout: 30_000, polling: 100 }).catch(() => undefined);
  const after = await metricsOf(cdp);
  let hot: [string, number][] = [];
  if (args.cpu) {
    const { profile } = await cdp.send('Profiler.stop') as any;
    const nodes = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node])), self = new Map<number, number>();
    profile.samples.forEach((sample: number, at: number) => self.set(sample, (self.get(sample) ?? 0) + profile.timeDeltas[at] / 1000));
    const total = new Map<string, number>();
    const walk = (nodeId: number, path: Set<string>): number => { const node = nodes.get(nodeId), key = `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber}`;
      const fresh = !path.has(key); if (fresh) path.add(key); let sum = self.get(nodeId) ?? 0; for (const child of node.children ?? []) sum += walk(child, path);
      if (fresh) { path.delete(key); total.set(key, (total.get(key) ?? 0) + sum); } return sum; };
    walk(profile.nodes[0].id, new Set());
    hot = [...total].filter(([key]) => !/^\((root|idle|program)\)/.test(key)).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([key, ms]) => [key, Math.round(ms)]);
    await cdp.send('Profiler.disable');
  }
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const probe = await page.evaluate(() => {
    const { press, loaf, motion, commits } = window.switchProbe;
    const reads = performance.getEntriesByType('resource').filter(each => each.name.includes('/api/')).map(each => {
      const timing = each as PerformanceResourceTiming;
      return { path: new URL(each.name).pathname, start: timing.startTime, end: timing.responseEnd, waiting: timing.responseStart - timing.requestStart, bytes: timing.encodedBodySize };
    });
    return { press, loaf, motion, commits, reads, dom: document.getElementsByTagName('*').length };
  });
  const p = probe.press!, rel = (at: number | null) => at === null ? null : Math.round(at - p.at);
  const inWindow = probe.loaf.filter(each => each.start >= p.at - 50);
  const delta = (key: string) => Math.round(((after[key] ?? 0) - (before[key] ?? 0)) * 1000);
  const reads = probe.reads.filter(each => each.start >= p.at - 5).map(each => ({ ...each, start: rel(each.start), end: rel(each.end), waiting: Math.round(each.waiting) }));
  return {
    id: p.id, headerMs: rel(p.headerAt), bodyMs: rel(p.bodyAt), readyMs: rel(p.readyAt), quietMs: rel(p.quietAt),
    // Where the main thread went over the press (CDP: script, style, layout; the rest of its task time is paint, parse and other work).
    mainMs: { task: delta('TaskDuration'), script: delta('ScriptDuration'), style: delta('RecalcStyleDuration'), layout: delta('LayoutDuration') },
    layouts: Math.round((after.LayoutCount ?? 0) - (before.LayoutCount ?? 0)), styles: Math.round((after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0)),
    reads, readWaitMs: reads.length ? Math.max(...reads.map(each => each.end ?? 0)) : 0,
    longFrames: inWindow.length, longFrameMs: Math.round(inWindow.reduce((sum, each) => sum + each.duration, 0)),
    longestFrameMs: Math.round(Math.max(0, ...inWindow.map(each => each.duration))),
    motion: probe.motion.filter(each => each.at >= p.at - 5).map(each => ({ at: rel(each.at), what: each.what, ms: Math.round(each.ms) })),
    commits: probe.commits, dom: probe.dom, hot,
    topScripts: inWindow.flatMap(each => each.scripts).sort((a, b) => b.ms - a.ms).slice(0, 8).map(each => ({ ms: Math.round(each.ms), what: each.what })),
  };
}

const results: unknown[] = [];
const browser = await chromium.launch();
try {
  for (let round = 0; round < Number(args.rounds); round++) for (const width of args.widths.split(',').map(Number)) {
    const narrow = width < 700, root = join(out, `workspace-${round}-${width}`), home = join(out, `home-${round}-${width}`);
    rmSync(root, { recursive: true, force: true }); mkdirSync(home, { recursive: true });
    copyWorkspace(original.root, root);
    const chosen = chooseCases(root);
    const app = await serve(root);
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: narrow, isMobile: narrow, locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(30_000);
      await installProbe(page);
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      // Every section unfolded and shown whole, so each case's row can be pressed.
      const open = async () => {
        await page.goto(new URL('?agent=1', app.url).toString());
        await page.locator('[data-read]').first().waitFor();
        await quiet(page, 2000);
        for (const head of await page.locator('[data-time-tree] button[aria-expanded="false"]').all()) await head.click().catch(() => undefined);
        for (const more of await page.locator('[data-group-more] button[aria-expanded="false"]').all()) await more.click().catch(() => undefined);
        await quiet(page, 1500);
        return new Set(await page.locator('[data-time-tree] [data-read]').evaluateAll(rows => rows.map(row => row.getAttribute('data-read')!)));
      };
      const rows = await open();
      const shown = chosen.ordinary.filter(id => rows.has(id));
      if (shown.length < 4 || !rows.has(chosen.history)) throw new Error(`Rows not shown: ${chosen.history} ${shown.join(',')} of ${[...rows].slice(0, 40).join(',')}`);
      const [first, second, childrenTask, filesTask] = shown;
      await upload(app.url, filesTask!, enrich(app.url, home, childrenTask!, chosen.projects[childrenTask!]!, filesTask!));
      await open();
      const cases = [{ kind: 'ordinary', id: second! }, { kind: 'history', id: chosen.history }, { kind: 'children', id: childrenTask! }, { kind: 'files', id: filesTask! }];
      const back = async () => { if (narrow) { await page.keyboard.press('Escape'); await page.locator('aside[data-reader-mode]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => page.goBack()); await quiet(page, 800); } };
      // The detail starts open on an ordinary Task (a computer switches from it; a phone comes back to the list).
      await page.locator(`[data-time-tree] [data-read="${first}"]`).first().click(); await quiet(page, 1500); await back();
      for (const visit of ['cold', 'warm'] as const) for (const each of cases) {
        const measured = await press(page, cdp, each.id, narrow);
        results.push({ round, width, throttle, visit, kind: each.kind, ...measured });
        console.error(`[detail-switch] ${round} ${width} ${visit} ${each.kind} ${each.id}: header ${measured.headerMs} ready ${measured.readyMs} quiet ${measured.quietMs} reads ${measured.readWaitMs} main ${measured.mainMs.task}`);
        writeFileSync(join(out, 'results.json'), JSON.stringify({ release, throttle, cases: chosen, fixture: original.counts, results }, null, 1));
        await back();
      }
      await context.close();
    } finally { await app.close(); }
  }
} finally { clearTimeout(expiry); await browser.close(); }
