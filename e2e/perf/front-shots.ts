/** The same screens of a built checkout on the common synthetic workspace at a fixed clock, to compare before and after:
 *   node e2e/perf/front-shots.ts --release <built checkout> --out <new dir>   (writes <width>-<screen>.png)
 * Motion is settled and reduced, so a difference between two runs is a difference on the screen. */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';
import { commandHeaders } from '../../tests/helpers/command-fetch.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

const { values: args } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' }, seed: { type: 'string', default: 'synthetic-v1' } } });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out);
mkdirSync(out, { recursive: true });
const expiry = setTimeout(() => { console.error('front-shots expired'); process.exit(3); }, 15 * 60_000);
const NOW = new Date('2026-11-01T03:00:00Z');
const original = createOriginal({ ...profiles.perf, seed: args.seed }, join(process.env.HOME!, '.cache/alpacawork-fixtures'));
const browser = await chromium.launch();
const quiet = async (page: Page) => { await page.waitForTimeout(1500); await page.evaluate(() => Promise.all(document.getAnimations().map(each => each.finished.catch(() => undefined)))); await page.waitForTimeout(300); };
try {
  for (const width of [1440, 390]) {
    const root = join(out, `workspace-${width}`);
    rmSync(root, { recursive: true, force: true });
    copyWorkspace(original.root, root);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
    const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    process.once('exit', () => child.kill('SIGKILL'));
    const url = await new Promise<string>(done => { let text = ''; child.stdout.on('data', chunk => { text += chunk; const found = /http:\/\/[\w.:]+/.exec(text); if (found) done(found[0]); }); });
    const began = Date.now();
    for (let calm = Date.now(); Date.now() - calm < 5000 && Date.now() - began < 45_000;) { const asked = Date.now(); await (await fetch(new URL('/api/task/view?task=T2', url))).text(); if (Date.now() - asked > 300) calm = Date.now(); await new Promise(done => setTimeout(done, 100)); }
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 700, isMobile: width < 700, locale: 'en-US', timezoneId: 'Asia/Tokyo', reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    await page.clock.setFixedTime(NOW);
    const shot = async (name: string) => { await quiet(page); await page.screenshot({ path: join(out, `${width}-${name}.png`), animations: 'disabled', caret: 'hide' }); console.error(`[front-shots] ${width} ${name}`); };
    await page.goto(new URL('?agent=1', url).toString());
    await page.locator('[data-read]').first().waitFor();
    await shot('list');
    const ids = await page.locator('[data-read]').evaluateAll(rows => rows.map(row => row.getAttribute('data-read')!));
    for (const id of ids.slice(0, 3)) {
      await page.locator(`[data-read="${id}"]`).first().click();
      await page.locator('aside[data-reader-mode] [data-report-feed][data-history-ready="true"]').first().waitFor();
      await shot(`task-${id}`);
      if (id === ids[0]) {
        for (const row of await page.locator('aside[data-reader-mode] button[aria-expanded="false"]').all().then(all => all.slice(0, 3))) await row.click();
        await shot(`task-${id}-opened`);
      }
      await page.keyboard.press('Escape');
      await page.locator('aside[data-reader-mode]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    }
    // New records reach the list and the open task: what they draw must be what a fresh read draws.
    const post = (path: string, data: unknown) => fetch(new URL(path, url), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
    const comment = async (task: string, n: number) => { const { task: held } = await (await fetch(new URL(`/api/task/view?task=${task}`, url))).json(); await post('/api/commands/task/comment', { task, title: `Screen check ${n}`, description: `Words of screen check ${n}.`, expectedTaskHash: held.hash }); };
    await page.locator(`[data-read="${ids[0]}"]`).first().click();
    await page.locator('aside[data-reader-mode] [data-report-feed][data-history-ready="true"]').first().waitFor();
    await comment(ids[0]!, 1); await comment(ids[1]!, 2);
    await page.locator('aside[data-reader-mode]').getByText('Screen check 1').first().waitFor();
    await shot('task-after-update');
    await page.keyboard.press('Escape');
    await page.locator('aside[data-reader-mode]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    await shot('list-after-update');
    await context.close();
    await new Promise<void>(done => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.kill('SIGTERM'); });
    removeWorkspace(root);
  }
} finally {
  await browser.close();
  clearTimeout(expiry);
}
