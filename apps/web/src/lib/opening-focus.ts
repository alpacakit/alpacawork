import { createContext, useEffectEvent, useLayoutEffect, useRef, type RefObject } from "react";

/** The reader's one input DOM target, including a form rendered through a portal. React alone writes this ref. */
export const OpeningForm = createContext<RefObject<HTMLFormElement | null> | null>(null);

/** True once this request can finish in its form. A later choice inside the form keeps its selection. */
export function focusOpeningForm(form: HTMLFormElement | null): boolean {
  if (!form) return false;
  if (form.contains(document.activeElement)) return true;
  const first = form.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select, [role=radio][aria-checked=true], [role=radio]");
  first?.focus();
  // Only text fields have a caret; a radio or checkbox refuses a selection range.
  if ((first instanceof HTMLInputElement && first.selectionStart !== null) || first instanceof HTMLTextAreaElement)
    first.setSelectionRange(first.value.length, first.value.length);
  return true;
}

/** A ready destination finishes the request even when a later, still-live choice keeps focus. */
type OpeningStep = { complete: boolean; focus: () => void };

/** One finite request keyed by the opening intent. A later choice owns focus while it exists.
 * If that control disappears before the target arrives, the same opening can continue from BODY.
 * A commit can make the target available; it never restarts a completed request.
 * `resolve` learns the intent this one directly follows, so that one merely ending can begin nothing. */
export function useOpeningFocus(request: unknown, resolve: (previous: unknown) => (() => OpeningStep) | null) {
  const resolveOpeningTarget = useEffectEvent(resolve);
  const pending = useRef<{ schedule: () => void } | null>(null);
  const current = useRef<unknown>(null);
  useLayoutEffect(() => {
    // React may run the same request's effect again (StrictMode); that follows nothing.
    const previous = current.current === request ? null : current.current;
    current.current = request;
    if (!request) return;
    const advance = resolveOpeningTarget(previous);
    if (!advance) return;
    let frame: number | null = null;
    let chosen: Element | null = null;
    const choose = (event: FocusEvent) => { if (event.target instanceof Element) chosen = event.target; };
    const finish = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (pending.current === owner) pending.current = null;
      document.removeEventListener("focusin", choose, true);
    };
    const owner = { schedule: () => {
      if (pending.current !== owner || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        document.removeEventListener("focusin", choose, true);
        try {
          const step = advance();
          // A removed Retry/control cannot retain focus; a surviving Tab choice can.
          if (!chosen || (!chosen.isConnected && document.activeElement === document.body)) {
            chosen = null;
            step.focus();
          }
          if (step.complete) finish();
          else document.addEventListener("focusin", choose, true);
        } catch (error) { finish(); throw error; }
      });
    } };
    pending.current = owner;
    // Blur retains the browser's sequential Tab starting position; focusing the heading here would change it.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.addEventListener("focusin", choose, true);
    owner.schedule();
    return finish;
  }, [request]);
  useLayoutEffect(() => { pending.current?.schedule(); });
}
