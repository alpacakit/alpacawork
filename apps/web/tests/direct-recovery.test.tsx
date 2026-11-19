import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { notify, useToasts, type ToastOptions } from '../src/lib/notify';
import { useDirectWriteRecovery } from '../src/features/reader/recovery';
import { intentKey, checkWriteIntent, readWriteIntents, submitWriteIntent, useCheckedHere, useWriteIntentStore, type WriteIntent } from '../src/data/write-intent';
import { useConnection } from '../src/data/connection';
import { rememberWriteIdentity } from '../src/data/write-identity';
import { headOf, TestWorkspace, screenData, tree } from './fixtures';

beforeAll(() => startI18n());
afterEach(() => { notify.hold(document, false); useToasts.setState({ hidden: new Set() }); cleanup(); vi.restoreAllMocks(); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); });
const shown = (id: string) => useToasts.getState().toasts.find(toast => toast.id === id);
const key = intentKey('/fixture', 'project/new', 'foo');
const unknown: WriteIntent = { status: 'unconfirmed', operationId: 'fixed', transport: 'receipt',
  payload: { kind: 'project', title: 'Foo' }, attempt: 'first', at: '2026-10-17T10:00:00Z',
  recovery: { path: 'task/new', response: 'task', label: 'Foo' } };

test.each(['pending', 'unconfirmed'] as const)('reload checks a saved %s only after connection, and publishes only the new result', async status => {
  const data = screenData();
  const failure = { code: 'network_error', message: 'Previous page lost its response', retry: 'check' as const };
  const unproven = intentKey('/fixture', 'project/new', 'unproven');
  const unprovenReport = intentKey('/fixture', 'task/report', 'T4');
  const entries = {
    [key]: { ...unknown, status, failure },
    [intentKey('/fixture', 'task/report', 'T1')]: { ...unknown, status, failure, operationId: 'report',
      reader: { taskId: 'T1', title: 'Report task', turn: 'turn', phase: 'report', answer: 'done' as const, recovery: 'done' as const } },
    [intentKey('/fixture', 'settled', 'T2')]: { ...unknown, status: 'confirmed' as const, operationId: 'settled' },
    [intentKey('/fixture', 'refused', 'T3')]: { ...unknown, status: 'refused' as const, operationId: 'refused' },
    [unproven]: { ...unknown, status, operationId: 'unproven' },
    [unprovenReport]: { ...unknown, status, operationId: 'unproven-report',
      reader: { taskId: 'T4', title: 'Unproven task', turn: 'turn', phase: 'report', answer: 'done' as const, recovery: 'done' as const } },
  };
  for (const entry of Object.values(entries).slice(0, 4)) rememberWriteIdentity('/fixture', entry.operationId, 'initial');
  sessionStorage.setItem('alpacawork-write-intents-v5', JSON.stringify({ version: 1, entries }));
  useWriteIntentStore.setState(readWriteIntents());
  useConnection.setState({ state: 'reconnecting', fresh: false, offline: true });
  const responses: ((response: Response) => void)[] = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { responses.push(resolve); }));
  const error = vi.spyOn(notify, 'error');
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace data={data}>{children}</TestWorkspace> });
  expect(error).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  act(() => useConnection.setState({ state: 'live', fresh: true, writable: true, offline: false }));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(shown('write-intent:fixed')).toBeUndefined();
  expect(shown('reader-operation:report')).toBeUndefined();
  for (const [heldKey, id] of [[unproven, 'write-intent:unproven'], [unprovenReport, 'reader-operation:unproven-report']]) {
    const toast = shown(id!);
    expect(toast).toMatchObject({ kind: 'error', detail: i18n.t('forms:writeFailure.unproven') });
    expect(toast?.action).toBeUndefined();
    expect(useWriteIntentStore.getState().entries[heldKey!]).toEqual({ ...entries[heldKey!], status: 'unconfirmed' });
  }
  for (const [index, entry] of Object.values(entries).slice(0, 2).entries()) {
    const request = fetcher.mock.calls[index]![1]!;
    expect(JSON.parse(request.body as string)).toEqual(entry.payload);
    expect(new Headers(request.headers).get('X-Alpacawork-Op-Id')).toBe(entry.operationId);
  }
  await act(async () => {
    responses[0]!(new Response(JSON.stringify({ task: headOf(tree().tasks[0]!) })));
    responses[1]!(new Response(JSON.stringify({ error: { code: 'network_error', message: 'Still unknown', retry: 'check' } }), { status: 503 }));
  });
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
  expect(shown('write-intent:fixed')).toBeUndefined();
  expect(shown('reader-operation:report')).toMatchObject({ kind: 'error', action: { label: i18n.t('reader:recovery.check') } });
  error.mockClear();
  act(() => useConnection.setState({ lastReceivedAt: Date.now() }));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(error).not.toHaveBeenCalled();
  hook.unmount();
});

