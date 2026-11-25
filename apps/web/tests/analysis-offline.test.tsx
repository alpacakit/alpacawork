import { afterEach, expect, test, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { analysisTasksViewSchema, type AnalysisTasksView } from '@alpacawork/contract/analysis';
import { assessRead, onReadEvent, receiveFullIndex, resources } from '../src/data/resources';
import { restoreReadPersistence, startReadPersistence } from '../src/data/read-persistence';
import { readQuery } from '../src/data/read-model';
import { useConnection } from '../src/data/connection';
import { OFFLINE_SHOWN_AFTER_MS } from '../src/data/reach';
import { ReadPart } from '../src/features/analysis/parts';
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
const head = view.head, counts = { launches: 1, runMs: 60_000, live: 0, newConversations: 1, tokens: { output: 1, input: 2, cache: 3 }, tokensUnknown: 0, tasks: 1 };
const row = { id: 'T2', title: 'Fictional task', project: 'P1', outcome: 'passed' as const, finishedAt: '2026-11-25T01:00:00.000Z', value: null };
const listed_ = { head, total: 1, rows: [row], cursor: null };
const unit = { head, unit: { ...row, requestedAt: '2026-11-25T00:00:00.000Z', asked: 'T2' }, band: [], marks: [], time: accepted.time,
  submits: 1, questions: 0, sendBacks: 0, instructionsAtReview: 0, instructionsAfterAccept: 0, instructionsDuringWork: 0, answers: 0,
  workers: 0, children: 0, usage: counts, models: [], prs: [], skills: [], tools: [], tallied: { runs: 0, of: 0, since: '2026-11-25' } };
const listOptions = () => resources.analysisList(index.root, { project: null, period: 'today', set: 'finished', limit: '100' });
const options = () => resources.analysisView(index.root, 'tasks', { project: null, period: 'today', bucket: 'day', by: null }, analysisTasksViewSchema);

test('the analysis read once is kept for offline and drawn again at the next start, until it is read anew', async () => {
  const storage = checkpointFixture(); vi.stubGlobal('indexedDB', storage.factory);
  const asked = vi.fn(async (url: string) => {
    const path = new URL(url, 'http://fixture').pathname;
    if (path === '/api/commands/settings/get') return Response.json({ values: {}, revision: index.person.settings });
    if (path === '/api/person/notices') return Response.json({ state: null, revision: index.person.notices });
    if (path === '/api/commands/analysis/tasks') return Response.json(view);
    if (path === '/api/commands/analysis/list') return Response.json(listed_);
    if (path === '/api/commands/analysis/task') return Response.json(unit);
    throw new Error('Unexpected HTTP ' + url);
  });
  vi.stubGlobal('fetch', (url: string) => asked(String(url)));
  const first = client();
  await restoreReadPersistence(first); receiveFullIndex(first, index);
  // The person's own reads come first, as at every start.
  await first.fetchQuery(resources.personalSettings(index.root)); await first.fetchQuery(resources.notices(index.root));
  await first.fetchQuery(options());
  // A list and one task's values opened once are kept as well.
  await first.fetchInfiniteQuery(listOptions()); await first.fetchQuery(resources.analysisTask(index.root, 'T2'));
  const stop = startReadPersistence(first, listener => onReadEvent(first, listener)); cleanup.push(stop);
  await waitFor(() => expect(storage.read().slots.filter((slot: any) => slot.key[0] === 'analysis-view').map((slot: any) => slot.key[2]).sort())
    .toEqual(['list', 'task', 'tasks']));
  stop();

  // The next start, with the network cut: what was read stands, and asking again keeps it.
  useConnection.setState({ offline: true });
  const next = client();
  await restoreReadPersistence(next);
  expect(next.getQueryData(options().queryKey)).toEqual(view);
  expect(next.getQueryData(listOptions().queryKey)).toMatchObject({ pages: [listed_] });
  expect(next.getQueryData(resources.analysisTask(index.root, 'T2').queryKey)).toEqual(unit);
  const observer = new QueryObserver(next, options());
  cleanup.push(observer.subscribe(() => {}));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(observer.getCurrentResult().data).toEqual(view);
  expect(asked.mock.calls.filter(([url]) => url.includes('analysis/')).length).toBe(3);
  // Once the workspace has moved on it is still shown, and wants reading again.
  receiveFullIndex(next, { ...index, rev: index.rev + 1 });
  expect(assessRead(next, readQuery(next, options().queryKey)!)).toMatchObject({ display: true, needsRead: true });
});

test('a part never read stands, offline, as what the list of tasks says of what it has not read, and its failure as every read says it', async () => {
  const read = { data: undefined, isPlaceholderData: false, isError: false, error: null, refetch: () => {} };
  const offline = render(<ReadPart reads={[read]} skeleton={<i data-skeleton />}>{() => <p>drawn</p>}</ReadPart>);
  act(() => useConnection.setState({ offline: true, state: 'reconnecting', failures: 1 }));
  await waitFor(() => expect(offline.container.querySelector('[data-read-note="absent"]')).not.toBeNull(), { timeout: OFFLINE_SHOWN_AFTER_MS + 2000 });
  expect(offline.container.querySelector('[data-skeleton]')).toBeNull();
  offline.unmount();
  act(() => useConnection.setState({ offline: false, state: 'live', failures: 0 }));
  const retry = vi.fn();
  // A part drawn from two reads (the AI's use and its finished tasks): one that failed is said, and asked again.
  const failed = render(<ReadPart reads={[{ ...read, data: 1 }, { ...read, isError: true, error: new Error('x'), refetch: retry }]}
    skeleton={<i data-skeleton />}>{() => <p>drawn</p>}</ReadPart>);
  expect(failed.container.querySelector('[data-read-failure]')).not.toBeNull();
  expect(failed.queryByText('drawn')).toBeNull();
  failed.unmount();
  const waiting = render(<ReadPart reads={[{ ...read, data: 1 }, read]} skeleton={<i data-skeleton />}>{() => <p>drawn</p>}</ReadPart>);
  // Until both have come, its own shape: nothing drawn now to be pushed down by what comes later.
  expect(waiting.container.querySelector('[data-skeleton]')).not.toBeNull();
  expect(waiting.queryByText('drawn')).toBeNull();
  waiting.unmount();
});
