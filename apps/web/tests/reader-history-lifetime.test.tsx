/** A reader without its reports does not read History. */
import { historyCursor } from '@alpacawork/contract';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { useTaskDetail, useTaskHistory } from '../src/data/queries';
import { useConnection } from '../src/data/connection';
import { dto, historyFixture, indexOf, screenData, TestWorkspace, tree, viewsOf } from './fixtures';

beforeEach(() => { queryClient.clear(); useConnection.setState({ state: 'live', offline: false }); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });

function fixture(reports = true) {
  const value = tree({ tasks: [dto({ id: 'T1', body: 'Reader body' })],
    history: { T1: historyFixture([{ id: 'L1', kind: 'comment', title: 'The report' }]) } });
  const data = screenData(value), index = indexOf(value), task = data.tasks.find(task => task.id === 'T1')!;
  const view = viewsOf(value).find(view => view.task.id === task.id)!;
  const historyOptions = resources.history(index.root, task.id);
  // The real feed consumes this same Query, only while the group's view is drawable (Reader.tsx).
  function Feed() { const history = useTaskHistory(index.root, task.id); return <span>{history.data?.pages[0]?.events[0]?.title}</span>; }
  function Reader() {
    const read = useTaskDetail(task, reports);
    return read.detail && <><p>{String(read.detail.values.values.notes ?? "")}</p>{reports && <Feed />}</>;
  }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify(
    String(url).includes('/task/history?') ? { generation: 'a', sourcePv: 0, events: value.history!.T1, hasOlder: false, oldestKey: historyCursor(value.history!.T1![0]!) } : view)));
  render(<TestWorkspace data={data}><Reader /></TestWorkspace>);
  return { index, view, fetcher, historyOptions };
}

test('a reader of files or a hover with reports=false does not acquire History', async () => {
  const f = fixture(false);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(screen.getByText('Reader body')).toBeTruthy();
  expect(f.fetcher.mock.calls.filter(([url]) => String(url).includes('/task/history?'))).toHaveLength(0);
});
