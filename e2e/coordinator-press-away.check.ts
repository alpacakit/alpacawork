import { labelLayer } from './editor-surface.ts';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, open, openCoordinator, writeCoordinator, settleMotion, touch, swipe } from './fixtures.ts';
import type { Runtime } from './server.ts';
import { configureCoordinator, readyCoordinator } from './coordinator-fixture.ts';
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { seedReview, taskFolder } from './fixture/task-state.ts';
import { publishFixtureFiles } from './fixture-writes.ts';

// On a phone, with the conversation open, a tap on what it stands over (the list, a task's report) folds the
// conversation alone; the input stays up with what is in it, and the tap does what it does there. Scrolling, swiping,
// selecting, a held press, a key, and anything done in the conversation, the input or what they open leave it open.
// Folded, the same tap puts the input down to its one line with what is in it (it has no × of its own).
// On a computer the coordinator stands beside what is read and goes down by itself on no tap: the tap still does
// what it does there, and the input stays up as it was (foot.ts goesDownByItself).
test.use({ isolated: true });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
const field = (page: Page) => page.locator('[data-one-input]');
const panel = (page: Page) => page.locator('[data-coordinator-panel]');

/** An answered conversation, open, with words written in the input under it. */
async function talking(page: Page, runtime: Runtime, draft: string) {
  await readyCoordinator(page, runtime);
  await writeCoordinator(page);
  // Sent without the open task's label, it answers no card, so the task stays open (a send with the label sends an answered card off).
  await labelLayer(field(page)).locator('[data-label=task] button').last().click();
  await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(0);
  await field(page).click();
  await page.keyboard.insertText('markdown-answer');
  const sent = coordinatorMessage(page);
  await page.locator('[data-ask-send]').click();
  // The tap begins after this message's answer is imported; Run startup is not a UI response deadline.
  await coordinatorCompleted(page, runtime, await sent);
  expect(((await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation.turns as { status: string }[])
    .filter(turn => turn.status === 'succeeded')).toHaveLength(1);
  await expect(field(page)).toHaveCount(0);
  await openCoordinator(page);
  await field(page).click(); await page.keyboard.insertText(draft);
  await settleMotion(page);
  await expect(panel(page)).toBeVisible();
}
/** The conversation done rising (what says the coordinator is at it moves for as long as it is). */
const risen = (page: Page) => expect.poll(() => panel(page).evaluate(element =>
  element.getAnimations().every(animation => animation.playState !== 'running'))).toBe(true);
/** One finger held still for longer than a tap. */
async function hold(page: Page, at: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await page.waitForTimeout(700);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}
/**
 * A point on one of `selector`'s elements that nothing over it covers, and what it is (a row's task): along its line,
 * from its middle outwards, since a toast at the top of the list may stand over part of a row.
 */
async function pointOn(page: Page, selector: string) {
  return page.evaluate(selector => {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect(), y = box.top + Math.min(box.height / 2, 20);
      for (const share of [0.5, 0.25, 0.1]) {
        const x = box.left + box.width * share;
        if (y > 0 && y < innerHeight && element.contains(document.elementFromPoint(x, y)))
          return { x, y, task: (element.closest<HTMLElement>('[data-read]') ?? element.querySelector<HTMLElement>('[data-read]'))?.dataset.read ?? null };
      }
    }
    throw new Error(`nothing of ${selector} is in sight`);
  }, selector);
}
const ROW = '[data-row-head]';
const tap = (page: Page, phone: boolean, at: { x: number; y: number }) => phone ? touch(page, [[at]]) : page.mouse.click(at.x, at.y);


// On a phone the conversation covers what is read, so a tap on it (a row, the task's sheet) folds the open conversation;
// the run it was sent goes on and its answer still comes. A computer's conversation stands beside the report.
test('a tap on the task\'s report folds the conversation while it answers, and the answer still comes (phone)', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 412, height: 915 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  // The task's sheet left tall, its head over the conversation (as in the request's picture).
  await page.addInitScript(() => localStorage.setItem('alpacawork.sheetHeight', '0.85'));
  await open(page, runtime, '?task=T111');
  await talking(page, runtime, 'Short draft');
  // Sent, the input goes down to its line while the coordinator is at it; opened again, the conversation shows it.
  const gate = join(runtime.root, 'answer-now');
  await field(page).click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(`wait:${gate}`);
  await page.locator('[data-ask-send]').click();
  if (await panel(page).count() === 0) await openCoordinator(page);
  await risen(page);
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('[data-coordinator-turn=running]')).toHaveCount(1);
  // The task's report comes up over the list from a row, and that press folds the conversation too.
  await page.locator(ROW).first().click(); await expect(panel(page)).toHaveCount(0); await openCoordinator(page); await risen(page);
  const reader = page.locator('aside[data-reader-mode]');
  await expect(reader).toBeVisible(); await risen(page);
  await tap(page, true, await pointOn(page, 'aside[data-reader-mode] h2'));
  await expect(panel(page)).toHaveCount(0);
  await expect(reader).toBeVisible();
  writeFileSync(gate, '');
  await expect(field(page)).toBeVisible();
  await expect.poll(async () => ((await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation.turns as { status: string }[])
    .filter(turn => turn.status === 'succeeded').length).toBe(2);
});

const capsule = (page: Page) => page.locator('[data-coordinator-capsule]');
/** A point on the list under its last row, where a tap is on nothing but the list. */
const belowRows = (page: Page) => page.evaluate(() => {
  const last = [...document.querySelectorAll('[data-row-head]')].at(-1)!.getBoundingClientRect();
  return { x: last.left + 24, y: last.bottom + 40 };
});
async function stillUp(page: Page, draft: string) {
  await settleMotion(page);
  await expect(field(page)).toBeVisible(); await expect(field(page)).toContainText(draft);
}

