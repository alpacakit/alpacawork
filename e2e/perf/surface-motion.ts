/** How the coordinator's own surfaces move: its queue grown out of its button and folded back into it (folded,
 * and over the conversation), and the conversation maximized and back (a computer only), on the real app.
 * node --import ./e2e/guard-loader.mjs e2e/perf/surface-motion.ts <output.json> [--throttle 4] [--rounds 3] [--film] [--profile]
 * The conversation is a fixed 12 answered and 3 queued turns (its GET and warm-up answered here); the list and the reader
 * are the isolated e2e serve. The instrument is motion-probe.ts. Every serve and browser is closed here, with an expiry.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Route } from '@playwright/test';
import { coordinatorConversationSchema } from '@alpacawork/contract/coordinator';
import { start } from '../server.ts';
import { installProbe, measurer } from './motion-probe.ts';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '4' }, rounds: { type: 'string', default: '3' }, film: { type: 'boolean', default: false },
  profile: { type: 'boolean', default: false }, slow: { type: 'string', default: '' }, widths: { type: 'string', default: '1440,390' },
} });
const output = resolve(positionals[0] ?? '/tmp/surface-motion.json');
const throttle = Number(args.throttle), rounds = Number(args.rounds);
mkdirSync(dirname(output), { recursive: true });
const conversation = coordinatorConversationSchema.parse({ id: 'surface-motion', agent: 'claude', warm: 'none' as const, busy: false, cancelled: [],
  turns: [...Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, at: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
    ask: `Measurement request ${i}`, attachments: [], status: 'succeeded', waiting: false, seen: true, error: null, result: null,
    answer: Array.from({ length: 25 }, (_, n) => `### Item ${n}\nText with explanations and **checks**.\n\n- Result ${n}\n- Next review\n\n`).join(''),
    answeredAt: `2026-01-01T00:${String(i).padStart(2, '0')}:30Z` })), ...Array.from({ length: 3 }, (_, i) => ({
    id: `waiting-${i}`, at: `2026-01-01T01:0${i}:00Z`, ask: `Queued measurement ${i}`, attachments: [],
    status: 'queued' as const, waiting: true, seen: true, error: null, result: null, answer: null, answeredAt: null }))] });

const results: unknown[] = [];
const runtime = await start();
const browser = await chromium.launch().catch(async error => { await runtime.stop(); throw error; });
const expiry = setTimeout(() => { console.error('expired'); process.exit(3); }, 15 * 60_000);
try {
  for (const width of args.widths.split(',').map(Number)) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width < 700,
      locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.on('pageerror', error => console.error('pageerror', error.message));
    // The real snapshot (its root, generation and revision), holding the fixed conversation.
    const fixed = async (route: Route) => { const response = await route.fetch(); route.fulfill({ response, json: { ...await response.json(), conversation } }); };
    await page.route('**/api/coordinator', fixed);
    await page.route('**/api/coordinator/warm', route => route.fulfill({ json: conversation }));
    await installProbe(page);
    const run = await measurer(page, context, { output, width, throttle, film: args.film, profile: args.profile }, results);
    await page.goto(`${runtime.origin}/?agent=1`);
    await page.locator('li[data-row]').first().waitFor();
    // Opened and folded once outside the windows: the first open reads the catalog.
    await page.locator('[data-coordinator-expand]').first().click();
    await page.locator('[data-one-input]').waitFor();
    await foldChat(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    if (args.slow) await page.evaluate(ms => { for (const step of ['base', 'slow']) document.documentElement.style.setProperty(`--motion-${step}`, `${ms}ms`); }, args.slow);
    for (let round = 0; round < rounds; round++) {
      await run(`queue-folded-open-${round}`, 700, () => page.locator('[data-coordinator-queue-button]:visible').click());
      await run(`queue-folded-close-${round}`, 600, () => page.locator('[data-coordinator-queue-fold]').click());
      await page.locator('[data-coordinator-expand]').first().click();
      await page.locator('[data-ask-answer]').first().waitFor({ state: 'attached' });
      // The queue opens from the folded row only; the open conversation shows its queued turns in the thread.
      await page.waitForTimeout(400);
      if (width > 700) {
        await run(`maximize-${round}`, 600, () => page.locator('[data-coordinator-maximize]').click());
        await run(`restore-${round}`, 600, () => page.locator('[data-coordinator-maximize]').click());
      }
      await foldChat(page);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(600);
    }
    await context.close();
  }
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
