import { labelLayer } from './editor-surface.ts';
import { swipeSubmittedAnswer } from './optimistic-reader-fixture.ts';
import { projectRows } from './fixture/list-rows.ts';
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import { commandPost } from "./command-post.ts";
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errors, type Page } from '@playwright/test';
import { test, expect, open, swipe, settleMotion, openCoordinator, keepShot } from './fixtures.ts';
import { configureCoordinator, startFakeCoordinator, foldConversation } from './coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview } from './fixture/task-state.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import type { Runtime } from './server.ts';
import { visibleReaderContentTop } from './fixtures.ts';
import { decideValues } from '../tests/helpers/task-values.ts';
import type { TaskValues } from '@alpacawork/contract';

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => projectRows(root, ['T111'])); } });
const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const shown = (page: Page) => reader(page).locator('header [data-reader-task-id]');
/** Start a report gesture on visible report content, below the title's vertical sheet grip. */
async function reportSwipeY(page: Page, x = 65, covered: number[][] = []) {
  await settleMotion(page, reader(page));
  const feed = (await reader(page).locator('[data-report-feed]').boundingBox())!;
  let y = Math.max(feed.y, await visibleReaderContentTop(reader(page))) + 20;
  // The report's start point also stays clear of the conversation and its entrance on a computer.
  for (const [top, bottom] of [...covered].sort((a, b) => a[0]! - b[0]!))
    if (y >= top! && y <= bottom!) y = bottom! + 20;
  const area = (await reader(page).locator('[data-reader-content]').boundingBox())!;
  expect(y).toBeLessThan(area.y + area.height);
  const hit = await page.evaluate(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    return { report: !!target?.closest('aside[data-reader-mode] [data-report-feed]'),
      blocked: !!target?.closest('[data-task-sheet-grab], input, textarea, select, [contenteditable], [data-image-slider]'),
      target: target?.outerHTML.slice(0, 300) };
  }, { x, y });
  expect(hit, `report swipe starts at ${x},${y}`).toMatchObject({ report: true, blocked: false });
  return y;
}

const field = (page: Page) => page.locator('[data-one-input]');
const card = (page: Page) => page.locator('[data-coordinator-card]');
test.use({ isolated: true });
test.describe.configure({ timeout: 90_000 });
// Its sends from the input are read leaving their cards: auto-swipe on.
test.use({ autoSwipe: true });
type Task = { id: string; hash: string; state: string };
const QUESTION = decideValues(['Which option', ['Option1 Send current input', 'Send to the coordinator'], ['Option2 Decide later', 'Hold it']]);
const TWO = decideValues(['Which option', ['Option1 Send current input', 'Send to the coordinator'], ['Option2 Decide later', 'Hold it']],
  ['Additional review', ['Option1 Proceed', 'Select it'], ['Option2 Later', 'Put on hold']]);
const poster = (page: Page, runtime: Runtime) => async (path: string, data: object) => {
  const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
};
const current = async (page: Page, runtime: Runtime, id: string): Promise<Task> =>
  (await (await page.request.get(runtime.origin + `/api/task/view?task=${id}`)).json()).task;
/**
 * A Task the user asks for under `parent`, with its responsible placed (its profile one the coordinator's config keeps):
 * at work, it asks the user its body's question (seedQuestion; a question keeps the state, so the Task is at work
 * first).
 */
async function asking(page: Page, runtime: Runtime, { parent, title, values, profile, description = 'Send the selected result to the coordinator.' }: { parent: string; title: string; values: TaskValues; profile: string; description?: string }) {
  const post = poster(page, runtime);
  const { task } = await post('task/new', { parent, title, values }) as { task: Task };
  await post('agent/assign', { task: task.id, role: 'responsible', profile, expectedTaskHash: task.hash });
  patchTask(runtime.root, task.id, { state: 'doing' });
  seedQuestion(runtime.root, task.id, { to: 'user', title: 'Please choose an option', description });
  return current(page, runtime, task.id);
}
/**
 * A question in the sample's project and, after it, a review of another Task's Run. The coordinator only answers (what is sent stays as it was), or (`acting`)
 * carries out what it is sent (fixture/fake-coordinator.mjs). `values`: the task's own decide value instead of the
 * one or two questions; `description`: what the question's report says (long, to read down).
 */