// The phone's finger (swipes, a held touch) and the computer's mouse reach it by different ways, and the tap ends
// differently: a phone's input goes down to its line, a computer's stays up. Both keep what is in it.
for (const phone of [false, true]) test(`folded, a tap on the list does what it does there and keeps the input's words, files and recipients, ${phone ? 'putting it down to its line (phone)' : 'leaving it up (pc)'}`, async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  if (phone) await page.setViewportSize({ width: 412, height: 915 });
  await open(page, runtime);
  await writeCoordinator(page);
  const draft = 'Unfinished draft';
  await page.keyboard.insertText(draft);
  await expect(panel(page)).toHaveCount(0);
  // Presses in the input are its own: attaching through its attach button (the file picker over the page), and the words.
  const note = join(runtime.root, 'note.txt'); writeFileSync(note, 'Note');
  const picker = page.waitForEvent('filechooser');
  await page.locator('[data-composer-frame] [data-attach]').click();
  await (await picker).setFiles(note);
  await expect(page.locator('[data-composer-frame]')).toContainText('note.txt');
  await field(page).click();
  await stillUp(page, draft);
  // What the input opens over the screen takes the press outside it for itself: it closes, the input stays up.
  await page.locator('[data-composer-frame] button[aria-label="Insert a task or project"]').click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await tap(page, phone, await belowRows(page));
  await stillUp(page, draft);

  // Moved over the list, a finger or the mouse is reading or selecting it; held, it is for the words or the phone.
  const at = await pointOn(page, ROW);
  if (phone) { await swipe(page, at, { x: at.x, y: at.y + 120 }); await swipe(page, at, { x: at.x - 150, y: at.y }); }
  else { await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 120, at.y + 4, { steps: 6 }); await page.mouse.up(); }
  await stillUp(page, draft);
  const held = await pointOn(page, ROW);
  if (phone) await hold(page, held); else { await page.mouse.move(held.x, held.y); await page.mouse.down(); await page.waitForTimeout(700); await page.mouse.up(); }
  await stillUp(page, draft);
  if (!phone) { await page.locator(ROW).first().focus(); await page.keyboard.press('Enter'); await stillUp(page, draft); }

  const recipients = await labelLayer(field(page)).locator('[data-label=task] .tabular-nums').allTextContents();
  const row = await pointOn(page, `${ROW}:not(:has([aria-current]))`);
  await tap(page, phone, row);
  // Insert a task opens its picker by writing a #; dismissing it keeps that character in the draft.
  const keptDraft = `${draft} #`;
  expect(row.task).not.toBeNull();
  if (phone) {
    await expect(field(page)).toHaveCount(0);
    await expect(capsule(page).locator('[data-capsule-text]')).toHaveText(keptDraft);
    await expect(capsule(page).locator('[data-coordinator-write]')).toHaveAccessibleName(`Draft ${keptDraft}`);
    await expect(capsule(page).locator('[data-capsule-draft]')).toBeVisible();
    // Opening a row never adds its Task to an input the person is already composing.
    await expect.poll(() => capsule(page).locator('[data-capsule-label=taskLabel] .tabular-nums').allTextContents()).toEqual(recipients);
  }
  await expect.poll(() => decodeURIComponent(page.url())).toContain(row.task!.replace(/^default\//, ''));
  if (phone) {
    // Brought up again, it is as it was put down.
    await writeCoordinator(page);
  } else {
    // Read once the tap's motion is over: a fold that starts a frame later would pass a first read.
    await stillUp(page, keptDraft);
    await expect.poll(() => labelLayer(field(page)).locator('[data-label=task] .tabular-nums').allTextContents()).toEqual(recipients);
  }
  await expect(field(page)).toContainText(keptDraft);
  await expect(page.locator('[data-composer-frame]')).toContainText('note.txt');
});

// A finger's tap on the report's video, its picture or its play button, goes to the browser's own controls, which send
// no mouse press: the focus still leaves the input for the video (the keyboard goes down), as a mouse's press gives it. A tap on the report's words
// leaves the focus on the page, not handed back to the input's line.
test('a tap on the report\'s video or words takes the focus out of the input (phone)', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 412, height: 915 });
  const folder = join(taskFolder(runtime.root, 'T112'), 'media');
  mkdirSync(folder, { recursive: true });
  copyFileSync(new URL('./fixture/swipe-clip.webm', import.meta.url), join(folder, 'a.webm'));
  publishFixtureFiles(runtime.root);
  seedReview(runtime.root, 'T112', { title: 'Video review', description: 'Words of the report.\n\n![Video](media/a.webm)' });
  await open(page, runtime, '?task=T112');
  const video = page.locator('aside[data-reader-mode] video[data-task-video]');
  await video.scrollIntoViewIfNeeded();
  await writeCoordinator(page); await settleMotion(page);
  await tap(page, true, await pointOn(page, 'aside[data-reader-mode] video[data-task-video]'));
  await expect(video).toBeFocused();
  // The play button of the browser's controls, at their bottom left: the page hears only that it plays.
  await writeCoordinator(page); await settleMotion(page);
  const box = (await video.boundingBox())!;
  await tap(page, true, { x: box.x + 30, y: box.y + box.height - 30 });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => !element.paused)).toBe(true);
  await expect(video).toBeFocused();
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await writeCoordinator(page); await settleMotion(page);
  await tap(page, true, await pointOn(page, 'aside[data-reader-mode] p'));
  await expect(field(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(true);
});
