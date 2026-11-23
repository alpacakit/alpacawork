import { commandPost } from "./command-post.ts";
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, openCoordinator, settleMotion, swipe, visibleReaderContentTop } from './fixtures.ts';
import { configureCoordinator, startFakeCoordinator } from './coordinator-fixture.ts';
import { patchTask, seedQuestion, seedReview } from './fixture/task-state.ts';
import type { Runtime } from './server.ts';
import { decideValues } from '../tests/helpers/task-values.ts';

const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const shown = (page: Page) => reader(page).locator('header [data-reader-task-id]');
test.use({ isolated: true, isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });
test.describe.configure({ timeout: 90_000 });
/**
 * `count` cards in a project of their own, in the order the server lists them. Each is a Task the user asked for whose
 * responsible, at work, asks the user `questions` questions (seedQuestion; a question keeps the state, so the Task is at
 * work first), or (`review`) waits for the user's review of its Run (seedReview). The coordinator carries out what it
 * is sent (fixture/fake-coordinator.mjs), or (`acting` false) only answers it, so what a send answers stays open.
 */
async function prepare(page: Page, runtime: Runtime, { count = 2, questions = 1, firstTitle = 'Review card 1', review = false, acting = true } = {}) {
  if (acting) startFakeCoordinator(runtime.root); else configureCoordinator(runtime.root);
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const { task: project } = await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Swipe' });
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const { task } = await post('commands/task/new', { parent: project.id, title: n === count - 1 ? firstTitle : `Review card ${count - n}`,
      ...review ? {} : { values: decideValues(...Array.from({ length: questions }, (_, i): [string, ...[string, string][]] =>
        [`Choose an option ${i + 1}`, ['Option1 Proceed', 'Select it'], ['Option2 Later', 'Put on hold']])) } });
    // The responsible's profile is one the coordinator's config keeps.
    await post('commands/agent/assign', { task: task.id, role: 'responsible', profile: acting ? 'codex' : 'fake', expectedTaskHash: task.hash });
    if (review) seedReview(runtime.root, task.id, { title: 'Please review', description: 'This is a report' });
    else {
      patchTask(runtime.root, task.id, { state: 'doing' });
      seedQuestion(runtime.root, task.id, { to: 'user', title: 'Please review', description: 'This is a report' });
    }
    ids.push(task.id);
  }
  const index = await (await page.request.get(runtime.origin + '/api/workspace/live')).json() as { home: { taskId: string; section: string }[] };
  const order = index.home.filter(row => row.section === 'review' && ids.includes(row.taskId)).map(row => row.taskId);
  expect(order).toHaveLength(count);
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${order[0]}`);
  await expect(shown(page)).toHaveText(order[0]!); await settleMotion(page);
  return order;
}
/** `up`: the input brought up after the choice, as a person adding words would. */
async function choose(page: Page, up = false) {
  await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
  const fold = page.locator('[data-coordinator-panel]').getByRole('button', { name: 'Close the conversation', exact: true });
  if (await fold.count()) await fold.click();
  // On a phone the choice leaves the input down. Folded, its line follows the conversation and settles a saved
  // send at once, so a check of one is made with the input up.
  if (up && !await page.locator('[data-one-input]').count()) await page.locator('[data-coordinator-write]').click();
  if (await page.locator('[data-one-input]').count()) await page.locator('[data-one-input]').blur();
  await settleMotion(page);
}
async function pay(page: Page, side: 'hold' | 'send') {
  // From the text a person sees, below the header laid over the report's top.
  const box = (await reader(page).locator('[data-reader-content]').boundingBox())!;
  const y = await visibleReaderContentTop(reader(page)) + 45;
  await swipe(page, { x: box.x + (side === 'hold' ? 330 : 70), y }, { x: box.x + (side === 'hold' ? 70 : 330), y });
}
const messages = (url: URL) => url.pathname === '/api/coordinator/messages' || url.pathname === '/api/commands/task/report';
const stateOf = async (page: Page, runtime: Runtime, id: string) =>
  (await (await page.request.get(runtime.origin + '/api/task/view?task=' + id)).json()).task.state;
const conversation = async (page: Page, runtime: Runtime) => (await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
/**
 * Holds every read of the coordinator's conversation until `release`: a snapshot holding a message is its receipt, so
 * while none is read the outcome of a send whose answer was lost stays unknown, and an intent stays pending.
 */
async function holdSnapshots(page: Page, onRequest: () => void = () => {}) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(url => url.pathname === '/api/coordinator', async route => { onRequest(); await gate; await route.continue(); });
  return release;
}
test('saved-lost: a hold not received keeps its card and recovers by opening the latest or sending the same message once', async ({ page, runtime }) => {
  const ids = await prepare(page, runtime);
  const payloads: { opId: string; state?: string }[] = [];
  await page.route(messages, async route => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length > 1) return route.continue();
    await route.fetch();
    await route.abort('connectionreset');
  });
  // Serve may have it, but no snapshot says so until the check.
  const release = await holdSnapshots(page);
  await pay(page, 'hold');
  const action = page.locator('[data-toast]').getByRole('button', { name: 'Check' });
  await expect(action).toBeVisible();
  // Admission unknown: the next card remains in place.
  await expect(shown(page)).toHaveText(ids[1]!);
  expect(payloads[0]!.state).toBe('held');
  await action.dblclick();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads[1]).toEqual(payloads[0]);
  release();
  // Received once, it goes once: the coordinator held the Task, and the card left for the next one.
  await expect.poll(() => stateOf(page, runtime, ids[0]!)).toBe('held');
  await expect(shown(page)).toHaveText(ids[1]!);
  expect((await conversation(page, runtime)).turns).toHaveLength(0);
});
// Which questions a send answered is the server's to say: one of two chosen still goes, and its card leaves.
test('a right swipe sends one of two questions chosen; overlapping H presses admit one operation', async ({ page, runtime }) => {
  const ids = await prepare(page, runtime, { count: 3, questions: 2 }); await choose(page);
  let sends = 0; page.on('request', request => { if (request.url().endsWith('/api/coordinator/messages')) sends++; });
  await pay(page, 'send'); await expect(shown(page)).toHaveText(ids[1]!); expect(sends).toBe(1);
  // Folded on a phone after the choice, the conversation's line pulses while it works: the card's motion is what must end.
  await settleMotion(page, reader(page));
  let holds = 0;
  await page.route(messages, async route => { if (route.request().postDataJSON().state === 'held') holds++; await route.continue(); });
  await page.evaluate(() => {
    for (let n = 0; n < 2; n++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  });
  await expect(shown(page)).toHaveText(ids[2]!); expect(holds).toBe(1);
});

test('send response lost (after persistence): same immutable request, one message, no second departure', async ({ page, runtime }) => {
  // The coordinator only answers: what is sent stays as it is, and its first turn waits while `.warm-hold` exists.
  const ids = await prepare(page, runtime, { acting: false });
  const coordinator = join(runtime.root, '.alpacawork', 'coordinator');
  mkdirSync(coordinator, { recursive: true }); writeFileSync(join(coordinator, '.warm-hold'), 'hold');
  // Keep delivery genuinely unknown until the explicit Check; a matching GET now settles admission immediately.
  const unseen = await (await page.request.get(runtime.origin + '/api/coordinator')).json();
  let holdReads = true;
  await page.route('**/api/coordinator', route => holdReads ? route.fulfill({ json: unseen }) : route.continue());
  try {
    await choose(page, true);
    const bodies: object[] = [];
    await page.route(messages, async route => {
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) {
        await route.fetch();
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await pay(page, 'send'); await expect(shown(page)).toHaveText(ids[1]!);
    await pay(page, 'send'); await expect(shown(page)).toHaveText(ids[1]!); expect(bodies).toHaveLength(1);
    // Unknown is said on its own message in the conversation, with its one way to check that same request.
    await openCoordinator(page);
    const unknown = page.locator(`[data-coordinator-local=unknown][data-coordinator-message="${(bodies[0] as { id: string }).id}"]`);
    const check = unknown.locator('[data-coordinator-resend]');
    await expect(check).toBeVisible();
    // Two checks reach the same control in one turn; the explicit Check's GET must reach the server even if its route
    // runs before evaluate returns to Node.
    holdReads = false;
    await check.evaluate((element: HTMLElement) => { element.click(); element.click(); });
    // Checked: settled meanwhile by a snapshot that holds it, nothing goes again; a resend could only repeat the same body.
    await expect(unknown).toHaveCount(0);
    await expect(page.locator(`[data-coordinator-message="${(bodies[0] as { id: string }).id}"]`)).toHaveCount(1);
    expect(bodies.length).toBeLessThanOrEqual(2); for (const body of bodies) expect(body).toEqual(bodies[0]);
    await expect.poll(async () => (await conversation(page, runtime)).turns.length).toBe(1);
    rmSync(join(coordinator, '.warm-hold'));
    await expect.poll(async () => (await conversation(page, runtime)).turns[0].status, { timeout: 30_000 }).toBe('succeeded');
    await expect(shown(page)).toHaveText(ids[1]!); await expect(page.locator('[data-flying-card]')).toHaveCount(0);
  } finally { holdReads = false; rmSync(join(coordinator, '.warm-hold'), { force: true }); }
});
