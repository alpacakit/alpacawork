import { projectRows, questionRow } from './fixture/list-rows.ts';
import { labelLayer } from './editor-surface.ts';
import { test, expect, open, keepShot, settleMotion, writeCoordinator } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { commandPost } from './command-post.ts';

// Navigation mixes top rows with a genuine child whose explicit user question exposes its row.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => { questionRow(root, 'T112'); projectRows(root, ['T114', 'T117']); }); } });

const reader = (page: Page) => page.locator('aside[data-reader-mode]:visible');
const head = (page: Page) => reader(page).locator('[data-reader-head-row]');
const ids = (page: Page) => page.locator('[data-row]').evaluateAll(rows => [...new Set(rows.map(row => row.getAttribute('data-row')!))]);
const shown = async (page: Page, id: string) => {
  await expect(head(page).locator('[data-reader-task-id]')).toHaveText(id);
  await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(id);
  await settleMotion(page);
};
const previous = (page: Page) => head(page).locator('[data-list-previous]');
const next = (page: Page) => head(page).locator('[data-list-next]');
// Overlap checks alone missed a repeated press moving to another line.
const stepBoxes = async (page: Page) => ({ previous: await previous(page).boundingBox(), next: await next(page).boundingBox() });

async function fits(page: Page, width: number) {
  const controls = head(page).locator('[data-reader-back], [data-reader-task-id], [data-reader-task-id] + button, [data-list-pager] button, [data-reader-frame-buttons] button');
  const boxes = await controls.evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }));
  for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
  for (let i = 0; i < boxes.length; i++) for (const other of boxes.slice(i + 1)) {
    const box = boxes[i]!;
    expect(Math.min(box.right, other.right) - Math.max(box.x, other.x) > 1 && Math.min(box.bottom, other.bottom) - Math.max(box.y, other.y) > 1, 'header controls do not overlap').toBe(false);
  }
  // An element can fit its path and viewport while an outer row clips its text.
  // Measure the text itself and every clipping ancestor, rather than the element's padded box.
  const ink = await head(page).locator('[data-reader-task-id]').evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const text = [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    const clips = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), r = ancestor.getBoundingClientRect();
      const x = /^(clip|hidden|auto|scroll)$/.test(style.overflowX);
      const y = /^(clip|hidden|auto|scroll)$/.test(style.overflowY);
      if (x || y) clips.push({ name: ancestor.outerHTML.split('>')[0], x, y,
        left: r.left + ancestor.clientLeft, right: r.left + ancestor.clientLeft + ancestor.clientWidth,
        top: r.top + ancestor.clientTop, bottom: r.top + ancestor.clientTop + ancestor.clientHeight });
    }
    return { text, clips };
  });
  expect(ink.text.length).toBeGreaterThan(0);
  for (const clip of ink.clips) for (const text of ink.text) {
    if (clip.x) {
      expect(text.left, `ID text left inside ${clip.name}`).toBeGreaterThanOrEqual(clip.left - 0.5);
      expect(text.right, `ID text right inside ${clip.name}`).toBeLessThanOrEqual(clip.right + 0.5);
    }
    if (clip.y) {
      expect(text.top, `ID text top inside ${clip.name}`).toBeGreaterThanOrEqual(clip.top - 0.5);
      expect(text.bottom, `ID text bottom inside ${clip.name}`).toBeLessThanOrEqual(clip.bottom + 0.5);
    }
  }
  const grow = boxes.at(-2)!;
  for (const button of [previous(page), next(page)]) {
    expect(await button.evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })))
      .toEqual({ width: grow.width, height: grow.height });
  }
}

async function keepHeaderShot(page: Page, name: string) {
  await keepShot(page, name);
  const shots = process.env.ALPACAWORK_SHOTS;
  if (shots) await head(page).screenshot({ path: join(shots, `${name}-header.png`) });
}

