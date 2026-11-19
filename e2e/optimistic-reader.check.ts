import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { foldConversation } from './coordinator-fixture.ts';

import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { test as base, expect, openCoordinator, settleMotion, swipe, visibleReaderContentTop } from '../e2e/fixtures.ts';
import { start, type Runtime } from '../e2e/server.ts';
import { startFakeCoordinator, fakeCoordinatorArgv } from '../e2e/coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview } from '../e2e/fixture/task-state.ts';
import { holdCoordinator } from '../e2e/last-answer-evidence.ts';
import { writeFileSync } from 'node:fs';
import { captureOptimisticRuntime, observeOptimisticInput, swipeSubmittedAnswer } from './optimistic-reader-fixture.ts';
import { decideValues } from '../tests/helpers/task-values.ts';
const out = process.env.OPTIMISTIC_READER_EVIDENCE;
const test = base.extend({ page: async ({ page }, use) => {
        await observeOptimisticInput(page);
        await use(page);
    }, runtime: async ({}, use) => {
        const r = await start(undefined, startFakeCoordinator);
        try {
            await use(r);
        }
        finally {
            try { await captureOptimisticRuntime(r, base.info()); }
            finally { await r.stop(); }
        }
    } });
test.setTimeout(60000);
if (process.env.OPTIMISTIC_READER_EVIDENCE) test.use({ video: 'on' });
async function post(r: Runtime, path: string, body: object) { const response = await fetch(r.origin + '/api/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status, await response.clone().text()).toBe(200); return response.json(); }
const project = async (r: Runtime) => (await post(r, 'task/new', { kind: 'project', color: '#39659b', parent: 'none', title: '統合後の確認' })).task.id;
async function task(r: Runtime, p: string, review = false) {
    const { task } = await post(r, 'task/new', { parent: p, title: review ? '最後のレビュー' : '最後の質問', ...(!review ? { values: decideValues(['色を選んでください', ['A 青', '青にする'], ['B 赤', '赤にする']]) } : {}) });
    await post(r, 'agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
    if (review)
        seedReview(r.root, task.id, { description: '確認してください' });
    else {
        patchTask(r.root, task.id, { state: 'doing' });
        seedQuestion(r.root, task.id, { to: 'user' });
    }
    return task.id;
}
const reader = (page: any) => page.locator('aside[data-reader-mode]');
async function begin(page: any, r: Runtime, p: string, q: string) { await page.goto(r.origin + `/?agent=1&project=${p}&task=${q}`); await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(q); }
async function record(page: any) {
    await page.addInitScript(() => {
        (window as any).optimisticRings = 0;
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
            if (this.matches('[data-ring-piece]'))
                (window as any).optimisticRings++;
            return animate.apply(this, args);
        };
    });
}
const conversation = async (page: any, r: Runtime) => (await (await page.request.get(r.origin + '/api/coordinator')).json()).conversation;
const rings = (page: any) => page.evaluate(() => (window as any).optimisticRings);
async function fold(page: any) {
    // Pressed only if it is there: the conversation may already be folded.
    await foldConversation(page);
    if (await page.locator('[data-one-input]').count())
        await page.locator('[data-one-input]').blur();
    await settleMotion(page, reader(page));
}
// A flight's motion: departure.ts has no branch on the width; next-question's first case sees a docked card leave the screen.
for (const [width, reduced] of [[412, false]] as const)
        test.describe(`${width} ${reduced ? 'reduced' : 'normal'}`, () => {
            // The swipe that sends carries its finger's own times, as in the recovery cases below (real clock).
            test.use({ viewport: { width, height: 915 }, hasTouch: true, isMobile: width === 412, locale: 'ja-JP', reducedMotion: reduced ? 'reduce' : 'no-preference', fixedTime: false });
            test('a choice completes its flight while Task reads and POST are held', async ({ page, runtime }) => {
                const p = await project(runtime), q = await task(runtime, p);
                await record(page);
                await page.addInitScript(() => {
                    const cancel = Animation.prototype.cancel;
                    Animation.prototype.cancel = function () {
                        const target = (this.effect as KeyframeEffect)?.target;
                        if (target instanceof Element && target.matches('[data-flying-card]') && this.playState === 'finished') {
                            const b = target.getBoundingClientRect();
                            ((window as any).flightEnds ??= []).push({ left: b.left, right: b.right });
                        }
                        return cancel.call(this);
                    };
                });
                await begin(page, runtime, p, q);
                const warm = page.waitForResponse(r => new URL(r.url()).pathname === '/api/coordinator/warm');
                await page.locator('[data-coordinator-write]').click();
                await warm;
                await expect.poll(async () => (await conversation(page, runtime)).warm, { timeout: 20000 }).toMatch(/^(?:none|ready|failed)$/);
                const releaseAI = holdCoordinator(runtime.root, fakeCoordinatorArgv);
                let releaseCheck = () => { }, releasePost = () => { };
                const checkGate = new Promise<void>(r => releaseCheck = r), postGate = new Promise<void>(r => releasePost = r);
                let check = false, post = false;
                try {
                    await reader(page).locator('[data-question="1"]').getByRole('button', { name: /A 青/ }).click();
                    await fold(page);
                    await page.route('**/api/task/view?*', async (route) => {
                        if (new URL(route.request().url()).searchParams.get('task') === q) {
                            check = true;
                            await checkGate;
                        }
                        await route.continue();
                    });
                    await page.route('**/api/coordinator/messages', async (route) => { post = true; await postGate; await route.continue(); });
                    await page.evaluate(() => {
                        (window as any).flightSamples = [];
                        // The window opens with the copy itself, not before the swipe: delivering the finger's touches can
                        // take longer than the flight, which then starts after a window counted from here has closed.
                        let end = Infinity;
                        const scan = () => {
                            const ghost = document.querySelector('[data-flying-card]');
                            const live = document.querySelector('aside[data-reader-mode]')!;
                            const g = ghost?.getBoundingClientRect();
                            if (g && end === Infinity) end = performance.now() + 1800;
                            (window as any).flightSamples.push({ at: performance.now(), ghost: g ? { left: g.left, right: g.right } : null, live: { right: live.getBoundingClientRect().right, transform: getComputedStyle(live).transform } });
                            if (performance.now() < end)
                                requestAnimationFrame(scan);
                        };
                        scan();
                    });
                    const box = await reader(page).boundingBox(), y = await visibleReaderContentTop(reader(page)) + 130;
                    await swipeSubmittedAnswer(page, { x: box!.x + 80, y }, { x: box!.x + 240, y });
                    await expect.poll(() => post).toBe(true);
                    await page.waitForTimeout(650);
                    const samples = await page.evaluate(() => (window as any).flightSamples);
                    if (out) {
                        const { mkdirSync } = await import('node:fs');
                        mkdirSync(out, { recursive: true });
                        writeFileSync(out + `/${width}-${reduced ? 'reduced' : 'normal'}-post-held.json`, JSON.stringify({ samples, ends: await page.evaluate(() => (window as any).flightEnds), check, post, turns: (await conversation(page, runtime)).turns }, null, 2));
                        await page.screenshot({ path: out + `/${width}-${reduced ? 'reduced' : 'normal'}-post-held.png` });
                    }
                    expect((await conversation(page, runtime)).turns).toHaveLength(0);
                    expect(post).toBe(true);
                    // Submission reaches POST without waiting for Task reads; the copy finishes before POST answers.
                    expect(samples.some((s: any) => s.ghost)).toBe(true);
                    await expect(page.locator('[data-flying-card]')).toHaveCount(0);
                    await expect(reader(page).locator('[data-answered-count]')).toHaveText('送信 1');
                    if (!reduced) {
                        const xs = samples.filter((s: any) => s.ghost).map((s: any) => s.ghost.left);
                        expect(await page.evaluate(() => (window as any).flightEnds?.some((b: any) => b.left > innerWidth))).toBe(true);
                        for (let i = 1; i < xs.length; i++)
                            expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] - 1);
                    }
                    expect(await rings(page)).toBe(reduced ? 0 : 1);
                    await page.waitForTimeout(300);
                    expect((await conversation(page, runtime)).turns).toHaveLength(0);
                    releasePost();
                    await expect.poll(async () => (await conversation(page, runtime)).turns.length).toBe(1);
                    expect((await conversation(page, runtime)).turns[0].result).toBeNull();
                    await expect(reader(page).locator('[data-answered-count]')).toHaveText('送信 1');
                    releaseAI();
                    await expect.poll(async () => (await conversation(page, runtime)).turns[0]?.result?.writes.length, { timeout: 20000 }).toBe(1);
                    expect(await rings(page)).toBe(reduced ? 0 : 1);
                }
                finally {
                    releaseCheck();
                    releasePost();
                    releaseAI();
                }
            });
        });
