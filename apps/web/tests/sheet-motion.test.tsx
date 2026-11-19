import { afterEach, describe, expect, it, vi } from 'vitest';
import { sheetLanding, sheetMotion } from '../src/lib/sheet-motion';

afterEach(() => vi.unstubAllGlobals());

describe('a held sheet', () => {
  // Its one-pixel top edge is drawn on one row of screen pixels only while the sheet stands on whole pixels.
  it('moves by whole screen pixels, so its top edge stays one pixel row while a finger drags it', () => {
    vi.stubGlobal('devicePixelRatio', 2.625);
    const el = document.createElement('div');
    const motion = sheetMotion(el, { most: () => 860, bottom: () => 860, stand: () => 400 });
    for (const height of [400, 412.37, 433.9, 501.05]) {
      motion.hold(height);
      const y = Number(/translateY\((-?[\d.]+)px\)/.exec(el.style.transform)?.[1]);
      expect(Math.abs(y * 2.625 - Math.round(y * 2.625))).toBeLessThan(1e-6);
      expect(Math.abs(y - (860 - height))).toBeLessThanOrEqual(0.5 / 2.625 + 1e-9);
    }
  });
});

describe('a sheet let go', () => {
  const screen = 800, rests = [200, 680] as const;
  it('goes whole, rests or goes away by one rule; a surface with no rests goes away where a sheet would rest', () => {
    expect(sheetLanding({ height: 780, from: 800, speed: 0, screen, rests: null })).toEqual({ to: 'whole' });
    expect(sheetLanding({ height: 500, from: 800, speed: 0, screen, rests })).toEqual({ to: 'rest', height: 500 });
    expect(sheetLanding({ height: 500, from: 800, speed: 0, screen, rests: null })).toEqual({ to: 'away' });
    expect(sheetLanding({ height: 790, from: 800, speed: -1, screen, rests: null })).toEqual({ to: 'away' });
  });
});