async function prepare(page: Page, runtime: Runtime, { count = 1, acting = false, values, description, choicesInView = false, title = 'Check swipe recovery' }: { count?: number; acting?: boolean; values?: TaskValues; description?: string; choicesInView?: boolean; title?: string } = {}) {
  if (acting) startFakeCoordinator(runtime.root); else configureCoordinator(runtime.root);
  const profile = acting ? 'codex' : 'fake';
  const task = await asking(page, runtime, { parent: SAMPLE_PROJECT.id, title, values: values ?? (count > 1 ? TWO : QUESTION), profile, description });
  const { task: next } = await poster(page, runtime)('task/new', { parent: SAMPLE_PROJECT.id, title: 'Next review card' }) as { task: Task };
  await poster(page, runtime)('agent/assign', { task: next.id, role: 'responsible', profile, expectedTaskHash: next.hash });
  seedReview(runtime.root, next.id, { title: 'Please review', description: 'Swipe left here to hold.' });
  const conversationRead = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/coordinator' && response.request().method() === 'GET');
  await open(page, runtime, `?agent=1&task=${task.id}`);
  await expect(shown(page)).toHaveText(task.id);
  // The header comes from the tree before the separate frozen question and conversation reads. CDP gestures do
  // not wait for actionability: wait for the question a person reads and the folded input's conversation first.
  await expect(reader(page).locator('[data-question="1"] [role="group"]')).toBeVisible();
  const response = await conversationRead;
  expect(response.ok()).toBe(true); await response.finished();
  await expect(page.locator('[data-coordinator-write]')).toHaveAttribute('aria-busy', 'false');
  await expect(reader(page).locator('[data-report-feed]')).toHaveAttribute('data-history-ready', 'true');
  if (choicesInView) {
    // Visibility does not establish an in-view case: the folded conversation can cover Other.
    const group = reader(page).locator('[data-question="1"] [role="group"]');
    await group.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await settleMotion(page, reader(page));
    await expect.poll(() => choicesAreClear(page)).toBe(true);
  }
  return { ...task, next: next.id };
}
/** Every choice is inside the readable area and 12px clear of actual overlays before an in-view gesture. */
async function choicesAreClear(page: Page) {
  return reader(page).locator('[data-question="1"] [role="group"]').evaluate(group => {
    const area = group.closest<HTMLElement>('[data-reader-content]')!, view = area.getBoundingClientRect();
    const top = Math.max(0, view.top + (Number.parseFloat(getComputedStyle(area).getPropertyValue('--reader-header-h')) || 0));
    const bottom = Math.min(innerHeight, view.bottom);
    const over = [...document.querySelectorAll('[data-coordinator-card] > *, [data-coordinator-capsule], [data-composer-frame], [data-coordinator-panel], [data-coordinator-pill], [data-toast]')]
      .map(element => element.getBoundingClientRect()).filter(box => box.width && box.height);
    const choices = [...group.children].map(element => element.getBoundingClientRect());
    return choices.length > 0 && choices.every(box => box.top >= top + 12 && box.bottom <= bottom - 12
      && over.every(other => other.right <= box.left || other.left >= box.right || other.bottom <= box.top - 12 || other.top >= box.bottom + 12));
  });
}
async function launch(page: Page) { await openCoordinator(page); await expect(field(page)).toHaveAttribute('contenteditable', 'true'); }
/**
 * Folds the conversation if it is open: the input stands folded at the screen's foot. A press on the list
 * behind it may have folded it already, and then its ⌄ is on its way out.
 */
async function fold(page: Page) {
  const button = page.locator('[data-coordinator-panel] [data-coordinator-fold]');
  if (!await page.locator('[data-coordinator-folded]').count()) {
    if (!await button.count()) await foldConversation(page);
    else try { await button.click({ timeout: 1_000 }); }
    catch (error) {
      // Press-away may remove the button between the check and the click. The same closed-state assertion below
      // must still pass; a conversation that stays open is a failure, including when the click timed out.
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
  }
  await expect(page.locator('[data-coordinator-folded]')).toBeVisible();
}
async function words(page: Page) { await launch(page); await field(page).press('End'); await page.keyboard.insertText('Proceed with this option'); }
function gate() { let release!: () => void, reached!: () => void; return { wait: new Promise<void>(r => { release = r; }), entered: new Promise<void>(r => { reached = r; }), release: () => release(), reach: () => reached() }; }
// Through the real input and POST: one refused. One that takes its card, one that does not take it (another task named), what
// else takes a card, and that a receipt looks at no screen, are the same call in apps/web/tests/reader-send.test.tsx
// (another task and text without a task label…, a matching task…, held…, late acceptance…).
test('coordinator receipt: failure', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const task = await prepare(page, runtime);
  await words(page);
  await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
  let sends = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/coordinator/messages') sends++; });
  const pending = gate(), replied = gate();
  await page.route('**/api/coordinator/messages', async route => {
    pending.reach(); await pending.wait;
    try { await route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'refused', retry: 'fix' } } }); }
    finally { replied.reach(); }
  });
  await card(page).locator('[data-ask-send]').click(); await pending.entered;
  await field(page).press('ControlOrMeta+Enter'); expect(sends).toBe(1);
  await expect(shown(page)).not.toHaveText(task.id);
  const successor = await shown(page).textContent();
  pending.release(); await replied.entered;
  await expect(page.locator('[data-flying-card]')).toHaveCount(0);
  await expect(page.locator('[data-toast]').getByRole('button', { name: 'Open' })).toBeVisible();
  // Its receipt moves nothing: where the person went stays.
  await expect(shown(page)).toHaveText(successor!);
});

