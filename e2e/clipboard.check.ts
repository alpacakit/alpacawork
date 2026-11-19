import { labelLayer } from './editor-surface.ts';
import { coordinatorMessage, coordinatorCompleted } from './coordinator-completion.ts';
import type { Runtime } from './server.ts';
import { test, expect, open, keepShot, settleMotion, openCoordinator } from './fixtures.ts';
import { formatTask } from '../apps/web/src/features/coordinator/editor/wire.ts';
import { configureCoordinator } from './coordinator-fixture.ts';
import type { Locator, Page } from '@playwright/test';

/*
 * A sent message held long is copied, with its tasks and skills as references: text/plain is Markdown (a task
 * a link to its screen), text/html the same marked; pasted into the input they are labels again, as known here. The
 * input's own copy and cut put the same; a pasted link to another server's task is its words. A hold that scrolls, or
 * a press let go sooner, copies nothing, and the press it ends in opens nothing under it.
 */
const card = (page: Page) => page.locator('[data-coordinator-card], [data-coordinator-panel]');
const field = (page: Page) => page.locator('[data-one-input]');
// Await the real coordinator reply before timing the clipboard gestures.
const answered = (surface: Locator) => expect(surface.locator('[data-ask-answer]')).toHaveCount(1, { timeout: 30_000 });
test.use({ isolated: true });
test.describe.configure({ timeout: 120_000 });

/** Clipboard interactions use a completed exchange; agent execution has its own bounded readiness budget. */
async function sendCompleted(page: Page, runtime: Runtime) {
  const sent = coordinatorMessage(page);
  await card(page).locator('[data-ask-send]').click();
  await coordinatorCompleted(page, runtime, await sent);
}

const clipboard = (page: Page) => page.evaluate(async () => {
  const [item] = await navigator.clipboard.read();
  const read = async (type: string) => item!.types.includes(type) ? await (await item!.getType(type)).text() : null;
  return { types: [...item!.types], plain: await read('text/plain'), html: await read('text/html') };
});
const sentinel = (page: Page) => page.evaluate(() => navigator.clipboard.writeText('sentinel'));

