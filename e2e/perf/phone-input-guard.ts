/** What a change for the phone's input may not cost, run the same way on the build before and after: the words are
 * kept (a reload before sending, a storage that refuses, an update arriving during a composition, a send taken back), what
 * arrives still arrives, and the screen is the same picture on the same data.
 *
 *   node e2e/perf/phone-input-guard.ts --release <built checkout> --out <new dir> [--seed synthetic-v1]
 *
 * Results are facts for a person to compare (`guard.json`, `*.png`). Take pictures one run at a time: side by side under
 * load they differ by a few levels even on one build.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext, type Page } from '@playwright/test';
import { commandHeaders } from '../../tests/helpers/command-fetch.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

const { values: args } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' }, seed: { type: 'string', default: 'synthetic-v1' } } });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out);
mkdirSync(out, { recursive: true });
const expiry = setTimeout(() => { console.error('guard expired'); process.exit(3); }, 10 * 60_000);

const root = join(out, 'workspace');
rmSync(root, { recursive: true, force: true });
copyWorkspace(createOriginal({ ...profiles.perf, seed: args.seed }, join(process.env.HOME!, '.cache/alpacawork-fixtures')).root, root);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
process.once('exit', () => child.kill('SIGKILL'));
const origin = await new Promise<string>((done, fail) => {
  let text = '';
  child.stdout.on('data', chunk => { text += chunk; const found = /http:\/\/[\w.:]+/.exec(text); if (found) done(found[0]); });
  child.once('exit', code => fail(new Error(`serve exited with ${code}: ${text}`)));
});
for (let calm = Date.now(), began = Date.now(); Date.now() - calm < 3000 && Date.now() - began < 45_000;) {
  const asked = Date.now();
  await (await fetch(new URL('/api/task/view?task=T2', origin))).text();
  if (Date.now() - asked > 300) calm = Date.now();
  await new Promise(done => setTimeout(done, 100));
}
const post = (path: string, data: unknown) => fetch(new URL(path, origin), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
const titled = async (task: string, title: string) => {
  const { task: current } = await (await fetch(new URL(`/api/task/view?task=${task}`, origin))).json();
  const response = await post('/api/commands/task/update', { task, title, expectedTaskHash: current.hash });
  if (!response.ok) throw new Error(`Title ${task}: ${response.status} ${await response.text()}`);
};

const browser = await chromium.launch();
const facts: Record<string, unknown> = { release, pageErrors: [] };
const errors = facts.pageErrors as string[];
const phone = () => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
const opened = async (context: BrowserContext, query = '?agent=1') => {
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.setDefaultTimeout(30_000);
  await page.goto(new URL(query, origin).toString());
  await page.locator('[data-read]').first().waitFor();
  return page;
};
const openInput = async (page: Page) => {
  await page.locator('[data-coordinator-write]').click();
  const field = page.locator('[data-one-input]');
  await field.waitFor();
  await field.click();
  return field;
};
const words = async (page: Page) => (await page.locator('[data-one-input]').innerText()).replace(/\s+/g, ' ').trim();
const firstRow = (page: Page) => page.locator('[data-read]').first().getAttribute('data-read');
/** How long after a change the first row's title reads it, with `during` going on meanwhile. */
const arrivalMs = async (page: Page, task: string, title: string, during?: () => Promise<void>) => {
  const began = performance.now();
  await titled(task, title);
  const shown = page.locator(`[data-read="${task}"]`).filter({ hasText: title }).first();
  await Promise.all([shown.waitFor({ timeout: 25_000 }), during?.()]);
  return Math.round(performance.now() - began);
};

