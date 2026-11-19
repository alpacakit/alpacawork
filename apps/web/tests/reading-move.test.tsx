import { expect, test, vi } from 'vitest';
import { onReadingMove } from '../src/features/reader/reading-move';

test('activation, typing, horizontal movement and zoom retain restoration; vertical navigation takes over', () => {
  const area = document.createElement('div'), button = document.createElement('button'), input = document.createElement('textarea');
  area.append(button, input); document.body.append(area);
  const move = vi.fn(), stop = onReadingMove(area, move);
  const key = (target: HTMLElement, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key }));
  const touch = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: x, clientY: y }] }); area.dispatchEvent(event);
  };
  try {
    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    key(button, 'Enter'); key(button, ' '); key(area, 'Tab'); key(input, 'PageDown');
    area.dispatchEvent(new WheelEvent('wheel', { deltaX: 100 }));
    area.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true }));
    touch('touchstart', 100, 100); touch('touchmove', 130, 101);
    expect(move).not.toHaveBeenCalled();
    area.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    key(area, 'ArrowDown'); key(button, 'PageDown'); touch('touchmove', 100, 130);
    Object.defineProperties(area, { offsetWidth: { value: 220 }, clientWidth: { value: 200 } });
    area.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 210, button: 0 }));
    expect(move).toHaveBeenCalledTimes(5);
    stop(); area.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }));
    expect(move).toHaveBeenCalledTimes(5);
  } finally { stop(); area.remove(); }
});

test('a surface owns touch before reading intent is observed; interruptions and disposal end that observation', () => {
  const surface = document.createElement('div'), area = document.createElement('div'), outside = document.createElement('div');
  surface.append(area); document.body.append(surface, outside);
  const move = vi.fn(), stop = onReadingMove(area, move);
  let owned = true;
  surface.addEventListener('touchmove', event => { if (owned) event.preventDefault(); });
  const touch = (target: HTMLElement, type: string, points: { clientX: number; clientY: number }[]) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points }); target.dispatchEvent(event);
  };
  const point = (y: number) => ({ clientX: 100, clientY: y });
  try {
    touch(area, 'touchstart', [point(100)]); touch(area, 'touchmove', [point(130)]);
    expect(move).not.toHaveBeenCalled();
    touch(area, 'touchcancel', []); owned = false;
    touch(area, 'touchmove', [point(160)]); expect(move).not.toHaveBeenCalled();
    touch(area, 'touchstart', [point(100)]); touch(area, 'touchmove', [point(130)]);
    expect(move).toHaveBeenCalledTimes(1);
    // A second finger may land outside the reader. Returning to one finger is not a fresh reading gesture.
    touch(outside, 'touchstart', [point(130), point(160)]);
    touch(area, 'touchmove', [point(180)]); expect(move).toHaveBeenCalledTimes(1);
    touch(outside, 'touchend', []); touch(area, 'touchmove', [point(200)]);
    expect(move).toHaveBeenCalledTimes(1);
    touch(area, 'touchstart', [point(100)]); touch(area, 'touchmove', [point(130)]);
    expect(move).toHaveBeenCalledTimes(2);
    stop(); touch(area, 'touchstart', [point(100)]); touch(area, 'touchmove', [point(140)]);
    expect(move).toHaveBeenCalledTimes(2);
  } finally { stop(); surface.remove(); outside.remove(); }
});
