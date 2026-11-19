import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import { watchScrollAway } from '../src/lib/scroll-away';
import { READING_THRESHOLD } from '../src/lib/reading-scroll';

afterEach(() => document.body.replaceChildren());
function fixture(delegated = false) {
  const layer = document.createElement('div'), area = document.createElement('div');
  document.body.append(layer, area);
  let hidden = false, room = 60;
  Object.defineProperties(area, {
    scrollHeight: { configurable: true, value: 2000 }, clientHeight: { configurable: true, value: 800 },
  });
  const { stop } = watchScrollAway({ source: delegated ? document : area, accepts: element => element === area,
    height: () => room, hidden: () => hidden, setHidden: value => { hidden = value; }, controls: () => layer });
  onTestFinished(stop);
  const scroll = (top: number, height = area.clientHeight) => {
    Object.defineProperty(area, 'clientHeight', { configurable: true, value: height });
    area.scrollTop = top; area.dispatchEvent(new Event('scroll'));
  };
  return { layer, area, scroll, setRoom: (value: number) => { room = value; }, hidden: () => hidden };
}

test('accumulates direction past 16px, stays hidden while stopped, and returns on a run upwards', () => {
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); });
  const f = fixture();
  f.scroll(200); f.scroll(200 - READING_THRESHOLD); expect(f.hidden()).toBe(true);
  f.scroll(200 - READING_THRESHOLD - 1); expect(f.hidden()).toBe(false);
  f.scroll(201); expect(f.hidden()).toBe(true);
  vi.advanceTimersByTime(10_000); expect(f.hidden()).toBe(true);
  f.scroll(201); expect(f.hidden()).toBe(true);
});

test('small consecutive steps accumulate, reversing resets the run, and the top always shows', () => {
  const f = fixture();
  f.scroll(100); f.scroll(80); expect(f.hidden()).toBe(false);
  f.scroll(88); f.scroll(96); expect(f.hidden()).toBe(false);
  f.scroll(97); expect(f.hidden()).toBe(true);
  f.scroll(90); f.scroll(97); f.scroll(90); expect(f.hidden()).toBe(true);
  f.scroll(60); expect(f.hidden()).toBe(false);
});

test('bounces at both ends do not change the direction or valid baseline', () => {
  const f = fixture();
  f.scroll(1200); expect(f.hidden()).toBe(true);
  f.scroll(1260); f.scroll(1200); expect(f.hidden()).toBe(true);
  f.scroll(1183); expect(f.hidden()).toBe(false);
  f.scroll(0); f.scroll(-90); f.scroll(0); f.scroll(61); expect(f.hidden()).toBe(true);
});

test('a height change establishes a baseline, without counting layout movement', () => {
  const f = fixture();
  f.scroll(400, 700); expect(f.hidden()).toBe(false);
  f.scroll(300, 800); expect(f.hidden()).toBe(false);
  f.scroll(317); expect(f.hidden()).toBe(true);
  f.scroll(300, 900); expect(f.hidden()).toBe(true);
  f.scroll(284); expect(f.hidden()).toBe(true);
  f.scroll(283); expect(f.hidden()).toBe(false);
});

test.each([false, true])('layer-height corrections reset the run, then reading counts (delegated=%s)', delegated => {
  const f = fixture(delegated);
  f.scroll(300); f.scroll(320); expect(f.hidden()).toBe(true);
  f.scroll(304); expect(f.hidden()).toBe(true);
  f.setRoom(112); f.scroll(356); expect(f.hidden()).toBe(true);
  f.setRoom(60); f.scroll(304); expect(f.hidden()).toBe(true);
  f.scroll(288); expect(f.hidden()).toBe(true);
  f.scroll(287); expect(f.hidden()).toBe(false);
  f.scroll(303); expect(f.hidden()).toBe(false);
  f.setRoom(80); f.scroll(323); expect(f.hidden()).toBe(false);
  f.scroll(339); expect(f.hidden()).toBe(false);
  f.scroll(340); expect(f.hidden()).toBe(true);
});