test('direct recovery observes saved transitions without replaying a notice for unrelated writes, and releases its subscription', () => {
  rememberWriteIdentity('/fixture', 'fixed', 'initial');
  const error = vi.spyOn(notify, 'error');
  const dismiss = vi.spyOn(notify, 'dismiss');
  useWriteIntentStore.setState({ entries: { [key]: unknown } });
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  // Closing the notification leaves settlement to the write owner.
  expect(error).toHaveBeenCalledWith(i18n.t('forms:writeFailure.checkWhich', { subject: 'Foo' }), expect.objectContaining({ id: 'write-intent:fixed', detail: i18n.t('forms:writeFailure.operationUnconfirmed'), action: expect.objectContaining({ run: expect.any(Function) }) }));
  expect(shown('write-intent:fixed')).toMatchObject({ kind: 'error', stays: true });
  error.mockClear();
  act(() => useWriteIntentStore.setState(state => ({ entries: { ...state.entries,
    [intentKey('/fixture', 'personal-setting:theme', null)]: { ...unknown, operationId: 'setting', recovery: undefined, status: 'confirmed' },
  } })));
  expect(error).not.toHaveBeenCalled();
  act(() => useWriteIntentStore.setState(state => ({ entries: { ...state.entries, [key]: { ...unknown, status: 'confirmed' } } })));
  expect(dismiss).toHaveBeenCalledWith('write-intent:fixed');
  expect(shown('write-intent:fixed')).toBeUndefined();
  hook.unmount(); error.mockClear();
  act(() => useWriteIntentStore.setState({ entries: { [key]: unknown } }));
  expect(error).not.toHaveBeenCalled();
  expect(useWriteIntentStore.getState().entries[key]).toEqual(unknown);
});

test('changing workspace releases old notices and observes only its new scope, including storage recovery', () => {
  const error = vi.spyOn(notify, 'error');
  const dismiss = vi.spyOn(notify, 'dismiss');
  let data = screenData();
  useWriteIntentStore.setState({ entries: { [key]: unknown }, unavailable: true });
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace data={data}>{children}</TestWorkspace> });
  expect(error).toHaveBeenCalledWith(i18n.t('forms:draft.storageUnavailable'), expect.any(Object));
  data = screenData(tree({ root: '/other' }));
  hook.rerender();
  expect(dismiss).toHaveBeenCalledWith('write-intent:fixed');
  error.mockClear();
  act(() => useWriteIntentStore.setState({ entries: { [key]: { ...unknown, attempt: 'changed' } }, unavailable: false }));
  expect(error).not.toHaveBeenCalled();
  expect(dismiss).toHaveBeenCalledWith('write-intent-storage');
  expect(useToasts.getState().toasts).toEqual([]);
});

