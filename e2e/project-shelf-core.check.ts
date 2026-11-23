/** Integration through the standard view Query, actual catalog and archive URL surface. */
import { test, expect } from './fixtures.ts';
import { commandPost } from './command-post.ts';

test.use({ isolated: true });
test('a warmed project URL survives parent archive and restore through the standard view Query', async ({ page, runtime }) => {
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const project = (await post('commands/task/new', { kind: 'project', color: '#39659b', parent: 'none', title: 'Shelf core fixture' })).task;
  const nested = (await post('commands/task/new', { kind: 'project', color: '#39659b', parent: project.id, title: 'Nested fixture' })).task;
  const child = (await post('commands/task/new', { parent: nested.id, title: 'Retained child', fromUser: true })).task;
  await page.goto(runtime.origin + '/?agent=1&task=' + child.id);
  await expect(page.locator('[data-reader-task-id]')).toHaveText(child.id);
  const before = await (await page.request.get(runtime.origin + '/api/commands/task/get?task=' + child.id)).json();
  const currentProject = await (await page.request.get(runtime.origin + '/api/commands/task/get?task=' + project.id)).json();
  const archived = await post('commands/task/archive', { task: project.id, expectedTaskHash: currentProject.task.hash });
  await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/workspace/live')).json()).projects.some((p: { id: string }) => p.id === nested.id)).toBe(false);
  const id = project.id;
  await page.goto(runtime.origin + '/?agent=1&project=' + id);
  const result = await page.request.get(runtime.origin + '/api/task/view?task=' + id);
  expect(result.status()).toBe(404);
  const refusal = await result.json();
  expect(refusal.error.reason.kind).toBe('task_archived');
  expect(refusal.error.detail.shelf.restoreTarget.id).toBe(project.id);
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(id);
  await expect(page.locator('[data-archive-notice]')).toBeVisible();
  await expect(page.locator('[data-row="' + child.id + '"]')).toHaveCount(0);
  const catalog = await (await page.request.get(runtime.origin + '/api/commands/project/shelf')).json();
  const target = catalog.projects.find((p: { id: string }) => p.id === project.id).shelf.restoreTarget;
  expect(target.hash).toBe(archived.task.hash);
  await expect(page.locator('[data-archive-notice]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-archive-restore]')).toBeEnabled();
  await page.locator('[data-archive-restore]').click();
  await expect(page.locator('[data-archive-notice]')).toHaveCount(0);
  await expect.poll(async () => (await (await page.request.get(runtime.origin + '/api/task/view?task=' + id)).json()).task?.id).toBe(id);
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe(id);
  const after = await (await page.request.get(runtime.origin + '/api/commands/task/get?task=' + child.id)).json();
  expect(after.task.hash).toBe(before.task.hash); expect(after.task.lifecycle).toBe(before.task.lifecycle);
});

