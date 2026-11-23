import { setConversationState, snapshotJson } from './conversation-fixture';
import { afterEach, beforeAll, expect, onTestFinished, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import { ReportFeed } from '../src/features/reader/ReportFeed';
import { questionReports } from '../src/domain/question-reports';
import { requestRead } from '../src/data/read-demand';
import { taskReadState } from '../src/data/read-model';
import { queryClient } from '../src/data/query-client';
import { useConversation } from '../src/features/coordinator/coordinator';
import { useDraftStore } from '../src/features/forms/draft-store';
import { answersIn, documentSchema } from '../src/features/coordinator/editor/document';
import { at, decideItem, dto, historyFixture, questionFixture, screenData, taskFixture, TestWorkspace, tree, userBall } from './fixtures';

// A choice's drawing stands where it was written; drawing it is mermaid.test's.
vi.mock('../src/lib/mermaid', () => ({ renderMermaid: vi.fn(() => new Promise(() => {})) }));
vi.mock('../src/lib/mermaid-theme', async () => {
  const { palette } = await import('./mermaid-palette');
  return { diagramPalette: () => palette('light') };
});

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); queryClient.clear(); setConversationState(useConversation.getInitialState()); });

/** T1's own question to the user; the server sends only a Task's own human questions (userQuestions). */
function fixture({ open = true, history = false }: { open?: boolean; history?: boolean } = {}) {
  const question = questionFixture({ id: 'Qown', title: 'Own question', decide: [decideItem('Where to save?',
    [['Keep', 'Keep the original'], ['Change', 'Change it']], { decide_note: '![Original file](proof.png)' })] });
  return tree({ tasks: [taskFixture({ id: 'T1', values: { notes: '### 1 Rewritten body\n#### Wrong\nNever read this' },
    files: [{ name: 'proof.png', size: 8, revision: 'original', at }], ...open ? { ball: userBall('question', 'Qown', at, { questionId: 'Qown' }) } : {} })],
    questions: open ? [question] : [], userQuestions: { T1: open ? [{ ...question, destination: { kind: 'user' as const }, taskTitle: 'Own' }] : [] },
    history: { T1: history ? historyFixture([{ id: 'Qown', kind: 'question', title: question.title, askedTo: 'user', open }]) : [] } });
}
function feed(value = fixture()) {
  const data = screenData(value);
  return { data, node: <TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace> };
}
const card = (key = 'log:T1:Qown') => document.querySelector<HTMLElement>(`[data-report-key="${key}"]`)!;

test('the Task’s own human question appears without History, and answers its original ID and what it fixed', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(snapshotJson({ id: 'projection-choice', nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, busy: false, cancelled: [], turns: [] })));
  onTestFinished(() => fetcher.mockRestore());
  render(feed().node);
  expect(within(card()).getByText('Where to save?')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Wrong' })).toBeNull();
  expect(card().querySelector('img')?.getAttribute('src')).toContain('/api/tasks/T1/file?path=proof.png');
  fireEvent.click(within(card()).getByRole('button', { name: 'Keep' }));
  await waitFor(() => {
    const draft = Object.values(useDraftStore.getState().entries).find(entry => entry.values.doc?.includes('1-Keep'));
    expect(draft).toBeTruthy();
    expect(answersIn(documentSchema.parse(JSON.parse(draft!.values.doc!)), 'T1')).toEqual([{ question: 'Qown', task: 'T1', n: '1', name: 'Keep', answer: '1-Keep' }]);
  });
});

