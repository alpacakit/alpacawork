import { reloadWithoutReadCheckpoint } from './read-fixture.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { TaskHistoryDTO } from '@alpacawork/contract/control';
import { startServer } from './fixture/server.ts';
import { test as base, expect, openReference, settleMotion } from './fixtures.ts';
import { historyReferenceId, seedHistoryRequest } from './fixture/history-request.ts';
import { patchTask, taskFolder } from './fixture/task-state.ts';
import { failureJson, withFixtureCleanup } from './fixture-cleanup.ts';

// The current-baseline fixture uses a fictional focal Request to reproduce reading-position failures.
// The ordinary auto failure fixture retains the live API/DB/FS before this runtime is stopped.
// The shared stage allocator owns temporary storage selection.
const test = base.extend<{ supplements: number; navigationFixture: boolean }>({
  supplements: [85, { option: true }],
  navigationFixture: [false, { option: true }],
  fixedTime: false,
  runtime: async ({ supplements, navigationFixture, context }, use, info) => {
    const root = mkdtempSync(join(tmpdir(), 'alpacawork-history-position-'));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    const completed: string[] = [];
    await withFixtureCleanup(async () => {
      seedHistoryRequest(root, supplements);
      if (navigationFixture) {
        // Files and their History link belong to the fixture before serve's first projection, as in reader-back.
        writeFileSync(join(taskFolder(root, 'T9001'), 'navigation.md'), '# A different reading pane');
        patchTask(root, 'T9001', { logs: [{ id: 'navigation-target', kind: 'reported', at: '2001-02-04T00:00:00Z',
          title: 'Navigation target', description: `Read ${historyReferenceId}. [Open navigation file](/api/tasks/T9001/file?path=navigation.md)`,
          actor: { kind: 'human' }, fromState: null, toState: null }] });
      }
      server = await startServer(root, 0);
      // This historical corpus includes a queued synthetic Run. Measure a stable history only after the inert
      // executable's completion is published; its legitimate startup updates otherwise invalidate page reads.
      await expect.poll(async () => {
        const response = await fetch(new URL('/api/workspace/live', server!.url));
        const index = await response.json();
        return index.runs.find((run: { id: string }) => run.id === 'R9002')?.state;
      }, { timeout: 20_000 }).toBe('failed');
      writeFileSync(info.outputPath('runtime.json'), JSON.stringify({ pid: process.pid, root, url: server.url,
        started: new Date().toISOString(), deadline: new Date(Date.now() + info.timeout).toISOString() }));
      await use({ root, origin: new URL(server.url).origin });
    }, [
      // Runtime tears down before the base page/context fixtures. End their requests and socket pools
      // before waiting for this in-process HTTP server; otherwise a live client can keep close pending.
      { name: 'client-close', run: async () => { await context.close(); completed.push('client-close'); } },
      { name: 'server-close', run: async () => {
        await server?.close(); completed.push('server-close');
        rmSync(root, { recursive: true, force: true }); completed.push('remove-root');
      } },
    ], failures => writeFileSync(info.outputPath('runtime-teardown.json'), JSON.stringify({
      originalTestErrors: info.errors, completed, failures: failures.map(each => ({ stage: each.stage, error: failureJson(each.error) })),
    })));
  },
});
test.use({ locale: 'ja-JP', colorScheme: 'dark' });
const id = 'synthetic-catalog-review-01';
const key = `request:${id}`;
const target = (page: Page) => page.locator(`[data-reader-mode] [data-report-key="${key}"]`);
const area = (page: Page) => page.locator('[data-reader-mode] [data-reader-content]');
const scroll = (page: Page) => area(page).evaluate(element => element.scrollTop);
const saved = (page: Page) => page.evaluate(() => history.state?.readerPosition?.scroll);
const url = (origin: string) => `${origin}/?task=T9001&agent=1&event=${encodeURIComponent(key)}`;

async function readTarget(page: Page) {
  await expect(target(page)).toHaveCount(1);
  await expect(target(page).locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => ({ saved: await saved(page), scroll: await scroll(page) })).toMatchObject({ saved: expect.any(Number) });
  await expect.poll(async () => (await saved(page)) === (await scroll(page))).toBe(true);
  const tail = target(page).getByText('最後に確認できた内容と', { exact: false });
  await tail.scrollIntoViewIfNeeded();
  await settleMotion(page, area(page));
  // The text, not only an attached row, must actually be at the reading position.
  await expect(tail).toBeInViewport();
  await expect.poll(async () => (await saved(page)) === (await scroll(page))).toBe(true);
  return scroll(page);
}

