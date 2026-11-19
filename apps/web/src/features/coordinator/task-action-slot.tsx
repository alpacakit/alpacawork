import { useCallback, useLayoutEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { cn } from '@/lib/utils';
import { sizeObserver, useSurfaceDocument } from '@/lib/surface';
import { useConversation } from './coordinator';

/** The visible conversation controls' DOM anchor, and the document it is drawn in (the conversation's own window, when it
 * has gone into one: the same element moves there). The reader keeps ownership of its task action. `labels`: the row the
 * tools stand in now has room for their words beside their marks (a computer's; useRowWords measures it). */
export const useTaskActionSlot = create<{ element: HTMLSpanElement | null; inThread: boolean; page: Document | null; labels: boolean }>(() => ({ element: null, inThread: false, page: null, labels: false }));

/** The coordinator input's quiet round tools (#, /, a recording's cancel): 32px under a pointer, the 44px a finger takes on a
 * phone or a touch screen (`narrow` or `pointer-coarse`, the same for every part of the row: inputFinger). Its “+” (AttachButton), model, microphone and send keep the same height and centre. */
export const inputTool = 'grid size-8 flex-none place-items-center rounded-full text-md text-muted hover:bg-hover hover:text-ink active:bg-line disabled:opacity-38 narrow:size-11 pointer-coarse:size-11';
/** A finger's 44px face for the coordinator input's round parts, on a phone or a touch screen. */
export const inputFinger = 'narrow:size-11 pointer-coarse:size-11';
/** The microphone while nothing is written, open or folded: the round tool with its edge, as the one line's other round
 * tools are (the way into the conversation, its moves); Send, once there are words, keeps the filled ink. */
export const inputSpeak = 'border-lit-line bg-raised text-ink hover:border-lit-line hover:bg-hover hover:text-ink';

/** Shared shape of every button in the open conversation's end row (and the queue's folded toggle). */
export const conversationTool = "relative inline-flex h-9 flex-none items-center gap-1 rounded-full border border-lit-line bg-raised px-2.5 text-sm text-muted tabular-nums hover:bg-hover hover:text-ink disabled:opacity-38 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-0 pointer-coarse:before:-bottom-2 pointer-coarse:before:content-['']";

/** The task actions' round tool on the folded row, floating over the screen; in the open thread, conversationTool. */
const foldedTool = "relative inline-flex h-9 flex-none items-center gap-1.5 rounded-full border border-lit-line bg-raised px-3 text-sm text-muted shadow-float hover:bg-hover hover:text-ink disabled:opacity-38 pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:top-0 pointer-coarse:before:-bottom-2 pointer-coarse:before:content-['']";

/** How a task action is drawn: the round tool of the conversation's row with its words, or on a phone that tool with its
 * mark alone, named for what it does (TaskActions). */
export type ActionLook = 'tool' | 'mark';
/** The round tool reduced to its mark (ActionLook 'mark'). */
export const markTool = "w-9 justify-center px-0";

/** The round tool the conversation's row is made of where the task actions stand now: its open thread or its folded row. */
export function useRowTool() {
  const inThread = useTaskActionSlot(state => state.inThread);
  return inThread ? conversationTool : foldedTool;
}

/** Where the conversation's own tools stand now: its folded row while it is folded here, else the open conversation
 * (or its own window). Each tool is drawn in that one place. */
export function useToolsHere(folded: boolean) {
  const expanded = useConversation(state => state.expanded);
  const own = useSurfaceDocument() !== document;
  return folded ? !expanded && !own : expanded || own;
}

/** What gives way in the conversation's row to its tools (the last words, a parked draft's return): it may shrink to
 * nothing, so the row never spills, cut with an ellipsis. */
export const ROW_GIVES_WAY = 'min-w-0 shrink';
/** The width a giving-way item keeps readable (its mark and a few words), counted for it when the tools ask for room. */
const ROW_LEAST = 128;
/** A giving-way item that is read only whole (a message's grace: its ring, words and Undo) is counted at its whole width
 * instead, so the tools give it that room while they can; it still shrinks where even their marks leave less. */
export const ROW_WHOLE = { 'data-row-whole': '' } as const;
/** An item's width with its parts side by side at their own widths: a part wrapped out of sight keeps its width. */
function wholeWidth(element: Element): number {
  const style = getComputedStyle(element);
  if (!style.display.endsWith('flex') || style.flexDirection.startsWith('column')) return element.getBoundingClientRect().width;
  const parts = [...element.children].filter(child => getComputedStyle(child).position !== 'absolute');
  const edges = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
  return parts.reduce((sum, part) => { const own = getComputedStyle(part); return sum + wholeWidth(part) + parseFloat(own.marginLeft) + parseFloat(own.marginRight); },
    edges + Math.max(0, parts.length - 1) * (parseFloat(style.columnGap) || 0));
}

/**
 * The one rule for how the conversation's row (folded over the input, or the open conversation's foot) holds its tools:
 * everything in it stays on one line; what else stands in it either stands whole or gives way (it can shrink:
 * ROW_GIVES_WAY), and the tools (`group`) say their words only while the row has room for them beside what stands whole
 * and ROW_LEAST for each item giving way (its whole width for one read only whole: ROW_WHOLE); else, and on a phone,
 * they are marks alone. The room is counted from those widths, not from where things stand now, so what a mark leaves
 * free never changes the answer: the words come back as soon as the row is as wide as they were with them. `on`: this
 * row is the one on screen (only one measures at a time).
 */
export function useRowWords(row: RefObject<HTMLElement | null>, group: RefObject<HTMLElement | null>, on: boolean, phone: boolean) {
  const page = useSurfaceDocument();
  useLayoutEffect(() => {
    const line = row.current, tools = group.current;
    const set = (next: boolean) => { if (useTaskActionSlot.getState().labels !== next) useTaskActionSlot.setState({ labels: next }); };
    if (!on) return;
    if (!line || !tools || phone) { set(false); return; }
    let wanted = 0;
    const gap = (element: Element) => parseFloat(getComputedStyle(element).columnGap || '0') || 0;
    const room = () => {
      const style = getComputedStyle(line);
      const others = [...line.children].filter(child => child !== tools && child.getBoundingClientRect().width > 0);
      const least = (child: Element) => child.matches('[data-row-whole]') ? Math.max(ROW_LEAST, wholeWidth(child)) : ROW_LEAST;
      const taken = others.reduce((sum, child) => sum + (getComputedStyle(child).flexShrink !== '0' ? least(child) : child.getBoundingClientRect().width), 0);
      return line.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - taken - others.length * gap(line);
    };
    // How wide the tools are as drawn: each stands whole (flex-none), so their sum is what they need, wherever the row
    // would push them (right-aligned, they spill out at the left, which no scroll width counts).
    const drawnWidth = () => {
      const shown = [...tools.children].filter(child => child.getBoundingClientRect().width > 0);
      return shown.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + Math.max(0, shown.length - 1) * gap(tools);
    };
    const fit = () => {
      if (useTaskActionSlot.getState().labels) { const need = drawnWidth(); if (need > room() + 1) { wanted = need; set(false); } }
      else if (!wanted || room() >= wanted) set(true);
    };
    const view = page.defaultView ?? window;
    const sizes = sizeObserver(line, fit);
    const watch = () => { sizes.disconnect(); sizes.observe(line); for (const child of line.children) sizes.observe(child); };
    watch();
    // What else stands in the row coming or going, or its words changing (the last words): measured again.
    const beside = new view.MutationObserver(records => { if (records.some(record => !tools.contains(record.target))) { watch(); fit(); } });
    beside.observe(line, { childList: true, subtree: true, characterData: true });
    // The tools themselves changing (a task action coming or going): tried with words again.
    const changed = new view.MutationObserver(() => { wanted = 0; fit(); });
    changed.observe(tools, { childList: true });
    const slot = tools.matches('[data-task-action-slot]') ? null : tools.querySelector('[data-task-action-slot]');
    if (slot) changed.observe(slot, { childList: true });
    fit();
    return () => { sizes.disconnect(); beside.disconnect(); changed.disconnect(); set(false); };
  }, [row, group, on, phone, page]);
}

/** Only the visible controls register a slot: the folded row, or the conversation in its current document. */
export function TaskActionSlot({ className, inThread = false, ref }: { className?: string; inThread?: boolean; ref?: RefObject<HTMLSpanElement | null> } = {}) {
  const page = useSurfaceDocument();
  const anchor = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return;
    if (ref) ref.current = element;
    useTaskActionSlot.setState({ element, inThread, page });
    return () => {
      if (ref?.current === element) ref.current = null;
      if (useTaskActionSlot.getState().element === element) useTaskActionSlot.setState({ element: null, inThread: false, page: null });
    };
  }, [inThread, page, ref]);
  // Change state and Done side by side (TaskActions); what else stands in the row gives way to them.
  return <span ref={anchor} data-task-action-slot className={cn("pointer-events-auto flex flex-none items-center gap-2 empty:hidden", className)} />;
}
