import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { WindowWidthHandle } from '../src/features/shell/docked-window';
import { useViewStore } from '../src/state/view-store';
import { readerWidth } from '../src/state/screen-settings';

afterEach(() => { cleanup(); readerWidth.remove(); useViewStore.setState(useViewStore.getInitialState()); });

test("resizing a window that never fills the screen keeps its width only and leaves the full reader full", () => {
  useViewStore.getState().setReaderFull(true);
  render(<div data-window=""><WindowWidthHandle label="Width" widest={() => 600} fills={false} /></div>);
  const edge = document.querySelector<HTMLElement>('[data-window-width]')!;
  Object.defineProperty(edge.parentElement!, 'offsetWidth', { configurable: true, value: 500 });
  fireEvent.keyDown(edge, { key: 'ArrowLeft' });
  expect(readerWidth.get()).toBe(524);
  expect(useViewStore.getState().readerFull).toBe(true);
  // A double press gives the default width back, and the reader stays full.
  fireEvent.doubleClick(edge);
  expect(readerWidth.get()).toBeNull();
  expect(useViewStore.getState().readerFull).toBe(true);
});
