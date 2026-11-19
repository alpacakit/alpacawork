import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n, startI18n } from '@alpacawork/i18n';
import { ReaderHeader } from '../src/features/reader/ReaderHeader';
import { TestWorkspace, dto, screenData, tree } from './fixtures';

let hidden: string, resize: (() => void) | undefined;
const observers: { targets: Set<Element>; disconnect: ReturnType<typeof vi.fn> }[] = [];
beforeEach(() => {
  if (!i18n.isInitialized) startI18n();
  hidden = 'T2'; observers.length = 0;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.hasAttribute('data-reader-path') ? new DOMRect(0, 0, 200, 40)
      : new DOMRect(0, this.textContent?.startsWith(hidden) ? 80 : 0, 80, 40);
  });
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>();
    disconnect = vi.fn(() => this.targets.clear());
    constructor(callback: () => void) { resize = callback; observers.push(this); }
    observe = (target: Element) => { this.targets.add(target); };
    unobserve = (target: Element) => { this.targets.delete(target); };
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const dataFor = (parent = 'T2') => screenData(tree({ tasks: [dto({ id: 'T1', parentId: parent }), dto({ id: 'T2' }), dto({ id: 'T3' })] }));
function Head({ data, ruled = false }: { data: ReturnType<typeof dataFor>; ruled?: boolean }) {
  return <I18nextProvider i18n={i18n}><TestWorkspace data={data}><ReaderHeader task={data.tasks.find(task => task.id === 'T1')!} mode="sheet"
    canDock={false} onFollow={() => {}} walking={false} pane="task" ruled={ruled} /></TestWorkspace></I18nextProvider>;
}

test('a reader state commit keeps its path observer and does not measure unchanged steps', () => {
  const data = dataFor(); const view = render(<Head data={data} />);
  const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect'); measure.mockClear();
  const previous = observers.length;
  view.rerender(<Head data={data} ruled />);
  expect(observers).toHaveLength(previous);
  expect(measure).not.toHaveBeenCalled();
});

test('a resized path updates hidden steps without replacing the observer', () => {
  const view = render(<Head data={dataFor()} />);
  const parent = view.getByRole('button', { name: /^T2 /, hidden: true }).parentElement!;
  expect(parent.inert).toBe(true);
  const previous = observers.length;
  hidden = 'none'; act(() => resize?.());
  expect(parent.inert).toBe(false);
  hidden = 'T2'; act(() => resize?.());
  expect(parent.inert).toBe(true);
  expect(observers).toHaveLength(previous);
});

test('replacing an ancestor with the same size rebinds and clips the new node', () => {
  const view = render(<Head data={dataFor()} />);
  const old = view.getByRole('button', { name: /^T2 /, hidden: true }).parentElement!;
  hidden = 'T3';
  view.rerender(<Head data={dataFor('T3')} />);
  const replacement = view.getByRole('button', { name: /^T3 /, hidden: true }).parentElement!;
  expect(replacement).not.toBe(old);
  expect(replacement.inert).toBe(true);
  expect(observers.some(observer => observer.targets.has(replacement))).toBe(true);
  expect(observers.every(observer => !observer.targets.has(old))).toBe(true);
  view.unmount();
  expect(observers.every(observer => observer.targets.size === 0)).toBe(true);
});

test('a child-only path update binds its new step without another header commit', async () => {
  const view = render(<Head data={dataFor()} />);
  const nav = view.container.querySelector('[data-reader-path]')!;
  const added = document.createElement('span'); added.textContent = 'T3 async mark';
  hidden = 'T3';
  // Project marks can arrive through their own subscription, independently of the header's render.
  await act(async () => { nav.append(added); });
  expect(added.inert).toBe(true);
  expect(observers.some(observer => observer.targets.has(added))).toBe(true);
  await act(async () => { added.remove(); });
  expect(observers.every(observer => !observer.targets.has(added))).toBe(true);
});