test.each([false, true])('reading during content growth hides, stays hidden when stopped, and reading up during shrinkage shows (delegated=%s)', delegated => {
  vi.useFakeTimers(); onTestFinished(() => { vi.useRealTimers(); });
  const f = fixture(delegated);
  f.scroll(300); f.scroll(320); f.scroll(303); expect(f.hidden()).toBe(false);
  for (let n = 1; n <= 3; n++) {
    Object.defineProperty(f.area, 'scrollHeight', { configurable: true, value: 2000 + n * 100 });
    f.scroll(303 + n * 40); expect(f.hidden()).toBe(true);
  }
  vi.advanceTimersByTime(10_000); expect(f.hidden()).toBe(true);
  for (let n = 1; n <= 3; n++) {
    Object.defineProperty(f.area, 'scrollHeight', { configurable: true, value: 2300 - n * 100 });
    f.scroll(423 - n * 10); expect(f.hidden()).toBe(n === 1);
  }
});

test.each([false, true])('reserved foot padding changes establish a baseline, unlike incoming report text (delegated=%s)', delegated => {
  const f = fixture(delegated);
  f.area.style.paddingBottom = '80px';
  f.scroll(300); f.scroll(320); expect(f.hidden()).toBe(true);
  // The coordinator gave the list more room at its foot. Anchoring follows it; that movement is not reading up.
  f.area.style.paddingBottom = '160px'; f.scroll(240); expect(f.hidden()).toBe(true);
  f.scroll(224); expect(f.hidden()).toBe(true);
  f.scroll(223); expect(f.hidden()).toBe(false);
});

test.each([false, true])('a layer resize observed before its anchoring scroll keeps that pending baseline (delegated=%s)', delegated => {
  let notify: ResizeObserverCallback;
  const observer = { observe() {}, unobserve() {}, disconnect() {} } as ResizeObserver;
  const resize = vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function(callback) { notify = callback; return observer; });
  onTestFinished(() => resize.mockRestore());
  const f = fixture(delegated);
  f.scroll(300); f.scroll(320); f.scroll(303); expect(f.hidden()).toBe(false);
  f.setRoom(112);
  notify!([{ target: f.area } as unknown as ResizeObserverEntry], observer);
  f.scroll(355); expect(f.hidden()).toBe(false);
  f.scroll(372); expect(f.hidden()).toBe(true);
});

test.each([false, true])('foot padding resized without scrolling counts the first real step from its observed position (delegated=%s)', delegated => {
  let notify: ResizeObserverCallback;
  const observer = { observe() {}, unobserve() {}, disconnect() {} } as ResizeObserver;
  const resize = vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function(callback) { notify = callback; return observer; });
  onTestFinished(() => resize.mockRestore());
  const f = fixture(delegated);
  f.area.style.paddingBottom = '80px';
  f.scroll(300); f.scroll(320); f.scroll(303); expect(f.hidden()).toBe(false);
  f.area.style.paddingBottom = '160px';
  notify!([{ target: f.area } as unknown as ResizeObserverEntry], observer);
  f.scroll(403); expect(f.hidden()).toBe(true);
});

test('an unscrollable body shows the header', () => {
  const f = fixture(); f.scroll(400); expect(f.hidden()).toBe(true);
  Object.defineProperty(f.area, 'scrollHeight', { configurable: true, value: 700 });
  f.scroll(0); expect(f.hidden()).toBe(false);
});

test('open controls and keyboard focus keep the layer visible; opening an inline form calls it back', async () => {
  const f = fixture();
  f.layer.innerHTML = '<button aria-expanded="true">menu</button>';
  f.scroll(400); expect(f.hidden()).toBe(false);
  f.layer.firstElementChild!.setAttribute('aria-expanded', 'false');
  const button = f.layer.firstElementChild as HTMLButtonElement;
  button.focus(); f.scroll(500); expect(f.hidden()).toBe(false);
  button.blur(); f.scroll(600); expect(f.hidden()).toBe(true);
  f.layer.append(document.createElement('form'));
  await Promise.resolve(); expect(f.hidden()).toBe(false);
  f.scroll(700); expect(f.hidden()).toBe(false);
});

