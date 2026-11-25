/**
 * The Working row opens and closes as every History row does (history-row-toggle): its body unfolds over the
 * shared disclosure step, so the row grows over several frames rather than at once, only grows while it opens and only
 * shrinks while it closes, its head (time, who, ⌄) stays still, and its words are drawn on every frame of the way,
 * once (never a folding copy over an unfolding one), with no empty band under them on the way; the step under them
 * switches at once and keeps the row from moving against its press. Before any press it stands still: its folded lines
 * are drawn where they are, not slid out as the page comes.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Locator } from '@playwright/test';
import { RunStore } from '@alpacawork/runs';
import { OutputActivityReader } from '@alpacawork/backend/test-dist/runs/activity.js';
import { AGENT_RUNTIME_ADAPTERS } from '@alpacawork/backend/test-dist/agents/registry.js';
import { startServer } from './fixture/server.ts';
import { runningRunsTest } from './fixture/running-runs.ts';
import { expect, settleMotion } from './fixtures.ts';

const words = '調査をまとめました。History の各項目の開閉を確かめ、作業者の出力欄も同じ部品で開閉させます。'.repeat(6);
const test = runningRunsTest.extend({
  runtime: async ({ scene }, use) => {
    const store = new RunStore(scene.root, { busyTimeoutMs: 1000 });
    const owner = store.read().find(run => run.task === scene.busy && run.role === 'owner')!;
    const folder = store.folder(owner.id);
    // A step under way under the words: it switches with them.
    const command = { id: 'step', type: 'command_execution', command: 'pnpm vitest run tests/billing/amount.test.ts --reporter=dot' };
    writeFileSync(join(folder, 'stdout.log'), [{ type: 'item.started', item: command },
      { type: 'item.completed', item: { type: 'agent_message', text: words } }].map(row => JSON.stringify(row) + '\n').join(''));
    new OutputActivityReader(AGENT_RUNTIME_ADAPTERS.codex).poll(folder);
    store.close();
    const app = await startServer(scene.root, 0);
    try { await use({ root: scene.root, origin: new URL(app.url).origin }); } finally { await app.close(); }
  },
});

/** The row's height on every frame from the press until it has settled, where its head's parts are, and whether its words are drawn. */
const frames = (row: Locator) => row.evaluate(item => new Promise<{ heights: number[]; heads: string[]; said: boolean[]; copies: number[]; bands: number[] }>(done => {
  // Each part's middle: the turning ⌄'s box grows on the way, its middle stays.
  const head = () => ['[data-rail-time]', '[data-working-model]', 'svg[data-icon="down"]'].map(selector => {
    const part = item.querySelector(`[data-working-person] ${selector}`)?.getBoundingClientRect();
    return part ? Math.round((part.top + part.bottom) / 2 - item.getBoundingClientRect().top) : null;
  }).join(',');
  const said = () => [...item.querySelectorAll('[data-working-note]')].some(note => {
    const box = note.getBoundingClientRect(), clip = note.closest('[data-disclosure-body]')?.getBoundingClientRect();
    return box.height >= 1 && (!clip || clip.height >= Math.min(box.height, 1));
  });
  const copies = () => item.querySelector('[data-working-person]')!.querySelectorAll('[data-working-note]').length;
  // What the lead's body shows under the end of its words: nothing, on any frame.
  const band = () => {
    const body = item.querySelector<HTMLElement>('[data-working-person] [data-disclosure-body]')!;
    const note = body.querySelector('[data-working-note]')!;
    // The words are seen down to their end or to the first clip round them, whichever comes first.
    let seen = note.getBoundingClientRect().bottom;
    for (let clip = note.parentElement; clip; clip = clip.parentElement) {
      if (getComputedStyle(clip).overflowY !== 'visible') seen = Math.min(seen, clip.getBoundingClientRect().bottom);
      if (clip === body) break;
    }
    return Math.max(0, Math.round(body.getBoundingClientRect().bottom - seen));
  };
  const heights = [item.getBoundingClientRect().height], heads = [head()], seen = [said()], counts = [copies()], bands = [band()], start = performance.now();
  const frame = () => {
    heights.push(item.getBoundingClientRect().height); heads.push(head()); seen.push(said()); counts.push(copies()); bands.push(band());
    if (performance.now() - start < 450) requestAnimationFrame(frame); else done({ heights, heads, said: seen, copies: counts, bands });
  };
  item.querySelector<HTMLElement>('[data-working-model]')!.click();
  requestAnimationFrame(frame);
}));
const against = (seen: number[], opening: boolean) => Math.max(0, ...seen.slice(1).map((height, at) => (opening ? -1 : 1) * (height - seen[at]!)));
const between = (seen: number[]) => seen.filter(height => height > Math.min(...seen) + 1 && height < Math.max(...seen) - 1).length;

test('the Working row opens and closes on the shared disclosure motion at PC and phone widths', async ({ page, runtime, scene }) => {
  await page.addInitScript(() => {
    const seen = window as unknown as { disclosureMoves: number };
    seen.disclosureMoves = 0;
    document.addEventListener('transitionrun', event => { if ((event.target as Element).matches?.('[data-disclosure-body]')) seen.disclosureMoves++; }, true);
  });
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${runtime.origin}/?agent=1&task=${scene.busy}`);
    const row = page.locator('[data-working-here]');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(row.locator('[data-working-note]').first()).toContainText('調査をまとめました');
    await expect(row.locator('[data-work-line]')).toContainText('pnpm vitest run');
    await settleMotion(page, row, true);
    expect(await page.evaluate(() => (window as unknown as { disclosureMoves: number }).disclosureMoves), 'nothing slides before a press').toBe(0);
    for (const opening of [true, false]) {
      const seen = await frames(row);
      await expect(row).toHaveAttribute('aria-expanded', String(opening));
      await settleMotion(page, row, true);
      expect(between(seen.heights), `${width}px ${opening ? 'opening' : 'closing'} moves over frames`).toBeGreaterThanOrEqual(2);
      expect(against(seen.heights, opening)).toBeLessThanOrEqual(0.5);
      expect(new Set(seen.heads).size, 'the head stays still').toBe(1);
      expect(seen.said.every(Boolean), 'the words are drawn on every frame').toBe(true);
      expect(new Set(seen.copies), 'the words are drawn once on every frame').toEqual(new Set([1]));
      expect(Math.max(...seen.bands), 'no empty band under the words').toBeLessThanOrEqual(1);
    }
  }
});
