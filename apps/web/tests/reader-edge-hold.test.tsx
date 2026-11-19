import { afterEach, expect, test, vi } from 'vitest';
import { holdReaderEdge, readerEdgeHeld } from '../src/state/screen-settings';

afterEach(() => { vi.useRealTimers(); readerEdgeHeld.set(false); });

test('let go, the reader\'s edge stays held until the frame laying out its last width is drawn, and held again it stays held', () => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  holdReaderEdge(true);
  holdReaderEdge(false);
  expect(readerEdgeHeld.get()).toBe(true);
  vi.advanceTimersToNextFrame();
  expect(readerEdgeHeld.get()).toBe(true);
  vi.advanceTimersToNextFrame();
  expect(readerEdgeHeld.get()).toBe(false);
  holdReaderEdge(true); holdReaderEdge(false); holdReaderEdge(true);
  vi.advanceTimersToNextFrame(); vi.advanceTimersToNextFrame();
  expect(readerEdgeHeld.get()).toBe(true);
});
