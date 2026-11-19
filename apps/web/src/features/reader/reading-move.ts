/** Observe the person's intent to move vertically, rather than every activation in the reading column.
 * Pressing a control (including with Enter/Space) or starting a touch does not choose a new reading position. */
export function onReadingMove(area: HTMLElement, move: (event: Event) => void): () => void {
  const wheel = (event: WheelEvent) => { if (event.deltaY !== 0 && !event.ctrlKey) move(event); };
  let touch: { x: number; y: number } | undefined;
  const touchstart = (event: TouchEvent) => {
    const first = event.touches.length === 1 && event.composedPath().includes(area) ? event.touches[0] : undefined;
    touch = first ? { x: first.clientX, y: first.clientY } : undefined;
  };
  const touchmove = (event: TouchEvent) => {
    if (event.touches.length !== 1) { touch = undefined; return; }
    // A surface (such as sheet-press) may own this finger and cancel native scrolling in bubble.
    // Observe that result at the window, after the surface, rather than deciding ownership again here.
    if (event.defaultPrevented || !event.composedPath().includes(area)) return;
    const first = event.touches[0];
    if (touch && first && Math.abs(first.clientY - touch.y) > 5
      && Math.abs(first.clientY - touch.y) > Math.abs(first.clientX - touch.x)) move(event);
  };
  const touchend = () => { touch = undefined; };
  const pointerdown = (event: PointerEvent) => {
    // The native scrollbar's gutter is outside the client box. Presses on content activate/select it.
    const box = area.getBoundingClientRect();
    const x = event.clientX - box.left;
    if (event.target === area && event.button === 0 && area.offsetWidth > area.clientWidth
      && (x < area.clientLeft || x >= area.clientLeft + area.clientWidth)) move(event);
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!(event.target instanceof Element) || event.target.closest('input,textarea,select,[contenteditable],[role="textbox"],[role="slider"],[role="combobox"],[role="listbox"],[role="menu"],[role="tablist"]')) return;
    if (event.key === ' ' && event.target.closest('button,[role="button"]')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) move(event);
  };
  const events = { wheel, pointerdown, keydown };
  const view = area.ownerDocument.defaultView!;
  view.addEventListener('touchstart', touchstart, { capture: true, passive: true });
  view.addEventListener('touchmove', touchmove, { passive: true });
  view.addEventListener('touchend', touchend, { capture: true, passive: true });
  view.addEventListener('touchcancel', touchend, { capture: true, passive: true });
  for (const [type, listener] of Object.entries(events)) area.addEventListener(type, listener as EventListener, { capture: true, passive: true });
  return () => {
    for (const [type, listener] of Object.entries(events)) area.removeEventListener(type, listener as EventListener, true);
    view.removeEventListener('touchstart', touchstart, true);
    view.removeEventListener('touchmove', touchmove);
    view.removeEventListener('touchend', touchend, true);
    view.removeEventListener('touchcancel', touchend, true);
  };
}
