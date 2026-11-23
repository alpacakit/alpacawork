/** Does a finger on a phone sheet's handle move it and close it? Real touch input (CDP), on the synthetic perf workspace,
 * with updates arriving and the CPU slowed, in every layout a person reaches. Counts per press, never a time alone.
 *
 *   node --import ./e2e/perf/guard.mjs e2e/perf/sheet-handle.ts --release <built checkout> --out <new dir> [--throttle 4] [--repeat 5] [--live]
 *     [--flick] [--stop 0.2] [--layouts a,b] [--presses grip,above,above12,title,resting]
 * `--presses content,chat-content,chat-grip` press what the detail sheet or the conversation shows (or its grip); `--by` moves the finger that far.
 * `--scan` (`--offset` px below the pill's middle, negative over it) presses the handle's pill with the sheet standing at every share from 0.30 to 0.85, so rows lie at every distance from its edge; `--radius` is the finger's (px).
 * `--flick` gives the touches a real finger's times (CDP's own delay is no finger's speed); `--stop` lets go, still, with the sheet at that share.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession, type Page } from '@playwright/test';
import { commandHeaders } from '../../tests/helpers/command-fetch.ts';
import { copyWorkspace, createOriginal, profiles, removeWorkspace } from '../../scripts/dev-fixtures/fixture.ts';

const { values: args } = parseArgs({ options: {
  release: { type: 'string' }, out: { type: 'string' }, throttle: { type: 'string', default: '4' }, repeat: { type: 'string', default: '5' },
  live: { type: 'boolean', default: false }, flick: { type: 'boolean', default: false }, stop: { type: 'string' }, radius: { type: 'string', default: '1' }, scan: { type: 'boolean', default: false }, offset: { type: 'string', default: '0' }, by: { type: 'string' }, shots: { type: 'string' }, layouts: { type: 'string' }, presses: { type: 'string' }, turns: { type: 'string', default: '40' },
} });
if (!args.release || !args.out) throw new Error('--release and --out are required');
const release = resolve(args.release), out = resolve(args.out), throttle = Number(args.throttle), repeat = Number(args.repeat);
mkdirSync(out, { recursive: true });
setTimeout(() => { console.error('sheet-handle expired'); process.exit(3); }, 25 * 60_000).unref();
const PHONE = { width: 412, height: 915 };

async function serve(root: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ALPACAWORK_')));
  const child = spawn(process.execPath, [join(release, 'apps/backend/dist/backend.js'), '--workspace', root, 'workspace', 'serve', '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((done, fail) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; const found = /http:\/\/[\w.:]+/.exec(text); if (found) done(found[0]); });
    child.once('exit', code => fail(new Error(`serve exited with ${code}: ${text}`)));
  });
  process.once('exit', () => child.kill('SIGKILL'));
  const began = Date.now();
  let calm = Date.now();
  while (Date.now() - calm < 5000 && Date.now() - began < 45_000) {
    const asked = Date.now();
    await (await fetch(new URL('/api/task/view?task=T2', url))).text();
    if (Date.now() - asked > 300) calm = Date.now();
    await new Promise(done => setTimeout(done, 100));
  }
  return { url, close: () => new Promise<void>(done => { child.removeAllListeners('exit'); child.once('exit', () => done()); child.kill('SIGTERM'); }) };
}

const SHEET = '[data-sheet]';
const sheetOpen = (page: Page) => page.locator(`${SHEET} aside[data-reader-mode=sheet]`).count();
const CHAT = '[data-coordinator-phone]';
let measured = SHEET;
const sheetTop = (page: Page) => page.evaluate((s) => document.querySelector(s)?.getBoundingClientRect().top ?? null, measured);

/** What each press hears, in the page, in order. */
const installEar = (page: Page) => page.addInitScript(() => {
  const heard: string[] = (window as any).heard = [];
  const name = (t: EventTarget | null) => t instanceof Element ? `${t.tagName.toLowerCase()}${t.hasAttribute('data-task-sheet-grip') ? '[grip]' : t.closest('[data-task-sheet-grab]') ? '[grab]' : t.closest('[data-coordinator-phone]') ? '[coord]' : ''}` : String(t);
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'gotpointercapture', 'touchcancel', 'contextmenu'])
    addEventListener(type, event => heard.push(`${type}:${name(event.target)}`), { capture: true, passive: true });
  let moves = 0;
  addEventListener('pointermove', event => { moves++; (window as any).moves = moves; heard.push(`m@${Math.round(event.timeStamp)}:${Math.round(event.clientY)}`); }, { capture: true, passive: true });
});

