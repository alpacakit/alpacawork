import { labelLayer } from './editor-surface.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Page, Request } from '@playwright/test';
import { commandFetch as fetch } from '../tests/helpers/command-fetch.ts';
import { test as base, expect as baseExpect, openCoordinator, touch, settleMotion } from './fixtures.ts';
import { start, type Runtime } from './server.ts';
import { startFakeCoordinator, foldConversation } from './coordinator-fixture.ts';
import { patchTask, seedQuestion } from './fixture/task-state.ts';
import { decideValues } from '../tests/helpers/task-values.ts';
import type { TaskValues } from '@alpacawork/contract';

// Every label in the input is a recipient. Opening a Task seeds its label only into a draft with nothing of the
// person's in it; once written to, chosen in or with a label taken off, what the panel opens leaves the draft alone
// while anything is left in it. A send keeps
// the labels for the next draft, and the same panel puts nothing back. What the screen shows is sent nowhere: the
// message's tasks, the stored dialogue links and the Task's history name the recipients only.
const expect = baseExpect.configure({ timeout: 20_000 });
const SHOTS = process.env.RECIPIENTS_SHOTS;
const test = base.extend<{ runtime: Runtime; project: string }>({
  runtime: async ({}, use) => {
    const runtime = await start(undefined, startFakeCoordinator);
    try { await use(runtime); } finally { await runtime.stop(); }
  },
  project: async ({ runtime }, use) => {
    await use((await post<Written>(runtime, 'commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Recipients check' })).task.id);
  },
});
test.describe.configure({ timeout: 120_000 });

