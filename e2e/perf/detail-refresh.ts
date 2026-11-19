/** Opening the detail panel on a task that changed while it was closed (its History read again, the newer reports
 * coming in), on one that did not, and a report arriving while it stays open. Each open is measured with the list-motion-probe.ts probe; `--film` keeps the compositor's frames
 * for `detail-refresh-film.ts`. History is held for `--hold` ms on every read, as a network would, so the wait is seen.
 * Run after build; server and browser close in finally (the server's keeper also ends it on its own).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { installProbe, measurer } from './list-motion-probe.ts';
const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '1' }, rounds: { type: 'string', default: '3' }, widths: { type: 'string', default: '1440,390' },
  film: { type: 'boolean', default: false }, reduced: { type: 'boolean', default: false }, hold: { type: 'string', default: '500' },
} });
const output = resolve(positionals[0] ?? '/tmp/detail-refresh.json'); mkdirSync(dirname(output), { recursive: true });
const results: unknown[] = []; const browser = await chromium.launch();
const expiry = setTimeout(() => { console.error('detail-refresh expired'); process.exit(3); }, 15 * 60_000);
const fresh = (tag: string, minute: number) => [
  { id: `detail-refresh-line-${tag}`, kind: 'reported' as const, at: `2026-09-25T14:${minute}:00+09:00`, actor: { kind: 'human' }, fromState: null, toState: null,
    title: 'A note written while the panel was closed', description: 'Older of the two.' },
  { id: `detail-refresh-story-${tag}`, kind: 'reported' as const, at: `2026-09-25T14:${minute + 1}:00+09:00`, actor: { kind: 'human' }, fromState: 'waiting' as const, toState: 'doing' as const,
    title: 'Picked up again with the corrected invoice', description: 'The newest report, opened in place of the one read before.\n\nIt has a second paragraph, so it takes some room when it opens.' },
];
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => {
  const check = () => document.getAnimations().some(each => each.playState === 'running' && Number.isFinite(Number(each.effect?.getComputedTiming().endTime)))
    ? setTimeout(check, 50) : done();
  check();
}));
try { for (const width of args.widths.split(',').map(Number)) {
  const runtime = await start(undefined, undefined, resolve('.local/detail-refresh-runtime', basename(output) + '-' + width + '-' + Date.now()));
  const context = await browser.newContext({ viewport: { width, height: width < 700 ? 844 : 900 }, hasTouch: width < 700, isMobile: width < 700, locale: 'en-US',
    timezoneId: 'Asia/Tokyo', serviceWorkers: 'block', reducedMotion: args.reduced ? 'reduce' : 'no-preference' });
  try {
    const page = await context.newPage(); await installProbe(page);
    const reads: number[] = [];
    await page.route(url => url.pathname === '/api/task/history', async route => {
      reads.push(Date.now()); await new Promise(done => setTimeout(done, Number(args.hold))); await route.continue();
    });
    const run = await measurer(page, context, { output, width, throttle: Number(args.throttle), film: args.film, extra: { reduced: args.reduced, hold: Number(args.hold) } }, results);
    await page.goto(runtime.origin + '/?agent=1');
    const row = page.locator('[data-row="T111"] [data-row-title]').first();
    await row.waitFor();
    const reader = page.locator('aside[data-reader-mode]');
    const close = async () => { await reader.getByRole('button', { name: 'Close details' }).click(); await reader.waitFor({ state: 'detached' }); await settle(page); };
    await row.click();
    await reader.locator('[data-report-feed] li[data-motion-key]').first().waitFor();
    await page.waitForTimeout(1500); await settle(page);
    await close();
    for (let round = 0; round < Number(args.rounds); round++) {
      const tag = `${width}-${round}`;
      patchTask(runtime.root, 'T111', { logs: fresh(tag, 20 + round * 2) });
      await page.waitForTimeout(900);
      reads.length = 0;
      const diff = await run('open-diff-' + round, 1400, async () => {
        await row.click();
        await reader.locator(`[data-report-key="log:T111:detail-refresh-story-${tag}"]`).waitFor();
      });
      Object.assign(diff, { historyReads: reads.length });
      await close();
      await page.waitForTimeout(900);
      reads.length = 0;
      const same = await run('open-same-' + round, 1400, async () => {
        await row.click();
        await reader.locator('[data-report-feed] li[data-motion-key]').first().waitFor();
      });
      Object.assign(same, { historyReads: reads.length });
      // A report written while it stays open: the same read again, brought by the live update.
      await page.waitForTimeout(600);
      reads.length = 0;
      const live = await run('open-live-' + round, 1400, async () => {
        patchTask(runtime.root, 'T111', { logs: fresh(`${tag}-live`, 40 + round * 2) });
        await reader.locator(`[data-report-key="log:T111:detail-refresh-story-${tag}-live"]`).waitFor();
      });
      Object.assign(live, { historyReads: reads.length });
      writeFileSync(output, JSON.stringify({ version: 1, throttle: Number(args.throttle), browser: browser.version(), results }, null, 2));
      await close();
    }
  } finally { await context.close(); await runtime.stop(); }
} } finally { clearTimeout(expiry); await browser.close(); }
