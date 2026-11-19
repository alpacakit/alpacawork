import { describe, expect, it } from 'vitest';
import { endOf, lengthFor, resting, retarget, sampleAt, shapeStyle, transition, type Leg } from '../src/features/reader/answer-cue-motion';

const card = { x: 100, y: 100, width: 240, height: 44 };
const chip = { x: 600, y: 700, width: 80, height: 24 };
const incoming: Leg = { from: resting(card, 0), toward: 1, velocity: null, correction: null, length: 640 };

describe('the answer shape', () => {
  it('starts at the card, bows above the straight line, and lands exactly at the moving chip', () => {
    expect(sampleAt(incoming, chip, 0)).toEqual(incoming.from);
    const middle = sampleAt(incoming, chip, 0.4);
    const onLine = card.y + (chip.y - card.y) * (middle.box.x - card.x) / (chip.x - card.x);
    expect(middle.box.y).toBeLessThan(onLine);
    const moved = { ...chip, x: 800, y: 750 };
    expect(sampleAt(incoming, moved, 1).box).toEqual(moved);
    expect(sampleAt(incoming, moved, 1).look).toBe(1);
  });

  it('never overlaps the card and chip words, and keeps a solid face all the way in', () => {
    for (let i = 0; i <= 100; i++) {
      const sample = sampleAt(incoming, chip, i / 100);
      expect(sample.cardWords * sample.chipWords).toBe(0);
      expect(sample.opacity).toBe(1);
      expect(sample.box.width).toBeGreaterThanOrEqual(chip.width);
      expect(sample.box.width).toBeLessThanOrEqual(card.width);
    }
  });

  it('turns from the exact drawn shape with the same velocity, then dissolves into the card', () => {
    const from = sampleAt(incoming, chip, 0.08), velocity = { x: 0.8, y: 0.5, width: -0.1, height: -0.02 };
    const back: Leg = { from, velocity, toward: 0, correction: null, length: 600 };
    const start = sampleAt(back, card, 0);
    for (const key of ['look', 'opacity', 'cardWords', 'chipWords', 'lift'] as const) expect(start[key]).toBeCloseTo(from[key], 12);
    expect(start.box).toEqual(from.box);
    const next = sampleAt(back, card, 0.000001);
    expect((next.box.x - from.box.x) / (back.length * 0.000001)).toBeCloseTo(velocity.x, 3);
    expect((next.box.y - from.box.y) / (back.length * 0.000001)).toBeCloseTo(velocity.y, 3);
    const end = sampleAt(back, card, 1);
    expect(end.box).toEqual(card);
    expect(end.opacity).toBe(0);
    const again: Leg = { from: sampleAt(back, card, 0.2), velocity, toward: 1, correction: null, length: 600 };
    expect(sampleAt(again, chip, 0).box).toEqual(again.from.box);
    expect(sampleAt(again, chip, 0).opacity).toBeCloseTo(again.from.opacity);
    expect(sampleAt(again, chip, 1).box).toEqual(chip);
    for (let i = 0; i <= 100; i++) {
      const turned = sampleAt(again, chip, i / 100);
      expect(turned.cardWords * turned.chipWords).toBe(0);
      expect(turned.lift).toBeGreaterThanOrEqual(0);
      expect(turned.lift).toBeLessThanOrEqual(1);
      expect(turned.opacity).toBeGreaterThanOrEqual(0);
      expect(turned.opacity).toBeLessThanOrEqual(1);
    }
  });

  it('retargets a wider answer from the exact shape and all four measured velocities', () => {
    const from = sampleAt(incoming, chip, 0.7), previous = sampleAt(incoming, chip, 0.68);
    const velocity = Object.fromEntries(Object.keys(from.box).map(key => [key,
      (from.box[key as keyof typeof from.box] - previous.box[key as keyof typeof from.box]) / 12.8])) as typeof from.box;
    const wider = { ...chip, x: chip.x + 60, width: chip.width + 120 };
    const redirected = retarget(incoming, wider, 0.7, from.box, velocity, 120);
    expect(redirected.length).toBe(incoming.length);
    expect(redirected.from).toBe(incoming.from);
    const start = sampleAt(redirected, wider, 0.7), next = sampleAt(redirected, wider, 0.700001);
    expect(start.box).toEqual(from.box);
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect((next.box[key] - from.box[key]) / 0.00064).toBeCloseTo(velocity[key], 3);
    expect(start.look).toBe(from.look);
    expect(sampleAt(redirected, wider, 1).box).toEqual(wider);
    const second = retarget(redirected, chip, 0.8, sampleAt(redirected, wider, 0.8).box, velocity, 120);
    for (const at of [0.05, 0.3, 0.7]) {
      const changed = retarget(incoming, wider, at, sampleAt(incoming, chip, at).box, velocity, 120);
      for (const progress of [at, Math.max(at, 0.13), Math.max(at, 0.14), Math.max(at, 0.35), 1]) {
        const expected = sampleAt(incoming, chip, progress), actual = sampleAt(changed, wider, progress);
        for (const key of ['look', 'cardWords', 'chipWords', 'opacity', 'lift'] as const) expect(actual[key]).toBe(expected[key]);
      }
    }
    expect(second.length).toBe(incoming.length);
    expect(sampleAt(second, chip, 1).box).toEqual(chip);
  });

  it('reserves a fast correction near and after the original deadline without resetting the word clock', () => {
    const wider = { ...chip, width: 176 };
    const same = retarget(incoming, chip, 0.95, sampleAt(incoming, chip, 0.95).box, { x: 0, y: 0, width: 0, height: 0 }, 120);
    expect(endOf(same)).toBe(1);
    for (const at of [0.95, 1, 1.05]) {
      const from = sampleAt(incoming, chip, at), changed = retarget(incoming, wider, at, from.box, { x: 0, y: 0, width: 0, height: 0 }, 120);
      expect((endOf(changed) - at) * changed.length).toBeCloseTo(120);
      expect(sampleAt(changed, wider, at).box).toEqual(from.box);
      let previous = from.box.width;
      for (let elapsed = 16; elapsed < 120; elapsed += 16) {
        const next = sampleAt(changed, wider, at + elapsed / changed.length);
        expect(Math.abs(next.box.width - previous)).toBeLessThan(24);
        expect(next.look).toBe(sampleAt(incoming, chip, at + elapsed / changed.length).look);
        previous = next.box.width;
      }
      expect(sampleAt(changed, wider, endOf(changed)).box).toEqual(wider);
    }
  });

  it('interpolates the whole surface over an opaque ground without scaling the words', () => {
    const cardLook = { radius: 8, background: 'pink', ground: 'white', border: 'red' };
    const chipLook = { radius: 999, background: 'white', ground: 'white', border: 'blue' };
    const start = shapeStyle(cardLook, chipLook, incoming.from);
    expect(start.borderRadius).toBe('8px');
    const middle = shapeStyle(cardLook, chipLook, sampleAt(incoming, chip, 0.5));
    expect(middle.backgroundColor).toBe('var(--lit)');
    expect(middle.backgroundImage).not.toBe(start.backgroundImage);
    expect(middle.transform).not.toContain('scale');
    const end = shapeStyle(cardLook, chipLook, sampleAt(incoming, chip, 1));
    expect(end.borderRadius).toBe('12px');
    expect(end.borderColor).not.toBe(start.borderColor);
  });

  it('uses the same destination rule for addition, replacement, cancellation and repeated interruption', () => {
    expect(transition(null, 1, false)).toBe('start');
    expect(transition(null, 0, false)).toBe('start');
    expect(transition(1, 1, false)).toBe('continue');
    expect(transition(0, 0, false)).toBe('continue');
    expect(transition(1, 0, false)).toBe('turn');
    expect(transition(0, 1, false)).toBe('turn');
    expect(transition(1, 1, true)).toBe('retarget');
    expect(lengthFor(320, card, chip)).toBeGreaterThan(550);
    expect(lengthFor(320, card, { x: 2000, y: 2000 })).toBeCloseTo(704);
  });
});
