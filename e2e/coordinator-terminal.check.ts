import { labelLayer } from './editor-surface.ts';
import type { Page } from '@playwright/test';
import { test as base, expect } from './fixtures.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start, type Runtime } from './server.ts';
import { configureCoordinator, foldConversation } from './coordinator-fixture.ts';
import { open, openCoordinator, settleMotion } from './fixtures.ts';
import { patchTask, seedQuestion, seedReview } from './fixture/task-state.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import { decideValues } from '../tests/helpers/task-values.ts';
type StoredEntry = { status: string; values: Record<string, string> };
const test = base.extend<{ runtime: Runtime }>({ runtime: async ({}, use, info) => {
  const runtime = await start(undefined, configureCoordinator);
  const gate = join(runtime.root, 'terminal-delivery-gate');
  try {
    const current = await (await fetch(runtime.origin + '/api/coordinator')).json();
    const response = await fetch(runtime.origin + '/api/coordinator/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: current.conversation.id, id: crypto.randomUUID(),
        text: `wait:${gate}`, attachments: [] }),
    });
    expect(response.status, await response.text()).toBe(200);
    writeFileSync(info.outputPath('runtime.json'), JSON.stringify({ root: runtime.root, origin: runtime.origin }));
    await use(runtime);
  } finally { writeFileSync(gate, 'release'); await runtime.stop(); }
} });
test.use({ fixedTime: false }); // Preserve the real clock these host-time delivery cases used with Playwright base.
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
test.setTimeout(60000);
const shown = (page: Page) => page.locator('aside[data-reader-mode] header [data-reader-task-id]');
const field = (page: Page) => page.locator('[data-one-input]');
const entries = (page: Page): Promise<Record<string, StoredEntry>> => page.evaluate(() => JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries);
const inputKey = (runtime: Runtime, id: string) => JSON.stringify([runtime.root, 'coordinator', id]);
/**
 * In the sample's project, a Task the user asked for whose responsible, at work, asks them a question (seedQuestion; a
 * question keeps the state, so the Task is at work first), and after it a review of another Task's Run (seedReview).
 * Their responsible's profile is the one the coordinator's config keeps.
 */
