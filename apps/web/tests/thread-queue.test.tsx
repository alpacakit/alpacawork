import { setConversationState } from './conversation-fixture';
import { useRef } from 'react';
import { SurfaceDocument } from '../src/lib/surface';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ThreadQueue } from '../src/features/coordinator/ThreadQueue';
import { useConversation } from '../src/features/coordinator/coordinator';
import type { Waiting } from '../src/features/coordinator/CoordinatorQueue';

let count = 1;
vi.mock('../src/features/coordinator/CoordinatorQueue', () => ({
  useWaiting: () => ({ count, waiting: [], local: [], running: true } satisfies Waiting),
  WaitingRows: () => <ol aria-label="Waiting rows" />,
}));
beforeEach(() => { count = 1; setConversationState({ expanded: false }); });
afterEach(cleanup);

test('the last message leaving ends the disclosure; new waiting starts closed', () => {
  const view = render(<ThreadQueue folded />);
  fireEvent.click(view.getByRole('button'), { detail: 1 });
  expect(view.queryByRole('dialog')).not.toBeNull();
  count = 0; view.rerender(<ThreadQueue folded />);
  expect(view.queryByRole('dialog')).toBeNull();
  expect(view.queryByRole('button')).toBeNull();
  count = 1; view.rerender(<ThreadQueue folded />);
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByRole('dialog')).toBeNull();
});

test('nonempty updates keep a queue open, and manual closing stays closed', () => {
  const view = render(<ThreadQueue folded />);
  fireEvent.click(view.getByRole('button'));
  count = 2; view.rerender(<ThreadQueue folded />);
  expect(view.queryByRole('dialog')).not.toBeNull();
  fireEvent.click(view.container.querySelector('[data-coordinator-queue-fold]')!);
  count = 1; view.rerender(<ThreadQueue folded />);
  expect(view.queryByRole('dialog')).toBeNull();
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
});

function FoldedQueue() {
  const area = useRef<HTMLDivElement>(null);
  return <div ref={area}><ThreadQueue area={area} folded /></div>;
}

test('the folded place ends its disclosure when the conversation opens, including across later waiting', () => {
  setConversationState({ expanded: false });
  const view = render(<FoldedQueue />);
  fireEvent.click(view.getByRole('button'));
  expect(view.queryByRole('dialog')).not.toBeNull();
  act(() => setConversationState({ expanded: true }));
  expect(view.queryByRole('dialog')).toBeNull();
  expect(view.queryByRole('button')).toBeNull();
  count = 0; view.rerender(<FoldedQueue />);
  act(() => setConversationState({ expanded: false }));
  count = 2; view.rerender(<FoldedQueue />);
  expect(view.queryByRole('dialog')).toBeNull();
  expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false');
});

test('an own window shows waiting messages in the thread and no queue button', () => {
  setConversationState({ expanded: false });
  const own = document.implementation.createHTMLDocument();
  const view = render(<SurfaceDocument value={own}><ThreadQueue /><FoldedQueue /></SurfaceDocument>);
  expect(view.queryByRole('button')).toBeNull();
  view.rerender(<SurfaceDocument value={null}><ThreadQueue /><FoldedQueue /></SurfaceDocument>);
  expect(view.getAllByRole('button')).toHaveLength(1);
  expect(view.container.querySelector('[data-coordinator-queue-end]')).toBeNull();
});
