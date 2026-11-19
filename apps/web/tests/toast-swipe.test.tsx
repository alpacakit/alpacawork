import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { Toaster } from '../src/components/ui/toaster';
import { notify, useToasts } from '../src/lib/notify';

beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
let moves: { frames: Keyframe[]; finish: () => void; cancel: ReturnType<typeof vi.fn> }[];
beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ toasts: [], held: new Map(), covered: new Map(), hidden: new Set() });
  moves = [];
  vi.spyOn(Element.prototype, 'animate').mockImplementation(frames => {
    let finish!: () => void, reject!: (e: Error) => void;
    const finished = new Promise<void>((yes, no) => { finish = yes; reject = no; });
    const cancel = vi.fn(() => reject(new Error('cancelled')));
    moves.push({ frames: frames as Keyframe[], finish, cancel });
    return { finished, cancel } as unknown as Animation;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** A notice that stays (an error) unless `goes`: then one that goes by itself (an info). */
function setup(goes = false) {
  const run = vi.fn();
  render(<><button>Opener</button><Toaster /></>);
  act(() => notify[goes ? 'info' : 'error']('A notice', { id: 'swipe', action: { label: 'Open', run } }));
  const card = document.querySelector<HTMLElement>('[data-toast]')!;
  Object.defineProperty(card, 'offsetWidth', { value: 320 });
  card.setPointerCapture = vi.fn(); card.hasPointerCapture = vi.fn(() => true); card.releasePointerCapture = vi.fn();
  return { card, run };
}
function point(target: Element, type: string, x: number, y = 0, t = 0, pointerType = 'touch', pointerId = 1) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerType, pointerId, isPrimary: true });
  Object.defineProperty(event, 'timeStamp', { value: t });
  fireEvent(target, event);
}
function swipe(card: Element, dx: number, t = 300) {
  point(card, 'pointerdown', 160, 0, 0);
  point(card, 'pointermove', 160 + dx, 0, t);
  point(card, 'pointerup', 160 + dx, 0, t + 120);
}
async function finish() { await act(async () => moves.at(-1)!.finish()); }
const lastFrame = () => moves.at(-1)!.frames.at(-1)!;

for (const [direction, dx] of [['left', -150], ['right', 150]] as const) test(`${direction} swipe waits for animation.finished before hiding only this toast`, async () => {
  const { card } = setup();
  act(() => notify.error('Another'));
  swipe(card, dx);
  expect(moves).toHaveLength(1);
  expect(moves[0]!.frames[0]!.transform).toBe(`translateX(${dx}px)`);
  expect(card.isConnected).toBe(true);
  await finish();
  expect(card.isConnected).toBe(false);
  expect(screen.getByText('Another')).toBeTruthy();
});

test('short slow movement follows the finger, then returns with opacity restored', async () => {
  const { card } = setup();
  point(card, 'pointerdown', 160);
  point(card, 'pointermove', 210, 0, 200);
  expect(card.style.transform).toBe('translateX(50px)');
  expect(Number(card.style.opacity)).toBeLessThan(1);
  point(card, 'pointerup', 210, 0, 400);
  expect(lastFrame()).toMatchObject({ transform: 'translateX(0px)', opacity: 1 });
  await finish(); expect(card.style.transform).toBe(''); expect(card.style.opacity).toBe('');
  expect(card.isConnected).toBe(true);
});

for (const dx of [-35, 35]) test(`recent fast flick ${dx}px closes below the distance threshold`, async () => {
  const { card } = setup();
  point(card, 'pointerdown', 160); point(card, 'pointermove', 160 + dx / 2, 0, 10);
  point(card, 'pointermove', 160 + dx, 0, 30); point(card, 'pointerup', 160 + dx, 0, 35);
  await finish(); expect(card.isConnected).toBe(false);
});

test('returning inward past the distance line does not dismiss, including after a pause', async () => {
  const { card } = setup();
  point(card, 'pointerdown', 160); point(card, 'pointermove', 340, 0, 100);
  point(card, 'pointermove', 310, 0, 150); point(card, 'pointerup', 310, 0, 400);
  expect(lastFrame().transform).toBe('translateX(0px)'); await finish(); expect(card.isConnected).toBe(true);
});

test('vertical movement gives this whole gesture to scrolling', () => {
  const { card } = setup();
  point(card, 'pointerdown', 160); point(card, 'pointermove', 166, 30, 40);
  point(card, 'pointermove', 360, 40, 100); point(card, 'pointerup', 360, 40, 110);
  expect(card.style.transform).toBe(''); expect(moves).toHaveLength(0);
  expect(card.setPointerCapture).not.toHaveBeenCalled();
});