type Written = { task: { id: string; hash: string } };
async function post<Result>(runtime: Runtime, path: string, body: object): Promise<Result> {
  const response = await fetch(`${runtime.origin}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  baseExpect(response.status, text).toBe(200);
  return JSON.parse(text) as Result;
}
async function requested(runtime: Runtime, project: string, title: string, values?: TaskValues) {
  const { task } = await post<Written>(runtime, 'commands/task/new', { parent: project, title, ...values === undefined ? {} : { values } });
  await post(runtime, 'commands/agent/assign', { task: task.id, role: 'responsible', profile: 'codex', expectedTaskHash: task.hash });
  return task.id;
}
const DECIDE = decideValues(['Which option', ['Option1 Send current input', 'Send'], ['Option2 Decide later', 'Hold it']]);

const field = (page: Page) => page.locator('[data-coordinator-card] [data-one-input]');
const reader = (page: Page) => page.locator('aside[data-reader-mode]');
const labels = (page: Page) => labelLayer(field(page)).locator('[data-label=task]').evaluateAll(els => els.map(el => el.querySelector('.tabular-nums')?.textContent ?? ''));
/** The input's words as written, each label as [its id], spaces as one. */
const written = (page: Page) => field(page).evaluate(el => ((el as HTMLElement & { editor: { getJSON: () => { content: { content?: { type: string; text?: string; attrs?: { id: string } }[] }[] } } }).editor
  .getJSON().content.flatMap(block => block.content ?? []).map(node => node.type === 'taskLabel' ? `[${node.attrs!.id}]` : node.text ?? '').join('').replace(/ +/g, ' ')));
const linked = (runtime: Runtime) => {
  const db = new DatabaseSync(join(runtime.root, '.alpacawork', 'alpacawork.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT d.request_id AS request, k.external_id AS id FROM task_dialogues d JOIN tasks k ON k.id = d.task_uuid').all().map(row => String(row.id)).sort(); }
  finally { db.close(); }
};
const history = async (runtime: Runtime, task: string) =>
  ((await (await fetch(`${runtime.origin}/api/task/history?task=${task}&mode=latest`)).json()) as { events: { kind: string }[] }).events.filter(event => event.kind === 'dialogue').length;
async function answered(runtime: Runtime, count: number) {
  await expect.poll(async () => { const { turns } = (await (await fetch(`${runtime.origin}/api/coordinator`)).json()).conversation as { turns: { status: string }[] };
    return turns.length === count && turns.at(-1)!.status; }, { timeout: 30_000 }).toBe('succeeded');
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settleMotion(page);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

for (const [device, viewport] of [['pc', { width: 1440, height: 900 }]] as ['pc' | 'phone', { width: number; height: number }][]) test.describe(device, () => {
  test.use({ viewport, ...device === 'phone' ? { hasTouch: true, isMobile: true } : {}, locale: 'ja-JP' });
  test(`the input's labels are the recipients through choice, panel moves, sends and reload (${device})`, async ({ page, runtime, project }) => {
    const asking = await requested(runtime, project, 'Recipient question', DECIDE);
    patchTask(runtime.root, asking, { state: 'doing' });
    seedQuestion(runtime.root, asking, { to: 'user' });
    const other = await requested(runtime, project, 'Recipient other');
    const posts: Record<string, unknown>[] = [];
    page.on('request', (request: Request) => { if (new URL(request.url()).pathname === '/api/coordinator/messages' && request.method() === 'POST') posts.push(request.postDataJSON()); });
    const fold = () => foldConversation(page);
    // Opens `id` in the panel the way a person does: its row on a wide screen; back to the list and its row on a phone.
    const openInPanel = async (id: string, title: string) => {
      await fold();
      if (device === 'phone') {
        const header = reader(page).locator('[data-reader-header]');
        // Reveal a head hidden by reading. At the top, the same downward pull would dismiss the sheet instead.
        if (await header.getAttribute('data-reader-header') === 'hidden') {
          const box = (await reader(page).locator('[data-reader-content]').boundingBox())!;
          const point = { x: box.x + box.width / 2, y: box.y + Math.min(180, box.height / 2) };
          await touch(page, [[point], [{ x: point.x, y: point.y + 50 }], [{ x: point.x, y: point.y + 100 }], [{ x: point.x, y: point.y + 150 }]]);
        }
        await expect(header).toHaveAttribute('data-reader-header', 'shown');
        await settleMotion(page);
        await reader(page).locator('header').getByRole('button', { name: '詳細を閉じる', exact: true }).first().click();
        await settleMotion(page);
      }
      await page.getByRole('button', { name: new RegExp(device === 'phone' ? title : `^${id} ${title}`) }).first().click();
      await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(id);
      await settleMotion(page);
    };
    const send = async (count: number) => { await page.locator('[data-coordinator-card] [data-ask-send]').click(); await answered(runtime, count); };

    await page.goto(`${runtime.origin}/?project=${project}&task=${asking}`);
    await expect(reader(page).locator('[data-question="1"]')).toBeVisible();
    await openCoordinator(page);
    // An untouched draft takes the opened Task's label.
    await expect.poll(() => labels(page)).toEqual([asking]);
    await shot(page, `${device}-1-opened`);
    // A choice makes the draft the person's; another Task opened in the panel changes nothing in it.
    await fold();
    await reader(page).locator('[data-question="1"]').getByRole('button', { name: /Option1/ }).click();
    await settleMotion(page);
    await openInPanel(other, 'Recipient other');
    await openCoordinator(page);
    await expect.poll(() => labels(page)).toEqual([asking]);
    await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveCount(1);
    await shot(page, `${device}-2-choice-then-other-panel`);
    // Sent while the other Task is open: it goes to the chosen Task only, and its label stays for the next draft.
    await field(page).press('End'); await page.keyboard.insertText(' この案で');
    await send(1);
    baseExpect(posts[0]).not.toHaveProperty('context');
    baseExpect(posts[0]!.tasks).toEqual([asking]);
    baseExpect(posts[0]!.answers).toEqual([expect.objectContaining({ task: asking })]);
    await expect.poll(() => linked(runtime)).toEqual([asking]);
    await expect.poll(() => history(runtime, asking)).toBe(1);
    baseExpect(await history(runtime, other)).toBe(0);
    await expect.poll(() => labels(page)).toEqual([asking]);
    await expect(labelLayer(field(page)).locator('[data-label=answer]')).toHaveCount(0);
    await shot(page, `${device}-3-sent-label-kept`);
    // Taken off for a general question: recorded nowhere, and the same panel puts no label back.
    await labelLayer(field(page)).locator('[data-label=task] button[aria-label]').first().click();
    await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(0);
    await field(page).press('End'); await page.keyboard.insertText('PWAとは何ですか？ 参考: https://example.test/?task=' + other);
    await send(2);
    baseExpect(posts[1]).not.toHaveProperty('context');
    baseExpect(posts[1]!.tasks ?? []).toEqual([]);
    await expect.poll(() => linked(runtime)).toEqual([asking]);
    await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(0);
    await shot(page, `${device}-4-general-no-label`);
    // A newly opened Task seeds the untouched next draft; reload keeps it as it is.
    await openInPanel(asking, 'Recipient question');
    await openCoordinator(page);
    await expect.poll(() => labels(page)).toEqual([asking]);
    await shot(page, `${device}-5-new-task-seeds`);
    await page.reload();
    await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(asking);
    await openCoordinator(page);
    await expect.poll(() => labels(page)).toEqual([asking]);
    // The thread says nothing of what the screen showed.
    await expect(page.locator('[data-coordinator-panel]')).not.toContainText('を見ながら');
    await shot(page, `${device}-6-reloaded`);
  });
  test(`the head's insert mark puts its Task's label at the input's caret, once (${device})`, async ({ page, runtime, project }) => {
    const first = await requested(runtime, project, 'Insert first'), second = await requested(runtime, project, 'Insert second');
    await page.goto(`${runtime.origin}/?project=${project}&task=${first}`);
    // Pressed before the input was ever brought up: it comes up with the label, not twice beside its seed.
    await reader(page).locator('header').getByRole('button', { name: `${first} を入力欄に入れる` }).click();
    await expect.poll(() => labels(page)).toEqual([first]);
    await expect(field(page)).toBeFocused();
    // The person's words after the seed, the caret then between them and the input put away: the next label goes
    // where the caret was, not at either end.
    await field(page).press('End'); await page.keyboard.insertText(' 質問'); await field(page).press('ArrowLeft');
    // The editor reads a moved caret a moment later; it is put away once it has.
    await expect.poll(() => field(page).evaluate(el => { const { state } = (el as HTMLElement & { editor: { state: { selection: { from: number }; doc: { content: { size: number } } } } }).editor;
      return state.doc.content.size - state.selection.from; })).toBe(2);
    await page.keyboard.press('Escape');
    // Put away, the input's editor is off the page; it keeps its caret.
    await expect(field(page)).toHaveCount(0);
    await page.getByRole('button', { name: new RegExp(`^${second} Insert second`) }).first().click();
    await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(second);
    // It comes up with the caret right after the label put in.
    await reader(page).locator('header').getByRole('button', { name: `${second} を入力欄に入れる` }).click();
    await expect.poll(() => labels(page)).toEqual([first, second]);
    await expect(reader(page).locator('header').getByRole('button', { name: `${second} を入力欄に入れました` })).toBeVisible();
    await page.keyboard.insertText('と');
    await expect.poll(() => written(page)).toBe(`[${first}] 質[${second}] と問`);
    // Already in: not put in twice.
    await reader(page).locator('header').getByRole('button', { name: new RegExp(`^${second} を入力欄に入れ`) }).click();
    await expect.poll(() => written(page)).toBe(`[${first}] 質[${second}] と問`);
  });
});

