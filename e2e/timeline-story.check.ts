import { commandPost } from './command-post.ts';
import { expect, open, readOnlyTest, settleMotion, visibleReaderContentTop, keepShot, openCoordinator } from './fixtures.ts';
import { STORY, seedTimelineStories } from './fixture/timeline-story.ts';
import type { Locator, Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const test = readOnlyTest(seedTimelineStories);
const reader = (page: Page) => page.locator('aside[data-reader-mode]:visible');
const key = (task: string, id: string) => `log:${task}:${id}`;
const row = (page: Page, task: string, id: string) => reader(page).locator(`[data-report-key="${key(task, id)}"]`);

/** A question jump lands its heading at the top, its first choice in view too; unless a form held open in a phone's header
 * leaves the sheet too short for more than the heading (`choices: "below"`): the choices follow it, each pressable when
 * scrolled up to just under the header. */
async function position(page: Page, task: string, question: string, name: string, choices: "visible" | "below" = "visible") {
  const target = row(page, task, question);
  await expect(target.locator('article')).toHaveAttribute('data-report-card-open', '');
  await expect.poll(() => new URL(page.url()).searchParams.get('event')).toBe(key(task, question));
  await expect(target.locator('[data-waiting-report-actions] [role=group] button').first()).toBeAttached();
  const capture = async () => {
    const visibleTop = await visibleReaderContentTop(reader(page));
    const measured = await target.evaluate((el, top) => {
    const area = el.closest('[data-reader-content]')!.getBoundingClientRect();
    const head = el.querySelector('article > div > button[aria-expanded]')!.getBoundingClientRect();
    const choices = [...el.querySelectorAll('[data-waiting-report-actions] [role=group] button')].map(button => button.getBoundingClientRect());
    return { visibleTop: top, contentBottom: area.bottom, headingTop: head.top, headingBottom: head.bottom,
      headerHeight: el.closest('aside')!.querySelector('[data-reader-header]')!.getBoundingClientRect().height,
      headerState: el.closest('aside')!.querySelector('[data-reader-header]')!.getAttribute('data-reader-header'),
      dayBottom: (el.closest('[data-day]')!.querySelector('[data-day-head]')?.getBoundingClientRect().bottom ?? -Infinity),
      choiceVisible: [...el.querySelectorAll('[data-waiting-report-actions] [role=group] button')].map(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      }), choiceTops: choices.map(box => box.top), choiceBottoms: choices.map(box => box.bottom), width: innerWidth };
  }, visibleTop);
  if (process.env.ALPACAWORK_SHOTS) {
    mkdirSync(process.env.ALPACAWORK_SHOTS, { recursive: true });
    writeFileSync(join(process.env.ALPACAWORK_SHOTS, `${name}.json`), JSON.stringify(measured, null, 2));
  }
  await keepShot(page, name);
    return measured;
  };
  try {
  await expect.poll(async () => {
    const top = await visibleReaderContentTop(reader(page));
    return target.evaluate((el, top) => Math.abs(el.querySelector('article > div > button[aria-expanded]')!.getBoundingClientRect().top
      - Math.max(top, (el.closest('[data-day]')!.querySelector('[data-day-head]')?.getBoundingClientRect().bottom ?? -Infinity))), top);
  }).toBeLessThan(1.5);
  await settleMotion(page, reader(page));
  } catch (error) { await capture(); throw error; }
    const measured = await capture();
  expect(measured.headingTop).toBeGreaterThanOrEqual(measured.visibleTop - 1);
  // The date band, over a day before today, is the only header over the reports; no previous report is left in its gap.
  expect(Math.abs(measured.headingTop - Math.max(measured.visibleTop, measured.dayBottom))).toBeLessThan(1.5);
  expect(measured.choiceTops.length).toBeGreaterThan(0);
  if (choices === "below") {
    expect(measured.choiceTops[0]).toBeGreaterThan(measured.headingBottom);
    for (const choice of await target.locator('[data-waiting-report-actions] [role=group] button').all()) {
      await choice.evaluate((button, top) => {
        button.closest('[data-reader-content]')!.scrollTop += button.getBoundingClientRect().top - top - 16;
      }, await visibleReaderContentTop(reader(page)));
      await expect.poll(() => choice.evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      })).toBe(true);
    }
    return measured;
  }
  expect(measured.choiceTops[0]).toBeLessThan(measured.contentBottom - 20);
  expect(measured.choiceVisible[0]).toBe(true);
  return measured;
}

