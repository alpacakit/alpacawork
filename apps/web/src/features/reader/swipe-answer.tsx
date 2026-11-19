import { useTaskReport } from './use-task-report';
import { countUse } from '@/features/telemetry/count';
import { useReaderTurnHeld, useReaderCard, type ReaderAdmission } from "./next-question";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { Icon } from "@/components/ui/icon";
import type { IconName } from "@/components/ui/icon";
import { duration, easing } from "@/lib/motion";
import { stampInk, stampPaper, stampWords } from "./stamp";
import { cn } from "@/lib/utils";
import type { Task } from '@/data/types';
import { useTranslation } from 'react-i18next';
import { userTurn } from '@alpacawork/contract';
import { useReaderPeople } from '@/data/queries';
import { useReaderSend } from '@/features/coordinator/reader-send';
import { useSwipeRefusal } from './swipe-refusal';

type SwipeAction = { kind: 'send' | 'hold' | 'done'; verb: string; run: () => ReaderAdmission };
/**
 * `refuse`: no answer on the right yet; a swipe there is drawn back and says why (what is left to choose) instead of
 * doing nothing.
 */
const SWIPE_USE = { send: 'swipe.send', done: 'swipe.done', hold: 'swipe.hold' } as const;
type Actions = { answer: SwipeAction | null; hold: SwipeAction | null; refuse?: (() => void) | null };

/**
 * How fast the finger was moving when it let go (px/ms), from its last two moves. Held still before letting go, a finger
 * sends no moves, so a pause longer than 100ms, or than twice the gap between its moves on a slow device, is no movement.
 */
export function releaseSpeed(trail: readonly { x: number; t: number }[], at: number) {
  const [before, last] = trail.length > 1 ? trail.slice(-2) : [undefined, trail[0]];
  const gap = before && last ? last.t - before.t : 0;
  if (!before || !last || gap <= 0 || at - last.t > Math.max(100, 2 * gap)) return 0;
  return (last.x - before.x) / gap;
}

/** How far the card goes before letting go answers: a third of its width, at most 120px. */
const reach = (width: number) => Math.min(120, width * 0.3);
/** The card carried `dx` sideways: moved and tilted the way it goes, the same for a swipe that answers and one refused. */
const carried = (dx: number) => `translateX(${dx}px) rotate(${dx / 45}deg)`;

/**
 * A press that starts where sideways movement already means something (a field, a wide code block, a slider), or on a
 * diff or a file shown over the reports (UrlViewer), which is read, not the card, or on a sheet's thin handle, which
 * keeps its finger even pinch-zoomed (lib/pinch-zoom.ts). The header and title, grips too, are the card's like the
 * rest: the sheet takes only a press that goes up or down first (sheet-press), so one going sideways is the swipe's.
 */
function ownsSideways(target: EventTarget | null, area: HTMLElement) {
  if (!(target instanceof Element) || target.closest("input, textarea, select, [contenteditable], [data-image-slider], [data-viewer], [data-sheet-handle]")) return true;
  // What scrolls across and lets a finger do it; the reports' own scroller (Reader) lets one only up and down.
  for (let node: Element | null = target; node && node !== area; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/auto|scroll/.test(style.overflowX) && /auto|manipulation|pan-x/.test(style.touchAction)
      && node.scrollWidth > node.clientWidth + 1) return true;
  }
  return false;
}

/**
 * On a touch screen, the reader's report follows a sideways finger from anywhere it is read (`reading`: its head, title
 * and reports alike): right confirms a review by direct report, or
 * sends a question's answer through the coordinator's input. Left holds by direct report through useHoldAction.
 * Up and down stay the report's scrolling: a press is only taken once it clearly goes sideways (the reader's content
 * leaves the browser only up and down and pinching while its card can be swiped: Reader, `swipeable`). A card let go short of the line comes back, and so does one held still before letting go, even past
 * the line: only a finger still moving outward answers. The stamp of that side (SwipeStamp, `stamp`) shows with the
 * finger and is pressed in at the line. With no answer on the right (`refuse`), the card still follows the finger, held
 * back more the further it goes, with no stamp; let go past the line or flicked as it would answer, it comes back and
 * then says why. Let go short of the line, it only comes back.
 */
