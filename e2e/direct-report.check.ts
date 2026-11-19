import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, settleMotion, keepShot, holdReader, taskKey } from './fixtures.ts';
import { commandPost } from './command-post.ts';
import { placeResponsible } from './fixture/responsible.ts';
import { seedReview } from './fixture/task-state.ts';
import { readTaskLog } from './task-history.ts';

test.use({ isolated: true, hasTouch: true });
// The report the screen writes is the same at every width (use-task-report); swipes are review-swipe's. The form is a
// sheet on a phone and a popover on a computer (popup.tsx), so the form's cases stand on both.
for (const [action, width] of [['form-done', 1440]] as ['complete' | 'H' | 'form-done' | 'form-held' | 'form-restore' | 'form-stopped', number][]) {
  test(`human direct report ${action} at ${width}`, async ({ page, runtime }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const post = async (path: string, data: object) => {
      const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
      expect(response.ok(), await response.text()).toBe(true); return response.json();
    };
    const { task: project } = await post('task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Direct report proof' });
    const ids: string[] = [], runs: string[] = [];
    for (const title of ['Direct action target', 'Next waiting card']) {
      const { task } = await post('task/new', { parent: project.id, title });
      await placeResponsible(page.request, runtime.origin, task);
      ids.push(task.id); runs.push(seedReview(runtime.root, task.id, { title: 'Review result', description: 'Ready to confirm' }));
    }
    const get = async () => (await (await page.request.get(runtime.origin + '/api/task/get?task=' + ids[0])).json());
    if (action === 'form-restore') await post('task/report', { task: ids[0], state: 'held', expectedTaskHash: (await get()).task.hash, opId: crypto.randomUUID() });
    const shown = await get();
    const revision = shown.agents.find((placement: any) => placement.active && placement.responsible).revision;
    await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${ids[0]}`);
    const reader = page.locator('aside[data-reader-mode]'), header = reader.locator('header [data-reader-task-id]');
    await expect(header).toHaveText(ids[0]!); await settleMotion(page);
    const posts: { path: string; input: any }[] = [];
    const words = ({ 'form-done': { title: 'Done', description: 'Reviewed the result.' },
      'form-held': { title: 'On hold', description: 'Handle this later.' }, 'form-restore': { title: 'Off hold', description: 'Back to its state before the hold.' },
      'form-stopped': { title: 'Stopped', description: 'Stops this task and the tasks under it.' } } as Record<string, { title: string; description: string }>)[action];
    page.on('request', request => { if (request.method() === 'POST') posts.push({ path: new URL(request.url()).pathname, input: request.postDataJSON() }); });
    if (action === 'complete') await page.locator('[data-task-done]').click();
    else if (action === 'H') await holdReader(page);
    else {
      await taskKey(page, 'r');
      const popup = page.getByRole('dialog', { name: `Change the state of ${ids[0]}` });
      await expect(popup).toBeVisible();
      const label = { 'form-done': 'Done', 'form-held': 'On hold', 'form-restore': 'Awaiting review', 'form-stopped': 'Stopped' }[action];
      await popup.getByRole('radio', { name: label, exact: true }).click();
      // The choice's own words stand in the fields as values, and go as shown.
      await expect(popup.getByRole('textbox', { name: 'Title in History' })).toHaveValue(words!.title);
      await expect(popup.getByRole('textbox', { name: 'Description in History' })).toHaveValue(words!.description);
      if (process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE) {
        mkdirSync(join(process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE, 'screens'), { recursive: true });
        await page.screenshot({ path: join(process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE, 'screens', `${width}-${action}-form.png`) });
      }
      await popup.getByRole('button', { name: 'Update', exact: true }).click();
    }
    await expect.poll(() => posts.filter(post => post.path === '/api/task/report').length).toBe(1);
    const report = posts.find(post => post.path === '/api/task/report')!.input;
    const state = action === 'H' || action === 'form-held' ? 'held' : action === 'form-restore' ? 'waiting' : action === 'form-stopped' ? 'stopped' : 'done';
    expect(report).toMatchObject({ task: ids[0], state, expectedTaskHash: shown.task.hash, expectedPlacementRevision: revision });
    if (state === 'done') expect(report.aboutRun).toBe(runs[0]); else expect(report).not.toHaveProperty('aboutRun');
    if (words) expect(report).toMatchObject(words);
    await expect.poll(async () => (await get()).task.state).toBe(state);
    expect(posts.filter(post => post.path === '/api/coordinator/messages')).toEqual([]);
    const record = (await readTaskLog(runtime.origin, ids[0]!)).find(entry => entry.id === report.opId);
    expect(record?.actor).toEqual({ kind: 'human' });
    if (action !== 'form-restore') await expect(header).toHaveText(ids[1]!);
    else await expect(header).toHaveText(ids[0]!);
    if (process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE) {
      const folder = join(process.env.ALPACAWORK_DIRECT_REPORT_EVIDENCE, 'screens'); mkdirSync(folder, { recursive: true });
      await page.screenshot({ path: join(folder, `${width}-${action}-result.png`) });
      writeFileSync(join(folder, `${width}-${action}.json`), JSON.stringify({ test: info.title, workspace: runtime.root, posts, record, nextCard: await header.textContent() }, null, 2));
    }
  });
}

// The form is a sheet on a phone and a popover on a computer (popup.tsx): Open brings each back with what was written.
for (const width of [390]) test(`direct report recovery keeps title/body and leaves conversational words independent at ${width}`, async ({ page, runtime }) => {
  await page.setViewportSize({ width, height: 900 });
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const { task: project } = await post('task/new', { kind:'project', color: '#39659b', parent:'none', title:'Recovery proof' });
  const { task } = await post('task/new', { parent:project.id, title:'Recovery target' });
  await placeResponsible(page.request, runtime.origin, task);
  seedReview(runtime.root, task.id, { title:'Please review', description:'Ready' });
  const { task: other } = await post('task/new', { parent:project.id, title:'Next card' });
  await placeResponsible(page.request, runtime.origin, other);
  seedReview(runtime.root, other.id, { title:'Please review', description:'Ready' });
  const get = async () => (await (await page.request.get(runtime.origin + '/api/task/get?task=' + task.id)).json());
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${task.id}`);
  const { openCoordinator } = await import('./fixtures.ts');
  await openCoordinator(page);
  await page.locator('[data-one-input]').fill('Keep these unsent conversation words');
  await page.keyboard.press('Escape');
  await taskKey(page, 'r');
  const form = page.getByRole('dialog', { name:`Change the state of ${task.id}` });
  await form.getByRole('textbox', { name:'Title in History', exact:true }).fill('My report title');
  await form.getByRole('textbox', { name:'Description in History', exact:true }).fill('My report body');
  const reports: any[] = [];
  await page.route('**/api/task/report', async route => {
    reports.push(route.request().postDataJSON());
    if (reports.length === 1) await post('task/update', { task:task.id, title:'A newer displayed revision', expectedTaskHash:(await get()).task.hash });
    await route.continue();
  });
  await form.getByRole('button', { name:'Update', exact:true }).click();
  const entrance = page.locator('[data-toast]').getByRole('button', { name:'Open', exact:true });
  await expect(entrance).toBeVisible();
  await expect(page.locator('aside header [data-reader-task-id]')).toHaveText(other.id);
  await entrance.click();
  await expect(form).toBeVisible();
  await expect(form.getByRole('textbox', { name:'Title in History', exact:true })).toHaveValue('My report title');
  await expect(form.getByRole('textbox', { name:'Description in History', exact:true })).toHaveValue('My report body');
  await form.getByRole('radio', { name:'Done', exact:true }).click();
  await form.getByRole('button', { name:'Update', exact:true }).click();
  await expect.poll(async () => (await get()).task.state).toBe('done');
  expect(reports).toHaveLength(2); expect(reports[1].opId).not.toBe(reports[0].opId);
  expect(reports[1].expectedTaskHash).not.toBe(reports[0].expectedTaskHash);
  expect(reports[1]).toMatchObject({title:'My report title',description:'My report body',aboutRun:reports[0].aboutRun});
  if (!await page.locator('[data-one-input]').isVisible()) await openCoordinator(page);
  await expect(page.locator('[data-one-input]')).toContainText('Keep these unsent conversation words');
});