test('a late check result stays in the write owner and cannot recreate a notification after its workspace unmounts', async () => {
  rememberWriteIdentity('/fixture', 'fixed', 'initial');
  let respond!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  const error = vi.spyOn(notify, 'error'), failure = vi.spyOn(notify, 'failure'), success = vi.spyOn(notify, 'success');
  useWriteIntentStore.setState({ entries: { [key]: unknown } });
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  const options: ToastOptions = error.mock.calls.find(([, options]) => options?.id === 'write-intent:fixed')![1]!;
  act(() => options.action!.run());
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('pending');
  expect(shown('write-intent:fixed')?.kind).toBe('pending');
  hook.unmount(); error.mockClear();
  expect(shown('write-intent:fixed')).toBeUndefined();
  await act(async () => {
    respond(new Response(JSON.stringify({ error: { code: 'invalid_input', message: 'Refused', retry: 'fix' } }), { status: 400 }));
  });
  expect(useWriteIntentStore.getState().entries[key]).toMatchObject({ status: 'refused', operationId: 'fixed', payload: unknown.payload });
  expect(error).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
  expect(success).not.toHaveBeenCalled();
  expect(useToasts.getState().toasts).toEqual([]);
});

test('hiding a check changes no operation record or admission, and publication after another dialog closes stays hidden', () => {
  useWriteIntentStore.setState({ entries: { [key]: unknown } });
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  const send = vi.fn(), build = vi.fn();
  act(() => notify.hide('write-intent:fixed'));
  expect(shown('write-intent:fixed')).toBeUndefined();
  expect(useWriteIntentStore.getState().entries[key]).toEqual(unknown);
  expect(submitWriteIntent(key, build, send)).toBeUndefined();
  expect(build).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  // A dialog showing the same check causes a suspend + republish, with no write-state transition.
  act(() => useCheckedHere.setState({ [key]: 1 }, true));
  act(() => useCheckedHere.setState({}, true));
  expect(shown('write-intent:fixed')).toBeUndefined();
  expect(useWriteIntentStore.getState().entries[key]).toEqual(unknown);
  hook.unmount();
  expect(useToasts.getState().hidden.size).toBe(0);
});

test('settling a hidden saved operation releases its impression, and a new operation on the same task is visible', () => {
  rememberWriteIdentity('/fixture', 'fixed', 'initial');
  rememberWriteIdentity('/fixture', 'another', 'initial');
  useWriteIntentStore.setState({ entries: { [key]: unknown } });
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  act(() => notify.hide('write-intent:fixed'));
  act(() => useWriteIntentStore.setState({ entries: { [key]: { ...unknown, status: 'confirmed' } } }));
  expect(useToasts.getState().hidden.size).toBe(0);
  act(() => useWriteIntentStore.setState({ entries: { [key]: { ...unknown, operationId: 'another' } } }));
  expect(shown('write-intent:another')?.action?.label).toBe(i18n.t('reader:recovery.check'));
  hook.unmount();
});

test('a check hidden while pending stays hidden at its terminal callback and releases its impression', async () => {
  rememberWriteIdentity('/fixture', 'fixed', 'initial');
  let respond!: (response: Response) => void;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(resolve => { respond = resolve; }));
  useWriteIntentStore.setState({ entries: { [key]: unknown } });
  const hook = renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  act(() => shown('write-intent:fixed')!.action!.run());
  act(() => notify.hide('write-intent:fixed'));
  expect(useToasts.getState().hidden.has('write-intent:fixed')).toBe(true);
  await act(async () => {
    respond(new Response(JSON.stringify({ task: headOf(tree().tasks[0]!) }), { status: 200 }));
  });
  expect(useWriteIntentStore.getState().entries[key]?.status).toBe('confirmed');
  expect(shown('write-intent:fixed')).toBeUndefined();
  expect(useToasts.getState().hidden.size).toBe(0);
  hook.unmount();
});