async function warm(page: any, r: Runtime) { const response = page.waitForResponse((v: any) => new URL(v.url()).pathname === '/api/coordinator/warm'); await openCoordinator(page); await response; await expect.poll(async () => (await conversation(page, r)).warm, { timeout: 20000 }).toMatch(/^(?:none|ready|failed)$/); }
async function words(page: any, text: string) {
    if (!await page.locator('[data-coordinator-panel]').isVisible())
        await openCoordinator(page);
    await page.locator('[data-one-input]').press('End');
    await page.keyboard.insertText(text);
}
async function choose(page: any) { await fold(page); await reader(page).locator('[data-question="1"]').getByRole('button', { name: /A 青/ }).click(); }
async function submit(page: any, way: 'swipe' | 'button' = 'swipe', stroke = swipe) {
    if (way === 'button') {
        await page.locator('[data-ask-send]').click();
        return;
    }
    await fold(page);
    const box = await reader(page).boundingBox(), y = await visibleReaderContentTop(reader(page)) + 100;
    await stroke(page, { x: box!.x + 80, y }, { x: box!.x + 240, y });
}
async function holdRefusedAnswer(page: any, runtime: Runtime, task: string, words: string) {
    let release = () => {}, first = true, submitted: any;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent = coordinatorMessage(page);
    await page.route('**/api/coordinator/messages', async (route: any) => {
        if (!first) return route.continue();
        first = false; submitted = route.request().postDataJSON();
        await gate;
        await route.continue({ postData: JSON.stringify({ ...submitted, conversationId: 'missing-conversation' }) });
    });
    return { release, rejected: async () => {
        const response = await (await sent).response();
        expect(response?.status()).toBe(409);
        expect((await response!.json()).error.reason.kind).toBe('conversation_has_changed');
        expect(submitted.intent).toBeUndefined();
        expect(submitted.answers).toEqual([{ task, question: expect.any(String) }]);
        expect(submitted.text).toContain(words);
        expect((await conversation(page, runtime)).turns).toHaveLength(0);
        return submitted;
    } };
}
async function shot(page: any, r: Runtime, name: string) {
    if (!out)
        return;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: out + '/' + name + '.png' });
    writeFileSync(out + '/' + name + '.json', JSON.stringify({ conversation: await conversation(page, r), deck: await reader(page).locator('[data-empty-deck]').allTextContents(), input: await page.locator('[data-one-input]').allTextContents(), toasts: await page.locator('[data-toast]').allTextContents() }, null, 2));
}
/** Recovered by the current reader or explicitly from a stale question, the answer keeps one body, choice and recipient. */
async function restored(page: any, q: string) {
    if (!await page.locator('[data-coordinator-panel]').isVisible())
        await openCoordinator(page);
    await expect(page.locator('[data-one-input]')).toHaveText('補足も残す');
    await expect(page.locator('[data-label-layer] [data-label="answer"]')).toHaveCount(1);
    await expect(page.locator('[data-label-layer] [data-label="task"]')).toHaveCount(1);
    await expect(page.locator('[data-label-layer] [data-label="task"]')).toContainText(q);
    await expect(page.locator('[data-coordinator-local=refused]')).toHaveCount(0);
    await expect(page.locator('[data-one-input-area] [role="alert"]')).toHaveCount(0);
}
// Recovery does not read the motion setting or width. Refusal follows local departure, before HTTP admission.
for (const width of [412])
        test.describe(`${width} normal recovery`, () => {
            const mode = 'normal';
            test.use({ viewport: { width, height: 915 }, hasTouch: true, isMobile: width === 412, locale: 'ja-JP' });
            // Each refused delivery puts the same draft back, so the next refusal starts where a person sending it again would.
            if (width === 412) test('an immediate refusal of any kind restores the same choice and words once, each time', async ({ page, runtime }) => {
                const p = await project(runtime), q = await task(runtime, p);
                await begin(page, runtime, p, q);
                await warm(page, runtime);
                await choose(page);
                await words(page, '補足も残す');
                const release = holdCoordinator(runtime.root, fakeCoordinatorArgv);
                try {
                    for (const failure of ['conflict', 'question_expired', 'question_does_not_exist'] as const) await test.step(failure, async () => {
                        let releasePost = () => { }, entered = false;
                        const gate = new Promise<void>(r => releasePost = r);
                        await page.unroute('**/api/coordinator/messages');
                        await page.route('**/api/coordinator/messages', async (route) => {
                            entered = true;
                            await gate;
                            const missing = failure === 'question_does_not_exist';
                            await route.fulfill({ status: missing ? 404 : 409, json: { error: {
                                code: missing ? 'not_found' : failure,
                                message: 'fixture refusal', retry: 'reread',
                                ...(missing ? { reason: { kind: 'question_does_not_exist' } } : {})
                            } } });
                        });
                        try {
                            await submit(page);
                            await expect.poll(() => entered).toBe(true);
                            await page.waitForTimeout(650);
                            await expect(reader(page).locator('[data-answered-count]')).toHaveText('送信 1');
                            await shot(page, runtime, `${width}-${mode}-${failure}-departed`);
                        }
                        finally { releasePost(); }
                        const toast = page.locator('[data-toast]');
                        await expect(toast).toHaveCount(1);
                        // A question that moved on says so; any other refusal says the server's words and offers its card.
                        if (failure === 'conflict') await expect(toast.getByRole('button', { name: '開く', exact: true })).toBeVisible();
                        else await expect(toast).toContainText('問いが変わりました');
                        await expect(reader(page).locator('[data-empty-deck]')).toHaveCount(0);
                        if (!await page.locator('[data-coordinator-panel]').isVisible()) await openCoordinator(page);
                        if (failure !== 'conflict') {
                            // A superseded question cannot be taken back merely by observing its old card.
                            await expect(page.locator('[data-one-input]')).toHaveText('');
                            const back = page.locator('[data-coordinator-local=refused] [data-coordinator-take-back]');
                            await expect(back).toBeEnabled();
                            await back.click();
                        }
                        await restored(page, q);
                        await shot(page, runtime, `${width}-${mode}-${failure}-restored`);
                        await toast.locator('[data-toast-pin="close"]').click();
                        await expect(toast).toHaveCount(0);
                    });
                }
                finally { release(); }
            });
        });
