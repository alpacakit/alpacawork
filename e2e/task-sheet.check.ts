import { projectRows } from './fixture/list-rows.ts';
import { patchTask } from './fixture/task-state.ts';
import { SAMPLE_NOW } from './fixture/sample.ts';
import type { Locator, Page } from "@playwright/test";
import { expect, keepShot, open, settleMotion, test, touch, swipe, openAbout, openReference } from "./fixtures.ts";

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => projectRows(root, ['T111', 'T113', 'T114'])); } });

/**
 * On a phone a task opens in a sheet from the bottom: two thirds of the screen at first, nothing dimmed behind
 * it. The grip sets its height (kept), a flick up makes the same sheet the whole screen. The URL is what the screen
 * shows: a task pressed anywhere (a reference in the sheet, a row behind it, the coordinator's card) is the
 * sheet's next step, the URL names it, Back shows the one before and Forward it again; × and a finger close the sheet,
 * and Back after them opens nothing again; what is open for a moment (a menu, a dialog, the coordinator unfolded)
 * closes with the step Back goes back over.
 */
const PHONE = { width: 412, height: 915 };
test.use({ isMobile: true, hasTouch: true, viewport: PHONE });

const sheet = (page: Page) => page.locator("[data-sheet]").filter({ has: page.locator("aside[data-reader-mode=sheet]") });
// The live sheet: a closing one leaves a still copy going down, which is no sheet of its own (no data-sheet).
const reader = (page: Page) => page.locator("[data-sheet] aside[data-reader-mode=sheet]");
const shown = (page: Page) => reader(page).locator("header [data-reader-task-id]");
const row = (page: Page, id: string) => page.locator(`[data-read="${id}"]`);
const top = async (box: Locator) => (await box.boundingBox())!.y;
const listScroller = (page: Page) => page.locator("[data-time-tree]");

async function openList(page: Page, runtime: Parameters<typeof open>[1]) {
  await open(page, runtime, "?");
  await expect(row(page, "T113")).toBeVisible();
}

/** A point of the list above the sheet, under the bar, with nothing to press there (as useCloseOnPressBehind reads it). */
async function emptyBehind(page: Page): Promise<[number, number]> {
  const point = await page.evaluate((width) => {
    const interactive = "[data-sheet], button, a, input, textarea, select, label, summary, [role=button], [data-task-reference]";
    const targets = Array.from(document.querySelectorAll(interactive), element => element.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0);
    // Native touch can choose a nearby row from its narrow side gutter. Use a clear area in the middle instead.
    const x = width / 2, clearance = 20;
    for (let y = 8; y < innerHeight / 3; y += 4) {
      const at = document.elementFromPoint(x, y);
      if (at?.closest("main") && !at.closest(interactive) && !targets.some(box =>
        x >= box.left - clearance && x <= box.right + clearance && y >= box.top - clearance && y <= box.bottom + clearance)) return [x, y];
    }
    return null;
  }, PHONE.width);
  expect(point).not.toBeNull();
  return point as [number, number];
}
const url = (page: Page) => new URL(page.url()).searchParams.get("task");
/** T111's Context names T114: the reference pressed in a task's text. */
async function followReference(page: Page) {
  await openAbout(reader(page));
  await openReference(reader(page).locator('[data-task-reference="T114"]').first(), { tap: true });
  await expect(shown(page)).toHaveText("T114");
}

