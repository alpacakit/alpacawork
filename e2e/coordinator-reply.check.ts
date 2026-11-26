import { labelLayer } from './editor-surface.ts';
import { test as base, expect, open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, readyCoordinator, foldConversation } from './coordinator-fixture.ts';
import { start } from './server.ts';

const test = base.extend({ runtime: async ({}, use) => {
  const runtime = await start(undefined, configureCoordinator);
  try { await use(runtime); } finally { await runtime.stop(); }
} });
test.use({ isolated: true });

for (const phone of [false]) test.describe(phone ? 'phone reply' : 'pc reply', () => {
  if (phone) test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('reply takes every Task label off the draft for good, keeping a project label, words, files and the caret', async ({ page, runtime }) => {
    // The person's case: a message sent with the open Task's label keeps that label in the input; replying is not to it.
    await open(page, runtime, '?agent=1&task=T111'); await openCoordinator(page);
    await readyCoordinator(page, runtime);
    const field = page.locator('[data-coordinator-card] [data-one-input]');
    const tasks = labelLayer(field).locator('[data-label=task]');
    await expect(tasks).toHaveCount(1);
    await field.click(); await field.press('End'); await field.pressSequentially('markdown-answer');
    await page.locator('[data-coordinator-card] [data-ask-send]').click();
    const source = page.locator('[data-coordinator-turn=succeeded]').first();
    await expect(source).toBeVisible(); await expect(tasks).toHaveCount(1);
    await field.click(); await field.press('End');
    await field.evaluate(node => (node as HTMLElement & { editor: { commands: { insertContent: (content: unknown) => boolean } } }).editor.commands.insertContent([
      { type: 'taskLabel', attrs: { id: 'T112', title: '' } }, { type: 'taskLabel', attrs: { id: 'P1', title: '' } }, { type: 'text', text: ' keep these words about T13' }]));
    await expect(tasks).toHaveCount(3);
    const kept = page.locator('[data-coordinator-card] [data-attachment="kept.txt"]');
    await page.locator('[data-coordinator-card] input[type=file]').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('kept') });
    await expect(kept).toHaveAttribute('data-attachment-state', 'saved');
    // The answer replied to is the one pressed: its ID is read there, not from a later drawing of the conversation.
    const id = await source.locator('[data-reply-answer]').getAttribute('data-reply-answer');
    expect(id).toEqual(expect.any(String));
    await source.getByRole('button', { name: 'Reply to this message', exact: true }).click();
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1);
    await expect(tasks).toHaveText([/Accounting/]);
    await expect(field).toContainText('keep these words about T13'); await expect(field).toBeFocused();
    await expect(kept).toHaveAttribute('data-attachment-state', 'saved');
    await field.pressSequentially('!'); await expect(field).toContainText('keep these words about T13!');
    // The Task in view, or the next one opened, does not put its label back.
    await page.reload(); await openCoordinator(page);
    await open(page, runtime, '?agent=1&task=T113'); await openCoordinator(page);
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1);
    await expect(tasks).toHaveText([/Accounting/]);
    await expect(field).toContainText('keep these words about T13!');
    await expect(kept).toHaveAttribute('data-attachment-state', 'saved');
    // What is sent: the reply, the project's label, the words and the file; no Task recipient.
    const sent = page.waitForRequest(request => request.url().endsWith('/api/coordinator/messages') && request.method() === 'POST');
    await page.locator('[data-coordinator-card] [data-ask-send]').click(); const body = (await sent).postDataJSON();
    expect(body.replyTo).toBe(id); expect(body.text).toContain('P1'); expect(body.text).toContain('keep these words about T13!');
    expect(body.text).not.toMatch(/T11[123]/); expect(body.attachments).toHaveLength(1);
  });
  test(phone ? 'reply icon is a finger\'s press, and puts the document label in and back' : 'reply icon → document label → disclosure → send → explicit jump and return; reload and switching preserve the draft', async ({ page, runtime }, info) => {
    await open(page, runtime, '?agent=1'); await openCoordinator(page);
    await readyCoordinator(page, runtime);
    const field = page.locator('[data-coordinator-card] [data-one-input]');
    const send = page.locator('[data-coordinator-card] [data-ask-send]');
    await expect(field).toHaveAttribute('contenteditable', 'true');
    await field.fill('markdown-answer'); await send.click();
    const source = page.locator('[data-coordinator-turn=succeeded]').first();
    await expect(source).toBeVisible();
    await field.fill('Another source'); await send.click();
    await expect(page.locator('[data-coordinator-turn=succeeded]')).toHaveCount(2);
    const replyButton = source.getByRole('button', { name: 'Reply to this message', exact: true });
    await expect(replyButton).toBeVisible();
    const id = await replyButton.getAttribute('data-reply-answer');
    const replyBox = (await replyButton.boundingBox())!;
    // A finger's press on a phone. Above the sizes it may change with the row.
    expect(replyBox.width).toBeGreaterThanOrEqual(phone ? 36 : 28); expect(replyBox.height).toBeGreaterThanOrEqual(phone ? 40 : 28);
    // Copy's translated name is independently tested elsewhere; here inspect its adjacent button's actual hit box.
    const copyBox = await replyButton.locator('..').locator('[data-copy]').boundingBox();
    expect(copyBox!.width).toBe(replyBox.width); expect(copyBox!.x + copyBox!.width).toBe(replyBox.x);
    await replyButton.click();
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1);
    await expect(send).toBeDisabled();
    await replyButton.click(); await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1);
    // The label's × takes it out, as the screen's Task label's does; pressing the icon puts it back.
    await labelLayer(field).locator('[data-label=reply]').getByRole('button', { name: /^Remove Reply at/ }).click();
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(0);
    await replyButton.click(); await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1);
    // The rest has no branch by device; a phone's jump and way back: coordinator-reply-navigation.check.ts › an explicit reply jump.
    if (phone) return;
    await labelLayer(field).locator('[data-label=reply] button[aria-haspopup]').click();
    const dialog = page.getByRole('dialog', { name: "Coordinator's reply", exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.locator('strong')).toContainText('T11');
    await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    await field.press('End'); await field.pressSequentially('reply words');
    await page.locator('[data-reply-answer]').last().click();
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1); await expect(field).toContainText('reply words');
    await replyButton.click();
    await foldConversation(page);
    await page.keyboard.press('Escape'); // The header folds the conversation; Escape also puts its input down.
    await expect(page.locator('[data-capsule-label=replyLabel]')).toBeVisible();
    await expect(page.locator('[data-coordinator-write]')).toHaveAccessibleName(/Reply at.*reply words/);
    await page.reload(); await openCoordinator(page);
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(1); await expect(field).toContainText('reply words');
    // The outgoing HTTP reference is the Request ID, never parsed label text.
    const sent = page.waitForRequest(request => request.url().endsWith('/api/coordinator/messages') && request.method() === 'POST');
    await send.click(); const body = (await sent).postDataJSON(); expect(body.replyTo).toBe(id); expect(body.text).toBe('reply words');
    await expect(labelLayer(field).locator('[data-label=reply]')).toHaveCount(0);
    const message = page.locator(`[data-coordinator-message="${body.id}"]`);
    await expect(message).toHaveAttribute('data-coordinator-turn', 'succeeded');
    await expect(message.locator('[data-label=reply]')).toBeVisible();
    await message.locator('[data-label=reply] button[aria-haspopup]').click();
    await expect(message.locator('[data-label=reply]').getByRole('button', { name: /^Remove/ })).toHaveCount(0);
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
    await expect(page.locator('[data-reply-return]')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Go to the original reply', exact: true }).click();
    await expect(page.locator('[data-reply-return]')).toBeVisible();
    // The ring is on the answer's words going there, and on the sent words coming back, not on the whole exchange.
    await expect(page.locator('[data-reply-flash]')).toHaveCount(1);
    await expect(source.locator('[data-ask-answer][data-reply-flash]')).toBeInViewport();
    await page.locator('[data-reply-return]').click(); await expect(page.locator('[data-reply-return]')).toHaveCount(0);
    await expect(message.locator(`[data-coordinator-origin="${body.id}"][data-reply-flash]`)).toBeInViewport();
    await expect(page.locator('[data-reply-flash]')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('reply-sent.png') });
  });
});
