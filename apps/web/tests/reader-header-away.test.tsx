import { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useReaderHeaderAway } from '../src/features/reader/reader-header-away';

afterEach(cleanup);
function Reading({ bind }: { bind: (tracking: ReturnType<typeof useReaderHeaderAway>) => void }) {
  const header = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), placing = useRef<string | null>(null);
  bind(useReaderHeaderAway(header, content, true, 'fixture', placing));
  return <div><div ref={header} data-head /><div ref={content} data-content /></div>;
}

test('scrolling uses the same measured fractional header room as the content, including after resize', () => {
  const observed: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
  vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function(callback) {
    const row = { callback, targets: [] as Element[] }; observed.push(row);
    return { observe: (element: Element) => row.targets.push(element), unobserve() {}, disconnect() {} } as ResizeObserver;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 60.5));
  const offset = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(61);
  let tracking: ReturnType<typeof useReaderHeaderAway>;
  const view = render(<Reading bind={value => { tracking = value; }} />), head = view.container.querySelector<HTMLElement>('[data-head]')!, area = view.container.querySelector<HTMLElement>('[data-content]')!;
  Object.defineProperties(area, { clientHeight: { value: 800 }, scrollHeight: { value: 2000 } });
  const scroll = (top: number) => { act(() => { area.scrollTop = top; area.dispatchEvent(new Event('scroll')); }); };
  scroll(300); scroll(320); expect(head.dataset.readerHeader).toBe('hidden');
  area.scrollTop = 60.75; act(() => tracking!.reset()); head.dataset.readerHeader = 'hidden';
  scroll(60.75); expect(head.dataset.readerHeader).toBe('hidden');
  scroll(60.5); expect(head.dataset.readerHeader).toBe('shown');
  expect(area.parentElement!.style.getPropertyValue('--reader-header-h')).toBe('60.5px');
  const resize = observed.find(row => row.targets.includes(head))!;
  act(() => resize.callback([{ target: head, borderBoxSize: [{ blockSize: 100.75 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver));
  scroll(300); scroll(320); expect(head.dataset.readerHeader).toBe('hidden');
  scroll(100.75); expect(head.dataset.readerHeader).toBe('shown');
  expect(area.parentElement!.style.getPropertyValue('--reader-header-h')).toBe('100.75px');
  expect(offset).not.toHaveBeenCalled();
});