async function press(page: Page, cdp: CDPSession, x: number, y: number, distance: number, resting?: { x: number; y: number }) {
  await page.evaluate(() => { (window as any).heard.length = 0; (window as any).moves = 0; });
  const before = await sheetTop(page);
  const hit = await page.evaluate(([px, py]) => {
    const at = document.elementFromPoint(px!, py!);
    return at ? `${at.tagName.toLowerCase()} grab=${!!at.closest('[data-task-sheet-grab]')} coord=${!!at.closest('[data-coordinator-phone]')} cardgrab=${!!at.closest('[data-card-grab]')} touch=${getComputedStyle(at).touchAction}` : null;
  }, [x, y]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', ...(args.flick ? { timestamp: Date.now() / 1000 } : {}), touchPoints: [...(resting ? [resting] : []), { x, y, radiusX: Number(args.radius), radiusY: Number(args.radius) }] });
  const finger = { radiusX: Number(args.radius), radiusY: Number(args.radius) };
  const steps = args.flick ? 6 : 12;
  let followed = 0, last = before;
  const clock = Date.now() / 1000;
  const moveMs: number[] = [];
  for (let step = 1; step <= steps; step++) {
    const sent = performance.now();
    // A real finger's times, whatever this script's own delay: 200px in 96ms, about 2 px/ms.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', ...(args.flick ? { timestamp: clock + step * 0.016 } : {}), touchPoints: [...(resting ? [resting] : []), { x, y: y + (args.flick ? Math.min(distance, 200) : distance) * step / steps, ...finger }] });
    moveMs.push(performance.now() - sent);
    if (args.flick) continue;
    await page.waitForTimeout(16);
    const top = await sheetTop(page);
    if (top !== null && last !== null && Math.abs(top - last) > 0.5) followed++;
    last = top;
  }
  const atLift = await sheetTop(page);
  const chatTop = await page.evaluate(() => document.querySelector('[data-coordinator-phone]')?.getBoundingClientRect().top ?? null);
  if (!args.flick) await page.waitForTimeout(160);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', ...(args.flick ? { timestamp: clock + (steps + 1) * 0.016 } : {}), touchPoints: [] });
  await page.waitForTimeout(900);
  const after = await sheetTop(page), open = measured === CHAT ? await page.locator(CHAT).count() : await sheetOpen(page);
  const heard = await page.evaluate(() => [...(window as any).heard] as string[]);
  return { moveMs: Math.round(moveMs.sort((a, b) => a - b)[Math.floor(moveMs.length / 2)]!), hit, chatTop, before, atLift, after, moved: before !== null && atLift !== null ? Math.round(atLift - before) : null, followed, closed: open === 0,
    expanded: await page.locator('[data-coordinator-phone]').count() > 0, heard, moves: await page.evaluate(() => (window as any).moves as number) };
}

const original = createOriginal({ ...profiles.perf, seed: 'synthetic-v1' }, join(process.env.HOME!, '.cache/alpacawork-fixtures'));
const root = join(out, 'workspace');
rmSync(root, { recursive: true, force: true });
copyWorkspace(original.root, root);
const app = await serve(root);
const browser = await chromium.launch();
const results: Record<string, unknown>[] = [];
const save = () => writeFileSync(join(out, 'results.json'), JSON.stringify({ release, throttle, live: args.live, results }, null, 1));
const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true, deviceScaleFactor: 2.625, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
await installEar(page);
const turns = Number(args.turns);
const conversation = { id: 'sheet-handle', nextLaunch: { agent: 'claude', values: {} }, warm: 'none', busy: false, cancelled: [], turns: Array.from({ length: turns }, (_, i) => ({
  id: `turn-${i}`, at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), ask: `Measured request ${i} about T2 and T3`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
  answer: `### Answer ${i}\nT2 goes on after T3, **checked**.\n\n- First point\n- Second point\n`, answeredAt: new Date(Date.UTC(2026, 9, 1, 0, i, 30)).toISOString() })) };