test("a row opens its task in a sheet over two thirds of the screen; the list behind scrolls; a row behind shows its task in the same sheet as a step Back returns from", async ({ page, runtime }) => {
  await openList(page, runtime);
  await row(page, "T113").tap();
  await expect(shown(page)).toHaveText("T113");
  await settleMotion(page);
  expect(await top(sheet(page))).toBeCloseTo(PHONE.height / 3, -1);
  await keepShot(page, "sheet-open");
  // Nothing behind is dimmed or out of reach: the list scrolls under a finger above the sheet.
  const list = listScroller(page);
  expect(await list.evaluate((element) => !!element.closest("[inert]"))).toBe(false);
  const before = await list.evaluate((element) => element.scrollTop);
  await touch(page, [[{ x: 200, y: 280 }], [{ x: 200, y: 230 }], [{ x: 200, y: 160 }], [{ x: 200, y: 120 }]]);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
  await list.evaluate((element) => { element.scrollTop = 0; });
  // A row pressed behind: the same sheet shows it, and the URL names it, one step on.
  const steps = await page.evaluate(() => history.length);
  const surface = await reader(page).elementHandle();
  await row(page, "T111").tap();
  await expect(shown(page)).toHaveText("T111");
  expect(url(page)).toBe("T111");
  expect(await page.evaluate(() => history.length)).toBe(steps + 1);
  expect(await reader(page).evaluate((element, earlier) => element === earlier, surface)).toBe(true);
  await page.goBack();
  await expect(shown(page)).toHaveText("T113");
  await page.goForward();
  await expect(shown(page)).toHaveText("T111");
  // A press on nothing behind it takes it away.
  await page.touchscreen.tap(...await emptyBehind(page));
  await expect(reader(page)).toHaveCount(0);
});

test("a task named in the sheet's text is the sheet's next step: the URL names it, Back shows the first, Forward the second", async ({ page, runtime }) => {
  await openList(page, runtime);
  await row(page, "T111").tap();
  await settleMotion(page);
  const surface = await reader(page).elementHandle();
  await openAbout(reader(page));
  await keepShot(page, "sheet-before-follow");
  await openReference(reader(page).locator('[data-task-reference="T114"]').first(), { tap: true });
  await expect(shown(page)).toHaveText("T114");
  expect(url(page)).toBe("T114");
  // One sheet: what it shows changed, at the height it stands.
  expect(await reader(page).evaluate((element, earlier) => element === earlier, surface)).toBe(true);
  await expect(page.locator("[data-sheet]")).toHaveCount(1);
  expect(await top(sheet(page))).toBeCloseTo(PHONE.height / 3, -1);
  await keepShot(page, "sheet-followed");
  await page.goBack();
  await expect(shown(page)).toHaveText("T111");
  expect(url(page)).toBe("T111");
  await page.goForward();
  await expect(shown(page)).toHaveText("T114");
  // A reload shows what the URL names, and Back from it the task before.
  await page.reload();
  await expect(shown(page)).toHaveText("T114");
  await page.goBack();
  await expect(shown(page)).toHaveText("T111");
  // Context was a step of its own: Back from it is T111's reports, then the list.
  await page.goBack();
  await expect(shown(page)).toHaveText("T111");
  await expect(reader(page).locator("[data-task-about]")).toHaveCount(0);
  await page.goBack();
  await expect(reader(page)).toHaveCount(0);
});

test("a task's link opened straight on a phone has the list's step under it: × and then Back leave the app's steps", async ({ page, runtime }) => {
  await open(page, runtime);
  await open(page, runtime, "?task=T111");
  await expect(shown(page)).toHaveText("T111");
  await followReference(page);
  await page.goBack();
  await expect(shown(page)).toHaveText("T111");
  await reader(page).getByRole("button", { name: "Close details" }).tap();
  await expect(reader(page)).toHaveCount(0);
  await expect(row(page, "T113")).toBeVisible();
  await page.goBack();
  await expect(reader(page)).toHaveCount(0);
  expect(url(page)).toBeNull();
});

test("a sheet pulled down from the whole screen keeps its top edge while the finger holds it", async ({ page, runtime }) => {
  await openList(page, runtime);
  await row(page, "T113").tap();
  await expect(shown(page)).toHaveText("T113");
  await reader(page).locator("[data-reader-grow]").click(); await settleMotion(page);
  await expect(sheet(page)).toHaveAttribute("data-whole", "true");
  // Whole and still, it has no edge of its own; held, it has the edge it has at any other height.
  const edge = () => reader(page).evaluate((element) => getComputedStyle(element).borderTopColor);
  expect(await edge()).toBe("rgba(0, 0, 0, 0)");
  const grip = (await reader(page).locator("[data-task-sheet-grab]").first().boundingBox())!;
  const x = grip.x + grip.width / 2, y = grip.y + grip.height / 2;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (const down of [20, 60, 120]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + down }] });
  await expect(sheet(page)).toHaveAttribute("data-sheet-held", "");
  expect(await edge()).not.toBe("rgba(0, 0, 0, 0)");
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
});

