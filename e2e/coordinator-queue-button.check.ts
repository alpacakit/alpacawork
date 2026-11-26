
import { configureCoordinator, configureInputCoordinator, foldConversation } from './coordinator-fixture.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, open, openCoordinator } from './fixtures.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import { usableQueue } from './queue-geometry.ts';

// Where the conversation is shown, what waits to be sent is one button at its foot's left, opened over the
// conversation (grown out of the button, folding back into it).
test.use({ isolated: true });

// 320px is the tightest row (no breakpoint or container query between it and a wider phone).
test('delayed queue actions acknowledge the press without duplicate HTTP (320px)', async ({ page, runtime }, info) => {
  const width = 320;
  await page.setViewportSize({ width, height: 844 });
  const q = await inputQueue(page, runtime);
  const gates = new Map<string, { promise: Promise<void>; release: () => void; calls: number }>();
  for (const path of ['messages/send-now', 'messages/withdraw', 'messages', 'clear']) {
    let release!: () => void;
    const gate = { promise: new Promise<void>(done => { release = done; }), release: () => release(), calls: 0 };
    gates.set(path, gate);
    await page.route(`**/api/coordinator/${path}`, async route => { gate.calls++; await gate.promise; await route.continue(); });
  }
  try {
    const first = await q.send('First waiting message'), next = await q.send('Second waiting message');
    await open(page, runtime, '?agent=1'); await openCoordinator(page); await foldConversation(page); await button(page).click(); await usableQueue(page);
    const firstRow = over(page).locator(`[data-coordinator-waiting="${first}"]`);
    await firstRow.locator('[data-coordinator-send-now]').focus();
    await firstRow.locator('[data-coordinator-send-now]').evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
    await expect(firstRow.locator('[data-coordinator-send-now]')).toHaveCount(0);
    await expect(firstRow).toContainText('Sending…');
    await expect(firstRow.locator('[data-coordinator-withdraw]')).toBeEnabled();
    await expect.poll(() => gates.get('messages/send-now')!.calls).toBe(1);
    await usableQueue(page);
    const geometry = await firstRow.evaluate(row => {
      const parts = row.querySelector('[data-coordinator-row-control]')!, label = parts.querySelector('[role=status]')!;
      const text = document.createRange(); text.selectNodeContents(label);
      return { row: row.getBoundingClientRect().toJSON(), parts: parts.getBoundingClientRect().toJSON(), text: text.getBoundingClientRect().toJSON(), lines: text.getClientRects().length,
        fontSize: getComputedStyle(parts).fontSize, overflow: row.scrollWidth > row.clientWidth };
    });
    expect(geometry.overflow).toBe(false); expect(geometry.parts.right).toBeLessThanOrEqual(geometry.row.right);
    expect(geometry.text.height).toBeLessThanOrEqual(24);
    await info.attach(`queue-control-${width}`, { body: JSON.stringify(geometry), contentType: 'application/json' });
    await page.screenshot({ path: info.outputPath(`send-now-${width}.png`) });
    gates.get('messages/send-now')!.release(); await expect.poll(() => q.status(first)).toBe('joined');
    await expect(firstRow).toHaveCount(0);
    await expect.poll(() => focusedIn(page, `[data-coordinator-waiting="${next}"] [data-coordinator-row-control]`)).toBe(true);

    const cancelRow = over(page).locator(`[data-coordinator-waiting="${next}"]`);
    await cancelRow.locator('[data-coordinator-withdraw]').click();
    await expect(cancelRow).toContainText('Cancelling…');
    await expect(cancelRow.locator('[data-coordinator-withdraw]')).toHaveCount(0);
    await expect.poll(() => gates.get('messages/withdraw')!.calls).toBe(1);
    gates.get('messages/withdraw')!.release(); await expect(cancelRow).toHaveCount(0);
    await expect.poll(() => focusedIn(page, '[data-one-input]')).toBe(true);

    const field = page.locator('[data-coordinator-card] [data-one-input]');
    await field.fill('Words awaiting admission'); await page.locator('[data-ask-send]').click();
    await expect.poll(() => gates.get('messages')!.calls).toBe(1);
    await foldConversation(page);
    await button(page).click();
    const local = over(page).locator('[data-coordinator-waiting]').filter({ hasText: 'Words awaiting admission' });
    await expect(local.locator('[data-coordinator-withdraw]')).toBeEnabled();
    await local.locator('[data-coordinator-withdraw]').click(); await expect(local).toHaveCount(0);
    await openCoordinator(page);
    await expect(field).toContainText('Words awaiting admission');
    gates.get('messages')!.release();
    await expect.poll(() => gates.get('messages/withdraw')!.calls).toBe(2);

    // Clearing is in the usage ring's menu: pressed twice, the menu closes and the conversation holds still meanwhile.
    await page.locator('[data-coordinator-context]').click();
    const clear = page.locator('[data-coordinator-clear]'); await clear.click();
    await clear.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
    await expect(clear).toHaveCount(0);
    await expect(page.locator('[data-reading-column][inert]')).toHaveCount(1);
    await expect(page.locator('[data-ask-send]')).toBeDisabled();
    await expect(page.locator('[data-ask-send]')).toHaveAttribute('title', 'Clearing the conversation');
    await field.press('Enter'); expect(gates.get('messages')!.calls).toBe(1);
    await expect.poll(() => gates.get('clear')!.calls).toBe(1);
    await page.screenshot({ path: info.outputPath(`clear-${width}.png`) });
    gates.get('clear')!.release(); await expect(page.locator('[data-reading-column][inert]')).toHaveCount(0);
  } finally { for (const gate of gates.values()) gate.release(); q.release(); }
});