try {
  {
    const context = await phone(), page = await opened(context);
    await openInput(page);
    await page.keyboard.type('reload keeps these words');
    await page.waitForTimeout(100);
    await page.reload();
    await page.locator('[data-read]').first().waitFor();
    const field = await openInput(page);
    await field.waitFor();
    facts.reloadBeforeSend = await words(page);
    await context.close();
  }
  {
    const context = await phone(), page = await opened(context);
    await openInput(page);
    await page.keyboard.type('before ');
    await page.evaluate(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (name: string, value: string) { if (name.includes('input-drafts')) throw new DOMException('full', 'QuotaExceededError'); return set.call(this, name, value); }; });
    await page.keyboard.type('after');
    await page.waitForTimeout(300);
    facts.storageRefused = { words: await words(page), said: await page.getByText('下書きを保存できません').count() > 0 };
    await context.close();
  }
  {
    const context = await phone(), page = await opened(context);
    const task = await firstRow(page);
    await openInput(page);
    const cdp = await context.newCDPSession(page);
    await page.keyboard.type('変換前 ');
    await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
    await titled(task!, 'Arrived during composition');
    await page.waitForTimeout(1200);
    const during = await words(page);
    await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '日本語' });
    await page.waitForTimeout(800);
    await page.locator(`[data-read="${task}"]`).filter({ hasText: 'Arrived during composition' }).first().waitFor({ timeout: 10_000, state: 'attached' });
    facts.updateDuringComposition = { during, after: await words(page) };
    await context.close();
  }
  {
    const context = await phone(), page = await opened(context);
    const field = await openInput(page);
    await page.keyboard.type('take this back');
    await page.locator('[data-ask-send]').click();
    // The undo toast comes with the send; without it nothing was checked, so this fails rather than passes.
    const undo = page.locator('[data-toast] button').first();
    await undo.waitFor({ timeout: 4000 });
    await undo.click();
    await page.waitForTimeout(500);
    if (!await field.isVisible()) await openInput(page);
    facts.sendTakenBack = await words(page);
    await context.close();
  }
  {
    const context = await phone(), page = await opened(context);
    const task = await firstRow(page);
    await page.waitForTimeout(800);
    facts.arrivalNotTypingMs = await arrivalMs(page, task!, 'Arrived while idle');
    await openInput(page);
    let typing = true;
    const keys = (async () => { while (typing) { await page.keyboard.type('a'); await page.waitForTimeout(150); } })();
    const began = performance.now();
    await titled(task!, 'Arrived while typing');
    await page.locator(`[data-read="${task}"]`).filter({ hasText: 'Arrived while typing' }).first().waitFor({ timeout: 25_000, state: 'attached' });
    const whileTyping = performance.now() - began;
    typing = false;
    await keys;
    // The hold's bound, plus the server's turn: the point is that it arrives with the keys still going.
    facts.arrivalWhileTypingMs = Math.round(whileTyping);
    await context.close();
  }
  {
    // The stream cut while updates arrive and keys go on: nothing throws, and what comes after still arrives.
    const context = await phone(), page = await opened(context);
    const task = await firstRow(page);
    await openInput(page);
    let typing = true;
    const keys = (async () => { while (typing) { await page.keyboard.type('a'); await page.waitForTimeout(150); } })();
    await titled(task!, 'Before the cut');
    await page.waitForTimeout(2000);
    await context.setOffline(true);
    await page.waitForTimeout(400);
    await context.setOffline(false);
    await page.waitForTimeout(1500);
    typing = false;
    await keys;
    await titled(task!, 'After the cut');
    facts.afterStreamCut = await page.locator(`[data-read="${task}"]`).filter({ hasText: 'After the cut' }).first().waitFor({ timeout: 25_000, state: 'attached' }).then(() => 'arrived', () => 'never');
    await context.close();
  }
  for (const [width, height, mobile] of [[390, 844, true], [1440, 900, false]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: mobile, isMobile: mobile, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-01T09:00:00+09:00'));
    await page.addInitScript(() => addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.append(style); }));
    await page.goto(new URL('?agent=1', origin).toString());
    await page.locator('[data-read]').first().waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `list-${width}.png`) });
    await page.locator('[data-read]').first().click();
    await page.locator('aside[data-reader-mode] header [data-reader-task-id]').first().waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, `reader-${width}.png`) });
    await page.locator('[data-coordinator-write]').click();
    await page.locator('[data-one-input]').click();
    await page.keyboard.type('同じ画面か比べます abc');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `input-${width}.png`) });
    await context.close();
  }
} finally {
  writeFileSync(join(out, 'guard.json'), JSON.stringify(facts, null, 1));
  await browser.close();
  await new Promise<void>(done => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.kill('SIGTERM'); });
  removeWorkspace(root);
  clearTimeout(expiry);
}
console.log(JSON.stringify(facts, null, 1));