export function useSwipeAnswer(card: RefObject<HTMLElement | null>, reading: RefObject<HTMLElement | null>,
  stamp: RefObject<HTMLElement | null>, on: boolean, actions: Actions, identity: string) {
  const latest = useRef(actions);
  latest.current = actions;
  useLayoutEffect(() => {
    const area = reading.current, aside = card.current, mark = stamp.current;
    if (!on || !area || !aside || !mark) return;
    let start: { x: number; y: number; id: number } | null = null;
    let sideways = false, dx = 0, armed = false, refusing = false;
    // A refusal's reason waits for the card to come back; a new press, or the card gone, takes it back.
    let telling: number | undefined;
    let trail: { x: number; t: number }[] = [];
    let action: SwipeAction | null = null;
    const hide = () => { delete mark.dataset.swipe; delete mark.dataset.armed; mark.style.removeProperty("--swipe"); };
    // The card is carried by the finger: let go, it goes on at once (departure.ts), its words shown with the finger.
    const carry = (on: boolean) => aside.toggleAttribute("data-carried", on);
    const reset = () => {
      const pointer = start?.id;
      start = null; sideways = false;
      clearTimeout(telling);
      if (pointer !== undefined && area.hasPointerCapture?.(pointer)) area.releasePointerCapture(pointer);
      aside.style.removeProperty('transform');
      aside.style.removeProperty('transition');
      carry(false); hide();
    };
    const back = () => {
      reset();
      // A card let go comes back to its place (a move within its place: base duration, out easing).
      aside.style.transition = `transform ${duration("base")}ms ${easing("out")}`;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !event.isPrimary || ownsSideways(event.target, area)) return;
      start = { x: event.clientX, y: event.clientY, id: event.pointerId };
      sideways = false; dx = 0; armed = false; refusing = false; action = null;
      clearTimeout(telling);
      trail = [{ x: event.clientX, t: event.timeStamp }];
    };
    const move = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      const mx = event.clientX - start.x, my = event.clientY - start.y;
      if (!sideways) {
        if (Math.hypot(mx, my) < 12) return;
        // Only a clearly sideways start is taken; a slanted one is the report's scrolling.
        const actions = latest.current;
        action = mx > 0 ? actions.answer : actions.hold;
        refusing = !action && mx > 0 && !!actions.refuse;
        if (Math.abs(mx) < Math.abs(my) * 1.5 || !action && !refusing || getSelection()?.toString()) { start = null; return; }
        sideways = true;
        area.setPointerCapture(event.pointerId);
        // A refused card is not carried off (departure.ts) and shows no stamp.
        if (!refusing) { carry(true); mark.dataset.swipe = mx > 0 ? "right" : "left"; }
      }
      event.preventDefault();
      dx = mx;
      trail = [...trail.slice(-1), { x: event.clientX, t: event.timeStamp }];
      const line = reach(aside.offsetWidth);
      aside.style.transition = "none";
      if (refusing) {
        // Held back: carried as an answer is, giving less the further the finger goes, never past half the line.
        const give = line / 2;
        aside.style.transform = carried(Math.sign(dx) * give * (1 - Math.exp(-Math.abs(dx) / give)));
        const now = dx >= line;
        if (now !== armed) { armed = now; if (now) navigator.vibrate?.(8); }
        return;
      }
      // The card follows the finger as it is: no curve while it is held.
      aside.style.transform = carried(dx);
      mark.style.setProperty("--swipe", String(Math.min(1, Math.abs(dx) / line)));
      const now = Math.abs(dx) >= line;
      if (now !== armed) { armed = now; mark.toggleAttribute("data-armed", now); if (now) navigator.vibrate?.(8); }
    };
    const up = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      if (!sideways) return reset();
      const speed = releaseSpeed(trail, event.timeStamp);
      const outward = Math.sign(speed) === Math.sign(dx);
      const go = outward && (armed && Math.abs(speed) > 0.1 || Math.abs(dx) > 40 && Math.abs(speed) > 0.6);
      if (refusing) {
        back();
        // Past the line (held there or not) or flicked, it says why once the card is back, so nothing moves under it.
        if (armed || go) { countUse('swipe.refused'); telling = window.setTimeout(() => latest.current.refuse?.(), duration("base")); }
        return;
      }
      hide();
      if (!go || !action) return back();
      // Eligibility may have changed while the finger was down (recording, upload, sending, task update).
      const current = dx > 0 ? latest.current.answer : latest.current.hold;
      if (!current || current.kind !== action.kind) return back();
      // The gesture owns the live transform only while the finger is down. Sending owns its eventual admission;
      // a copy already made by a synchronous retirement keeps its own geometry independently of this cleanup.
      let admission: ReaderAdmission = 'rejected';
      try { admission = current.run(); } finally { if (admission === 'retired') reset(); else back(); }
      // As the button and Enter count, only a swipe that was taken; one refused is swipe.refused's.
      if (admission !== 'rejected') countUse(SWIPE_USE[current.kind]);
    };
    const cancel = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id) return;
      back();
    };
    const lost = (event: PointerEvent) => { if (event.target === area) cancel(event); };
    // Once the card has the finger, the browser does not also take it as a pan of what it started on (a strip of tabs
    // that scrolls across, a link): told so on every move, listened to all along, as a sheet's press is (sheet-press).
    const keep = (event: TouchEvent) => { if (sideways && event.cancelable) event.preventDefault(); };
    const visibility = () => { if (document.visibilityState === 'hidden') reset(); };
    area.addEventListener("pointerdown", down);
    area.addEventListener("pointermove", move, { passive: false });
    area.addEventListener("pointerup", up);
    area.addEventListener("pointercancel", cancel);
    area.addEventListener("lostpointercapture", lost);
    area.addEventListener("touchmove", keep, { passive: false });
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', reset);
    return () => {
      reset();
      area.removeEventListener("pointerdown", down);
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerup", up);
      area.removeEventListener("pointercancel", cancel);
      area.removeEventListener("lostpointercapture", lost);
      area.removeEventListener("touchmove", keep);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', reset);
    };
  }, [card, reading, stamp, on, identity]);
}