/** At work on one message with `texts` waiting behind it, the conversation open. */
async function waiting(page: Page, runtime: { root: string; origin: string }, texts: string[], replies = 0) {
  configureCoordinator(runtime.root);
  const release = join(runtime.root, 'release-queue');
  const conversation = (await (await page.request.get(new URL('/api/coordinator', runtime.origin).href)).json()).conversation;
  if (replies) {
    const answer = join(runtime.root, 'queue-prior-answer.md');
    writeFileSync(answer, Array.from({ length: 16 }, (_, n) => `Paragraph ${n + 1}: a prior answer keeps the conversation long.`).join('\n\n'));
    for (let n = 0; n < replies; n++) {
      const id = crypto.randomUUID();
      expect((await page.request.post(`${runtime.origin}/api/coordinator/messages`, {
        data: { conversationId: conversation.id, id, text: `answer-from:${answer}`, attachments: [] },
      })).ok()).toBe(true);
      await expect.poll(async () => (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation
        .turns.find((turn: { id: string }) => turn.id === id)?.status).toBe('succeeded');
    }
  }
  for (const text of [`wait:${release}`, ...texts]) expect((await page.request.post(new URL('/api/coordinator/messages', runtime.origin).href,
    { data: { conversationId: conversation.id, id: crypto.randomUUID(), text, attachments: [] } })).ok()).toBe(true);
  await open(page, runtime, '?agent=1');
  await openCoordinator(page);
  await foldConversation(page);
  await expect(button(page)).toBeVisible();
  // Arrived (the work under way keeps a pulse going, so the panel never stands wholly still).
  await page.waitForTimeout(600);
  return { release: () => writeFileSync(release, '') };
}
const button = (page: Page) => page.locator('[data-coordinator-queue-button]');
const over = (page: Page) => page.locator('[data-coordinator-queue-over]');
const panel = (page: Page) => page.locator('[data-coordinator-panel]');
const focusedIn = (page: Page, selector: string) => page.evaluate((selector: string) => !!document.activeElement?.closest(selector), selector);

/** Real serve and stdin receipts; no UI or conversation response is substituted. */
async function inputQueue(page: Page, runtime: { root: string; origin: string }) {
  configureInputCoordinator(runtime.root);
  const conversation = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
  const send = async (text: string) => {
    const id = crypto.randomUUID();
    expect((await page.request.post(`${runtime.origin}/api/coordinator/messages`, {
      data: { conversationId: conversation.id, id, text, attachments: [] },
    })).ok()).toBe(true);
    return id;
  };
  const status = async (id: string) => (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation
    .turns.find((turn: { id: string }) => turn.id === id)?.status;
  const action = (name: string, id: string) => page.request.post(`${runtime.origin}/api/coordinator/messages/${name}`, {
    data: { conversationId: conversation.id, id },
  });
  await send(`hold:${join(runtime.root, 'release-input')}`);
  await expect.poll(() => existsSync(join(runtime.root, 'agent-started'))).toBe(true);
  return { send, status, action, release: () => writeFileSync(join(runtime.root, 'release-input'), '') };
}

test.describe('phone Back', () => {
  test.use({ viewport: { width: 412, height: 846 }, hasTouch: true, isMobile: true });
  // Back closes what is open for a moment along with the page's step (lib/close-on-back): the queue too.
  test("Back folds the queue with the page's step", async ({ page, runtime }) => {
    test.setTimeout(120_000);
    const { release } = await waiting(page, runtime, ['First']);
    try {
      await expect(panel(page)).toHaveCount(0);
      // A step of the page's own to go back from: a task opened from the list.
      await page.getByRole('button', { name: /Expense classification/ }).first().click();
      await expect(page.locator('aside[data-reader-mode]')).toBeVisible();
      await openCoordinator(page); await foldConversation(page); await page.waitForTimeout(600);
      await button(page).click(); await expect(over(page)).toBeVisible();
      await page.goBack();
      await expect(over(page)).toHaveCount(0);
      await expect(page.locator('aside[data-reader-mode]')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: SAMPLE_PROJECT.title, level: 1 })).toBeVisible();
    } finally { release(); }
  });
});

