/** How the coordinator's input and conversation open and close, frame by frame, on the real app.
 * node --import ./e2e/guard-loader.mjs e2e/perf/open-close-motion.ts <output.json> [--throttle 4] [--rounds 3] [--video] [--film] [--profile] [--reduced]
 * Each width (1440×900, touch 390×900) gets its own isolated serve with the fake coordinator, a project of question
 * cards and the reader open on the first. Every press is measured over a fixed window that covers its motion: rAF
 * frame gaps, Long Animation Frames, CDP layout/style/script time, React commits, and which properties each
 * Element.animate drew. --video records the same presses, --film keeps every frame the compositor drew in each window
 * (<output>.film/<width>-<name>/<ms>.jpg), --profile the hottest functions; each costs CPU, so time them in a run of their own. Every serve and browser is
 * owned and closed here, with a hard expiry.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { start, type Runtime } from '../server.ts';
import { startFakeCoordinator } from '../coordinator-fixture.ts';
import { patchTask, seedQuestion } from '../fixture/task-state.ts';
import { swipe, visibleReaderContentTop } from '../fixtures.ts';
import { installProbe, measurer } from './motion-probe.ts';
import { commandFetch as fetch } from '../../tests/helpers/command-fetch.ts';
import { decideValues } from '../../tests/helpers/task-values.ts';

/** The conversation's ⌄ (a phone has one too), else Esc. */
async function foldChat(page: any, press: (target: any) => Promise<unknown> = target => target.click()) {
  const fold = page.locator('[data-coordinator-panel] [data-coordinator-fold]').first();
  if (await fold.count()) await press(fold); else await page.keyboard.press('Escape');
}

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '4' }, rounds: { type: 'string', default: '3' },
  video: { type: 'boolean', default: false }, profile: { type: 'boolean', default: false }, film: { type: 'boolean', default: false }, slow: { type: 'string', default: '' }, reduced: { type: 'boolean', default: false }, widths: { type: 'string', default: '1440,390' },
} });
const output = resolve(positionals[0] ?? '/tmp/open-close-motion.json');
const throttle = Number(args.throttle), rounds = Number(args.rounds);
mkdirSync(dirname(output), { recursive: true });

