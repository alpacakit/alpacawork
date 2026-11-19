import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import type { StartOrderDTO, TaskHistoryDTO } from '@alpacawork/contract';
import type { InfiniteData } from '@tanstack/react-query';
import { indexTasks } from '../src/domain/tasks';
import { startOrderOf, waitersOf } from '../src/domain/start-order';
import { OrderList, orderRecordWords } from '../src/features/reader/StartOrder';
import { ReportFeed } from '../src/features/reader/ReportFeed';
import { StatusTime, WaitedNote } from '../src/features/tree/RowStatus';
import { at, dto, historyFixture, screenData, TestWorkspace, tree, userBall } from './fixtures';
import { queryClient } from '../src/data/query-client';
import { resources } from '../src/data/resources';
import { useViewStore } from '../src/state/view-store';
import type { Task } from '../src/data/types';

beforeAll(() => startI18n());
afterEach(cleanup);
const after = (task: string, state = 'doing', finished = false) => ({ task, title: `Read ${task}`, state, finished, lifecycle: 'active' });
const order = (items = [after('T2')], fields: Partial<StartOrderDTO> = {}): StartOrderDTO => ({ after: items, started: false, waiting: true, ...fields });
function dataOf(startOrder = order()) {
  return screenData(tree({ tasks: [dto({ id: 'T1', state: 'todo' }), dto({ id: 'T2', title: 'Prerequisite' }),
    dto({ id: 'T3', title: 'Other prerequisite' })], startOrder: { T1: startOrder } }));
}

// Each mutated source here must alter the result: no UI re-derivation of finished or whose move it is.
test('state and finished stay paired from the server read; only the matching live state may supply a user ball', () => {
  const data = dataOf(order([after('T2', 'done', false)])), waiting = data.tasks[0]!, prerequisite = data.tasks[1]!;
  const index = indexTasks(data.tasks);
  prerequisite.state = 'done'; prerequisite.ball = userBall('review', 'L1', at);
  expect(startOrderOf(waiting, index)!.waitingFor[0]).toMatchObject({ state: 'done', finished: false, urge: 'turn' });
  prerequisite.state = 'doing';
  expect(startOrderOf(waiting, index)!.waitingFor[0]).toMatchObject({ state: 'done', finished: false, ball: null, urge: 'moving' });
  waiting.startOrder = order([after('T2', 'doing', true)]);
  expect(startOrderOf(waiting, index)!.waitingFor).toEqual([]);
  expect(waitersOf('T2', indexTasks([...data.tasks]))).toEqual([]);
});

test('a waiting task with a parent ball is moving; only holder=user ranks first, before held/error then moving', () => {
  const data = dataOf(order([after('T2', 'waiting'), after('T3', 'held'), after('T4', 'doing')]));
  const second = data.tasks[1]!; second.state = 'waiting'; second.ball = { holder: 'parent', reason: 'question' };
  const fourth = { ...data.tasks[2]!, id: 'T4', state: 'doing', ball: userBall('question', 'L4', at) } as Task;
  const index = indexTasks([...data.tasks, fourth]);
  expect(startOrderOf(data.tasks[0]!, index)!.waitingFor.map(item => [item.id, item.urge]))
    .toEqual([['T4', 'turn'], ['T3', 'stuck'], ['T2', 'moving']]);
});

test('an opened old detail follows index startOrder, including removal and first start', () => {
  const data = dataOf(), current = data.tasks[0]!, opened = { ...current, startOrder: order([after('T3')]) };
  const index = indexTasks(data.tasks);
  expect(startOrderOf(opened, index)!.after[0]!.id).toBe('T2');
  current.startOrder = null;
  expect(startOrderOf(opened, index)).toBeNull();
  current.startOrder = order([after('T2', 'done', true)], { waiting: false, started: true });
  expect(startOrderOf(opened, index)).toMatchObject({ started: true, waitingFor: [] });
});

test.each([1, 2, 3])('the list and tree share the quiet wait word for %i prerequisites', async count => {
  await i18n.changeLanguage('ja');
  const data = dataOf(order(Array.from({ length: count }, (_, n) => after(`T${n + 2}`))));
  render(<TestWorkspace data={data}><StatusTime task={data.tasks[0]!} /></TestWorkspace>);
  const word = document.querySelector('[data-row-status="order"]')!;
  expect(word.textContent).toBe(count === 1 ? 'T2 待ち' : count === 2 ? 'T2・T3 待ち' : 'T2 ほか2件待ち');
  expect(word.classList.contains('text-ink')).toBe(true);
  expect(word.classList.contains('text-turn')).toBe(false);
});