test.describe('recovery location and gesture lifecycle', () => {
    // These cases hold a POST behind the swipe that sends it. The swipe carries its finger's own times, so a release
    // that CDP delivers late on a busy machine is still the same quick release (with the real clock: a fixed one
    // replaces those times).
    test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, locale: 'ja-JP', fixedTime: false });
    test('a refused answer keeps its recipient through Open and resend, preserving the next card’s separate draft', async ({ page, runtime }) => {
        const p = await project(runtime), first = await task(runtime, p), second = await task(runtime, p);
        await begin(page, runtime, p, first); await warm(page, runtime); await choose(page);
        await words(page, '最初の追記');
        const refusal = await holdRefusedAnswer(page, runtime, first, '最初の追記');
        try {
            await submit(page, 'swipe', swipeSubmittedAnswer);
            await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(second);
            // This is the ordinary next-card operation: type without first deleting the retained original.
            await words(page, '次の未送信の文章');
            refusal.release(); await refusal.rejected();
            // A newer card's draft cannot be overwritten by the generic take-back action.
            await expect(page.locator('[data-coordinator-local=refused]')).toContainText('最初の追記');
            await expect(page.locator('[data-one-input]')).toContainText('次の未送信の文章');
            await expect(page.locator('[data-one-input]')).not.toContainText('最初の追記');
            await expect(page.locator('[data-coordinator-local=refused] [data-coordinator-take-back]')).toBeDisabled();
            await page.locator('[data-toast]').getByRole('button', { name: '開く', exact: true }).click();
            await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(first);
            await expect(page.locator('[data-one-input]')).toHaveText('最初の追記');
            await expect(page.locator('[data-label-layer] [data-label="task"]')).toHaveCount(1);
            await expect(page.locator('[data-label-layer] [data-label="task"]')).toContainText(first);
            await expect(page.locator('[data-coordinator-local=refused]')).toHaveCount(0);
            await expect(page.locator('[data-toast]').filter({ hasText: '入力欄を空にすると戻せます' })).toHaveCount(0);
            await shot(page, runtime, 'appended-refusal-open-keeps-both');
            const resent = coordinatorMessage(page);
            await page.locator('[data-ask-send]').click();
            const admitted = await resent;
            // The first answer keeps its original recipient; the next card's words stay out of that request.
            const body = admitted.postDataJSON();
            expect(body.text).toContain('1-A 最初の追記');
            expect(body.text).not.toContain('次の未送信の文章');
            expect(body.tasks).toEqual([first]);
            expect(body.answers).toEqual([{ task: first, question: expect.any(String) }]);
            await coordinatorCompleted(page, runtime, admitted);
            await expect(page.locator('[data-one-input]')).not.toContainText('最初の追記');
            // Reopening the next card restores its parked draft through persisted state, without another answer chip.
            await begin(page, runtime, p, second);
            await openCoordinator(page);
            await expect(page.locator('[data-one-input]')).toHaveText('次の未送信の文章');
            await expect(page.locator('[data-label-layer] [data-label="task"]')).toHaveCount(1);
            await expect(page.locator('[data-label-layer] [data-label="task"]')).toContainText(second);
            await expect(page.locator('[data-label-layer] [data-label="answer"]')).toHaveCount(0);
            await shot(page, runtime, 'appended-explicit-resend-accepted');
        } finally { refusal.release(); }
    });
    test('reload while POST waits keeps the fixed answer unknown until an explicit same-ID resend', async ({ page, runtime }) => {
        const p = await project(runtime), q = await task(runtime, p);
        await record(page);
        await begin(page, runtime, p, q);
        await warm(page, runtime);
        await choose(page);
        await words(page, '再読込でも残す');
        const releaseAI = holdCoordinator(runtime.root, fakeCoordinatorArgv), posts: any[] = [];
        let releasePost = () => { };
        const gate = new Promise<void>(resolve => releasePost = resolve);
        await page.route('**/api/coordinator/messages', async route => {
            posts.push(route.request().postDataJSON());
            if (posts.length === 1) {
                await gate;
                // The destroyed page cannot know whether this POST reached serve.
                await route.abort('failed').catch(() => {});
                return;
            }
            await route.continue();
        });
        try {
            await submit(page, 'swipe', swipeSubmittedAnswer);
            await expect.poll(() => posts.length).toBe(1);
            await expect(reader(page).locator('[data-answered-count]')).toHaveText('送信 1');
            await page.reload();
            releasePost();
            await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(q);
            await expect(reader(page).locator('[data-question="1"]').getByRole('button', { name: /A 青/ })).toBeDisabled();
            expect(await rings(page)).toBe(0);
            await openCoordinator(page);
            const unknown = page.locator('[data-coordinator-local=unknown]');
            await expect(unknown).toContainText('再読込でも残す');
            expect(posts).toHaveLength(1);
            expect((await conversation(page, runtime)).turns).toHaveLength(0);
            await shot(page, runtime, 'reloaded-post-unknown');
            await unknown.locator('[data-coordinator-resend]').click();
            await expect.poll(() => posts.length).toBe(2);
            expect(posts[1]).toEqual(posts[0]);
            await expect.poll(async () => (await conversation(page, runtime)).turns.length).toBe(1);
            expect(await rings(page)).toBe(0);
            releaseAI();
            await expect.poll(async () => (await conversation(page, runtime)).turns[0]?.result?.writes.length, { timeout: 20000 }).toBe(1);
            expect((await conversation(page, runtime)).turns[0].id).toBe(posts[0].id);
        }
        finally {
            releasePost();
            releaseAI();
        }
    });
});
