import { useLayoutEffect, useRef } from 'react';
import { onReadingMove } from '@/features/reader/reading-move';
import { glideReading, reducedMotion } from '@/lib/motion';
import { sizeObserver } from '@/lib/surface';
import { useConversation } from './coordinator';

const rows = '[data-earlier], [data-coordinator-message]';
/** Space over the latest words at the opening target. */
const OVER_MESSAGE = 8;
/** How long after the person's own scroll (a wheel's or a flick's run-on included) the thread still counts as in hand. */
const IN_HAND_AFTER = 400;
// A turn's work line and its open steps are read too: a reader there is kept there as the words above it change.
const blocks = '[data-sent-message], [data-ask-answer] :is(p,li,h1,h2,h3,h4,pre,table,img), [data-coordinator-answer-meta], [data-turn-work-line], [data-run-log]';
/** Layout coordinates ignore the entrance animations on the card and its messages. */
function layoutTop(element: HTMLElement): number {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) top += node.offsetTop;
  return top;
}
type Position = { update: () => void; end: (smooth?: boolean) => void; retain: () => void; hold: () => void; jump: (target: HTMLElement, options: ScrollIntoViewOptions, past?: number) => void };
const positions = new WeakMap<HTMLElement, Position>();
const positionOf = (thread: HTMLElement) => {
  const area = thread.closest<HTMLElement>('[data-card-scroll]');
  return area ? positions.get(area) : undefined;
};
/** Opening or folding the displayed history requests the current place, rather than following its height change. */
export function keepThreadPosition(thread: HTMLElement) { positionOf(thread)?.retain(); }
/**
 * A press that opens or folds something in the thread (a turn's work) is the person's own move: what is read stays
 * where it is as that grows or shrinks, as after a scroll, rather than being followed to the last thing said.
 */
export function holdThreadPosition(thread: HTMLElement) { positionOf(thread)?.hold(); }
/**
 * Every explicit send entrance, including resending an old failure, asks the same owner for the latest place; so does
 * the way down from reading back (ToLatest), which glides there (`smooth`).
 */
export function scrollThreadToEnd(thread: HTMLElement, smooth = false) { positionOf(thread)?.end(smooth); }
/**
 * Reply navigation is an explicit position request, even before its native smooth scroll has started. `past`: how much
 * a target still unfolding is yet to grow; placed at its end, it is placed as it will stand, and the thread lends up to
 * that much room under it to get there.
 */
