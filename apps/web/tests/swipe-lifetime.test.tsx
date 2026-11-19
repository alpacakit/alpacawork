import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef } from 'react';
import { useSwipeAnswer } from '../src/features/reader/swipe-answer';
import { cardFlying, flyAway } from '../src/features/reader/departure';

const run = vi.fn(() => 'retired' as 'retained' | 'retired' | 'rejected');
function Swipe({ on = true, identity = 'one' }: { on?: boolean; identity?: string }) {
  const card = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null), stamp = useRef<HTMLDivElement>(null);
  useSwipeAnswer(card, content, stamp, on, { answer: { kind: 'send', verb: 'Send', run }, hold: null }, identity);
  return <aside ref={card}><div ref={content} data-area><button>Question</button></div><div ref={stamp} /></aside>;
}
let pointerClock = 0;
const pointer = (type: string, x: number) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerType: 'touch', isPrimary: true, pointerId: 1, clientX: x, clientY: 100 });
  Object.defineProperty(event, 'timeStamp', { value: pointerClock += 16 });
  act(() => document.querySelector('[data-area]')!.dispatchEvent(event));
};
beforeEach(() => {
  run.mockClear(); pointerClock = 0;
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
});
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  cleanup(); vi.restoreAllMocks(); vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
});
for (const ending of ['pointercancel', 'lostpointercapture', 'hidden', 'rerender', 'retired'] as const)
  test(`a carried live card returns inside its viewport on ${ending}`, () => {
    const view = render(<Swipe />);
    pointer('pointerdown', 50); pointer('pointermove', 210);
    const card = document.querySelector('aside')!;
    expect(card.style.transform).toContain('translateX(160px)');
    if (ending === 'hidden') {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      act(() => document.dispatchEvent(new Event('visibilitychange')));
    } else if (ending === 'rerender') view.rerender(<Swipe identity="two" />);
    else if (ending === 'retired') view.rerender(<Swipe on={false} />);
    else pointer(ending, 210);
    expect(card.style.transform).toBe('');
    expect(card.hasAttribute('data-carried')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

for (const admission of ['retained', 'retired', 'rejected'] as const)
test(`local ${admission} submission captures the release pose then cleans the live panel immediately`, () => {
  let pose = '';
  run.mockImplementationOnce(() => { pose = document.querySelector('aside')!.style.transform; return admission; });
  render(<Swipe />);
  pointer('pointerdown', 50); pointer('pointermove', 210); pointer('pointerup', 210);
  expect(run).toHaveBeenCalledOnce();
  expect(pose).toContain('translateX(160px)');
  const card = document.querySelector('aside')!;
  expect(card.style.transform).toBe('');
  expect(card.hasAttribute('data-carried')).toBe(false);
  expect(card.style.transition === '').toBe(admission === 'retired');
});

test('transferring implicit capture from a choice to the content keeps the gesture', () => {
  render(<Swipe />);
  pointer('pointerdown', 50); pointer('pointermove', 210);
  const event = new Event('lostpointercapture', { bubbles: true });
  Object.assign(event, { pointerId: 1 });
  act(() => document.querySelector('button')!.dispatchEvent(event));
  expect(document.querySelector('aside')!.hasAttribute('data-carried')).toBe(true);
  pointer('pointercancel', 210);
  expect(document.querySelector('aside')!.style.transform).toBe('');
});

test('a paused decorative flight has a deadline and removes its input shield too', async () => {
  vi.useFakeTimers();
  const card = document.createElement('aside'); card.dataset.readerMode = 'sheet'; document.body.append(card);
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => ({ startTime: null, playState: 'paused',
    finished: new Promise(() => {}), cancel() {} }) as unknown as Animation);
  flyAway('send', 'Sent');
  expect(cardFlying()).toBe(true);
  expect(document.querySelector('[data-flying-card]')).toBeTruthy();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(document.querySelector('[data-flying-card]')).toBeNull();
  expect(cardFlying()).toBe(false);
  expect(document.body.children).toHaveLength(1);
  card.remove();
});

test('hiding a flight removes it once and a hidden receipt creates no copy', () => {
  const card = document.createElement('aside'); card.dataset.readerMode = 'sheet'; document.body.append(card);
  vi.spyOn(Element.prototype, 'animate').mockImplementation(() => ({ startTime: null,
    finished: new Promise(() => {}), cancel() {} }) as unknown as Animation);
  flyAway('send', 'Sent');
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('pagehide'));
  expect(cardFlying()).toBe(false);
  expect(document.querySelector('[data-flying-card]')).toBeNull();
  expect(flyAway('send', 'Sent')).toBeNull();
  expect(document.body.children).toHaveLength(1);
  card.remove();
});
