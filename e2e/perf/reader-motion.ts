/** Real Reader operations, same fixture and windows before/after. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { start } from '../server.ts';
import { patchTask } from '../fixture/task-state.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';
import { installProbe, measurer } from './motion-probe.ts';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  throttle: { type: 'string', default: '1' }, rounds: { type: 'string', default: '3' },
  film: { type: 'boolean' }, reduced: { type: 'boolean' }, widths: { type: 'string', default: '1440,390' },
  slow: { type: 'string' }, counts: { type: 'boolean' },
  extra: { type: 'boolean' }, stall: { type: 'boolean' },
  reports: { type: 'boolean' },
  overlay: { type: 'boolean' },
} });
const output = resolve(positionals[0] ?? '/tmp/reader-motion.json');
mkdirSync(dirname(output), { recursive: true });
const text = Array.from({ length: 8 }, (_, i) => `### Section ${i + 1}\nReading **work** and results.\n\n- Result one\n- Result two\n\n`).join('');
const logs = Array.from({ length: 12 }, (_, n) => ({ id: `reader-perf-${n}`, kind: 'reported',
  at: `2026-09-24T12:${String(n * 2).padStart(2, '0')}:00+09:00`, actor: { kind: 'human' }, fromState: null, toState: null,
  title: `Reader measurement ${n}`, description: text }));
const results: unknown[] = [];
const browser = await chromium.launch();
const expiry = setTimeout(() => process.exit(3), 20 * 60_000);
try {
  for (const width of args.widths.split(',').map(Number)) {
    // T111 is folded under T11 on the home list; the list press opens T113, which carries the same text and reports.
    const runtime = await start(undefined, root => { for (const id of ['T111', 'T113']) patchTask(root, id, { values: { notes: text.trim() }, logs: id === 'T111' ? logs : logs.map(log => ({ ...log, id: `${log.id}-${id}` })) }); });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width < 700,
        locale: 'en-US', timezoneId: 'Asia/Tokyo', reducedMotion: args.reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(SAMPLE_NOW));
      page.setDefaultTimeout(10000);
      page.on('pageerror', e => console.error('pageerror', e.message));
      await installProbe(page);
      if (args.counts) await page.addInitScript(() => {
        const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__, commit = hook.onCommitFiberRoot;
        (window as any).readerRenders = {};
        const name = (value: any): string => typeof value === 'function' ? value.displayName || value.name : value?.displayName || name(value?.type || value?.render || (() => 'Anonymous'));
        const walk = (fiber: any) => {
          if ([0, 1, 11, 14, 15].includes(fiber.tag) && (!fiber.alternate || fiber.flags & 1)) {
            const key = name(fiber.type); (window as any).readerRenders[key] = ((window as any).readerRenders[key] || 0) + 1;
          }
          if (fiber.alternate && fiber.alternate.child === fiber.child) return;
          for (let child = fiber.child; child; child = child.sibling) walk(child);
        };
        hook.onCommitFiberRoot = (...params: any[]) => { commit(...params); walk(params[1].current); };
      });
      // CSS transitions are absent from Element.animate. Capture their actual keyframes and timing as they start.
      await page.addInitScript(() => {
        (window as any).readerCSS = [];
        const record = (event: Event) => {
          if (!(event.target instanceof Element)) return;
          for (const animation of event.target.getAnimations()) {
            const effect = animation.effect as KeyframeEffect;
            (window as any).readerCSS.push({ type: event.type, target: event.target.getAttributeNames().filter(n => n.startsWith('data-')).join(','),
              property: (event as TransitionEvent).propertyName ?? (event as AnimationEvent).animationName,
              frames: effect.getKeyframes(), timing: effect.getTiming() });
          }
        };
        document.addEventListener('transitionrun', record, true);
        document.addEventListener('animationstart', record, true);
      });
      const measure = await measurer(page, context, { output, width, throttle: Number(args.throttle), film: args.film,
        extra: { reduced: !!args.reduced } }, results);
      const run = async (name: string, work: () => Promise<unknown>, valid?: () => Promise<boolean>) => {
        await page.evaluate(() => { (window as any).readerCSS = []; (window as any).readerRenders = {}; });
        const result = await measure(name, args.slow ? Number(args.slow) + 400 : 750, async () => {
          if (args.counts) await page.evaluate(() => { (window as any).readerRenders = {}; });
          await work();
          if (args.stall) await page.evaluate(() => setTimeout(() => { const end = performance.now() + 500; while (performance.now() < end) {} }, 40));
        });
        Object.assign(result, { css: await page.evaluate(() => (window as any).readerCSS),
          ...(args.counts ? { renders: await page.evaluate(() => (window as any).readerRenders) } : {}), ...(valid ? { valid: await valid() } : {}) });
        writeFileSync(output, JSON.stringify({ version: 1, browser: browser.version(), results }, null, 2));
      };
      const reader = page.locator('aside[data-reader-mode]');
      const area = reader.locator('[data-reader-content]');
      const show = async (id = 'T111') => {
        await page.goto(`${runtime.origin}/?agent=1&task=${id}`);
        await reader.locator('[data-reader-task-id]').waitFor();
        await reader.locator('[data-report-feed]').waitFor();
        await page.waitForTimeout(700);
        if (args.slow) await page.evaluate(ms => document.documentElement.style.setProperty('--motion-base', `${ms}ms`), args.slow);
      };
      const click = (selector: string) => page.locator(selector).first().evaluate((el: HTMLElement) => el.click());
      const close = () => reader.getByRole('button', { name: 'Close details', exact: true }).evaluate((el: HTMLElement) => el.click());
      const opened = async () => await reader.count() === 1;
      const disclosure = () => reader.getByRole('button', { name: 'Reader measurement 11', exact: false }).first();
      for (let round = 0; round < Number(args.rounds); round++) {
        if (args.overlay) {
          if (width < 700) throw Error('Overlay entry is the desktop case; use --widths 1440');
          await show();
          if (await reader.getAttribute('data-reader-mode') !== 'overlay') {
            await click('[data-reader-grow]'); await page.waitForTimeout(400);
          }
          await close(); await page.waitForTimeout(500);
          await run(`overlay-press-open-${round}`, () => click('[data-read="T113"]'), async () => await reader.getAttribute('data-reader-mode') === 'overlay');
          await run(`overlay-press-close-${round}`, close, async () => !await reader.count());
          continue;
        }
        if (args.reports) {
          await show();
          if (await disclosure().getAttribute('aria-expanded') === 'true') {
            await disclosure().evaluate((el: HTMLElement) => el.click()); await page.waitForTimeout(350);
          }
          await disclosure().evaluate(el => el.scrollIntoView({ block: 'center' }));
          await page.waitForTimeout(500);
          const visible = await disclosure().evaluate(el => {
            const box = el.getBoundingClientRect(), area = el.closest('[data-reader-content]')!.getBoundingClientRect();
            return box.top >= area.top && box.bottom <= area.bottom;
          });
          if (!visible) throw Error('The report heading is outside the Reader viewport');
          await run(`report-visible-open-${round}`, () => disclosure().evaluate((el: HTMLElement) => el.click()), async () => await disclosure().getAttribute('aria-expanded') === 'true');
          await run(`report-visible-close-${round}`, () => disclosure().evaluate((el: HTMLElement) => el.click()), async () => await disclosure().getAttribute('aria-expanded') === 'false');
          continue;
        }
        if (args.extra) {
          // These paths all reach crossfade through actual parent, child and body reference controls.
          await show();
          await run(`parent-switch-${round}`, () => reader.locator('header button').filter({ hasText: /^T11(?:$|\D)/ }).first().evaluate((el: HTMLElement) => el.click()), async () => await reader.locator('[data-reader-task-id]').innerText() === 'T11');
          await reader.locator('[data-family-entry]').evaluate((el: HTMLElement) => el.click());
          await page.locator('[data-family-row="T111"] [data-family-go]').waitFor();
          await page.waitForTimeout(400);
          await run(`child-switch-${round}`, () => click('[data-family-row="T111"] [data-family-go]'), async () => await reader.locator('[data-reader-task-id]').innerText() === 'T111');
          await reader.locator('[data-family-entry]').evaluate((el: HTMLElement) => el.click());
          await reader.locator('[data-reader-entry="about"]').evaluate((el: HTMLElement) => el.click());
          await reader.locator('[data-task-about]').waitFor();
          await page.waitForTimeout(400);
          // The fixture body is augmented only in this separate series, equally in both revisions.
          patchTask(runtime.root, 'T111', { values: { notes: ('See T113.\n\n' + text).trim() } });
          await reader.locator('[data-task-about] [data-task-reference="T113"]').first().waitFor({ state: 'attached' });
          // A body reference shows its card first; the switch measured is its Open's.
          await click('[data-task-about] [data-task-reference="T113"]');
          await page.locator('[data-badge-card] [data-task-card-open]').waitFor();
          await run(`reference-switch-${round}`, () => click('[data-badge-card] [data-task-card-open]'), async () => await reader.locator('[data-reader-task-id]').innerText() === 'T113');
          continue;
        }
        await show();
        await close(); await page.waitForTimeout(500);
        await run(`reader-open-${round}`, () => click('[data-read="T113"]'), opened);
        await run(`reader-close-${round}`, close, async () => !await reader.count());
        await show();
        if (width > 700) {
          await run(`overlay-open-${round}`, () => click('[data-reader-grow]'), async () => await reader.getAttribute('data-reader-mode') === 'overlay');
          await run(`overlay-close-${round}`, () => click('[data-reader-grow]'), async () => await reader.getAttribute('data-reader-mode') === 'docked');
        }
        if (await disclosure().getAttribute('aria-expanded') === 'true') { await disclosure().evaluate((el: HTMLElement) => el.click()); await page.waitForTimeout(350); }
        await disclosure().evaluate(el => el.scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(500);
        if (!await disclosure().evaluate(el => {
          const box = el.getBoundingClientRect(), area = el.closest('[data-reader-content]')!.getBoundingClientRect();
          return box.top >= area.top && box.bottom <= area.bottom;
        })) throw Error('The report heading is outside the Reader viewport');
        await run(`report-open-${round}`, () => disclosure().evaluate((el: HTMLElement) => el.click()), async () => await disclosure().getAttribute('aria-expanded') === 'true');
        await run(`report-close-${round}`, () => disclosure().evaluate((el: HTMLElement) => el.click()), async () => await disclosure().getAttribute('aria-expanded') === 'false');
        await area.evaluate(el => { el.scrollTop = 0; }); await page.waitForTimeout(400);
        await run(`family-open-${round}`, () => click('[data-family-entry]'), async () => await page.locator('[data-family-panel]').count() === 1);
        await run(`family-switch-${round}`, () => click('[data-family-row="T113"] [data-family-go]'), async () => await reader.locator('[data-reader-task-id]').innerText() === 'T113');
        await run(`family-close-${round}`, () => page.locator('[data-family-panel]').getByRole('button', { name: 'Close the task tree', exact: true }).evaluate((el: HTMLElement) => el.click()), async () => !await page.locator('[data-family-panel]').count());
        await show();
        await run(`report-arrival-${round}`, async () => {
          patchTask(runtime.root, 'T111', { logs: [{ ...logs[0]!, id: `arrived-${round}`, at: `2026-09-25T14:${20 + round}:00+09:00`, title: `Arrived ${round}`, description: text }] });
          await reader.locator(`[data-report-key="log:T111:arrived-${round}"]`).waitFor();
        }, async () => await reader.locator(`[data-report-key="log:T111:arrived-${round}"]`).count() === 1);
        if (width < 700) {
          // Wheel the real scroller: the auto-hiding header and stuck date divider change together.
          await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
          await area.evaluate(el => { el.scrollTop = 0; }); await page.waitForTimeout(400);
          const box = (await area.boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await run(`header-away-${round}`, () => page.mouse.wheel(0, 430), async () => await reader.locator('[data-reader-header]').getAttribute('data-reader-header') === 'hidden');
          await run(`header-back-${round}`, () => page.mouse.wheel(0, -90), async () => await reader.locator('[data-reader-header]').getAttribute('data-reader-header') === 'shown');
        }
      }
      await page.screenshot({ path: `${output}.${width}.png` });
      await context.close();
    } finally { await runtime.stop(); }
  }
} finally { clearTimeout(expiry); await browser.close(); }
