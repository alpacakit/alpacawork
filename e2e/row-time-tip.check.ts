import { projectRows } from './fixture/list-rows.ts';
import { patchTask } from './fixture/task-state.ts';
import { readOnlyTest, expect, open } from "./fixtures.ts";

const test = readOnlyTest(root => {
  projectRows(root, ['T117']);
  patchTask(root, 'T117', { state: 'held', logs: [{ id: 'Lrow-time-held', kind: 'reported',
    at: '2026-09-25T12:00:00+09:00', actor: { kind: 'human' }, fromState: 'todo', toState: 'held', title: 'Review later', description: null }] });
});

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/**
 * A phone row's time is a press of its own over the row's: a tap on it opens what it means and stays on the list,
 * while a tap on the title just under it opens the task, so its hit area never reaches into the title's line.
 */
test("a row's time opens its words, and the title under it still opens the task", async ({ page, runtime }) => {
  await open(page, runtime);
  const time = page.locator("button[data-row-status='since']").first();
  await expect(time).toBeVisible();
  const list = await page.evaluate(() => location.pathname + location.search);
  const box = (await time.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator("[data-time-tip]")).toBeVisible();
  expect(await page.evaluate(() => location.pathname + location.search)).toBe(list);
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-time-tip]")).toHaveCount(0);
  const titleTop = await time.evaluate((element) => element.closest("[data-row-lines]")!.querySelector("[data-row-title-line]")!.getBoundingClientRect().top);
  await page.touchscreen.tap(box.x + box.width / 2, titleTop);
  await expect.poll(() => page.evaluate(() => location.pathname + location.search)).not.toBe(list);
  await expect(page.locator("[data-time-tip]")).toHaveCount(0);
});
