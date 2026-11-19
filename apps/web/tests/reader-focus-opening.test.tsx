import { Fragment, StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Reader, type ReaderMode } from '../src/features/reader/Reader';
import { useEveryTaskIndex } from '../src/data/queries';
import { openScreenLink, useUrlBootstrap } from '../src/state/bootstrap';
import { closeInput, openInput } from '../src/state/open-input';
import { useViewStore } from '../src/state/view-store';
import { TestWorkspace, narrowScreen, screenData, tree } from './fixtures';
import { setupForms } from './forms-fixture';
import { fakeNavigation, sessionHistory } from './navigation-fake';

setupForms();
afterEach(() => vi.unstubAllGlobals());
function Bootstrap() { useUrlBootstrap(useEveryTaskIndex()); return null; }
function mount(mode: ReaderMode, search = '?agent=1', Wrapper: typeof StrictMode | typeof Fragment = Fragment) {
  localStorage.removeItem('alpacawork.navigation.v2');
  history.replaceState(null, '', `/${search}`); sessionHistory(); fakeNavigation();
  render(<Wrapper><TestWorkspace data={screenData(tree())}><Bootstrap />
    <input aria-label="Next task" autoFocus />
    <button onClick={() => useViewStore.getState().openReader('T1')}>Open task</button>
    <Reader mode={mode} />
  </TestWorkspace></Wrapper>);
  return screen.getByRole('textbox', { name: 'Next task' }) as HTMLInputElement;
}
const title = () => document.querySelector('h2[data-reader-title="T1"]');
const preserve = (input: HTMLInputElement) => {
  expect(screen.getByRole('textbox', { name: 'Next task' })).toBe(input);
  expect(input.value).toBe('Next unsent task');
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
};
const draft = (input: HTMLInputElement) => {
  input.focus(); fireEvent.change(input, { target: { value: 'Next unsent task' } }); input.setSelectionRange(2, 7);
};
const move = (step: () => void) => act(async () => {
  const arrived = new Promise<void>(resolve => addEventListener('popstate', () => resolve(), { once: true }));
  step(); await arrived;
});

for (const mode of ['docked', 'sheet'] as const) {
  test(`${mode}: a human press focuses the Reader title`, async () => {
    const narrow = narrowScreen(mode === 'sheet');
    try {
      mount(mode);
      const opener = screen.getByRole('button', { name: 'Open task' });
      opener.focus(); fireEvent.click(opener);
      await waitFor(() => expect(title()).not.toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(title()));
    } finally { narrow.restore(); }
  });

  test(`${mode}: a URL opening uses the current active input focus rule`, async () => {
    const narrow = narrowScreen(mode === 'sheet');
    try {
      mount(mode, '?agent=1&task=T1');
      await waitFor(() => expect(title()).not.toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(title()));
    } finally { narrow.restore(); }
  });
}

test('Back and Forward preserve input DOM, value and selection while using the active input focus rule', async () => {
  const narrow = narrowScreen(false);
  try {
    const input = mount('docked', '?agent=1&task=T1');
    await waitFor(() => expect(title()).not.toBeNull());
    act(() => openScreenLink('/?agent=1'));
    await waitFor(() => expect(title()).toBeNull());
    draft(input);
    await move(() => history.back());
    await waitFor(() => expect(title()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(title()));
    preserve(input);
    await move(() => history.forward());
    await waitFor(() => expect(title()).toBeNull());
    const opener = screen.getByRole('button', { name: 'Open task' });
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(title()));
    await move(() => history.back());
    await waitFor(() => expect(title()).toBeNull());
    draft(input);
    await move(() => history.forward());
    await waitFor(() => expect(title()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(title()));
    preserve(input);
  } finally { narrow.restore(); }
});

for (const active of ['body', 'svg', 'result'] as const) {
  test(`a press with ${active} active preserves the current main focus boundary`, async () => {
    const narrow = narrowScreen(false);
    try {
      const input = mount('docked');
      const opener = screen.getByRole('button', { name: 'Open task' });
      let previous: Element;
      if (active === 'svg') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('tabindex', '0'); opener.append(svg);
        (svg as SVGElement & { focus: () => void }).focus(); previous = svg;
      } else if (active === 'result') {
        opener.setAttribute('data-result', ''); opener.focus(); previous = opener;
      } else {
        input.blur(); previous = document.body;
      }
      expect(document.activeElement).toBe(previous);
      fireEvent.click(opener);
      await waitFor(() => expect(title()).not.toBeNull());
      await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
      expect(document.activeElement).toBe(previous);
    } finally { narrow.restore(); }
  });
}

const frame = () => act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
const moveField = () => document.querySelector('[data-inline-form] select');
for (const strict of [false, true]) test(`an input ending in the open reader begins nothing; a real next opening does, StrictMode=${strict}`, async () => {
  const narrow = narrowScreen(false);
  try {
    const input = mount('docked', '?agent=1', strict ? StrictMode : Fragment);
    const opener = screen.getByRole('button', { name: 'Open task' });
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(title()));

    act(() => openInput({ form: 'move', taskId: 'T1' }));
    await waitFor(() => expect(document.activeElement).toBe(moveField()));
    draft(input);
    act(closeInput);
    await frame();
    expect(moveField()).toBeNull();
    expect(document.activeElement).toBe(input);
    preserve(input);

    // The next input of the same reader is a new intention.
    act(() => openInput({ form: 'move', taskId: 'T1' }));
    await waitFor(() => expect(document.activeElement).toBe(moveField()));
    act(closeInput);
    await frame();
    expect(document.activeElement).toBe(document.body);

    // So is the next opening of the reader, after it closed.
    act(() => useViewStore.getState().closeReader());
    await waitFor(() => expect(title()).toBeNull());
    await frame();
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(document.activeElement).toBe(title()));
  } finally { closeInput(); narrow.restore(); }
});
