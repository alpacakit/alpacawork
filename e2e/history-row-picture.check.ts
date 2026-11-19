import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishFixtureFiles } from './fixture-writes.ts';
import { seedReview, taskFolder } from './fixture/task-state.ts';
import { test, expect, open, settleMotion } from './fixtures.ts';

test.use({ isolated: true });

/**
 * A closed History row with a picture keeps its ⌄ where every row has it (the head's right edge, on the time's
 * line) and the picture stands clear of it; opened, the row's coloured line runs from its head to the end of its body.
 */
for (const [width, height] of [[1440, 900]] as const) {
  test(`a pictured row's ⌄ lines up with the others clear of its picture, and its line runs down its body, at ${width}px`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height });
    const picture = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 700;
      const context = canvas.getContext('2d')!; context.fillStyle = '#43566d'; context.fillRect(0, 0, 1200, 700);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    writeFileSync(join(taskFolder(runtime.root, 'T112'), 'input.png'), Buffer.from(picture, 'base64'));
    publishFixtureFiles(runtime.root);
    await expect.poll(async () => {
      const view = await (await fetch(`${runtime.origin}/api/task/view?task=T112`)).json() as { task: { files: { name: string }[] } };
      return view.task.files.some(file => file.name === 'input.png');
    }).toBe(true);
    seedReview(runtime.root, 'T112', { title: 'Shall we go on with the quieter input?', description: 'A picture of the input.\n\n![Input](input.png)\n\nThe last paragraph.' });
    await open(page, runtime, '?agent=1&task=T112');
    const reader = page.locator('aside[data-reader-mode]:visible');
    const heads = reader.locator('[data-report-feed] li[data-report-key] article > div > button[aria-expanded]');
    await expect(heads.first()).toBeVisible();
    // Closed, every row: the newest report stands open at first.
    for (const head of await heads.all()) if (await head.getAttribute('aria-expanded') === 'true') await head.click();
    await expect(reader.locator('[data-report-feed] article button[aria-expanded] img')).toHaveCount(1);
    await settleMotion(page);
    const rows = await heads.evaluateAll(buttons => buttons.map(button => {
      const box = (element: Element | null) => element && element.getBoundingClientRect();
      const chevron = box(button.querySelector('svg[data-icon="down"]'))!, time = box(button.querySelector('time'))!, head = box(button)!;
      const picture = box(button.querySelector('img'));
      const crossing = picture ? Math.max(0, Math.min(chevron.right, picture.right) - Math.max(chevron.left, picture.left))
        * Math.max(0, Math.min(chevron.bottom, picture.bottom) - Math.max(chevron.top, picture.top)) : 0;
      // Its drawing square (4 to 20 of its 24) ends on the row's right edge, as every end mark's does (press-end).
      return { picture: !!picture, fromRight: Math.round(head.right - (chevron.right - chevron.width * 4 / 24)), crossing,
        offTimeLine: Math.round(Math.abs((chevron.top + chevron.bottom) / 2 - (time.top + time.bottom) / 2)) };
    }));
    expect(rows.filter(row => row.picture)).toHaveLength(1);
    // The same place on every row, the pictured one too, on the time's line; the picture does not cross it.
    expect(rows.map(row => row.fromRight)).toEqual(rows.map(() => 0));
    expect(rows.map(row => row.offTimeLine)).toEqual(rows.map(() => 0));
    expect(rows.map(row => row.crossing)).toEqual(rows.map(() => 0));

    // Opened, the review that waits on the user keeps its line, from its head to the foot of its body.
    const row = reader.locator('[data-report-feed] li[data-report-key]').filter({ hasText: 'Shall we go on with the quieter input?' });
    await row.locator('article > div > button[aria-expanded]').click();
    await expect(row.getByText('The last paragraph.')).toBeVisible();
    await page.mouse.move(1, 1); await settleMotion(page);
    const drawn = await row.evaluate(item => {
      const box = (element: Element) => element.getBoundingClientRect();
      const article = item.querySelector('article')!, line = item.querySelector('[data-report-line]')!, head = article.querySelector('button[aria-expanded]')!;
      const last = [...article.querySelectorAll('p')].at(-1)!;
      return { top: box(line).top - box(article).top, bottom: box(article).bottom - box(line).bottom, belowHead: box(line).bottom - box(head).bottom,
        pastLastWords: box(line).bottom - box(last).bottom };
    });
    expect(Math.round(drawn.top)).toBe(0);
    // It stops at the row's rule (1px), well past the head and the body's last words.
    expect(Math.round(drawn.bottom)).toBe(1);
    expect(drawn.belowHead).toBeGreaterThan(40);
    expect(drawn.pastLastWords).toBeGreaterThanOrEqual(0);
  });
}