for (const event of ['pointercancel', 'lostpointercapture']) test(`${event} returns a carried card`, async () => {
  const { card } = setup();
  point(card, 'pointerdown', 160); point(card, 'pointermove', 310, 0, 100); point(card, event, 310, 0, 120);
  expect(lastFrame().transform).toBe('translateX(0px)'); await finish(); expect(card.isConnected).toBe(true);
});

test('losing a child action capture when the card takes it does not cancel the swipe', async () => {
  const { card } = setup(); const action = screen.getByRole('button', { name: 'Open' });
  point(action, 'pointerdown', 160); point(card, 'pointermove', 310, 0, 100);
  point(action, 'lostpointercapture', 310, 0, 110);
  expect(moves).toHaveLength(0);
  point(card, 'pointerup', 310, 0, 200); await finish(); expect(card.isConnected).toBe(false);
});

test('resize cancels a swipe', async () => {
  const { card } = setup(); point(card, 'pointerdown', 160); point(card, 'pointermove', 310, 0, 100);
  fireEvent(window, new Event('resize')); await finish(); expect(card.isConnected).toBe(true); expect(card.style.transform).toBe('');
});

for (const name of ['Open', 'Close notification']) test(`horizontal swipe suppresses its generated click on ${name}, and a later tap works`, async () => {
  const { card, run } = setup(); const button = screen.getByRole('button', { name });
  swipe(card, 45); fireEvent.click(button, { detail: 1 });
  expect(run).not.toHaveBeenCalled(); expect(card.isConnected).toBe(true);
  await finish();
  point(button, 'pointerdown', 160); point(button, 'pointerup', 160, 0, 500); fireEvent.click(button, { detail: 1 });
  if (name === 'Open') expect(run).toHaveBeenCalledOnce(); else expect(card.isConnected).toBe(false);
});

test('movement below the direction lock remains an ordinary action tap', () => {
  const { run } = setup(); const action = screen.getByRole('button', { name: 'Open' });
  point(action, 'pointerdown', 160); point(action, 'pointermove', 164, 3, 60); point(action, 'pointerup', 164, 3, 80);
  fireEvent.click(action, { detail: 1 }); expect(run).toHaveBeenCalledOnce(); expect(moves).toHaveLength(0);
});

test('mouse text dragging does not swipe or prevent a later click', () => {
  const { card, run } = setup();
  point(card, 'pointerdown', 160, 0, 0, 'mouse'); point(card, 'pointermove', 310, 0, 80, 'mouse'); point(card, 'pointerup', 310, 0, 100, 'mouse');
  expect(card.style.transform).toBe(''); expect(moves).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Open' }), { detail: 1 }); expect(run).toHaveBeenCalledOnce();
});

test('pen swipes like touch; other pointer IDs cannot finish its gesture', async () => {
  const { card } = setup(); point(card, 'pointerdown', 160, 0, 0, 'pen'); point(card, 'pointermove', 310, 0, 100, 'pen');
  point(card, 'pointerup', 310, 0, 200, 'pen', 2); expect(moves).toHaveLength(0);
  point(card, 'pointerup', 310, 0, 250, 'pen'); await finish(); expect(card.isConnected).toBe(false);
});

for (const dx of [45, 150]) test(`reduced motion follows the finger but settles ${dx}px immediately`, () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const { card } = setup(); point(card, 'pointerdown', 160); point(card, 'pointermove', 160 + dx, 0, 150);
  expect(card.style.transform).toBe(`translateX(${dx}px)`); point(card, 'pointerup', 160 + dx, 0, 350);
  expect(moves).toHaveLength(0); expect(card.isConnected).toBe(dx < 100); expect(card.style.transform).toBe('');
});

test('pointer holding pauses expiration; expiration during departure cancels the old animation without a second hide', async () => {
  const { card } = setup(true); const hide = vi.spyOn(notify, 'hide');
  act(() => vi.advanceTimersByTime(7900)); fireEvent.pointerOver(card);
  point(card, 'pointerdown', 160); point(card, 'pointermove', 310, 0, 200);
  act(() => vi.advanceTimersByTime(20_000)); expect(card.isConnected).toBe(true);
  point(card, 'pointerup', 310, 0, 350); fireEvent.pointerOut(card);
  act(() => vi.advanceTimersByTime(150)); expect(card.isConnected).toBe(false);
  await finish(); expect(hide).not.toHaveBeenCalled(); expect(moves[0]!.cancel).toHaveBeenCalled();
});

