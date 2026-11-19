import { expect, test } from 'vitest';
import { atLargest, atRight, besidePanel, EDGE, FIRST, LEAST_WIDTH, SIDE, placeFrame, placeMaximized, pushedAcross, pushingPanel, type Frame, type Room } from '../src/features/coordinator/frame';
import { moved, sized, type FrameHand } from '../src/features/coordinator/frame-hand';

const whole: Room = { left: 0, right: 1600, top: 12, reach: 12, bottom: 900, widest: 760 };
const byLeft: Frame = { side: 'left', x: SIDE, edge: 'bottom', y: 12, width: 440, height: 400 };
const besideFrom = (left: number | null) => besidePanel(whole, left === null ? null : { left });
const drawn = (frame: Frame, readerLeft: number | null) => placeFrame(frame, besideFrom(readerLeft), 50, false);

test('it narrows where it stands as the reader widens, as far from it as the reader is from the window, down to its least', () => {
  expect(drawn(byLeft, 1000)).toMatchObject({ left: SIDE, width: 440 });
  expect(drawn(byLeft, 400)).toMatchObject({ left: SIDE, width: 400 - EDGE - SIDE });
  // Past its least the reader goes over it; it neither narrows further nor moves.
  expect(drawn(byLeft, 200)).toMatchObject({ left: SIDE, width: LEAST_WIDTH });
  // The reader narrowed again, it is as wide as it was kept.
  expect(drawn(byLeft, 1200)).toMatchObject({ left: SIDE, width: 440 });
});

test('by the reader\'s side, it stands beside the reader; where it first stands, in the middle of the room, 600px wide', () => {
  expect(drawn({ ...byLeft, side: 'right' }, 1000)).toMatchObject({ left: 1000 - EDGE - 440, width: 440 });
  const room = besideFrom(1000), first = drawn(FIRST, 1000);
  expect(first.width).toBe(600);
  expect(first.left).toBe(Math.round((room.left + room.right - 600) / 2));
});

test('maximized beside the reader, it is at its largest there', () => {
  const room = besideFrom(600);
  const most = placeMaximized(placeFrame(byLeft, room, 50, true), room);
  expect(most.left + most.width).toBe(600 - EDGE);
  expect(atLargest(most, room)).toBe(true);
});

/** The hand holding `frame` as drawn beside a reader from `readerLeft`, open. */
function holding(frame: Frame, readerLeft: number) {
  let kept = frame;
  const room = besideFrom(readerLeft), placed = placeFrame(frame, room, 50, true);
  const hand = { frame: () => kept, expanded: () => true } as FrameHand;
  return { hand, start: { placed, room, input: 50, top: placed.top - placed.height, foot: placed.foot }, keep: (next: Frame) => { kept = next; } };
}

test('narrowed beside the reader, sized up and down or moved up and down, it is kept where and as wide as it was', () => {
  const { hand, start } = holding(byLeft, 400);
  const taller = sized(hand, start, null, true, true, 0, -24).frame, higher = moved(hand, start, 0, -16);
  for (const next of [taller, higher]) {
    expect(next).toMatchObject({ side: 'left', x: SIDE, width: 440 });
    expect(drawn(next, null)).toMatchObject({ left: SIDE, width: 440 });
  }
});

test('at its least beside the reader, a side pulled leaves the other side where it is', () => {
  const at = { ...byLeft, x: 300 }, { hand, start, keep } = holding(at, 400);
  const before = drawn(at, 400);
  const pulled = sized(hand, start, 'right', false, true, 1, 0).frame;
  keep(pulled);
  expect(drawn(pulled, 400).left).toBe(before.left);
});

test('narrowed beside the reader and moved across, it goes on from under the hand', () => {
  const at = { ...byLeft, x: 300 }, { hand, start } = holding(at, 700);
  const before = drawn(at, 700), after = drawn(moved(hand, start, 1, 0), 700);
  expect(Math.abs(after.left - before.left - 1)).toBeLessThanOrEqual(1);
  expect(after.width).toBe(before.width);
});

test('at its least and moved towards the window\'s side, it stays as far from the reader as the reader is from the window', () => {
  const at = drawn({ ...byLeft, x: 300 }, 400);
  expect(at).toMatchObject({ width: LEAST_WIDTH });
  expect(400 - (at.left + at.width)).toBe(EDGE);
});

test('pushed by the reader to the window\'s other side at its least, it stays there and widens away from it as the reader narrows', () => {
  expect(pushedAcross(FIRST, drawn(FIRST, 1000), besideFrom(1000), true)).toBeNull();
  // Only narrowed by the reader, it is not pushed: given its room back, it is where it was.
  expect(pushedAcross(FIRST, drawn(FIRST, 500), besideFrom(500), true)).toBeNull();
  const pushed = pushedAcross(FIRST, drawn(FIRST, 300), besideFrom(300), true);
  expect(pushed).toMatchObject({ side: 'left', x: SIDE, width: 600 });
  expect(drawn(pushed!, 1200)).toMatchObject({ left: SIDE, width: 600 });
  // Put by the hand away from the reader, it is not pushed anywhere.
  expect(pushedAcross(byLeft, drawn(byLeft, 300), besideFrom(300), true)).toBeNull();
});

test('only the panel coming further in while the person holds the reader\'s edge pushes it across', () => {
  expect(pushingPanel(true, 600, 900)).toBe(true);
  // The window sized or the type size changed (nothing held), the panel not further in, or just opened.
  expect(pushingPanel(false, 600, 900)).toBe(false);
  expect(pushingPanel(true, 900, 900)).toBe(false);
  expect(pushingPanel(true, 600, undefined)).toBe(false);
});

test('a file read beside the reader moved to the window\'s left: it stays left of the file, over the reader, as it stood', () => {
  // The reader 12..612 at the window's right; the file opened, the reader 12..612 at the left and the file 624..1588.
  const reader = { left: whole.right - 12 - 600 }, beside = [{ left: 12 }, { left: 624 }];
  expect(atRight(beside)).toEqual({ left: 624 });
  const before = placeFrame(byLeft, besidePanel(whole, atRight([reader])), 50, true);
  const after = placeFrame(byLeft, besidePanel(whole, atRight(beside)), 50, true);
  expect(after).toEqual(before);
  expect(after.left + after.width).toBeLessThanOrEqual(624 - EDGE);
});
