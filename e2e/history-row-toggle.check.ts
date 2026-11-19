import type { Locator, Page } from '@playwright/test';
import { test, expect, open, settleMotion } from './fixtures.ts';

/**
 * Opening and closing a History row moves nothing in its head (its time, kind, who and ⌄), whether its words stay
 * in the head (a titled report) or go to its body (an instruction says them as its body's first line); and the row only
 * grows while it opens and only shrinks while it closes, so the rows under it never jump one way and glide back. Its words
 * are drawn on every frame of the way, in the head or in the body.
 */
const head = (row: Locator) => row.locator('article > div > button[aria-expanded]');
const parts = (row: Locator) => row.evaluate(item => {
  const top = item.getBoundingClientRect().top, at = (selector: string) => {
    const part = item.querySelector(`article button[aria-expanded] ${selector}`);
    return part ? Math.round((part.getBoundingClientRect().top - top) * 10) / 10 : null;
  };
  return { time: at('time'), kind: at('[data-row-kind]'), name: at('[data-row-name]'), arrow: at('svg[data-icon="down"]') };
});
/**
 * The row's height on every frame from the press until it has settled, and whether its words are drawn on that frame:
 * in the head's line (still there, folding or growing), or in the body as far as it has unfolded (this caught a past
 * fault: an instruction opening once took its head's line away at once, and its body reached its own copy only after who it was
 * between).
 */
const frames = (page: Page, row: Locator) => row.evaluate(item => new Promise<{ heights: number[]; said: boolean[] }>(done => {
  const said = () => {
    const line = item.querySelector('[data-row-words]');
    if (line && line.getBoundingClientRect().height >= 1) return true;
    const clip = item.querySelector('[data-disclosure-body]')?.getBoundingClientRect(), copy = item.querySelector('[data-disclosure-body] p');
    return !!clip && !!copy && copy.getBoundingClientRect().bottom <= clip.bottom + 0.5;
  };
  // Its height before the press too: the press redraws the head at once, before the first frame is seen.
  const heights: number[] = [item.getBoundingClientRect().height], seen = [said()], start = performance.now();
  const frame = () => {
    heights.push(item.getBoundingClientRect().height); seen.push(said());
    if (performance.now() - start < 450) requestAnimationFrame(frame); else done({ heights, said: seen });
  };
  item.querySelector<HTMLButtonElement>('article button[aria-expanded]')!.click();
  requestAnimationFrame(frame);
}));
/** The largest step against the way the row goes (down while it opens, up while it closes). */
const against = (seen: number[], opening: boolean) => Math.max(0, ...seen.slice(1).map((height, at) => (opening ? -1 : 1) * (height - seen[at]!)));

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`a History row's head stays still and the row moves one way as it opens and closes, at ${width}px`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height });
    await open(page, runtime, '?agent=1&task=T111');
    const reader = page.locator('aside[data-reader-mode]:visible');
    const rows = reader.locator('[data-report-feed] li[data-report-key]');
    await expect(rows.first()).toBeVisible();
    for (const each of await head(rows).all()) if (await each.getAttribute('aria-expanded') === 'true') await each.click();
    await settleMotion(page);
    // An instruction, whose words go to its body, and a report, whose words stay in its head.
    // Pinned by key: the instruction's head loses its words as it opens.
    const keyOf = (prefix: string) => rows.filter({ has: page.locator('[data-row-words]') }).and(reader.locator(`li[data-report-key^="${prefix}"]`)).first().getAttribute('data-report-key');
    const cases = [[await keyOf('request:'), true], [await keyOf('log:'), false]] as const;
    for (const [key, handed] of cases) {
      const row = reader.locator(`li[data-report-key="${key}"]`);
      await row.scrollIntoViewIfNeeded(); await settleMotion(page);
      const closed = await parts(row);
      const opening = await frames(page, row); await settleMotion(page);
      await expect(head(row)).toHaveAttribute('aria-expanded', 'true');
      // The instruction's head has handed its words to the body; the report's keeps them.
      await expect(row.locator('[data-row-words]')).toHaveCount(handed ? 0 : 1);
      expect(await parts(row)).toEqual(closed);
      const closing = await frames(page, row); await settleMotion(page);
      expect(await parts(row)).toEqual(closed);
      expect(against(opening.heights, true)).toBeLessThanOrEqual(0.5);
      expect(against(closing.heights, false)).toBeLessThanOrEqual(0.5);
      // The words never blink out on the way: on every frame they are drawn in the head or in the body.
      expect(opening.said.every(Boolean)).toBe(true);
      expect(closing.said.every(Boolean)).toBe(true);
    }
  });
}

/**
 * On a phone, where a closed row's tags are a small step with a tight line, each tag's agent name once lost its g and
 * p below and their marks stood over their words' middle. Every tag draws its words whole, inside whatever clips round them,
 * and its mark's middle is its words' capitals' middle.
 */
test("a closed History row's tags draw their words whole, each mark on its words' middle, at 390px", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, '?agent=1&task=T111');
  const ends = page.locator('aside[data-reader-mode]:visible [data-row-ends]');
  await expect(ends.first()).toBeVisible();
  await settleMotion(page);
  const tags = await ends.evaluateAll(rows => rows.flatMap(row => [...row.querySelectorAll('[data-row-end]')].flatMap(tag => {
    // The open Task's own tag is only its mark where its Run has no agent.
    const words = [...tag.querySelectorAll<HTMLElement>('[data-agent-name], [data-row-party], [data-row-task]')];
    if (!words.length) return [];
    // What clips round the words: every box up to the row that cuts what overflows it up or down.
    let top = -Infinity, bottom = Infinity;
    for (let box: Element | null = words[0]!; box && box !== row.closest('li'); box = box.parentElement) {
      if (getComputedStyle(box).overflowY === 'visible') continue;
      const rect = box.getBoundingClientRect(); top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom);
    }
    const cut = words.some(word => {
      const range = document.createRange(); range.selectNodeContents(word);
      const drawn = range.getBoundingClientRect();
      return drawn.top < top - 0.5 || drawn.bottom > bottom + 0.5;
    });
    const cap = document.createElement('span'); cap.style.cssText = 'display:inline-block;width:0;height:1cap';
    words[0]!.prepend(cap); const capitals = cap.getBoundingClientRect(); cap.remove();
    const mark = tag.querySelector('svg')!.getBoundingClientRect();
    return [{ words: words.map(word => word.textContent).join(' '), cut, off: Math.abs(mark.top + mark.height / 2 - (capitals.bottom - capitals.height / 2)) }];
  })));
  expect(tags.length).toBeGreaterThan(1);
  for (const tag of tags) {
    expect(tag.cut, tag.words).toBe(false);
    expect(tag.off, tag.words).toBeLessThanOrEqual(0.3);
  }
});
