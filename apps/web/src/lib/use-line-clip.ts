import { useLayoutEffect, useRef } from 'react';

/**
 * How tall the box's rendered content is on its first whole lines (two), including its own spacing: what a clip of it
 * shows. Measured on the text as laid out, so it is the same whether the box is clipped now or not.
 */
export function wholeLinesHeight(box: HTMLElement) {
  const content = box.firstElementChild;
  const lineHeight = parseFloat(getComputedStyle(box).lineHeight);
  if (!content) return lineHeight * 2;
  const top = box.getBoundingClientRect().top;
  const rects: { top: number; bottom: number; leading: number }[] = [];
  const walker = box.ownerDocument.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = box.ownerDocument.createRange();
    range.selectNodeContents(node);
    const height = parseFloat(getComputedStyle(node.parentElement!).lineHeight);
    for (const rect of range.getClientRects()) if (rect.width && rect.height)
      rects.push({ top: rect.top, bottom: rect.bottom, leading: Math.max(0, height - rect.height) / 2 });
  }
  rects.sort((a, b) => a.top - b.top);
  const lines: typeof rects = [];
  for (const rect of rects) {
    const last = lines.at(-1);
    if (last && rect.top < last.bottom - 1) {
      last.bottom = Math.max(last.bottom, rect.bottom);
      last.leading = Math.max(last.leading, rect.leading);
    } else lines.push({ ...rect });
  }
  // Two lines plus at most one half-line of block spacing. If the next block cannot fit,
  // stop at the previous whole line instead of exposing a fragment of the next one.
  const visible = lines.slice(0, 2).filter(line => line.bottom + line.leading - top <= lineHeight * 2.5 + 1);
  const last = visible.at(-1);
  return last ? Math.ceil(last.bottom + last.leading - top) : lineHeight * 2;
}

/** Clip rendered content on whole lines, including its own spacing, without changing its typography. */
export function useLineClip(open: boolean, text: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    if (open) { box.style.maxHeight = ''; return; }
    const content = box.firstElementChild;
    if (!content) return;
    const measure = () => { box.style.maxHeight = `${wholeLinesHeight(box)}px`; };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(content);
    return () => observer?.disconnect();
  }, [open, text]);
  return ref;
}
