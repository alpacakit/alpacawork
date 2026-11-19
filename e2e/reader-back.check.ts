import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, openAbout, openReference, revealReaderHeader, settleMotion } from "./fixtures.ts";
import { patchTask, taskFolder } from "./fixture/task-state.ts";

/**
 * The reader's one Back: every step inside the open reader (another task, a folder, the files) keeps the place it left
 * and where the reader was in it, and Back (as the browser's Back) lands there as it was: the same row open, at the
 * same scroll. A file is read in the viewer over the reader, which stays where it was read: Back closes the viewer.
 * The head keeps no Context or Files (they are entries under the title).
 */
test.use({ isolated: true });

const reading = "This fictional field guide describes twelve imaginary plants. Each sample has a leaf drawing, a flower drawing, and a short invented description.\n\n";
function prepare(root: string) {
  const folder = taskFolder(root, "T113");
  mkdirSync(join(folder, "docs"), { recursive: true });
  writeFileSync(join(folder, "docs", "steps.md"), `# Steps\n\n${"Steps explained.\n\n".repeat(80)}End of steps.\n`);
  writeFileSync(join(folder, "notes.md"), "# Note\n");
  // A long note around a link into the Task's folder and a reference to another Task.
  patchTask(root, "T113", { values: { notes: `${reading.repeat(10)}[Pinned version steps](docs/steps.md)\n\n関連タスク: T114\n\n${reading.repeat(10)}`.trim() } });
}

const reader = (page: Page) => page.locator("aside[data-reader-mode]:visible");
const content = (page: Page) => reader(page).locator("[data-reader-content]");
const scroll = (page: Page) => content(page).evaluate(element => Math.round(element.scrollTop));
const param = (page: Page, key: string) => new URL(page.url()).searchParams.get(key);
const inView = (target: Locator) => target.evaluate(element => {
  const box = element.getBoundingClientRect(), area = element.closest("[data-reader-content]")!.getBoundingClientRect();
  return box.top >= area.top && box.bottom <= area.bottom;
});
/** Back as a person presses it: on a phone the head may have folded away while reading down, so they read up a little first. */
async function pressBack(page: Page, phone: boolean) {
  if (phone) {
    await revealReaderHeader(reader(page));
  }
  await reader(page).locator("header [data-reader-back]").click();
  // Back's replacement can put a parent reference under the stationary pointer. Leave that hover before the next
  // press: its card covers Context, and a locator click jumps onto the card and keeps it open instead of leaving it.
  if (!phone) {
    await page.mouse.move(0, 0);
    await expect(page.locator("[data-badge-card]")).toHaveCount(0);
  }
}
/** Read down to `target` in the middle, and say where the reader stands. */
async function readTo(page: Page, target: Locator) {
  await target.evaluate(element => element.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  return scroll(page);
}

for (const [name, viewport, phone] of [["computer", { width: 1440, height: 900 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
  test.describe(`on a ${name}`, () => {
    test.use({ viewport, isMobile: phone, hasTouch: phone });

    test("a file opened from Context and another task followed from it: Back lands on Context, at the same scroll; Forward and Back step the same way", async ({ page, runtime }) => {
      prepare(runtime.root);
      await page.goto(`${runtime.origin}/?task=T113&agent=1`);
      await expect(reader(page).locator("header [data-reader-task-id]")).toHaveText("T113");
      // The head keeps neither Context nor Files, and nothing is behind the reader yet.
      await expect(reader(page).locator("header").getByRole("button", { name: /Context|Files/ })).toHaveCount(0);
      await expect(reader(page).locator("[data-reader-back]")).toHaveCount(0);
      await openAbout(reader(page));
      await expect.poll(() => param(page, "tab")).toBe("about");
      const link = content(page).getByRole("link", { name: "Pinned version steps" }).first();
      // Context is short here, so its place may be the top: what matters is that Back finds the same place.
      const before = await readTo(page, link);

      await link.click();
      await expect.poll(() => param(page, "view")).toBe("T113/docs/steps.md");
      // Read down the file in the viewer, then Back: the viewer closes over Context, which has not moved.
      const viewer = page.locator("[data-viewer]");
      await expect(viewer.getByText("End of steps.", { exact: true })).toBeAttached();
      await viewer.locator("[data-viewer-scroll]").evaluate(element => element.scrollTo(0, 900));
      await page.goBack();
      await expect.poll(() => param(page, "view")).toBeNull();
      await expect(viewer).toHaveCount(0);
      await expect.poll(() => param(page, "tab")).toBe("about");
      await expect.poll(() => scroll(page)).toBe(before);
      expect(await inView(link)).toBe(true);
      // Context itself is a step: its Back goes on to the reports.
      await expect(reader(page).locator("[data-reader-back]")).toHaveCount(1);

      const reference = content(page).locator('[data-task-reference="T114"]').first();
      const atReference = await readTo(page, reference);
      await openReference(reference);
      await expect(reader(page).locator("header [data-reader-task-id]")).toHaveText("T114");
      await pressBack(page, phone);
      await expect(reader(page).locator("header [data-reader-task-id]")).toHaveText("T113");
      await expect.poll(() => scroll(page)).toBe(atReference);
      // The browser's Forward and Back are the same steps.
      await page.goForward();
      await expect(reader(page).locator("header [data-reader-task-id]")).toHaveText("T114");
      await page.goBack();
      await expect(reader(page).locator("header [data-reader-task-id]")).toHaveText("T113");
      await expect.poll(() => scroll(page)).toBe(atReference);
      expect(await inView(reference)).toBe(true);
    });

    if (!phone) test("a file opened straight from its URL: Back goes to the reports over its step, and × closes the reader", async ({ page, runtime }) => {
      prepare(runtime.root);
      // A link written when files opened in the Files tab: the file opens in the viewer over its folder.
      await page.goto(`${runtime.origin}/?task=T113&tab=files&path=docs%2Fsteps.md&agent=1`);
      await expect(page.locator("[data-viewer]").getByText("End of steps.", { exact: true })).toBeAttached();
      expect([param(page, "path"), param(page, "view")]).toEqual(["docs/", "T113/docs/steps.md"]);
      await expect(reader(page).locator("header [data-reader-back]")).toBeVisible();
      const length = await page.evaluate(() => history.length);
      await pressBack(page, false);
      await expect.poll(() => param(page, "tab")).toBeNull();
      expect(param(page, "view")).toBeNull();
      expect(await page.evaluate(() => history.length)).toBe(length);
      await expect(reader(page).locator("[data-reader-back]")).toHaveCount(0);
      // A link from the reports, then ×: the reader closes, whatever steps were taken inside it.
      await openAbout(reader(page));
      await content(page).getByRole("link", { name: "Pinned version steps" }).first().click();
      await expect.poll(() => param(page, "view")).toBe("T113/docs/steps.md");
      await reader(page).locator("header").getByRole("button", { name: "Close details" }).click();
      await expect(reader(page)).toHaveCount(0);
      expect(param(page, "task")).toBeNull();
    });
  });
}
