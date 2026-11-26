/** Fixed-data browser measurement. Build with --mode profiling for named React counts.
 * node e2e/perf/render-motion.ts <output.json> [counts]
 * PANEL_TRACE=1 keeps raw CDP traces; PANEL_VIDEO=1 records the interaction sequence.
 * Timing runs omit the fiber walk. Every server/browser is owned and closed here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';
import { coordinatorConversationSchema } from '@alpacawork/contract/coordinator';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}

type Fiber = { tag: number; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; type: unknown; actualDuration?: number };
type Phase = { commits: number; renders: number; byName: Record<string, number> };
type Probe = { phase: Phase; frames: number[]; long: number[]; last: number; animations: { target: string; frames: unknown; options: unknown }[] };
declare global { interface Window { renderMotion: Probe } }
const output = resolve(process.argv[2] ?? '/tmp/render-motion.json'), counts = process.argv[3] === 'counts';
mkdirSync(dirname(output), { recursive: true });
const conversation = coordinatorConversationSchema.parse({ id: 'render-motion', nextLaunch: { agent: 'claude', values: {} }, busy: false, earlier: null, resets: [], context: null, autoReset: { tokens: 200_000, percent: 50 },
  turns: [...Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    ask: `Measurement request ${i}`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,

    answer: Array.from({ length: 25 }, (_, n) => `### Item ${n}\nText with explanations and **checks**. Compare load under the same conditions.\n\n- Result ${n}\n- Next review\n\n`).join(''),
    answeredAt: `2026-01-01T00:${String(i).padStart(2, '0')}:30Z` })), ...Array.from({ length: 3 }, (_, i) => ({
      id: `waiting-${i}`, at: `2026-01-01T01:0${i}:00Z`, ask: `Queued measurement ${i}`, attachments: [],
      status: 'queued' as const, waiting: true, seen: true, error: null, result: null, answer: null, answeredAt: null,
    }))] });
const runtime = await start();
const browser = await chromium.launch().catch(async error => { await runtime.stop(); throw error; });
const results: unknown[] = [];
const expiry = setTimeout(() => { void browser.close().finally(() => runtime.stop()); }, 12 * 60_000);
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block',
      ...(process.env.PANEL_VIDEO ? { recordVideo: { dir: output + '.videos', size: { width, height: 900 } } } : {}) });
    const page = await context.newPage();
    page.on('pageerror', error => console.error('pageerror', error.message));
    await page.clock.setFixedTime(new Date(SAMPLE_NOW));
    await page.route('**/api/coordinator', route => route.fulfill({ json: conversation }));

    await page.addInitScript((count) => {
      const probe: Probe = window.renderMotion = { phase: { commits: 0, renders: 0, byName: {} }, frames: [], long: [], last: 0, animations: [] };
      const frame = (at: number) => { if (probe.last) probe.frames.push(at - probe.last); probe.last = at; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      new PerformanceObserver(list => { probe.long.push(...list.getEntries().map(entry => entry.duration)); }).observe({ type: 'longtask' });
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        probe.animations.push({ target: this.getAttributeNames().filter(name => name.startsWith('data-')).join(','), frames, options });
        return animate.call(this, frames, options);
      };
      if (!count) return;
      const componentTags = new Set([0, 1, 11, 14, 15]);
      const named = (value: unknown): string => {
        if (typeof value === 'function') return value.name;
        if (value && typeof value === 'object') {
          if ('displayName' in value && typeof value.displayName === 'string') return value.displayName;
          if ('type' in value) return named(value.type);
          if ('render' in value) return named(value.render);
        }
        return 'Anonymous';
      };
      const walk = (fiber: Fiber) => {
        if (componentTags.has(fiber.tag) && (!fiber.alternate || (fiber.flags & 1))) {
          const name = named(fiber.type), phase = probe.phase;
          phase.byName[name] = (phase.byName[name] ?? 0) + 1; phase.renders++;
        }
        if (fiber.alternate && fiber.alternate.child === fiber.child) return;
        for (let child = fiber.child; child; child = child.sibling) walk(child);
      };
      Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: {
        renderers: new Map(), supportsFiber: true, isDisabled: false, checkDCE() {},
        inject() { return 1; }, onCommitFiberRoot(_id: number, root: { current: Fiber }) { probe.phase.commits++; walk(root.current); },
        onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
      } });
    }, counts);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    const run = async (name: string, work: () => Promise<unknown>) => {
      await page.waitForTimeout(400);
      const before = await metrics();
      await page.evaluate(() => { window.renderMotion.phase = { commits: 0, renders: 0, byName: {} }; window.renderMotion.frames = []; window.renderMotion.long = []; window.renderMotion.animations = []; window.renderMotion.last = 0; });
      await cdp.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReportEvents' });
      const trace: { name?: string; dur?: number }[] = [];
      const collect = (event: { value: { name?: string; dur?: number }[] }) => trace.push(...event.value);
      cdp.on('Tracing.dataCollected', collect);
      try { await work(); } catch (error) { await page.screenshot({ path: output + '.failure.png' }); writeFileSync(output + '.failure.html', await page.content()); throw error; }
      await page.waitForTimeout(450);
      const ended = new Promise<void>(done => cdp.once('Tracing.tracingComplete', () => done()));
      await cdp.send('Tracing.end'); await ended; cdp.off('Tracing.dataCollected', collect);
      if (process.env.PANEL_TRACE) writeFileSync(`${output}.${width}.${name}.trace.json`, JSON.stringify({ traceEvents: trace }));
      const after = await metrics();
      const probe = await page.evaluate(() => window.renderMotion);
      const sorted = [...probe.frames].sort((a, b) => a - b);
      const time = (event: string) => trace.filter(item => item.name === event).reduce((sum, item) => sum + (item.dur ?? 0), 0) / 1000;
      results.push({ width, name, counts, react: probe.phase, frames: { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1), over25: sorted.filter(ms => ms > 25).length },
        long: { count: probe.long.length, totalMs: probe.long.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...probe.long) },
        metrics: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)])),
        trace: { layoutMs: time('Layout'), paintMs: time('Paint'), styleMs: time('UpdateLayoutTree'), layerizeMs: time('Layerize') }, animations: probe.animations });
      writeFileSync(output, JSON.stringify({ version: 1, browser: browser.version(), counts, results }, null, 2));
      console.log(`${width} ${name}: renders=${probe.phase.renders} commits=${probe.phase.commits} taskMs=${Math.round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000)}`);
    };
    await page.goto(`${runtime.origin}/?agent=1`);
    try { await page.locator('li[data-row]').first().waitFor(); }
    catch (error) { await page.screenshot({ path: output + '.initial-failure.png' }); writeFileSync(output + '.initial-failure.html', await page.content()); await context.close(); throw error; }
    await page.waitForTimeout(1500);
    console.log('ready', JSON.stringify(await page.evaluate(() => ({ text: document.querySelector('[data-coordinator-capsule]')?.textContent, disabled: document.querySelector('[data-coordinator-write]')?.hasAttribute('disabled') }))));
    console.log('writable', (await (await page.request.get(runtime.origin + '/api/workspace/live')).json()).writable);
    await page.locator('[data-coordinator-expand]').first().click();
    await page.locator('[data-one-input]').waitFor();
    await foldChat(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
    await page.screenshot({ path: output + '.' + width + '.folded.png' });
    for (let round = 0; round < 3; round++) {
      await run(`queue-folded-open-${round}`, () => page.locator('[data-coordinator-queue-button]:visible').click());
      if (!round) await page.screenshot({ path: output + '.' + width + '.queue.png' });
      await run(`queue-folded-close-${round}`, () => page.locator('[data-coordinator-queue-fold]').click());
      await run(`input-open-${round}`, () => page.locator('[data-coordinator-write]').click());
      await run(`input-type-${round}`, () => page.locator('[data-one-input]').pressSequentially('Measurement draft', { delay: 30 }));
      if (!round) await page.screenshot({ path: output + '.' + width + '.input.png' });
      await run(`input-close-${round}`, () => page.keyboard.press('Escape'));
      await run(`chat-open-${round}`, () => page.locator('[data-coordinator-expand]').first().click());
      await page.locator('[data-ask-answer]').first().waitFor({ state: 'attached' });
      if (!round) await page.screenshot({ path: output + '.' + width + '.chat.png' });
      await run(`queue-chat-open-${round}`, () => page.locator('[data-coordinator-queue-button]:visible').click());
      await run(`queue-chat-close-${round}`, () => page.locator('[data-coordinator-queue-fold]').click());
      await run(`chat-close-${round}`, () => foldChat(page));
      await page.keyboard.press('Escape');
      await run(`list-scroll-${round}`, async () => {
        const box = await page.locator('[data-time-tree]').boundingBox();
        if (!box) throw Error('No tree');
        await page.mouse.move(box.x + box.width / 2, box.y + 150); await page.mouse.wheel(0, 500); await page.waitForTimeout(150); await page.mouse.wheel(0, -500);
      });
      await run(`list-update-${round}`, async () => {
        patchTask(runtime.root, 'T111', { values: { notes: `Measurement ${width} ${round}\n\nUpdate under fixed conditions.` } });
        await page.waitForTimeout(600);
      });
      await run(`detail-open-${round}`, () => page.locator('[data-read="T111"]').first().click());
      await page.locator('[data-reader-content] [data-report-feed]').waitFor();
      await run(`detail-close-${round}`, () => page.getByRole('button', { name: 'Close details', exact: true }).click());
    }
    await context.close();
  }
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