async function language(page: Page, origin: string, lang: 'en' | 'ja') {
  const { revision } = await (await page.request.get(origin + '/api/settings/get')).json();
  const response = await commandPost(page.request, origin + '/api/settings/set', {
    data: { key: 'language', value: lang, expectedRevision: revision },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

// The head's own branches are widths (ReaderHeader.tsx: its container at 20rem, 24rem, 480 and 600; narrow at 700). The language has
// none: it changes Back's word and the names, so each width runs once, and Japanese stands at 412, where its word is drawn.
for (const [lang, width] of [['en', 1440]] as ['en' | 'ja', number][]) test.describe(`detail list steps ${lang} ${width}px`, () => {
  test.use({ locale: lang === 'ja' ? 'ja-JP' : 'en-US', viewport: { width, height: 900 }, isMobile: width < 700, hasTouch: width < 700 });
  test('drawn order, child rows, continuous steps, boundaries, Back/Forward, reload and header geometry', async ({ page, runtime }) => {
    await language(page, runtime.origin, lang);
    await open(page, runtime, '?agent=1&task=T112');
    // Snapshot the requested flat rows after the source task is drawn.
    await expect(page.locator('[data-row="T112"]')).toBeAttached();
    const order = await ids(page);
    expect(order).toContain('T11'); expect(order).toContain('T112');
    expect(order.indexOf('T112')).toBeGreaterThan(0);
    await shown(page, 'T112'); await fits(page, width);
    await expect(previous(page)).toHaveAccessibleName(lang === 'ja' ? '前のタスク' : 'Previous task');
    const separators = head(page).locator('[data-reader-path-separator]:visible');
    if (await separators.count()) {
      const separator = separators.last(), mark = (await separator.boundingBox())!;
      const ancestor = (await separator.locator('..').getByRole('button').first().boundingBox())!;
      const id = (await head(page).locator('[data-reader-task-id]').boundingBox())!;
      const left = mark.x - ancestor.x - ancestor.width, right = id.x - mark.x - mark.width;
      expect(left).toBeGreaterThanOrEqual(4);
      expect(Math.abs(left - right), 'breadcrumb separator has equal space on each side').toBeLessThanOrEqual(0.5);
      // Where an ancestor is only its ID, the same between what is read, not only the boxes, and a finger keeps its 44px.
      if (width < 700) {
        const step = await separator.locator('..').getByRole('button').first().evaluate(button => {
          const range = document.createRange(); range.selectNodeContents(button);
          const box = button.getBoundingClientRect(), y = (box.top + box.bottom) / 2;
          let press = 0;
          for (let x = box.left - 40; x <= box.right + 60; x += 0.5) {
            const found = document.elementFromPoint(x, y);
            if (found && (found === button || button.contains(found))) press += 0.5;
          }
          return { text: range.getBoundingClientRect().right, press };
        });
        expect(Math.abs(mark.x - step.text - right), 'an ancestor reads as far from the separator as the next ID').toBeLessThanOrEqual(0.5);
        expect(step.press, 'what a finger reaches on an ancestor').toBeGreaterThanOrEqual(44);
      }
    }
    const stationary = await stepBoxes(page);
    const headHeight = (await head(page).boundingBox())!.height;
    await expect(head(page).locator('[data-reader-back]')).toHaveCount(0);
    await keepShot(page, `detail-${lang}-${width}-before`);
    const to = order[order.indexOf('T112') - 1]!;
    await previous(page).click(); await shown(page, to); await fits(page, width);
    const back = head(page).locator('[data-reader-back]');
    await expect(back).toBeVisible();
    await expect(back).toHaveAccessibleName(lang === 'ja' ? '戻る' : 'Back');
    if (width === 320) await expect(back.locator('span')).toBeHidden();
    else await expect(back.locator('span')).toBeVisible();
    expect(await stepBoxes(page)).toEqual(stationary);
    expect((await head(page).boundingBox())!.height).toBe(headHeight);
    await keepShot(page, `detail-${lang}-${width}-after`);
    if (width < 700) await keepHeaderShot(page, `review3-${lang}-${width}-back`);
    // A sideways trackpad swipe over the reader is the browser's Back.
    const reading = (await reader(page).locator('[data-reader-content]').boundingBox())!;
    await page.mouse.move(reading.x + reading.width / 2, reading.y + reading.height / 2);
    for (let step = 0; step < 6; step++) await page.mouse.wheel(-40, 0);
    await shown(page, 'T112');
    await page.goForward(); await shown(page, to);
    await page.reload(); await shown(page, to);
    // Every displayed child follows its predecessor, with no task-number sort or wrap.
    let at = order.indexOf(to);
    while (at > 0) { await previous(page).click(); await shown(page, order[--at]!); }
    await expect(previous(page)).toBeDisabled();
    await next(page).click(); await shown(page, order[1]!);
    await keepShot(page, `detail-${lang}-${width}-child`);
    at = 1;
    while (at < order.length - 1) { await next(page).click(); await shown(page, order[++at]!); }
    await expect(next(page)).toBeDisabled(); await fits(page, width);
    await keepShot(page, `detail-${lang}-${width}-last`);
    if (width < 700) {
      await head(page).locator('[data-reader-grow]').click(); await settleMotion(page);
      await expect(page.locator('[data-sheet]')).toHaveAttribute('data-whole', 'true');
      await fits(page, width);
      await previous(page).click(); await shown(page, order[order.length - 2]!);
      await expect(page.locator('[data-sheet]')).toHaveAttribute('data-whole', 'true');
    }
  });
});

test.use({ isolated: true });

test('viewing steps preserve the explicit task/answer draft and reply metadata without sending anything', async ({ page, runtime }) => {
  const conversation = (await (await page.request.get(`${runtime.origin}/api/coordinator`)).json()).conversation;
  await page.addInitScript(({ root, conversationId }) => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'taskLabel', attrs: { id: 'T111', title: 'Explicit task', auto: false } },
      { type: 'answerLabel', attrs: { task: 'T111', question: 'Ldraft', n: '1', name: 'Keep this choice', answer: 'Option1' } },
      { type: 'text', text: ' Keep this unsent message.' },
    ] }] };
    sessionStorage.setItem('alpacawork-input-drafts-v10', JSON.stringify({ version: 6, entries: {
      [JSON.stringify([root, 'coordinator', conversationId])]: { status: 'editing', values: {
        doc: JSON.stringify(doc), requestId: 'retained-request', context: 'T112', replyTo: 'retained-reply',
      } },
    } }));
  }, { root: runtime.root, conversationId: conversation.id });
  const writes: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && /\/api\/(?:coordinator\/messages|task\/(?:report|request|update))/.test(request.url())) writes.push(request.url()); });
  await open(page, runtime, '?agent=1&task=T112');
  await writeCoordinator(page);
  const field = page.locator('[data-one-input]');
  await expect(field).toContainText('Keep this unsent message.');
  const kept = async () => page.evaluate(() => {
    const entries = JSON.parse(sessionStorage.getItem('alpacawork-input-drafts-v10')!).entries;
    const values = (Object.values(entries) as { values: Record<string, string> }[]).find(entry => entry.values.requestId === 'retained-request')!.values;
    const doc = JSON.parse(values.doc!);
    // The automatic viewing badge may be replaced; explicit content must survive unchanged.
    const content = doc.content.flatMap((block: { content?: any[] }) => block.content ?? []).filter((node: any) => !node.attrs?.auto);
    return { content, replyTo: values.replyTo, requestId: values.requestId };
  });
  const before = await kept();
  await previous(page).click();
  await expect(head(page).locator('[data-reader-task-id]')).not.toHaveText('T112');
  await next(page).click(); await shown(page, 'T112');
  expect(await kept()).toEqual(before);
  expect(writes).toEqual([]);
  // On a computer a step press takes the coordinator down no more than any other press: read once the steps'
  // motion is over, the input is still up with what is in it, and nothing has to bring it up again.
  await settleMotion(page);
  await expect(field).toBeVisible();
  await expect(page.locator('[data-coordinator-write]')).toHaveCount(0);
  await expect(field).toContainText('Keep this unsent message.');
  await expect(labelLayer(field).locator('[data-label="task"]:not([data-auto])')).toContainText('T111');
  await expect(labelLayer(field).locator('[data-label="answer"]')).toHaveAttribute('data-answer-question', 'Ldraft');
  await expect(labelLayer(field).locator('[data-label="answer"]')).toHaveAttribute('data-answer-answer', 'Option1');
  await keepShot(page, 'detail-draft-preserved');
});
