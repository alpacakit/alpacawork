import { useLayoutEffect, useRef } from 'react';
import { onReadingMove } from '@/features/reader/reading-move';
import { glideReading } from '@/lib/motion';
import { sizeObserver } from '@/lib/surface';
import { useConversation } from './coordinator';

const rows = '[data-earlier], [data-coordinator-message]';
/** Space over the latest words at the opening target. */
const OVER_MESSAGE = 8;
// A turn's work line and its open steps are read too: a reader there is kept there as the words above it change.
const blocks = '[data-sent-message], [data-ask-answer] :is(p,li,h1,h2,h3,h4,pre,table,img), [data-coordinator-answer-meta], [data-turn-work-line], [data-run-log]';
/** Layout coordinates ignore the entrance animations on the card and its messages. */
function layoutTop(element: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
  return top;
}
type Position = { update: () => void; end: () => void; retain: () => void; jump: (target: HTMLElement, options: ScrollIntoViewOptions) => void };
const positions = new WeakMap<HTMLElement, Position>();
const positionOf = (thread: HTMLElement) => {
  const area = thread.closest<HTMLElement>('[data-card-scroll]');
  return area ? positions.get(area) : undefined;
};
/** Opening or folding the displayed history requests the current place, rather than following its height change. */
export function keepThreadPosition(thread: HTMLElement) { positionOf(thread)?.retain(); }
/** Every explicit send entrance, including resending an old failure, asks the same owner for the latest place. */
export function scrollThreadToEnd(thread: HTMLElement) { positionOf(thread)?.end(); }
/** Reply navigation is an explicit position request, even before its native smooth scroll has started. */
export function scrollThreadTo(thread: HTMLElement, target: HTMLElement, options: ScrollIntoViewOptions) {
  const owner = positionOf(thread);
  if (owner) owner.jump(target, options);
  else target.scrollIntoView(options);
}

/**
 * One owner for the shown conversation's position: an opening is placed once, a send asks for the end, and otherwise
 * the visible block stays put (or the end follows growth). An opening starts at the last thing said,
 * at its first drawing, and growth does not take it to the end until the person moves. Neither a late GET nor an
 * image acquiring its height can restore an old position.
 */