async function prepare(page: Page, runtime: Runtime, explicit = true) {
  const post = async (path: string, data: object) => {
    const response = await page.request.post(runtime.origin + '/api/' + path, { headers: { 'X-Alpacawork-Op-Id': crypto.randomUUID() }, data });
    expect(response.ok(), await response.text()).toBe(true); return (await response.json()).task as { id: string; hash: string };
  };
  const task = await post('commands/task/new', { parent: SAMPLE_PROJECT.id, title: 'Check target from ordinary text', values: decideValues(['Approach', ['Option1 Proceed', 'Description'], ['Option2 Wait', 'Description']]) });
  await post('commands/agent/assign', { task: task.id, role: 'responsible', profile: 'fake', expectedTaskHash: task.hash });
  patchTask(runtime.root, task.id, { state: 'doing' });
  seedQuestion(runtime.root, task.id, { to: 'user', title: 'Review', description: 'Plain text instruction' });
  const next = await post('commands/task/new', { parent: SAMPLE_PROJECT.id, title: 'Next review' });
  await post('commands/agent/assign', { task: next.id, role: 'responsible', profile: 'fake', expectedTaskHash: next.hash });
  seedReview(runtime.root, next.id, { title: 'Review', description: 'Next' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, `?agent=1&task=${task.id}`); await openCoordinator(page);
  await expect(field(page)).toHaveAttribute('contenteditable', 'true');
  // Native paste/insert text supplies a raw document: no synthetic taskLabel is inserted for its contents.
  await field(page).press('ControlOrMeta+A'); await page.keyboard.insertText(`Fix the flow for ${task.id}`);
  await expect(labelLayer(field(page)).locator('[data-label="task"]')).toHaveCount(0);
  if (explicit) {
    // A saved conversation frame can cover the reader's choice. Fold it as a person would before answering behind it.
    await foldConversation(page);
    // The fixture's message keeps the coordinator at work: its folded dot pulses throughout, so only finite motion waits.
    await settleMotion(page, undefined, true);
    await page.locator('aside[data-reader-mode] [data-question="1"]').getByRole('button', { name: /Option1/ }).click();
    await openCoordinator(page);
  }
  return task;
}
async function send(page: Page, keyboard = false) {
  const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/coordinator/messages');
  if (keyboard) await field(page).press('ControlOrMeta+Enter'); else await page.locator('[data-ask-send]').click();
  const result = await accepted; expect(result.ok()).toBe(true);
  const input = result.request().postDataJSON(); return { input, snapshot: (await result.json()).conversation };
}
const pending = (page: Page) => page.locator('[role="status"]').filter({ hasText: /Checking.*result/ });
/** With the conversation open, what waits is behind its button: opened, its rows show. */
async function queue(page: Page) {
  await foldConversation(page);
  const button = page.locator('[data-coordinator-queue-button]');
  await expect(button).toBeVisible();
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await expect(page.locator('[data-coordinator-queue-over]')).toBeVisible();
}
test('saved ask reply loss followed by another browser cancellation settles the same request ID without sending it again', async ({ page, runtime }) => {
  const task = await prepare(page, runtime);
  let accepted!: () => void; const saved = new Promise<void>(resolve => { accepted = resolve; });
  // No snapshot may establish admission before this test's explicit cross-browser cancellation.
  let releaseReads!: () => void, answerOldReads = true;
  const beforePost = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
  const reads = new Promise<void>(resolve => { releaseReads = resolve; });
  await page.route('**/api/coordinator', async route => {
    if (answerOldReads) { await route.fulfill({ json: beforePost }); return; }
    await reads; await route.continue();
  });
  try {
    const bodies: unknown[] = [];
    await page.route('**/api/coordinator/messages', async route => {
      bodies.push(route.request().postDataJSON()); const result = await route.fetch(); expect(result.ok()).toBe(true);
      await route.abort('failed'); accepted();
    });
    await page.locator('[data-ask-send]').click(); await saved;
    await expect(shown(page)).not.toHaveText(task.id);
    const unknown = page.locator('[data-coordinator-local=unknown] [data-coordinator-resend]');
    await expect(unknown).toBeVisible(); answerOldReads = false;
    // Until admission the original remains protected internally and is shown on its message.
    await expect(field(page)).not.toContainText(`Fix the flow for ${task.id}`);
    const otherContext = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    try {
      const other = await otherContext.newPage(); await open(other, runtime, '?agent=1'); await openCoordinator(other); await queue(other);
      await other.locator('[data-coordinator-queue-over] button.grid[data-coordinator-withdraw]').click();
      releaseReads();
      await expect(unknown).toHaveCount(0); await expect(pending(page)).toHaveCount(0); await expect(page.locator('[data-coordinator-waiting]')).toHaveCount(0);
    } finally { await otherContext.close(); }
    // Withdrawn is settled: serve had it. Nothing is left to resend, and the next message is not held.
    await expect(page.locator('[data-coordinator-local]')).toHaveCount(0);
    const draft = await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries).filter(key => key.includes('send:')));
    // An untouched input takes the cancelled answer back immediately, under a fresh ID.
    expect(draft).toHaveLength(0);
    // Restored words can paint an inline Task label; its visible text is in the editor's label layer.
    await expect.poll(() => field(page).evaluate(node => (node as HTMLElement & { editor: { getText(): string } }).editor.getText())).toContain(`Fix the flow for ${task.id}`);
    await expect(page.locator('[data-toast]').getByRole('button', { name: 'Open', exact: true })).toHaveCount(0);
    const remaining = await page.evaluate(() => Object.keys(JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries).filter(key => key.includes('send:')));
    expect(remaining).toEqual([]);
    await field(page).fill('Next instruction'); await expect(page.locator('[data-ask-send]')).toBeEnabled();
    expect(bodies).toHaveLength(1);
  } finally { releaseReads(); }
});
// Who cleared changes nothing once the reply is lost: that pair adds no way through.
for (const [mode, elsewhere] of [['live', false]] as ['live' | 'lost-reply', boolean][])
  test(`clear scopes fixed sends without overwriting the next draft; ${mode}; other-device=${elsewhere}`, async ({ page, runtime }, info) => {
    const observed: unknown[] = [];
    const capture = async (step: string) => {
      const response = await page.request.get(runtime.origin + '/api/coordinator'); expect(response.ok()).toBe(true);
      const server = (await response.json()).conversation;
      observed.push({ step, runtime, entries: await entries(page), server });
      writeFileSync(info.outputPath('storage-transitions.json'), JSON.stringify(observed, null, 2));
      return server;
    };
    await prepare(page, runtime);
    const { input: initial } = await send(page);
    // Start the storage lifecycle checks without a reader recipient: reader context changes have their own owner.
    await page.goto(runtime.origin + '/?agent=1'); await openCoordinator(page);
    const oldKey = inputKey(runtime, initial.conversationId);
    await field(page).fill('Fixed original words');
    const card = page.locator('[data-coordinator-card]');
    // Upload is an explicit writable operation; hidden-input injection cannot bypass its visible precondition.
    await expect(card.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
    await card.locator('input[type=file]').setInputFiles({ name: 'fixed.txt', mimeType: 'text/plain', buffer: Buffer.from('fixed attachment') });
    await expect(card.locator('[data-attachment-state=saved]')).toHaveCount(1);
    const original = (await entries(page))[oldKey]!;
    // Capture a real GET before the POST. Deliver those old reads late, without letting an event GET
    // settle the fixed send before the deliberately held/lost POST response. APIRequestContext stays live.
    const oldSnapshot = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
    let releaseReads!: () => void, answerOldReads = mode === 'lost-reply';
    const readsHeld = new Promise<void>(resolve => { releaseReads = resolve; });
    await page.route('**/api/coordinator', async route => {
      if (!answerOldReads) await readsHeld;
      await route.fulfill({ json: oldSnapshot });
    });
    let release!: () => void, received!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { received = resolve; });
    let input: any;
    let posts = 0;
    await page.route('**/api/coordinator/messages', async route => {
      posts++; input = route.request().postDataJSON();
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      received();
      if (mode === 'live') { await held; await route.fulfill({ response }); }
      else await route.abort('failed');
    });
    try {
      await page.locator('[data-ask-send]').click(); await saved;
      if (mode === 'lost-reply') {
        // The sender checks one GET before reporting unknown; it receives the captured pre-POST snapshot.
        await expect(page.locator('[data-coordinator-local=unknown]')).toContainText("Couldn't confirm whether it arrived.");
        answerOldReads = false;
      }
      expect(input.id).toBe(original.values.requestId);
      expect(input.text).toBe('Fixed original words'); expect(input.attachments).toEqual(['fixed.txt']);
      const sentKey = JSON.stringify([runtime.root, 'coordinator', `send:${input.id}`]);
      let fixed = (await entries(page))[sentKey]!;
      expect(fixed.values.stage).toBe('posted');
      expect(JSON.parse(fixed.values.submitted!)).toEqual(Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'id')));
      // The newly writable input has its own ID, text and uploaded file while the fixed send stays untouched.
      await field(page).fill('Next unsent words');
      await card.locator('input[type=file]').setInputFiles({ name: 'next.txt', mimeType: 'text/plain', buffer: Buffer.from('next attachment') });
      await expect(card.locator('[data-attachment="next.txt"][data-attachment-state=saved]')).toHaveCount(1);
      const next = (await entries(page))[oldKey]!;
      expect(next.values.requestId).not.toBe(input.id);
      const remapped = (await entries(page))[sentKey]!;
      // Position ownership moves with edits; every other part of the fixed record stays unchanged.
      const { inputPortion: _oldPosition, ...beforeValues } = fixed.values;
      const { inputPortion: _newPosition, ...afterValues } = remapped.values;
      expect({ ...remapped, values: afterValues }).toEqual({ ...fixed, values: beforeValues });
      fixed = remapped;
      const before = await capture('before-clear');
      expect(before.id).toBe(input.conversationId);
      const turn = before.turns.find((turn: any) => turn.id === input.id);
      expect(turn.ask).toBe(input.text); expect(turn.attachments).toEqual(input.attachments); expect(turn.status).toBe('queued');
      const clearPage = async (target: Page) => {
        const done = target.waitForResponse(response => new URL(response.url()).pathname === '/api/coordinator/clear');
        // Clearing is in the usage ring's menu, pressed twice.
        await target.locator('[data-coordinator-context]').click();
        const button = target.locator('[data-coordinator-clear]'); await button.click(); await button.click();
        const response = await done; expect(response.ok()).toBe(true); return (await response.json()).conversation;
      };
      let closed: any;
      if (elsewhere) {
        const context = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
        try {
          const other = await context.newPage(); await open(other, runtime, '?agent=1'); await openCoordinator(other);
          closed = await clearPage(other);
        } finally { await context.close(); }
      } else closed = await clearPage(page);
      expect(closed.id).not.toBe(input.conversationId);
      await page.unroute('**/api/coordinator');
      // A real UI refresh draws the replacement scope, independently of delivery/event timing.
      await foldConversation(page);
      await openCoordinator(page);
      await expect.poll(async () => !!(await entries(page))[inputKey(runtime, closed.id)]).toBe(true);
      expect((await entries(page))[oldKey]).toEqual(next);
      expect((await entries(page))[sentKey]).toEqual(mode === 'live' ? fixed : undefined);
      await expect(field(page)).not.toContainText('Next unsent words');
      await expect(card.locator('[data-attachment-state=saved]')).toHaveCount(0);
      // Write in the replacement scope too: the delayed old response must not replace either input.
      await field(page).fill('Replacement input');
      const fresh = (await entries(page))[inputKey(runtime, closed.id)]!;
      await capture('replacement-drawn'); releaseReads();
      if (mode === 'live') {
        const replied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/coordinator/messages');
        release(); await replied;
        // The old POST response arrives after clear. The next drawn GET after the attempt ends owns removal.
        await expect.poll(async () => {
          await foldConversation(page);
          await openCoordinator(page); return (await entries(page))[sentKey];
        }).toBeUndefined();
      }
      const replay = await page.request.post(runtime.origin + '/api/coordinator/messages', { data: input }); expect(replay.status()).toBe(409);
      const reClear = await page.request.post(runtime.origin + '/api/coordinator/clear', { data: { conversationId: input.conversationId } }); expect(reClear.status()).toBe(409);
      const kept = (await entries(page))[oldKey]!;
      expect(kept.values.requestId).toBe(next.values.requestId);
      expect(JSON.parse(kept.values.doc!).content[0].content[0].text).toBe('Next unsent words');
      expect(JSON.parse(kept.values.attachments!).map((file: any) => file.name)).toEqual(['next.txt']);
      expect((await entries(page))[inputKey(runtime, closed.id)]).toEqual(fresh);
      expect(posts).toBe(1);
      const settled = await capture('settled');
      expect(settled.id).toBe(closed.id); expect(settled.turns.some((turn: any) => turn.id === input.id)).toBe(false);
      await page.reload(); await openCoordinator(page);
      await expect(field(page)).toContainText('Replacement input');
      expect((await entries(page))[oldKey]).toEqual(kept);
      // Opening a retained draft starts a new editing edition; every payload value must stay intact.
      expect((await entries(page))[inputKey(runtime, closed.id)]).toEqual({ ...fresh, revision: expect.any(String) });
      expect((await entries(page))[sentKey]).toBeUndefined();
      await capture('reloaded');
    } finally { release(); releaseReads(); }
  });

