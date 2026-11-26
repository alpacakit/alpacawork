/** DOM ownership of reader controls; real sizing, touch and History remain in E2E. */
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { Reader } from '../src/features/reader/Reader';
import { useViewStore } from '../src/state/view-store';
import { queryClient } from '../src/data/query-client';
import { TestWorkspace, dto, historyFixture, narrowScreen, screenData, tree } from './fixtures';

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); queryClient.clear(); useViewStore.setState(useViewStore.getInitialState()); });
for (const mode of ['docked', 'sheet'] as const) test(`a ${mode} reader waiting for its task keeps its frame controls`, () => {
  const narrow = narrowScreen(mode === 'sheet');
  try {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise(() => {}));
    useViewStore.setState({ selected: null, reader: { open: true, pane: 'task', address: 'T999', returnTo: null } });
    render(<TestWorkspace><Reader mode={mode} /></TestWorkspace>);
    expect(document.querySelector('[data-reader-awaiting="T999"]')).toBeTruthy();
    expect(document.querySelectorAll('[data-reader-grow]')).toHaveLength(1);
    if (mode === 'docked') expect(document.querySelectorAll('[data-window-width]')).toHaveLength(1);
  } finally { narrow.restore(); }
});

test('the full reader report column has a report and no all-records entry', () => {
  const value = tree({ tasks: [dto({ id: 'T1' })], history: { T1: historyFixture([{ id: 'L1', kind: 'comment', title: 'Newest report' }]) } });
  const data = screenData(value);
  act(() => useViewStore.getState().openTask('T1', { reader: true }));
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  expect(document.querySelector('[data-report-feed] [data-report-key]')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /All records/ })).toBeNull();
  expect(document.querySelector('[data-all-records]')).toBeNull();
});