// Notification routing must preserve failures of actual screen presses, at both form factors. A hold's on a
// computer and on a phone are swipe-recovery's recovery toast, a completion's on a phone review-swipe's.
for (const failure of ['refused'] as const) {
  test(`screen complete ${failure} still offers recovery at 1280`, async ({ page, runtime }) => {
    await page.setViewportSize({ width: 1280, height: 844 });
    const response = await commandPost(page.request, runtime.origin + '/api/task/new', { data: { parent: 'P1', title: 'Screen operation failure' } });
    expect(response.ok()).toBe(true);
    const { task } = await response.json();
    await placeResponsible(page.request, runtime.origin, task);
    seedReview(runtime.root, task.id, { title: 'Please review', description: 'Ready to confirm' });
    await page.goto(runtime.origin + `/?agent=1&task=${task.id}`);
    const reader = page.locator('aside[data-reader-mode]');
    await expect(reader.locator('header [data-reader-task-id]')).toHaveText(task.id);
    await settleMotion(page);
    await page.route('**/api/task/report', route => failure === 'refused'
      ? route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Task changed', retry: 'reread' } } })
      : route.abort('failed'));
    await page.locator('[data-task-done]').click();
    const toast = page.locator('[data-toast][data-kind=error]');
    await expect(toast.getByRole('button', { name: failure === 'refused' ? 'Open' : 'Check', exact: true })).toBeVisible();
    await settleMotion(page, toast);
    await keepShot(page, `screen-complete-${failure}-1280`);
  });
}
