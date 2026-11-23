import { expect, test } from 'vitest';
import { AXIS_JOIN_MS, joinBusy, type Busy } from '@alpacawork/contract';
import { atOf, buildAxis, shownScaleMs, xOf, zoomFor } from '../src/features/tree/time-line';

const minute = 60_000, hour = 60 * minute, now = Date.parse('2026-10-20T10:00:00Z');
test('activity compaction respects the exact fold threshold and keeps open work bounded by now', () => {
  expect(joinBusy([[0, 0], [AXIS_JOIN_MS - 1, AXIS_JOIN_MS - 1]])).toEqual([[0, AXIS_JOIN_MS - 1]]);
  expect(joinBusy([[0, 0], [AXIS_JOIN_MS, AXIS_JOIN_MS]])).toHaveLength(2);
  expect(joinBusy([[0, null], [100, null], [now + hour, now + hour]])).toEqual([[0, null], [now + hour, now + hour]]);
});

test('full-lifetime compaction preserves axis geometry across clips, zooms and open work', () => {
  let seed = 279;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 120; trial++) {
    const spans: [number, number | null][] = Array.from({ length: 25 }, () => {
      const from = now - Math.floor(random() * 100 * hour);
      return [from, random() < 0.12 ? null : from + Math.floor(random() * 2 * hour)];
    });
    const compact = joinBusy(spans);
    for (const view of [20 * minute, hour, 6 * hour, 24 * hour, 7 * 24 * hour, 30 * 24 * hour]) {
      const axis = (busy: Busy) => buildAxis(now - 72 * hour, now + hour, now, busy, 1000, view);
      const raw = axis(spans), joined = axis(compact);
      expect(joined.at(-1)!.x1).toBeCloseTo(raw.at(-1)!.x1, 7);
      expect(joined.filter(piece => piece.gap).map(piece => [piece.from, piece.to]))
        .toEqual(raw.filter(piece => piece.gap).map(piece => [piece.from, piece.to]));
      for (const [at] of spans) expect(xOf(joined, at)).toBeCloseTo(xOf(raw, at), 7);
      expect(shownScaleMs(joined, 1000)).toBeCloseTo(shownScaleMs(raw, 1000), 2);
      for (const x of [0, 1, 100, 333.3, 700, 999])
        expect(atOf(joined, x)).toBeCloseTo(atOf(raw, x), 0);
    }
  }
});

test('with no zoom chosen, a history shorter than a day is shown whole, not from a day back', () => {
  const day = 24 * 3_600_000, hour = 3_600_000;
  expect(zoomFor(null, hour)).toBe(hour);
  expect(zoomFor(null, 3 * day)).toBe(day);
  expect(zoomFor('all', 3 * day)).toBe(3 * day);
  expect(zoomFor(2 * hour, 3 * day)).toBe(2 * hour);
});
