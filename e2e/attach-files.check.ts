
import { test, expect, open, openCoordinator } from './fixtures.ts';
import { configureCoordinator, readyCoordinator, foldConversation } from './coordinator-fixture.ts';
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { writeFixtureConfig } from './fixture-writes.ts';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { Runtime } from './server.ts';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==', 'base64');
const card = (page: Page) => page.locator('[data-coordinator-card]');
const input = (page: Page) => page.locator('[data-one-input]');
test.use({ isolated: true });
test.describe.configure({ timeout: 90_000 });
async function begin(page: Page, runtime: Runtime) {
  configureCoordinator(runtime.root); await open(page, runtime, '?agent=1&task=T117');
  await openCoordinator(page);
  await expect(card(page).getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
  await readyCoordinator(page, runtime);
}
const upload = (page: Page, files = [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG }]) => card(page).locator('input[type=file]').setInputFiles(files);

test('coordinator attachments survive reload, open in its viewer and reach the agent with the one input’s words', async ({ page, runtime }) => {
  await begin(page, runtime); await input(page).press('End'); await page.keyboard.insertText('Please review these two');
  await upload(page, [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Note') }]);
  await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(2);
  const picture = card(page).locator('[data-attachment=shot\\.png] button').first(); await picture.click();
  await expect(page.locator('[data-image-slider-modal]')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(card(page)).toBeVisible(); await expect(input(page)).toContainText('these two');
  await page.reload(); await openCoordinator(page);
  await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(2);
  const sent = coordinatorMessage(page);
  await input(page).press('ControlOrMeta+Enter');
  await coordinatorCompleted(page, runtime, await sent);
  await expect(page.locator('[data-coordinator-panel] [data-ask-answer]')).toHaveCount(1);
  const answer = JSON.parse((await page.locator('[data-coordinator-panel] [data-ask-answer]').textContent())!);
  expect(answer.prompt).toContain('these two'); expect(answer.prompt).toContain('shot.png'); expect(answer.prompt).toContain('notes.txt'); expect(answer.attachmentBytes).toEqual({ 'shot.png': PNG.length, 'notes.txt': Buffer.byteLength('Note') });
});

test('uncertain send reloads with the same ID, words, files and selection; a new share goes to the next draft meanwhile', async ({ page, runtime }) => {
  await begin(page, runtime); await input(page).fill('Fixed words'); await upload(page); await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(1);
  const sent: any[] = [];
  // The connection fails on the first: whether serve has it is not known here (it does not).
  await page.route('**/api/coordinator/messages', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await route.abort('connectionfailed'); else await route.continue();
  });
  await card(page).locator('[data-ask-send]').click();
  const unknown = page.locator('[data-coordinator-local=unknown]');
  await expect(unknown).toContainText('Fixed words'); await expect(input(page)).toHaveAttribute('contenteditable', 'true');
  // Until it is admitted its words and file stay with its own message (none of it is in the input), and they cannot
  // be sent a second time.
  await expect(unknown.locator('[data-message-file], img, a')).not.toHaveCount(0);
  await expect(input(page)).not.toContainText('Fixed words'); await expect(card(page).locator('[data-attachment="shot.png"]')).toHaveCount(0);
  await expect(card(page).locator('[data-ask-send]')).toBeDisabled(); expect(sent).toHaveLength(1);
  await page.evaluate(async () => {
    const inbox = await caches.open('share-inbox');
    await inbox.put('/share/list', new Response(JSON.stringify({ at: Date.now(), title: '', text: 'Shared after the uncertain send', url: '', files: [{ name: 'shared.txt', type: 'text/plain', size: 12 }] }), { headers: { 'Content-Type': 'application/json' } }));
    await inbox.put('/share/0', new Response('shared bytes'));
  });
  // Reloaded, the request is still unknown, with its words and file, and not sent again by itself; the share goes into
  // the input as the next message's part, apart from the unknown request's own.
  await page.reload(); await openCoordinator(page);
  await expect(unknown).toContainText('Fixed words'); await expect(unknown.locator('[data-message-file], img, a')).not.toHaveCount(0);
  await expect(input(page)).not.toContainText('Fixed words'); await expect(input(page)).toContainText('Shared after the uncertain send');
  await expect(card(page).locator('[data-attachment="shot.png"]')).toHaveCount(0);
  await expect(card(page).locator('[data-attachment="shared.txt"][data-attachment-state=saved]')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => caches.has('share-inbox'))).toBe(false);
  expect(sent).toHaveLength(1);
  // Another submission may be saved locally; FIFO delivery stays behind the unknown one until Check settles it.
  await expect(card(page).locator('[data-ask-send]')).toBeEnabled(); expect(sent).toHaveLength(1);
  await unknown.locator('[data-coordinator-resend]').click();
  await expect(page.locator('[data-coordinator-turn=succeeded]')).toHaveCount(1); await expect(unknown).toHaveCount(0);
  // Admitted, only its own portion leaves the input: its words and its file; the share stays as the next message.
  const admittedLeftOnlyItsOwn = async () => {
    await expect(input(page)).not.toContainText('Fixed words'); await expect(input(page)).toContainText('Shared after the uncertain send');
    await expect(card(page).locator('[data-attachment="shot.png"]')).toHaveCount(0);
    await expect(card(page).locator('[data-attachment="shared.txt"][data-attachment-state=saved]')).toHaveCount(1);
  };
  await admittedLeftOnlyItsOwn();
  await expect(card(page).locator('[data-ask-send]')).toBeEnabled();
  await page.reload(); await openCoordinator(page);
  await admittedLeftOnlyItsOwn();
  expect(sent).toHaveLength(2); expect(sent[1]).toEqual(sent[0]); expect(sent[0].text).toBe('Fixed words'); expect(sent[0].attachments).toEqual(['shot.png']);
});

test('shared bytes survive a failed upload and reload with one text insertion and the same upload operation', async ({ page, runtime }) => {
  await begin(page, runtime);
  const ops: string[] = [];
  await page.route('**/api/coordinator/attachments?*', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    ops.push(route.request().headers()['x-alpacawork-op-id']!);
    if (ops.length === 1) await route.abort('connectionfailed'); else await route.continue();
  });
  await page.evaluate(async () => {
    const inbox = await caches.open('share-inbox');
    await inbox.put('/share/0', new Response('shared bytes'));
    await inbox.put('/share/list', new Response(JSON.stringify({ at: Date.now(), title: '', text: 'Durably shared words', url: '', files: [{ name: 'retry-share.txt', type: 'text/plain', size: 12 }] })));
  });
  await page.reload();
  await expect(input(page)).toContainText('Durably shared words');
  await expect(card(page).locator('[data-attachment="retry-share.txt"][data-attachment-state=failed]')).toHaveCount(1);
  expect(await page.evaluate(() => caches.has('share-inbox'))).toBe(true);
  await page.reload();
  await expect(card(page).locator('[data-attachment="retry-share.txt"][data-attachment-state=saved]')).toHaveCount(1);
  expect((await input(page).innerText()).match(/Durably shared words/g)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => caches.has('share-inbox'))).toBe(false);
  expect(ops.length).toBeGreaterThanOrEqual(2); expect(new Set(ops).size).toBe(1);
});

