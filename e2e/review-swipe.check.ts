import type { Locator, Page } from '@playwright/test';
import { coordinatorSnapshotSchema, type CoordinatorConversation } from '@alpacawork/contract/coordinator';
import { test, expect, openCoordinator, settleMotion, visibleReaderContentTop } from './fixtures.ts';
import { swipeSubmittedAnswer } from './optimistic-reader-fixture.ts';
import { commandPost } from './command-post.ts';
import { startFakeCoordinator } from './coordinator-fixture.ts';
import { placeResponsible } from './fixture/responsible.ts';
import { patchTask, seedQuestion, seedReview } from './fixture/task-state.ts';
import { readTaskLog } from './task-history.ts';
import type { Runtime } from './server.ts';
import { decideValues } from '../tests/helpers/task-values.ts';

const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const shown = (page: Page) => reader(page).locator('header [data-reader-task-id]');
// A swipe answers only while the finger still moves outward when let go (releaseSpeed). Its moves carry the finger's own
// time, which Playwright's fixed clock would replace with the time a busy page got round to them.
test.use({ isolated: true, isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 }, fixedTime: false });
test.describe.configure({ timeout: 90_000 });
/** How long the coordinator may take to carry a press out: its Run starts, and runs the alpacawork CLI. */
const CARRIED_OUT = { timeout: 30_000 };
const QUESTION = decideValues(['Choose an option', ['Accept', 'Proceed'], ['Hold', 'Review later']]);

const post = async (page: Page, runtime: Runtime, path: string, data: object) => {
  const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
};
const view = async (page: Page, runtime: Runtime, id: string): Promise<{ state: string; hash: string }> =>
  (await (await page.request.get(runtime.origin + '/api/task/view?task=' + id)).json()).task;
const state = async (page: Page, runtime: Runtime, id: string) => (await view(page, runtime, id)).state;
const conversation = async (page: Page, runtime: Runtime): Promise<CoordinatorConversation> =>
  coordinatorSnapshotSchema.parse(await (await page.request.get(runtime.origin + '/api/coordinator')).json()).conversation;
/** The versions the screen shows of a card, which a press on it carries: the Task's, and its responsible's. */
async function versions(page: Page, runtime: Runtime, id: string) {
  const live = await (await page.request.get(runtime.origin + '/api/workspace/live')).json() as
    { tasks: { id: string; hash: string }[]; placements: { taskId: string; responsible: boolean; revision: number }[] };
  return { expectedTaskHash: live.tasks.find(task => task.id === id)!.hash,
    expectedPlacementRevision: live.placements.find(placement => placement.taskId === id && placement.responsible)!.revision };
}

/**
 * The first card: a review (its responsible's Run reported done on the user's request), a question asked of the user
 * while the Task works, such a review the user held, or a Task that is not the user's turn.
 */
type First = 'review' | 'question' | 'held' | 'todo';
/**
 * A project of two cards, each a top Task with its responsible placed, and the coordinator that carries out the
 * screen's presses (fixture/fake-coordinator.mjs); the reader opens on the first, and the second is a review. Returns the
 * cards and the Run each review confirms.
 */