for (const occupied of [true]) test(`a clear during send admission recovers words in the current conversation (390px, occupied=${occupied})`, async ({ page, runtime }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const q = await inputQueue(page, runtime);
  let release!: () => void, calls = 0;
  const held = new Promise<void>(done => { release = done; });
  await page.route('**/api/coordinator/messages', async route => { calls++; await held; await route.continue(); });
  try {
    await open(page, runtime, '?agent=1'); await openCoordinator(page);
    const field = page.locator('[data-coordinator-card] [data-one-input]');
    const original = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.id;
    await field.fill('Recover these words after clearing'); await page.locator('[data-ask-send]').click();
    await expect.poll(() => calls).toBe(1);
    await page.locator('[data-coordinator-context]').click();
    const clear = page.locator('[data-coordinator-clear]'); await clear.click(); await clear.focus(); await clear.press('Enter');
    await expect.poll(async () => (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.id).not.toBe(original);
    // Clear's server reply precedes the new input's rendered conversation/read basis.
    // Fill only the actual writable editor, while the original message POST is still held.
    if (occupied) {
      await expect(field).toHaveAttribute('contenteditable', 'true');
      await field.fill('Keep this new draft');
    }
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/coordinator/messages') && response.status() === 409);
    release(); await rejected;
    if (occupied) {
      const recovery = page.locator('[data-coordinator-local=refused]').filter({ hasText: 'Recover these words after clearing' });
      await expect(recovery).toBeVisible();
      await expect(field).toContainText('Keep this new draft');
      await expect(recovery.locator('[data-coordinator-take-back]')).toBeDisabled();
      await page.screenshot({ path: info.outputPath('retained-refusal-390.png') });
      await field.fill(''); await recovery.locator('[data-coordinator-take-back]').click();
      await expect(recovery).toHaveCount(0);
    }
    await expect(field).toContainText('Recover these words after clearing');
    const current = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.id;
    const drafts = await page.evaluate(({ root, current }) => {
      const state = JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!);
      return state.entries[JSON.stringify([root, 'coordinator', current])];
    }, { root: runtime.root, current });
    expect(drafts.values.doc).toContain('Recover these words after clearing');
    expect(calls).toBe(1);
    await expect.poll(async () => (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation.turns).toHaveLength(0);
    await page.screenshot({ path: info.outputPath('recovered-input-390.png') });
  } finally { release(); q.release(); }
});