// While the feed is late the page cannot learn that the list changed: only Retry can leave the refused cursor.
test('a shelved next page refused because the list changed is read again from its first page by Retry', async ({ page, runtime }) => {
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, { data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const shelve = async (title: string) => {
    const { task } = await post('commands/task/new', { title });
    return (await post('commands/task/archive', { task: task.id, expectedTaskHash: task.hash })).task;
  };
  const shelved = [];
  for (let at = 0; at < 22; at++) shelved.push(await shelve(`Shelved ${at}`));
  // The server's own refusal of a cursor from before a change.
  const first = await (await page.request.get(runtime.origin + '/api/task/shelved?limit=20')).json();
  await post('commands/task/restore', { task: shelved[0].id, expectedTaskHash: shelved[0].hash });
  const refusal = await page.request.get(runtime.origin + `/api/task/shelved?limit=20&after=${encodeURIComponent(first.nextAfter)}`);
  expect(refusal.status()).toBe(409);
  const refused = await refusal.text();
  // The list as it stands on a page that has not heard: every next page is refused until it reads from the first page again.
  const reads: string[] = [];
  let reread = false;
  await page.route('**/api/task/shelved?*', async route => {
    const after = new URL(route.request().url()).searchParams.has('after');
    reads.push(after ? 'next' : 'first');
    if (after && !reread) { await route.fulfill({ status: 409, contentType: 'application/json', body: refused }); return; }
    reread = !after && reads.includes('next');
    await route.continue();
  });
  await page.goto(runtime.origin + '/?agent=1');
  await page.locator('[data-section="done"] button').click();
  await page.locator('[data-shelved] summary').click();
  const rows = page.locator('[data-shelved] li').filter({ has: page.getByRole('button', { name: 'Restore', exact: true }) });
  await expect(rows).toHaveCount(20);
  await page.locator('[data-shelved-tail]').scrollIntoViewIfNeeded();
  const failure = page.locator('[data-shelved-tail] [data-read-failure]');
  await expect(failure).toBeVisible();
  await failure.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(rows).toHaveCount(21);
  await expect(failure).toHaveCount(0);
  expect(reads.slice(0, 4)).toEqual(['first', 'next', 'first', 'next']);
});

// At a phone's width, where the Check stands over or beside the dialog and closing it is a history step (dialog.tsx useCloseOnBack);
// a computer's Check closing the dialog is 'project modal keeps unknown explicit' below. The receipt's rules have no width.
{
  const width = 390;
  test(`committed archive loses only its response; SSE unmount then notification Check closes settings at ${width}`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height: 900 });
    const made = await commandPost(page.request, runtime.origin + '/api/commands/task/new', { data: {
      kind: 'project', color: '#39659b', parent: 'none', title: 'Committed response loss fixture',
    } });
    expect(made.ok()).toBe(true);
    const project = (await made.json()).task;
    await page.goto(runtime.origin + '/?agent=1&project=' + project.id);
    await page.locator('[data-project-trigger]').click();
    await page.locator('[data-project-settings]').click();
    await expect(page.locator('[data-project-archive] button')).toBeEnabled();
    await page.locator('[data-project-archive] button').click();
    const requests: { body: string | null; operationId?: string }[] = [];
    const receipts: { status: number; body: any }[] = [];
    await page.route('**/api/commands/task/archive', async route => {
      requests.push({ body: route.request().postData(), operationId: route.request().headers()['x-alpacawork-op-id'] });
      const response = await route.fetch();
      receipts.push({ status: response.status(), body: await response.json() });
      if (requests.length === 1) {
        expect(response.status()).toBe(200);
        // No receipt has reached the browser. This removal therefore comes from real serve's SSE.
        await expect(page.locator('[data-project-archive]')).toHaveCount(0);
        await route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Lost committed response', retry: 'check' } } });
      } else await route.fulfill({ response });
    });
    await page.locator('[data-archive-submit]').click();
    const check = page.locator('[data-toast] [data-toast-action]');
    await expect(check).toHaveText('Check');
    await expect(page.locator('[role=dialog]')).toHaveCount(1);
    await check.click();
    await expect(page.locator('[role=dialog]')).toHaveCount(0);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(receipts[1]).toEqual(receipts[0]);
    const current = await (await page.request.get(runtime.origin + '/api/commands/task/get?task=' + project.id + '&log=80')).json();
    expect(current.task.lifecycle).toBe('archived');
    const archived = current.task.log.filter((entry: { kind: string }) => entry.kind === 'archived');
    expect(archived).toHaveLength(1);
  });
}

for (const failure of ['unknown'] as ('unknown' | 'hash conflict')[]) test(`project modal keeps ${failure} explicit through the actual archive endpoint`, async ({page, runtime}) => {
  const post = async (path: string, data: object) => {
    const response = await commandPost(page.request, runtime.origin + '/api/' + path, {data});
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const project = (await post('commands/task/new', {kind:'project', color:'#5a8649', parent:'none', title:'Archive recovery fixture'})).task;
  await page.goto(runtime.origin + '/?agent=1&project=' + project.id);
  await page.locator('[data-project-trigger]').click();
  await page.locator('[data-project-settings]').click();
  await expect(page.locator('[data-project-archive] button')).toBeEnabled();
  await page.locator('[data-project-archive] button').click();
  const requests: {body: string | null; id: string | undefined}[] = [];
  await page.route('**/api/commands/task/archive', async route => {
    const request = route.request(); requests.push({body: request.postData(), id: request.headers()['x-alpacawork-op-id']});
    if(requests.length === 1 && failure === 'unknown') {
      await route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({error:{code:'unavailable', message:'Lost fixture answer', retry:'check'}})});
      return;
    }
    if(failure === 'hash conflict') await post('commands/task/update',{task:project.id, title:'Changed elsewhere', expectedTaskHash:project.hash});
    await route.continue();
  });
  await page.locator('[data-archive-submit]').click();
  await expect(page.locator('[data-archive-confirm]')).toHaveCount(0);
  const notice = page.locator('[data-toast][data-kind=error]');
  await expect(notice).toBeVisible();
  if(failure === 'unknown') {
    await expect(notice.getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
    expect(requests).toHaveLength(1);
    await notice.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.locator('[role=dialog]')).toHaveCount(0);
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    const catalog = await (await page.request.get(runtime.origin + '/api/commands/project/shelf')).json();
    expect(catalog.projects.find((p: {id:string}) => p.id===project.id).color).toBe('#5a8649');
  } else {
    await expect(notice.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
    expect(requests).toHaveLength(1);
    expect((await (await page.request.get(runtime.origin + '/api/commands/task/get?task=' + project.id)).json()).task.lifecycle).toBe('active');
  }
});