// The phone's reload is `delayed reload ... at 390px`; this one is the undelayed path and the row still folding after it.
test('F5: the same instruction URL reloads the acquired row and read position at 1440px', async ({ page, runtime }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/task/history') requests.push(request.url()); });
  await page.goto(url(runtime.origin));
  const before = await readTarget(page);
  await page.screenshot({ path: info.outputPath('before-reload.png') });
  const first = await (await page.request.get(`${runtime.origin}/api/task/history?task=T9001&limit=80`)).json() as TaskHistoryDTO;
  expect(first.events.some(event => event.id === id)).toBe(false);
  const countBefore = requests.length;
  await reloadWithoutReadCheckpoint(page);
  await expect(target(page)).toHaveCount(1);
  await expect(target(page).locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => scroll(page)).toBe(before);
  await expect(target(page).getByText('最後に確認できた内容と', { exact: false })).toBeInViewport();
  expect(new URL(page.url()).searchParams.get('event')).toBe(key);
  expect(requests.slice(countBefore).some(request => new URL(request).searchParams.has('before'))).toBe(true);
  await page.screenshot({ path: info.outputPath('after-reload.png') });
  await target(page).locator('button[aria-expanded]').first().click();
  await expect(target(page).locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'false');
  await target(page).locator('button[aria-expanded]').first().click();
  await expect(target(page).locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
  await info.attach('history-requests', { body: JSON.stringify(requests), contentType: 'application/json' });
});

async function allEvents(page: Page, origin: string, after?: string) {
  const events: TaskHistoryDTO['events'] = [];
  let before: string | null = null, pages = 0;
  do {
    const address = new URL('/api/task/history?task=T9001&children=1&limit=80', origin);
    if (before) address.searchParams.set('before', before);
    if (after) address.searchParams.set('after', after);
    const response = await page.request.get(address.href);
    expect(response.ok()).toBe(true);
    const result = await response.json() as TaskHistoryDTO;
    events.push(...result.events); before = result.nextBefore; pages++;
  } while (before);
  return { events, pages };
}
const identity = (event: TaskHistoryDTO['events'][number]) => event.kind === 'request' ? `request:${event.id}`
  : event.kind === 'dialogue' ? `dialogue:${event.taskId}:${event.id}`
  : event.kind === 'error' && event.state === null ? `run:${event.id}:finished` : `log:${event.taskId}:${event.id}`;
async function sameOrder(page: Page, origin: string) {
  const { events, pages } = await allEvents(page, origin);
  const cursors = events.map(event => `${event.at}|${event.taskId}|${event.id}|${event.kind}`);
  expect(cursors).toEqual([...cursors].sort().reverse());
  expect(new Set(cursors).size).toBe(cursors.length);
  const shown = await page.locator('[data-reader-mode] [data-report-key]').evaluateAll(rows => rows.map(row => row.getAttribute('data-report-key')));
  expect(shown).toEqual(events.map(identity).filter(key => shown.includes(key)));
  expect(new Set(shown).size).toBe(shown.length);
  return { events, pages };
}

test.describe('history over three pages', () => {
  test.use({ supplements: 245 });

    // Back passes through a width branch in state/bootstrap.ts; the phone side is run, the docked column is left to reader-back.
    for (const width of [390]) test(`Back and Forward reacquire the reference row and retain its read position at ${width}px`, async ({ page, runtime }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      const noteKey = 'log:T9001:screen-legitimate-comment';
      await page.goto(`${runtime.origin}/?task=T9001&agent=1&event=${encodeURIComponent(noteKey)}`);
      const note = page.locator(`[data-reader-mode] [data-report-key="${noteKey}"]`);
      await expect(note.locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
      const reference = note.locator(`[data-task-reference="${historyReferenceId}"]`);
      await reference.scrollIntoViewIfNeeded();
      await settleMotion(page, area(page));
      // Save the actual press position; the initial jump is allowed to settle before the person follows the link.
      await expect.poll(async () => (await saved(page)) === (await scroll(page))).toBe(true);
      await reference.scrollIntoViewIfNeeded();
      await expect(reference).toBeInViewport();
      const before = await scroll(page);
      await openReference(reference);
      await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(historyReferenceId);
      await reloadWithoutReadCheckpoint(page); // No held History pages from T9001 remain in the new JS runtime.
      await expect(page.locator('header [data-reader-task-id]')).toHaveText(historyReferenceId);
      await page.goBack();
      await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe('T9001');
      await expect(reference).toBeVisible();
      await expect.poll(() => scroll(page)).toBe(before);
      await expect(reference).toBeInViewport();
      expect(new URL(page.url()).searchParams.get('event')).toBe(noteKey);
      await page.screenshot({ path: info.outputPath('back-reference.png') });
      await page.goForward();
      await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(historyReferenceId);
      await page.goBack();
      await expect(reference).toBeVisible();
      await expect.poll(() => scroll(page)).toBe(before);
      await expect(reference).toBeInViewport();
      await sameOrder(page, runtime.origin);
    });
});

// The final text's hit test catches a paragraph attached below the phone's reading surface.
async function tailHit(page: Page) {
  return target(page).getByText('最後に確認できた内容と', { exact: false }).evaluate(element => {
    const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let last: Text | undefined;
    while (walk.nextNode()) if (walk.currentNode.textContent?.trim()) last = walk.currentNode as Text;
    const range = document.createRange();
    range.setStart(last!, Math.max(0, last!.length - 8)); range.setEnd(last!, last!.length);
    const box = range.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { exposed: !!hit && (element === hit || element.contains(hit)), x: box.x, y: box.y };
  });
}

async function reachRetry(page: Page) {
  const retry = page.locator('[data-report-feed] [data-read-failure]').getByRole('button');
  const viewport = await area(page).boundingBox();
  await page.mouse.move(viewport!.x + viewport!.width / 2, viewport!.y + viewport!.height / 2);
  for (let step = 0; step < 60; step++) {
    const button = await retry.boundingBox();
    const x = button!.x + button!.width / 2, y = button!.y + button!.height / 2;
    if (y > viewport!.y + 20 && y < viewport!.y + viewport!.height - 20
      && await retry.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), { x, y })) {
      // Observe it stop while its saved scroll catches up, then take a fresh point; never press the earlier coordinate.
      let previous = await scroll(page), still = 0;
      await expect.poll(async () => {
        const current = await scroll(page); still = current === previous ? still + 1 : 0; previous = current;
        return still >= 3;
      }, { intervals: [50] }).toBe(true);
      const settled = await retry.boundingBox();
      const point = { x: settled!.x + settled!.width / 2, y: settled!.y + settled!.height / 2 };
      if (point.y > viewport!.y + 20 && point.y < viewport!.y + viewport!.height - 20
        && await retry.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), point)) return point;
      continue;
    }
    const before = await scroll(page);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scroll(page)).not.toBe(before);
  }
  throw new Error('Retry was not reached by real wheel input');
}