// The report's words were above its question when written; the card must not lift the question over them.
test('a question report reads in the order written: its words, then each question with its choices and its note, once each', () => {
  // The report's words are the question record's summary, as the server sends the projection and History alike.
  const summary = 'Report words first\n\n![Report picture](proof.png)\n\nReport words last';
  const question = questionFixture({ id: 'Qown', title: 'Own question', summary, decide: [
    decideItem('Where to save?', [['Keep', 'Keep the original'], ['Change', 'Change it']], { decide_note: 'After the choices, see [the guide](guide.md)' }),
    decideItem('Anything else?', [['Yes', 'Go on']], { decide_note: 'After the second' })] });
  const value = tree({ tasks: [taskFixture({ id: 'T1', files: [{ name: 'proof.png', size: 8, revision: 'original', at }, { name: 'guide.md', size: 8, revision: 'original', at }],
    ball: userBall('question', 'Qown', at, { questionId: 'Qown' }) })],
    questions: [question], userQuestions: { T1: [{ ...question, destination: { kind: 'user' as const }, taskTitle: 'Own' }] },
    history: { T1: historyFixture([{ id: 'Qown', kind: 'question', title: question.title, askedTo: 'user',
      summary }]) } });
  render(feed(value).node);
  const text = card().textContent!;
  const order = ['Report words first', 'Report words last', 'Where to save?', 'Keep the original', 'Change it', 'After the choices',
    'the guide', 'Anything else?', 'Go on', 'After the second'];
  for (const words of order) expect(text.split(words), words).toHaveLength(2);
  const places = order.map(words => text.indexOf(words));
  expect(places).toEqual([...places].sort((a, b) => a - b));
  // The report's picture stands between its words, over the question's choices.
  const picture = card().querySelector('img[alt="Report picture"]')!, choices = card().querySelector('[data-waiting-report-actions]')!;
  expect(picture.compareDocumentPosition(choices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(within(card()).getByText('the guide').closest('a, button')).toBeTruthy();
  expect(within(card()).getAllByRole('button', { name: 'Keep' })).toHaveLength(1);
});

test('a projected question and its History record render only once', () => {
  render(feed(fixture({ history: true })).node);
  expect(document.querySelectorAll('[data-report-key="log:T1:Qown"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-waiting-report-actions]')).toHaveLength(1);
});

test('a child’s consultation of its parent stays in the parent’s column, readable and without choices or a link to answer it', () => {
  const consult = questionFixture({ id: 'Qconsult', taskId: 'T2', destination: { kind: 'task', taskId: 'T1' }, title: 'Child asks its parent',
    decide: [decideItem('Which way?', [['Keep', 'Keep']])] });
  const data = screenData(tree({ tasks: [dto(), dto({ id: 'T2', parentId: 'T1' })], questions: [consult], userQuestions: { T1: [] },
    history: { T1: historyFixture([{ id: 'Qconsult', taskId: 'T2', fromChild: true, kind: 'question', title: consult.title, askedTo: 'T1' }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  expect(card('log:T2:Qconsult').textContent).toContain('Child asks its parent');
  expect(document.querySelector('[data-waiting-report-actions]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull();
  expect(document.querySelector('[data-questions-bar]')).toBeNull();
});

test('the questions bar counts only what the server gives as the Task’s own questions', () => {
  render(feed().node);
  expect(document.querySelector('[data-questions-bar]')?.textContent).toContain('Question for you · 1');
  cleanup();
  render(feed(fixture({ open: false })).node);
  expect(document.querySelector('[data-questions-bar]')).toBeNull();
});

test('a closed question loses its choices when the Task refreshes, including stale History', async () => {
  const view = render(feed(fixture({ history: true })).node);
  expect(screen.getByRole('button', { name: 'Keep' })).toBeTruthy();
  view.rerender(feed(fixture({ open: false, history: true })).node);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Keep' })).toBeNull());
});

test('unreadable questions show a read failure rather than an empty success', () => {
  const value = fixture({ open: false });
  value.userQuestions.T1 = null;
  render(feed(value).node);
  expect(screen.getByRole('alert').textContent).toContain('Could not read the questions');
});

test('question projection keeps original keys when History is absent', () => {
  const reports = questionReports([], screenData(fixture()).tasks[0]!);
  expect(reports.map(report => [report.key, report.sourceTaskId, report.question])).toEqual([['log:T1:Qown', undefined, 'Qown']]);
});


test('choice descriptions and every picture stay beside their answer in the detail', () => {
  const value = fixture();
  value.questions[0]!.decide = [decideItem('Distribution?', [['GitHub', 'An executable for each OS\n![PC example](proof.png)\n![Phone example](proof.png)'],
    ['npm', 'One registry']], { decide_note: 'Shared limits' })];
  render(feed(value).node);
  const choice = within(card()).getByRole('button', { name: 'GitHub' }).parentElement!;
  expect(choice.textContent).toContain('An executable for each OS');
  for (const name of ['PC example', 'Phone example'])
    expect(within(choice).getByRole('img', { name }).getAttribute('src')).toContain('/api/tasks/T1/file?path=proof.png');
});

// What a choice says reads in the order written; no picture or drawing is lifted over the words before it.
test('a choice keeps its lines, pictures and drawings in the order written', () => {
  const value = fixture();
  value.questions[0]!.decide = [decideItem('Which plan?', [
    ['A Go on', ['Read first', '![Figure 1](proof.png)', 'After the figure', '![Figure 2](proof.png)'].join('\n')],
    ['B Picture first', ['![Figure 3](proof.png)', 'Under the picture'].join('\n')],
    ['C Drawings', ['Before the drawing', '```', 'box -> box', '```', 'Between drawings', '```mermaid', 'flowchart LR', '  a --> b', '```', 'After the drawings'].join('\n')],
  ], { decide_note: 'Shared' })];
  render(feed(value).node);
  /** What a choice's section shows under its button, in document order: words, a picture by its name (its caption repeats it), a drawing by its kind. */
  const shown = (name: string) => {
    const answer = within(card()).getByRole('button', { name }), choice = answer.parentElement!;
    const walker = document.createTreeWalker(choice, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    const seen: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (answer.contains(node)) continue;
      if (node instanceof HTMLImageElement) seen.push(`img:${node.alt}`);
      else if (node instanceof Element && node.hasAttribute('data-mermaid-figure')) seen.push('mermaid');
      else if (node instanceof HTMLPreElement && !node.closest('[data-mermaid-figure]')) seen.push(`pre:${node.textContent!.trim()}`);
      else if (node.nodeType === Node.TEXT_NODE && !node.parentElement!.closest('pre, figure, [data-mermaid-figure]') && node.textContent!.trim()) seen.push(node.textContent!.trim());
    }
    return seen;
  };
  expect(shown('A Go on')).toEqual(['Read first', 'img:Figure 1', 'After the figure', 'img:Figure 2']);
  expect(shown('B Picture first')).toEqual(['img:Figure 3', 'Under the picture']);
  expect(shown('C Drawings')).toEqual(['Before the drawing', 'pre:box -> box', 'Between drawings', 'mermaid', 'After the drawings']);
  expect(card().textContent!.split('Shared')).toHaveLength(2);
});

test('a question stays readable during revalidation, and its answer is disabled once that lasts', async () => {
  const { data, node } = feed();
  render(node);
  const query = queryClient.getQueryCache().find({ queryKey: ['task', data.info.root, 'T1'], exact: true })!;
  await act(async () => { requestRead(query); query.invalidate(); });
  expect(taskReadState(queryClient, data.info.root, 'T1').assessment.project).toBe(false);
  expect(within(card()).getByText('Where to save?')).toBeTruthy();
  // A short revalidation does not dim the choice (steady-control); this one never ends.
  expect(within(card()).getByRole('button', { name: 'Keep' }).hasAttribute('disabled')).toBe(false);
  await waitFor(() => expect(within(card()).getByRole('button', { name: 'Keep' }).hasAttribute('disabled')).toBe(true), { timeout: 3000 });
  expect(within(card()).getByRole('img', { name: 'Original file' })).toBeTruthy();
});
