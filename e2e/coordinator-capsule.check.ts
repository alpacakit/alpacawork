import { editorSurface } from './editor-surface.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, open, writeCoordinator } from './fixtures.ts';
import { configureCoordinator, startFakeCoordinator, revealReplies } from './coordinator-fixture.ts';
import { commandPost } from './command-post.ts';
import { placeResponsible } from './fixture/responsible.ts';
import { seedReview } from './fixture/task-state.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';

// The input form's input is down to one line at the screen's foot until it is pressed, and goes back down once
// what is written is sent; the conversation folds every exchange before the one it was opened on into one row.
test.use({ isolated: true });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
const capsule = (page: import('@playwright/test').Page) => page.locator('[data-coordinator-capsule]');
const field = (page: import('@playwright/test').Page) => page.locator('[data-one-input]');
// Every answer is read on the server, the shared read fact.
const allSeen = (page: import('@playwright/test').Page, origin: string) => async () => {
  const conversation = (await (await page.request.get(`${origin}/api/coordinator`)).json()).conversation;
  return (conversation.turns as { answeredAt: string | null; seen: boolean }[]).filter(turn => !!turn.answeredAt).every(turn => turn.seen);
};

// The line has no width of its own (CoordinatorCapsule); at a phone's width it opens into the phone's sheet.
test('the one line brings the input up, sending puts it down, and it says the work and the answer (phone)', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 412, height: 915 });
  await open(page, runtime);
  await expect(capsule(page)).toBeVisible(); await expect(field(page)).toHaveCount(0);
  // It says where to ask, the same before and after there is a conversation.
  await expect(capsule(page)).toContainText('Ask for anything here');
  // One line, round at both ends: no taller than its controls, wider than tall.
  const line = (await capsule(page).boundingBox())!;
  expect(line.height).toBeLessThanOrEqual(56); expect(line.width).toBeGreaterThan(line.height * 4);
  await writeCoordinator(page);
  await expect(editorSurface(field(page)).locator('[data-placeholder]')).toHaveAttribute('data-placeholder', 'Manage tasks and request work, all from here');
  // No × of its own: Esc, a tap away and sending put it down.
  await expect(page.locator('[data-composer-frame] [data-icon=close]')).toHaveCount(0);
  await expect(page.locator('[data-coordinator-ai]')).toContainText('opus');
  const gate = join(runtime.root, 'answer-now');
  await page.keyboard.insertText(`wait:${gate}`); await page.locator('[data-ask-send]').click();
  // Taken, the input goes down: the line says the coordinator is at it, at the same height.
  await expect(page.locator('[data-coordinator-pill]')).toContainText('Working on it'); await expect(field(page)).toHaveCount(0);
  // Once the input has shrunk back into it (they take each other's place reshaped).
  await expect.poll(async () => Math.abs((await capsule(page).boundingBox())!.height - line.height)).toBeLessThan(1);
  writeFileSync(gate, '');
  await expect(page.locator('[data-coordinator-pill]').locator('[data-coordinator-unseen]')).toBeVisible();
  // ∧ opens the conversation to read it; read, the line is where to write again.
  await page.locator('[data-coordinator-pill]').click();
  // The latest reply is shown directly; reveal earlier unread replies only when there are any.
  await revealReplies(page);
  await expect(page.locator('[data-ask-answer]')).toHaveCount(1, { timeout: 30_000 });
  // Read to its end: it opens at its head, and the fake's report of the run (its paths) can be taller than the
  // conversation.
  await page.locator('[data-coordinator-panel] [data-card-scroll]').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
  // Its end on screen is a shared server fact.
  await expect.poll(allSeen(page, runtime.origin)).toBe(true);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(capsule(page)).toContainText('Ask for anything here');
  await writeCoordinator(page);
  await expect(editorSurface(field(page)).locator('[data-placeholder]')).toHaveAttribute('data-placeholder', 'Manage tasks and request work, all from here');
});

for (const expanded of [false]) test(`Done actually approves the reviewed task and keeps the person's draft (${expanded ? 'open' : 'folded'})`, async ({ page, runtime }) => {
  startFakeCoordinator(runtime.root);
  await page.setViewportSize({ width: expanded ? 1440 : 320, height: 900 });
  const made = await commandPost(page.request, `${runtime.origin}/api/task/new`, {
    data: { parent: SAMPLE_PROJECT.id, title: 'Review from conversation controls' },
  });
  expect(made.ok()).toBe(true);
  const reviewed = await placeResponsible(page.request, runtime.origin, (await made.json()).task);
  seedReview(runtime.root, reviewed.id);
  await open(page, runtime, `?task=${reviewed.id}`);
  const task = async () => (await (await page.request.get(`${runtime.origin}/api/task/view?task=${reviewed.id}`)).json()).task;
  expect((await task()).state).toBe('waiting');
  await writeCoordinator(page);
  await page.keyboard.insertText('Keep these exact words, do not send this draft');
  const ownDraft = () => field(page).evaluate((el: any) => {
    const doc = el.editor.getJSON();
    return { ...doc, content: doc.content.map((block: any) => ({ ...block,
      content: block.content?.filter((node: any) => !(node.type === 'taskLabel' && node.attrs.auto)) })) };
  });
  const before = await ownDraft();
  if (expanded) await page.locator('[data-coordinator-pill]').click();
  const sent = page.waitForRequest(request => request.url().endsWith('/api/task/report'));
  // Done stands in the conversation's row: its open end, or its folded row.
  await page.locator(`${expanded ? '[data-coordinator-end]' : '[data-coordinator-fold-row]'} [data-task-done]`).click();
  const message = (await sent).postDataJSON();
  expect(message).toMatchObject({ task: reviewed.id, state: 'done' });
  expect(JSON.stringify(message)).not.toContain('Keep these exact words');
  await expect.poll(async () => (await task()).state, { timeout: 20_000 }).toBe('done');
  if (!await field(page).isVisible()) await writeCoordinator(page);
  expect(await ownDraft()).toEqual(before);
});