async function reachChoices(target: Locator) {
  // Choice evidence can extend below a phone's viewport. Every choice must remain reachable.
  const choices = target.locator('[data-waiting-report-actions] [role=group] button');
  for (const choice of await choices.all()) {
    await choice.evaluate(button => button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    await expect.poll(() => choice.evaluate(button => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    })).toBe(true);
  }
}

for (const [name, width, height] of [['pc', 1440, 1000]] as ['pc' | 'sp390' | 'sp320', number, number][]) {
  test.describe(name, () => {
    test.use({ viewport: { width, height }, isMobile: width < 700, hasTouch: width < 700 });
    // 320px is the sheet's tightest room and also takes the 360px narrowings, so it stands for the phone here. 390px keeps
    // what only its room allows, the first choice in view under a held form, below.
    if (name !== 'sp390') test('one question goes directly to its real choices with its heading above the answer controls', async ({ page, runtime }) => {
      await open(page, runtime, `?task=${STORY.single}&agent=1`);
      const bar = reader(page).locator('[data-questions-bar]');
      await expect(bar).toContainText('Question for you · 1');
      const history = await (await page.request.get(`${runtime.origin}/api/task/history?task=${STORY.single}&children=1&limit=80`)).json();
      expect(history.events.some((event: { id: string }) => event.id === STORY.singleQuestion)).toBe(false);
      await bar.locator('button').click();
      await position(page, STORY.single, STORY.singleQuestion, `timeline-story-${name}-single`);
      await expect(row(page, STORY.single, STORY.singleQuestion).locator('[data-question-number]')).toHaveText('Question 1/1');
      await reachChoices(row(page, STORY.single, STORY.singleQuestion));
      // Selecting an answer keeps the same source question identity in the existing input.
      await row(page, STORY.single, STORY.singleQuestion).getByRole('button', { name: 'A Option A', exact: true }).click();
      await expect(row(page, STORY.single, STORY.singleQuestion).getByRole('button', { name: 'A Option A', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await openCoordinator(page);
      await expect(page.locator(`[data-label="answer"][data-answer-task="${STORY.single}"][data-answer-question="${STORY.singleQuestion}"]`)).toHaveAttribute('data-answer-answer', '1-A');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const settings = await (await page.request.get(`${runtime.origin}/api/settings/get`)).json();
      const saved = await commandPost(page.request, `${runtime.origin}/api/settings/set`, {
        data: { key: 'language', value: 'ja', expectedRevision: settings.revision, timeZone: 'Asia/Tokyo' },
      });
      expect(saved.ok()).toBe(true);
      try {
        await open(page, runtime, `?task=${STORY.single}&agent=1&event=${encodeURIComponent(key(STORY.single, STORY.singleQuestion))}`);
        await reader(page).locator('[data-questions-bar] button').click();
        await position(page, STORY.single, STORY.singleQuestion, `timeline-story-${name}-ja-position`);
        await expect(row(page, STORY.single, STORY.singleQuestion).locator('[data-question-number]')).toHaveText('問 1/1');
        await expect(row(page, STORY.single, STORY.singleQuestion).locator('[data-question-number]')).toBeInViewport();
        await settleMotion(page, reader(page));
        await keepShot(page, `timeline-story-${name}-ja-question-heading`);
      } finally {
        const current = await (await page.request.get(`${runtime.origin}/api/settings/get`)).json();
        const restored = await commandPost(page.request, `${runtime.origin}/api/settings/set`, {
          data: { key: 'language', value: 'en', expectedRevision: current.revision, timeZone: 'Asia/Tokyo' },
        });
        expect(restored.ok()).toBe(true);
      }
    });
  });
}

// Each closure race owns its workspace; no test mutates the read-only layouts or any production task.
import { test as baseTest } from './fixtures.ts';
import { start } from './server.ts';
import { patchTask } from './fixture/task-state.ts';
const lifecycle = baseTest.extend({
  runtime: async ({}, use) => {
    const runtime = await start(undefined, seedTimelineStories);
    try { await use(runtime); } finally { await runtime.stop(); }
  },
});
for (const width of [1440]) {
  lifecycle.describe(`question lifecycle ${width}px`, () => {
    lifecycle.use({ viewport: { width, height: 844 }, isMobile: width < 700, hasTouch: width < 700 });
    // Closing a question while its page loads is the same read at any width and for either closing kind: one is run.
    for (const kind of ['question_withdrawn'] as ('answered' | 'question_withdrawn')[]) lifecycle(`${kind} while the old page is loading removes the bar and the old choices without a wrong jump`, async ({ page, runtime }) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let waiting = false;
      await page.route('**/api/task/history?**', async route => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('task') === STORY.single && url.searchParams.has('before')) { waiting = true; await gate; }
        await route.continue();
      });
      await open(page, runtime, `?task=${STORY.single}&agent=1`);
      await reader(page).locator('[data-questions-bar] button').click();
      await expect.poll(() => waiting).toBe(true);
      patchTask(runtime.root, STORY.single, { logs: [{ id: `L-story-${kind}`, kind, at: '2026-09-25T05:20:00Z',
        title: kind === 'answered' ? 'Choose A' : 'Question withdrawn', description: 'Closed while navigating', actor: { kind: 'human' },
        questionId: STORY.singleQuestion, fromState: null, toState: null }], ...(kind === 'answered' ? { texts: { [`L-story-${kind}`]: 'A' } } : {}) });
      await expect.poll(async () => (await (await page.request.get(`${runtime.origin}/api/task/view?task=${STORY.single}`)).json()).userQuestions.length).toBe(0);
      release();
      await expect(reader(page).locator('[data-questions-bar]')).toHaveCount(0);
      await expect.poll(() => new URL(page.url()).searchParams.get('event')).toBe(key(STORY.single, STORY.singleQuestion));
      const target = row(page, STORY.single, STORY.singleQuestion);
      await expect(target.locator('[data-waiting-report-actions]')).toHaveCount(0);
      await expect(target.locator('[data-rail-time] svg').first()).toHaveClass(/text-muted/);
      await keepShot(page, `timeline-story-${width}-${kind}`);
    });
    if (width === 390) lifecycle('a held question retains its entry and choices in grey through reload', async ({ page, runtime }) => {
      patchTask(runtime.root, STORY.single, { state: 'held' });
      await open(page, runtime, `?task=${STORY.single}&agent=1`);
      await expect(reader(page)).toHaveAttribute('data-held', 'true');
      await reader(page).locator('[data-questions-bar] button').click();
      await position(page, STORY.single, STORY.singleQuestion, `timeline-story-${width}-held`);
      await reachChoices(row(page, STORY.single, STORY.singleQuestion));
      // Hold's common theme owns the grey, while the question still belongs to the user's turn.
      await page.mouse.move(0, 0);
      expect(await row(page, STORY.single, STORY.singleQuestion).locator('[data-rail-time]').evaluate(time =>
        getComputedStyle(time.querySelector('svg')!).color === getComputedStyle(time).color)).toBe(true);
      await page.reload();
      await expect(reader(page)).toHaveAttribute('data-held', 'true');
      await expect(row(page, STORY.single, STORY.singleQuestion).locator('article')).toHaveAttribute('data-report-card-open', '');
      await expect(row(page, STORY.single, STORY.singleQuestion).locator('[data-waiting-report-actions]')).toBeVisible();
    });
  });
}
