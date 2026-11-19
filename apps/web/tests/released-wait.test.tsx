import { afterEach, beforeAll, expect, test } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import type { HistoryEvent } from '../src/domain/history';
import { ReportFeed } from '../src/features/reader/ReportFeed';
import { released, reportEvent } from '../src/domain/report-events';
import { queryClient } from '../src/data/query-client';
import { historyFixture, screenData, TestWorkspace, tree } from './fixtures';

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); queryClient.clear(); });

type Closure = NonNullable<HistoryEvent['closure']>;
const CASES: { kind: 'question' | 'review'; closure: Closure; words: string | null }[] = [
  { kind: 'question', closure: 'withdrawn', words: 'Withdrawn without an answer' }, { kind: 'question', closure: 'expired', words: 'Expired when the addressee changed' },
  { kind: 'review', closure: 'invalidated', words: 'Back to work' }, { kind: 'review', closure: 'stopped', words: 'Closed when the task was stopped' },
  { kind: 'question', closure: 'answered', words: null }, { kind: 'review', closure: 'confirmed', words: null }];

function column(kind: 'question' | 'review', closure: Closure) {
  const data = screenData(tree({ history: { T1: historyFixture([{ id: 'W', kind, title: 'The wait', open: false, closure,
    ...kind === 'question' ? { askedTo: 'user' as const } : { state: 'waiting' as const } }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  return document.querySelector<HTMLElement>('[data-report-key="log:T1:W"] article')!;
}

for (const { kind, closure, words } of CASES) test(`a ${kind} closed as ${closure} ${words ? 'is drawn quiet with why it closed' : 'keeps its look'}`, () => {
  const card = column(kind, closure);
  // The newest report stands open, in ink, when it says more than its title; closed, it says how it stands among the rest.
  const press = card.querySelector<HTMLElement>('button[aria-expanded]');
  if (press?.getAttribute('aria-expanded') === 'true') fireEvent.click(press);
  const title = card.querySelector('[data-row-words]')!;
  if (words) {
    expect(card.dataset.released).toBe(closure);
    expect(title.className).toContain('font-normal');
    expect(title.className).toContain('text-soft');
    expect(card.querySelector('[data-row-end-words]')?.textContent).toBe(words);
  } else {
    expect(card.dataset.released).toBeUndefined();
    expect(title.className).toContain('text-row-words');
    expect(card.querySelector('[data-row-end-words]')).toBeNull();
  }
});

test('one rule for both waits: only a closure other than an answer or a confirmation releases, and its mark is quiet', () => {
  expect((['answered', 'withdrawn', 'expired', 'confirmed', 'invalidated', 'stopped'] as const).map(closure => released({ closure })))
    .toEqual([undefined, 'withdrawn', 'expired', undefined, 'invalidated', 'stopped']);
  expect(released({})).toBeUndefined();
  const [done] = historyFixture([{ id: 'R', kind: 'review', title: 'Done review', state: 'done', open: false, closure: 'invalidated' }]);
  expect(reportEvent(done!, () => null).mark).toEqual({ kind: 'report', tone: 'quiet' });
});

// A record that only closes a wait has no row of its own; the wait's card says it (its released mark).
for (const closure of ['withdrawn', 'expired'] as const) test(`a question ${closure} by a later record is told on its card, with no row of that record`, () => {
  const data = screenData(tree({ history: { T1: historyFixture([
    { id: 'X', kind: closure, at: '2026-01-01T00:01:00.000Z', author: { kind: 'owner', profileKey: 'p' } },
    { id: 'W', kind: 'question', title: 'The wait', open: false, closure, askedTo: 'user', at: '2026-01-01T00:00:00.000Z' }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector('[data-report-key="log:T1:X"]')).toBeNull();
  expect(document.body.textContent).not.toMatch(/Question withdrawn|Question expired/);
  const card = document.querySelector<HTMLElement>('[data-report-key="log:T1:W"] article')!;
  expect(card.dataset.released).toBe(closure);
  expect(card.querySelector('[data-row-end-words]')?.textContent).toBe(closure === 'withdrawn' ? 'Withdrawn without an answer' : 'Expired when the addressee changed');
});
