/** From a card answered (Done, Hold, a question's answer) to the next card read, frame by frame, on the real app.
 * node --import ./e2e/guard-loader.mjs e2e/perf/swipe-next.ts <output.json> [--throttle 4] [--rounds 3] [--widths 390,1440]
 *   [--kinds done,hold,answer] [--contents light,heavy] [--cold] [--profile] [--film] [--video] [--reduced]
 * Each width gets its own isolated serve with the fake coordinator and one project per kind and content: cards in the
 * person's turn (reviews, or questions to the person), each with its report history, and a picture in its newest report
 * (light: a few short reports; heavy: a long body and 120 reports). On a phone (390, touch) the card is swiped with a
 * finger moving at a real finger's pace (timestamps on every move); on a computer (1440) the same answer is pressed
 * (Done, H, the choice then send). One window per answer, split at the press, the release and the moment the next card
 * is read (its head names it, its history is drawn without placeholders, its pictures decoded): frame gaps, Long
 * Animation Frames, CDP layout/style/script, React commits and the animations drawn. --cold holds the next card's reads
 * until the finger lets go (a card the reader could not read ahead). Every serve and browser is closed here, with a
 * hard expiry. --headed opens installed Chrome in a window and prints `mark <width> <case> <epoch ms>` at each answer, to cut a
 * screen recording (ffmpeg x11grab on Xvfb) at the same moment for both versions. --trace keeps a Chrome trace per window
 * (PERF_TRACE_CATEGORIES picks its categories), --profile a CPU profile.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { ControlStore } from '@alpacawork/db';
import { start, type Runtime } from '../server.ts';
import { startFakeCoordinator } from '../coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview, taskFolder } from '../fixture/task-state.ts';
import { visibleReaderContentTop } from '../fixtures.ts';
import { commandFetch as fetch } from '../../tests/helpers/command-fetch.ts';
import { decideValues } from '../../tests/helpers/task-values.ts';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '4' }, rounds: { type: 'string', default: '3' }, widths: { type: 'string', default: '390,1440' },
  kinds: { type: 'string', default: 'done,hold,answer' }, contents: { type: 'string', default: 'light,heavy' },
  cold: { type: 'boolean', default: false }, profile: { type: 'boolean', default: false }, film: { type: 'boolean', default: false },
  video: { type: 'boolean', default: false }, trace: { type: 'boolean', default: false }, headed: { type: 'boolean', default: false }, reduced: { type: 'boolean', default: false },
} });
const output = resolve(positionals[0] ?? '/tmp/swipe-next.json');
const throttle = Number(args.throttle), rounds = Number(args.rounds);
mkdirSync(dirname(output), { recursive: true });
type Kind = 'done' | 'hold' | 'answer';
type Content = 'light' | 'heavy';

async function post(r: Runtime, path: string, body: object) {
  const response = await fetch(r.origin + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const QUESTION = decideValues(['色を選んでください', ['A 青', '青にする'], ['B 赤', '赤にする']]);
const section = (n: number) => `### 確認 ${n}\n結果の**要点**と読み物、表を含む報告です。前後を同じ条件で比べました。\n\n| 項目 | 値 |\n| --- | --- |\n| 確認 | 合格 |\n\n- 次の点検\n- 残りの作業\n\n`;
/** One project of `count` cards of `kind`, each with its history; returns its cards in the order the list shows. */
async function deck(r: Runtime, kind: Kind, content: Content, count: number) {
  const project = (await post(r, 'task/new', { kind: 'project', color: '#39659b', parent: 'none', title: `${kind}-${content}` })).task.id;
  const ids: string[] = [];
  const heavy = content === 'heavy';
  // The body is written straight to the record below: the command keeps a field to its size, and the heavy body is longer.
  const notes = Array.from({ length: heavy ? 30 : 2 }, (_, n) => section(n)).join('') + '![画面](screen.png)';
  for (let i = 0; i < count; i++) {
    const { task } = await post(r, 'task/new', { parent: project, title: `${kind} ${content} ${i + 1}`, ...kind === 'answer' ? { values: QUESTION } : {} });
    await post(r, 'agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
    copyFileSync(new URL('../fixture/wide-report.png', import.meta.url), taskFolder(r.root, task.id) + '/screen.png');
    const db = new ControlStore(r.root, { busyTimeoutMs: 1000 }, true);
    const placement = (() => { try { return db.read(sql => String(sql.prepare("SELECT id FROM placements WHERE task_id=? AND responsible=1").get(task.id)!.id)); } finally { db.close(); } })();
    const reports = heavy ? 120 : 4;
    const logs = Array.from({ length: reports }, (_, n) => ({ id: `${task.id}-log-${n}`, at: new Date(Date.now() - (reports - n) * 60_000 - 3600_000).toISOString(),
      kind: 'reported', title: `報告 ${n + 1}`, description: section(n).repeat(heavy ? 3 : 1) + (n === reports - 1 ? '![報告の画像](screen.png)\n' : ''),
      actor: { kind: 'placement', placementId: placement }, fromState: 'doing', toState: 'doing' }));
    patchTask(r.root, task.id, { state: 'doing', values: { notes }, logs });
    if (kind === 'answer') seedQuestion(r.root, task.id, { to: 'user' });
    else seedReview(r.root, task.id, { title: '確認できました', description: '結果を確かめてください。' });
    ids.push(task.id);
  }
  // The list shows the newest first: the reader goes on down it.
  return { project, ids: ids.reverse() };
}

/** Installed before load: absolute frame times, Long Animation Frames, React commits, the press and release, animations. */
async function installProbe(page: Page) {
  await page.addInitScript(() => {
    type Probe = { frames: number[]; loaf: { start: number; duration: number; blocking: number; styleLayout: number; scripts: string[] }[]; commits: number[];
      down: number; up: number; next: string; shown: number; readable: number; animations: { at: number; target: string; props: string[] }[] };
    const probe: Probe = (window as any).swipeProbe = { frames: [], loaf: [], commits: [], down: 0, up: 0, next: '', shown: 0, readable: 0, animations: [] };
    const read = () => {
      if (!probe.next || probe.readable) return;
      const head = document.querySelector('aside[data-reader-mode] header [data-reader-task-id]');
      if (head?.textContent?.trim() !== probe.next) return;
      if (!probe.shown) probe.shown = performance.now();
      const content = document.querySelector('aside[data-reader-mode] [data-reader-content]');
      if (!content || content.querySelector('[data-skeleton]') || !content.querySelector('[data-report-feed][data-history-ready="true"]')) return;
      if ([...content.querySelectorAll('img')].some(img => !img.complete || !img.naturalWidth)) return;
      probe.readable = performance.now();
    };
    (probe as any).mutations = [];
    new MutationObserver(list => { for (const each of list) { const el = each.target as HTMLElement;
      if (el.matches?.('.reader-reading, [data-reader-content], aside[data-reader-mode]')) (probe as any).mutations.push(`${Math.round(performance.now())} ${el.className.split(' ')[0]} ${each.attributeName}: ${String(each.oldValue).slice(0, 140)} -> ${String(el.getAttribute(each.attributeName!)).slice(0, 140)}`); } })
      .observe(document, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'inert', 'class'] });
    const frame = (at: number) => { probe.frames.push(at); read(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    addEventListener('pointerdown', event => { if (!probe.down) probe.down = event.timeStamp; }, true);
    addEventListener('keydown', event => { if (!probe.down) probe.down = event.timeStamp; }, true);
    addEventListener('pointerup', event => { probe.up = event.timeStamp; }, true);
    try { new PerformanceObserver(list => { for (const entry of list.getEntries() as any[]) probe.loaf.push({ start: entry.startTime, duration: entry.duration, blocking: entry.blockingDuration,
      styleLayout: entry.styleAndLayoutStart ? entry.startTime + entry.duration - entry.styleAndLayoutStart : 0,
      scripts: entry.scripts.map((each: any) => `${Math.round(each.duration)}ms ${each.invokerType} ${each.invoker} ${each.sourceFunctionName} ${String(each.sourceURL).split('/').pop()}:${each.sourceCharPosition}`) }); })
      .observe({ type: 'long-animation-frame', buffered: false }); } catch { /* unsupported */ }
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (frames, options) {
      const list = Array.isArray(frames) ? frames : frames ? [frames] : [];
      const props = [...new Set(list.flatMap(each => Object.keys(each ?? {}).filter(key => !['offset', 'easing', 'composite'].includes(key))))];
      probe.animations.push({ at: performance.now(), target: this.getAttributeNames().filter(each => each.startsWith('data-')).slice(0, 3).join(',') || this.tagName.toLowerCase(), props });
      return animate.call(this, frames, options);
    };
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: {
      renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
      inject() { return 1; }, onCommitFiberRoot() { probe.commits.push(performance.now()); performance.mark('react-commit'); },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
    } });
  });
}

