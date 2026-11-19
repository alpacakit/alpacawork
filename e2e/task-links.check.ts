import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openAbout, openReference, keepShot, settleMotion } from "./fixtures.ts";
import { patchTask, taskFolder } from "./fixture/task-state.ts";

test.use({ isolated: true });

test("Enter on a referenced task opens it where the pointer can hover, and focus does not return to the reader being replaced", async ({ page, runtime }) => {
  patchTask(runtime.root, "T113", { values: { notes: "関連タスク: T111" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runtime.origin}/?task=T113`);
  await openAbout(page.locator("aside[data-reader-mode]"));
  const reference = page.locator('[data-task-reference="T111"]').first();
  await expect(reference).not.toHaveAttribute('aria-haspopup');
  await reference.focus();
  // Retain the old node after navigation; its eventual removal would hide the redundant focus trip.
  const returned = await reference.evaluateHandle(element => {
    const seen = { count: 0 };
    element.addEventListener('focus', () => { seen.count++; });
    return seen;
  });
  try {
    await reference.press('Enter');
    await expect(page.locator('aside header [data-reader-task-id]')).toHaveText('T111');
    await expect(page.locator('[data-badge-card]')).toHaveCount(0);
    expect(await returned.evaluate(seen => seen.count)).toBe(0);
  } finally { await returned.dispose(); }
});

test("at 390px a file link is pressed on its own line only: stacked links keep their letters and lines keep their pitch", async ({ page, runtime }) => {
  for (const name of ["a.md", "b.md", "c.md"]) writeFileSync(join(taskFolder(runtime.root, "T113"), name), `${name}\n`);
  patchTask(runtime.root, "T113", { values: { notes: `- [AAAAAA](a.md)\n- [BBBBBB](b.md)\n- [External explanation](https://example.com/explanation)\n- [CCCCCC](c.md)\n\nPlace [AAAAAA](a.md) inside a paragraph followed by a long sentence that wraps onto the next line, then place [BBBBBB](b.md) after it.\n\n[This long file label wraps naturally with the surrounding sentence instead of forcing an early break or keeping the whole link on one line](c.md).` } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runtime.origin}/?task=T113`);
  await openAbout(page.locator("aside[data-reader-mode]"));
  const body = page.locator("aside").locator("ul", { hasText: "AAAAAA" }).locator("..");
  await expect(body.locator("ul a", { hasText: "CCCCCC" })).toBeVisible();
  const shortRows = body.locator("ul").filter({ has: page.locator('a[href="https://example.com/explanation"]') }).locator(":scope > li");
  await expect(shortRows).toHaveText(["AAAAAA", "BBBBBB", "External explanation", "CCCCCC"]);
  for (const [size, line] of [[14, 22], [13, 19.5], [20, 30]] as const) {
    await body.evaluate((element, step) => {
      element.style.fontSize = `${step.size}px`;
      element.style.lineHeight = String(step.line / step.size);
    }, { size, line });
    // The top, middle and bottom of each link's letters press that link, not the one on the line next to it.
    const hits = await body.evaluate(element => [...element.querySelectorAll("ul a, p a")].flatMap(link => {
      link.scrollIntoView({ block: "center" });
      const range = document.createRange();
      range.selectNodeContents(link);
      return [...range.getClientRects()].filter(rect => rect.width > 0).map(letters => {
        const x = letters.left + Math.min(15, letters.width / 2);
        return { link: link.textContent, pressed: [2, letters.height / 2, letters.height - 2]
          .map(y => document.elementFromPoint(x, letters.top + y)?.closest("a")?.textContent ?? null) };
      });
    }));
    expect(hits.length, "the long link wraps across lines").toBeGreaterThan(7);
    for (const { link, pressed } of hits) expect(pressed, link!).toEqual([link, link, link]);
    // What presses a file link reaches no further than its own line, so it cannot cover a line next to it however
    // close the lines are (a time note's are 19.5px apart).
    const reach = await body.evaluate(element => [...element.querySelectorAll<HTMLElement>("a:not([target])")].flatMap(link =>
      [...link.getClientRects()].map(rect => ({ link: link.textContent, height: rect.height, line: parseFloat(getComputedStyle(link).lineHeight) }))));
    expect(reach.length).toBeGreaterThan(6);
    for (const { link, height, line } of reach) expect(height, link!).toBeLessThanOrEqual(line + 2);
    // Compare the short file-link rows with their external-link control. Other fixture lists may wrap naturally.
    const items = await shortRows.evaluateAll(lis => lis.map(li => ({ text: li.textContent, height: li.getBoundingClientRect().height, line: parseFloat(getComputedStyle(li).lineHeight) })));
    await test.info().attach(`file-link-line-metrics-${size}`, { body: JSON.stringify({ reach, items }), contentType: "application/json" });
    expect(items).toHaveLength(4); // Three file links and the external-link control; unrelated prose may wrap.
    for (const item of items) expect(Math.abs(item.height - item.line)).toBeLessThan(1);
  }
  await keepShot(page, 'file-link-native-hit-box');
});

test("a bare address of this screen opens in the same tab without loading again, and Back returns", async ({ page, runtime }) => {
  patchTask(runtime.root, "T113", { values: { notes: `Search: ${runtime.origin}/?q=Invoice and related: ${runtime.origin}/?task=T111&tab=about and prototype: https://other.test:10000/?agent=1` } });
  await page.goto(`${runtime.origin}/?task=T113`);
  await openAbout(page.locator("aside[data-reader-mode]"));
  await expect(page.locator('[data-task-reference="T111"]').filter({ hasText: /^T111$/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://other.test:10000/?agent=1" })).toHaveAttribute("target", "_blank");
  await page.evaluate(() => { (window as unknown as { kept: boolean }).kept = true; });
  const before = page.url();
  await page.getByRole("link", { name: `${runtime.origin}/?q=Invoice` }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Invoice");
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
  await page.goBack();
  await expect.poll(() => page.url()).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { kept?: boolean }).kept)).toBe(true);
});


for (const screen of [{ width: 1440, phone: false }, { width: 390, phone: true }]) test.describe(`${screen.width}px reference card`, () => {
  test.use({ viewport: { width: screen.width, height: 900 }, hasTouch: screen.phone, isMobile: screen.phone });
  // Body and History share the card; one source is run at each width.
  for (const source of screen.phone ? ['History'] : ['body']) test(`${source}: hover or touch opens the shared card and its Open remains reachable`, async ({ page, runtime }, info) => {
    patchTask(runtime.root, 'T113', { values: { notes: 'Card reference: T111' } });
    if (source === 'History') patchTask(runtime.root, 'T113', { logs: [{ id: 'L680-reference', kind: 'reported',
      at: '2026-09-25T14:16:00+09:00', title: 'Card reference history', description: 'Related task: T111',
      actor: { kind: 'human' }, fromState: null, toState: null }] });
    await page.goto(`${runtime.origin}/?agent=1&task=T113`);
    if (source === 'body') await openAbout(page.locator('aside[data-reader-mode]'));
    else {
      await page.getByRole('button', { name: /Card reference history/ }).click();
      await settleMotion(page, page.locator('aside[data-reader-mode]'));
    }
    const reference = page.locator('[data-task-reference="T111"]').first();
    const card = page.getByRole('dialog', { name: 'T111', exact: true });
    await reference.hover();
    await page.clock.runFor(600);
    if (screen.phone) {
      await expect(card).toHaveCount(0);
      await reference.tap();
    }
    await expect(card).toBeVisible();
    await expect(page.locator('[data-task-peek]')).toHaveCount(0);
    await expect(card.locator('[data-task-card-open]')).toBeVisible();
    await expect(page.locator('aside header [data-reader-task-id]')).toHaveText('T113');
    if (!screen.phone) {
      const from = (await reference.boundingBox())!, to = (await card.boundingBox())!;
      const x = Math.max(to.x + 4, Math.min(from.x + from.width / 2, to.x + to.width - 4));
      const edge = to.y < from.y ? to.y + to.height : to.y;
      await page.mouse.move(x, (edge + (to.y < from.y ? from.y : from.y + from.height)) / 2, { steps: 10 });
      await page.clock.runFor(1000);
      await expect(card).toBeVisible();
      await card.locator('[data-task-card-open]').hover();
      await page.clock.runFor(1000);
      await expect(card).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath('reference-card.png') });
    if (screen.phone) await card.locator('[data-task-card-open]').tap();
    else await card.locator('[data-task-card-open]').click();
    await expect(page.locator('aside header [data-reader-task-id]')).toHaveText('T111');
    await expect(card).toHaveCount(0);
  });
});
