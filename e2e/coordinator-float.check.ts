
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, open, openCoordinator, writeCoordinator, settleMotion as settled } from './fixtures.ts';
import { configureCoordinator, readyCoordinator } from './coordinator-fixture.ts';
import { seedReview } from './fixture/task-state.ts';

// On a computer the coordinator floats at the foot with no ground of its own round it (what scrolls shows round it,
// and a press there reaches it); on a phone it stands on the foot's ground from its top down; reading the list under it leaves the input up; sending with the keys from the input does
// not make the line it goes back to show a keyboard's focus.
test.use({ isolated: true });

test('on a screen lower than the list, its last row still scrolls clear of the input and takes a press', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 412, height: 240 });
  await open(page, runtime);
  await writeCoordinator(page); await settled(page);
  const end = await page.locator('[data-under-bar]').first().evaluate(list => {
    list.scrollTop = list.scrollHeight;
    const row = [...list.querySelectorAll<HTMLElement>('[data-motion-key]')].at(-1)!, box = row.getBoundingClientRect();
    const input = document.querySelector('[data-composer-frame]')!.getBoundingClientRect();
    return { list: list.getBoundingClientRect().bottom, bottom: box.bottom, input: input.top,
      pressed: row.contains(document.elementFromPoint(box.left + 40, box.top + box.height / 2)) };
  });
  expect(end.list).toBeLessThanOrEqual(240); expect(end.bottom).toBeLessThanOrEqual(end.input); expect(end.pressed).toBe(true);
});

// Folding the conversation while it works, its notice stands at the foot from the first frame
// (never over the conversation still leaving, then dropping with it), and come in there; the line and the input taking
// each other's place show what they hold from the first frame (no empty surface).
test('folded, what stands over the foot is placed at the foot at once and comes in there; a reshape never shows empty', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  seedReview(runtime.root, 'T112');
  // This checks the working fold, after the separate warm-up has published completion.
  await readyCoordinator(page, runtime);
  await page.setViewportSize({ width: 412, height: 915 });
  // Set to work from the list (no task's label before the words), then the task opened under it.
  await open(page, runtime);
  await writeCoordinator(page);
  const gate = join(runtime.root, 'answer-now');
  await page.keyboard.insertText(`wait:${gate}`); await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-coordinator-pill]')).toContainText('Working on it');
  await open(page, runtime, '?agent=1&task=T112');
  await expect(page.locator('[data-coordinator-pill]')).toContainText('Working on it');
  // What it says pulses while it works, so only the moves of the surfaces themselves are waited for.
  const still = (css: string) => expect.poll(() => page.locator(css).evaluate(el => el.getAnimations().every(move => move.playState === 'finished'))).toBe(true);
  await page.locator('[data-coordinator-pill]').click();
  await expect(page.locator('[data-coordinator-panel]')).toBeVisible(); await still('[data-coordinator-panel]');
  const first = await page.evaluate(() => {
    const box = (css: string) => { const el = document.querySelector<HTMLElement>(css)!, b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, opacity: Number(getComputedStyle(el).opacity) }; };
    const read = () => ({ pill: box('[data-coordinator-fold-row]'), input: box('[data-composer-frame]'), panel: box('[data-still-copy]:has([data-card-scroll])') });
    return new Promise<ReturnType<typeof read>>((resolve, reject) => {
      // Register before the click: read its first pre-paint frame, after React and the picture's microtasks.
      // Registering in a later task can already miss the entrance's first visible state under all-suite load.
      requestAnimationFrame(() => {
        try { resolve(read()); } catch (error) { reject(error); }
      });
      // Its ⌄ where it has one, else Esc (a phone, where its place is held and flicked down instead).
      const fold = document.querySelector<HTMLElement>('[data-coordinator-panel] [data-coordinator-fold]');
      if (fold) fold.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
  });
  // At the foot, over the input, while the conversation is still drawn going.
  expect(first.panel.opacity).toBeGreaterThan(0.5);
  for (const over of [first.pill]) {
    expect(over.bottom).toBeLessThanOrEqual(first.input.top);
    expect(first.input.top - over.bottom).toBeLessThan(24);
    expect(over.opacity).toBeLessThan(0.5);
  }
  await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0);
  await still('[data-coordinator-fold-row]');
  const rest = await page.evaluate(() => ['[data-coordinator-fold-row]'].map(css => {
    const el = document.querySelector<HTMLElement>(css)!; return { bottom: el.getBoundingClientRect().bottom, opacity: Number(getComputedStyle(el).opacity) };
  }));
  // Where they first stood, but for the little they rose (--motion-shift): they did not travel there.
  expect(Math.abs(rest[0]!.bottom - first.pill.bottom)).toBeLessThanOrEqual(7);
  expect(rest.map(r => r.opacity)).toEqual([1]);
  // The input put down: the line says its news from the first frame of its reshape.
  const shown = await page.evaluate(async () => {
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await frame();
    const line = document.querySelector<HTMLElement>('[data-coordinator-capsule]')!;
    return { moving: line.getAnimations().length > 0, opacities: [...line.children].map(part => Number(getComputedStyle(part).opacity)) };
  });
  expect(shown.moving).toBe(true);
  expect(shown.opacities.every(opacity => opacity === 1)).toBe(true);
  writeFileSync(gate, '');
});

