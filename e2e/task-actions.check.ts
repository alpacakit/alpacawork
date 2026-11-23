import { seedReview } from './fixture/task-state.ts';
import { test, expect, open, openCoordinator, settleMotion } from './fixtures.ts';
import { configureCoordinator } from './coordinator-fixture.ts';

// Done here really finishes T112: every test has a workspace of its own.
test.use({ isolated: true });
test.beforeEach(async ({ runtime }) => { seedReview(runtime.root, 'T112'); });

test('Done sends once without opening the form, and a second press while the reader leaves sends nothing', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, '?task=T112');
  let release!: () => void, sent = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/commands/task/report', async route => { sent++; await gate; await route.continue(); });
  const done = page.locator('[data-task-action-slot] [data-task-done]');
  await done.click();
  await expect(page.getByRole('dialog', { name: 'Change the state of T112' })).toHaveCount(0);
  await page.locator('[data-task-done]:visible').first().click({ force: true }).catch(() => {});
  release();
  await expect.poll(() => sent).toBe(1);
  await page.waitForTimeout(500);
  expect(sent).toBe(1);
});

// In the conversation's foot on a computer the tools say their words where they all fit, else they are marks
// (also when the pane is narrowed under them); Clear, left of them, asks again over itself without moving.
test('the conversation foot words its tools where they fit, and Clear asks over itself', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, '?agent=1');
  const { id } = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
  expect((await page.request.post(`${runtime.origin}/api/coordinator/messages`, { data: { conversationId: id, id: crypto.randomUUID(), text: 'markdown-answer number 1', attachments: [] } })).ok()).toBe(true);
  await page.evaluate(() => localStorage.setItem('alpacawork.coordinatorFrame', JSON.stringify({ side: 'right', x: 16, edge: 'bottom', y: 12, width: 640, height: 400 })));
  await open(page, runtime, '?task=T112&agent=1');
  await openCoordinator(page);
  const foot = page.locator('[data-coordinator-end]'), clear = foot.locator('[data-coordinator-clear]');
  await expect(foot.locator('[data-task-done]')).toBeVisible();
  await expect(clear).toHaveText('Clear conversation');
  await expect(foot.locator('[data-task-state]')).toHaveText('Change state');
  // Narrowed by the hand under its words, they become marks.
  const edge = (await page.locator('[data-frame-edge="left"]').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2); await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 300, edge.y + edge.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(clear).toHaveText('');
  await settleMotion(page, undefined, true);
  const before = (await clear.boundingBox())!;
  expect(before.x).toBeLessThan((await foot.locator('[data-task-state]').boundingBox())!.x);
  await clear.click();
  await expect(page.locator('[data-coordinator-clear-ask]')).toHaveText('Click again to clear');
  expect(await clear.boundingBox()).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-coordinator-clear-ask]')).toHaveCount(0);
  await expect(clear).toHaveAttribute('aria-label', 'Clear conversation');
});

// In the conversation's own window the same: words while they fit, marks once it narrows.
test('in its own window the foot words its tools while they fit, and narrowed they are marks', async ({ page, runtime }) => {
  configureCoordinator(runtime.root);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, '?agent=1');
  const { id } = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
  expect((await page.request.post(`${runtime.origin}/api/coordinator/messages`, { data: { conversationId: id, id: crypto.randomUUID(), text: 'markdown-answer number 1', attachments: [] } })).ok()).toBe(true);
  await open(page, runtime, '?task=T112&agent=1');
  await openCoordinator(page);
  const opened = page.context().waitForEvent('page');
  await page.locator('[data-coordinator-pop-out]').click();
  const own = await opened;
  const clear = own.locator('[data-coordinator-clear]');
  await expect(own.locator('[data-task-done]')).toBeVisible();
  await expect(clear).toHaveText('Clear conversation');
  // The window narrowed (its body, as a narrower window draws it): marks.
  await own.evaluate(() => { document.body.style.width = '380px'; });
  await expect(clear).toHaveText('');
  await own.evaluate(() => { document.body.style.width = ''; });
  await expect(clear).toHaveText('Clear conversation');
});

