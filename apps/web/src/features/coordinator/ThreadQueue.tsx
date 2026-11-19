import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "@/components/ui/icon";
import { Message } from "@/components/ui/message";
import { useCloseOnBack } from "@/lib/close-on-back";
import { ESCAPE_LAYER, useEscapeLayer } from "@/lib/escape-layer";
import { sizeObserver, useSurfaceDocument } from "@/lib/surface";
import { growBack, growOut, shapeOf } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { useImageViewer } from "@/features/reader/ImageSlider";
import { useConversation } from "./coordinator";
import { useWaiting, WaitingRows, type Waiting } from "./CoordinatorQueue";
import { useFoldOnPressAway } from "./fold-on-press-away";
import { conversationTool, useToolsHere } from "./task-action-slot";
import { useShownConversation } from './shown';

/* Hallmark · component: the conversation's queue · genre: modern-minimal · theme: the app's own tokens (the panel's paper)
 * states: none waiting (nothing) · waiting (its button, N queued) · open (over the conversation, grown out of the button)
 */

const FIRST = ":is(button, [tabindex='0']):not(:disabled)";

/**
 * What waits to be sent, where the conversation is shown: one button at its foot's left (N queued, where Clear conversation
 * leaves room), standing there over what scrolls when one reads back. Nothing waiting, no button. A press opens it over
 * the conversation, grown out of the button as the state form grows out of the ✓ (growOut, growBack), and keeps the
 * focus where it is (the input's keyboard stays up); opened by a key, the focus goes in. Folded, the conversation's
 * queue uses the same button and disclosure, in the folded row.
 */
export function ThreadQueue({ area, folded = false }: { area?: RefObject<HTMLDivElement | null>; folded?: boolean }) {
  const { t } = useTranslation("ui");
  const queue = useWaiting();
  const { closing } = useShownConversation();
  const visible = useToolsHere(folded);
  const button = useRef<HTMLButtonElement>(null);
  // A disclosure belongs to a nonempty queue at this place. Losing either ends that disclosure, so a later queue
  // starts closed. Reconcile during render: no empty dialog (or stale open state) reaches the screen.
  const [open, setOpen] = useState<{ byKey: boolean } | null>(null);
  const available = folded && visible && queue.count > 0;
  if (!available && open) setOpen(null);
  const close = () => setOpen(null);
  if (!available) return null;
  const label = t("coordinatorCard.waitingCount", { count: queue.count });
  const control = (
      <button ref={button} type="button" data-coordinator-queue-button disabled={closing} aria-expanded={!!open} aria-haspopup="dialog" aria-label={label}
        onPointerDown={event => event.preventDefault()} onClick={event => open ? close() : setOpen({ byKey: event.detail === 0 })}
        style={open ? { visibility: "hidden" } : undefined}
        className={cn(conversationTool, "pointer-events-auto whitespace-nowrap")}>
        {label}<Icon name="up" className="size-3" />
      </button>);
  const over = open && <QueueOver queue={queue} from={button} area={area?.current ? area : undefined} folded={folded} byKey={open.byKey} close={close} />;
  return <>
    {control}
    {over && (area?.current ? createPortal(over, area.current) : over)}
  </>;
}

/**
 * Align its fold with the button, within the room needed by the rows and the conversation's head.
 * Measure the actual position, never an accumulated correction that can grow when a smaller area clips the rows.
 */
function place(over: HTMLElement, button: HTMLElement, content: HTMLElement, area: Element | null, folded: boolean) {
  const fold = over.querySelector<HTMLElement>("[data-coordinator-queue-fold]");
  if (!fold || !area) return;
  const rows = content.firstElementChild;
  // The open conversation's button is just below its body area; keep the fold on that same spot.
  over.style.setProperty("--queue-min-bottom", `${folded ? 0 : area.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom - 2}px`);
  over.style.setProperty("--queue-fold-left", `${Math.max(0, button.getBoundingClientRect().left - over.getBoundingClientRect().left - 2)}px`);
  const bottom = area.getBoundingClientRect().top + area.clientTop + area.clientHeight - over.getBoundingClientRect().bottom;
  const anchor = bottom + fold.getBoundingClientRect().bottom - button.getBoundingClientRect().bottom;
  over.style.setProperty("--queue-anchor", `${anchor}px`);
  over.style.setProperty("--queue-height", `${(rows?.scrollHeight ?? 0) + fold.parentElement!.offsetHeight}px`);
}

/**
 * Over the conversation, from its foot up to under its head line (its ⌄ stays in reach): the button grown, its corner
 * the button's corner, folding back into it. Esc, Back, a tap outside it, or the same spot close it. It is placed from
 * the conversation's own area (the panel, or in its own window the part over the input), not from what scrolls.
 */
