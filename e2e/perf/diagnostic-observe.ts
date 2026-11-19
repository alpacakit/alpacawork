import { measureHost } from '@alpacawork/core/host-measurement';
import { startPackagedServer } from './packaged-server.ts';
/** One isolated round, built backend/browser only, common synthetic perf copy. */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { release: { type: 'string' }, root: { type: 'string' }, out: { type: 'string' } } });
if (!values.release || !values.root || !values.out) throw Error('release/root/out required');
const app = await startPackagedServer(values.release, values.root, 0), browser = await chromium.launch();
const result: Record<string, unknown> = { release: values.release, root: values.root, pid: process.pid, node: process.version, at: new Date().toISOString() };
let success = false;
try {
  const page = await browser.newPage(), cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const errors: string[] = [], posts: number[] = [], warnings: string[] = [], failedRequests: unknown[] = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('requestfailed', request => failedRequests.push({ path: new URL(request.url()).pathname, failure: request.failure() }));
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (new URL(response.url()).pathname === '/__dev-performance') posts.push(response.status()); });
  const warmup = performance.now();
  await fetch(new URL('/api/workspace/live', app.url));
  await fetch(new URL('/api/task/view?task=T2', app.url));
  await page.waitForTimeout(3000);
  result.serverWarmupMs = performance.now() - warmup;
  const host = measureHost(values.root), serverBefore = host.supported ? host.read().processes.get(app.pid) : undefined;
  const cpu = process.cpuUsage(), began = performance.now();
  await page.goto(app.url);
  await page.getByText('Synthetic development project', { exact: true }).first().waitFor();
  result.firstVisibleMs = performance.now() - began;
  const before = await cdp.send('Performance.getMetrics');
  const frameWindow = page.evaluate(() => new Promise<number[]>(done => {
    const gaps: number[] = []; let last = performance.now(); const start = last;
    const tick = (now: number) => { if (now >= last) gaps.push(now - last); last = now; if (now - start >= 12_000) done(gaps); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  // Same read/open/back/scroll sequence for both editions. No API writes or agents.
  for (let n = 0; n < 3; n++) {
    await page.getByText('Synthetic development project', { exact: true }).first().click();
    await page.waitForTimeout(300); await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300); await page.keyboard.press('Escape');
    await page.waitForTimeout(300); await page.mouse.wheel(0, -600);
    await page.waitForTimeout(300);
  }
  result.frameGapsMs = await frameWindow;
  const after = await cdp.send('Performance.getMetrics');
  const metric = (set: typeof after, name: string) => set.metrics.find((metric: { name: string; value: number }) => metric.name === name)?.value ?? null;
  const first = metric(before, 'TaskDuration'), last = metric(after, 'TaskDuration');
  result.browserTaskMs = first === null || last === null ? null : (last - first) * 1000;
  result.browserHeapBytes = metric(after, 'JSHeapUsedSize');
  const serverAfter = host.supported ? host.read().processes.get(app.pid) : undefined;
  result.serverCpuMs = serverBefore?.ticks != null && serverAfter?.ticks != null ? serverAfter.ticks - serverBefore.ticks : null;
  result.serverRssBytes = serverAfter?.rssBytes ?? null;
  result.harnessCpuUs = process.cpuUsage(cpu); result.harnessRssBytes = process.memoryUsage().rss;
  result.wallMs = performance.now() - began; result.posts = posts; result.pageErrors = errors; result.warnings = warnings; result.failedRequests = failedRequests;
  if (errors.length) throw Error(errors.join('\n'));
  if (values.release.endsWith('-diagnostic') && !posts.includes(204)) throw Error('No built diagnostic sample');
  if (!values.release.endsWith('-diagnostic') && posts.length) throw Error('Production sent diagnostics');
  success = true;
} finally {
  result.success = success;
  writeFileSync(values.out, JSON.stringify(result, null, 2));
  await browser.close(); await app.close();
}
