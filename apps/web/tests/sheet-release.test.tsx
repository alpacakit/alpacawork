import { describe, expect, it } from 'vitest';
import { sheetRelease } from '../src/features/coordinator/sheet-release';

// Held by the foot, the sheet draws twice the finger's way; whether a release is a flick is the finger's alone.
describe('a sheet let go', () => {
  it('flicks only on the finger\'s own way, not on the height a foot hold doubled', () => {
    const from = 506, most = 667;
    // The finger went 10px up in 16ms (a fast slip under the flick's 12px); the doubled height went 20px.
    expect(sheetRelease({ from, to: from + 20, far: 10, trail: [[0, from], [16, from + 10]], at: 16, most })).toEqual({ kind: 'rest', height: from + 20 });
    // 12px of the finger's own way, as fast, is a flick to the tallest.
    expect(sheetRelease({ from, to: from + 24, far: 12, trail: [[0, from], [16, from + 12]], at: 16, most })).toEqual({ kind: 'rest', height: most });
  });
});
