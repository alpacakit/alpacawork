/** Where the reader's reading line stands, as pictures with the line ringed: while History is held, at rest, after
 * scrolling the reports (a day's divider stuck at the top); and a task with no Task tree row read for the first time,
 * which shows its placeholder and no line. Run after build:
 * node --import ./e2e/guard-loader.mjs e2e/perf/detail-refresh-still.ts <out dir>
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { commandFetch as fetch } from '../../tests/helpers/command-fetch.ts';
const out = resolve(process.argv[2] ?? '/tmp/detail-refresh-still'); mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const expiry = setTimeout(() => { console.error('detail-refresh-still expired'); process.exit(3); }, 8 * 60_000);
const logs = (tag: string) => Array.from({ length: 6 }, (_, at) => ({ id: `detail-refresh-still-${tag}-${at}`, kind: 'reported' as const,
  at: `2026-09-2${at < 3 ? 4 : 5}T1${at}:0${at}:00+09:00`, actor: { kind: 'human' }, fromState: null, toState: null,
  title: `A report written while the panel was closed (${at + 1})`, description: 'So the reports reach past the screen.' }));
/** The line drawn ringed in red (a picture's mark only: an outline takes no room). */
const ring = (page: Page) => page.evaluate(() => {
  const line = document.querySelector<HTMLElement>('[data-reading-line]');
  if (line) Object.assign(line.style, { outline: '2px solid #e5484d', outlineOffset: '3px' });
  return !!line;
});
try { for (const width of [1440, 390]) {
  const runtime = await start();
  try {
  const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, hasTouch: width < 700, isMobile: width < 700,
    locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    let release = () => {};
    await page.route(url => url.pathname === '/api/task/history', async route => {
      await new Promise<void>(done => { release = done; setTimeout(done, 20_000); }); await route.continue();
    });
    const shoot = async (name: string) => {
      await page.evaluate(() => new Promise<void>(done => setTimeout(done, 400)));
      const seen = await ring(page);
      await page.screenshot({ path: `${out}/${width}-${name}.png` });
      console.log(width, name, seen ? 'line' : 'no line');
    };
    await page.goto(runtime.origin + '/?agent=1');
    const reader = page.locator('aside[data-reader-mode]');
    // The line shows once a read has lasted a second, over what was read before: not on a first read's placeholder.
    const open = async (id: string, shows: string) => {
      await page.locator(`[data-row="${id}"] [data-row-title]`).first().click();
      await reader.locator(shows).first().waitFor();
    };
    // Read for the first time, and again once reports came while it was closed.
    await open('T111', '[data-skeleton]'); release();
    await reader.locator('[data-report-feed] li[data-motion-key]').first().waitFor();
    await reader.locator('[data-reading-line]').waitFor({ state: 'detached' });
    await reader.getByRole('button', { name: 'Close details' }).click(); await reader.waitFor({ state: 'detached' });
    patchTask(runtime.root, 'T111', { logs: logs(String(width)) });
    await page.waitForTimeout(900);
    await open('T111', '[data-reading-line]');
    await shoot('reading');
    // Scrolled down the reports while it still reads: the line goes with the rule, a day's divider stands at the top.
    await reader.locator('[data-reader-content]').evaluate(each => { each.scrollTop = 400; });
    await shoot('reading-scrolled');
    release();
    await reader.locator('[data-reading-line]').waitFor({ state: 'detached' });
    await reader.locator('[data-reader-content]').evaluate(each => { each.scrollTop = 0; });
    await reader.getByRole('button', { name: 'Close details' }).click(); await reader.waitFor({ state: 'detached' });
    // A task with no Task tree row: a project's own task without children, read for the first time.
    const made = await fetch(runtime.origin + '/api/commands/task/new', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parent: 'P1', title: 'A task on its own', userRequested: true }) });
    const alone = (await made.json()).task as { id: string };
    await page.goto(`${runtime.origin}/?task=${alone.id}&agent=1`);
    await reader.locator('[data-skeleton]').first().waitFor();
    await shoot(`first-read-no-tree-${alone.id}`);
    release();
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); }
  } finally { await runtime.stop(); }
} } finally { clearTimeout(expiry); await browser.close(); }