async function prepare(page: Page, runtime: Runtime, first: First = 'review') {
  startFakeCoordinator(runtime.root);
  const { task: project } = await post(page, runtime, 'task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Swipe check' });
  const ids: string[] = [], runs: Record<string, string> = {};
  for (const card of [first, 'review'] as const) {
    const { task } = await post(page, runtime, 'task/new', { parent: project.id, title: ids.length ? 'Next review card' : 'First card',
      values: card === 'question' ? QUESTION : { notes: 'Validation is complete. Please review the results.' } });
    await placeResponsible(page.request, runtime.origin, task);
    if (card === 'question') {
      patchTask(runtime.root, task.id, { state: 'doing' });
      seedQuestion(runtime.root, task.id, { to: 'user' });
    } else if (card !== 'todo') runs[task.id] = seedReview(runtime.root, task.id, { title: 'Validation is complete', description: 'Please review the results.' });
    if (card === 'held') await post(page, runtime, 'task/report', { task: task.id, state: 'held', opId: crypto.randomUUID(),
      expectedTaskHash: (await view(page, runtime, task.id)).hash });
    ids.push(task.id);
  }
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${ids[0]}`);
  await expect(shown(page)).toHaveText(ids[0]!); await settleMotion(page);
  return { ids, runs };
}
/** A swipe across the reports, or (a locator) across what it names, at its middle's height. */
async function pay(page: Page, side: 'left' | 'right', on?: Locator) {
  const box = (await reader(page).locator('[data-reader-content]').boundingBox())!;
  const at = on && (await on.boundingBox())!;
  const y = at ? at.y + at.height / 2 : await visibleReaderContentTop(reader(page)) + 45;
  await swipeSubmittedAnswer(page, { x: box.x + (side === 'left' ? 330 : 70), y }, { x: box.x + (side === 'left' ? 70 : 330), y });
}

test(`right: a review's swipe writes a direct report, and the card and state change once it has written`, async ({ page, runtime }) => {
  const { ids, runs } = await prepare(page, runtime);
  await expect(page.locator('[data-swipe-mark="done"]')).toHaveText('Done');
  const pressed = await versions(page, runtime, ids[0]!);
  // The screen writes no state of its own: the coordinator does.
  const reports: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/task/report') reports.push(request.url()); });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const sent: Record<string, any>[] = [];
  await page.route(url => url.pathname === '/api/task/report', async route => { sent.push(route.request().postDataJSON()); await gate; await route.continue(); });
  try {
    await pay(page, 'right');
    await expect.poll(() => sent.length).toBe(1);
    // The press means Approve of the review shown, with the versions shown, in the one line the screen says.
    expect(sent[0]).toMatchObject({ task: ids[0], state: 'done', ...pressed });
    expect(sent[0]!.aboutRun).toBe(runs[ids[0]!]);
    // Local submission advances before serve holds it; only the coordinator changes Task state.
    await expect(shown(page)).toHaveText(ids[1]!);
    expect(await state(page, runtime, ids[0]!)).toBe('waiting');
  } finally { release(); }
  // Its receipt moves the reader on; the coordinator's write, quoting the line, changes the state.
  await expect(shown(page)).toHaveText(ids[1]!);
  await expect.poll(() => state(page, runtime, ids[0]!), CARRIED_OUT).toBe('done');
  const written = (await readTaskLog(runtime.origin, ids[0]!)).find(entry => entry.toState === 'done');
  expect(written?.actor).toMatchObject({ kind: 'human' });
  expect(reports).toHaveLength(1);
});

test("the reader's head and title are swiped as its reports are: right answers, left holds", async ({ page, runtime }) => {
  const { ids } = await prepare(page, runtime);
  const sent: Record<string, any>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/task/report') sent.push(request.postDataJSON()); });
  // The head's row stands over the reports, outside them; the title is a sheet grip inside them.
  await pay(page, 'right', reader(page).locator('[data-reader-path]'));
  await expect(shown(page)).toHaveText(ids[1]!);
  await settleMotion(page);
  await pay(page, 'left', reader(page).locator('[data-reader-title]'));
  await expect.poll(() => sent.map(each => [each.task, each.state])).toEqual([[ids[0], 'done'], [ids[1], 'held']]);
});

