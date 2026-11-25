import { afterEach, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { analysisTasksViewSchema, type AnalysisTasksView } from '@alpacawork/contract/analysis';
import { assessRead, onReadEvent, receiveFullIndex, resources } from '../src/data/resources';
import { restoreReadPersistence, startReadPersistence } from '../src/data/read-persistence';
import { readQuery } from '../src/data/read-model';
import { useConnection } from '../src/data/connection';
import { checkpointFixture } from './checkpoint-fixture';
import { indexOf, tree } from './fixtures';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); useConnection.setState({ offline: false }); });
const listed = indexOf(tree()), index = { ...listed, person: { ...listed.person, settings: 'stored-settings', notices: 'stored-notices' } };
const finished = { passed: 3, reworked: 1, stopped: 0, accepted: 4, finished: 4, share: null };
const accepted = { leadMedianMs: 60_000, submits: 5, questions: 1, prs: 2, time: { review: 1, answer: 2, ai: 3, other: 4 } };
const view: AnalysisTasksView = {
  head: { timeZone: 'UTC', today: '2026-11-25', firstDay: '2026-11-25', project: null, period: { from: '2026-11-25', to: '2026-11-25' }, previous: null },
  counts: { value: finished, previous: null }, accepted: { value: accepted, previous: null }, ever: null,
  series: { bucket: 'day', points: [{ from: '2026-11-25', to: '2026-11-25', complete: true, counts: finished, accepted }] },
  grass: { from: '2026-11-23', finished: [0, 0, 4] }, breakdown: null,
};
const client = () => {
  const made = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  cleanup.push(() => made.clear()); return made;
};
const options = () => resources.analysisView(index.root, 'tasks', { project: null, period: 'today', bucket: 'day', by: null }, analysisTasksViewSchema);

test('the analysis read once is kept for offline and drawn again at the next start, until it is read anew', async () => {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory);
  const asked = vi.fn(async (url: string) => {
    const path = new URL(url, 'http://fixture').pathname;
    if (path === '/api/commands/settings/get') return Response.json({ values: {}, revision: index.person.settings });
    if (path === '/api/person/notices') return Response.json({ state: null, revision: index.person.notices });
    if (path === '/api/commands/analysis/tasks') return Response.json(view);
    throw new Error('Unexpected HTTP ' + url);
  });
  vi.stubGlobal('fetch', (url: string) => asked(String(url)));
  const first = client();
  await restoreReadPersistence(first); receiveFullIndex(first, index);
  // The person's own reads come first, as at every start.
  await first.fetchQuery(resources.personalSettings(index.root)); await first.fetchQuery(resources.notices(index.root));
  await first.fetchQuery(options());
  const stop = startReadPersistence(first, listener => onReadEvent(first, listener)); cleanup.push(stop);
  await waitFor(() => expect(storage.read().slots.some((slot: any) => slot.key[0] === 'analysis-view')).toBe(true));
  stop();

  // The next start, with the network cut: what was read stands, and asking again keeps it.
  useConnection.setState({ offline: true });
  const next = client();
  await restoreReadPersistence(next);
  expect(next.getQueryData(options().queryKey)).toEqual(view);
  const observer = new QueryObserver(next, options());
  cleanup.push(observer.subscribe(() => {}));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(observer.getCurrentResult().data).toEqual(view);
  expect(asked.mock.calls.filter(([url]) => url.includes('analysis/')).length).toBe(1);
  // Once the workspace has moved on it is still shown, and wants reading again.
  receiveFullIndex(next, { ...index, rev: index.rev + 1 });
  expect(assessRead(next, readQuery(next, options().queryKey)!)).toMatchObject({ display: true, needsRead: true });
});
