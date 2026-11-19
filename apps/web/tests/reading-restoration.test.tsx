import { useRef } from 'react';
import { I18nextProvider } from 'react-i18next';
import { i18n, startI18n } from '@alpacawork/i18n';
import { ReadFailure, ReadRetryContext } from '../src/components/ui/loadable';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { useReaderRestoration } from '../src/features/reader/reading-restoration';
import { useViewStore } from '../src/state/view-store';
import { noteReaderPosition, noteReaderScroll, readerHistoryPosition, showingNavigation } from '../src/state/reader-position';

vi.mock('../src/state/reader-position', () => ({
  noteReaderPlace: vi.fn(), noteReaderScroll: vi.fn(), noteReaderPosition: vi.fn(), showingNavigation: vi.fn(() => false),
  readerHistoryPosition: vi.fn(() => ({ task: 'T1', pane: 'task', path: null, scroll: 500 })),
}));
beforeAll(() => startI18n());
const original = { task: 'T1', pane: 'task', path: null, scroll: 500 };
const reset = vi.fn(), start = vi.fn();
function Reading({ acquired, header = false, hidden = false }: { acquired: boolean; header?: boolean; hidden?: boolean }) {
  const area = useRef<HTMLDivElement>(null), placing = useRef<string | null>(null);
  const { retry, noteScroll } = useReaderRestoration(area, true, 'T1', 'task', null, 'T1', true, reset, start, placing);
  const failure = <ReadFailure retry={() => {}} />;
  return <I18nextProvider i18n={i18n}><ReadRetryContext value={retry}><div data-reader-content ref={area} onScroll={event => noteScroll(event.currentTarget.scrollTop)}>
    <div data-held-hidden={hidden || undefined}>
    <div data-report-feed data-history-ready={acquired} data-history-exhausted={acquired} aria-busy="false">
      {acquired && <li data-report-key="request:original"><button aria-expanded="true">Original instruction</button></li>}
      {!header && failure}
    </div></div>
  </div>{header && failure}</ReadRetryContext></I18nextProvider>;
}

