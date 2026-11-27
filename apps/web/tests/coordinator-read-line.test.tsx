import { snapshotJson, SERVED, servedTurn } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { CoordinatorCard } from "../src/features/coordinator/CoordinatorCard";
import { useConversation } from "../src/features/coordinator/coordinator";
import { allRead, opening } from "../src/features/coordinator/read-boundary";
import type { CoordinatorConversation, CoordinatorTurn } from "../src/data/coordinator";
import { TestWorkspace, screenData } from "./fixtures";

const at = "2026-10-19T08:00:00.000Z";
const answered = (n: number, extra: Partial<CoordinatorTurn> = {}): CoordinatorTurn => servedTurn('conversation-1', { id: `turn-${n}`, at, ask: `Request ${n}`,
  attachments: [], status: "succeeded", waiting: false, answer: `Answer ${n}.`, answeredAt: at, seen: n <= 3, error: null, result: null, ...extra });
const conversation = (turns: CoordinatorTurn[]): CoordinatorConversation => ({ id: "conversation-1", nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns });
const five = [1, 2, 3, 4, 5].map(n => answered(n));
/** E: an earlier row; H: the opened history's head; o/f: an open/folded exchange. */
const shape = () => [...document.querySelectorAll<HTMLElement>("[data-coordinator-thread] > li")]
  .map(row => row.dataset.earlier ? "E" : row.dataset.earlierHead !== undefined ? "H" : row.dataset.exchange === "open" ? "o" : "f").join("");
function show(turns: CoordinatorTurn[]) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init?: RequestInit) => Promise.resolve(new Response(snapshotJson(url.endsWith("/read") ? JSON.parse(String(init?.body)) : useConversation.getState().conversation)))));
  setConversationState({ conversation: conversation(turns) });
  setConversationState({ open: true, expanded: true, opening: opening(turns) });
  render(<TestWorkspace><CoordinatorCard /></TestWorkspace>);
  // A person is at the page: only then does an open conversation read.
  fireEvent.pointerDown(document);
}
beforeAll(() => startI18n());
beforeEach(async () => { screenData(); await i18n.changeLanguage("en"); setConversationState(useConversation.getInitialState()); });
afterEach(async () => { await act(async () => {}); cleanup(); vi.unstubAllGlobals(); setConversationState(useConversation.getInitialState()); });

test("presentation chooses the latest sent exchange, excluding waiting and joined messages", () => {
  const turns = [answered(1, { seen: false }), answered(2, { seen: false }),
    answered(3, { status: 'queued', waiting: true, answeredAt: null }), answered(4, { status: 'joined' })];
  expect(opening(turns).latest).toBe('turn-2');
  expect(allRead(conversation(turns))).toBe(false);
});

test("opening reads folded history without unfolding it; its entrance counts messages, read or not", async () => {
  show(five);
  expect(shape()).toBe('Eo');
  expect(document.querySelector('[data-earlier]')?.textContent).toContain('4 earlier messages');
  await waitFor(() => expect(useConversation.getState().read).toBe(true));
  expect(shape()).toBe('Eo');
  expect(document.querySelector('[data-earlier]')?.textContent).toContain('4 earlier messages');
  const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/read'));
  expect(calls.flatMap(([, init]) => JSON.parse(String(init?.body)).seen)).toEqual(['turn-4', 'turn-5']);
});

test("revealing history puts its head in the entrance's place, shows earlier exchanges, and folding it again goes back, the focus with each", async () => {
  show(five.map(turn => ({ ...turn, seen: true })));
  expect(shape()).toBe('Eo');
  const button = document.querySelector<HTMLButtonElement>('[data-earlier] button')!;
  button.focus();
  fireEvent.click(button);
  await act(async () => {});
  expect(document.querySelector('[data-earlier]')).toBeNull();
  expect(shape()).toBe('Hffffo');
  expect([...document.querySelectorAll<HTMLElement>('[data-coordinator-message]')].map(row => row.dataset.coordinatorMessage))
    .toEqual(five.map(turn => turn.id));
  const fold = document.querySelector<HTMLButtonElement>('[data-earlier-fold]')!;
  expect(document.activeElement).toBe(fold);
  fireEvent.click(fold);
  await act(async () => {});
  expect(shape()).toBe('Eo');
  expect(document.activeElement).toBe(document.querySelector('[data-earlier] button'));
});

test("arrivals stay shown while old history remains independently folded", async () => {
  show(five.map(turn => ({ ...turn, seen: true })));
  act(() => setConversationState({ conversation: conversation([...five.map(turn => ({ ...turn, seen: true })), answered(6)]) }));
  expect(shape()).toBe('Eoo');
  fireEvent.keyDown(document);
  await waitFor(() => expect(useConversation.getState().read).toBe(true));
});

test("opening the conversation again folds manually opened history", async () => {
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  try {
    show(five.map(turn => ({ ...turn, seen: true })));
    fireEvent.click(document.querySelector('[data-earlier] button')!);
    expect(document.querySelector('[data-earlier]')).toBeNull();
    act(() => useConversation.getState().setExpanded(false));
    await act(async () => useConversation.getState().setExpanded(true));
    expect(shape()).toBe('Eo');
    expect(document.querySelector('[data-earlier]')?.getAttribute('data-earlier')).toBe('folded');
    expect(document.querySelector('[data-coordinator-turn]')?.getAttribute('data-coordinator-message')).toBe('turn-5');
  } finally {
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  }
});

test('reopening after midnight refreshes message dates and still accepts a changed answer', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // JSDOM has no running animations; this case keeps the real reopen path.
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  try {
    vi.setSystemTime(new Date(at));
    const turn = answered(1, { seen: true });
    show([turn]);
    const clock = () => document.querySelector('[data-coordinator-answer-meta] time')?.textContent;
    const format = (withDate: boolean) => new Date(at).toLocaleString('en', { ...(withDate ? { month: 'numeric', day: 'numeric' } as const : {}), hour: '2-digit', minute: '2-digit', hour12: false });
    expect(clock()).toBe(format(false));
    act(() => useConversation.getState().setExpanded(false));
    vi.setSystemTime(new Date(Date.parse(at) + 24 * 60 * 60_000));
    await act(async () => useConversation.getState().setExpanded(true));
    expect(clock()).toBe(format(true));
    act(() => setConversationState({ conversation: conversation([{ ...turn, answer: 'The answer changed after reopening.' }]) }));
    expect(document.querySelector('[data-ask-answer]')?.textContent).toContain('The answer changed after reopening.');
  } finally {
    vi.useRealTimers();
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  }
});