// The page count is one loop in ReportFeed's acquisition, with nothing in restoration that reads it: 245, where later pages
// keep arriving after the choice. A key on Retry after the feed's silence cap; a touch press on Retry is not run in the browser.
for (const supplements of [245]) test.describe(`F6 recovery with ${supplements} supplements`, () => {
  test.use({ supplements, hasTouch: true });
  for (const activation of ['cap-keyboard'] as const) {
    test(`${activation} Retry preserves the instruction tail and saved position at 390px`, async ({ page, runtime }, info) => {
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.clock.install();
      await page.addInitScript(() => {
        const moves: unknown[] = []; (window as any).readingMoves = moves;
        document.addEventListener('click', event => {
          if (event.target instanceof Element && event.target.closest('[data-read-failure] button')) (window as any).actualRetryActivated = true;
        }, true);
        const replace = history.replaceState;
        history.replaceState = function(state, unused, url) {
          if (state?.readerPosition) moves.push({ at: performance.now(), position: state.readerPosition,
            scroll: document.querySelector('[data-reader-content]')?.scrollTop, stack: new Error().stack });
          return replace.call(this, state, unused, url);
        };
      });
      await page.goto(url(runtime.origin));
      await readTarget(page);
      // The preparation may move the viewport; after Retry there are no test scrolls or wheel events.
      for (let attempt = 0; !(await tailHit(page)).exposed && attempt < 8; attempt++) {
        const box = await area(page).boundingBox();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
        await page.mouse.wheel(0, 140); await settleMotion(page, area(page));
      }
      await expect.poll(async () => (await tailHit(page)).exposed).toBe(true);
      await expect.poll(async () => (await saved(page)) === (await scroll(page))).toBe(true);
      const before = await scroll(page);
      expect((await allEvents(page, runtime.origin)).pages).toBe(4);
      await page.screenshot({ path: info.outputPath('before-retry.png') });
      await page.route('**/api/task/history?**', async route => {
        const older = new URL(route.request().url()).searchParams.has('before');
        // Advancing 35s also triggers feed-silence recovery. Keep its GET fault real
        // until the actual Retry activation, so automatic recovery cannot remove the button first.
        const explicit = await page.evaluate(() => !!(window as any).actualRetryActivated);
        if (older && !explicit) await route.abort('failed');
        else await route.continue();
      });
      await reloadWithoutReadCheckpoint(page);
      const failure = page.locator('[data-report-feed] [data-read-failure]');
      await expect(failure).toBeVisible(); await expect(target(page)).toHaveCount(0);
      expect(await saved(page)).toBe(before);
      const phases: unknown[] = [];
      const phase = async (name: string) => { phases.push(await page.evaluate(name => ({ name, at: Date.now(), saved: history.state?.readerPosition, scroll: document.querySelector('[data-reader-content]')?.scrollTop, ready: document.querySelector('[data-report-feed]')?.getAttribute('data-history-ready'), failure: !!document.querySelector('[data-report-feed] [data-read-failure]') }), name)); };
      const retry = failure.getByRole('button');
      await phase('before-cap'); await page.clock.fastForward(35_000); await phase('after-cap');
      await retry.focus(); await phase('after-focus'); await page.clock.runFor(250); await phase('after-focus-save-window'); expect(await saved(page)).toBe(before); await expect(failure).toBeVisible();
      await retry.press('Enter'); await phase('after-enter');
      await expect(target(page)).toHaveCount(1);
      await settleMotion(page, area(page));
      try { await expect.poll(() => saved(page)).toBe(before); }
      finally { writeFileSync(info.outputPath('restoration-writes.json'), JSON.stringify({ phases, writes: await page.evaluate(() => (window as any).readingMoves) })); }
      const after = { before, scroll: await scroll(page), saved: await saved(page), tail: await tailHit(page) };
      writeFileSync(info.outputPath('retry-position.json'), JSON.stringify(after));
      await info.attach('retry-position', { path: info.outputPath('retry-position.json'), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath('after-retry.png') });
      expect(after.tail.exposed).toBe(true);
      expect(after.scroll).toBe(before); expect(after.saved).toBe(before);
      await expect(target(page).locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
    });
  }

  test.describe('navigation across a pending Retry', () => {
    test.use({ navigationFixture: true });
    for (const destination of ['task'] as const) test(`an in-flight Retry cannot replace a different ${destination}`, async ({ page, runtime }, info) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(url(runtime.origin)); await readTarget(page);
      let failed = false, entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/task/history?**', async route => {
        if (new URL(route.request().url()).searchParams.has('before')) {
          if (!failed) { failed = true; await route.abort('failed'); return; }
          entered(); await gate;
        }
        await route.continue();
      });
      let next!: string;
      try {
        await reloadWithoutReadCheckpoint(page); await expect(page.locator('[data-read-failure]')).toBeVisible();
        const point = await reachRetry(page);
        await page.mouse.click(point.x, point.y); await waiting;
        const note = page.locator('[data-report-key="log:T9001:navigation-target"]');
        await note.locator('button[aria-expanded]').first().click();
        if (destination === 'task') {
          await openReference(note.locator(`[data-task-reference="${historyReferenceId}"]`));
          await expect(page.locator('header [data-reader-task-id]')).toHaveText(historyReferenceId);
        } else {
          await note.getByRole('link', { name: 'Open navigation file' }).click();
          await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe('navigation.md');
        }
        await settleMotion(page, area(page)); next = page.url();
      } finally { release(); }
      await expect(page.locator('[data-report-feed] [data-read-failure]')).toHaveCount(0);
      await settleMotion(page, area(page));
      expect(page.url()).toBe(next); expect(await scroll(page)).toBe(0);
      if (destination === 'task') await expect(page.locator('header [data-reader-task-id]')).toHaveText(historyReferenceId);
      else await expect(area(page)).toContainText('A different reading pane');
      writeFileSync(info.outputPath('navigation-after-retry.json'), JSON.stringify({ destination, url: page.url(), scroll: await scroll(page), saved: await saved(page) }));
    });

  });
});
