/** The trimmed still copy draws as the whole one. Both versions of stillCopy (base and candidate motion.ts) are
 * placed in turn exactly over the same real heavy reader (fixed, untransformed) and the reader's box is captured; the
 * PNGs must be byte-identical, at the top and scrolled half way, on a phone and a computer: the long report history
 * (`feed`), and a body that starts with a 160-row table whose 140th row has a long first cell, on the Context page
 * (`table`: a table's columns come from every row, so none of it may be left out). Then 27 plain shapes
 * whose look could hang on one long line two screens down (tables, grids, flex rows and columns, boxes sized to their
 * content, floats, columns, margins), each copied by both versions over the same plain page.
 * node --import ./e2e/guard-loader.mjs e2e/perf/still-copy-pixels.ts <out dir> <base motion.ts> <candidate motion.ts>
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { chromium } from '@playwright/test';
import { startPanelFixture } from './panel-fixture.ts';
import { patchTask } from '../fixture/task-state.ts';
import { SAMPLE_NOW } from '../fixture/sample.ts';

const [out, basePath, candidatePath] = process.argv.slice(2);
assert.ok(out && basePath && candidatePath);
mkdirSync(resolve(out), { recursive: true });
const extract = (path: string) => {
  const source = readFileSync(path, 'utf8'), begin = source.indexOf('export function stillCopy('), end = source.indexOf('/** The still copies fading', begin);
  assert.ok(begin >= 0 && end > begin);
  return ts.transpileModule(source.slice(begin, end).replace('export function', 'function'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
};
const source = { before: extract(basePath), after: extract(candidatePath) };
const runtime = await startPanelFixture(true);
// The long table goes on T112's body, opened on its Context page.
const rows = Array.from({ length: 160 }, (_, n) => `| ${n === 139 ? 'A first cell long enough to widen its column on every row of the table' : `Row ${n}`} | Value ${n} with a few words |`).join('\n');
patchTask(runtime.root, 'T112', { values: { notes: `| Name | Value |\n| --- | --- |\n${rows}\n\nAfter the table.` } });
const browser = await chromium.launch();
const expiry = setTimeout(() => process.exit(3), 10 * 60_000);
const summary: unknown[] = [];
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width < 700, isMobile: width < 700, bypassCSP: true, reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(SAMPLE_NOW));
    for (const scene of ['feed', 'table'] as const) {
    if (scene === 'feed') {
      await page.goto(`${runtime.origin}/?agent=1&task=T111`);
      await page.locator('[data-reader-content] [data-report-feed][data-history-ready="true"]').waitFor();
    } else {
      await page.goto(`${runtime.origin}/?agent=1&task=T112`);
      await page.locator('[data-reader-entry="about"]').click();
      await page.locator('[data-task-about] table').waitFor();
    }
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-reader-content] img')].every(img => img.complete));
    await page.waitForTimeout(800);
    for (const scroll of ['top', 'middle']) {
      await page.evaluate(where => { const area = document.querySelector<HTMLElement>('aside[data-reader-mode] [data-reader-content]')!;
        area.scrollTop = where === 'top' ? 0 : Math.round(area.scrollHeight / 2); }, scroll);
      await page.waitForTimeout(400);
      const shots: Record<string, Buffer> = {}, nodes: Record<string, number> = {};
      for (const name of ['before', 'after'] as const) {
        nodes[name] = await page.evaluate(({ text, name }) => {
          const stillCopy = new Function(`${text};return stillCopy;`)();
          const surface = document.querySelector<HTMLElement>('aside[data-reader-mode]')!;
          const box = surface.getBoundingClientRect();
          const { copy, place } = stillCopy(surface);
          copy.setAttribute('data-pixel-copy', name);
          Object.assign(copy.style, { position: 'fixed', inset: 'auto', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, margin: '0', transform: 'none', zIndex: '2147483647' });
          document.body.append(copy); place();
          return copy.querySelectorAll('*').length;
        }, { text: source[name], name });
        await page.waitForTimeout(200);
        const box = (await page.locator('aside[data-reader-mode]').boundingBox())!;
        shots[name] = await page.screenshot({ clip: box, animations: 'disabled' });
        writeFileSync(resolve(out, `${width}-${scene}-${scroll}-${name}.png`), shots[name]!);
        await page.evaluate(() => document.querySelectorAll('[data-pixel-copy]').forEach(each => each.remove()));
      }
      const same = shots.before!.equals(shots.after!);
      summary.push({ width, scene, scroll, same, nodes, original: await page.locator('aside[data-reader-mode] *').count() });
      console.log(JSON.stringify(summary.at(-1)));
    }
    }
    await context.close();
  }
  const LONG = 'A long line that is wider than its box, far down, long enough to widen it';
  const rows = (n: number, tag = 'div', style = '') => Array.from({ length: n }, (_, i) => `<${tag} style="${style}">${i === 150 ? LONG : 'r' + i}</${tag}>`).join('');
  const shapes: Record<string, string> = {
    table: `<table border=1 style="border-collapse:collapse">${Array.from({ length: 200 }, (_, i) => `<tr><td>${i === 150 ? LONG : 'r' + i}</td><td>Value ${i} with a few more words</td></tr>`).join('')}</table>`,
    wfit: `<div style="width:fit-content;border:2px solid red">${rows(200)}</div>`,
    wfitNarrow: `<div style="width:fit-content;max-width:100%;border:2px solid red">${rows(200, 'div', 'white-space:nowrap')}</div>`,
    flexStart: `<div style="display:flex;flex-direction:column;align-items:flex-start">${rows(200, 'div', 'border:1px solid blue')}</div>`,
    flexStartWide: `<div style="display:flex;flex-direction:column;align-items:flex-start"><div style="border:2px solid red">${rows(200)}</div></div>`,
    flexCenter: `<div style="display:flex;flex-direction:column;align-items:center"><div style="border:2px solid red">${rows(200)}</div></div>`,
    grid: `<div style="display:grid;grid-template-columns:auto 1fr">${Array.from({ length: 200 }, (_, i) => `<span>${i === 150 ? LONG : 'r' + i}</span><span>v${i}</span>`).join('')}</div>`,
    gridRows: `<div style="display:grid;grid-template-columns:max-content 1fr">${Array.from({ length: 200 }, (_, i) => `<div style="display:contents"><b>${i === 150 ? 'XXXXXXXXXXXXXXXXXX' : 'r' + i}</b><span>v${i}</span></div>`).join('')}</div>`,
    inlineBlock: `<div style="display:inline-block;border:2px solid red">${rows(200)}</div>`,
    floatBox: `<div style="float:left;border:2px solid red">${rows(200)}</div>`,
    absBox: `<div style="position:relative;height:9000px"><div style="position:absolute;left:0;top:0;border:2px solid red">${rows(200)}</div></div>`,
    olReversed: `<ol reversed>${rows(200, 'li')}</ol>`,
    colReverse: `<div style="display:flex;flex-direction:column-reverse">${rows(200)}</div>`,
    multicol: `<div style="columns:2">${rows(200)}</div>`,
    marginCollapse: `${Array.from({ length: 200 }, (_, i) => `<section><p style="margin:24px 0">${'r' + i}</p></section>`).join('')}`,
    wfitNested: `<div style="width:fit-content"><div>${rows(200)}</div></div>`,
    shrinkScroller: `<div style="width:fit-content;height:600px;overflow:auto;border:2px solid red">${rows(200)}</div>`,
    flexRowList: `<div style="display:flex;gap:8px"><div style="flex:none;border:2px solid red">${rows(200)}</div><div style="flex:1;background:#eee">right</div></div>`,
    plainList: rows(200),
    // An auto side margin in a flex column, and a scroller inside a box sized to its content.
    mxAutoInFlexCol: `<div style="display:flex;flex-direction:column"><div style="margin:0 auto;border:2px solid red">${rows(200)}</div></div>`,
    mlAutoInFlexCol: `<div style="display:flex;flex-direction:column"><div style="margin-left:auto;border:2px solid red">${rows(200)}</div></div>`,
    mxAutoInBlock: `<div style="margin:0 auto;border:2px solid red">${rows(200)}</div>`,
    scrollerInWfit: `<div style="width:fit-content;border:2px solid red"><div style="height:500px;overflow:auto">${rows(200)}</div></div>`,
    scrollerInFlexRowItem: `<div style="display:flex"><div style="flex:none;border:2px solid red"><div style="height:500px;overflow:auto">${rows(200)}</div></div><div style="flex:1;background:#ddd">right</div></div>`,
    scrollerInInlineBlock: `<div style="display:inline-block;border:2px solid red"><div style="height:500px;overflow:auto">${rows(200)}</div></div>`,
    scrollerInAbs: `<div style="position:relative;height:600px"><div style="position:absolute;top:0;left:0;border:2px solid red"><div style="height:500px;overflow:auto">${rows(200)}</div></div></div>`,
    flexColList: `<div style="display:flex;flex-direction:column;gap:4px">${rows(200)}</div>`,
  };
  const plain = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const [name, html] of Object.entries(shapes)) {
    await plain.setContent(`<body style="margin:0"><div id="w" style="width:380px;height:820px;display:flex;flex-direction:column"><div id="s" style="flex:1;min-height:0;overflow:auto;font:16px sans-serif;padding:0 8px;overflow-wrap:anywhere">${html}</div></div></body>`);
    const shots: Record<string, Buffer> = {}, nodes: Record<string, number> = {};
    for (const which of ['before', 'after'] as const) {
      nodes[which] = await plain.evaluate(text => {
        const stillCopy = new Function(`${text};return stillCopy;`)();
        const { copy, place } = stillCopy(document.getElementById('w')!);
        Object.assign(copy.style, { position: 'fixed', left: '0', top: '0', background: 'white', zIndex: '9' });
        copy.setAttribute('data-pixel-copy', '');
        document.body.append(copy); place();
        return copy.querySelectorAll('*').length;
      }, source[which]);
      shots[which] = await plain.screenshot({ clip: { x: 0, y: 0, width: 380, height: 820 } });
      await plain.evaluate(() => document.querySelector('[data-pixel-copy]')!.remove());
    }
    const same = shots.before!.equals(shots.after!);
    if (!same) for (const which of ['before', 'after'] as const) writeFileSync(resolve(out, `shape-${name}-${which}.png`), shots[which]!);
    summary.push({ shape: name, same, nodes });
    console.log(JSON.stringify(summary.at(-1)));
  }
  await plain.close();
  writeFileSync(resolve(out, 'summary.json'), JSON.stringify(summary, null, 2));
  assert.ok(summary.every((each: any) => each.same), 'the trimmed copy draws as the whole one');
} finally { clearTimeout(expiry); await browser.close(); await runtime.stop(); }