async function post(r: Runtime, path: string, body: object) {
  const response = await fetch(r.origin + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
async function questions(r: Runtime, count: number) {
  const project = (await post(r, 'commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: '開閉の計測' })).task.id;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const { task } = await post(r, 'commands/task/new', { parent: project, title: `質問 ${i + 1}`,
      values: decideValues(['色を選んでください', ['A 青', '青にする'], ['B 赤', '赤にする']]) });
    await post(r, 'commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
    patchTask(r.root, task.id, { state: 'doing' });
    seedQuestion(r.root, task.id, { to: 'user' });
    ids.push(task.id);
  }
  return { project, ids };
}

const results: unknown[] = [];
const browser = await chromium.launch();
const expiry = setTimeout(() => { console.error('expired'); process.exit(3); }, 20 * 60_000);
try {
  for (const width of args.widths.split(',').map(Number)) {
    const runtime = await start(undefined, startFakeCoordinator);
    try {
      const { project, ids } = await questions(runtime, rounds * 3 + 4);
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width < 700,
        locale: 'ja-JP', timezoneId: 'Asia/Tokyo', serviceWorkers: 'block', reducedMotion: args.reduced ? 'reduce' : 'no-preference',
        ...(args.video ? { recordVideo: { dir: `${output}.video-${width}`, size: { width, height: 900 } } } : {}) });
      const page = await context.newPage();
      page.on('pageerror', error => console.error('pageerror', error.message));
      await installProbe(page);
      const reader = page.locator('aside[data-reader-mode]');
      const measure = await measurer(page, context, { output, width, throttle, film: args.film, profile: args.profile, extra: { reduced: args.reduced } }, results);
      // A card that did not leave (its send refused or not yet ready) is not the motion this run is for.
      const flew = (animations: { target: string }[]) => animations.some(each => each.target.includes('data-flying-card'));
      const run = (name: string, span: number, work: () => Promise<unknown>) => measure(name, span, work, /^(send-fold|swipe-next)/.test(name) ? flew : undefined);
      const folded = async () => {
        await foldChat(page);
        await page.waitForTimeout(400);
        // Esc folds the input only while it is being written in; anywhere else it closes the reader.
        const writing = page.locator('[data-one-input]:focus');
        if (await writing.count()) { await page.keyboard.press('Escape'); await page.waitForTimeout(400); }
        if (await writing.count()) { await writing.blur(); await page.waitForTimeout(400); }
      };
      const write = async (text: string) => {
        if (!await page.locator('[data-one-input]').count()) await page.locator('[data-coordinator-write]').click();
        await page.locator('[data-one-input]').press('End');
        await page.keyboard.insertText(text);
      };
      const showing = () => reader.locator('[data-reader-task-id]').innerText();
      await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${ids[0]}`);
      await reader.locator('[data-reader-task-id]').waitFor();
      // First open loads the catalog outside the measurement windows.
      await page.locator('[data-coordinator-expand]').first().click();
      await page.waitForTimeout(1500);
      await folded();
      // --slow <ms>: every base-length motion drawn that long, to see its shape frame by frame (never for timing).
      if (args.slow) await page.evaluate(ms => document.documentElement.style.setProperty('--motion-base', `${ms}ms`), args.slow);
      for (let round = 0; round < rounds; round++) {
        // Every round starts on a card not yet answered (a send that stays holds its answer on its card).
        if (round) {
          await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${ids[round * 3]}`);
          await reader.locator('[data-reader-task-id]').waitFor();
          await page.waitForTimeout(1500);
          if (args.slow) await page.evaluate(ms => document.documentElement.style.setProperty('--motion-base', `${ms}ms`), args.slow);
        }
        await folded();
        await run(`input-open-${round}`, 600, () => page.locator('[data-coordinator-write]').click());
        await page.keyboard.insertText('下書き');
        await run(`input-close-${round}`, 600, () => page.keyboard.press('Escape'));
        await folded();
        await run(`chat-open-${round}`, 600, () => page.locator('[data-coordinator-expand]').first().click());
        await run(`chat-close-${round}`, 600, () => foldChat(page));
        await folded();
        // Sent from the input with auto-swipe on: the card is stamped and flung, the next comes, the input folds to its line.
        if (!await reader.locator('[data-question="1"] button:not([disabled])').first().waitFor({ timeout: 5000 }).then(() => true, () => false)) {
          console.error(`send-fold-${round}: no card to answer, the sends skipped`); continue;
        }
        await page.locator('[data-auto-swipe]').first().click();
        await page.waitForTimeout(300);
        await folded();
        let was = await showing();
        await write('青で進めてください');
        await run(`send-fold-${round}`, 1400, () => page.locator('[data-ask-send]').click());
        if (await showing() === was) console.error(`send-fold-${round}: card stayed`);
        // A swipe that finishes the card: chosen, then swiped on to the next.
        was = await showing();
        const choice = reader.locator('[data-question="1"]').getByRole('button', { name: /A 青/ });
        if (await choice.isDisabled().catch(() => true)) { console.error(`swipe-next-${round}: no card to answer, skipped`); continue; }
        await choice.click();
        await page.waitForTimeout(300);
        await folded();
        const box = await reader.boundingBox(), y = await visibleReaderContentTop(reader) + 100;
        await run(`swipe-next-${round}`, 1400, () => swipe(page, { x: box!.x + 80, y }, { x: box!.x + 240, y }));
        if (await showing() === was) console.error(`swipe-next-${round}: card stayed`);
        // Auto-swipe off (the default): the card and the input stay; only the sent words leave the input.
        await folded();
        await page.locator('[data-auto-swipe]').first().click();
        await page.waitForTimeout(300);
        was = await showing();
        await write('補足です');
        await run(`stay-send-${round}`, 1000, () => page.locator('[data-ask-send]').click());
        if (await showing() !== was) console.error(`stay-send-${round}: card moved`);
        if (!await page.locator('[data-one-input]').count()) console.error(`stay-send-${round}: input folded`);
        await folded();
      }
      await context.close();
    } finally { await runtime.stop(); }
  }
} finally { clearTimeout(expiry); await browser.close(); }
