import { problemResponse } from './problem';
import { notify, useToasts } from '../src/lib/notify';
import { seedPersonal } from './read-fixtures';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { defaultSettings } from '@alpacawork/contract';
import * as contract from '@alpacawork/contract';
import { PresenceMenu } from '../src/features/chrome/PresenceMenu';
import { usePersonalSettings } from '../src/data/personal-settings';
import { screenData, TestWorkspace } from './fixtures';
import { postPresence } from '../src/data/presence';
import { useConnection } from '../src/data/connection';

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); cleanup(); vi.useRealTimers(); vi.restoreAllMocks();
  useConnection.setState({ state: 'connecting', fresh: false, writable: false, offline: false });
  usePersonalSettings.setState(usePersonalSettings.getInitialState(), true); });

function mount(clock: string, paused = false, open = true) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`2026-10-16T${clock}:00+09:00`));
  const Original = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
    return new Original(locales, { timeZone: 'Asia/Tokyo', ...options });
  });
  seedPersonal({ status: 'ready', values: { ...defaultSettings(),
    'push.quiet': true, 'push.quietTo': '11:00', 'push.timeZone': 'UTC' }, revision: 'r1' });
  const data = screenData();
  if (paused) data.info.presence = { state: 'muted', until: '2026-10-16T02:00:00.000Z' };
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
  render(<TestWorkspace data={data}><PresenceMenu /></TestWorkspace>);
  if (open) fireEvent.click(document.querySelector('[data-presence-trigger]')!);
  return fetcher;
}

for (const [clock, day] of [['23:30', 'tomorrow'], ['00:30', 'today'], ['10:59', 'today'], ['11:00', 'tomorrow']] as const) {
  test(`morning menu says ${day} at ${clock} JST and sends the browser zone`, async () => {
    const fetcher = mount(clock);
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: `Pause until 11:00 ${day}` })); });
    const pause = fetcher.mock.calls.find(([url]) => String(url).endsWith('/pause'));
    expect(JSON.parse(String(pause?.[1]?.body))).toEqual({ duration: 'morning', timeZone: 'Asia/Tokyo' });
  });
}

test('an open menu changes tomorrow to today across midnight without a feed update', () => {
  mount('23:30');
  expect(screen.getByRole('menuitem', { name: 'Pause until 11:00 tomorrow' })).toBeTruthy();
  act(() => { vi.advanceTimersByTime(60 * 60_000); });
  expect(screen.getByRole('menuitem', { name: 'Pause until 11:00 today' })).toBeTruthy();
});

test('presence refuses before fetch even when uncertain results are accepted', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  useConnection.setState({ state: 'live', fresh: false, writable: true, offline: false });
  await expect(postPresence('/pause', { duration: 'hour' }, true)).rejects.toMatchObject({ retry: 'later' });
  expect(fetcher).not.toHaveBeenCalled();
  useConnection.setState({ fresh: true, writable: false });
  await expect(postPresence('/pause', { duration: 'hour' }, true)).rejects.toMatchObject({ code: 'forbidden', retry: 'fix' });
  expect(fetcher).not.toHaveBeenCalled();
});

test('choosing present without write access shows a failure and keeps the menu open', async () => {
  const fetcher = mount('00:30');
  for (const access of [{ fresh: false, writable: true, offline: true }, { fresh: true, writable: false, offline: false }]) {
    useConnection.setState({ state: 'live', ...access });
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: /Present/ })); });
    expect(screen.getByRole('menu', { name: 'Notification status' })).toBeTruthy();
    expect(useToasts.getState().toasts.some(toast => toast.kind === 'error')).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id);
  }
});

test('paused text formats the saved instant with the same today wording', () => {
  mount('00:30', true);
  expect(screen.getByText('Notifications paused until 11:00 today')).toBeTruthy();
});


test('a restored presence refusal keeps the shared reason and next action instead of a generic save error', async () => {
  const fetcher = mount('00:30');
  fetcher.mockResolvedValue(problemResponse('restore_changed'));
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Pause for 1 hour' })); });
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/pause'))).toBe(true);
  expect(useToasts.getState().toasts.find(toast => toast.kind === 'error')?.text).toBe(i18n.t('problem.code.restore_changed'));
});


test('a closed menu skips next-morning calculation and reopening uses the current time', () => {
  const morning = vi.spyOn(contract, 'morningUntil');
  mount('10:59', false, false);
  expect(morning).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(2 * 60_000); });
  expect(morning).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector('[data-presence-trigger]')!);
  expect(morning).toHaveBeenCalled();
  expect(screen.getByRole('menuitem', { name: 'Pause until 11:00 tomorrow' })).toBeTruthy();
  fireEvent.click(document.querySelector('[data-presence-trigger]')!);
  morning.mockClear();
  act(() => { vi.advanceTimersByTime(24 * 60 * 60_000); });
  expect(morning).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector('[data-presence-trigger]')!);
  expect(morning).toHaveBeenLastCalledWith(Date.now(), expect.objectContaining({ 'push.timeZone': 'Asia/Tokyo' }));
  expect(screen.getByRole('menuitem', { name: 'Pause until 11:00 tomorrow' })).toBeTruthy();
});
