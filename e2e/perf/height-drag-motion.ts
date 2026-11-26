/** The conversation's height dragged by hand next to the task sheet's, the same finger path on both,
 * on the isolated e2e serve. A phone (390, touch): the conversation sheet's grip and the task sheet's grip, each pulled
 * down, up and down again slowly, flicked up, and pulled down to rest. A computer (1440, mouse): the conversation's far
 * edge pulled the same way, with the reader closed and docked open (a computer's reader has no height to drag).
 * node --import ./e2e/guard-loader.mjs e2e/perf/height-drag-motion.ts <output.json> [--throttle 4] [--rounds 2] [--film] [--widths 390,1440]
 * The conversation is a fixed 12 answered turns; the task T111 has as much text. The instrument is motion-probe.ts; each
 * run also records the drawn height and the page's foot room (--coordinator-dock) before and after, so a run whose hand
 * did nothing is seen. Every serve and browser is closed here, with an expiry.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type CDPSession, type Page, type Route } from '@playwright/test';
import { coordinatorConversationSchema } from '@alpacawork/contract/coordinator';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';
import { installProbe, measurer } from './motion-probe.ts';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '4' }, rounds: { type: 'string', default: '2' }, film: { type: 'boolean', default: false },
  widths: { type: 'string', default: '390,1440' }, profile: { type: 'boolean', default: false },
  // Drawn in a window (installed Chrome) for a screen recording: each run's start and end are printed as `mark` lines.
  headed: { type: 'boolean', default: false },
} });
const output = resolve(positionals[0] ?? '/tmp/height-drag-motion.json');
const throttle = Number(args.throttle), rounds = Number(args.rounds);
mkdirSync(dirname(output), { recursive: true });
const answer = Array.from({ length: 25 }, (_, n) => `### Item ${n}\nText with explanations and **checks**.\n\n- Result ${n}\n- Next review\n\n`).join('');
const conversation = coordinatorConversationSchema.parse({ id: 'height-drag', nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [],
  turns: Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    ask: `Measurement request ${i}`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
    answer, answeredAt: `2026-01-01T00:${String(i).padStart(2, '0')}:30Z` })) });
const text = Array.from({ length: 8 }, (_, i) => `### Section ${i + 1}\nReading **work** and results.\n\n- Result one\n- Result two\n\n`).join('');
const logs = Array.from({ length: 12 }, (_, n) => ({ id: `drag-perf-${n}`, kind: 'reported',
  at: `2026-09-24T12:${String(n * 2).padStart(2, '0')}:00+09:00`, actor: { kind: 'human' }, fromState: null, toState: null,
  title: `Drag measurement ${n}`, description: text }));

/** Down 160, back up 160, down 80: an even, slow hand (5px a frame) with turns, as a person sizes a sheet. Up is negative. */
const PATH = [...Array(32).fill(5), ...Array(32).fill(-5), ...Array(16).fill(5)];
/** A clear flick up: 30px a frame for 8 frames, let go moving. */
const FLICK = Array(8).fill(-30);
/** Pulled down 240 and held still before it is let go: it rests where it was let go. */
const DOWN = Array(40).fill(6);