test.describe('phone report gestures', () => {
  // Native pointer timestamps must measure the finger, not the installed fixed clock or CDP delivery.
  test.use({ fixedTime: false, isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });
  test('chosen right swipe sends the current words through the real queue and next card; left swipe holds', async ({ page, runtime }) => {
    // The coordinator answers; the left swipe uses the real direct report owner.
    const task = await prepare(page, runtime, { acting: true });
    const shots = process.env.READER_SEND_SHOTS;
    if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, '01-phone-before.png') }); }
    await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
    // On a phone the choice leaves the input down; the person brings it up to add words.
    await expect(field(page)).toHaveCount(0);
    await page.locator('[data-coordinator-write]').click(); await expect(field(page)).toHaveAttribute('contenteditable', 'true');
    await field(page).press('End'); await page.keyboard.insertText(' Send the added instruction too'); await fold(page);
    await settleMotion(page, reader(page));
    const y = await reportSwipeY(page);
    // Short and paused releases send nothing, even with an answer selected.
    let sent = 0; page.on('request', request => { if (request.url().endsWith('/api/coordinator/messages')) sent++; });
    await swipeSubmittedAnswer(page, { x: 75, y }, { x: 95, y }); expect(sent).toBe(0);
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 65, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 200, y }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 345, y }] });
    await page.waitForTimeout(250);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach(); await settleMotion(page, reader(page)); expect(sent).toBe(0);
    const response = page.waitForResponse(response => response.url().endsWith('/api/coordinator/messages'));
    await swipeSubmittedAnswer(page, { x: 65, y }, { x: 345, y });
    expect((await response).ok()).toBe(true); expect(sent).toBe(1);
    await expect(shown(page)).not.toHaveText(task.id);
    await page.locator('[data-coordinator-write]').click();
    await expect.poll(() => labelLayer(field(page)).locator('[data-label=task]').evaluateAll(elements => elements.map(element => element.querySelector('.tabular-nums')?.textContent)))
      .toEqual([await shown(page).textContent()]);
    await settleMotion(page, reader(page));
    if (shots) await page.screenshot({ path: join(shots, '02-phone-sent.png') });
    await fold(page);
    const conversation = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    expect(conversation.turns.at(-1).ask).toContain(task.id); expect(conversation.turns.at(-1).ask).toContain('1-Option1'); expect(conversation.turns.at(-1).ask).toContain('Send the added instruction too');
    // Finish the right swipe's work before testing a different operation. Admission already moved the card, but
    // the coordinator may still be warming up or carrying that answer out; the next hold must not inherit that wait.
    const answerId = conversation.turns.at(-1).id;
    await expect.poll(async () => ((await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation)
      .turns.find((turn: { id: string }) => turn.id === answerId)?.status, { timeout: 30_000 }).toBe('succeeded');
    const answered = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    expect(answered.turns.find((turn: { id: string }) => turn.id === answerId).result.writes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ task: task.id, kind: 'answered' })]));
    // Policy also exposes legacy inconsistent sample reviews. Read this case's valid review before testing its hold;
    // the automatic next-card assertion above is independent of which sample row the attention order selects.
    await page.locator(`[data-row="${task.next}"] [data-row-title]`).click();
    await expect(shown(page)).toHaveText(task.next);

    await settleMotion(page, reader(page));
    const nextId = await shown(page).textContent();
    const nextY = await reportSwipeY(page, 345);
    await swipeSubmittedAnswer(page, { x: 345, y: nextY }, { x: 65, y: nextY });
    await expect.poll(async () => (await current(page, runtime, nextId!)).state).toBe('held');
    if (shots) await page.screenshot({ path: join(shots, '03-phone-held.png') });
  });
});