test('cleanup detaches the listener', () => {
  const layer = document.createElement('div'), area = document.createElement('div');
  document.body.append(layer, area);
  Object.defineProperties(area, { scrollHeight: { value: 2000 }, clientHeight: { value: 800 } });
  const setHidden = vi.fn();
  const { stop } = watchScrollAway({ source: area, accepts: () => true, height: () => 60,
    hidden: () => false, setHidden, controls: () => layer });
  stop(); area.scrollTop = 400; area.dispatchEvent(new Event('scroll')); expect(setHidden).not.toHaveBeenCalled();
});

test('continuing downward while hidden does not recheck focus styles, but opening controls still recalls the layer', async () => {
  const f = fixture();
  f.scroll(300); f.scroll(320); expect(f.hidden()).toBe(true);
  const inspect = vi.spyOn(f.layer, 'querySelector');
  f.scroll(340); f.scroll(360); f.scroll(380);
  expect(inspect).not.toHaveBeenCalled();
  f.layer.append(document.createElement('form'));
  await Promise.resolve();
  expect(f.hidden()).toBe(false);
  f.scroll(400); expect(f.hidden()).toBe(false);
});

test('each scroll samples its scrollport once before deciding visibility', () => {
  const f = fixture(); f.scroll(300); f.scroll(320);
  const top = vi.fn(() => 340), height = vi.fn(() => 800), extent = vi.fn(() => 2000);
  Object.defineProperties(f.area, {
    scrollTop: { configurable: true, get: top }, clientHeight: { configurable: true, get: height },
    scrollHeight: { configurable: true, get: extent },
  });
  f.area.dispatchEvent(new Event('scroll'));
  expect(top).toHaveBeenCalledTimes(1);
  expect(height).toHaveBeenCalledTimes(1);
  expect(extent).toHaveBeenCalledTimes(1);
  expect(f.hidden()).toBe(true);
});

test('restoring a saved position resets the baseline and shows the layer, without counting the jump as reading', () => {
  const layer = document.createElement('div'), area = document.createElement('div');
  document.body.append(layer, area);
  Object.defineProperties(area, { scrollHeight: { value: 2000 }, clientHeight: { value: 800 } });
  let hidden = false;
  const tracking = watchScrollAway({ source: area, accepts: () => true, height: () => 60,
    hidden: () => hidden, setHidden: value => { hidden = value; }, controls: () => layer });
  onTestFinished(tracking.stop);
  area.scrollTop = 500; tracking.reset(area); area.dispatchEvent(new Event('scroll'));
  expect(hidden).toBe(false);
  area.scrollTop += READING_THRESHOLD; area.dispatchEvent(new Event('scroll')); expect(hidden).toBe(false);
  area.scrollTop++; area.dispatchEvent(new Event('scroll')); expect(hidden).toBe(true);
});

test('layout compensation rebases direction without revealing a hidden header', () => {
  const layer = document.createElement('div'), area = document.createElement('div');
  document.body.append(layer, area);
  Object.defineProperties(area, { scrollHeight: { value: 2000 }, clientHeight: { value: 800 } });
  let hidden = false;
  const tracking = watchScrollAway({ source: area, accepts: () => true, height: () => 60,
    hidden: () => hidden, setHidden: value => { hidden = value; }, controls: () => layer });
  onTestFinished(tracking.stop);
  area.scrollTop = 400; area.dispatchEvent(new Event('scroll')); expect(hidden).toBe(true);
  // Layout shrinks above the reader. This large upward compensation is not reading back up.
  area.scrollTop = 300; tracking.rebase(area); area.dispatchEvent(new Event('scroll'));
  expect(hidden).toBe(true);
  area.scrollTop -= READING_THRESHOLD; area.dispatchEvent(new Event('scroll')); expect(hidden).toBe(true);
  area.scrollTop--; area.dispatchEvent(new Event('scroll')); expect(hidden).toBe(false);
});