for (const phone of [false]) test.describe(phone ? 'phone' : 'pc', () => {
  if (phone) test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
  else test.use({ viewport: { width: 1440, height: 900 } });
  const size = phone ? 'phone' : 'pc';

  test(`a sent message held long copies its references, and pasted into the input they are labels again (${size})`, async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: runtime.origin });
    await page.route('**/api/coordinator/skills?*', route => route.fulfill({ json: { status: 'ready', profile: 'fake',
      skills: [{ name: 'letmesketch', description: 'Think in pictures', invocation: '/' }] } }));
    await open(page, runtime, '?agent=1&task=T111');
    await openCoordinator(page);
    const index = await (await page.request.get(runtime.origin + '/api/workspace/live')).json();
    const title = (id: string) => index.tasks.find((task: any) => task.id === id).title as string;
    await field(page).fill(`${formatTask('T112', title('T112'))} Open the sample\nLine 2 /letmesketch`);
    await sendCompleted(page, runtime);
    await expect(card(page).locator('[data-ask-answer]')).toHaveCount(1);
    await settleMotion(page);
    const sent = card(page).locator('[data-sent-message]').first();
    await expect(sent.locator('[data-label=task]')).toHaveCount(1);
    await expect(sent.locator('[data-label=skill]')).toHaveCount(1);
    const chip = sent.locator('[data-label=task]');
    // In the middle of the conversation, clear of its sticky head: the presses below are on the label itself.
    await chip.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await settleMotion(page);
    const box = (await chip.boundingBox())!;
    let at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await chip.evaluate((element, { x, y }) => element.contains(document.elementFromPoint(x, y)), at)).toBe(true);
    const cdp = phone ? await page.context().newCDPSession(page) : null;
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = at.x, y = at.y) =>
      cdp!.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    /** Holds the pointer on the task's label for `ms`, moving it by `move` px first. */
    const hold = async (ms: number, move = 0) => {
      if (phone) { await touch('touchStart'); if (move) await touch('touchMove', at.x, at.y + move); await page.waitForTimeout(ms); await touch('touchEnd'); }
      else { await page.mouse.move(at.x, at.y); await page.mouse.down(); if (move) await page.mouse.move(at.x, at.y + move); await page.waitForTimeout(ms); await page.mouse.up(); }
    };
    const shown = () => new URL(page.url()).searchParams.get('task');
    const before = shown();

    // Moved like a scroll while held: nothing is copied, and nothing opens.
    await sentinel(page);
    await hold(700, 30);
    await page.waitForTimeout(200);
    expect((await clipboard(page)).plain).toBe('sentinel');
    expect(shown()).toBe(before);

    // Held long but let go just off the message (within a finger's wander): nothing is copied.
    const words = (await sent.boundingBox())!;
    const edge = { x: words.x + words.width - 6, y: words.y + words.height - 2 };
    if (phone) { await touch('touchStart', edge.x, edge.y); await page.waitForTimeout(650); await touch('touchMove', edge.x, edge.y + 7); await touch('touchEnd'); }
    else { await page.mouse.move(edge.x, edge.y); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.move(edge.x, edge.y + 7); await page.mouse.up(); }
    await page.waitForTimeout(200);
    expect((await clipboard(page)).plain).toBe('sentinel');

    // A move down from the top of a conversation that does not scroll sizes it as its grip does: aim again.
    await settleMotion(page);
    const moved = (await chip.boundingBox())!;
    at = { x: moved.x + moved.width / 2, y: moved.y + moved.height / 2 };
    // Held long: drawn held, then copied at the release, and the press opened nothing.
    if (phone) { await touch('touchStart'); } else { await page.mouse.move(at.x, at.y); await page.mouse.down(); }
    await page.waitForTimeout(650);
    await expect(card(page).locator('[data-held]').first()).toBeVisible();
    await keepShot(page, `held-${size}`);
    if (phone) await touch('touchEnd'); else await page.mouse.up();
    await expect(page.getByText('Copied')).toBeVisible();
    await keepShot(page, `copied-${size}`);
    expect(shown()).toBe(before);
    const link = `${runtime.origin}/?task=T112`;
    const copied = await clipboard(page);
    expect(copied.types.sort()).toEqual(['text/html', 'text/plain']);
    expect(copied.plain).toBe(`[T112 ${title('T112')}](${link}) Open the sample\nLine 2 /letmesketch`);
    expect(copied.html).toContain(`data-alpacawork="task"`);
    expect(copied.html).toContain(`<span data-alpacawork="skill">/letmesketch</span>`);

    // Touch differs in how a copy is made, above and in the last step; what a paste makes has no branch by device.
    if (!phone) {
      // Pasted into the input: the task and the skill are labels again, in their order, with the words and the line.
      await field(page).click();
      await page.keyboard.press('ControlOrMeta+V');
      await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(1);
      await expect(labelLayer(field(page)).locator('[data-label=skill]')).toHaveCount(1);
      await expect(field(page).locator('p')).toHaveCount(2);
      expect(await field(page).evaluate(node => [...node.querySelectorAll('p')].map(p => [...p.childNodes].map(child =>
        child instanceof HTMLElement && child.dataset.labelSlot ? `<${child.dataset.labelSlot.replace(/Label$/, '')}>` : child.textContent).join('')))).toEqual(['<task> Open the sample', 'Line 2 <skill>']);
      await keepShot(page, `pasted-${size}`);

      // The input's own copy and cut put the same references; pasted back they are labels again.
      await field(page).press('ControlOrMeta+A');
      await field(page).press('ControlOrMeta+X');
      await expect(labelLayer(field(page)).locator('[data-label]')).toHaveCount(0);
      expect((await clipboard(page)).plain).toBe(`[T112 ${title('T112')}](${link}) Open the sample\nLine 2 /letmesketch`);
      await page.keyboard.press('ControlOrMeta+V');
      await expect(labelLayer(field(page)).locator('[data-label=task]')).toHaveCount(1);
      await expect(labelLayer(field(page)).locator('[data-label=skill]')).toHaveCount(1);

      // Another server's task and an unavailable skill stay words. Every local Task ID is a label by format,
      // including an unknown ID; only a title read here is used, whatever the clipboard named it.
      await field(page).press('ControlOrMeta+A'); await field(page).press('Delete');
      await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob(['x'], { type: 'text/plain' }),
        'text/html': new Blob(['<a href="https://other.example/?task=T112" data-alpacawork="task">T112 Elsewhere</a> '
          + `<a href="${location.origin}/?task=T9999" data-alpacawork="task">T9999 Missing</a> <span data-alpacawork="skill">/unknown</span><img src=x onerror="window.pwned=1">`
          + ` <a href="${location.origin}/?task=T111" data-alpacawork="task">T111 False title</a>`], { type: 'text/html' }),
      })]));
      await field(page).click();
      await page.keyboard.press('ControlOrMeta+V');
      const pastedTasks = labelLayer(field(page)).locator('[data-label=task]');
      await expect(pastedTasks).toHaveCount(2);
      await expect(pastedTasks.nth(0)).toHaveText('T9999');
      await expect(pastedTasks.nth(1)).toContainText(title('T111'));
      await expect(field(page)).not.toContainText('False title');
      await expect(field(page)).not.toContainText('Missing');
      await expect(field(page)).toContainText('T112 Elsewhere');
      await expect(field(page)).toContainText('/unknown');
      expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
      await keepShot(page, `pasted-local-ids-${size}`);
      await field(page).press('ControlOrMeta+A'); await field(page).press('Delete');
    }

    // A press on the label that is let go sooner copies nothing. A finger's shows its card, whose Open opens it;
    // a mouse's opens it.
    await sentinel(page);
    await hold(250);
    if (phone) {
      const cardOpen = page.locator('[data-badge-card] [data-task-card-open]');
      await expect(cardOpen).toBeVisible();
      expect(shown()).toBe(before);
      await cardOpen.tap();
    }
    await expect.poll(shown).toBe('T112');
    expect((await clipboard(page)).plain).toBe('sentinel');
  });
});