test('a file removed on its way leaves even when the session can no longer record it, and never goes out with a send', async ({ page, runtime }) => {
  await begin(page, runtime);
  await input(page).press('End'); await page.keyboard.insertText('Words without the file');
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  let arrive!: () => void; const held = new Promise<void>(resolve => { arrive = resolve; });
  const deletions: number[] = []; page.on('response', response => { if (response.request().method() === 'DELETE') deletions.push(response.status()); });
  await page.route('**/api/coordinator/attachments**', async route => {
    if (route.request().method() !== 'DELETE' && route.request().method() !== 'GET') await held;
    await route.continue();
  });
  await upload(page, [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Note') }]);
  const file = card(page).locator('[data-attachment="notes.txt"]');
  await expect(file).toHaveAttribute('data-attachment-state', 'uploading');
  await file.hover(); await file.getByRole('button', { name: 'Remove notes.txt', exact: true }).click();
  // The session's real storage, full to the byte, as the answer arrives.
  await page.evaluate(() => {
    let room = 1 << 20, kept = ''; sessionStorage.setItem('full', '');
    while (room >= 1) { try { sessionStorage.setItem('full', kept + 'x'.repeat(room)); kept += 'x'.repeat(room); } catch { room >>= 1; } }
  });
  arrive();
  await expect(file).toHaveCount(0);
  await expect.poll(() => deletions).toEqual([200]);
  expect(failures).toEqual([]);
  await expect(page.getByText("Couldn't save the draft", { exact: false })).toBeVisible();
  // A record this session could not clear brings the card back on the next load (bugs.md): the file itself is gone, so
  // the send stops and says so, and × takes the card away.
  await page.evaluate(() => sessionStorage.removeItem('full'));
  await page.reload(); await openCoordinator(page);
  await expect(file).toHaveAttribute('data-attachment-state', 'saved');
  const refused = page.waitForResponse(response => response.url().includes('/api/coordinator/messages') && response.request().method() === 'POST');
  await input(page).press('ControlOrMeta+Enter');
  expect((await refused).status()).toBe(404);
  await expect(file).toBeVisible();
  await file.hover(); await file.getByRole('button', { name: 'Remove notes.txt', exact: true }).click();
  await expect(file).toHaveCount(0);
});

test.describe('attachment ownership through cancellation', () => {
  test.use({ fixedTime: false, writeGraceMs: 3000 });
  test('a resent message shows its images while they are copied to it, and after', async ({ page, runtime }) => {
    await begin(page, runtime);
    await input(page).press('End'); await page.keyboard.insertText('Show my picture');
    await upload(page); await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(1);
    await card(page).locator('[data-ask-send]').click();
    await page.locator('[data-coordinator-panel] [data-coordinator-cancel-unsent]').click();
    await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(1);
    // The resend copies the file under its own ID; held, the message is drawn before the copy is there.
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/coordinator/attachments?*', async route => { if (route.request().method() === 'POST') await held; await route.continue(); });
    const sent = coordinatorMessage(page);
    await card(page).locator('[data-ask-send]').click();
    const loaded = (img: ReturnType<Page['locator']>) => expect.poll(() => img.evaluate((each: HTMLImageElement) => each.complete ? each.naturalWidth : -1)).toBeGreaterThan(0);
    await loaded(page.locator('[data-coordinator-panel] [data-coordinator-local] [data-coordinator-files] img'));
    release();
    const completed = await coordinatorCompleted(page, runtime, await sent);
    const served = () => page.locator(`[data-coordinator-panel] [data-coordinator-message="${completed.id}"]:not([data-coordinator-local]) [data-coordinator-files] img`);
    await loaded(served());
    await page.reload(); await openCoordinator(page);
    await loaded(served());
  });
  for (const phone of [false, true]) test(`undo restores every attachment for another send (${phone ? 'phone' : 'pc'})`, async ({ page, runtime }, info) => {
    await page.setViewportSize({ width: phone ? 390 : 1440, height: 900 });
    await begin(page, runtime);
    await input(page).press('End'); await page.keyboard.insertText('Keep my attachments');
    await upload(page, [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Note') }]);
    await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('attached-before-send.png') });
    await card(page).locator('[data-ask-send]').click();
    await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(0);
    // The prepared next input follows navigation while the outgoing original stays hidden.
    await foldConversation(page);
    await page.locator('[data-reader-path]').getByRole('button', { name: /^T11 / }).click();
    await expect(page.locator('aside[data-reader-mode] [data-reader-task-id]')).toHaveText('T11');
    await page.screenshot({ path: info.outputPath('immediate-before-undo.png') });
    await page.locator('[data-coordinator-pill] [data-coordinator-cancel-unsent]').click();
    await openCoordinator(page);
    await expect(input(page)).toContainText('Keep my attachments');
    await page.screenshot({ path: info.outputPath('attached-after-undo.png') });
    await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(2);
    const newUpload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/coordinator/attachments?'));
    await upload(page, [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('New note') }]);
    const newer = await (await newUpload).json();
    await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(3);
    const oldNote = card(page).locator('[data-attachment="notes.txt"]').first();
    await oldNote.hover(); await oldNote.getByRole('button', { name: 'Remove notes.txt', exact: true }).click();
    await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('after-removing-old-note.png') });
    const newerBytes = await page.request.get(runtime.origin + newer.absolutePath);
    expect(newerBytes.status()).toBe(200);
    expect(await newerBytes.text()).toBe('New note');
    // Let a separate message keep the coordinator busy so the next send is admitted but waits.
    const conversation = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    const release = runtime.root + '/attachment-release';
    await page.request.post(runtime.origin + '/api/coordinator/messages', { data: {
      conversationId: conversation.id, id: crypto.randomUUID(), text: 'wait:' + release, attachments: [] } });
    try {
      // A second local undo must keep the old references before copying is needed.
      await card(page).locator('[data-ask-send]').click();
      await page.locator('[data-coordinator-panel] [data-coordinator-cancel-unsent]').click();
      await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(2);
      // Keep two same-name files from different storage owners through both cancellation and resend.
      await upload(page, [{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Other') }]);
      await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(3);
      // A fresh attachment now belongs to the request that will actually reach the server.
      const freshUpload = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/coordinator/attachments?'));
      await upload(page, [{ name: 'removable.txt', mimeType: 'text/plain', buffer: Buffer.from('Remove after withdrawal') }]);
      const fresh = await (await freshUpload).json();
      await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(4);
      // Wait for actual server admission before cancelling the waiting row.
      await card(page).locator('[data-ask-send]').click();
      await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation.turns
        .filter((turn: { ask: string; status: string }) => turn.ask.includes('Keep my attachments') && turn.status === 'queued').length).toBe(1);
      await expect(page.locator('[data-coordinator-panel] [data-coordinator-withdraw]')).toBeVisible();
      await page.locator('[data-coordinator-panel] [data-coordinator-withdraw]').click();
      await expect(input(page)).toContainText('Keep my attachments');
      await page.screenshot({ path: info.outputPath('attached-after-withdraw.png') });
      await expect(card(page).locator('[data-attachment-state=saved]')).toHaveCount(4);
      const removable = card(page).locator('[data-attachment="removable.txt"]');
      await removable.hover(); await removable.getByRole('button', { name: 'Remove removable.txt', exact: true }).click();
      await expect(removable).toHaveCount(0);
      expect((await page.request.get(runtime.origin + fresh.absolutePath)).status()).toBe(404);
      expect((await page.request.get(runtime.origin + newer.absolutePath)).status()).toBe(200);
      writeFileSync(release, '');
      const sent = coordinatorMessage(page);
      await card(page).locator('[data-ask-send]').click();
      const completed = await coordinatorCompleted(page, runtime, await sent);
      const answer = JSON.parse(completed.answer!);
      await expect(page.locator(`[data-coordinator-panel] [data-coordinator-message="${completed.id}"] [data-ask-answer]`)).toContainText('notes.txt');
      expect(answer.attachmentBytes).toEqual({ 'shot.png': PNG.length, 'notes.txt': Buffer.byteLength('New note'), 'notes-2.txt': Buffer.byteLength('Other') });
      await page.screenshot({ path: info.outputPath('attachments-resent.png') });
      expect((await page.request.post(runtime.origin + '/api/coordinator/clear', { data: { conversationId: conversation.id } })).ok()).toBe(true);
      await expect.poll(() => existsSync(join(runtime.root, '.alpacawork/coordinator', conversation.id))).toBe(false);
    } finally { writeFileSync(release, ''); }
  });
});
