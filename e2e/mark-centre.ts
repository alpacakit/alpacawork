import type { Locator } from '@playwright/test';

/**
 * How far, in px, the middle of a line's work mark stands from the middle of its first words. The words' middle is
 * that of a reference glyph on their baseline: a full-height kana where they hold Japanese, else a capital (the
 * cap height), so descenders and a monospace face's line box do not move it.
 */
export const markCentreGap = (line: Locator) => line.evaluate(item => {
  const mark = item.querySelector('[data-work-mark]')!.getBoundingClientRect();
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.textContent!.trim() && !node.parentElement!.closest('[data-work-mark]') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const words = walker.nextNode()!, range = document.createRange();
  range.selectNodeContents(words);
  const box = range.getClientRects()[0]!, style = getComputedStyle(words.parentElement!);
  const canvas = document.createElement('canvas').getContext('2d')!;
  canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const glyph = canvas.measureText(/[　-鿿＀-￯]/.test(words.textContent!) ? 'あ' : 'H');
  const baseline = box.top + glyph.fontBoundingBoxAscent + (box.height - glyph.fontBoundingBoxAscent - glyph.fontBoundingBoxDescent) / 2;
  const middle = baseline - (glyph.actualBoundingBoxAscent - glyph.actualBoundingBoxDescent) / 2;
  return Math.abs(mark.top + mark.height / 2 - middle);
});
