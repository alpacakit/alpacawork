import { projectRows } from './fixture/list-rows.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, open, readOnlyTest, settleMotion } from './fixtures.ts';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { patchTask, taskFolder } from './fixture/task-state.ts';

/** The Task's responsible as the one who reports its progress: a person writes no progress report of their own. */
function responsible(root: string, id: string) {
  const placements = new PlacementStore(root, true);
  try {
    const owner = placements.placements(id).find(item => item.responsible);
    if (!owner) throw new Error(`Sample Task ${id} has no responsible`);
    return { kind: 'placement' as const, placementId: owner.id };
  } finally { placements.close(); }
}

const reading = Array.from({ length: 10 }, (_, i) => `### ${i + 1}. Reviewed content\n\nCompared invoices and ledger; reviewing records, gaps and next steps.`).join('\n\n');
const test = readOnlyTest(root => {
  projectRows(root, ['T112', 'T113']);
  writeFileSync(join(taskFolder(root, 'T112'), 'result.md'), '# Review results\nReconciliation is complete.');
  for (const id of ['T112', 'T113']) patchTask(root, id, { values: { notes: reading.trim() }, state: 'doing', logs: [{
    id: `Lheader-${id}`, kind: 'reported', at: '2026-09-25T14:15:00+09:00', title: 'Monthly report review', description: reading,
    actor: responsible(root, id), fromState: 'doing', toState: 'doing',
  }] });
});
// The reader's own: a still copy fading over it as it turns to another task is drawn alike.
const header = (page: Page) => page.locator('[data-sheet] aside[data-reader-mode] [data-reader-header]');
const content = (page: Page) => page.locator('aside[data-reader-mode] [data-reader-content]');
async function wheel(page: Page, delta: number) {
  const box = (await content(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await expect.poll(() => content(page).evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await settleMotion(page);
}
async function shown(layer: Locator) { await expect(layer).toHaveAttribute('data-reader-header', 'shown'); }
async function hidden(layer: Locator) { await expect(layer).toHaveAttribute('data-reader-header', 'hidden'); }
async function openReading(page: Page, runtime: Parameters<typeof open>[1]) {
  await open(page, runtime, '?agent=1&task=T112');
  await expect(content(page)).toContainText('10. Reviewed content');
  await settleMotion(page);
}

test.describe('phone reading header', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });

  test('a header form stays below its controls, keeps focus, and prevents hiding; reduced motion skips travel', async ({ page, runtime }) => {
    await openReading(page, runtime);
    // The row's ordinary M action opens the section in the existing reader, also when its header is away.
    await page.locator('[data-read="T112"]').press('m');
    const form = header(page).locator('form');
    await expect(form).toBeVisible();
    await expect(form.locator('select').first()).toBeFocused();
    expect((await form.boundingBox())!.y).toBeGreaterThanOrEqual((await header(page).locator('header').boundingBox())!.y);
    await wheel(page, 360); await shown(header(page));
    await page.keyboard.press('Escape'); await expect(form).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // Closing the form changed the overlaid layer's reserved height. That first scroll rebases;
    // the next event of the reading gesture counts normally, without a timer or a form-specific policy.
    await wheel(page, 90); await shown(header(page));
    await wheel(page, 90); await hidden(header(page));
    expect(await header(page).evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0s');
  });
});