test('task ID lists use the catalog separator in the wait word, followers and History', async () => {
  await i18n.changeLanguage('en');
  const separator = i18n.t('reader:order.separator');
  i18n.addResource('en', 'reader', 'order.separator', ' / ');
  try {
    const data = dataOf(order([after('T2'), after('T3')]));
    const view = render(<TestWorkspace data={data}><StatusTime task={data.tasks[0]!} /></TestWorkspace>);
    expect(document.querySelector('[data-row-status="order"]')!.textContent).toBe('Waits for T2 / T3');
    view.unmount();
    const three = dataOf(order([after('T2'), after('T3'), after('T4')]));
    render(<TestWorkspace data={three}><OrderList form="under" task={three.tasks[1]!} onFollow={() => {}} onClose={() => {}} /></TestWorkspace>);
    expect(document.querySelector('[data-order-list]')!.textContent).toContain('Also waits for T3 / T4');
    const words = orderRecordWords({ after: ['T2', 'T3'], previous: ['T4', 'T5'] }, () => undefined, i18n.getFixedT('en', 'reader'));
    expect(words.text).toBe('Starts after T2 / T3');
    expect(words.description).toContain('Previously: T4 / T5');
  } finally { i18n.addResource('en', 'reader', 'order.separator', separator); }
});

test('the waited note opens waiter titles and states, and follows the chosen waiter', async () => {
  await i18n.changeLanguage('ja');
  const data = dataOf();
  render(<TestWorkspace data={data}><WaitedNote task={data.tasks[1]!} /></TestWorkspace>);
  const note = document.querySelector('[data-row-waited]')!;
  expect(note.textContent).toBe('後続 T1'); fireEvent.click(note);
  const tip = document.querySelector('[data-order-tip]')!;
  expect(tip.textContent).toContain('Task one');
  expect(tip.textContent).toContain('未着手');
  fireEvent.click(tip.querySelector('[data-order-task="T1"]')!);
  expect(document.querySelector('[data-order-tip]')).toBeNull();
  expect(useViewStore.getState().selected).toBe('T1');
  expect(useViewStore.getState().reader.open).toBe(true);
});

test('detail shows stuck reasons, reverse waits, and started wording from the index', async () => {
  await i18n.changeLanguage('ja');
  const data = dataOf(order([after('T2', 'held'), after('T3', 'done', false)]));
  const follow = vi.fn();
  const view = render(<TestWorkspace data={data}><OrderList form="under" onClose={() => {}} task={data.tasks[0]!} onFollow={follow} />
    <OrderList form="under" onClose={() => {}} task={data.tasks[1]!} onFollow={follow} /></TestWorkspace>);
  expect(document.querySelector('[data-order-stuck]')!.textContent).toContain('T2 は保留中です。');
  expect(view.container.textContent).toContain('実行の終わり待ち');
  expect(view.container.textContent).toContain('ほかに T3 も待っています');
  fireEvent.click(document.querySelector('[data-order-section="after"] [data-order-task="T2"]')!);
  expect(follow).toHaveBeenCalledWith('T2');
  cleanup();
  const begun = dataOf(order([after('T2', 'stopped', true)], { started: true, waiting: false }));
  render(<TestWorkspace data={begun}><OrderList form="under" onClose={() => {}} task={begun.tasks[0]!} onFollow={follow} /></TestWorkspace>);
  expect(document.querySelector('[data-order-started]')!.textContent).toContain('のあとに始まりました');
  expect(document.querySelector('[data-order-list]')!.textContent).toContain('中止');
  expect(document.querySelector('[data-order-stuck]')).toBeNull();
});

test('detail explains an errored prerequisite without calling a parent question the user’s turn', async () => {
  await i18n.changeLanguage('ja');
  const data = dataOf(order([after('T2', 'error')]));
  render(<TestWorkspace data={data}><OrderList form="under" onClose={() => {}} task={data.tasks[0]!} onFollow={() => {}} /></TestWorkspace>);
  expect(document.querySelector('[data-order-stuck]')!.textContent).toBe('T2 はエラーで止まっています。直して完了するか中止し、実行が終わると、待ちが解けます。');
});

test.each(['own-running', 'below-running', 'unclear', 'since'] as const)('wait words do not hide %s', kind => {
  const data = dataOf(), task = data.tasks[0]!;
  task.state = 'doing'; task.rowFacts.kind = null;
  if (kind === 'own-running') task.rowFacts.status = { kind: 'running', since: Date.now() - 60000 };
  else if (kind === 'below-running') { task.rowFacts.status = null; task.rowFacts.childrenRunning = 1; task.homeRow = { taskId: task.id, section: 'doing', summary: { done: 0, total: 1 } }; }
  else if (kind === 'unclear') task.rowFacts.status = { kind: 'unclear' };
  else task.rowFacts.status = { kind: 'since', at: Date.now() - 60000 };
  render(<TestWorkspace data={data}><StatusTime task={task} /></TestWorkspace>);
  expect(document.querySelector('[data-row-status="order"]')).toBeNull();
  expect(document.querySelector('[data-row-status]')).not.toBeNull();
});

