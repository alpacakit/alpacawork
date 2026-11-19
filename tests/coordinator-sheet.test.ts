import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sheetRelease } from '../apps/web/src/features/coordinator/sheet-release.ts';
// By default the finger came to `to` and stayed there: no speed.
const release = (from: number, to: number, trail: [number, number][] = [[0, to], [100, to]], at = 100, most = 600) => sheetRelease({ from, to, trail, at, most });
test('sheet release uses the drawn height, including screens drawing less than 160px', () => {
  for (const from of [100, 140, 160, 320, 360, 600]) {
    const floor = Math.min(160, from);
    assert.deepEqual(release(from, floor - 48), { kind: 'rest', height: 160 });
    assert.deepEqual(release(from, floor - 49), { kind: 'close' });
  }
  assert.deepEqual(release(100, 90, undefined, 100, 100), { kind: 'rest', height: 100 });
});
test('flick needs more than .5 px/ms, 12px travel and a move in the last 80ms', () => {
  assert.deepEqual(release(360, 348, [[20, 360], [40, 348]], 100), { kind: 'close' });
  assert.deepEqual(release(360, 348, [[20, 360], [40, 348]], 121), { kind: 'rest', height: 348 });
  // Frames slower than 80ms (a busy phone) still give the speed between the last two moves.
  assert.deepEqual(release(360, 240, [[0, 360], [120, 240]], 130), { kind: 'close' });
  assert.deepEqual(release(360, 349, [[80, 360], [90, 349]]), { kind: 'rest', height: 349 });
  assert.deepEqual(release(360, 348, [[70, 360], [94, 348]]), { kind: 'rest', height: 348 });
  assert.deepEqual(release(360, 372, [[80, 360], [90, 372]]), { kind: 'rest', height: 600 });
  assert.deepEqual(release(100, 112, [[80, 100], [90, 112]], 100, 100), { kind: 'rest', height: 100 });
});
test('a stationary grip, cancellation and no move do not flick or commit a height', () => {
  assert.deepEqual(release(360, 340, [[0, 360], [20, 340]], 200), { kind: 'rest', height: 340 });
  assert.deepEqual(sheetRelease({ from: 360, to: 0, trail: [], at: 100, most: 600, cancelled: true }), { kind: 'cancel' });
  // Pressed and let go without a move is a tap, which sizes nothing (and says how it is sized).
  assert.deepEqual(sheetRelease({ from: 360, to: null, trail: [], at: 100, most: 600 }), { kind: 'tap' });
});