test.describe('pre-admission cancellation', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test('a cut POST is cancelled before admission and a delayed same-ID POST cannot create a turn', async ({ page, runtime }) => {
    await open(page, runtime, '?agent=1'); await openCoordinator(page);
    const words = 'Words cancelled before the server receives them';
    await expect(field(page)).toHaveAttribute('contenteditable', 'true');
    await field(page).fill(words);
    const bodies: any[] = [];
    // Abort before route.fetch/continue: unlike reply loss, this request has never reached serve.
    await page.route('**/api/coordinator/messages', async route => {
      bodies.push(route.request().postDataJSON()); await route.abort('failed');
    });
    await page.locator('[data-ask-send]').click();
    await expect(page.locator('[data-coordinator-local=unknown]')).toContainText("Couldn't confirm whether it arrived.");
    expect(bodies).toHaveLength(1);
    const input = bodies[0];
    const before = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    expect(before.turns.some((turn: any) => turn.id === input.id)).toBe(false);
    const status = await page.request.get(`${runtime.origin}/api/coordinator/messages/${input.id}/status`);
    expect((await status.json()).status).toBe('missing');
    const local = page.locator('[data-coordinator-thread] [data-coordinator-local="unknown"]');
    await expect(local.getByRole('button', { name: 'Send again', exact: true })).toBeVisible();
    await expect(local.locator('[data-coordinator-withdraw], [data-coordinator-cancel-unsent]')).toHaveCount(1);
    await local.locator('[data-coordinator-withdraw]').click();
    await expect(field(page)).toHaveText(words);
    await expect(page.locator('[data-toast]')).toHaveCount(1);
    await expect(page.locator('[data-toast]')).toContainText('Cancelled and moved back to the input box.');
    const restored = await entries(page);
    expect(restored[inputKey(runtime, input.conversationId)]!.values.requestId).not.toBe(input.id);
    expect(Object.keys(restored).some(key => key.includes(`send:${input.id}`))).toBe(false);
    // APIRequestContext bypasses the browser route: deliver the exact original POST after the cancellation committed.
    const delayed = await page.request.post(runtime.origin + '/api/coordinator/messages', { data: input });
    expect(delayed.ok()).toBe(true);
    const after = await delayed.json();
    expect(after.message).toEqual({ id: input.id, status: 'withdrawn' });
    expect(after.conversation.turns.some((turn: any) => turn.id === input.id)).toBe(false);
    await page.reload(); await openCoordinator(page);
    await expect(field(page)).toHaveText(words);
    await expect(page.locator('[data-coordinator-waiting]')).toHaveCount(0);
    await expect(page.locator('[data-coordinator-local]')).toHaveCount(0);
    expect(bodies).toHaveLength(1);
  });
});
