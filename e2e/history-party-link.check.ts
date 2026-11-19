import { test, expect, open, settleMotion } from './fixtures.ts';
import { SAMPLE_NOW } from './fixture/sample.ts';
import { patchTask } from './fixture/task-state.ts';

test.use({ isolated: true });

/**
 * At the top of an open History row, another Task's tag is its kind's word, its ID and its agent, without the
 * Task's title, and the whole tag is the one way to that Task: a press on any of its words follows it, and Back opens
 * the row it was read in again.
 */
for (const [width, height] of [[1440, 900]] as const) {
  test(`an open row's child tag is the link to the child on any of its words, without its title, at ${width}px`, async ({ page, runtime }) => {
    patchTask(runtime.root, 'T118', { state: 'done', logs: [{ id: 'L-party-child', kind: 'reported', at: SAMPLE_NOW,
      actor: { kind: 'human' }, title: 'Finished independent child work', description: 'State report', fromState: 'doing', toState: 'done' }] });
    await page.setViewportSize({ width, height });
    await open(page, runtime, '?agent=1&task=T11');
    // The child's own History holds the same record, and a reader stepped away from can stay drawn: read T11's.
    const reader = page.locator('aside[data-reader-mode]').filter({ has: page.locator('[data-input-view="T11"]') });
    const row = reader.locator('[data-report-key="log:T118:L-party-child"]');
    const head = row.locator('article > div > button[aria-expanded]');
    if (await head.getAttribute('aria-expanded') !== 'true') await head.click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await settleMotion(page);
    const tag = row.locator('[data-row-parties] [data-row-open][data-task-reference="T118"]');
    await expect(tag).toHaveCount(1);
    const child = await page.evaluate(async () => (await (await fetch('/api/task/view?task=T118')).json()).task.title as string);
    await expect(tag).not.toContainText(child);
    await expect(tag.locator('[data-row-title]')).toHaveCount(0);
    await expect(tag).toHaveAttribute('aria-label', new RegExp(child.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // One underline runs under the kind's word through the ID; no other part of the open row is a second way there.
    const words = tag.locator('[data-row-party]').locator('xpath=..');
    expect(await words.evaluate(element => getComputedStyle(element).textDecorationLine)).toBe('underline');
    await expect(row.locator('[data-row-parties] [data-task-reference="T118"]')).toHaveCount(1);
    // A press on the ID, not the tag's middle, follows the child; Back opens the row it was read in again.
    await tag.locator('[data-row-task]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe('T118');
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe('T11');
    await expect(row.locator('article > div > button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true');
    // And a press on its kind's word goes the same way.
    await row.locator('[data-row-parties] [data-row-open] [data-row-party]').click();
    await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe('T118');
  });
}