export function useThreadPosition(body: HTMLElement, host: HTMLElement | null, active: boolean, surface: Window | boolean,
  local: readonly { id: string }[]) {
  const scope = useConversation(state => `${state.root}/${state.conversation?.id ?? ''}`);
  // One opening is one placement: a later snapshot or history toggle does not place it again.
  const openingId = useConversation(state => state.opening?.id);
  const localNow = useRef(local);
  localNow.current = local;
  const owner = useRef<Position | null>(null);
  useLayoutEffect(() => {
    const area = body.closest<HTMLElement>('[data-card-scroll]');
    if (!active || !area) return;
    let pending = true, following = false, stayOnQuestion = false;
    let localIds = new Set(localNow.current.map(turn => turn.id));
    let rememberedTop = area.scrollTop;
    let rememberedHeight = area.scrollHeight, rememberedRoom = area.clientHeight;
    let anchor: { block: HTMLElement; offset: number; text?: { range: Range; offset: number } } | null = null;
    const oldAnchoring = area.style.overflowAnchor, oldPadding = body.style.paddingBottom;
    let bottomRoom = 0;
    const releaseRoom = () => { bottomRoom = 0; body.style.paddingBottom = oldPadding; };
    area.style.overflowAnchor = 'none';
    const topIn = (element: HTMLElement) => layoutTop(element) - layoutTop(area);
    // How far a drawn point is below the area's drawn top, in layout pixels: the area may be drawn scaled while it comes in.
    const below = (drawnTop: number) => { const box = area.getBoundingClientRect(); return (drawnTop - box.top) * (box.height ? area.offsetHeight / box.height : 1); };
    // Anchors use layout positions. A newly inserted row may still be animating above the retained words;
    // its entrance transform must not become a reason to scroll those words on the next acknowledgement.
    const at = (element: HTMLElement) => topIn(element) - area.scrollTop;
    const textAt = (range: Range, block: HTMLElement) => at(block) + below(range.getBoundingClientRect().top) - below(block.getBoundingClientRect().top);
    const headHeight = () => area.querySelector<HTMLElement>('[data-coordinator-panel-head]')?.offsetHeight ?? 0;
    const atEnd = () => area.scrollHeight - area.clientHeight - area.scrollTop < 48;
    // The browser holds the reading at the end when what is below shrinks under it: that is not the reader's move, so
    // where it was read (and whether it followed the end) stays, and grown back, the same line is read where it was.
    const held = () => { const end = area.scrollHeight - area.clientHeight; return rememberedTop > end + 0.5 && Math.abs(area.scrollTop - end) < 1; };
    const movedByReader = () => area.scrollTop !== rememberedTop && !held();
    // Held there, only where it stands is new; what is read and whether it follows are kept.
    const noteHeld = () => { rememberedTop = area.scrollTop; rememberedHeight = area.scrollHeight; rememberedRoom = area.clientHeight; };
    // The last thing the person said: an opening puts it at the top, and following the end goes no further than that,
    // so an answer that comes in long is read from its start, under what it answers.
    const lastSaid = () => {
      const last = [...body.querySelectorAll<HTMLElement>('[data-coordinator-turn], [data-coordinator-local]')].at(-1);
      return last && ([...last.querySelectorAll<HTMLElement>('[data-coordinator-said]')].at(-1) ?? last);
    };
    const saidAtTop = (said: HTMLElement) => topIn(said) - headHeight() - OVER_MESSAGE;
    const followTop = () => { const said = lastSaid(); return Math.min(area.scrollHeight, said ? saidAtTop(said) : area.scrollHeight); };
    // Following only ever goes on toward the end: a reader already past where it stops (reading the work under what
    // they said) keeps what they read, and what comes appears under it.
    const pastFollow = () => followTop() < area.scrollTop - 1;
    // Where it stands, as of now: cheap, read on every settle.
    const note = () => {
      rememberedTop = area.scrollTop;
      rememberedHeight = area.scrollHeight; rememberedRoom = area.clientHeight;
      following = !stayOnQuestion && atEnd();
    };
    // Where it stands and what is read at its top. Following the end, nothing there is kept (the end is), so the words
    // in sight are looked for only when the reading stands somewhere else: a pane sized by the hand settles each frame.
    const remember = () => {
      note();
      anchor = null;
      // Following, the words in sight are kept only when the reading is already past where following stops.
      if (!pending && (!following || pastFollow())) findAnchor();
    };
    const findAnchor = () => {
      const edge = area.scrollTop + headHeight();
      // Thread rows do not overlap. Find the first visible row without measuring all earlier opened history.
      const candidates = body.querySelectorAll<HTMLElement>('[data-coordinator-message]');
      let low = 0, high = candidates.length;
      while (low < high) {
        const middle = (low + high) >>> 1, row = candidates[middle]!;
        if (topIn(row) + row.offsetHeight <= edge) low = middle + 1;
        else high = middle;
      }
      const row = candidates[low];
      if (!row) return;
      const block = [...row.querySelectorAll<HTMLElement>(blocks)].find(element => topIn(element) + element.offsetHeight > edge) ?? row;
      anchor = { block, offset: at(block) };
      // A tall paragraph can contain an inline image above the line in sight. Remember the actual text there too.
      const box = area.getBoundingClientRect(), line = block.getBoundingClientRect();
      const range = area.ownerDocument.caretRangeFromPoint?.(Math.max(box.left + 40, line.left + 4), box.top + headHeight() + 12);
      if (range && range.startContainer.nodeType === Node.TEXT_NODE && block.contains(range.startContainer)) {
        range.setEnd(range.startContainer, Math.min(range.startOffset + 1, range.startContainer.textContent?.length ?? 0));
        const rect = range.getBoundingClientRect();
        if (rect.height > 0 && rect.top >= box.top + headHeight() && rect.bottom <= box.bottom)
          anchor.text = { range, offset: textAt(range, block) };
      }
    };
    const settle = () => {
      if (pending) return;
      // Explicit reply jumps, focus, and native scrolling can precede their scroll event. They choose a new anchor.
      if (movedByReader()) { remember(); return; }
      const sized = area.scrollHeight !== rememberedHeight || area.clientHeight !== rememberedRoom;
      // Following the end with nothing kept, a change that moves nothing and sizes nothing (a second ticking by) asks nothing.
      if (following && !anchor && !sized) return;
      if (following && sized && !(anchor && pastFollow())) {
        const from = area.scrollTop;
        area.scrollTop = followTop();
        // What it follows comes into sight by gliding there, not by a jump.
        glideReading(body, area.scrollTop - from);
      }
      else if (anchor && body.contains(anchor.block)) {
        const text = anchor.text;
        const shift = text && text.range.startContainer.nodeType === Node.TEXT_NODE && body.contains(text.range.startContainer)
          ? textAt(text.range, anchor.block) - text.offset : at(anchor.block) - anchor.offset;
        const wanted = area.scrollTop + shift;
        if (shift !== 0) area.scrollTop = wanted;
        // Kept where it was, the same words are still at the top: only where it stands is new (and where their block
        // now is, should the words be lost later). Held short of that (the
        // area could not scroll so far), what is at its top is looked for again.
        if (Math.abs(area.scrollTop - wanted) < 1) { anchor.offset = at(anchor.block); note(); if (!following) return; }
        // Held short of it at the end, the words stay what is read, to be read where they were once there is room.
        else if (wanted > area.scrollTop && Math.abs(area.scrollTop - (area.scrollHeight - area.clientHeight)) < 1) { noteHeld(); return; }
      }
      remember();
    };
    const takeOver = () => {
      pending = false; stayOnQuestion = false;
      remember();
    };
    // A reply jump or scrollbar can choose a position before the browser delivers its scroll event.
    const takeOverIfMoved = () => { if (pending && movedByReader()) takeOver(); };
    const end = () => {
      releaseRoom();
      takeOver();
      area.scrollTo({ top: area.scrollHeight });
      remember();
    };
    const place = () => {
      const said = lastSaid();
      // As far as it goes: a last exchange too short to reach the top stops at the thread's end, with no room added.
      if (body.querySelector('[data-coordinator-waiting]')) {
        stayOnQuestion = false;
        area.scrollTo({ top: area.scrollHeight });
      } else if (said) {
        stayOnQuestion = true;
        area.scrollTo({ top: saidAtTop(said) });
      } else area.scrollTo({ top: 0 });
      remember();
    };
    const update = () => {
      const state = useConversation.getState();
      const nextLocalIds = new Set(localNow.current.map(turn => turn.id));
      // A send chooses the latest row from its first drawing, including the optional transport grace period.
      const sentHere = [...nextLocalIds].some(id => !localIds.has(id));
      localIds = nextLocalIds;
      takeOverIfMoved();
      if (sentHere) {
        end();
      } else if (pending && state.opening) {
        // Each opening is placed once, at its first drawing.
        pending = false;
        place();
      } else settle();
    };
    const scrolled = () => {
      takeOverIfMoved();
      // Its own keeping (settle, end) has already remembered where it put the reading; the browser's hold is not a move.
      if (!movedByReader()) { if (held()) noteHeld(); return; }
      // A scrollbar moves no reading-move event: having left the question, the end follows growth again.
      stayOnQuestion = false;
      remember();
    };
    const stopMove = onReadingMove(area, takeOver);
    area.addEventListener('scroll', scrolled, { passive: true });
    const sizes = sizeObserver(area, settle);
    const watched = new Set<Element>();
    const watch = () => {
      const next = new Set<Element>([area, body, ...body.querySelectorAll(rows), ...body.querySelectorAll(blocks)]);
      for (const element of watched) if (!next.has(element)) { sizes.unobserve(element); watched.delete(element); }
      for (const element of next) if (!watched.has(element)) { sizes.observe(element); watched.add(element); }
    };
    const changes = new MutationObserver(() => { watch(); settle(); });
    changes.observe(body, { childList: true, subtree: true, characterData: true });
    watch();
    const controller: Position = { update, end, retain: () => {
      // A short thread already has blank space below it. Keep that space scrollable when history is inserted above;
      // otherwise the browser clamps the requested position before the old message can stay at its original height.
      const room = area.clientHeight - below(body.getBoundingClientRect().bottom);
      if (room > 0) { bottomRoom += room; body.style.paddingBottom = `${bottomRoom}px`; }
      takeOver(); following = false; if (!anchor) findAnchor();
    }, jump: (target, options) => {
      takeOver();
      target.scrollIntoView(options);
      remember();
      // Kept where it jumped, not at the end: what is read there is what it keeps.
      following = false; if (!anchor) findAnchor();
    } };
    owner.current = controller;
    positions.set(area, controller);
    update();
    return () => {
      owner.current = null;
      positions.delete(area);
      stopMove(); changes.disconnect(); sizes.disconnect(); area.removeEventListener('scroll', scrolled);
      area.style.overflowAnchor = oldAnchoring;
      releaseRoom();
    };
  }, [body, host, active, surface, openingId, scope]);
  // DOM and size observers own content movement. Parent geometry commits do not move the thread.
  useLayoutEffect(() => { owner.current?.update(); }, [body, host, active, surface, scope, local, openingId]);
}
