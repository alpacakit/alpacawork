import { seedTask } from '../../../e2e/fixture/tasks.ts';
/** Local product check. Run with Node 24 after building the questions backend/contract and this web app. */
import { chromium, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { start } from '../../../e2e/server.ts';
import { startFakeCoordinator } from '../../../e2e/coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview, taskFolder } from '../../../e2e/fixture/task-state.ts';
import { readTaskLog } from '../../../e2e/task-history.ts';
import { commandFetch as fetch } from '../../../tests/helpers/command-fetch.ts';

const evidence = resolve(process.env.ALPACAWORK_UI_EVIDENCE ?? '/tmp/alpacawork-question-ui-evidence');
mkdirSync(evidence, { recursive: true });
const runtime = await start(undefined, startFakeCoordinator);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US', serviceWorkers: 'block' });
const steps: object[] = [];
async function get(path: string) {
 const response = await fetch(`${runtime.origin}/api/${path}`);
 expect(response.status, await response.clone().text()).toBe(200);
 return response.json();
}
async function post(path: string, body: object) {
 const response = await fetch(`${runtime.origin}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
 expect(response.status, await response.clone().text()).toBe(200);
 return response.json();
}
async function task(parent: string, title: string, body?: string) {
 const task = seedTask(runtime.root, parent, title, body);
 await post('commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
 patchTask(runtime.root, task.id, { state: 'doing' });
 return task.id as string;
}
const body = (label: string) => `## 問い\n### 1 ${label}\n[Original evidence](proof.md)\n#### Keep\nKeep the original\n#### Change\nChange it\n`;
const reader = page.locator('aside[data-reader-mode]');
const card = (id: string, question: string) => reader.locator(`[data-report-key="log:${id}:${question}"]`);
async function openCard(id: string, question: string) {
 const target = card(id, question);
 await expect(target).toBeVisible();
 const heading = target.locator('button[aria-expanded]').first();
 if (await heading.getAttribute('aria-expanded') === 'false') await heading.click();
 return target;
}
try {
 const project = (await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Question UI local fixture' })).task.id;
 const direct = await task(project, 'Direct display');
 const parent = await task(direct, 'Middle owner');
 const source = await task(parent, 'Original question owner', body('Where to save the result?'));
 writeFileSync(join(taskFolder(runtime.root, source), 'proof.md'), '# Original evidence\nSource-owned file.');
 const question = seedQuestion(runtime.root, source, { to: 'user', title: 'Deep human question' });
 patchTask(runtime.root, source, { userRequested: false, body: body('Rewritten body must not replace the fixed question') });
 const second = seedQuestion(runtime.root, source, { to: 'user', title: 'Second human question' });
 patchTask(runtime.root, source, { userRequested: false });
 const parentOnly = await task(parent, 'Parent question owner', body('Parent alone decides this'));
 patchTask(runtime.root, parentOnly, { userRequested: false });
 const parentQuestion = seedQuestion(runtime.root, parentOnly, { to: 'parent', title: 'Parent only' });
 await expect.poll(async () => (await get(`task/view?address=${direct}`)).userQuestions?.length).toBe(2);
 await page.goto(`${runtime.origin}/?project=${project}&task=${direct}`);
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 const first = await openCard(source, question);
 await expect(first.getByText('Where to save the result?', { exact: true })).toBeVisible();
 await expect(first.getByRole('link', { name: 'Original evidence' })).toHaveAttribute('href', new RegExp(`task=${source}.*path=proof.md`));
 expect(await card(source, question).count()).toBe(1);
 expect(await card(parentOnly, parentQuestion).count()).toBe(0);
 await page.screenshot({ path: join(evidence, 'ui-question-before.png') });
 steps.push({ step: 'Direct reader opens deep human question with original file link; parent question excluded', direct, parent, source, question, second, parentQuestion });
 // The link follows the original file through the product's file pane, and Back returns to this direct reader.
 await first.getByRole('link', { name: 'Original evidence' }).click();
 await expect(reader).toContainText('Source-owned file.');
 await page.goBack();
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(direct);
 const choices = await openCard(source, question);
 await choices.getByRole('button', { name: 'Keep', exact: true }).click();
 const input = page.locator('[data-one-input]');
 await expect(input).toContainText(source);
 await page.screenshot({ path: join(evidence, 'ui-question-selected.png') });
 await page.locator('[data-ask-send]').click();
 await expect.poll(async () => (await readTaskLog(runtime.origin, source)).filter(entry => entry.kind === 'answered' && entry.questionId === question).length, { timeout: 20000 }).toBe(1);
 expect((await readTaskLog(runtime.origin, direct)).filter(entry => entry.kind === 'answered')).toHaveLength(0);
 await expect.poll(async () => (await get(`task/view?address=${direct}`)).userQuestions.map((q: { id: string }) => q.id)).toEqual([second]);
 await expect(card(source, question).locator('[data-waiting-report-actions]')).toHaveCount(0);
 await page.screenshot({ path: join(evidence, 'ui-question-answered.png') });
 steps.push({ step: 'Selected Keep on direct reader; answered once on original source; direct has no answered record' });
 // Withdrawal closes the original asking record. The open reader reads again when its view's required version rises.
 const state = await get(`commands/task/get?task=${source}`);
 const placement = state.agents.find((entry: { responsible: boolean }) => entry.responsible);
 patchTask(runtime.root, source, { logs: [{ id: randomUUID(), kind: 'question_withdrawn', at: new Date().toISOString(), title: 'Withdraw second', description: null,
   actor: { kind: 'placement', placementId: placement.id }, fromState: null, toState: null, questionId: second }] });
 await expect.poll(async () => (await get(`task/view?address=${direct}`)).userQuestions.length).toBe(0);
 await expect(card(source, second).locator('[data-waiting-report-actions]')).toHaveCount(0);
 steps.push({ step: 'Withdrawn original question removes choices without reloading direct reader' });
 const expiring = await task(parent, 'Expiring question owner', body('Expires on stop'));
 const expires = seedQuestion(runtime.root, expiring, { to: 'user', title: 'Expiring question' });
 await openCard(expiring, expires);
 const expiryTask = (await get(`commands/task/get?task=${expiring}`)).task;
 await post('commands/task/report', { opId: randomUUID(), task: expiring, state: 'stopped', expectedTaskHash: expiryTask.hash, title: 'Stop fixture', description: 'Local expiry check' });
 await expect.poll(async () => (await get(`commands/task/get?task=${expiring}&question=${expires}`)).question.state).toBe('expired');
 await expect(card(expiring, expires).locator('[data-waiting-report-actions]')).toHaveCount(0);
 steps.push({ step: 'Stopping original Task expires its question and removes direct-reader choices' });
 // A child result keeps its existing review target: open that result, approve, and verify only it completes.
 const review = await task(direct, 'Child result to confirm');
 seedReview(runtime.root, review, { title: 'Child result ready', description: 'Please confirm this child result.' });
 await page.goto(`${runtime.origin}/?project=${project}&task=${direct}`);
 const childLink = reader.getByRole('button', { name: new RegExp(`${review} Child result to confirm`) });
 await childLink.first().click();
 await expect(reader.locator('header [data-reader-task-id]')).toHaveText(review);
 await expect(page.locator('[data-task-done]')).toBeEnabled();
 await page.locator('[data-task-done]').click();
 await expect.poll(async () => (await get(`commands/task/get?task=${review}`)).task.state, { timeout: 20000 }).toBe('done');
 expect((await get(`commands/task/get?task=${direct}`)).task.state).not.toBe('done');
 steps.push({ step: 'Existing child-result link and confirmation complete original child, leaving display parent unconfirmed', review });
 await page.setViewportSize({ width: 390, height: 844 });
 const phone = await task(parent, 'Phone question owner', body('Confirm original question on phone'));
 const phoneQuestion = seedQuestion(runtime.root, phone, { to: 'user', title: 'Phone human question' });
 await page.goto(`${runtime.origin}/?project=${project}&task=${direct}`);
 await openCard(phone, phoneQuestion);
 await page.screenshot({ path: join(evidence, 'ui-question-phone.png') });
 steps.push({ step: '390px direct reader uses the same existing question card', phone, phoneQuestion });
 writeFileSync(join(evidence, 'ui-browser-steps.json'), JSON.stringify({ ok: true, root: runtime.root, steps }, null, 2));
 console.log(JSON.stringify({ ok: true, evidence, steps: steps.length }));
} catch (error) {
 await page.screenshot({ path: join(evidence, 'ui-browser-failure.png') }).catch(() => {});
 writeFileSync(join(evidence, 'ui-browser-failure.json'), JSON.stringify({ steps, error: String(error), body: await page.locator('body').innerText().catch(() => '') }, null, 2));
 throw error;
} finally { await page.close(); await browser.close(); await runtime.stop(); }