const pace = (until: number) => new Promise(done => setTimeout(done, Math.max(0, until - performance.now())));
/** A finger pressed at `at`, moved by each step (one each 16ms, with the finger's own times), held `still` ms, lifted. */
async function finger(cdp: CDPSession, at: { x: number; y: number }, steps: number[], still = 150) {
  let y = at.y, next = performance.now();
  const point = () => [{ x: at.x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(), timestamp: Date.now() / 1000 });
  for (const dy of steps) {
    await pace(next += 16); y += dy;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(), timestamp: Date.now() / 1000 });
  }
  await pace(performance.now() + still);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: Date.now() / 1000 });
}
/** The same path by a mouse, pulling an edge up by each step's negative. */
async function mouse(page: Page, at: { x: number; y: number }, steps: number[], still = 150) {
  let y = at.y, next = performance.now();
  await page.mouse.move(at.x, y); await page.mouse.down();
  for (const dy of steps) { await pace(next += 16); y += dy; await page.mouse.move(at.x, y); }
  await pace(performance.now() + still);
  await page.mouse.up();
}
const center = async (page: Page, selector: string) => {
  const box = (await page.locator(selector).first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
/** The drawn height of what `selector` names over the screen's foot, and the page's foot room. */
const state = (page: Page, selector: string) => page.locator(selector).first().evaluate(el => ({
  height: Math.round(el.getBoundingClientRect().height), top: Math.round(el.getBoundingClientRect().top),
  dock: getComputedStyle(document.documentElement).getPropertyValue('--coordinator-dock').trim(),
  cover: getComputedStyle(document.documentElement).getPropertyValue('--sheet-cover').trim() }));

const results: unknown[] = [];
const browser = await chromium.launch(args.headed ? { headless: false, channel: 'chrome', args: ['--window-position=0,0', '--window-size=1460,1040', '--lang=en-US'], env: { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en_US' } } : {});
const expiry = setTimeout(() => { console.error('expired'); process.exit(3); }, 20 * 60_000);
try {
  for (const width of args.widths.split(',').map(Number)) {
    const runtime = await start(undefined, root => patchTask(root, 'T111', { values: { notes: text.trim() }, logs }));
    try {
      const phone = width < 700;
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, hasTouch: true, isMobile: phone,
        locale: 'en-US', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(SAMPLE_NOW));
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => console.error('pageerror', error.message));
      const fixed = async (route: Route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...await response.json(), conversation } }); };
      await page.route('**/api/coordinator', fixed);
      await page.route('**/api/coordinator/warm', route => route.fulfill({ json: conversation }));
      await installProbe(page);
      const cdp = await context.newCDPSession(page);
      const measure = await measurer(page, context, { output, width, throttle, film: args.film, profile: args.profile }, results);
      /** One run: the state before and after it is kept with its numbers, and a hand that moved nothing is said. */
      const run = async (name: string, span: number, of: string, work: () => Promise<unknown>) => {
        const before = await state(page, of);
        if (args.headed) console.log(`mark ${width} ${name} ${Date.now()} ${await page.evaluate(() => outerHeight - innerHeight)}`);
        const result = await measure(name, span, work);
        if (args.headed) console.log(`mark ${width} ${name}-end ${Date.now()}`);
        const after = await state(page, of);
        Object.assign(result, { before, after });
        if (Math.abs(after.height - before.height) < 4) console.error(`${name}: the height did not change (${before.height})`);
        console.log(`   ${name}: height ${before.height}→${after.height} dock ${before.dock}→${after.dock} cover ${before.cover}→${after.cover}`);
      };
      const openConversation = async () => {
        await page.locator('[data-coordinator-expand]').first().click();
        await page.locator('[data-ask-answer]').first().waitFor({ state: 'attached' });
        await page.waitForTimeout(800);
      };
      const fold = async () => { await foldChat(page); await page.waitForTimeout(800); };
      await page.goto(`${runtime.origin}/?agent=1`);
      await page.locator('li[data-row]').first().waitFor();
      // Opened and folded once outside the windows: the first open reads the catalog.
      await openConversation(); await fold();
      for (let round = 0; round < rounds; round++) {
        if (phone) {
          const panel = '[data-coordinator-panel]', grip = `${panel} [data-sheet-grip]`;
          await openConversation();
          await run(`chat-drag-${round}`, 500, panel, async () => finger(cdp, await center(page, grip), PATH));
          await run(`chat-flick-up-${round}`, 700, panel, async () => finger(cdp, await center(page, grip), FLICK, 0));
          await run(`chat-pull-down-${round}`, 700, panel, async () => finger(cdp, await center(page, grip), DOWN));
          await fold();
          await page.goto(`${runtime.origin}/?agent=1&task=T111`);
          const sheet = '[data-sheet]', taskGrip = '[data-task-sheet-grip]';
          await page.locator(taskGrip).first().waitFor();
          await page.waitForTimeout(1000);
          await run(`task-drag-${round}`, 500, sheet, async () => finger(cdp, await center(page, taskGrip), PATH));
          await run(`task-flick-up-${round}`, 700, sheet, async () => finger(cdp, await center(page, taskGrip), FLICK, 0));
          await run(`task-pull-down-${round}`, 700, sheet, async () => finger(cdp, await center(page, taskGrip), DOWN));
          await page.goto(`${runtime.origin}/?agent=1`);
          await page.locator('li[data-row]').first().waitFor();
          await page.waitForTimeout(600);
        } else {
          const panel = '[data-coordinator-panel]', far = '[data-frame-edge="far"]';
          // Each drag starts from the first height (a double press on the far edge gives it back).
          const first = async () => { await page.locator(far).first().dblclick(); await page.waitForTimeout(600); };
          await openConversation(); await first();
          await run(`chat-height-drag-${round}`, 500, panel, async () => mouse(page, await center(page, far), PATH));
          await page.goto(`${runtime.origin}/?agent=1&task=T111`);
          await page.locator('[data-window-width]').first().waitFor();
          await openConversation(); await first();
          await run(`chat-height-drag-reader-${round}`, 500, panel, async () => mouse(page, await center(page, far), PATH));
          await fold();
          await page.goto(`${runtime.origin}/?agent=1`);
          await page.locator('li[data-row]').first().waitFor();
        }
      }
      await context.close();
    } finally { await runtime.stop(); }
  }
} finally { clearTimeout(expiry); await browser.close(); }