test.each([undefined, '{"restoreId":null}', '{bad', '{"restoreId":"unsupported"}', '{"restoreId":"initial","extra":true}'])('unproven notification offers no resend for %s and keeps its record', pin => {
  const pinKey = 'alpacawork-write-identity:' + JSON.stringify(['/fixture', 'fixed']);
  if (pin === undefined) sessionStorage.removeItem(pinKey); else sessionStorage.setItem(pinKey, pin);
  useWriteIntentStore.setState({ entries: { [key]: unknown }, unavailable: false });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  expect(shown('write-intent:fixed')).toMatchObject({ kind: 'error', detail: i18n.t('forms:writeFailure.unproven') });
  expect(shown('write-intent:fixed')?.action).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled();
  expect(useWriteIntentStore.getState().entries[key]).toEqual(unknown); expect(sessionStorage.getItem(pinKey)).toBe(pin ?? null);
});

test('a check refused by storage returns to the same unknown notification without a pending spinner', async () => {
  rememberWriteIdentity('/fixture', 'fixed', 'initial');
  useWriteIntentStore.setState({ entries: { [key]: unknown }, unavailable: false });
  renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  const fetcher = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('synthetic full storage'); });
  await act(async () => { shown('write-intent:fixed')!.action!.run(); });
  expect(shown('write-intent:fixed')?.kind).toBe('error'); expect(fetcher).not.toHaveBeenCalled();
  expect(useWriteIntentStore.getState().entries[key]).toEqual(unknown);
});

test.each(['body', 'report', 'settings'] as const)('a held %s notification says storage refusal in its original slot, keeps the attempt, and offers no ineffective check', async kind => {
  const fixedKey = intentKey('/fixture', kind === 'settings' ? 'server-settings' : kind === 'body' ? 'body' : 'task/report', kind === 'settings' ? null : 'T1');
  const entry: WriteIntent = { ...unknown, recovery: { ...unknown.recovery!, label: kind },
    ...(kind === 'report' ? { reader: { taskId: 'T1', title: 'Report task', turn: 'turn', phase: 'report', answer: 'done', recovery: 'done' } as const } : {}) };
  rememberWriteIdentity('/fixture', entry.operationId, 'initial');
  useWriteIntentStore.setState({ entries: { [fixedKey]: entry }, unavailable: false });
  const original = JSON.stringify({ version: 1, entries: { [fixedKey]: entry } });
  sessionStorage.setItem('alpacawork-write-intents-v5', original);
  const pinKey = 'alpacawork-write-identity:' + JSON.stringify(['/fixture', entry.operationId]), pin = sessionStorage.getItem(pinKey);
  renderHook(useDirectWriteRecovery, { wrapper: ({ children }) => <TestWorkspace>{children}</TestWorkspace> });
  const id = `${kind === 'report' ? 'reader-operation' : 'write-intent'}:fixed`, was = shown(id)!;
  expect(was.action).toBeTruthy();
  act(() => notify.hold(document, true));
  const fetcher = vi.spyOn(globalThis, 'fetch');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('synthetic full storage'); });
  await act(async () => { was.action!.run(); });
  expect(useToasts.getState().held.get(document)?.has(id)).toBe(true);
  expect(shown(id)).toMatchObject({ kind: 'error', detail: i18n.t('forms:draft.storageUnavailable'), order: was.order, came: was.came });
  expect(shown(id)?.action).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
  expect(useWriteIntentStore.getState().entries[fixedKey]).toBe(entry);
  expect(sessionStorage.getItem('alpacawork-write-intents-v5')).toBe(original);
  expect(sessionStorage.getItem(pinKey)).toBe(pin);
  const send = vi.fn();
  await expect(checkWriteIntent(fixedKey, send)).rejects.toMatchObject({ code: 'unavailable', retry: 'check' });
  expect(send).not.toHaveBeenCalled(); expect(useWriteIntentStore.getState().entries[fixedKey]).toBe(entry);
  act(() => notify.hold(document, false));
});
