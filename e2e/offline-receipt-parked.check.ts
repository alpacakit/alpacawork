import { labelLayer } from './editor-surface.ts';
/** Formal regression (test only): main's parked reader words (e2e/parked-recovery.check.ts) under the offline cut. The
 * automatic restore takes its current turn from a qualified server Task and is not called while there is none; the person's
 * explicit way back (ParkedReturn) stays. The flow that parks A's words is main's own, unchanged; only the cut (a refused
 * C lost from memory, live GETs held) and the anchor are added. A build without main's explicit recipients cannot run
 * it: a fixture error, not a product result. */
import { test, controlledPwa } from './pwa-fixture.ts';
import type { BrowserContext, Page, Route } from '@playwright/test';
import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { expect, openCoordinator, settleMotion } from './fixtures.ts';
import type { Runtime } from './server.ts';
import { patchTask, seedQuestion } from './fixture/task-state.ts';
import { coordinatorMessageSchema } from '@alpacawork/contract/coordinator';
import { holdRefusedCoordinatorPosts, foldConversation } from './coordinator-fixture.ts';
import { decideValues } from '../tests/helpers/task-values.ts';

test.setTimeout(120_000);
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
async function post(r: Runtime, path: string, body: object) { const res = await fetch(r.origin + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(res.status, await res.clone().text()).toBe(200); return res.json(); }
async function task(r: Runtime, p: string, title: string) {
  const { task } = await post(r, 'commands/task/new', { parent: p, title, values: decideValues(['色を選んでください', ['A 青', '青にする'], ['B 赤', '赤にする']]) });
  await post(r, 'commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
  patchTask(r.root, task.id, { state: 'doing' }); seedQuestion(r.root, task.id, { to: 'user' });
  return task.id as string;
}
const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const shown = (page: Page) => reader(page).locator('header [data-reader-task-id]');
const input = (page: Page) => page.locator('[data-one-input]');
const entrance = (page: Page) => page.locator('[data-coordinator-take-back-parked]:visible');
const toast = (page: Page, title: string) => page.locator('[data-toast]').filter({ hasText: title });
const conversation = async (page: Page, r: Runtime) => (await (await page.request.get(r.origin + '/api/coordinator')).json()).conversation;
async function fold(page: Page) {
  await foldConversation(page);
  if (await input(page).count()) await input(page).blur();
  try { await settleMotion(page, reader(page), true); }
  catch (error) {
    await test.info().attach('parked-residual-motion', { contentType: 'application/json', body: JSON.stringify(await reader(page).evaluate(element =>
      element.getAnimations({ subtree: true }).map(animation => ({ playState: animation.playState,
        iterations: animation.effect?.getTiming().iterations === Infinity ? 'Infinity' : animation.effect?.getTiming().iterations,
        target: (animation.effect as KeyframeEffect | null)?.target?.outerHTML, currentTime: animation.currentTime })))) });
    throw error;
  }
}
async function ensureOpen(page: Page) { if (!await page.locator('[data-coordinator-panel]').isVisible()) await openCoordinator(page); }
async function empty(page: Page) { await ensureOpen(page); await input(page).focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Backspace'); }
/** Wait for finite Reader transitions only: the cut may show a skeleton with an infinite shimmer. */
async function goto(page: Page, id: string) { await fold(page); await page.locator(`[data-read="${id}"]`).click(); await expect(shown(page)).toHaveText(id); await settleMotion(page, reader(page), true); }
const copies = (page: Page, words: string) => page.evaluate((w: string) => Object.values({ ...sessionStorage }).reduce((n, v) => n + (String(v).split(w).length - 1), 0), words);

/** The mounted provider's QueryClient, found once by walking React's fiber tree (no product debug API). */
async function bindClient(page: Page) {
  await page.evaluate(() => {
    const root = document.getElementById('root')!, key = Object.keys(root).find(k => k.startsWith('__reactContainer'))!;
    let client: any; const seen = new Set();
    const walk = (fiber: any) => { if (!fiber || seen.has(fiber) || client) return; seen.add(fiber);
      if (fiber.memoizedProps?.client?.getQueryCache) client = fiber.memoizedProps.client;
      walk(fiber.child); walk(fiber.sibling); walk(fiber.stateNode?.current); };
    walk((root as any)[key]);
    if (!client) throw new Error('The served app has no QueryClient provider');
    (window as any).r4333Client = client;
  });
}
const query = (page: Page, kind: 'task' | 'index', id?: string) => page.evaluate(({ kind, id }) => { const client = (window as any).r4333Client;
  const root = client.getQueryData(['index'])?.root;
  const found = client.getQueryCache().getAll().find((q: any) => q.queryKey[0] === kind && (kind === 'index' || q.queryKey[1] === root) && (id === undefined || q.queryKey[2] === id));
  if (!found) return 'absent';
  return client.fetchQuery({ ...found.options, staleTime: 0 }).then(() => 'success', (error: any) => `error:${error?.code ?? error?.message}`); }, { kind, id });
const evict = (page: Page, id: string) => page.evaluate(id => { const client = (window as any).r4333Client;
  const root = client.getQueryData(['index'])?.root;
  for (const q of client.getQueryCache().getAll()) if (['task', 'task-history'].includes(q.queryKey[0]) && q.queryKey[1] === root && q.queryKey[2] === id) client.removeQueries({ queryKey: q.queryKey, exact: true }); }, id);
/** Complete live GETs are held from the loss until the anchor; held requests are released to the real server. */
async function holdLive(context: BrowserContext) {
  const held: Route[] = []; let holding = false;
  await context.route('**/api/workspace/live', route => { if (!holding) return route.continue(); held.push(route); });
  return { start: () => { holding = true; }, release: async () => { holding = false; for (const route of held.splice(0)) await route.continue(); } };
}

for (const [width, ways] of [[1280, ['anchor']], [390, ['anchor', 'explicit']]] as const) test.describe(`${width}`, () => {
  test.use({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390, isMobile: width === 390, locale: 'ja-JP' });
  for (const way of ways)
  test(`parked A words in the cut: browsing A restores nothing without a server turn; ${way === 'anchor' ? 'the anchor\'s server turn restores them' : 'its explicit entrance still takes them back'} (${width})`, async ({ page, runtime }, info) => {
    if (!('tasks' in coordinatorMessageSchema.shape))
      throw new Error('FIXTURE main-unintegrated: this build has no explicit recipients or parked reader words (main df179477a)');
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
    // C asks nothing, so the deck that main's flow swipes through stays A then B.
    const c = (await post(runtime, 'commands/task/new', { parent: p, title: '拒否される確認' })).task.id as string;
    const live = await holdLive(page.context());
    // C is read first, so its refusal and loss can cut the server facts later.
    await page.goto(runtime.origin + `/?agent=1&project=${p}&task=${c}`); await expect(shown(page)).toHaveText(c);
    await controlledPwa(page);
    await bindClient(page);
    await goto(page, a);
    const warm = page.waitForResponse(v => new URL(v.url()).pathname === '/api/coordinator/warm'); await openCoordinator(page); await warm;
    await expect.poll(async () => (await conversation(page, runtime)).warm, { timeout: 20_000 }).toMatch(/^(?:none|ready|failed)$/);
    // The current formal answer caller parks the unchanged same-turn A document.
    await fold(page); await reader(page).locator('[data-question="1"]').getByRole('button', { name: /A 青/ }).click();
    await ensureOpen(page); await input(page).press('End'); await page.keyboard.insertText('PARKED A ORIGINAL');
    // Answer references promise delivery, not an AI Task write. Hold the delivery
    // until the next draft exists, then let the real server refuse admission.
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
      await info.attach('A-fixed-question', { contentType: 'application/json', body: JSON.stringify({ task: a, question }) });
      await ensureOpen(page); await input(page).press('End'); await page.keyboard.insertText('Keep A in its refusal notice');
      await releaseRefusal(0);
      await expect(toast(page, '請求書の確認')).toHaveCount(1, { timeout: 20_000 });
      await empty(page); await fold(page);
      await reader(page).locator('[data-question="1"]').getByRole('button', { name: /B 赤/ }).click();
      await ensureOpen(page); await page.locator('[data-ask-send]').click();
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
      await toast(page, '経費の分類').getByRole('button', { name: '開く', exact: true }).click();
      await expect(shown(page)).toHaveText(b); await ensureOpen(page);
      await expect(input(page)).not.toContainText('PARKED A ORIGINAL');
      await expect.poll(() => copies(page, 'PARKED A ORIGINAL')).toBe(1);
      expect(held).toHaveLength(2);
      expect((await conversation(page, runtime)).turns).toHaveLength(0);
      admission.pass();
      // A send leaves the next draft prepared (main lifecycle afterSend): only an untouched draft is ever restored
      // automatically, so this is the state in which the cut's rule can be seen at all.
      await empty(page); await page.keyboard.insertText('Bの続きは不要'); await page.locator('[data-ask-send]').click();
      await expect.poll(async () => (await conversation(page, runtime)).turns.at(-1)?.status, { timeout: 30_000 }).toBe('succeeded');
      await info.attach('cut-premise', { contentType: 'application/json', body: JSON.stringify({
        shown: await shown(page).textContent(), input: await input(page).textContent(), copies: await copies(page, 'PARKED A ORIGINAL') }) });
      await expect(input(page), 'the original words must still be parked before testing cut recovery').not.toContainText('PARKED A ORIGINAL');
      const beforeCut = (await conversation(page, runtime)).turns.map((turn: any) => ({ id: turn.id, status: turn.status }));
      const posts: string[] = [];
      page.context().on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
      // The cut: C is refused through its own Query, then lost from memory, with live GETs held.
      await page.context().route(`**/api/task/view?task=${c}`, route => route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Refused by the server', retry: 'fix' } } }));
      const readControl = () => page.evaluate(() => new Promise<any>((resolve, reject) => { const r = indexedDB.open('alpacawork-read-checkpoint', 3); r.onerror=() => reject(r.error); r.onsuccess=() => {
        const db=r.result, tx=db.transaction(['control','slots']), control=tx.objectStore('control').get('current'), slots=tx.objectStore('slots').getAll();
        tx.oncomplete=() => { db.close(); resolve({control:control.result,slots:slots.result}); }; }; }));
      const beforeRefusal = await readControl();
      expect(await query(page, 'task', c)).toMatch(/^error/);
      // This is post-commit removal. Pre-commit forced removal has its own terminal-fault case.
      await expect.poll(async () => (await readControl()).control.epoch !== beforeRefusal.control.epoch).toBe(true);
      expect((await readControl()).slots.some((slot: any) => slot.key[2] === c)).toBe(false);
      live.start();
      await evict(page, c);
      // A, still A's current question, is opened in the cut: shown from what was acquired, with no server turn.
      await goto(page, a); await ensureOpen(page); await settleMotion(page, reader(page), true);
      await expect.soft(input(page), 'no automatic restore without a qualified server turn').not.toContainText('PARKED A ORIGINAL');
      await expect.soft(entrance(page), 'the explicit way back stays').toHaveCount(1);
      expect.soft(await copies(page, 'PARKED A ORIGINAL'), 'the one original is kept').toBe(1);
      if (way === 'explicit') {
        // As in main's own test, the entrance takes the words back into an empty input.
        await empty(page); await entrance(page).click({ timeout: 5_000 }); await ensureOpen(page);
        await expect.soft(input(page), 'the explicit entrance takes the words back in the cut').toContainText('PARKED A ORIGINAL');
        await expect.soft(labelLayer(input(page)).locator('[data-label="answer"]')).toHaveCount(1);
        await expect.soft(entrance(page)).toHaveCount(0);
      } else {
        // The anchor: a complete live GET; A's server turn is the same, so the automatic restore may now run.
        await page.evaluate(() => { const client = (window as any).r4333Client, q = client.getQueryCache().getAll().find((each: any) => each.queryKey[0] === 'index');
          (window as any).r4333Anchor = client.fetchQuery({ ...q.options, staleTime: 0 }).then(() => 'success', (error: any) => `error:${error?.code ?? error?.message}`); });
        await live.release();
        expect(await page.evaluate(() => (window as any).r4333Anchor)).toBe('success');
        await expect.soft(input(page), 'with a qualified server turn the automatic restore runs').toContainText('PARKED A ORIGINAL', { timeout: 10_000 });
      }
      expect.soft(await copies(page, 'PARKED A ORIGINAL'), 'never copied').toBe(1);
      expect(((await input(page).textContent()) ?? '').split('PARKED A ORIGINAL').length - 1, 'one original in the input').toBe(1);
      await expect(labelLayer(input(page)).locator('[data-label="answer"]')).toHaveCount(1);
      expect((await conversation(page, runtime)).turns.map((turn: any) => ({ id: turn.id, status: turn.status })), 'browsing/recovery adds no conversation turn').toEqual(beforeCut);
      expect(posts.filter(path => ['/api/coordinator/messages', '/api/commands/task/report', '/api/commands/task/request'].includes(path)), 'recovery never sends automatically').toEqual([]);
    } finally {
      try { await admission.dispose(); } finally { await live.release(); }
    }
  });
});
