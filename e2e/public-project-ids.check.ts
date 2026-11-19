import { test, expect, open, settleMotion } from './fixtures.ts';
import { SAMPLE_PROJECT } from './fixture/sample.ts';
import { commandPost } from './command-post.ts';

test.use({ isolated: true });
for (const width of [1440]) test(`public project IDs across URL, choices and labels at ${width}px`, async ({ page, runtime }) => {
  await page.setViewportSize({ width, height: 900 });
  await open(page, runtime);
  const added = await commandPost(page.request, `${runtime.origin}/api/task/new`, { data: { kind: 'project', color: '#39659b', parent: 'none', title: SAMPLE_PROJECT.title } });
  expect(added.ok(), await added.text()).toBe(true);
  const project = (await added.json()).task;
  expect(project.id).toMatch(/^P[1-9]\d*$/);
  const longResponse = await commandPost(page.request, `${runtime.origin}/api/task/new`, { data: { kind: 'project', color: '#39659b', parent: 'none', title: 'A'.repeat(180) } });
  expect(longResponse.ok(), await longResponse.text()).toBe(true);
  const longProject = (await longResponse.json()).task;
  await page.goto(`${runtime.origin}/?project=P1&task=T111&agent=1`);
  await expect(page.locator('[data-reader-task-id]')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('project')).toBe('P1');
  await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe('T111');
  // With several projects in view the path starts with the project's square, then the first ID as on a list's row:
  // no separator between them, and the same distance.
  await page.goto(`${runtime.origin}/?task=T112&agent=1`);
  const pathTile = page.locator('[data-reader-path] [data-project-tile]').first();
  await expect(pathTile).toBeVisible();
  const rowTile = page.locator('[data-row] [data-project-tile]').first();
  await expect(rowTile).toBeAttached();
  const toId = (tile: Element) => {
    const next = tile.nextElementSibling!;
    // The ID's text itself: the path's first ID may stand in a button with padding of its own.
    const text = document.createTreeWalker(next, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.selectNodeContents(text);
    return { separator: next.hasAttribute('data-reader-path-separator'), gap: range.getBoundingClientRect().left - tile.getBoundingClientRect().right };
  };
  const inPath = await pathTile.evaluate(toId), inRow = await rowTile.evaluate(toId);
  expect(inPath.separator).toBe(false);
  expect(Math.abs(inPath.gap - inRow.gap), 'the square stands as far from the ID as on a row').toBeLessThanOrEqual(0.5);
  // Close the reader so the project picker can be operated at either width.
  await page.goto(`${runtime.origin}/?project=P1&agent=1`);
  await page.locator('[data-project-trigger]').click();
  const menu = page.getByRole('menu', { name: 'Projects' });
  await expect(menu.locator('[data-project-item="P1"]')).toContainText(`${SAMPLE_PROJECT.title} P1`);
  await expect(menu.locator(`[data-project-item="${project.id}"]`)).toContainText(`${SAMPLE_PROJECT.title} ${project.id}`);
  await settleMotion(page, menu);
  const longId = menu.locator(`[data-project-item="${longProject.id}"] [data-project-id]`);
  await expect(longId).toBeVisible();
  expect(await longId.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
  })).toBe(true);
  await menu.getByRole('menuitem', { name: 'New project' }).click();
  const parent = page.getByLabel('Parent project');
  await expect(parent.locator('option[value="P1"]')).toHaveText(`${SAMPLE_PROJECT.title}　P1`);
  await expect(parent.locator(`option[value="${project.id}"]`)).toHaveText(`${SAMPLE_PROJECT.title}　${project.id}`);
});