test.describe("the task's analysis", () => {
  test.use({ runtimePrepare: async ({}, use) => {
    await use(root => {
      projectRows(root, ["T113"]);
      patchTask(root, "T113", { state: "done", userRequested: true, logs: [{
        id: "a3b272b4-8bcc-4008-8165-8f5625c91642", kind: "reported", at: SAMPLE_NOW,
        actor: { kind: "human" }, fromState: "doing", toState: "done", title: "Finished", description: null,
      }] });
    });
  } });

  test("the analysis list resizes, returns to its row after opening a task, and dismisses by touch", async ({ page, runtime }) => {
    await open(page, runtime);
    const dashboard = new URL(page.url());
    dashboard.searchParams.set("face", "analysis");
    dashboard.searchParams.set("span", "all");
    await page.goto(dashboard.href);
    await page.locator(".row-span-5").filter({ has: page.getByText("Finished tasks", { exact: true }) }).getByRole("button").tap();
    const listSheet = page.locator("[data-analysis-list]");
    const listGrip = listSheet.getByRole("separator", { name: "Analysis list height (up and down arrows)" });
    const analysisRow = listSheet.locator('[data-unit-row="T113"]');
    await expect(analysisRow).toBeVisible();
    await expect(listGrip).toBeVisible();
    const originalHeight = (await listSheet.boundingBox())!.height;
    const grip = (await listGrip.boundingBox())!;
    const start = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
    await swipe(page, start, { ...start, y: start.y - 74 });
    await expect.poll(async () => (await listSheet.boundingBox())!.height).toBeGreaterThan(originalHeight + 40);
    await settleMotion(page, listSheet);
    const height = (await listSheet.boundingBox())!.height;

    await analysisRow.tap();
    const analysis = reader(page).locator('[data-reader-entry="analysis"]');
    const history = reader(page).locator('[data-reader-entry="task"]');
    await expect(reader(page).locator("[data-task-analysis]")).toBeVisible();
    await expect(analysis).toHaveAttribute("aria-current", "page");
    const surface = await reader(page).elementHandle();
    await reader(page).locator("[data-reader-grow]").tap();
    await expect(sheet(page)).toHaveAttribute("data-whole", "true");
    await history.tap();
    await expect(shown(page)).toHaveText("T113");
    await expect(history).toHaveAttribute("aria-current", "page");
    await expect(reader(page).locator("[data-task-analysis]")).toHaveCount(0);
    expect(await reader(page).evaluate((element, original) => element === original, surface)).toBe(true);
    await expect(sheet(page)).toHaveAttribute("data-whole", "true");
    await page.goBack();
    await expect(reader(page).locator("[data-task-analysis]")).toBeVisible();
    await expect(analysis).toHaveAttribute("aria-current", "page");
    await history.tap();
    const back = reader(page).locator("[data-reader-back]");
    // Back walks the tabs as it does anywhere; on the step the row opened it goes back to the list.
    await expect(back).toHaveText("Back");
    await back.tap();
    await expect(analysis).toHaveAttribute("aria-current", "page");
    await expect(back).toHaveText("Back to list");
    await back.tap();
    await expect(reader(page)).toHaveCount(0);
    await expect(analysisRow).toBeFocused();
    expect((await listSheet.boundingBox())!.height).toBe(height);
    const returnedGrip = (await listGrip.boundingBox())!;
    const returned = { x: returnedGrip.x + returnedGrip.width / 2, y: returnedGrip.y + returnedGrip.height / 2 };
    await swipe(page, returned, { x: returned.x, y: PHONE.height - 28 });
    await expect(listSheet).toHaveCount(0);
    await expect(page).not.toHaveURL(/[?&]list=/);
  });
});
