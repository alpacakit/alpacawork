import { useRef, useState } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { goToReply, useReplyNavigation, useReplyNavigationOwner } from '../src/features/coordinator/reply-navigation';
afterEach(() => { cleanup(); useReplyNavigation.setState({ jump: null, back: null }); vi.restoreAllMocks(); });

test('a missing destination is consumed once and cannot execute after a later rendering; a new request still works', () => {
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  let show!: () => void;
  function Thread() {
    const root = useRef<HTMLOListElement>(null), [visible, setVisible] = useState(false);
    show = () => setVisible(true);
    useReplyNavigationOwner(root, 'conversation', 0, () => 'here');
    return <ol ref={root}>{visible && <li data-coordinator-message="missing"><div data-ask-answer>Now present</div></li>}</ol>;
  }
  render(<Thread />);
  act(() => goToReply('missing', { at: '2026-10-22T12:00:00Z' }));
  expect(useReplyNavigation.getState().jump).toBeNull();
  expect(useReplyNavigation.getState().back).toBeNull(); expect(scroll).not.toHaveBeenCalled();
  act(() => show()); expect(scroll).not.toHaveBeenCalled();
  act(() => goToReply('missing', { at: '2026-10-22T12:00:00Z' }));
  expect(scroll).toHaveBeenCalledTimes(1); expect(useReplyNavigation.getState().back).toEqual({ at: '2026-10-22T12:00:00Z' });
});