// On a phone the open conversation's foot has what closes it where a computer has its maximize, and no maximize;
// pressed, the conversation closes as it does any other way and the input stays. A computer keeps its maximize.
test('a phone closes the conversation from its foot and has no maximize; a computer keeps both in its head', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await readyCoordinator(page, runtime);
  await page.setViewportSize({ width: 412, height: 915 });
  await open(page, runtime);
  await writeCoordinator(page);
  await openCoordinator(page);
  const phone = page.locator('[data-coordinator-phone]');
  await settled(page);
  // What scrolls behind shows nowhere in the slips round the input: under it, beside it, nor between it and the conversation.
  const slips = () => page.evaluate(() => {
    const input = document.querySelector('[data-composer-frame]')!.getBoundingClientRect(), card = document.querySelector('[data-coordinator-card]')!;
    const middle = (input.left + input.right) / 2, points: [number, number][] = [[middle, input.bottom + 3], [input.left - 4, (input.top + input.bottom) / 2], [middle, input.top - 4]];
    return points.map(([x, y]) => { const at = document.elementFromPoint(x, y); return !!at && (card.contains(at) || !!at.closest('[data-coordinator-panel]')); });
  });
  expect(await slips()).toEqual([true, true, true]);
  await expect(phone.locator('[data-coordinator-maximize]')).toHaveCount(0);
  await phone.locator('[data-coordinator-pane-controls] [data-coordinator-fold]').click();
  await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0);
  await expect(page.locator('[data-one-input]')).toBeVisible();
  await settled(page);
  expect((await slips()).slice(0, 2)).toEqual([true, true]);

  await page.setViewportSize({ width: 1280, height: 900 });
  await openCoordinator(page);
  await expect(page.locator('[data-coordinator-phone]')).toHaveCount(0);
  // On a computer the pane's own controls stand in its head, clear of the thread and its end row.
  const head = page.locator('[data-coordinator-panel] [data-coordinator-panel-head]');
  await expect(head.locator('[data-coordinator-maximize]')).toBeVisible();
  await expect(head.locator('[data-coordinator-fold]')).toBeVisible();
});

// A conversation with nothing in it yet fills the pane under the computer's taller head without scrolling.
test('on a computer, an empty conversation fits under its head without scrolling', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, '?agent=1');
  await openCoordinator(page);
  await expect(page.locator('[data-coordinator-warm]')).toBeVisible();
  await settled(page);
  const area = await page.locator('[data-coordinator-panel] [data-card-scroll]').evaluate(el => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(area.scroll).toBeLessThanOrEqual(area.client);
});