await page.route('**/api/coordinator', async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), conversation } }); });
await page.route('**/api/coordinator/warm', route => route.fulfill({ json: conversation }));
const cdp = await context.newCDPSession(page);
if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });

let stopLive = () => {};
try {
  await page.goto(new URL('?agent=1', app.url).toString());
  await page.locator('[data-read]').first().waitFor();
  const ids = await page.locator('[data-read]').evaluateAll(rows => rows.map(row => row.getAttribute('data-read')!).slice(0, 8));
  const openId = ids[0]!;
  const taskUrl = new URL(`?agent=1&task=${openId}`, app.url).toString();

  if (args.live) {
    let running = true, n = 0;
    stopLive = () => { running = false; };
    void (async () => {
      const post = (path: string, data: unknown) => fetch(new URL(path, app.url), { method: 'POST', headers: Object.fromEntries(commandHeaders(data, { 'content-type': 'application/json' })), body: JSON.stringify(data) });
      while (running) {
        const task = n % 2 ? ids[n % ids.length]! : openId;
        const { task: current } = await (await fetch(new URL(`/api/task/view?task=${task}`, app.url))).json();
        await post('/api/task/comment', { task, title: `Live report ${n}`, description: `Live body ${n}.`, expectedTaskHash: current.hash }).catch(() => {});
        n++;
        await new Promise(done => setTimeout(done, 700));
      }
    })();
  }

  const openSheet = async (share: number | null, coordinator: number | null) => {
    await page.evaluate(([s, c]) => {
      if (s === null) localStorage.removeItem('alpacawork.sheetHeight'); else localStorage.setItem('alpacawork.sheetHeight', String(s));
      if (c === null) localStorage.removeItem('alpacawork.coordinatorExtent'); else localStorage.setItem('alpacawork.coordinatorExtent', JSON.stringify(c));
    }, [share, coordinator]);
    await page.goto(taskUrl);
    await page.locator(`${SHEET} aside[data-reader-mode=sheet] header [data-reader-task-id]`).waitFor();
    await page.waitForTimeout(1200);
  };
  const expand = async () => {
    await page.locator('[data-coordinator-expand]').first().tap();
    await page.locator('[data-coordinator-phone]').waitFor();
    await page.waitForTimeout(900);
  };
  const whole = async () => {
    const grip = (await page.locator('[data-task-sheet-grip]').boundingBox())!;
    const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (const yy of [y - 60, y - 200, y - 400]) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.max(1, yy) }] }); await page.waitForTimeout(10); }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(900);
  };
  const LAYOUTS: Record<string, () => Promise<void>> = {
    'rest': () => openSheet(null, null),
    'whole': async () => { await openSheet(null, null); await whole(); },
    'low-sheet': () => openSheet(0.3, null),
    'high-sheet': () => openSheet(0.85, null),
    'rest+chat-half': async () => { await openSheet(null, 457); await expand(); },
    'rest+chat-default': async () => { await openSheet(null, null); await expand(); },
    'rest+chat-tall': async () => { await openSheet(null, 760); await expand(); },
    'high+chat-half': async () => { await openSheet(0.85, 457); await expand(); },
    'low+chat-half': async () => { await openSheet(0.3, 457); await expand(); },
    'whole+chat-half': async () => { await openSheet(null, 457); await whole(); await expand(); },
    'zoom-1.02': async () => { await openSheet(null, null); await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.02 }); await page.waitForTimeout(400); },
    'zoom-1.3': async () => { await openSheet(null, null); await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.3 }); await page.waitForTimeout(400); },
  };
  if (args.scan) {
    for (let at = 30; at <= 85; at++) {
      await openSheet(at / 100, null);
      const grip = (await page.locator('[data-task-sheet-grip]').boundingBox())!;
      const pill = await page.locator('[data-task-sheet-grip] span').boundingBox();
      const x = grip.x + grip.width / 2, y = (pill ? pill.y + pill.height / 2 : grip.y + grip.height / 2) + Number(args.offset);
      const result = await press(page, cdp, x, y, 150);
      results.push({ layout: 'scan', kind: 'pill', share: at / 100, x, y, ...result });
      save();
      console.error(`[sheet-handle] scan ${at}: moved=${result.moved} first=${result.heard.find(h => h.startsWith('pointerdown'))}`);
    }
    throw new Error('scan done');
  }
  const chosen = args.layouts ? args.layouts.split(',') : Object.keys(LAYOUTS);
  const presses = args.presses ? args.presses.split(',') : ['grip', 'above', 'title'];
  for (const layout of chosen) for (const kind of presses) for (let round = 0; round < repeat; round++) {
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 }).catch(() => {});
    await LAYOUTS[layout]!();
    if (args.shots && round === 0 && kind === presses[0]) await page.screenshot({ path: join(args.shots, `${layout}.png`) });
    measured = kind.startsWith('chat') ? CHAT : SHEET;
    const grip = kind.startsWith('chat') ? await page.locator(`${CHAT} [data-sheet-grip]`).boundingBox() : await page.locator('[data-task-sheet-grip]').boundingBox();
    if (!grip) { results.push({ layout, kind, round, error: 'no grip' }); continue; }
    const x = grip.x + grip.width / 2;
    let y = grip.y + grip.height / 2;
    if (kind === 'above') y = grip.y - 4;
    if (kind === 'above12') y = grip.y - 12;
    // From the top of what each shows, under its head: the reading's first lines, the conversation's first words.
    // Well under the title (a heading and a grip): the browser moves a press near it onto it.
    if (kind === 'content') { const title = (await page.locator(`${SHEET} [data-reader-content] [data-task-sheet-grab]`).last().boundingBox())!; y = title.y + title.height + 60; }
    if (kind === 'chat-content') { const scroll = (await page.locator(`${CHAT} [data-card-scroll]`).boundingBox())!; y = scroll.y + 60; }
    if (kind === 'title') { const head = await page.locator(`${SHEET} header`).first().boundingBox(); y = head ? head.y + head.height / 2 : y; }
    if (y < 1) y = 1;
    const distance = args.by ? Number(args.by) : args.stop ? PHONE.height * (1 - Number(args.stop)) - (grip.y) : Math.min(PHONE.height - y - 5, 700);
    const result = await press(page, cdp, x, y, distance, kind === 'resting' ? { x: 40, y: PHONE.height - 200 } : undefined);
    results.push({ layout, kind, round, grip, x, y, ...result });
    save();
    console.error(`[sheet-handle] ${layout} ${kind} #${round}: hit=${result.hit} moved=${result.moved} followed=${result.followed} closed=${result.closed} heard=${result.heard.join(',')}`);
  }
} catch (error) {
  if (String(error).indexOf('scan done') < 0) throw error;
} finally {
  stopLive();
  save();
  await browser.close().catch(() => {});
  await app.close();
  try { removeWorkspace(root); } catch (error) { console.error(String(error)); }
  writeFileSync(join(out, 'done'), '');
}
process.exit(0);
