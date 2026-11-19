/** Alternating old/new stillCopy on one real heavy Reader, including placement and scroll restoration. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chromium } from '@playwright/test';
import { startPanelFixture, preparePanel } from './panel-fixture.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';

const [output, basePath, candidatePath] = process.argv.slice(2);
assert.ok(output && basePath && candidatePath, 'output.json before/motion.ts after/motion.ts required');
const extract = (path: string) => {
  const source = readFileSync(path, 'utf8'), begin = source.indexOf('export function stillCopy('), end = source.indexOf('/** The still copies fading', begin);
  assert.ok(begin >= 0 && end > begin);
  return ts.transpileModule(source.slice(begin, end).replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
};
const source = { before: extract(basePath), after: extract(candidatePath) };
const runtime = await startPanelFixture(true);
const browser = await chromium.launch();
const expiry = setTimeout(() => process.exit(3), 10 * 60_000);
try {
  const results = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true, isMobile: width < 700, bypassCSP: true });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(SAMPLE_NOW));
    await page.goto(`${runtime.origin}/?agent=1&task=T111`);
    await preparePanel(page, true);
    await page.waitForTimeout(500);
    const result = await page.evaluate(async source => {
      const versions = Object.fromEntries(Object.entries(source).map(([name, text]) => [name, new Function(`${text};return stillCopy;`)()]));
      const surface = document.querySelector<HTMLElement>('aside[data-reader-mode]')!;
      const make = (name: string, capture = false) => {
        void surface.offsetHeight; // each trial begins with the previous copy's removal already laid out
        const start = performance.now();
        const { copy, place } = versions[name](surface);
        copy.removeAttribute('data-reader-mode'); copy.removeAttribute('aria-label');
        surface.after(copy); place();
        const ms = performance.now() - start;
        const picture = capture ? { html: copy.outerHTML, scrolls: [...copy.querySelectorAll('*')].map(el => el.scrollTop).filter(n => n > 0) } : null;
        copy.remove();
        return { ms, picture };
      };
      const first = make('before', true), second = make('after', true);
      const samePicture = first.picture?.html === second.picture?.html && JSON.stringify(first.picture?.scrolls) === JSON.stringify(second.picture?.scrolls);
      const trials: { before: number; after: number }[] = [];
      for (let i = 0; i < 30; i++) {
        await new Promise(requestAnimationFrame);
        const order = i % 2 ? ['after', 'before'] : ['before', 'after'];
        const values = Object.fromEntries(order.map(name => [name, make(name).ms]));
        trials.push(values as { before: number; after: number });
      }
      return { samePicture, scrolls: first.picture?.scrolls, nodes: surface.querySelectorAll('*').length,
        remaining: document.querySelectorAll('[data-still-copy]').length, trials };
    }, source);
    assert.equal(result.samePicture, true, 'both implementations preserve the same markup and scrolls');
    assert.equal(result.remaining, 0);
    results.push({ width, ...result });
    await context.close();
  }
  writeFileSync(resolve(output), JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
