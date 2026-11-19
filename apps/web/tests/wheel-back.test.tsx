import { expect, test } from 'vitest';
import { wheelBackStep, type WheelGesture } from '../src/features/reader/wheel-back';

type Event = { deltaX: number; deltaY?: number; at: number; shift?: boolean; cancelable?: boolean; scrollsBack?: boolean };
const run = (events: Event[]) => {
  let gesture: WheelGesture | null = null;
  return events.map(({ deltaX, deltaY = 0, at, shift = false, cancelable = true, scrollsBack = false }) => {
    const step = wheelBackStep(gesture, { deltaX, deltaY, keys: shift, cancelable, scrollsBack: () => scrollsBack, at });
    gesture = step.gesture;
    return step;
  });
};
// A trackpad swipe back: a touch that moves nothing, then steady steps toward the start and their momentum.
const swipe = (from: number, step: Partial<Event> = {}): Event[] =>
  [{ deltaX: 0, at: from }, ...Array.from({ length: 30 }, (_, i) => ({ deltaX: -30, at: from + 16 * (i + 1), ...step }))];

test('one swipe back over the reader goes back once, momentum included, and the next swipe goes back again', () => {
  const steps = run([...swipe(0), ...swipe(2000)]);
  expect(steps.filter(step => step.back)).toHaveLength(2);
  expect(steps.slice(1, 31).every(step => step.prevent)).toBe(true);
});

test('up and down, toward the end, Shift, what can still scroll back, and a swipe the page cannot take stay the browser\'s', () => {
  for (const first of [{ deltaX: -5, deltaY: 20 }, { deltaX: 40 }, { deltaX: -40, shift: true }, { deltaX: -40, scrollsBack: true }, { deltaX: -40, cancelable: false }]) {
    const steps = run([{ ...first, at: 0 }, ...Array.from({ length: 10 }, (_, i) => ({ deltaX: -40, at: 16 * (i + 1) }))]);
    expect(steps.some(step => step.prevent || step.back)).toBe(false);
  }
});
