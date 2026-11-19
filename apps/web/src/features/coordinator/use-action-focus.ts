import { useCallback, useLayoutEffect, useRef, type FocusEvent } from 'react';

function operationButton(place: HTMLElement, identity: string | null) {
  const buttons = [...place.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  return buttons.find(button => button.dataset.actionFocusTarget === identity) ?? buttons[0];
}
/** One successor rule for disappearing operations: the following place, its queue, then the input in this surface. */
function successor(place: HTMLElement, identity: string | null) {
  const scope = place.closest<HTMLElement>('[data-action-focus-scope]');
  const places = scope ? [...scope.querySelectorAll<HTMLElement>('[data-action-focus-place]')] : [];
  const following = places.slice(places.indexOf(place) + 1);
  const inputArea = place.ownerDocument.querySelector('[data-one-input-area]');
  return () => {
    const next = following.find(each => each.isConnected && !each.closest('[inert]') && operationButton(each, identity));
    if (next) return operationButton(next, identity) ?? next;
    if (scope?.isConnected && !scope.closest('[inert]')) return scope;
    return inputArea?.isConnected ? inputArea.querySelector<HTMLElement>('[data-one-input]') : null;
  };
}
/** A replaced operation keeps focus here; one removed on success hands it to the next operable place. */
export function useActionFocus() {
  const ref = useRef<HTMLElement | null>(null), focused = useRef<Element | null>(null);
  const identity = useRef<string | null>(null);
  const next = useRef<ReturnType<typeof successor>>(() => null);
  const attach = useCallback((place: HTMLElement | null) => {
    const previous = ref.current;
    if (!place && previous && focused.current) {
      const owned = focused.current, follow = next.current;
      queueMicrotask(() => {
        if (!owned.isConnected && previous.ownerDocument.activeElement === previous.ownerDocument.body)
          follow()?.focus({ preventScroll: true });
      });
    }
    ref.current = place;
  }, []);
  useLayoutEffect(() => {
    const place = ref.current;
    if (!place) return;
    const page = place.ownerDocument;
    if (page.activeElement === place || focused.current && !focused.current.isConnected && page.activeElement === page.body) {
      const target = place.querySelector('[role=status]') ? place : operationButton(place, identity.current) ?? place;
      if (page.activeElement !== target) target.focus({ preventScroll: true });
    }
    focused.current = place.contains(page.activeElement) ? page.activeElement : null;
    if (focused.current) next.current = successor(place, identity.current);
  });
  return { ref: attach, tabIndex: -1, 'data-action-focus-place': '',
    onFocusCapture: (event: FocusEvent<HTMLElement>) => {
      const place = ref.current;
      if (place) {
        const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action-focus-target]');
        if (target) identity.current = target.dataset.actionFocusTarget ?? null;
        focused.current = place.ownerDocument.activeElement; next.current = successor(place, identity.current);
      }
    },
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { focused.current = null; identity.current = null; }
    } };
}
