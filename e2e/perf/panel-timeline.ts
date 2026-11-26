/** Fixed-data browser measurement. Build with --mode profiling for named React counts.
 * node e2e/perf/panel-timeline.ts <output.json> counts|timing normal|heavy
 * PANEL_TRACE=1 keeps raw CDP traces next to the result.
 * Timing runs omit the fiber walk. Every server/browser is owned and closed here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { SAMPLE_NOW } from '../fixture/sample.ts';
import { conversation, startPanelFixture, preparePanel, ensureConversation, PANEL_DRAFT, readPanelDraft } from './panel-fixture.ts';
import { leaveBarMenu, stripsSwitch } from './bar-entries.ts';

type Fiber = { tag: number; flags: number; alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; type: unknown; actualDuration?: number };
type Phase = { commits: number; renders: number; byName: Record<string, number> };
type Probe = { phase: Phase; frames: number[]; long: number[]; last: number; observers: number; observerEntries: number; pointers: number; animations: { target: string; frames: unknown; options: unknown }[] };
declare global { interface Window { panelTimeline: Probe } }
const output = resolve(process.argv[2] ?? '/tmp/render-motion.json'), counts = process.argv[3] === 'counts';
mkdirSync(dirname(output), { recursive: true });
const fixture = process.argv[4] ?? 'normal';
const heavy = fixture === 'heavy';
const runtime = await startPanelFixture(heavy);
const browser = await chromium.launch().catch(async error => { await runtime.stop(); throw error; });
const results: unknown[] = [];
const expiry = setTimeout(() => { void browser.close().finally(() => runtime.stop()); }, 12 * 60_000);
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.clock.setFixedTime(new Date(SAMPLE_NOW));
    await page.route('**/api/coordinator', route => route.fulfill({ json: conversation }));

    await page.addInitScript((count) => {
      localStorage.setItem('alpacawork.coordinatorExtent', '240');
      const probe: Probe = window.panelTimeline = { phase: { commits: 0, renders: 0, byName: {} }, frames: [], long: [], last: 0, observers: 0, observerEntries: 0, pointers: 0, animations: [] };
      const frame = (at: number) => { if (probe.last) probe.frames.push(at - probe.last); probe.last = at; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      new PerformanceObserver(list => { probe.long.push(...list.getEntries().map(entry => entry.duration)); }).observe({ type: 'longtask' });
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        probe.animations.push({ target: this.getAttributeNames().filter(name => name.startsWith('data-')).join(','), frames, options });
        return animate.call(this, frames, options);
      };
      const Observer = window.ResizeObserver;
      window.ResizeObserver = class extends Observer {
        constructor(callback: ResizeObserverCallback) { super((entries, observer) => { probe.observers++; probe.observerEntries += entries.length; callback(entries, observer); }); }
      };
      addEventListener('pointermove', () => probe.pointers++, true);
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
      await page.evaluate(() => { window.panelTimeline.phase = { commits: 0, renders: 0, byName: {} }; window.panelTimeline.frames = []; window.panelTimeline.long = []; window.panelTimeline.animations = []; window.panelTimeline.last = 0; window.panelTimeline.observers = 0; window.panelTimeline.observerEntries = 0; window.panelTimeline.pointers = 0; });
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
      const probe = await page.evaluate(() => window.panelTimeline);
      const sorted = [...probe.frames].sort((a, b) => a - b);
      const time = (event: string) => trace.filter(item => item.name === event).reduce((sum, item) => sum + (item.dur ?? 0), 0) / 1000;
      results.push({ width, name, fixture, counts, observers: probe.observers, observerEntries: probe.observerEntries, pointers: probe.pointers, react: probe.phase, frames: { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)], p95: sorted[Math.floor(sorted.length * .95)], max: sorted.at(-1), over25: sorted.filter(ms => ms > 25).length },
        long: { count: probe.long.length, totalMs: probe.long.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...probe.long) },
        metrics: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'].map(key => [key, (after[key] ?? 0) - (before[key] ?? 0)])),
        trace: { layoutMs: time('Layout'), paintMs: time('Paint'), styleMs: time('UpdateLayoutTree') }, animations: probe.animations });
      writeFileSync(output, JSON.stringify({ version: 2, fixture, browser: browser.version(), counts, results }, null, 2));
      console.log(`${width} ${name}: renders=${probe.phase.renders} commits=${probe.phase.commits} taskMs=${Math.round(((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000)}`);
    };
    const shape = () => page.evaluate(() => {
      const rect = (selector: string) => { const el = document.querySelector<HTMLElement>(selector); if (!el) return null; const b = el.getBoundingClientRect(); return { x:b.x, y:b.y, width:b.width, height:b.height, scroll:el.scrollTop }; };
      const input = document.querySelector<HTMLElement>('[data-one-input]');
      return { reader:rect('[data-reader-mode]'), content:rect('[data-reader-content]'), list:rect('[data-time-tree]'), sheet:rect('[data-sheet]:has([data-reader-mode])'), active: document.activeElement?.getAttributeNames().filter(n => n.startsWith('data-')),
        conversation:!!document.querySelector('[data-coordinator-panel]'), draft:input?.innerText, selection:input?.contains(document.getSelection()?.anchorNode ?? null) ? [document.getSelection()?.anchorOffset,document.getSelection()?.focusOffset] : null,
        reports: document.querySelectorAll('[data-report-key]').length, images:[...document.querySelectorAll<HTMLImageElement>('[data-reader-content] img')].map(el=>({complete:el.complete,width:el.naturalWidth})),
        videos:[...document.querySelectorAll<HTMLVideoElement>('[data-reader-content] video')].map(el=>({ready:el.readyState,paused:el.paused})) };
    });
    let positions: unknown[] = [];
    const dragReader = async () => {
      const box = await page.locator('[data-reader-width]').boundingBox(); if (!box) throw Error('No width edge');
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + 8, y); await page.mouse.down();
      for (const x of [820, 700, 576, 480, 576, 700, 820, 900, 820]) {
        await page.mouse.move(x, y, { steps: 4 });
        if (counts) positions.push({ pointer:x, shape:await shape() });
      }
      await page.mouse.up();
    };
    const dragSheet = async () => {
      const box = await page.locator('[data-task-sheet-grip]').boundingBox(); if (!box) throw Error('No sheet grip');
      const x = width / 2, y = box.y + box.height / 2;
      if (!await page.locator('[data-task-sheet-grip]').evaluate((grip, at) => grip.contains(document.elementFromPoint(at.x, at.y)), { x, y }))
        throw Error('The sheet grip is not the actual touch target');
      await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x,y}] });
      for (let i=1;i<=24;i++) {
        const dy = i<=12 ? -i*8 : -(24-i)*8;
        await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[{x,y:y+dy}] }); await page.waitForTimeout(16);
        if (counts) positions.push({ pointer:y+dy, shape:await shape() });
      }
      await page.waitForTimeout(160);
      await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
      if (counts) {
        const heights = positions.map(value => (value as { shape: { sheet: { y: number } } }).shape.sheet.y);
        if (Math.max(...heights) - Math.min(...heights) < 60) throw Error('Touch failed to move the actual sheet');
      }
    };
    await page.goto(runtime.origin + '/?agent=1&strip=on');
    await page.locator('li[data-row]').first().waitFor(); await page.waitForTimeout(1200);
    if (heavy) {
      await ensureConversation(page, true);
    }
    await page.screenshot({ path:output+'.'+width+'.list.png' });
    for (let round=0; round<3; round++) {
      if (heavy) await ensureConversation(page);
      // Keep coordinates unobscured by the conversation; focus and the draft are retained in its surface.
      await run('detail-open-'+round, () => page.locator('[data-read="T111"]').first().click());
      await preparePanel(page, heavy);
      if (round===0) await page.screenshot({ path:output+'.'+width+'.detail.png' });
      // A phone's grip lives in its auto-hiding header. Read back to the top before taking that real grip.
      if (width < 900) {
        await page.locator('[data-reader-content]').evaluate(element => { element.scrollTop = 0; });
        await page.waitForTimeout(450);
      }
      if (heavy) await ensureConversation(page);
      if (round === 0) await page.screenshot({ path:output+'.'+width+'.resize-start.png' });
      positions = [];
      await run('detail-resize-'+round, width>900 ? dragReader : dragSheet);
      results.push({ width, fixture, name:'geometry-'+round, positions, shape:await shape(), counts });
      if (heavy && (!await page.locator('[data-coordinator-panel]').isVisible() || await readPanelDraft(page) !== PANEL_DRAFT))
        throw Error('The heavy resize did not retain the open conversation and its draft');
      await run('viewport-resize-'+round, async () => {
        for (const delta of [-40,-80,-120,-80,-40,0]) await page.setViewportSize({ width:width+delta, height:900 });
      });
      // Reading the media hides the phone header. Return to its top before pressing the visible close control.
      await page.locator('[data-reader-content]').evaluate(element => { element.scrollTop = 0; });
      await page.waitForTimeout(450);
      await run('detail-close-'+round, () => page.getByRole('button', { name:'Close details', exact:true }).click());
      if (width<900) {
        // Only the switch's press is measured; reaching it in the bar's menu and leaving the menu are not.
        const time = await stripsSwitch(page);
        await run('timeline-close-'+round, () => time.click());
        await run('timeline-open-'+round, () => time.click());
        await leaveBarMenu(page);
      }
      await run('timeline-zoom-'+round, async () => {
        await page.locator('[data-time-tree]').focus();
        for (const key of ['+','+','+','-','-','-']) { await page.keyboard.press(key); await page.waitForTimeout(35); }
      });
    }
    await context.close();
  }
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