/** Each way of answering in its color. */
const answerIcon: Record<SwipeAction['kind'], IconName> = { send: 'plane', done: 'check', hold: 'held' };

/**
 * What letting go would do, as a stamp tilted the way the card goes, big at the top of the reader's window and in the
 * middle across, where the thumb does not cover it (useSwipeAnswer sets the side in `data-swipe` and how far toward the
 * line in `--swipe`). It stays where the window is, not on the moving card; it fades in with the finger and, at the line,
 * is pressed in.
 */
function SwipeStamp({ box, stamp, answer, hold }: Actions & { box: string; stamp: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={stamp} aria-hidden="true" data-swipe-stamp
      className={cn(box, "group/swipe pointer-events-none border-0 bg-transparent shadow-none [--swipe:0]")}>
      {([["right", answer], ["left", hold]] as const).map(([side, action]) => action && (
        <div key={side} data-swipe-mark={action.kind}
          className={cn("absolute top-[14%] left-1/2 hidden w-max max-w-[78%] flex-col items-center gap-1", stampPaper,
            "transition-[scale] duration-(--motion-base) ease-(--ease-pop) group-data-armed/swipe:scale-105",
            side === "right" ? "-rotate-12 group-data-[swipe=right]/swipe:flex" : "rotate-12 group-data-[swipe=left]/swipe:flex",
            stampInk[action.kind])}
          style={{ opacity: "min(1, calc(0.15 + 1.2 * var(--swipe)))", translate: "-50% 0" }}>
          <span className={stampWords}>
            <Icon name={answerIcon[action.kind]} className="size-[0.9em] stroke-[2.75]" />{action.verb}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Inside ReaderCardContext, so Review OK, Hold and the draft's send leave the card as the buttons do: a review's right
 * swipe and the left swipe write the state report, and the card leaves at local admission.
 */
export function ReaderSwipe({ task, box, reading, content, className, enabled }: { task: Task; box: RefObject<HTMLElement | null>;
  reading: RefObject<HTMLElement | null>; content: RefObject<HTMLElement | null>; className: string; enabled: boolean }) {
  const { t } = useTranslation('reader');
  const people = useReaderPeople(task.id);
  const send = useReaderSend(state => state.action);
  const missing = useReaderSend(state => state.missing);
  const refuse = useSwipeRefusal(content, missing);
  const card = useReaderCard();
  const report = useTaskReport(task, people, card);
  const ready = report.ready;
  const stamp = useRef<HTMLDivElement>(null);
  const turn = userTurn(task.ball);
  // Retiring a card ends the gesture's ownership of its transform, even when the last card keeps the same task/hash.
  const departed = useReaderTurnHeld(task);
  const on = enabled && !departed;
  const actions: Actions = {
    answer: turn?.reason === 'review' ? ready ? { kind: 'done', verb: t('nextQuestion.done'), run: () => report.complete().admission } : null
      : send?.tasks.includes(task.id) ? { kind: 'send', verb: t('swipe.send'), run: send.run } : null,
    hold: ready && task.state !== 'held' ? { kind: 'hold', verb: t('swipe.hold'), run: () => report.submit('hold').admission } : null,
  };
  // With no answer on the right to a question asked of the person, a swipe says why: the question left.
  if (!actions.answer && turn?.reason === 'question' && missing?.task === task.id) actions.refuse = refuse;
  useSwipeAnswer(box, reading, stamp, on, actions, `${task.id}:${task.hash}:${turn?.key ?? ""}`);
  return on ? <SwipeStamp box={className} stamp={stamp} {...actions} /> : null;
}
