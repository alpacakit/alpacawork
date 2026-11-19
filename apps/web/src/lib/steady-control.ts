import { useEffect, useRef, useState } from 'react';

/**
 * How long a control must stay unusable before it looks disabled. Reads, a message's admission and a reconnection
 * each end well inside a second; past a second a person waiting needs to be told why nothing happens.
 */
export const UNUSABLE_SHOWN_AFTER_MS = 1000;
/** Once it looks disabled it stays so this long, so a wait barely over the first does not flash either. */
export const UNUSABLE_SHOWN_FOR_MS = 500;

type Pressed = { currentTarget: EventTarget | null; preventDefault(): void };

/**
 * The one rule for a control that is unusable for a moment (`blocked`: its own guard, unchanged): it looks disabled
 * only once that has lasted (UNUSABLE_SHOWN_AFTER_MS), so the short waits of ordinary use do not blink it. Mounted
 * blocked, it starts disabled: nothing is shown usable that was not.
 * A press while it is blocked but still looks usable is never run against the guard: it is kept, and pressed again
 * on the same control when the block ends, where every guard of that moment meets it as a press of the person's
 * would. Controls that share one guard (a question's choices) each keep their own press, in the order pressed; one
 * control keeps one, its last (pressed again, it stands last, on what the person saw then), so it never runs twice.
 * A press is dropped when the controls come to look disabled, when
 * its control is gone, or when what the person saw (`seen`: the version acted on, the words to send) is no longer
 * what it would act on. What a control's own press makes unusable (sending, accepted) is the caller's to disable at
 * once, beside `disabled`: that is its answer to the press, and takes no second one.
 */
export function useSteadyControl(blocked: boolean, seen?: unknown) {
  const [dimmed, setDimmed] = useState(blocked);
  const kept = useRef<{ control: HTMLElement; seen: unknown }[]>([]);
  /** Until when it keeps looking disabled once usable again; mounted blocked, it owes no such stay. */
  const stays = useRef(0);
  const latest = useRef({ blocked, seen });
  latest.current = { blocked, seen };
  const disabled = dimmed && (blocked || Date.now() < stays.current);
  useEffect(() => {
    if (blocked) {
      if (dimmed) return;
      const timer = setTimeout(() => { kept.current = []; stays.current = Date.now() + UNUSABLE_SHOWN_FOR_MS; setDimmed(true); }, UNUSABLE_SHOWN_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (dimmed) {
      const rest = stays.current - Date.now();
      if (rest <= 0) { setDimmed(false); return; }
      const timer = setTimeout(() => setDimmed(false), rest);
      return () => clearTimeout(timer);
    }
    const presses = kept.current;
    kept.current = [];
    for (const { control, seen } of presses) if (control.isConnected && Object.is(seen, latest.current.seen)) control.click();
  }, [blocked, dimmed]);
  /** The control's onClick: `run` when usable; blocked, the press is kept and its default (a form's submit) held back. */
  const press = <E extends Pressed>(run?: (event: E) => void) => (event: E) => {
    if (!latest.current.blocked) { run?.(event); return; }
    event.preventDefault();
    const control = event.currentTarget;
    if (!dimmed && control instanceof HTMLElement) kept.current = [...kept.current.filter(each => each.control !== control), { control, seen: latest.current.seen }];
  };
  return { disabled, press };
}
