import { commandPost } from "./command-post.ts";
import { test, expect, keepShot, open, swipe, touch } from "./fixtures.ts";
import { startFakeCoordinator } from "./coordinator-fixture.ts";
import { placeResponsible } from "./fixture/responsible.ts";
import { seedReview } from "./fixture/task-state.ts";

test.use({ isolated: true, isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });

test("pinch-zoomed, a sideways finger on the reader pans the page and answers nothing; at normal scale a left swipe holds", async ({ page, runtime }) => {
  // The hold a left swipe asks for is carried out by the coordinator.
  startFakeCoordinator(runtime.root);
  const made = await commandPost(page.request, `${runtime.origin}/api/task/new`, { data: { title: "Check swiping while zoomed" } });
  expect(made.ok(), await made.text()).toBe(true);
  const task = await placeResponsible(page.request, runtime.origin, (await made.json()).task);
  seedReview(runtime.root, task.id, { title: "Please review",
    description: "Moving a finger sideways while zoomed pans the page without holding the report. At original zoom, swiping left holds it." });
  // The task's sheet at its tallest kept height, so its report is in what the zoom shows from the top.
  await page.addInitScript(() => localStorage.setItem("alpacawork.sheetHeight", "0.85"));
  await open(page, runtime, `?task=${task.id}`);
  const reader = page.locator("aside[data-reader-mode]");
  const content = reader.locator("[data-reader-content]");
  await expect(reader.locator("[data-reader-task-id]")).toContainText(task.id); await expect(reader).not.toHaveAttribute("data-held");
  const body = page.locator("body");
  const toast = page.locator("[data-toast]");
  // Use the report, after the title's sheet grip. It also fits in what a 2.5 times zoom shows (915 / 2.5 tall).
  const report = (await reader.locator("[data-report-feed]").boundingBox())!;
  const y = report.y + 20;
  expect(y).toBeLessThan(915 / 2.5);
  const session = await page.context().newCDPSession(page);
  const offsetLeft = () => page.evaluate(() => window.visualViewport!.offsetLeft);

  // The report's own toggle: the newest report stands open, so a tap folds it.
  const summary = reader.locator("[data-report-feed] button[aria-expanded]").first();
  await expect(summary).toHaveAttribute("aria-expanded", "true");
  const press = (await summary.boundingBox())!;

  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2.5 });
  await expect(body).toHaveAttribute("data-pinch-zoomed", "");
  await expect(content).toHaveCSS("touch-action", "manipulation");
  // A tap is still a tap.
  await touch(page, [[{ x: press.x + 30, y: press.y + press.height / 2 }]]);
  await expect(summary).toHaveAttribute("aria-expanded", "false");
  await keepShot(page, "reader-zoomed-before");
  // Emulated touches land at page coordinates; the finger lifts where the panned view still shows.
  await swipe(page, { x: 300, y }, { x: 50, y });
  await expect.poll(offsetLeft).toBeGreaterThan(100);
  await keepShot(page, "reader-zoomed-after");
  await expect(page.locator("[data-swipe-stamp]")).not.toHaveAttribute("data-swipe");
  await expect(reader).toHaveCSS("transform", "none");
  await expect(toast).toHaveCount(0);
  await expect(reader.locator("[data-reader-task-id]")).toHaveText(task.id);

  // A zoom too slight to see is no zoom: the report keeps its sideways finger.
  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1.05 });
  await expect(body).not.toHaveAttribute("data-pinch-zoomed");
  await expect(content).toHaveCSS("touch-action", "pan-y pinch-zoom");

  await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
  await expect(body).not.toHaveAttribute("data-pinch-zoomed");
  await keepShot(page, "reader-normal-before");
  await swipe(page, { x: 330, y }, { x: 80, y });
  await expect(toast).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(runtime.origin + `/api/task/view?task=${task.id}`)).json()).task.state).toBe('held');
  await keepShot(page, "reader-normal-after");
  await session.detach();
});
