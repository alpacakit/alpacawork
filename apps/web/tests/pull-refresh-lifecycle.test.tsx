import { useRef } from 'react';
import { test, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import { PullMark, usePullToRefresh } from '../src/features/tree/pull-refresh';
vi.mock('../src/lib/motion', () => ({ reducedMotion: () => true }));
afterEach(() => { cleanup(); vi.useRealTimers(); });
function Pull({ on, refresh }: { on: boolean; refresh: () => Promise<boolean> }) {
  const box = useRef<HTMLDivElement>(null), sheet = useRef<HTMLDivElement>(null), mark = useRef<HTMLDivElement>(null);
  usePullToRefresh(box, sheet, mark, on, refresh);
  return <div ref={box} data-testid="box"><div ref={sheet} data-testid="sheet" /><PullMark mark={mark} /></div>;
}
function pull(box: HTMLElement) {
  const point = (y: number) => ({ identifier: 1, clientX: 100, clientY: y });
  fireEvent.touchStart(box, { touches: [point(100)], changedTouches: [point(100)] });
  fireEvent.touchMove(box, { touches: [point(320)], changedTouches: [point(320)] });
  fireEvent.touchEnd(box, { touches: [], changedTouches: [point(320)] });
}
test('disabling a pending pull clears its drawing, ignores its late completion, and permits a later online pull', async () => {
  vi.useFakeTimers();
  let finish!: (ok: boolean) => void;
  const refresh = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; })).mockResolvedValue(true);
  const view = render(<Pull on refresh={refresh} />), box = view.getByTestId('box'), sheet = view.getByTestId('sheet');
  const mark = () => document.querySelector<HTMLElement>('[data-pull-mark]')!;
  pull(box);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(mark().dataset.phase).toBe('refreshing');
  view.rerender(<Pull on={false} refresh={refresh} />);
  expect(mark().dataset.phase).toBe('rest');
  expect(mark().style.opacity).toBe('0');
  expect(sheet.style.transform).toBe('');
  pull(box);
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () => { finish(true); await vi.advanceTimersByTimeAsync(1000); });
  expect(mark().dataset.phase).toBe('rest');
  expect(mark().style.opacity).toBe('0');
  view.rerender(<Pull on refresh={refresh} />);
  pull(box);
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(mark().dataset.phase).toBe('done');
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(mark().dataset.phase).toBe('rest');
  expect(sheet.style.transform).toBe('');
});
