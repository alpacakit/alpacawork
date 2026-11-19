import { questionRow } from './fixture/list-rows.ts';
import { commandPost } from "./command-post.ts";
import type { Locator, Page } from '@playwright/test';
import { test, expect, open, settleMotion, keepShot } from './fixtures.ts';
import { patchTask } from './fixture/task-state.ts';
import { seedReviewRun } from './fixture-writes.ts';
import type { Runtime } from './server.ts';

test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => questionRow(root, 'T112')); }, hasTouch: true });
test.describe.configure({ timeout: 60_000 });

test.beforeEach(async ({ page }) => {
  // Observe receipt on the real SSE connection without changing its response.
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]) === '/api/events' && response.ok) {
        const reader = response.clone().body!.getReader();
        void (async () => {
          const decoder = new TextDecoder();
          let pending = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            pending += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = pending.indexOf('\n\n')) >= 0) {
              const frame = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const rev = /^id: .*:(\d+)$/m.exec(frame)?.[1];
              if (rev) Object.assign(window, { receivedFeedRev: Number(rev) });
            }
          }
        })().catch(() => {}); // Page teardown closes its stream.
      }
      return response;
    };
  });
});

async function watchInput(field: Locator) {
  await field.evaluate(element => {
    const input = element as HTMLInputElement;
    input.setSelectionRange(2, 5);
    const observation = { element, removed: 0, blur: 0 };
    element.addEventListener('blur', () => observation.blur++);
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes)
        if (node === element || node.contains(element)) observation.removed++;
    }).observe(document.body, { childList: true, subtree: true });
    Object.assign(window, { inputObservation: observation });
  });
}

async function expectInputKept(page: Page, field: Locator, value: string) {
  await settleMotion(page);
  expect(await field.evaluate(element => {
    const observation = (window as unknown as { inputObservation: { element: Element; removed: number; blur: number } }).inputObservation;
    const input = element as HTMLInputElement;
    return { same: element === observation.element, removed: observation.removed, blur: observation.blur,
      selection: [input.selectionStart, input.selectionEnd] };
  })).toEqual({ same: true, removed: 0, blur: 0, selection: [2, 5] });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(value);
}

/** Wait for receipt by this browser, then let the app commit that update. */
async function liveUpdate(page: Page, runtime: Runtime, change: () => void | Promise<void>) {
  const before = await (await page.request.get(runtime.origin + '/api/workspace/live')).json();
  await change();
  let revision = before.rev;
  await expect.poll(async () => {
    revision = (await (await page.request.get(runtime.origin + '/api/workspace/live')).json()).rev;
    return revision;
  }).toBeGreaterThan(before.rev);
  await page.waitForFunction(rev => (window as unknown as { receivedFeedRev: number }).receivedFeedRev >= rev, revision);
  await settleMotion(page);
}

/** T112 remains a child; its explicit user question supplies the row used to open these forms. */
const ROW_T112 = '?agent=1&task=T112';
// One form holds both fields (ReportInputs.tsx), and a live update reaches it the same at any width: each width runs one field.
for (const [width, name] of [[412, 'Description in History']] as const) {
  test(`report ${name} keeps focus, selection and draft across a live task update at ${width}px`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height: 846 });
    await open(page, runtime, ROW_T112);
    // The reader's state form opens with R (no state control stands in the reader).
    await page.locator('[data-read="T112"]').dispatchEvent('keydown', { key: 'r' });
    await page.locator('[data-state-choice="stop"]').tap();
    const field = page.getByRole('textbox', { name, exact: true });
    await field.tap();
    const value = 'Keep the text being entered';
    await field.fill(value);
    await expect(field).toBeFocused();
    await watchInput(field);
    const refreshed = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/task/view'
      && response.ok() && (await response.json()).values.context.endsWith('Received an update.'));
    patchTask(runtime.root, 'T112', { values: { notes: 'Received an update.' } });
    expect((await refreshed).ok()).toBe(true);
    await expectInputKept(page, field, value);
    await liveUpdate(page, runtime, () => patchTask(runtime.root, 'T114', { values: { notes: 'Another task update' } }));
    await expectInputKept(page, field, value);
    // An agent view page reports no activity, so the person starts away: coming back is the presence change.
    await liveUpdate(page, runtime, async () => {
      expect((await commandPost(page.request, runtime.origin + '/api/presence', {
        data: { screen: 'person', seq: 1, touchSeq: 1, touchedAgo: 0, hiddenAgo: null },
      })).ok()).toBe(true);
    });
    await expectInputKept(page, field, value);
    const index = await (await page.request.get(runtime.origin + '/api/workspace/live')).json();
    const placement = index.placements.find((each: { taskId: string; responsible: boolean }) => each.taskId === 'T112' && each.responsible);
    const task = index.tasks.find((each: { id: string }) => each.id === 'T112');
    await liveUpdate(page, runtime, () => { seedReviewRun(runtime.root, 'T112', placement.id, task.hash); });
    await expectInputKept(page, field, value);
    await keepShot(page, `focus-refresh-${width}-${name}`);
    await page.keyboard.insertText('More');
    await expect(field).toHaveValue(value.slice(0, 2) + 'More' + value.slice(5));
  });
}
