import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { LabelCard } from '../src/features/coordinator/LabelPopover';
import { useViewStore } from '../src/state/view-store';
import { narrowScreen } from './fixtures';

function Harness({ inReader = true, paneOnly = false }: { inReader?: boolean; paneOnly?: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return <>
    <div data-reader-content={inReader ? '' : undefined}>
      <button ref={anchor} onClick={() => setOpen(true)}>Task reference</button>
    </div>
    <button>Another choice</button>
    {open && <LabelCard anchor={anchor} name="Task preview" header="Preview" close={() => setOpen(false)} actions={
      <button onClick={() => {
        setOpen(false);
        if (paneOnly) useViewStore.setState(state => ({ reader: { ...state.reader, pane: 'files' } }));
        else useViewStore.setState({ selected: 'T2' });
      }}>Open task</button>
    }>Task body</LabelCard>}
  </>;
}

beforeEach(() => {
  const state = useViewStore.getInitialState();
  useViewStore.setState({ ...state, selected: 'T1', reader: { ...state.reader, open: true, pane: 'task' } });
});
afterEach(() => { cleanup(); useViewStore.setState(useViewStore.getInitialState()); vi.unstubAllGlobals(); });
function open(props: Parameters<typeof Harness>[0] = {}) {
  const view = render(<Harness {...props} />);
  const source = view.getByRole('button', { name: 'Task reference' });
  source.focus(); fireEvent.click(source);
  expect(document.activeElement).toBe(view.getByRole('button', { name: 'Open task' }));
  const focus = vi.spyOn(source, 'focus');
  return { view, source, focus };
}

test('ordinary dismiss returns focus to the same task reference', () => {
  const { source, focus } = open();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(document.activeElement).toBe(source);
  expect(focus).toHaveBeenCalledOnce();
});

test('following a task retires the old reader focus destination before its DOM is removed', () => {
  const { view, source, focus } = open();
  fireEvent.click(view.getByRole('button', { name: 'Open task' }));
  expect(useViewStore.getState().selected).toBe('T2');
  // React removes the old task after layout cleanup. Keeping its DOM here catches a pointless focus trip
  // even when that eventual removal would hide the error by leaving BODY focused again.
  expect(source.isConnected).toBe(true);
  expect(focus).not.toHaveBeenCalled();
  expect(document.activeElement).not.toBe(source);
});

test('an input label keeps its focus destination when its action opens another task', () => {
  const { view, source, focus } = open({ inReader: false });
  fireEvent.click(view.getByRole('button', { name: 'Open task' }));
  expect(document.activeElement).toBe(source);
  expect(focus).toHaveBeenCalledOnce();
});

test('changing a pane within the same task keeps the reference focus destination', () => {
  const { view, source, focus } = open({ paneOnly: true });
  fireEvent.click(view.getByRole('button', { name: 'Open task' }));
  expect(useViewStore.getState().selected).toBe('T1');
  expect(document.activeElement).toBe(source);
  expect(focus).toHaveBeenCalledOnce();
});

test('another surviving focus choice takes priority over returning to the reference', () => {
  const { view, focus } = open();
  const other = view.getByRole('button', { name: 'Another choice' });
  other.focus(); fireEvent.pointerDown(other);
  expect(document.activeElement).toBe(other);
  expect(focus).not.toHaveBeenCalled();
});

test('phone Back dismisses the preview and restores focus without retiring the task destination', () => {
  const narrow = narrowScreen(true);
  try {
    const { source, focus } = open();
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(document.activeElement).toBe(source);
    expect(focus).toHaveBeenCalledOnce();
  } finally { narrow.restore(); }
});