/** A finger moving sideways from `from` by `dx` over `ms`, a move every 16ms with its own time, then let go while moving. */
async function finger(cdp: CDPSession, from: { x: number; y: number }, dx: number, ms = 260) {
  const t0 = Date.now() / 1000;
  const at = (s: number) => t0 + s / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...from, radiusX: 8, radiusY: 8 }], timestamp: at(0) });
  const steps = Math.round(ms / 16);
  for (let i = 1; i <= steps; i++) {
    // Eased like a hand: slow to start, fastest at the end, so it is still moving outward when it lets go.
    const p = i / steps, x = from.x + dx * p * p;
    const due = t0 * 1000 + i * 16 - Date.now();
    if (due > 0) await new Promise(done => setTimeout(done, due));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from.y + i * 0.3, radiusX: 8, radiusY: 8 }], timestamp: at(i * 16) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: at(steps * 16 + 8) });
}

const results: Record<string, unknown>[] = [];
// --headed: installed Chrome in a window (for a screen recording on Xvfb), English UI so no translate bar covers the page.
const browser = await chromium.launch(args.headed ? { headless: false, channel: 'chrome', args: ['--window-position=0,0', '--window-size=520,1000', '--lang=en-US'], env: { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US' } } : {});
const expiry = setTimeout(() => { console.error('expired'); process.exit(3); }, 30 * 60_000);
try {
  for (const width of args.widths.split(',').map(Number)) {
    const runtime = await start(undefined, startFakeCoordinator);
    try {
      const phone = width < 700;
      const decks: Record<string, { project: string; ids: string[] }> = {};
      for (const kind of args.kinds.split(',') as Kind[]) for (const content of args.contents.split(',') as Content[])
        decks[`${kind}-${content}`] = await deck(runtime, kind, content, rounds + 2);
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, deviceScaleFactor: phone ? 3 : 1, hasTouch: phone, isMobile: phone,
        locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block', reducedMotion: args.reduced ? 'reduce' : 'no-preference',
        ...(args.video ? { recordVideo: { dir: `${output}.video-${width}`, size: { width, height: phone ? 844 : 900 } } } : {}) });
      const page = await context.newPage();
      page.on('pageerror', error => console.error('pageerror', error.message));
      let posting = 0;
      page.on('request', request => { if (request.method() === 'POST') posting++; });
      page.on('requestfinished', request => { if (request.method() === 'POST') posting--; });
      page.on('requestfailed', request => { if (request.method() === 'POST') posting--; });
      page.on('response', async response => { if (new URL(response.url()).pathname === '/api/task/report' && response.status() !== 200) console.error('report', response.status(), (await response.text().catch(() => '')).slice(0, 400)); });
      await installProbe(page);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
      const reader = page.locator('aside[data-reader-mode]');
      const showing = () => reader.locator('[data-reader-task-id]').innerText();
      // Warm the app once (catalog, coordinator) outside every window.
      const first = Object.values(decks)[0]!;
      await page.goto(`${runtime.origin}/?agent=1&project=${first.project}&task=${first.ids.at(-1)}`);
      await reader.locator('[data-reader-task-id]').waitFor();
      await page.waitForTimeout(1500);
      for (const [name, { project, ids }] of Object.entries(decks)) {
        const kind = name.split('-')[0] as Kind;
        for (let round = 0; round < rounds; round++) {
          const from = ids[round]!, next = ids[round + 1]!;
          // --cold: the next card's reads wait until the answer is given (a card not read ahead).
          let opened: () => void = () => {};
          if (args.cold) {
            const gate = new Promise<void>(done => { opened = done; });
            await page.route(url => url.pathname.startsWith('/api/task/') && url.searchParams.get('task') === next, async route => { await gate; await route.continue().catch(() => {}); });
          }
          await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${from}`);
          await reader.locator('[data-reader-task-id]').filter({ hasText: from }).waitFor();
          await reader.locator('[data-report-feed][data-history-ready="true"]').waitFor({ timeout: 15_000 });
          await page.waitForTimeout(1200);
          if (kind === 'answer') {
            await reader.locator('[data-question="1"]').getByRole('button', { name: /A 青/ }).click();
            await page.waitForTimeout(600);
          }
          await page.waitForTimeout(400);
          if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
          if (args.profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
          const before = await metrics();
          const traced: any[] = [];
          const collect = (data: { value: any[] }) => { traced.push(...data.value); };
          if (args.trace) { cdp.on('Tracing.dataCollected', collect); await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: (process.env.PERF_TRACE_CATEGORIES ?? 'devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing').split(',') } }); }
          await page.evaluate(id => Object.assign((window as any).swipeProbe, { mutations: [], frames: [], loaf: [], commits: [], animations: [], down: 0, up: 0, shown: 0, readable: 0, next: id }), next);
          const screencast: { at: number; data: string }[] = [];
          const shot = (each: { data: string; sessionId: number; metadata: { timestamp?: number } }) => { screencast.push({ at: each.metadata.timestamp ?? 0, data: each.data }); void cdp.send('Page.screencastFrameAck', { sessionId: each.sessionId }).catch(() => {}); };
          if (args.film) { cdp.on('Page.screencastFrame', shot); await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 }); await page.waitForTimeout(150); screencast.length = 0; }
          if (args.headed) console.log(`mark ${width} ${name}-${round} ${Date.now()}`);
          if (phone) {
            const box = (await reader.locator('[data-reader-content]').boundingBox())!;
            const y = await visibleReaderContentTop(reader) + 120;
            const right = kind !== 'hold';
            await finger(cdp, { x: box.x + (right ? 70 : box.width - 70), y }, right ? 230 : -230);
          } else if (kind === 'done') await reader.locator('[data-task-done]').first().click().catch(() => page.locator('[data-task-done]').first().click());
          else if (kind === 'hold') { await reader.locator('[data-reader-task-id]').click(); await page.keyboard.press('h'); }
          else await page.locator('[data-ask-send]').first().click();
          if (args.cold) { await page.waitForTimeout(150); opened(); }
          await page.waitForFunction(() => (window as any).swipeProbe.readable > 0, undefined, { timeout: 20_000, polling: 100 }).catch(() => console.error(`${name}-${round}: never read`));
          await page.waitForTimeout(500);
          const after = await metrics();
          let hot: { fn: string; selfMs: number }[] = [];
          if (args.profile) {
            const { profile } = await cdp.send('Profiler.stop');
            writeFileSync(`${output}.${width}-${name}-${round}.cpuprofile`, JSON.stringify(profile));
            const self = new Map<number, number>();
            profile.samples!.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas![i] ?? 0) / 1000));
            const agg = new Map<string, number>();
            for (const node of profile.nodes) { const f = node.callFrame; const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; agg.set(key, (agg.get(key) ?? 0) + (self.get(node.id) ?? 0)); }
            hot = [...agg].map(([fn, selfMs]) => ({ fn, selfMs })).filter(v => !/^\((idle|program|root)\)/.test(v.fn)).sort((a, b) => b.selfMs - a.selfMs).slice(0, 30);
            await cdp.send('Profiler.disable');
          }
          if (args.film) {
            await cdp.send('Page.stopScreencast'); cdp.off('Page.screencastFrame', shot);
            const dir = `${output}.film/${width}-${name}-${round}`; mkdirSync(dir, { recursive: true });
            const t0 = screencast[0]?.at ?? 0;
            for (const each of screencast) writeFileSync(`${dir}/${String(Math.round((each.at - t0) * 1000)).padStart(5, '0')}.jpg`, Buffer.from(each.data, 'base64'));
          }
          if (args.trace) {
            const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
            await cdp.send('Tracing.end'); await done; cdp.off('Tracing.dataCollected', collect);
            writeFileSync(`${output}.${width}-${name}-${round}.trace.json`, JSON.stringify({ traceEvents: traced }));
          }
          if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
          if (args.cold) await page.unrouteAll({ behavior: 'wait' });
          const probe = await page.evaluate(() => (window as any).swipeProbe);
          const toasts = await page.locator('[data-toast][data-kind="error"]').allInnerTexts();
          if (toasts.length) console.error(`${name}-${round}: error toast: ${toasts.join(' / ')}`);
          const now = await showing(); const moved = now === next; if (!moved) console.error(`${name}-${round}: from ${from} expected ${next} showing ${now} ids ${ids.join(',')}`);
          // Phases: following the finger (press to release), leaving (release to the next card shown), reading (shown to readable).
          const down = probe.down, up = phone ? probe.up : probe.down;
          const phase = (a: number, b: number) => {
            const gaps = probe.frames.filter((t: number, i: number) => i > 0 && t > a && t <= b).map((t: number) => t - probe.frames[probe.frames.indexOf(t) - 1]);
            const loaf = probe.loaf.filter((each: any) => each.start + each.duration > a && each.start < b);
            return { ms: Math.round(b - a), frames: gaps.length, missed: gaps.reduce((s: number, g: number) => s + Math.max(0, Math.round(g / 16.67) - 1), 0),
              max: Math.round(Math.max(0, ...gaps)), loafMs: Math.round(loaf.reduce((s: number, e: any) => s + e.duration, 0)),
              blockingMs: Math.round(loaf.reduce((s: number, e: any) => s + e.blocking, 0)), commits: probe.commits.filter((t: number) => t > a && t <= b).length };
          };
          const end = probe.readable || probe.frames.at(-1);
          const settle = Math.max(end, up + 900);
          const result = { width, kind, content: name.split('-')[1], round, throttle, cold: args.cold, reduced: args.reduced, moved,
            toShown: probe.shown ? Math.round(probe.shown - down) : null, toReadable: probe.readable ? Math.round(probe.readable - down) : null,
            follow: phone ? phase(down, up) : null, leave: phase(up, up + 900), whole: phase(down, settle),
            cdp: { taskMs: Math.round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000), scriptMs: Math.round(((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000),
              layoutMs: Math.round(((after.LayoutDuration ?? 0) - (before.LayoutDuration ?? 0)) * 1000), styleMs: Math.round(((after.RecalcStyleDuration ?? 0) - (before.RecalcStyleDuration ?? 0)) * 1000),
              layouts: (after.LayoutCount ?? 0) - (before.LayoutCount ?? 0), styles: (after.RecalcStyleCount ?? 0) - (before.RecalcStyleCount ?? 0), nodes: after.Nodes },
            loafs: probe.loaf.filter((each: any) => each.start >= down - 50 && each.start < settle).map((each: any) => ({ at: Math.round(each.start - down), ms: Math.round(each.duration), styleLayout: Math.round(each.styleLayout), scripts: each.scripts.slice(0, 4) })),
            animations: probe.animations.map((each: any) => `${Math.round(each.at - down)} ${each.target}:${each.props.join('+')}`), hot };
          if (process.env.PERF_MUTATIONS) console.log((probe.mutations as string[]).map(each => `${Math.round(Number(each.split(' ')[0]) - down)} ${each.slice(each.indexOf(' ') + 1)}`).join('\n'));
          // The answer's own write finishes before the next round loads the page again.
          for (let waited = 0; posting > 0 && waited < 10_000; waited += 100) await page.waitForTimeout(100);
          results.push(result);
          writeFileSync(output, JSON.stringify({ version: 1, browser: browser.version(), throttle, results }, null, 2));
          console.log(`${width} ${name}-${round}${moved ? '' : ' (stayed)'}: follow=${JSON.stringify(result.follow && { missed: result.follow.missed, max: result.follow.max })} leave missed=${result.leave.missed} max=${result.leave.max} loaf=${result.leave.loafMs} | whole missed=${result.whole.missed} shown=${result.toShown} readable=${result.toReadable} layouts=${result.cdp.layouts} layoutMs=${result.cdp.layoutMs} styleMs=${result.cdp.styleMs} task=${result.cdp.taskMs}`);
        }
      }
      await context.close();
    } finally { await runtime.stop(); }
  }
} finally { clearTimeout(expiry); await browser.close(); }