test('a pending result replacing the same ID during departure stays on its way out and becomes hidden', async () => {
  const { card } = setup(); const hide = vi.spyOn(notify, 'hide');
  act(() => notify.pending('Checking', { id: 'swipe', ongoing: true }));
  swipe(card, 150);
  act(() => notify.success('Replacement', { id: 'swipe', ongoing: true }));
  expect(screen.getByText('Replacement').closest('[data-toast]')).toBe(card);
  expect(card.style.transform).toBe('translateX(150px)');
  expect(moves[0]!.cancel).not.toHaveBeenCalled();
  expect(useToasts.getState().hidden.has('swipe')).toBe(false);
  await finish();
  expect(hide).toHaveBeenCalledExactlyOnceWith('swipe'); expect(card.isConnected).toBe(false);
  expect(useToasts.getState().hidden.has('swipe')).toBe(true);
  act(() => notify.info('Published again', { id: 'swipe', ongoing: true }));
  expect(screen.queryByText('Published again')).toBeNull();
});

test('closing after a swipe returns focus to the existing opener', async () => {
  const { card } = setup(); const opener = screen.getByRole('button', { name: 'Opener' });
  act(() => opener.focus()); act(() => screen.getByRole('button', { name: 'Open' }).focus());
  swipe(card, 150); await finish(); expect(document.activeElement).toBe(opener);
});

test('same-ID republication keeps a swipe tracking until release, then hides it without running its action', async () => {
  const { card } = setup(); const run = vi.fn();
  act(() => notify.pending('Checking', { id: 'swipe', ongoing: true }));
  point(card, 'pointerdown', 160); point(card, 'pointermove', 110, 0, 200);
  act(() => notify.info('Replacement', { id: 'swipe', ongoing: true, action: { label: 'New action', run } }));
  expect(screen.getByText('Replacement').closest('[data-toast]')).toBe(card);
  expect(card.style.transform).toBe('translateX(-50px)');
  expect(card.releasePointerCapture).not.toHaveBeenCalled();
  point(card, 'pointermove', 10, 0, 300);
  expect(card.style.transform).toBe('translateX(-150px)');
  point(card, 'pointerup', 10, 0, 450);
  fireEvent.click(screen.getByRole('button', { name: 'New action' }), { detail: 1 });
  expect(run).not.toHaveBeenCalled(); expect(card.isConnected).toBe(true);
  await finish(); expect(card.isConnected).toBe(false);
  expect(useToasts.getState().hidden.has('swipe')).toBe(true);
});

test('same-ID replacement during return keeps the animation and the swipe click suppressed', async () => {
  const { card } = setup(); const run = vi.fn(); swipe(card, 50);
  act(() => notify.info('Replacement', { id: 'swipe', ongoing: true, action: { label: 'New action', run } }));
  expect(moves).toHaveLength(1); expect(moves[0]!.cancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'New action' }), { detail: 1 });
  await finish();
  expect(run).not.toHaveBeenCalled(); expect(card.style.transform).toBe(''); expect(card.isConnected).toBe(true);
  expect(useToasts.getState().hidden.has('swipe')).toBe(false);
});

test('Escape during departure closes once and cancels its pending completion', async () => {
  const { card } = setup(); const hide = vi.spyOn(notify, 'hide');
  act(() => screen.getByRole('button', { name: 'Open' }).focus());
  swipe(card, 150); fireEvent.keyDown(card, { key: 'Escape' }); await finish();
  expect(hide).toHaveBeenCalledTimes(1); expect(card.isConnected).toBe(false);
});

test('a same-ID replacement published in the animation completion turn is hidden by that swipe', async () => {
  const { card } = setup(); const hide = vi.spyOn(notify, 'hide'); swipe(card, 150);
  await act(async () => {
    notify.success('Same-turn replacement', { id: 'swipe', ongoing: true });
    moves.at(-1)!.finish();
    await Promise.resolve();
  });
  expect(hide).toHaveBeenCalledExactlyOnceWith('swipe'); expect(card.isConnected).toBe(false);
  expect(useToasts.getState().hidden.has('swipe')).toBe(true);
});

test('unmount cancels departure so a later card with the same ID keeps its own lifetime', async () => {
  const { card } = setup(); swipe(card, 150);
  act(() => notify.hide('swipe'));
  expect(card.isConnected).toBe(false); expect(moves[0]!.cancel).toHaveBeenCalledOnce();
  act(() => notify.info('New card', { id: 'swipe' }));
  const next = screen.getByText('New card').closest('[data-toast]');
  expect(next).not.toBe(card);
  const hide = vi.spyOn(notify, 'hide');
  await finish();
  expect(hide).not.toHaveBeenCalled(); expect(next?.isConnected).toBe(true);
});
