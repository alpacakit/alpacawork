import { labelLayer } from './editor-surface.ts';
import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { test as base, expect, openCoordinator, settleMotion } from './fixtures.ts';
import { start, type Runtime } from './server.ts';
import { startFakeCoordinator, holdRefusedCoordinatorPosts, foldConversation } from './coordinator-fixture.ts';
import { patchTask, seedQuestion } from './fixture/task-state.ts';
import { decideValues } from '../tests/helpers/task-values.ts';

// A refused answer put aside for another card keeps one explicit way back after its question moved on.
// Browsing never revives that past turn; the person takes it back with the visible entrance, into an empty input.
const test = base.extend({ runtime: async ({}, use) => { const r = await start(undefined, startFakeCoordinator); try { await use(r); } finally { await r.stop(); } } });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
test.setTimeout(90_000);
async function post(r: Runtime, path: string, body: object) { const res = await fetch(r.origin + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(res.status, await res.clone().text()).toBe(200); return res.json(); }
async function task(r: Runtime, p: string, title: string) {
  const { task } = await post(r, 'commands/task/new', { parent: p, title, values: decideValues(['色を選んでください', ['A 青', '青にする'], ['B 赤', '赤にする']]) });
  await post(r, 'commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
  patchTask(r.root, task.id, { state: 'doing' }); seedQuestion(r.root, task.id, { to: 'user' });
  return task.id as string;
}
const reader = (page: any) => page.locator('aside[data-reader-mode]');
const shown = (page: any) => reader(page).locator('header [data-reader-task-id]');
const input = (page: any) => page.locator('[data-one-input]');
const entrance = (page: any) => page.locator('[data-coordinator-take-back-parked]:visible');
const toast = (page: any, title: string) => page.locator('[data-toast]').filter({ hasText: title });
const conversation = async (page: any, r: Runtime) => (await (await page.request.get(r.origin + '/api/coordinator')).json()).conversation;
async function fold(page: any) { await foldConversation(page); if (await input(page).count()) await input(page).blur(); await settleMotion(page, reader(page)); }
async function ensureOpen(page: any) { if (!await page.locator('[data-coordinator-panel]').isVisible()) await openCoordinator(page); }
async function empty(page: any) { await ensureOpen(page); await input(page).focus(); await expect(input(page)).toBeFocused(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); }
async function goto(page: any, id: string) { await fold(page); await page.locator(`[data-read="${id}"]`).click(); await expect(shown(page)).toHaveText(id); await settleMotion(page, reader(page)); }
/** How many stored drafts hold the words: the one saved original, never a copy. */
const copies = (page: any, words: string) => page.evaluate((w: string) => Object.values({ ...sessionStorage }).reduce((n, v) => n + (String(v).split(w).length - 1), 0), words);

for (const width of [1440]) test.describe(`${width}`, () => {
  test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, isMobile: width === 390, locale: 'ja-JP' });
  test('a refused answer put aside after its turn moved on comes back only through its entrance, once', async ({ page, runtime }) => {
    const p = (await post(runtime, 'commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: '退避した回答' })).task.id;
    const a = await task(runtime, p, '請求書の確認'), b = await task(runtime, p, '経費の分類');
    const questions = new Map<string, string>();
    for (const id of [a, b]) {
      const response = await page.request.get(runtime.origin + '/api/task/view?task=' + id);
      expect(response.ok()).toBe(true);
      const question = (await response.json()).questions.find((item: any) => item.state === 'open');
      expect(question?.id).toEqual(expect.any(String));
      questions.set(id, question.id);
    }
    await page.goto(runtime.origin + `/?agent=1&project=${p}&task=${a}`); await expect(shown(page)).toHaveText(a);
    await openCoordinator(page);
    await expect.poll(async () => (await conversation(page, runtime)).busy, { timeout: 20_000 }).toBe(false);
    // A's answer and words are refused and taken back by its notice's Open.
    await fold(page); await reader(page).locator('[data-question="1"]').getByRole('button', { name: /A 青/ }).click();
    await ensureOpen(page); await input(page).press('End'); await page.keyboard.insertText('PARKED A ORIGINAL');
    // A reference promises delivery, not an AI Task write. Hold each delivery
    // until the next draft is ready, then let serve refuse it before admission.
    const admission = await holdRefusedCoordinatorPosts(page, runtime);
    const { held, refuse: releaseRefusal } = admission;
    try {
      await ensureOpen(page); await page.locator('[data-ask-send]').click();
      await expect(shown(page)).toHaveText(b);
      await expect.poll(() => held.length).toBe(1);
      expect(held[0]!.input.answers).toEqual([{ task: a, question: questions.get(a)! }]);
      expect(held[0]!.input.text).toContain('PARKED A ORIGINAL');
      const question = held[0]?.input.answers?.[0]?.question;
      if (!question) throw new Error(`Expected an answer question for ${a} in the first unaccepted coordinator POST`);
      expect((await conversation(page, runtime)).turns).toHaveLength(0);
      // Keep writing after each send so a refusal waits in its notice rather than restoring
      // automatically into the fresh input. Each notice then owns one real saved answer.
      await ensureOpen(page); await input(page).press('End'); await page.keyboard.insertText('Keep A in its refusal notice');
      await releaseRefusal(0);
      await expect(toast(page, '請求書の確認')).toHaveCount(1, { timeout: 20_000 });
      await empty(page); await fold(page);
      await reader(page).locator('[data-question="1"]').getByRole('button', { name: /B 赤/ }).click();
      await ensureOpen(page); await page.locator('[data-ask-send]').click();
      // B's send advances to A, while B remains in the input until admission is resolved.
      await expect(shown(page)).toHaveText(a); await ensureOpen(page);
      await expect(input(page)).not.toContainText('PARKED A ORIGINAL');
      await expect.poll(() => held.length).toBe(2);
      expect(held[1]!.input.answers).toEqual([{ task: b, question: questions.get(b)! }]);
      await releaseRefusal(1);
      await expect(toast(page, '経費の分類')).toHaveCount(1, { timeout: 20_000 });
      // Retention keeps B in the input until its refusal. Explicit Open A parks B before opening B parks A.
      await toast(page, '請求書の確認').getByRole('button', { name: '開く', exact: true }).click();
      await expect(shown(page)).toHaveText(a); await ensureOpen(page);
      await expect(input(page)).toContainText('PARKED A ORIGINAL');
      // B's own notice opens its Task and puts A's restored words aside.
      await toast(page, '経費の分類').getByRole('button', { name: '開く', exact: true }).click();
      await expect(shown(page)).toHaveText(b); await ensureOpen(page);
      await expect(input(page)).not.toContainText('PARKED A ORIGINAL');
      await expect.poll(() => copies(page, 'PARKED A ORIGINAL')).toBe(1);
      expect(held).toHaveLength(2);
      expect((await conversation(page, runtime)).turns).toHaveLength(0);
      admission.pass();
      // A's question is answered elsewhere: the saved answer belongs to a past turn.
      await post(runtime, 'commands/task/request', { task: a, answers: question, instruction: 'Answered elsewhere after park', opId: crypto.randomUUID() });
      await empty(page); await page.keyboard.insertText('Bの続きは不要'); await page.locator('[data-ask-send]').click();
      await expect.poll(async () => (await conversation(page, runtime)).turns.at(-1)?.status, { timeout: 30_000 }).toBe('succeeded');
      await goto(page, a); await ensureOpen(page); await page.waitForTimeout(400);
      // Browsing does not revive it; its entrance names the Task it belongs to.
      await expect(input(page)).not.toContainText('PARKED A ORIGINAL');
      await expect(entrance(page)).toHaveCount(1);
      await expect(entrance(page)).toContainText(a);
      await page.screenshot({ path: test.info().outputPath('entrance.png') });
      // Into words being written it does not go: those stay, and the reason is said.
      await empty(page); await page.keyboard.insertText('今の一般文');
      await entrance(page).click();
      await expect(page.locator('[data-toast]').filter({ hasText: '入力欄を空にすると戻せます' })).toHaveCount(1);
      await expect(input(page)).toContainText('今の一般文'); await expect(input(page)).not.toContainText('PARKED A ORIGINAL');
      expect(await copies(page, 'PARKED A ORIGINAL')).toBe(1);
      await page.screenshot({ path: test.info().outputPath('kept-writing.png') });
      // Into an empty input it comes back once, with its answer, and the entrance is gone; folded, the same entrance
      // stands in the conversation's folded row.
      await empty(page); await fold(page);
      await expect(page.locator('[data-coordinator-panel]')).toHaveCount(0); await settleMotion(page, page.locator('[data-coordinator-fold-row]'));
      await expect(page.locator('[data-coordinator-fold-row] [data-coordinator-take-back-parked]')).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('entrance-folded.png') });
      await entrance(page).click(); await ensureOpen(page);
      await expect(input(page)).toContainText('PARKED A ORIGINAL');
      expect(((await input(page).textContent()) ?? '').split('PARKED A ORIGINAL').length - 1).toBe(1);
      await expect(labelLayer(input(page)).locator('[data-label="answer"]')).toHaveCount(1);
      await expect(entrance(page)).toHaveCount(0);
      await expect.poll(() => copies(page, 'PARKED A ORIGINAL')).toBe(1);
      await page.screenshot({ path: test.info().outputPath('taken-back.png') });
    } finally {
      await admission.dispose();
    }
  });
});
