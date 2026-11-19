import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { useStrip } from '../src/features/tree/time-line';
import { usePullToRefresh } from '../src/features/tree/pull-refresh';

// Registration is observable at the browser boundary. jsdom checks ownership and cancellation;
// real touch routing and native scroll remain the browser checks' responsibility.
// The shared animate stub leaves the inline transform in place. Supply only that unanimated DOM matrix here;
// compositor interpolation and interruption positions are checked in the real-browser pull-spring cases.
beforeEach(() => {
  vi.stubGlobal('DOMMatrixReadOnly', class {
    readonly m42: number;
    constructor(transform: string) {
      const translate = /^translateY\(([-\d.]+)px\)$/.exec(transform);
      if (!translate) throw new Error(`Unexpected unanimated test transform: ${transform}`);
      this.m42 = Number(translate[1]);
    }
  });
});
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const hour = 3_600_000;
function list() {
  const box = document.createElement('div'), strip = document.createElement('div'), label = document.createElement('button');
  strip.dataset.timeStrip = '';
  box.append(label, strip);
  document.body.append(box);
  Object.defineProperties(box, { clientWidth: { value: 900 }, scrollWidth: { value: 5000 } });
  const active = new Set<EventListenerOrEventListenerObject>();
  const add = box.addEventListener, remove = box.removeEventListener;
  vi.spyOn(box, 'addEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
    if (type === 'touchmove' && typeof options === 'object' && options.passive === false) active.add(listener);
    add.call(this, type, listener, options);
  });
  vi.spyOn(box, 'removeEventListener').mockImplementation(function (this: HTMLElement, type, listener, options) {
    if (type === 'touchmove') active.delete(listener);
    remove.call(this, type, listener, options);
  });
  const setViewMs = vi.fn(), refresh = vi.fn().mockResolvedValue(true);
  const sheet = document.createElement('div'), mark = document.createElement('div');
  const scroller = { current: box }, page = { current: sheet }, sign = { current: mark };
  const hook = renderHook(({ shown, pull }) => {
    const axis = useStrip(scroller, { width: 900, zoomWidth: 900, letGo: false }, 0, { from: () => 0, end: () => 24 * hour, now: 23 * hour,
      busy: [[0, 24 * hour]], viewMs: 6 * hour, setViewMs }, shown);
    usePullToRefresh(scroller, page, sign, pull, refresh);
    return axis;
  }, { initialProps: { shown: true, pull: true } });
  return { box, strip, label, active, refresh, setViewMs, sheet, hook,
    close: () => { hook.unmount(); box.remove(); expect(active.size).toBe(0); } };
}
const point = (target: Element, id: number, x = 100, y = 100) => ({ target, identifier: id, clientX: x, clientY: y });
function touch(target: Element, type: string, touches: ReturnType<typeof point>[], changed = touches) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { touches, changedTouches: changed });
  act(() => { target.dispatchEvent(event); });
  return event;
}

test('a one-finger pan begun down the list has no blocking move, even if it reaches the top', () => {
  const view = list(), one = point(view.label, 1);
  expect(view.active.size).toBe(0);
  view.box.scrollTop = 100;
  touch(view.label, 'touchstart', [one]);
  expect(view.active.size).toBe(0);
  expect(touch(view.label, 'touchmove', [point(view.label, 1, 100, 80)]).defaultPrevented).toBe(false);
  view.box.scrollTop = 0;
  expect(touch(view.label, 'touchmove', [point(view.label, 1, 100, 400)]).defaultPrevented).toBe(false);
  expect(view.sheet.style.transform).toBe('');
  touch(view.label, 'touchend', [], [one]);
  expect(view.refresh).not.toHaveBeenCalled();
  view.close();
});

test('only a top pull candidate blocks moves, and an ordinary direction releases it for that touch', () => {
  const view = list(), one = point(view.label, 1);
  for (const [x, y] of [[100, 80], [160, 110]]) {
    touch(view.label, 'touchstart', [one]);
    expect(view.active.size).toBe(1);
    expect(touch(view.label, 'touchmove', [point(view.label, 1, x, y)]).defaultPrevented).toBe(false);
    expect(view.active.size).toBe(0);
    expect(touch(view.label, 'touchmove', [point(view.label, 1, 100, 400)]).defaultPrevented).toBe(false);
    touch(view.label, 'touchend', [], [one]);
  }
  touch(view.label, 'touchstart', [one]);
  expect(touch(view.label, 'touchmove', [point(view.label, 1, 100, 400)]).defaultPrevented).toBe(true);
  expect(view.active.size).toBe(1);
  expect(view.sheet.style.transform).toContain('translateY');
  touch(view.label, 'touchend', [], [one]);
  expect(view.active.size).toBe(0);
  expect(view.refresh).toHaveBeenCalledTimes(1);
  view.close();
});

test('a second finger abandons the pull; a page pinch never owns a blocking move', () => {
  const view = list(), one = point(view.label, 1), other = point(view.label, 2, 180);
  touch(view.label, 'touchstart', [one]);
  expect(view.active.size).toBe(1);
  touch(view.label, 'touchstart', [one, other], [other]);
  expect(view.active.size).toBe(0);
  expect(touch(view.label, 'touchmove', [one, point(view.label, 2, 220)]).defaultPrevented).toBe(false);
  touch(view.label, 'touchcancel', [], [one, other]);
  expect(view.refresh).not.toHaveBeenCalled();
  view.close();
});

test('only a two-finger strip pinch owns its move until release, including a replaced start target', () => {
  const view = list();
  view.box.scrollTop = 100;
  const mark = view.strip.appendChild(document.createElement('span'));
  const one = point(mark, 1), other = point(view.strip, 2, 140);
  touch(mark, 'touchstart', [one]);
  expect(view.active.size).toBe(0);
  touch(view.strip, 'touchstart', [one, other], [other]);
  expect(view.active.size).toBe(1);
  mark.remove();
  expect(touch(view.strip, 'touchmove', [point(mark, 1, 80), point(view.strip, 2, 160)]).defaultPrevented).toBe(true);
  expect(view.setViewMs).toHaveBeenCalled();
  touch(view.strip, 'touchend', [one], [other]);
  expect(view.active.size).toBe(0);
  expect(touch(view.strip, 'touchmove', [one]).defaultPrevented).toBe(false);
  view.close();
});

test('hiding or unmounting releases a live pinch, and hidden strips do not intercept modified wheels', () => {
  const view = list(), one = point(view.strip, 1), other = point(view.strip, 2, 140);
  view.box.scrollTop = 100;
  touch(view.strip, 'touchstart', [one, other]);
  expect(view.active.size).toBe(1);
  view.hook.rerender({ shown: false, pull: true });
  expect(view.active.size).toBe(0);
  const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -30 });
  fireEvent(view.strip, wheel);
  expect(wheel.defaultPrevented).toBe(false);
  view.hook.rerender({ shown: true, pull: true });
  touch(view.strip, 'touchstart', [one, other]);
  expect(view.active.size).toBe(1);
  view.close();
});

test('disabling the pull releases its pending move before another finger can use it', () => {
  const view = list(), one = point(view.label, 1);
  touch(view.label, 'touchstart', [one]);
  expect(view.active.size).toBe(1);
  view.hook.rerender({ shown: true, pull: false });
  expect(view.active.size).toBe(0);
  expect(touch(view.label, 'touchmove', [point(view.label, 1, 100, 400)]).defaultPrevented).toBe(false);
  expect(view.refresh).not.toHaveBeenCalled();
  view.close();
});
