import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { UNUSABLE_SHOWN_AFTER_MS, UNUSABLE_SHOWN_FOR_MS, useSteadyControl } from '@/lib/steady-control';

function Control({ blocked, seen, run }: { blocked: boolean; seen?: string; run: () => void }) {
  const steady = useSteadyControl(blocked, seen);
  return <button disabled={steady.disabled} onClick={steady.press(run)} />;
}
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test('a control looks disabled only once it has stayed unusable, and then long enough not to flash', () => {
  const run = vi.fn();
  const view = render(<Control blocked={false} run={run} />), button = view.container.querySelector('button')!;
  view.rerender(<Control blocked run={run} />);
  wait(UNUSABLE_SHOWN_AFTER_MS - 1);
  expect(button.disabled).toBe(false);
  view.rerender(<Control blocked={false} run={run} />);
  view.rerender(<Control blocked run={run} />);
  wait(UNUSABLE_SHOWN_AFTER_MS);
  expect(button.disabled).toBe(true);
  view.rerender(<Control blocked={false} run={run} />);
  wait(UNUSABLE_SHOWN_FOR_MS - 1);
  expect(button.disabled).toBe(true);
  wait(1);
  expect(button.disabled).toBe(false);
});

test('a press in a short wait runs once when the wait ends, never against the guard', () => {
  const run = vi.fn();
  const view = render(<Control blocked={false} seen="v1" run={run} />), button = view.container.querySelector('button')!;
  view.rerender(<Control blocked seen="v1" run={run} />);
  fireEvent.click(button); fireEvent.click(button);
  expect(run).not.toHaveBeenCalled();
  view.rerender(<Control blocked={false} seen="v1" run={run} />);
  expect(run).toHaveBeenCalledTimes(1);
});

test('a kept press is dropped when what it was made on changed, or the control came to look disabled', () => {
  const run = vi.fn();
  const view = render(<Control blocked={false} seen="v1" run={run} />), button = view.container.querySelector('button')!;
  view.rerender(<Control blocked seen="v1" run={run} />);
  fireEvent.click(button);
  view.rerender(<Control blocked={false} seen="v2" run={run} />);
  view.rerender(<Control blocked seen="v2" run={run} />);
  fireEvent.click(button);
  wait(UNUSABLE_SHOWN_AFTER_MS);
  view.rerender(<Control blocked={false} seen="v2" run={run} />);
  wait(UNUSABLE_SHOWN_FOR_MS);
  expect(run).not.toHaveBeenCalled();
});

test('controls sharing one guard each keep their own press, the last of each, in the order last pressed', () => {
  const ran: string[] = [];
  function Choices({ blocked, seen }: { blocked: boolean; seen: string }) {
    const steady = useSteadyControl(blocked, seen);
    return <>{['a', 'b'].map(name => <button key={name} data-name={name} disabled={steady.disabled} onClick={steady.press(() => { ran.push(name); })} />)}</>;
  }
  const view = render(<Choices blocked={false} seen="v1" />);
  view.rerender(<Choices blocked seen="v1" />);
  const [a, b] = [...view.container.querySelectorAll('button')];
  // b's press stands on what was seen then (v1) and goes with it; a, pressed again on v2, goes last.
  fireEvent.click(a!); fireEvent.click(b!);
  view.rerender(<Choices blocked seen="v2" />);
  fireEvent.click(a!);
  view.rerender(<Choices blocked={false} seen="v2" />);
  expect(ran).toEqual(['a']);
  view.rerender(<Choices blocked seen="v2" />);
  fireEvent.click(a!); fireEvent.click(b!); fireEvent.click(a!);
  view.rerender(<Choices blocked={false} seen="v2" />);
  expect(ran).toEqual(['a', 'b', 'a']);
});