// The project in view seeds its label as an opened Task does: choosing another project puts that one's in place of an
// untouched draft's, every project takes it off, and words written keep the draft as it is. A label taken off stays off
// while the same project is in view, a reload included; another project chosen is a new opening. A Task opened over the
// list does not take off a label the person put in.
test.describe('project in view', () => {
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP' });
  test('the project in view seeds its label and follows the project chosen', async ({ page, runtime, project }) => {
    const other = (await post<Written>(runtime, 'commands/task/new', { kind: 'project', color: '#9b3939', parent: 'none', title: 'Recipients other' })).task.id;
    const task = await requested(runtime, project, 'Recipient in project');
    const choose = async (id: string | null) => {
      await page.locator('[data-project-trigger]').click();
      await page.locator(`[data-project-item="${id ?? 'all'}"]`).click();
    };
    await page.goto(`${runtime.origin}/?project=${project}`);
    await openCoordinator(page);
    await expect.poll(() => written(page)).toBe(`[${project}]`);
    await choose(other);
    await expect.poll(() => written(page)).toBe(`[${other}]`);
    await choose(null);
    await expect.poll(() => written(page)).toBe('');
    await choose(project);
    await expect.poll(() => written(page)).toBe(`[${project}]`);
    // Taken off, it stays off through a reload; another project chosen then puts its label in.
    await labelLayer(field(page)).locator('[data-label=task] button[aria-label]').first().click();
    await expect.poll(() => written(page)).toBe('');
    await page.reload();
    await openCoordinator(page);
    await page.waitForTimeout(500);
    await expect.poll(() => written(page)).toBe('');
    await choose(other);
    await expect.poll(() => written(page)).toBe(`[${other}]`);
    // Put in by the person, a project's label stays while a Task of it is opened over the list.
    await choose(project);
    await expect.poll(() => written(page)).toBe(`[${project}]`);
    await labelLayer(field(page)).locator('[data-label=task] button[aria-label]').first().click();
    await field(page).press('End'); await page.keyboard.type('#');
    await page.locator(`[data-project-row] [title="${project}"]`).click();
    await expect.poll(() => written(page)).toBe(`[${project}] `);
    await page.getByRole('button', { name: new RegExp(`^${task} Recipient in project`) }).first().click();
    await expect(reader(page).locator('header [data-reader-task-id]')).toHaveText(task);
    await expect.poll(() => written(page)).toBe(`[${project}] `);
    // Words written keep the draft whatever project is chosen.
    await field(page).press('End'); await page.keyboard.insertText('調べて');
    await choose(other);
    await expect.poll(() => written(page)).toBe(`[${project}] 調べて`);
  });
});