test('moving on to the next card keeps the reading area as it is: its touch-action and header room are not written again', async ({ page, runtime }) => {
  const { ids } = await prepare(page, runtime);
  const content = reader(page).locator('[data-reader-content]');
  await expect(content).toHaveCSS('touch-action', 'pan-y pinch-zoom');
  // Each write of these restyles all the reading area holds, in the frame the card is let go.
  await page.evaluate(() => {
    const written: { touch: [string, string]; room: [string, string] }[] = (window as any).__written = [];
    const read = (style: string | null, name: string) => new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]*)`).exec(style ?? '')?.[1]?.trim() ?? '';
    new MutationObserver(list => { for (const each of list) {
      const now = (each.target as Element).getAttribute('style');
      written.push({ touch: [read(each.oldValue, 'touch-action'), read(now, 'touch-action')], room: [read(each.oldValue, '--reader-header-h'), read(now, '--reader-header-h')] });
    } }).observe(document.querySelector('aside[data-reader-mode] .reader-reading')!, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style'] });
  });
  await pay(page, 'right');
  await expect(shown(page)).toHaveText(ids[1]!);
  await settleMotion(page);
  const written: { touch: [string, string]; room: [string, string] }[] = await page.evaluate(() => (window as any).__written);
  expect(written.filter(each => each.touch[0] !== each.touch[1])).toEqual([]);
  expect(written.filter(each => each.room[0] !== each.room[1])).toEqual([]);
  // The next card is swiped as the first was.
  await expect(content).toHaveCSS('touch-action', 'pan-y pinch-zoom');
  await expect(page.locator('[data-swipe-mark="done"]')).toHaveText('Done');
});

for (const mode of ['refused', 'saved-lost'] as const) test(`${mode}: a direct report's recovery never invents a second operation`, async ({ page, runtime }) => {
  const { ids } = await prepare(page, runtime);
  await expect(page.locator('[data-swipe-mark="done"]')).toHaveCount(1);
  const sent: Record<string, any>[] = [];
  await page.route(url => url.pathname === '/api/task/report', async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length > 1) return route.continue();
    if (mode === 'refused') return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Conflict', retry: 'reread' } } });
    if (mode === 'saved-lost') await route.fetch();
    await route.abort('connectionreset');
  });
  await pay(page, 'right');
  const check = page.locator('[data-toast]').getByRole('button', { name: 'Check', exact: true });
  if (mode === 'refused') {
    // A refusal offers the failed card without stealing the next card.
    const latest = page.locator('[data-toast]').getByRole('button', { name: 'Open', exact: true });
    await expect(latest).toBeVisible();
    await expect(shown(page)).toHaveText(ids[1]!);
    await latest.click(); await expect(shown(page)).toHaveText(ids[0]!);
    expect(sent).toHaveLength(1); expect(await state(page, runtime, ids[0]!)).toBe('waiting');
    return;
  }
  {
    // Unknown delivery keeps the optimistic advance; Check uses the same fixed request.
    await expect(check).toBeVisible();
    await expect(shown(page)).toHaveText(ids[1]!);
    await check.dblclick();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toEqual(sent[0]);
  }
  // Serve has it now, or had it and its conversation says so: the card leaves, and the coordinator carries it out once.
  await expect(shown(page)).toHaveText(ids[1]!);
  await expect.poll(() => state(page, runtime, ids[0]!), CARRIED_OUT).toBe('done');
  await expect(check).toHaveCount(0);
  expect(sent).toHaveLength(2);
  expect((await readTaskLog(runtime.origin, ids[0]!)).filter(entry => entry.toState === 'done')).toHaveLength(1);
  expect((await conversation(page, runtime)).turns).toHaveLength(0);
});

test('a ✔ with the version shown is refused once the task has changed, and its card comes back', async ({ page, runtime }) => {
  const { ids } = await prepare(page, runtime);
  await expect(page.locator('[data-swipe-mark="done"]')).toHaveCount(1);
  const pressed = await versions(page, runtime, ids[0]!);
  const sent: Record<string, any>[] = [];
  await page.route(url => url.pathname === '/api/task/report', async route => {
    sent.push(route.request().postDataJSON());
    // The Task changes after the press, before the coordinator writes.
    await post(page, runtime, 'task/update', { task: ids[0], expectedTaskHash: pressed.expectedTaskHash, title: 'New review' });
    await route.continue();
  });
  await pay(page, 'right');
  // Received, the card leaves at once.
  await expect(shown(page)).toHaveText(ids[1]!);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ state: 'done', ...pressed });
  // The coordinator passes the version shown as it is, never a newer one: its write is refused and the Task stays.
  const latest = page.locator('[data-toast]').getByRole('button', { name: 'Open', exact: true });
  await expect(latest).toBeVisible(CARRIED_OUT);
  expect(await state(page, runtime, ids[0]!)).toBe('waiting');
  await expect(page.locator('[data-toast]')).toContainText('The task changed. Reload before reviewing');
  await latest.click();
  await expect(shown(page)).toHaveText(ids[0]!);
});
