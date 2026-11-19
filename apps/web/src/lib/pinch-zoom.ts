/**
 * Past this visual-viewport scale the page counts as pinch-zoomed: a zoom the person can see. Under it (two fingers
 * that brushed the screen, a scale back at normal that does not read exactly 1) the page looks as it does at normal
 * scale, so the app's gestures stay the app's.
 */
const ZOOMED = 1.1;

/** The window is pinch-zoomed: a finger pans the zoomed page, as on any site. */
export const pinchZoomed = (view: Window) => (view.visualViewport?.scale ?? 1) > ZOOMED;

/**
 * What the app's gestures follow: a touch starting and moving, Safari's pinch, a wheel or a trackpad's swipe, a
 * finger's pointer moving and a long press (a touch's context menu). A gesture built on these is held back while
 * pinch-zoomed without asking.
 */
const GESTURES = ["touchstart", "touchmove", "gesturestart", "gesturechange", "wheel", "pointermove", "contextmenu"] as const;
// A pointer's move and a context menu are a mouse's too, and only a finger's are held back.
const heldBack = (event: Event) =>
  (event.type !== "pointermove" && event.type !== "contextmenu") || (event as PointerEvent).pointerType === "touch";
/** On a sheet's handle: nothing but a handle, so a zoomed page never leaves a sheet that will not move. */
const onHandle = (target: EventTarget | null) => !!(target as Partial<Element> | null)?.closest?.("[data-sheet-handle]");

/**
 * Pinch-zoomed, the page is the browser's: a finger or a trackpad pans it up, down and sideways as on any site, and
 * none of the app's own gestures (a swipe, a drag, a pinch or wheel zoom on the time strip, a long press) start, but for
 * a sheet's handle (`data-sheet-handle`), which keeps its finger at any zoom. One
 * guard per window keeps that for every gesture, so none checks the zoom itself. While zoomed, the window's
 * `<body data-pinch-zoomed>` lets the browser pan and zoom on every element (styles.css), and the window's capture
 * phase, ahead of every element and React, stops the events in GESTURES. A press, a lift, a cancel and the click a
 * tap makes still arrive, so a tap, a button and a press outside to close work as at normal scale. A gesture that
 * decides on a held press alone (a timer from pointerdown, as `useLongPress`) is not held back: it reads the mark itself.
 * On a computer zoomed by a trackpad pinch, ctrl or ⌘ + wheel is then the browser's zoom, not the time strip's.
 */
export function guardPinchZoom(view: Window) {
  const body = view.document.body;
  const viewport = view.visualViewport;
  // A pinch changes the visual viewport's scale, and a resize says so.
  const follow = () => body.toggleAttribute("data-pinch-zoomed", pinchZoomed(view));
  // A press begun on a handle is the handle's to its lift, wherever the sheet then captures it (a touch's own events
  // keep the target it began on; a pointer's go to the capture).
  const handles = new Set<number>();
  const press = (event: PointerEvent) => { if (onHandle(event.target)) handles.add(event.pointerId); else handles.delete(event.pointerId); };
  const lift = (event: PointerEvent) => handles.delete(event.pointerId);
  // A lift that never comes (the page hidden mid-press) leaves its id behind only until that id is pressed again.
  const handled = (event: Event) => "pointerId" in event ? handles.has((event as PointerEvent).pointerId) : onHandle(event.target);
  const stop = (event: Event) => { if (pinchZoomed(view) && heldBack(event) && !handled(event)) event.stopImmediatePropagation(); };
  follow();
  viewport?.addEventListener("resize", follow);
  view.addEventListener("pointerdown", press, { capture: true, passive: true });
  view.addEventListener("pointerup", lift, { capture: true, passive: true });
  view.addEventListener("pointercancel", lift, { capture: true, passive: true });
  for (const type of GESTURES) view.addEventListener(type, stop, { capture: true, passive: true });
  return () => {
    viewport?.removeEventListener("resize", follow);
    view.removeEventListener("pointerdown", press, { capture: true });
    view.removeEventListener("pointerup", lift, { capture: true });
    view.removeEventListener("pointercancel", lift, { capture: true });
    for (const type of GESTURES) view.removeEventListener(type, stop, { capture: true });
    body.removeAttribute("data-pinch-zoomed");
  };
}
