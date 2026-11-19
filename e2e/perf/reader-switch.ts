/** Row → Reader, single and eight 200ms-apart presses; cold, warm and delayed transport. */
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
  film: { type: 'boolean' }, reduced: { type: 'boolean' }, counts: { type: 'boolean' },
  widths: { type: 'string', default: '1440,390' }, slow: { type: 'string' }, stall: { type: 'boolean' },
  profile: { type: 'boolean' },
} });
const output = resolve(positionals[0] ?? '/tmp/reader-switch.json');
mkdirSync(dirname(output), { recursive: true });
const ids = Array.from({ length: 8 }, (_, n) => `T11${n + 1}`);
const body = Array.from({ length: 16 }, (_, n) => `### Result ${n}\nRead the **results**, compare the work and check the next step.\n\n- Item one\n- Item two\n\n`).join('');
const browser = await chromium.launch();
const results: unknown[] = [];
const expiry = setTimeout(() => process.exit(3), 20 * 60_000);
try {
  for (const width of args.widths.split(',').map(Number)) {
    const runtime = await start(undefined, root => {
      for (const id of ids) patchTask(root, id, { state: 'doing', userRequested: true, values: { notes: body.trim() },
        logs: [{ id: `switch-${id}`, kind: 'reported', at: '2026-09-25T14:20:00+09:00',
          actor: { kind: 'human' }, fromState: 'doing', toState: 'doing', title: `Reader content ${id}`, description: body.slice(0, 900) }] });
    });
    try {
      for (let round = 0; round < Number(args.rounds); round++) {
        for (const scenario of ['single-cold', 'rapid-cold', 'rapid-warm', 'rapid-delayed']) {
          const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width < 700,
            locale: 'en-US', timezoneId: 'Asia/Tokyo', reducedMotion: args.reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          await page.clock.setFixedTime(new Date(SAMPLE_NOW));
          await installProbe(page);
          await page.addInitScript((counts) => {
            const probe = (window as any).switchProbe = { presses: [] as any[], requests: [] as any[], maxCopies: 0, copies: [] as any[], renders: {} as Record<string, number>, active: false };
            const original = window.fetch;
            window.fetch = async (...params) => {
              const url = new URL(String(params[0] instanceof Request ? params[0].url : params[0]), location.href);
              if (!['/api/task/view', '/api/task/history'].includes(url.pathname)) return original(...params);
              const entry = { path: url.pathname, id: url.searchParams.get('task'), start: performance.now(), end: null as number | null, state: 'pending' };
              probe.requests.push(entry);
              try { const response = await original(...params); entry.state = `response-${response.status}`; return response; }
              catch (error: any) { entry.state = error?.name === 'AbortError' ? 'aborted' : `failed:${error?.name}`; throw error; }
              finally { entry.end = performance.now(); }
            };
            const observe = () => {
              if (!probe.active) return;
              const count = document.querySelectorAll('[data-still-copy]').length;
              probe.maxCopies = Math.max(count, probe.maxCopies);
              probe.copies.push({ at: performance.now(), count });
              const press = probe.presses.at(-1);
              if (!press) return;
              const reader = document.querySelector('aside[data-reader-mode]');
              if (reader && reader.querySelector('header [data-reader-task-id]')?.textContent === press.id) {
                press.headerAt ??= performance.now();
                if (reader.querySelector(`[data-report-key="log:${press.id}:switch-${press.id}"]`)) press.bodyAt ??= performance.now();
              }
            };
            new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true,
              attributeFilter: ['data-reader-task-id', 'data-reader-mode', 'aria-busy', 'data-history-ready'] });
            document.addEventListener('click', event => {
              const row = event.target instanceof Element && event.target.closest('[data-read]');
              if (!row || !probe.active) return;
              probe.presses.push({ id: row.getAttribute('data-read'), at: performance.now(), headerAt: null, bodyAt: null });
              queueMicrotask(observe);
            }, true);
            if (counts) {
              const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__, commit = hook.onCommitFiberRoot;
              const named = (value: any): string => typeof value === 'function' ? value.displayName || value.name : value?.displayName || (value?.type || value?.render ? named(value.type || value.render) : 'Anonymous');
              const walk = (fiber: any) => {
                if ([0, 1, 11, 14, 15].includes(fiber.tag) && (!fiber.alternate || fiber.flags & 1)) {
                  const key = named(fiber.type); probe.renders[key] = (probe.renders[key] || 0) + 1;
                }
                if (fiber.alternate && fiber.alternate.child === fiber.child) return;
                for (let child = fiber.child; child; child = child.sibling) walk(child);
              };
              hook.onCommitFiberRoot = (...params: any[]) => { commit(...params); if (probe.active) walk(params[1].current); };
            }
          }, !!args.counts);
          if (scenario === 'rapid-delayed') await page.route(url => ['/api/task/view', '/api/task/history'].includes(url.pathname), async route => {
            await new Promise(resolve => setTimeout(resolve, 500));
            await route.continue().catch(() => {});
          });
          await page.goto(`${runtime.origin}/?agent=1&task=T111`);
          const reader = page.locator('aside[data-reader-mode]');
          await reader.locator('[data-report-key="log:T111:switch-T111"]').waitFor();
          // All eight requested row controls are in the flat list. Read-ahead still operates as in production.
          for (const id of ids) await page.locator(`[data-read="${id}"]`).first().waitFor({ state: 'attached' });
          if (scenario === 'rapid-warm') {
            for (const id of ids) {
              await page.locator(`[data-read="${id}"]`).first().evaluate((el: HTMLElement) => el.click());
              await reader.locator(`[data-report-key="log:${id}:switch-${id}"]`).waitFor();
            }
            await page.locator('[data-read="T111"]').first().evaluate((el: HTMLElement) => el.click());
          }
          await page.waitForTimeout(750);
          if (args.slow) await page.evaluate(ms => document.documentElement.style.setProperty('--motion-base', `${ms}ms`), args.slow);
          const run = await measurer(page, context, { output, width, throttle: Number(args.throttle), film: args.film, profile: args.profile,
            extra: { scenario, reduced: !!args.reduced, counts: !!args.counts } }, results);
          const sequence = scenario.startsWith('single') ? ['T114'] : [...ids.slice(1), 'T111'];
          const result = await run(`${scenario}-${round}`, args.slow ? Number(args.slow) + 800 : 1400, async () => {
            await page.evaluate(async ({ sequence, stall }) => {
              const probe = (window as any).switchProbe;
              Object.assign(probe, { active: true, presses: [], requests: [], maxCopies: 0, copies: [], renders: {} });
              const began = performance.now();
              for (let index = 0; index < sequence.length; index++) {
                const delay = began + index * 200 - performance.now();
                if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
                const row = document.querySelector<HTMLElement>(`[data-read="${sequence[index]}"]`);
                if (!row) throw Error(`Missing real row ${sequence[index]}`);
                row.click();
              }
              if (stall) setTimeout(() => { const end = performance.now() + 500; while (performance.now() < end) {} }, 40);
            }, { sequence, stall: !!args.stall });
          });
          const observation = await page.evaluate(() => { const probe = (window as any).switchProbe; probe.active = false; return probe; });
          const finalId = await reader.locator('[data-reader-task-id]').innerText();
          Object.assign(result, { observation, finalId, remainingCopies: await page.locator('[data-still-copy]').count(),
            valid: finalId === sequence.at(-1) && observation.presses.length === sequence.length && observation.presses.at(-1)?.bodyAt !== null,
            latencyMs: observation.presses.map((press: any) => ({ id: press.id, header: press.headerAt === null ? null : press.headerAt - press.at,
              content: press.bodyAt === null ? null : press.bodyAt - press.at })),
          });
          writeFileSync(output, JSON.stringify({ version: 1, browser: browser.version(), results }, null, 2));
          await page.screenshot({ path: `${output}.${width}-${scenario}-${round}.png` });
          await context.close();
        }
      }
    } finally { await runtime.stop(); }
  }
} finally { clearTimeout(expiry); await browser.close(); }
