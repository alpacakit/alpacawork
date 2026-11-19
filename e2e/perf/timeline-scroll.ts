/** Real fixture, native wheel, SVG and request chronology; run under the shared measurement lock + test queue. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { start } from '../server.ts';
import { seedTimelineScroll } from '../fixture/timeline-scroll.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';

const output = resolve(process.argv[2]!); mkdirSync(output, { recursive: true });
const width = Number(process.argv[3] ?? 1440), delay = Number(process.argv[4] ?? 0);
const runtime = await start(undefined, seedTimelineScroll, join(output, 'server'));
const browser = await chromium.launch().catch(async error => { await runtime.stop(); throw error; });
const expiry = setTimeout(() => { void browser.close(); }, 180_000);
const results: any = { width, delay, origin: runtime.origin, requests: [], phases: [] };
const save = () => writeFileSync(join(output, 'raw.json'), JSON.stringify(results, null, 2));
let activeContext: BrowserContext | undefined, activePage: Page | undefined;
try {
  const context = activeContext = await browser.newContext({ viewport: { width, height: 900 }, locale: 'en-US', timezoneId: 'Asia/Tokyo',
    serviceWorkers: 'block', recordVideo: { dir: join(output, 'video'), size: { width, height: 900 } } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = activePage = await context.newPage(); results.videoStarted = Date.now(); page.setDefaultTimeout(12000);
  await page.clock.setFixedTime(new Date(SAMPLE_NOW));
  let delayed = false;
  await page.route('**/api/task/timeline?**', async route => {
    const row: any = { url: route.request().url(), start: Date.now(), delayed: delayed && delay > 0 };
    results.requests.push(row);
    try {
      const response = await route.fetch(); row.received = Date.now();
      if (delayed && delay) await new Promise(r => setTimeout(r, delay));
      await route.fulfill({ response }); row.fulfilled = Date.now();
    } catch (error) { row.error = String(error); }
  });
  page.on('pageerror', error => { (results.errors ??= []).push(String(error)); });
  await page.goto(runtime.origin + '/?agent=1&task=T2063&zoom=21600000');
  if (width < 900) {
    await page.locator('[data-reader-frame-buttons] button').last().click();
    const time = page.locator('header [data-strips]');
    if (await time.getAttribute('aria-pressed') !== 'true') await time.click();
  }
  await page.locator('[data-group-more=review] button').waitFor();
  if (await page.locator('[data-group-more=review] button').getAttribute('aria-expanded') !== 'true')
    await page.locator('[data-group-more=review] button').click();
  await page.waitForTimeout(900);
  await page.locator('[data-time-tree]').evaluate(el => { el.scrollTop = 0; });
  await page.locator('[data-row="T2063"] [data-mark]').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(output, 'initial.png') });
  await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('[data-time-tree]')!;
    const data: any = { frames: [], mutations: [], phase: 'start', running: true };
    (window as any).scrollProbe = data;
    const snapshot = () => {
      const box = sheet.getBoundingClientRect();
      return [...sheet.querySelectorAll<HTMLElement>('[data-row-head]')].flatMap(row => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom < box.top + 55 || rect.top > box.bottom - 5) return [];
        const svg = row.querySelector('[data-time-strip]');
        return [{ id: row.parentElement!.dataset.row, y: rect.y, shapes: svg?.querySelectorAll('path,line,rect,polyline,circle').length ?? 0,
          marks: svg?.querySelectorAll('[data-mark]').length ?? 0, paths: [...svg?.querySelectorAll('path') ?? []].map(p => p.getAttribute('d')) }];
      });
    };
    const observer = new MutationObserver(records => data.mutations.push({ at: performance.now(), phase: data.phase,
      records: records.length, rows: snapshot() }));
    observer.observe(sheet, { childList: true, subtree: true, attributes: true, attributeFilter: ['d', 'class'] });
    const step = (at: number) => {
      data.frames.push({ at, phase: data.phase, top: sheet.scrollTop, rows: snapshot() });
      if (data.running) requestAnimationFrame(step); else observer.disconnect();
    };
    requestAnimationFrame(step);
  });
  const sheet = await page.locator('[data-time-tree]').boundingBox();
  results.sheet = sheet;
  results.pointer = { x: sheet!.x + Math.min(sheet!.width - 50, 440), y: sheet!.y + 300 };
  await page.mouse.move(results.pointer.x, results.pointer.y);
  delayed = true;
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const phase = async (name: string, dy: number, count: number, interval: number) => {
    const started = Date.now();
    await page.waitForTimeout(1000);
    await page.evaluate(name => { (window as any).scrollProbe.phase = name; }, name);
    const before = await metric();
    for (let n = 0; n < count; n++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(interval); }
    await page.waitForTimeout(600);
    results.phases.push({ name, started, ended: Date.now(), dy, count, interval, before, after: await metric() }); save();
    await page.screenshot({ path: join(output, name + '.png') });
  };
  await phase('down-slow', 65, 14, 90);
  await phase('up-fast', -220, 5, 45);
  await phase('down-fast', 220, 6, 45);
  await phase('up-slow', -65, 18, 90);
  await page.evaluate(() => { (window as any).scrollProbe.running = false; });
  results.probe = await page.evaluate(() => (window as any).scrollProbe);
  await context.tracing.stop({ path: join(output, 'trace.zip') });
  const video = page.video()!; await context.close(); await video.saveAs(join(output, 'raw.webm'));
} catch (error) {
  results.failure = String(error);
  if (activePage && !activePage.isClosed()) { await activePage.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    writeFileSync(join(output, 'failure.html'), await activePage.content()); }
  await activeContext?.tracing.stop({ path: join(output, 'failure-trace.zip') }).catch(() => {});
  throw error;
} finally {
  await activeContext?.close();
  save(); clearTimeout(expiry); await browser.close(); await runtime.stop();
  writeFileSync(join(output, 'cleanup.json'), JSON.stringify({ pid: process.pid, stopped: true, at: new Date().toISOString() }));
}
