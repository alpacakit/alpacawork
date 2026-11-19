/** IME state belongs to the field, including the confirming key just after compositionend. */
const compositions = new WeakMap<EventTarget, { active: boolean; ended: number }>();
function compositionStarted(target: EventTarget) { compositions.set(target, { active: true, ended: -Infinity }); }
function compositionEnded(target: EventTarget) { compositions.set(target, { active: false, ended: performance.now() }); }
export function isComposingTarget(target: EventTarget | null | undefined): boolean {
  const state = target ? compositions.get(target) : undefined;
  return !!state && (state.active || performance.now() - state.ended < 50);
}
export function isComposingKey(event: { nativeEvent?: { isComposing?: boolean }; isComposing?: boolean; keyCode: number; target?: EventTarget | null }): boolean {
  return (event.nativeEvent?.isComposing ?? event.isComposing ?? false) || event.keyCode === 229 || isComposingTarget(event.target);
}
// Observe native composition before the shared document-level Escape handler.
// React's composition plugin can finish its synthetic session before the final native key.
const observed = new WeakSet<Document>();
export function observeComposition(document: Document) {
  if (observed.has(document)) return;
  observed.add(document);
  document.addEventListener("compositionstart", event => { if (event.target) compositionStarted(event.target); }, true);
  document.addEventListener("compositionend", event => { if (event.target) compositionEnded(event.target); }, true);
  document.addEventListener("keydown", event => {
    if (event.target && (event.isComposing || event.keyCode === 229)) {
      compositions.set(event.target, { active: compositions.get(event.target)?.active ?? false, ended: performance.now() });
    }
  }, true);
  document.addEventListener("submit", event => {
    if (isComposingTarget(document.activeElement)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
}

if (typeof document !== "undefined") observeComposition(document);