function QueueOver({ queue, from, area, folded, byKey, close }: { queue: Waiting; from: RefObject<HTMLButtonElement | null>; area?: RefObject<HTMLDivElement | null>; folded: boolean; byKey: boolean; close: () => void }) {
  const { t } = useTranslation("ui");
  const { closing } = useShownConversation();
  const viewer = useImageViewer();
  const root = useRef<HTMLDivElement>(null), surface = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  // The fold back is played once it is gone, not when React only tries the effect again (StrictMode).
  const leaving = useRef<object | null>(null);
  useEscapeLayer(true, ESCAPE_LAYER.popup, close);
  useCloseOnBack(true, close);
  // A tap away closes it as a tap away takes the coordinator one step down (only a tap; what is open over it keeps it).
  // The document it is drawn in: the app's, or the conversation's own window, which it moves to open.
  const at = useSurfaceDocument();
  useFoldOnPressAway(true, node => !!root.current?.contains(node), close, { layer: ESCAPE_LAYER.popup, at });
  useLayoutEffect(() => {
    const button = from.current, shown = surface.current!, at = root.current!.ownerDocument;
    if (!button) return;
    leaving.current = null;
    place(root.current!, button, content.current!, area?.current ?? root.current!.offsetParent, folded);
    growOut(shown, content.current!, button);
    if (byKey) content.current!.querySelector<HTMLElement>(FIRST)?.focus();
    return () => {
      const was = shapeOf(button, shown), token = {}, focused = root.current?.contains(at.activeElement);
      leaving.current = token;
      queueMicrotask(() => {
        if (leaving.current !== token) return;
        growBack(was, shown, button);
        if (focused) button.focus({ preventScroll: true });
      });
    };
  }, []);
  // Kept at the button while the conversation's area or what it holds changes size (its window or card made lower, an
  // answer coming in), till it closes; moved to another window open, it watches that window's area from then on.
  useEffect(() => {
    const element = root.current!, button = from.current, face = area?.current ?? element.offsetParent;
    if (!button || !face) return;
    const view = element.ownerDocument.defaultView ?? window;
    // Measured once what changed has been laid out (the input under the area may take its new height after it).
    let frame = 0;
    const soon = () => { view.cancelAnimationFrame(frame); frame = view.requestAnimationFrame(() => place(element, button, content.current!, face, folded)); };
    const watch = sizeObserver(element, soon);
    watch.observe(face); watch.observe(button);
    // In the folded row the entrance can change width (new last words, or Done appearing) without resizing the face.
    if (area && button.previousElementSibling) watch.observe(button.previousElementSibling);
    watch.observe(content.current!);
    view.addEventListener("resize", soon);
    return () => { watch.disconnect(); view.removeEventListener("resize", soon); view.cancelAnimationFrame(frame); };
  }, [from, area, at]);
  return <div ref={root} inert={closing} aria-busy={closing || undefined} data-coordinator-queue-over role="dialog" aria-label={t("coordinatorCard.waitingMessages")}
    style={folded ? { "--queue-top": "0px" } as CSSProperties : undefined}
    // Folded, it takes the row's own edges (the input's), so nothing of the row shows round it.
    className={cn("pointer-events-auto absolute", folded ? "inset-x-0" : "inset-x-1.5", "[--queue-top:2.875rem] pointer-coarse:[--queue-top:3.125rem] [--queue-bottom:clamp(var(--queue-min-bottom,0.375rem),var(--queue-anchor,0.375rem),calc(100%-var(--queue-top)-var(--queue-height,0px)))] bottom-(--queue-bottom) z-20 isolate flex max-h-[calc(100%-var(--queue-top)-var(--queue-bottom))] flex-col")}>
    {/* Folded, it is the input's own pane; open, it stands 6px inside that pane (inset-x-1.5), so its corner is the pane's less those 6px. */}
    <div ref={surface} aria-hidden className={cn("absolute -inset-px -z-10 border border-lit-line bg-raised shadow-float", folded ? "rounded-pane" : "rounded-[calc(var(--radius-pane)-var(--spacing)*1.5)]")} />
    <div ref={content} className="flex min-h-0 flex-col justify-end">
      {queue.count ? <WaitingRows queue={queue} open={viewer.open} className="min-h-0 overflow-y-auto overscroll-contain py-1 [&>li:first-child]:border-t-0" />
        : <Message tone="empty" size="line" icon="chat" className="px-3 py-3" title={t("coordinatorCard.queueEmpty")} />}
      <div className="flex flex-none items-center border-t border-rule px-0.5 py-0.5 pointer-coarse:py-0">
        <button type="button" data-coordinator-queue-fold aria-expanded onPointerDown={event => event.preventDefault()} onClick={close}
          style={{ marginLeft: "var(--queue-fold-left, 0px)" }}
          className={cn(conversationTool, "border-transparent")}>
          {t("coordinatorCard.waitingCount", { count: queue.count })}<Icon name="down" className="size-3" />
        </button>
      </div>
    </div>
    {viewer.viewer}
  </div>;
}