export function scrollThreadTo(thread: HTMLElement, target: HTMLElement, options: ScrollIntoViewOptions, past = 0) {
  const owner = positionOf(thread);
  if (owner) owner.jump(target, options, past);
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
    let rememberedHeight = area.scrollHeight, rememberedRoom = area.clientHeight, rememberedWidth = area.clientWidth;
    let anchor: { block: HTMLElement; offset: number; text?: { range: Range; offset: number } } | null = null;
    const oldAnchoring = area.style.overflowAnchor, oldPadding = body.style.paddingBottom;
    let bottomRoom = 0, unfoldRoom = 0;
    // What following the end keeps at the top (the last thing said) and where it was laid out when last noted.
    let followed: { said: HTMLElement; top: number } | null = null;
    const releaseRoom = () => { bottomRoom = 0; unfoldRoom = 0; body.style.paddingBottom = oldPadding; };
    // Room lent for a jump to what is still unfolding (jump's `past`, never more) is taken back as far as it is out of
    // view, as what grows into it no longer needs it, and whatever is left once nothing unfolds any more (it opened
    // less far, or folded again), gliding down as far as the thread then shortens. Room kept for history opened above
    // stays until it is released.
    const setRoom = (room: number) => { bottomRoom = room; body.style.paddingBottom = room > 0 ? `${room}px` : oldPadding; };
    const takeBackRoom = () => {
      if (unfoldRoom <= 0) return;
      const give = Math.min(unfoldRoom, Math.floor(area.scrollHeight - area.scrollTop - area.clientHeight));
      if (give <= 0) return;
      unfoldRoom -= give; setRoom(bottomRoom - give);
    };
    const unfolding = () => body.getAnimations({ subtree: true }).some(move => move.playState === 'running'
      && move.effect instanceof KeyframeEffect && move.effect.target instanceof Element && move.effect.target.matches('[data-disclosure-body]'));
    const unfolded = (event: Event) => {
      if (unfoldRoom <= 0 || !(event.target instanceof Element) || !event.target.matches('[data-disclosure-body]') || unfolding()) return;
      const from = area.scrollTop;
      setRoom(bottomRoom - unfoldRoom); unfoldRoom = 0;
      glideReading(body, area.scrollTop - from, 'in-out');
      note();
    };
    body.addEventListener('transitionend', unfolded);
    body.addEventListener('transitioncancel', unfolded);
    area.style.overflowAnchor = 'none';
    const topIn = (element: HTMLElement) => layoutTop(element) - layoutTop(area);
    // How far a drawn point is below the area's drawn top, in layout pixels: the area may be drawn scaled while it comes in.
    const below = (drawnTop: number) => { const box = area.getBoundingClientRect(); return (drawnTop - box.top) * (box.height ? area.offsetHeight / box.height : 1); };
    // Anchors use layout positions. A newly inserted row may still be animating above the retained words;
    // its entrance transform must not become a reason to scroll those words on the next acknowledgement.
    const at = (element: HTMLElement) => topIn(element) - area.scrollTop;
    const textAt = (range: Range, block: HTMLElement) => at(block) + below(range.getBoundingClientRect().top) - below(block.getBoundingClientRect().top);
    const headHeight = () => area.querySelector<HTMLElement>('[data-coordinator-panel-head]')?.offsetHeight ?? 0;
    // How far the thread reaches as laid out: a glide draws it moved (glideReading), which the browser counts in its
    // scrollHeight while it lasts, and must not be taken for the thread having grown.
    const extent = () => Math.max(area.clientHeight, topIn(body) + body.offsetHeight);
    const atEnd = () => extent() - area.clientHeight - area.scrollTop < 48;
    // Whether what is read is short of the end, for the way down (ToLatest) to read.
    const markAway = () => area.toggleAttribute('data-thread-away', !atEnd());
    // The person's hand on the reading: a finger or a mouse button held on it, or a scroll of theirs a moment ago.
    // Meanwhile growth at the end is not followed (owed), so nothing moves under the hand; once let go, it is followed.
    let holding = false, movedAt = -Infinity, later = 0, owed = false;
    const view = area.ownerDocument.defaultView ?? window;
    const inHand = () => holding || performance.now() - movedAt < IN_HAND_AFTER;
    const settleLater = () => { view.clearTimeout(later); later = view.setTimeout(() => settle(), IN_HAND_AFTER); };
    const hold = (event: Event) => { if (!(event instanceof PointerEvent) || event.pointerType === 'mouse') holding = true; };
    const letGo = (event: Event) => {
      // A finger's pointer is cancelled once the browser scrolls under it; the finger is still there until it lifts.
      if (!holding || (event.type === 'pointercancel' && (event as PointerEvent).pointerType !== 'mouse')) return;
      // Only the window's own blur: a control in it losing the focus (as a press moves it) is no letting go.
      if (event.type === 'blur' && event.target !== view) return;
      holding = false; settleLater();
    };
    // The browser holds the reading at the end when what is below shrinks under it: that is not the reader's move, so
    // where it was read (and whether it followed the end) stays, and grown back, the same line is read where it was.
    const held = () => { const end = area.scrollHeight - area.clientHeight; return rememberedTop > end + 0.5 && Math.abs(area.scrollTop - end) < 1; };
    const movedByReader = () => area.scrollTop !== rememberedTop && !held();
    // Held there, only where it stands is new; what is read and whether it follows are kept.
    const noteHeld = () => { rememberedTop = area.scrollTop; rememberedHeight = area.scrollHeight; rememberedRoom = area.clientHeight; rememberedWidth = area.clientWidth; markAway(); };
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
      takeBackRoom();
      rememberedTop = area.scrollTop;
      rememberedHeight = area.scrollHeight; rememberedRoom = area.clientHeight; rememberedWidth = area.clientWidth;
      // What is owed to the end keeps it followed: the growth it waits for took it further than "at the end".
      following = !stayOnQuestion && (atEnd() || owed);
      markAway();
      const said = following ? lastSaid() : undefined;
      followed = said ? { said, top: topIn(said) } : null;
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
      if (movedByReader()) { owed = false; remember(); return; }
      const sized = area.scrollHeight !== rememberedHeight || area.clientHeight !== rememberedRoom;
      // Following the end with nothing kept, a change that moves nothing and sizes nothing (a second ticking by) asks nothing.
      if (following && !anchor && !sized && !owed) return;
      // A disclosure moving in the thread (a turn's work, pressed by the person) is not new words to follow: what is read
      // stays where it is while it moves; still at the end once it has, the end is followed again.
      if (following && (sized || owed) && !(anchor && pastFollow()) && !unfolding()) {
        // What came in above the followed words (older history read in, an image above taking its height) moved them
        // down: the reading goes down as far, so they stand where they were. Only what grew under them, or a new size of
        // the pane, is followed, and following only ever goes on toward the end, never back; what it follows comes into
        // sight by gliding there, as far as it moved on screen. A new size of the pane (a hand on any of its edges, the
        // pane gliding to its largest), and the words wrapping anew in a new width, come on every frame and are drawn as
        // they go: they are followed at once, without a glide, since a glide started on each frame draws the words where
        // they were and they shake under the edge.
        const from = area.scrollTop, said = lastSaid(), above = said && followed?.said === said ? topIn(said) - followed.top : 0;
        const resized = area.clientHeight !== rememberedRoom || area.clientWidth !== rememberedWidth;
        const grown = area.scrollHeight - rememberedHeight - above > 0 || resized || owed;
        // In the person's hand, what grew is owed rather than followed: what they read stays where it is (as far as what
        // came in above moved it), and the end is followed once they let go.
        const waits = grown && !resized && inHand();
        owed = waits;
        if (waits) settleLater();
        area.scrollTop = grown && !waits ? Math.max(from + above, followTop()) : from + above;
        if (!resized) glideReading(body, area.scrollTop - from - above);
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
      pending = false; stayOnQuestion = false; owed = false;
      remember();
    };
    // A reply jump or scrollbar can choose a position before the browser delivers its scroll event.
    const takeOverIfMoved = () => { if (pending && movedByReader()) takeOver(); };
    const end = (smooth = false) => {
      releaseRoom();
      takeOver();
      area.scrollTo({ top: area.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'instant' });
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
      movedAt = performance.now(); owed = false;
      stayOnQuestion = false;
      remember();
    };
    const stopMove = onReadingMove(area, event => { if (event.type === 'wheel') movedAt = performance.now(); takeOver(); });
    // Let go outside the window (or the window left), the hand is gone too.
    const handEvents = [['pointerup', letGo], ['pointercancel', letGo], ['touchend', letGo], ['touchcancel', letGo], ['blur', letGo]] as const;
    area.addEventListener('pointerdown', hold, { capture: true, passive: true });
    area.addEventListener('touchstart', hold, { capture: true, passive: true });
    for (const [type, listener] of handEvents) view.addEventListener(type, listener, { capture: true, passive: true });
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
    }, hold: () => {
      takeOver(); following = false; if (!anchor) findAnchor();
    }, jump: (target, options, past = 0) => {
      takeOver();
      const from = area.scrollTop;
      if (options.behavior === 'smooth' || (options.block !== 'start' && options.block !== 'end')) target.scrollIntoView(options);
      else {
        // Placed by hand at its laid-out place (not where a glide draws it), at the height it is unfolding to (`past`).
        // What the thread cannot scroll to yet is lent as room under it, up to what unfolds (takeBackRoom); past that
        // it goes as far as it can, as a last exchange too short to reach the top stops at the thread's end.
        const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
        const want = Math.max(0, options.block === 'start' ? topIn(target) - margin : topIn(target) + target.offsetHeight + past - area.clientHeight);
        const lend = Math.min(past, Math.max(0, want - (area.scrollHeight - area.clientHeight)));
        if (lend > 0) { unfoldRoom += lend; setRoom(bottomRoom + lend); }
        area.scrollTop = want;
      }
      // Not asked to scroll smoothly, it still comes into sight by gliding there, on a disclosure's curve: what unfolds
      // under the target as it goes (a turn's steps) and what is under that then move as one.
      if (options.behavior !== 'smooth') glideReading(body, area.scrollTop - from, 'in-out');
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
      area.removeEventListener('pointerdown', hold, true); area.removeEventListener('touchstart', hold, true);
      for (const [type, listener] of handEvents) view.removeEventListener(type, listener, true);
      view.clearTimeout(later);
      area.style.overflowAnchor = oldAnchoring; area.removeAttribute('data-thread-away');
      body.removeEventListener('transitionend', unfolded); body.removeEventListener('transitioncancel', unfolded);
      releaseRoom();
    };
  }, [body, host, active, surface, openingId, scope]);
  // DOM and size observers own content movement. Parent geometry commits do not move the thread.
  useLayoutEffect(() => { owner.current?.update(); }, [body, host, active, surface, scope, local, openingId]);
}