// Folded over the input, the row holds its tools by the same rule: on a narrow computer pane they are marks and
// the row stays one line inside its width; as wide as their words, they say them.
test('folded over the input, the tools are marks where their words do not fit and stay inside the row', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, '?agent=1');
  const frame = (width: number) => page.evaluate(w => localStorage.setItem('alpacawork.coordinatorFrame', JSON.stringify({ side: 'left', x: 16, edge: 'bottom', y: 12, width: w, height: 400 })), width);
  await frame(340);
  await open(page, runtime, '?task=T112&agent=1');
  const row = page.locator('[data-coordinator-fold-row]'), state = row.locator('[data-task-state]');
  await expect(row.locator('[data-task-done]')).toBeVisible();
  await expect(state).toHaveText('');
  const inside = await row.evaluate(line => { const box = line.getBoundingClientRect();
    return [...line.querySelectorAll('button')].every(button => { const at = button.getBoundingClientRect(); return !at.width || at.left >= box.left - 1 && at.right <= box.right + 1 && at.height <= 40; }); });
  expect(inside).toBe(true);
  await frame(700);
  await open(page, runtime, '?task=T112&agent=1');
  await expect(state).toHaveText('Change state');
});

// In the folded row the tools never keep their words while a message's grace beside them shows only Undo: they give it
// its whole width (its words beside Undo) while they can, else they are marks; the row stays inside its width.
test.describe('folded grace beside the tools', () => {
  test.use({ fixedTime: false, writeGraceMs: 60000 });
  test('the tools keep their words only where the grace still says Sending soon beside Undo', async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, runtime, '?task=T112&agent=1');
    await openCoordinator(page);
    await page.locator('[data-coordinator-panel] [data-coordinator-fold]').click();
    const area = page.locator('[data-coordinator-fold-area]'), pill = area.locator('[data-coordinator-pill]');
    await expect(area.locator('[data-task-done]')).toBeVisible();
    await page.locator('[data-one-input]').fill('Grace beside the tools');
    await page.locator('[data-ask-send]').click();
    await expect(pill).toHaveAttribute('data-coordinator-pill-state', 'waiting');
    for (let width = 340; width <= 640; width += 8) {
      await area.evaluate((element, w) => { (element as HTMLElement).style.width = `${w}px`; }, width);
      // Read once the row has settled: the tools measure it again over a few frames (useRowWords).
      const fits = await pill.evaluate(element => new Promise<boolean>(done => {
        const row = element.parentElement!;
        let last = '', still = 0, frames = 0;
        const step = () => {
          const now = [...row.children].map(child => Math.round(child.getBoundingClientRect().width)).join();
          still = now === last ? still + 1 : 0; last = now;
          if (still < 3 && ++frames < 60) { requestAnimationFrame(step); return; }
          const box = element.getBoundingClientRect(), words = [...element.querySelectorAll('span')].find(span => span.textContent === 'Sending soon')!.getBoundingClientRect();
          const inside = [...row.querySelectorAll('button')].every(button => { const at = button.getBoundingClientRect(); return !at.width || at.right <= row.getBoundingClientRect().right + 1; });
          const said = words.width > 0 && words.top >= box.top && words.bottom <= box.bottom && words.right <= box.right;
          done(inside && (said || !row.querySelector('[data-task-state]')!.textContent));
        };
        requestAnimationFrame(step);
      }));
      expect(fits, `${width}px`).toBe(true);
    }
    // Wide enough for both, the tools keep their words beside the grace.
    await expect(area.locator('[data-task-state]')).toHaveText('Change state');
  });
});

// On a phone the sheet closes from over Done, under the thumb: apart from Done (each with its touch room), it closes
// the sheet as its × does and reports nothing.
test.describe('phone task sheet', () => {
  test.use({ isMobile: true, hasTouch: true, viewport: { width: 412, height: 915 } });

  test('the ∨ over Done closes the sheet without reporting', async ({ page, runtime }) => {
    await open(page, runtime, '?agent=1&task=T112');
    let sent = 0;
    await page.route('**/api/commands/task/report', route => { sent++; return route.continue(); });
    const close = page.locator('[data-coordinator-fold-row] [data-reader-sheet-close]'), done = page.locator('[data-coordinator-fold-row] [data-task-done]');
    await expect(done).toBeVisible();
    await settleMotion(page);
    const [over, under] = [(await close.boundingBox())!, (await done.boundingBox())!];
    // Its touch room runs 8px under it (conversationTool), so it stays clear of Done's.
    expect(over.y + over.height + 8).toBeLessThan(under.y);
    expect(Math.abs(over.x + over.width - (under.x + under.width))).toBeLessThanOrEqual(1);
    await close.tap();
    await expect(page.locator('[data-reader-mode="sheet"]')).toHaveCount(0);
    await expect(page).not.toHaveURL(/task=T112/);
    expect(sent).toBe(0);
  });
});
