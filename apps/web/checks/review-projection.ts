import { seedTask } from '../../../e2e/fixture/tasks.ts';
/** Local product check: source reviews stay actionable in the project-direct reader. Node 24, local fixture only. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { start } from '../../../e2e/server.ts';
import { startFakeCoordinator } from '../../../e2e/coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview, taskFolder } from '../../../e2e/fixture/task-state.ts';
import { publishFixtureFiles } from '../../../e2e/fixture-writes.ts';
import { readTaskLog } from '../../../e2e/task-history.ts';
import { commandFetch as fetch } from '../../../tests/helpers/command-fetch.ts';

const evidence = resolve(process.env.ALPACAWORK_UI_EVIDENCE ?? '/tmp/alpacawork-review-ui-evidence');
mkdirSync(evidence, { recursive: true });
const runtime = await start(undefined, startFakeCoordinator);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US', serviceWorkers: 'block' });
const steps: object[] = [], requests: object[] = [];
page.on('request', request => { if (request.method() === 'POST' && /\/api\/(task\/report|coordinator\/messages)$/.test(request.url())) requests.push({ url: request.url(), body: request.postDataJSON() }); });
async function get(path: string) { const response = await fetch(`${runtime.origin}/api/${path}`); expect(response.status, await response.clone().text()).toBe(200); return response.json(); }
async function post(path: string, body: object) { const response = await fetch(`${runtime.origin}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status, await response.clone().text()).toBe(200); return response.json(); }
async function task(parent: string, title: string, body?: string) {
 const task = seedTask(runtime.root, parent, title, body);
 await post('commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
 patchTask(runtime.root, task.id, { state: 'doing' }); return task.id as string;
}
const reader = page.locator('aside[data-reader-mode]');
const card = (id: string, record: string) => reader.locator(`[data-report-key="log:${id}:${record}"]`);
async function openCard(id: string, record: string) {
 const target = card(id, record); await expect(target).toBeVisible();
 const heading = target.locator('button[aria-expanded]').first();
 if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
 return target;
}
const sourceState = async (id: string) => get(`commands/task/get?task=${id}`);
const sourceRuns = async (id: string) => (await get(`commands/task/get?task=${id}&runs=999999999`)).runs;
async function reviewId(direct: string, source: string) { await expect.poll(async () => (await get(`task/view?address=${direct}`)).userReviews?.some((review: { taskId: string }) => review.taskId === source)).toBe(true); return (await get(`task/view?address=${direct}`)).userReviews.find((review: { taskId: string }) => review.taskId === source).id as string; }
try {
 const project = (await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Review UI local fixture' })).task.id;
 const direct = await task(project, 'Direct display'); const middle = await task(direct, 'Middle owner');
 const source = await task(middle, 'Original deep review owner');
 const run = seedReview(runtime.root, source, { title: 'Deep result ready', description: '[Original file](proof.md)\nPlease confirm the original result.' });
 writeFileSync(join(taskFolder(runtime.root, source), 'proof.md'), '# Original source evidence\nThis file belongs to the review owner.'); publishFixtureFiles(runtime.root);
 const submitted = await reviewId(direct, source); const before = await sourceState(source); const runsBefore = await sourceRuns(source);
 await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${direct}`);
 const deep = await openCard(source, submitted);
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 await expect(deep.getByRole('link', { name: 'Original file' })).toHaveAttribute('href', new RegExp(`task=${source}.*path=proof.md`));
 await expect(deep.locator('[data-task-done]')).toBeEnabled(); expect(await card(source, submitted).count()).toBe(1);
 const originalFile = await fetch(`${runtime.origin}/api/tasks/${source}/file?path=proof.md`); expect(originalFile.status).toBe(200); expect(await originalFile.text()).toContain('This file belongs to the review owner.');
 await page.screenshot({ path: join(evidence, 'review-direct-pc.png') });
 await deep.locator('[data-task-done]').click();
 await expect.poll(async () => (await sourceState(source)).task.state).toBe('done');
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 expect((await sourceState(direct)).task.state).toBe('doing');
 const after = await sourceState(source); const sourceLogs = await readTaskLog(runtime.origin, source);
 expect(sourceLogs.filter(entry => entry.kind === 'review_approved')).toHaveLength(1);
 expect((await readTaskLog(runtime.origin, direct)).filter(entry => entry.kind === 'review_approved')).toHaveLength(0);
 expect((await sourceRuns(source)).map((each: { id: string }) => each.id)).toEqual(runsBefore.map((each: { id: string }) => each.id));
 const confirm = requests.find((each: any) => each.url.endsWith('/task/report')) as any;
 expect(confirm.body).toMatchObject({ task: source, expectedTaskHash: before.task.hash, aboutRun: run, expectedPlacementRevision: before.agents.find((each: any) => each.responsible).revision });
 steps.push({ step: 'PC: deep review confirmed on source once; direct reader retained; no source Run created', source, submitted, run, before, after, sourceLogs });
 await page.screenshot({ path: join(evidence, 'review-confirmed-pc.png') });
 // Snapshot approval has no aboutRun; it uses the source snapshot's hash.
 const snapshot = await task(middle, 'Original snapshot owner'); const snapRecord = randomUUID();
 patchTask(runtime.root, snapshot, { userRequested: true, state: 'waiting', logs: [{ id: snapRecord, kind: 'reported', at: new Date().toISOString(), title: 'Snapshot result ready', description: 'Review the source snapshot.', actor: { kind: 'human' }, fromState: 'doing', toState: 'waiting' }] });
 await reviewId(direct, snapshot); const snapBefore = await sourceState(snapshot);
 const snapCard = await openCard(snapshot, snapRecord); await snapCard.locator('[data-task-done]').click();
 await expect.poll(async () => (await sourceState(snapshot)).task.state).toBe('done');
 const snapPost = requests.filter((each: any) => each.url.endsWith('/task/report')).at(-1) as any;
 expect(snapPost.body.task).toBe(snapshot); expect(snapPost.body.expectedTaskHash).toBe(snapBefore.task.hash); expect(snapPost.body.aboutRun).toBeUndefined();
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 steps.push({ step: 'Source snapshot confirmation retains source hash and omits aboutRun', snapshot, snapRecord, request: snapPost });
 // The same original Run review is sent back through the existing draft/sender on a 390px phone.
 await page.setViewportSize({ width: 390, height: 844 });
 const returned = await task(middle, 'Phone deep review owner'); const returnedRun = seedReview(runtime.root, returned, { title: 'Phone result ready', description: 'Please inspect and send this result back.' });
 const returnedId = await reviewId(direct, returned); const sendBefore = await sourceState(returned); const sendRuns = await sourceRuns(returned);
 await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${direct}`);
 const phone = await openCard(returned, returnedId);
 await expect.poll(async () => (await get('coordinator')).warm).toMatch(/^(?:none|ready|failed)$/);
 await expect(phone.getByRole('button', { name: 'Write a send-back' })).toBeEnabled();
 await page.screenshot({ path: join(evidence, 'review-direct-phone.png') });
 await phone.getByRole('button', { name: 'Write a send-back' }).click();
 const input = page.locator('[data-one-input]'); await expect(input).toBeVisible(); await input.press('End'); await input.type(' Please revise the original result.');
 await page.locator('[data-ask-send]').click();
 await expect.poll(async () => (await readTaskLog(runtime.origin, returned)).filter(entry => entry.kind === 'review_sent_back').length, { timeout: 25000 }).toBe(1);
 await expect.poll(async () => (await sourceRuns(returned)).length, { timeout: 25000 }).toBe(sendRuns.length + 1);
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 expect((await readTaskLog(runtime.origin, direct)).filter(entry => entry.kind === 'review_sent_back')).toHaveLength(0);
 const sent = requests.filter((each: any) => each.url.endsWith('/coordinator/messages')).at(-1) as any;
 expect(sent.body.intent).toMatchObject({ task: returned, action: 'sendback', aboutRun: returnedRun, expectedTaskHash: sendBefore.task.hash, expectedPlacementRevision: sendBefore.agents.find((each: any) => each.responsible).revision });
 expect(sent.body.answers).toBeUndefined(); expect(sent.body.tasks).toEqual([returned]);
 await expect.poll(async () => (await get('coordinator')).turns.find((turn: any) => turn.id === sent.body.id)?.result?.writes.some((write: any) => write.task === returned && write.kind === 'review_sent_back'), { timeout: 25000 }).toBe(true);
 await expect(page.getByText('Not sent (operation_not_carried_out)', { exact: true })).toHaveCount(0);
 steps.push({ step: '390px: send-back draft targets source versions/Run; one source review_sent_back and one resumed source Run; direct reader retained', returned, returnedId, returnedRun, request: sent, runs: await sourceRuns(returned), logs: await readTaskLog(runtime.origin, returned) });
 await page.screenshot({ path: join(evidence, 'review-sent-back-phone.png') });
 // A snapshot send-back has no reporting Run to invent; the source snapshot and placement are still fixed.
 const snapshotBack = await task(middle, 'Snapshot send-back owner'); const snapshotBackId = randomUUID();
 patchTask(runtime.root, snapshotBack, { userRequested: true, state: 'waiting', logs: [{ id: snapshotBackId, kind: 'reported', at: new Date().toISOString(), title: 'Snapshot to revise', description: 'Revise this source snapshot.', actor: { kind: 'human' }, fromState: 'doing', toState: 'waiting' }] });
 await reviewId(direct, snapshotBack); const snapshotBackBefore = await sourceState(snapshotBack);
 const snapshotBackCard = await openCard(snapshotBack, snapshotBackId); await snapshotBackCard.getByRole('button', { name: 'Write a send-back' }).click();
 await page.locator('[data-one-input]').press('End'); await page.locator('[data-one-input]').type(' Please revise the snapshot.'); await page.locator('[data-ask-send]').click();
 await expect.poll(async () => (await readTaskLog(runtime.origin, snapshotBack)).filter(entry => entry.kind === 'review_sent_back').length, { timeout: 25000 }).toBe(1);
 await expect.poll(async () => (await sourceRuns(snapshotBack)).length).toBe(1);
 const snapshotBackPost = requests.filter((each: any) => each.url.endsWith('/coordinator/messages')).at(-1) as any;
 expect(snapshotBackPost.body.intent).toMatchObject({ task: snapshotBack, action: 'sendback', expectedTaskHash: snapshotBackBefore.task.hash, expectedPlacementRevision: snapshotBackBefore.agents.find((each: any) => each.responsible).revision });
 expect(snapshotBackPost.body.intent.aboutRun).toBeUndefined(); await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 await expect.poll(async () => (await get('coordinator')).turns.find((turn: any) => turn.id === snapshotBackPost.body.id)?.result?.writes.some((write: any) => write.task === snapshotBack && write.kind === 'review_sent_back'), { timeout: 25000 }).toBe(true);
 steps.push({ step: 'Snapshot send-back uses source snapshot hash/revision, no invented aboutRun, one request and new source Run', snapshotBack, snapshotBackId, request: snapshotBackPost });
 // A prepared send-back must not silently switch to a revised source's new turn/hash.
 const stale = await task(middle, 'Revised send-back owner'); seedReview(runtime.root, stale, { title: 'Result before revision' }); const staleId = await reviewId(direct, stale);
 await page.setViewportSize({ width: 1280, height: 900 });
 const staleCard = await openCard(stale, staleId); await staleCard.getByRole('button', { name: 'Write a send-back' }).click();
 const messagesBefore = requests.filter((each: any) => each.url.endsWith('/coordinator/messages')).length;
 patchTask(runtime.root, stale, { state: 'doing', body: 'Revised before the prepared send-back was sent.' });
 await expect(staleCard.locator('[data-review-report-actions]')).toHaveCount(0);
 await page.locator('[data-ask-send]').click();
 await expect(page.getByText('The task has changed. Choose its state again', { exact: true })).toBeVisible();
 expect(requests.filter((each: any) => each.url.endsWith('/coordinator/messages')).length).toBe(messagesBefore);
 steps.push({ step: 'Prepared source send-back becomes invalid after source revision and sends no message', stale, staleId });
 await page.locator('[data-one-input]').press('ControlOrMeta+A'); await page.locator('[data-one-input]').press('Backspace');
 // Hold/revise removes stale operations while retaining the submitted result for reading.
 await page.setViewportSize({ width: 1280, height: 900 });
 const held = await task(middle, 'Held review owner'); seedReview(runtime.root, held, { title: 'Held result' }); const heldId = await reviewId(direct, held);
 const h = await sourceState(held); await post('commands/task/report', { opId: randomUUID(), task: held, state: 'held', expectedTaskHash: h.task.hash });
 await openCard(held, heldId); await expect(card(held, heldId).locator('[data-task-done]')).toBeEnabled(); await expect(card(held, heldId).getByRole('button', { name: 'Write a send-back' })).toBeDisabled();
 const hs = await sourceState(held); await post('commands/task/report', { opId: randomUUID(), task: held, state: 'waiting', expectedTaskHash: hs.task.hash });
 await expect(card(held, heldId).locator('[data-task-done]')).toBeEnabled();
 patchTask(runtime.root, held, { state: 'doing', body: 'Revised result; old review is invalid.' });
 await expect(card(held, heldId).locator('[data-review-report-actions]')).toHaveCount(0);
 steps.push({ step: 'Held source stays confirmable with send-back disabled; restore re-enables send-back; source revision invalidates old actions', held, heldId });
 // Question projection can coexist without interpreting review controls as answers.
 const questionSource = await task(middle, 'Question alongside review', '## 問い\n### 1 Keep this?\n#### Keep\nKeep it');
 const q = seedQuestion(runtime.root, questionSource, { to: 'user', title: 'Separate question' });
 const separateReview = await task(middle, 'Separate review owner'); seedReview(runtime.root, separateReview, { title: 'Separate result' }); const separateId = await reviewId(direct, separateReview);
 await openCard(questionSource, q); await expect(card(questionSource, q).locator('[data-waiting-report-actions]')).toHaveCount(1);
 await openCard(separateReview, separateId); await expect(card(separateReview, separateId).locator('[data-review-report-actions]')).toHaveCount(1);
 steps.push({ step: 'Question and review remain separate original records and controls', questionSource, q, separateReview, separateId });
 await page.screenshot({ path: join(evidence, 'review-question-coexist-pc.png') });
 // Held review approval remains distinct from requests, for both a Run and a human snapshot.
 for (const snapshot of [false, true]) {
  const heldSource = await task(middle, snapshot ? 'Held source snapshot' : 'Held source Run');
  const heldRecord = randomUUID();
  if (snapshot) patchTask(runtime.root, heldSource, { userRequested: true, state: 'waiting', logs: [{ id: heldRecord, kind: 'reported', at: new Date().toISOString(), title: 'Held snapshot result', description: 'Review after holding this snapshot.', actor: { kind: 'human' }, fromState: 'doing', toState: 'waiting' }] });
  else seedReview(runtime.root, heldSource, { title: 'Held Run result', description: 'Review after holding this Run result.' });
  const heldSubmission = await reviewId(direct, heldSource), waiting = await sourceState(heldSource);
  await post('commands/task/report', { opId: randomUUID(), task: heldSource, state: 'held', expectedTaskHash: waiting.task.hash });
  const heldBefore = await sourceState(heldSource), heldRuns = await sourceRuns(heldSource), heldCard = await openCard(heldSource, heldSubmission);
  await expect(heldCard.locator('[data-task-done]')).toBeEnabled();
  await expect(heldCard.getByRole('button', { name: 'Write a send-back' })).toBeDisabled();
  await expect(heldCard.locator('svg[data-icon="report"]')).toBeVisible();
  await page.screenshot({ path: join(evidence, snapshot ? 'review-held-snapshot-pc.png' : 'review-held-run-pc.png'), animations: 'disabled' });
  await heldCard.locator('[data-task-done]').click();
  await expect.poll(async () => (await sourceState(heldSource)).task.state).toBe('done');
  const heldApproval = requests.filter((each: any) => each.url.endsWith('/task/report')).at(-1) as any;
  expect(heldApproval.body).toMatchObject({ task: heldSource, expectedTaskHash: heldBefore.task.hash, expectedPlacementRevision: heldBefore.agents.find((each: any) => each.responsible).revision });
  expect(heldApproval.body.aboutRun).toBe(snapshot ? undefined : heldBefore.reviewRun);
  expect((await readTaskLog(runtime.origin, heldSource)).filter(entry => entry.kind === 'review_approved')).toHaveLength(1);
  expect((await sourceRuns(heldSource)).map((each: any) => each.id)).toEqual(heldRuns.map((each: any) => each.id));
  await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
  steps.push({ step: `Held ${snapshot ? 'human snapshot' : 'Run'} source: report glyph, approve enabled, send-back disabled, source versions/one approval/no Run/direct reader retained`, heldSource, heldSubmission, request: heldApproval });
 }
 // A first source detail failure has no acquired view; earlier reviewed sources intentionally retain theirs.
 const unreadSource = await task(middle, 'Unread review source');
 await page.route(`**/api/task/view?task=${unreadSource}`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'Original detail unavailable', retry: 'reread' } }) }));
 seedReview(runtime.root, unreadSource, { title: 'Unread result' });
 const unreadId = (await readTaskLog(runtime.origin, unreadSource)).find(entry => entry.kind === 'reported' && entry.toState === 'waiting')!.id;
 await expect.poll(async () => (await get(`task/view?address=${direct}`)).userReviews.some((each: any) => each.taskId === unreadSource)).toBe(true);
 await page.goto(`${runtime.origin}/?agent=1&project=${project}&task=${direct}`); await openCard(unreadSource, unreadId);
 await expect(card(unreadSource, unreadId).locator('[data-read-failure]')).toBeVisible(); await expect(card(unreadSource, unreadId).locator('[data-task-done]')).toHaveCount(0);
 steps.push({ step: 'Failed source detail exposes retry and offers no source/parent approval', unreadSource });
 await page.screenshot({ path: join(evidence, 'review-source-unavailable-pc.png') });
 writeFileSync(join(evidence, 'browser-steps.json'), JSON.stringify({ ok: true, root: runtime.root, steps, requests }, null, 2));
 console.log(JSON.stringify({ ok: true, evidence, steps: steps.length }));
} catch (error) {
 await page.screenshot({ path: join(evidence, 'browser-failure.png') }).catch(() => {});
 writeFileSync(join(evidence, 'browser-failure.json'), JSON.stringify({ steps, requests, coordinator: await get('coordinator').catch(() => null), error: String(error), body: await page.locator('body').innerText().catch(() => '') }, null, 2)); throw error;
} finally { await page.close(); await browser.close(); await runtime.stop(); }
