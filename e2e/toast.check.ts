import { test, expect, open } from './fixtures.ts';
import { atTheTop } from './toast-position.ts';
import { commandPost } from './command-post.ts';

// One owner of toasts. What fails is said in the person's words as a toast, in the window it was done in, over
// what was pressed; nothing technical is written over the input.
test.use({ isolated: true });

test('a form validates locally and closes on admission, then shows its refused delivery in one toast', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, '?agent=1');
  await page.locator('[data-project-trigger]').click();
  await page.locator('[data-project-new]').click();
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const field = dialog.locator('#project-new-name');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('[data-toast]')).toHaveCount(0);
  await dialog.locator('#project-new-name').fill('見本');
  await page.route('**/api/task/new', route => route.fulfill({ status: 503, json: { error: { code: 'busy', message: 'busy', retry: 'later' } } }));
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const toast = page.locator('[data-toast][data-kind=error]');
  await expect(toast).toContainText('Try again shortly.');
  await atTheTop(toast);
  await expect(dialog).toBeHidden();
  await expect(toast).toHaveCount(1);
  // The saved form's words survive closing its one recovery notice.
  await toast.getByRole('button', { name: 'Close' }).click();
  await expect(toast).toHaveCount(0);
  await page.locator('[data-project-trigger]').click();
  await page.locator('[data-project-new]').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#project-new-name')).toHaveValue('見本');
});

// Exercise browser touch arbitration and real Web Animations on the shared card.
test.describe('toast touch swipe', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
});

test.describe('toast swipe isolation', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
});

test.describe('three-second unsent undo', () => {
  test.use({ fixedTime: false, writeGraceMs: 3000 });
  test('restore offers undo immediately and sends only after three real seconds',async({page,runtime})=>{
    await page.setViewportSize({width:1440,height:900});
    const made=await commandPost(page.request,runtime.origin+'/api/task/new',{data:{parent:'P1',title:'Five second undo'}});
    const task=(await made.json()).task;
    expect((await commandPost(page.request,runtime.origin+'/api/task/archive',{data:{task:task.id,expectedTaskHash:task.hash}})).ok()).toBe(true);
    await open(page,runtime,'?agent=1');
    await page.locator('[data-section="done"] button').click();
    await page.locator('[data-shelved] summary').click();
    const posts: number[]=[];
    page.on('request',request=>{if(new URL(request.url()).pathname==='/api/task/restore'&&request.method()==='POST') posts.push(Date.now());});
    const sent=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/task/restore'&&response.request().method()==='POST');
    const pressed=Date.now();
    await page.locator('[data-shelved] li').filter({hasText:'Five second undo'}).getByRole('button',{name:'Restore',exact:true}).click();
    const offer=page.locator('[data-toast][data-kind="success"]');
    await expect(offer.getByRole('button',{name:'Undo',exact:true})).toBeVisible();
    await expect(offer.locator('[data-toast-text]')).toHaveText(`Restored ${task.id}`);
    expect(posts).toHaveLength(0);
    await page.waitForTimeout(1000);
    expect(posts).toHaveLength(0);
    await page.screenshot({path:test.info().outputPath('undo-grace.png')});
    expect((await sent).ok()).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!-pressed).toBeGreaterThanOrEqual(2900);
    await expect(offer.getByRole('button',{name:'Undo',exact:true})).toHaveCount(0);
  });
});
