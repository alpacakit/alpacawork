import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, open, openCoordinator, settleMotion, keepShot } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import { patchTask } from './fixture/task-state.ts';

// What is read under the coordinator is the person's to scroll. A finger or a wheel on a task's report scrolls
// that report and leaves the conversation (or its input) up; only the person puts it down. The conversation's own
// scroll and its close are unchanged, and the report stays where it was read.
test.use({ isolated: true });
const reading = Array.from({ length: 150 }, (_, at) => `### ${at + 1}. Reviewed content\n\nCompared invoices and ledger; reviewing records, gaps and next steps.`).join('\n\n');
const LONG = ['This is a long answer.', ...Array.from({ length: 40 }, (_, at) => `- ${at + 1}: one line of a long answer.`), '', 'This is the end of the answer.'].join('\n');
const report = (page: Page) => page.locator('aside[data-reader-mode] [data-reader-content]');
const panel = (page: Page) => page.locator('[data-coordinator-panel]');
const top = (area: Locator) => area.evaluate(element => element.scrollTop);
/** Where `area` comes to rest once a finger's fling has run out. */
async function rest(area: Locator) {
  let last = -1;
  for (;;) {
    const now = await top(area);
    if (now === last) return now;
    last = now; await area.page().waitForTimeout(250);
  }
}

async function prepare(page: Page, runtime: Parameters<typeof open>[1]) {
  configureCoordinator(runtime.root);
  patchTask(runtime.root, 'T112', { values: { notes: reading.trim() } });
  const file = join(runtime.root, 'long-answer.md'); writeFileSync(file, LONG);
  await open(page, runtime, '?agent=1');
  const { id } = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation;
  expect((await fetch(`${runtime.origin}/api/coordinator/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId: id, id: crypto.randomUUID(), text: `answer-from:${file}`, attachments: [] }) })).ok).toBe(true);
  await expect.poll(async () => (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation.turns.some((turn: { answeredAt: string | null }) => !!turn.answeredAt), { timeout: 20_000 }).toBe(true);
  await open(page, runtime, '?agent=1&task=T112');
  // A task opens on its latest report; the long body is read in its Context.
  await page.locator('aside[data-reader-mode] [data-reader-entry="about"]').click();
  await expect(report(page)).toContainText("150. Reviewed content");
  await settleMotion(page);
}
/** A point on the report that a press reaches (not under the conversation). */
async function onReport(page: Page) {
  const box = (await report(page).boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + 100 };
  expect(await report(page).evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), point)).toBe(true);
  return point;
}

test('on a computer a wheel on the report scrolls it under the open conversation, which stays up until closed', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepare(page, runtime);
  await openCoordinator(page); await settleMotion(page);
  const at = await onReport(page);
  await page.mouse.move(at.x, at.y);
  for (let step = 0; step < 8; step++) { await page.mouse.wheel(0, 80); await page.waitForTimeout(30); }
  await keepShot(page, 'pc-after-wheel');
  const read = await rest(report(page));
  expect(read).toBeGreaterThan(200);
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Close the conversation', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await top(report(page))).toBe(read);
});
