import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { startI18n } from '@alpacawork/i18n';
import { historyCursor } from '@alpacawork/contract';
import { Reader } from '../src/features/reader/Reader';
import { queryClient } from '../src/data/query-client';
import { indexKey, resources } from '../src/data/resources';
import { useViewStore } from '../src/state/view-store';
import { dto, historyFixture, indexOf, screenData, TestWorkspace, tree, viewsOf } from './fixtures';

afterEach(() => { cleanup(); queryClient.clear(); useViewStore.setState(useViewStore.getInitialState()); vi.restoreAllMocks(); });

test('a History that is read while its view fails stays, and the view says why it is missing and reads it again', async () => {
  await startI18n();
  const value = tree({ tasks: [dto()] }), data = screenData(value), index = indexOf(value);
  queryClient.setQueryData(indexKey, index);
  queryClient.removeQueries({ queryKey: resources.taskView(index.root, 'T1').queryKey, exact: true });
  queryClient.removeQueries({ queryKey: resources.history(index.root, 'T1').queryKey, exact: true });
  const events = historyFixture([{ id: 'review-known', kind: 'report', title: 'Known review history', summary: 'Known report body' }]);
  let viewUp = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    const history = String(url).includes('task/history?');
    if (history) return Response.json({ generation: 'a', sourcePv: 0, events, hasOlder: false, oldestKey: historyCursor(events[0]!) });
    return viewUp ? Response.json(viewsOf(value)[0])
      : Response.json({ error: { code: 'unavailable', retry: 'later', message: 'Synthetic view unavailable' } }, { status: 503 });
  });
  act(() => useViewStore.getState().openTask('T1', { reader: true, pane: 'task' }));
  render(<TestWorkspace data={{ ...data, seed: () => {} }}><Reader mode="docked" /></TestWorkspace>);
  await waitFor(() => expect(document.querySelector('[data-report-key="log:T1:review-known"]')).not.toBeNull());
  // The History stays, and the view's part says it could not be read, with a way to read it again.
  const failure = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-read-failure]'); expect(found).not.toBeNull(); return found!; });
  viewUp = true;
  fireEvent.click(failure.querySelector('button')!);
  await waitFor(() => expect(document.querySelector('[data-read-failure]')).toBeNull());
  expect(document.querySelector('[data-report-key="log:T1:review-known"]')).not.toBeNull();
});

test('a held view whose new read fails stays, with its History, and says the failure and reads it again', async () => {
  await startI18n();
  const value = tree({ tasks: [dto()] }), data = screenData(value), index = indexOf(value);
  queryClient.setQueryData(indexKey, index);
  queryClient.removeQueries({ queryKey: resources.taskView(index.root, 'T1').queryKey, exact: true });
  queryClient.removeQueries({ queryKey: resources.history(index.root, 'T1').queryKey, exact: true });
  const events = historyFixture([{ id: 'review-known', kind: 'report', title: 'Known review history', summary: 'Known report body' }]);
  let viewUp = true;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
    if (String(url).includes('task/history?')) return Response.json({ generation: 'a', sourcePv: 0, events, hasOlder: false, oldestKey: historyCursor(events[0]!) });
    return viewUp ? Response.json(viewsOf(value)[0])
      : Response.json({ error: { code: 'unavailable', retry: 'later', message: 'Synthetic view unavailable' } }, { status: 503 });
  });
  const key = resources.taskView(index.root, 'T1').queryKey;
  act(() => useViewStore.getState().openTask('T1', { reader: true, pane: 'task' }));
  render(<TestWorkspace data={{ ...data, seed: () => {} }}><Reader mode="docked" /></TestWorkspace>);
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).toBe('success'));
  // The list moves on and the view is read again, and that read fails: what was read stays.
  viewUp = false;
  queryClient.setQueryData(indexKey, { ...index, rev: index.rev + 1, sourcePv: 1, requiredPv: { ...index.requiredPv, view: { T1: 1 } } });
  await act(async () => { await queryClient.invalidateQueries({ queryKey: key, exact: true }); });
  const failure = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-read-failure]'); expect(found).not.toBeNull(); return found!; });
  expect(queryClient.getQueryData(key)).toBeDefined();
  expect(document.querySelector('[data-report-key="log:T1:review-known"]')).not.toBeNull();
  viewUp = true;
  fireEvent.click(failure.querySelector('button')!);
  await waitFor(() => expect(document.querySelector('[data-read-failure]')).toBeNull());
  expect(document.querySelector('[data-report-key="log:T1:review-known"]')).not.toBeNull();
});