test.each(['ja', 'en'])('History draws structured IDs without depending on English titles (%s)', async lang => {
  await i18n.changeLanguage(lang);
  const data = screenData(tree({ tasks: [dto({ id: 'T1' })], history: { T1: historyFixture([
    { id: 'Ldependency', kind: 'changed', title: '', dependencies: { after: ['T2', 'T3'], previous: ['T4'] } },
    { id: 'Lclear', kind: 'changed', dependencies: { after: [], previous: ['T2'] } },
  ]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const key = resources.history(data.info.root, 'T1').queryKey;
  act(() => queryClient.setQueryData<InfiniteData<TaskHistoryDTO>>(key, held => held && ({ ...held, pages: held.pages.map(page => ({ ...page,
    tasks: { T2: { title: 'Finished prerequisite', parentId: null } } })) })));
  const row = await waitFor(() => { const row = document.querySelector('[data-report-key="log:T1:Ldependency"]'); expect(row).not.toBeNull(); return row!; });
  expect(row.textContent).toContain(lang === 'ja' ? 'T2・T3 のあとに始めます' : i18n.t('reader:order.history.set', { ids: 'T2, T3' }));
  fireEvent.click(row.querySelector('button[aria-expanded]')!);
  expect(row.textContent).toContain('Finished prerequisite');
  expect(row.textContent).toContain(lang === 'ja' ? '前の指定: T4' : i18n.t('reader:order.history.previous', { ids: 'T4' }));
  expect(document.querySelector('[data-report-key="log:T1:Lclear"]')!.textContent).toContain(i18n.t('reader:order.history.cleared'));
  const words = orderRecordWords({ after: ['T2'], previous: [] }, () => 'Finished prerequisite', i18n.getFixedT(lang, 'reader'));
  expect(words.description).toBe('- T2 Finished prerequisite');
});

// Looking up each row must not enumerate the whole index again; a new snapshot rebuilds the edges.
test('reverse dependency edges are built once per index and change with the next snapshot', () => {
  const data = dataOf(order([after('T2'), after('T3', 'done', true)]));
  const index = indexTasks(data.tasks);
  const scan = vi.spyOn(index.byId, 'values');
  for (let n = 0; n < 20; n++) expect(waitersOf('T2', index)).toEqual([data.tasks[0]]);
  expect(scan).not.toHaveBeenCalled();
  expect(waitersOf('T3', index)).toEqual([]);
  const next = indexTasks(data.tasks.map(task => task.id === 'T1' ? { ...task, startOrder: order([], { waiting: false, started: true }) } : task));
  expect(waitersOf('T2', next)).toEqual([]);
  expect(waitersOf('T2', index)).toEqual([data.tasks[0]]);
});


// Only prerequisite items have the server's unfinished-Run verdict. A follower carries no such verdict.
test('a stopped follower with no Runs says stopped without claiming a Run is ending, in the panel and list tip', async () => {
  await i18n.changeLanguage('ja');
  const data = screenData(tree({ tasks: [dto({ id: 'T1', title: 'Prerequisite' }), dto({ id: 'T2', title: 'Never started', state: 'stopped' })],
    runs: [], startOrder: { T2: order([after('T1')]) } }));
  render(<TestWorkspace data={data}>
    <OrderList form="under" task={data.tasks[0]!} onFollow={() => {}} onClose={() => {}} />
    <WaitedNote task={data.tasks[0]!} />
  </TestWorkspace>);
  const list = document.querySelector('[data-order-list]')!;
  expect(list.querySelector('[data-order-task="T2"]')!.textContent).toContain('中止');
  expect(list.textContent).not.toContain('実行の終わり待ち');
  fireEvent.click(document.querySelector('[data-row-waited]')!);
  expect(document.querySelector('[data-order-tip]')!.textContent).toContain('中止');
  expect(document.querySelector('[data-order-tip]')!.textContent).not.toContain('実行の終わり待ち');
});

test.each(['done', 'stopped'])('a %s prerequisite whose Run is unfinished still says it is ending', async state => {
  await i18n.changeLanguage('ja');
  const data = dataOf(order([after('T2', state, false)]));
  render(<TestWorkspace data={data}><OrderList form="under" task={data.tasks[0]!} onFollow={() => {}} onClose={() => {}} /></TestWorkspace>);
  expect(document.querySelector('[data-order-task="T2"]')!.textContent).toContain('実行の終わり待ち');
});