/** A fresh project makes the end-of-deck result independent of the prepared sample tasks. The coordinator carries out what it is sent. */
async function isolatedQuestions(page: Page, runtime: Runtime) {
  startFakeCoordinator(runtime.root);
  const { task: project } = await poster(page, runtime)('task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Check answer conflict' }) as { task: Task };
  const values = decideValues(['Storage destination', ['Option1 Local', 'text']]);
  const make = () => asking(page, runtime, { parent: project.id, title: 'Question to answer', values, profile: 'codex' });
  const task = await make(), next = await make();
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${task.id}`);
  await expect(reader(page).locator('[data-question="1"]')).toBeVisible();
  return { task, next };
}

test('free text and a choice both submit their cards, with no invented write refusal', async ({ page, runtime }) => {
  const { task, next } = await isolatedQuestions(page, runtime);
  await words(page);
  await card(page).locator('[data-ask-send]').click();
  await expect(shown(page)).toHaveText(next.id);
  await expect.poll(async () => {
    const conversation = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
    return conversation.turns.some((turn: any) => turn.result?.writes.some((write: any) => write.task === task.id && write.kind === 'answered'));
  }, { timeout: 60_000 }).toBe(true);
  await page.locator(`[data-read="${next.id}"]`).first().click();
  await expect(shown(page)).toHaveText(next.id);
  // The next one by its choice, which opens the input with it.
  await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
  await expect(field(page)).toHaveAttribute('contenteditable', 'true');
  // The screen reads the server's result for each message once the coordinator's Run that answered it has ended.
  const results = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/coordinator'
    && (await response.json()).conversation.turns.filter((turn: { result: unknown }) => turn.result).length === 2, { timeout: 60_000 });
  await card(page).locator('[data-ask-send]').click();
  const { turns } = (await (await results).json()).conversation;
  expect(turns.map((turn: { result: { writes: { task: string; kind: string }[] } }) => turn.result.writes.map(write => [write.task, write.kind])))
    .toEqual([[[task.id, 'answered']], [[next.id, 'answered']]]);
  // Background timeline attention is independent of these submitted Reader cards.
  await settleMotion(page, reader(page));
  await expect(page.locator('[data-toast]').getByRole('button', { name: 'Open' })).toHaveCount(0);
});

// Internal CLI refusals belong to the agent, even after a successful user message.
// The conflict on the open card, on a phone: next-question › an internal CLI refusal keeps free-text completion. Nothing here reads the width.
for (const [width, mode, context] of [[390, 'withdraw', 'raw ID']] as const) test(`ordinary ${context}: internal ${mode} refusal stays with the agent (${width}px)`, async ({ page, runtime }) => {
  await page.setViewportSize({ width, height: 844 });
  const task = await prepare(page, runtime, { acting: true });
  await launch(page);
  await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation.warm, { timeout: 20000 }).toMatch(/^(?:none|ready|failed)$/);
  writeFileSync(join(runtime.root, 'refuse-coordinator-write'), mode);
  if (context === 'raw ID') await field(page).evaluate((element: any, id) => {
    element.editor.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `${id} 中止にして` }] }] });
  }, task.id);
  else { await field(page).press('End'); await page.keyboard.insertText('中止にして'); }
  const sent = coordinatorMessage(page);
  await card(page).locator('[data-ask-send]').click();
  await coordinatorCompleted(page, runtime, await sent);
  const conversation = (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
  const turn = conversation.turns.at(-1);
  expect(turn.status).toBe('succeeded'); expect(turn.answer).toBe('処理を終えました。');
  expect(turn.result.writes).toEqual([]);
  expect(turn.result.refused).toMatchObject([{ task: task.id, code: 'forbidden', retry: 'fix' }]);
  expect(turn.result.refused[0].message).toContain('task.withdraw');
  expect(turn.intent).toBeUndefined(); expect(turn.answers).toBeUndefined();
  // Wait for the browser to consume this exact result; an empty toast list before the read proves nothing.
  await expect(page.locator('[data-ask-answer]').last()).toContainText('処理を終えました。');
  await expect(page.locator('[data-toast][data-kind=error]')).toHaveCount(0);
  await keepShot(page, `internal-${mode}-${context.replace(' ', '-')}-${width}`);
});