const flush = async () => act(async () => { await vi.advanceTimersByTimeAsync(20); });
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  useViewStore.setState({ ...useViewStore.getInitialState(), selected: 'T1', event: 'request:original',
    reader: { ...useViewStore.getInitialState().reader, open: true, pane: 'task' } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// These are request lifetime checks without layout claims; real wheel/touch geometry lives in history-position E2E.
test('the 30-second cap ends the attempt, while explicit Retry still chooses the original request', async () => {
  const view = render(<Reading acquired={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  expect(noteReaderPosition).toHaveBeenCalledWith(original);
  view.rerender(<Reading acquired />); await flush();
  expect(view.container.firstElementChild!.scrollTop).toBe(500);
});

test('late successful acquisition retires the canceled request before a later failure is retried', async () => {
  const view = render(<Reading acquired={false} />);
  const area = view.container.firstElementChild as HTMLElement;
  fireEvent.wheel(area, { deltaY: 100 }); area.scrollTop = 100;
  view.rerender(<Reading acquired />); await flush();
  expect(area.scrollTop).toBe(100);
  view.rerender(<Reading acquired={false} />); await flush();
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  view.rerender(<Reading acquired />); await flush();
  expect(area.scrollTop).toBe(100);
  expect(noteReaderPosition).not.toHaveBeenCalledWith(original);
});

for (const destination of ['event', 'task', 'pane'] as const)
  test(`leaving the ${destination} and immediately returning cannot resurrect the former request`, async () => {
    const view = render(<Reading acquired={false} />);
    const area = view.container.firstElementChild as HTMLElement;
    fireEvent.wheel(area, { deltaY: 100 }); area.scrollTop = 100;
    act(() => {
      const before = useViewStore.getState();
      if (destination === 'event') useViewStore.setState({ event: 'request:other' });
      else if (destination === 'task') useViewStore.setState({ selected: 'T2' });
      else useViewStore.setState({ reader: { ...before.reader, pane: 'files' } });
      useViewStore.setState(before);
    });
    fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    view.rerender(<Reading acquired />); await flush();
    expect(area.scrollTop).toBe(100);
    expect(noteReaderPosition).not.toHaveBeenCalledWith(original);
  });

test('taking over a retried attempt at a scroll boundary saves the place even without a scroll event', () => {
  const view = render(<Reading acquired={false} />);
  const area = view.container.firstElementChild as HTMLElement;
  fireEvent.wheel(area, { deltaY: 100 }); area.scrollTop = 100;
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  expect(noteReaderPosition).toHaveBeenLastCalledWith(original);
  // The browser can consume a vertical move at its boundary without emitting a scroll event.
  fireEvent.wheel(area, { deltaY: -100 });
  expect(noteReaderScroll).toHaveBeenLastCalledWith('T1', 'task', null, 100);
});

test('another row chosen in the same place keeps where the reader actually stands, with no scroll event', () => {
  const view = render(<Reading acquired={false} />);
  const area = view.container.firstElementChild as HTMLElement;
  // Not yet put back (the saved 500 not reached): the person reads on at 240, then opens another row without scrolling.
  fireEvent.wheel(area, { deltaY: 100 }); area.scrollTop = 240;
  vi.mocked(noteReaderScroll).mockClear();
  act(() => useViewStore.getState().setEvent('request:other'));
  expect(noteReaderScroll).toHaveBeenLastCalledWith('T1', 'task', null, 240);
  // A browser entry shown in the same place (Back/Forward) brings its own position: the one left is not chosen for it.
  vi.mocked(noteReaderScroll).mockClear();
  vi.mocked(showingNavigation).mockReturnValueOnce(true);
  act(() => useViewStore.getState().setEvent('request:original'));
  expect(noteReaderScroll).not.toHaveBeenCalled();
  // A move to another place is not this either: nothing is chosen for the place left.
  act(() => useViewStore.setState({ selected: 'T2' }));
  expect(noteReaderScroll).not.toHaveBeenCalled();
});

test('Retry chooses the whole original position again, keeping the reference followed from it', async () => {
  vi.mocked(readerHistoryPosition).mockReturnValueOnce({ ...original, pane: 'task', referenceId: 'T2', occurrence: 1 });
  const view = render(<Reading acquired={false} />);
  const area = view.container.firstElementChild as HTMLElement;
  area.scrollTop = 100; fireEvent.wheel(area, { deltaY: 100 });
  // The person's own move chooses a plain position.
  expect(noteReaderScroll).toHaveBeenLastCalledWith('T1', 'task', null, 100);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  expect(noteReaderPosition).toHaveBeenLastCalledWith({ ...original, referenceId: 'T2', occurrence: 1 });
});


test('a hidden retained floor does not finish acquisition; header Retry reselects the whole original position', async () => {
  const view = render(<Reading acquired header hidden />);
  const area = view.container.firstElementChild as HTMLElement;
  await flush();
  expect(noteReaderPosition).not.toHaveBeenCalled();
  area.scrollTop = 100; fireEvent.wheel(area, { deltaY: 100 });
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  expect(noteReaderPosition).toHaveBeenCalledWith(original);
  view.rerender(<Reading acquired header />); await flush();
  expect(area.scrollTop).toBe(500);
});

test('after the cap native focus scroll does not replace an unfinished request; vertical intent still chooses a new position', async () => {
  const view = render(<Reading acquired={false} />);
  const area = view.container.firstElementChild as HTMLElement;
  await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
  area.scrollTop = 100; fireEvent.scroll(area);
  expect(noteReaderScroll).not.toHaveBeenCalled();
  fireEvent.wheel(area, { deltaY: 100 }); area.scrollTop = 120; fireEvent.scroll(area);
  expect(noteReaderScroll).toHaveBeenLastCalledWith('T1', 'task', null, 120);
  fireEvent.click(view.getByRole('button', { name: 'Retry' }));
  vi.mocked(noteReaderScroll).mockClear(); area.scrollTop = 140; fireEvent.scroll(area);
  expect(noteReaderScroll).not.toHaveBeenCalled();
  expect(noteReaderPosition).toHaveBeenLastCalledWith(original);
});
