import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore } from 'zustand';
import { WorkspaceContext, type WorkspaceStore } from '../src/data/workspace-store';
import { startI18n, i18n } from '@alpacawork/i18n';
import type { RunStep, RunStepDetail, RunStepEntry } from '@alpacawork/contract/run';
import { StepList, WorkLine, WorkMark, takeIn, useRunSteps } from '../src/features/people/RunSteps';
import { stylesheet } from './stylesheet';
import { ApiError } from '../src/data/client';
import { TurnWork } from '../src/features/coordinator/parts';
/** An answered turn whose Run took steps: its work opens from the pill above its answer. */
const AnswerSteps = ({ run }: { run: string }) => <TurnWork turn={{ id: 'turn', at: '2026-11-01T00:00:00.000Z', status: 'succeeded', workedBy: run }} />;

// The server's side: one Run's steps, each with the version it last changed at, and what each ran.
const server = vi.hoisted(() => ({
  steps: [] as RunStepEntry[], version: 0, generation: 1, details: new Map<number, Omit<RunStepDetail, 'changed' | 'generation'>>(),
  refuse: false, asked: [] as string[], /** Answers "not found" this many times for one step. */ missing: 0,
  /** Adds or changes a step, as the server's index does: it takes the next version. */
  put(step: Omit<RunStepEntry, 'changed'>) { server.steps[step.n] = { ...step, changed: ++server.version }; },
}));
vi.mock('../src/data/run-steps', () => ({
  readRunSteps: async (run: string, range: { from?: number; limit: number } | { since: number }) => {
    server.asked.push(`${run} ${'since' in range ? `since ${range.since}` : `${range.from ?? 'latest'} ${range.limit}`}`);
    if (server.refuse) throw new Error('refused');
    const total = server.steps.length, answer = { total, version: server.version, complete: true, generation: server.generation };
    if ('since' in range) return { ...answer, steps: server.steps.filter(step => step.changed > range.since) };
    const from = range.from ?? Math.max(0, total - range.limit);
    return { ...answer, steps: server.steps.slice(from, from + range.limit) };
  },
  readRunStep: async (run: string, n: number) => {
    server.asked.push(`${run} step ${n}`);
    if (server.missing > 0) { server.missing--; throw new ApiError('Step does not exist', 'not_found'); }
    return { ...server.details.get(n) ?? { input: { text: server.steps[n]!.text, omitted: 0 }, output: null },
      changed: server.steps[n]!.changed, generation: server.generation };
  },
}));

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => { server.steps = []; server.version = 0; server.generation = 1; server.details = new Map(); server.refuse = false; server.asked = []; server.missing = 0; });
afterEach(cleanup);

const entry = (n: number, text: string, rest: Partial<RunStepEntry> = {}): Omit<RunStepEntry, 'changed'> => ({ n, id: `s${n}`, tool: 'Bash',
  kind: 'command', text, more: 0, about: null, state: 'done', startedAt: null, startSource: null, endedAt: null, endSource: null,
  fingerprint: null, output: null, parentId: null, subagentSteps: 0, ...rest });
const lines = () => [...document.querySelectorAll('[data-run-step]')].map(item => item.textContent);

test('the work line shows the shell command and extra lines, or how many steps are listed under it', () => {
  const latest: RunStep = { id: '1', at: '2026-11-24T00:00:00Z', tool: 'command_execution', kind: 'command', text: 'pnpm test --filter web', more: 2,
    about: null, state: 'running', result: null };
  const { rerender, container } = render(<WorkLine step={latest} />);
  expect(container.querySelector('[data-work-mark]')).toBeTruthy();
  expect(screen.getByText('$')).toBeTruthy();
  expect(screen.getByText('+2 lines')).toBeTruthy();
  expect(screen.getByText('pnpm test --filter web')).toBeTruthy();
  rerender(<WorkLine step={latest} label="12 steps so far" />);
  expect(screen.queryByText('pnpm test --filter web')).toBeNull();
  expect(screen.getByText('12 steps so far')).toBeTruthy();
});

test('an answer\'s steps are read only once opened, the latest first, and every earlier one a page at a time', async () => {
  for (let n = 0; n < 300; n++) server.put(entry(n, `echo ${n}`));
  render(<AnswerSteps run="R7" />);
  expect(server.asked).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  expect(await screen.findByText('300 steps behind this answer')).toBeTruthy();
  expect(lines()).toHaveLength(12);
  expect(lines()[0]).toContain('echo 288');
  // Each press reads the page before, saying how many it adds and how many are left, back to the Run's first step.
  fireEvent.click(screen.getByText('Show 24 earlier (288 left)'));
  await waitFor(() => expect(lines()[0]).toContain('echo 264'));
  for (let left = 264; left > 0; left -= 24) {
    fireEvent.click(screen.getByText(`Show ${Math.min(24, left)} earlier (${left} left)`));
    await waitFor(() => expect(lines()[0]).toContain(`echo ${Math.max(0, left - 24)}`));
  }
  expect(lines()).toHaveLength(300);
  expect(document.querySelector('[data-run-steps-more]')).toBeNull();
});

test('a step opens to all it ran and got back, read then, a failed one marked and what was left out said', async () => {
  server.put(entry(0, 'pnpm build', { more: 1, state: 'failed' }));
  server.details.set(0, { input: { text: 'pnpm build\n  && pnpm test', omitted: 0 }, output: { text: 'FAIL amount.test.ts\n  expected 2', omitted: 1200 } });
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  const row = await screen.findByRole('button', { name: /pnpm build/ });
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(server.asked).not.toContain('R7 step 0');
  fireEvent.click(row);
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm build\n  && pnpm test'));
  expect(server.asked).toContain('R7 step 0');
  expect(document.querySelector('[data-run-step-output]')?.textContent).toContain('FAIL amount.test.ts\n  expected 2');
  expect(document.querySelector('[data-run-step-output]')?.textContent).toMatch(/1,?200 more characters left out as too long$/);
});

test('a change of any step reads only what changed, keeping how far the list was gone back and the step opened', async () => {
  for (let n = 0; n < 40; n++) server.put(entry(n, `echo ${n}`, { state: n >= 30 ? 'running' : 'done' }));
  function Listed({ signal }: { signal: number }) {
    return <StepList steps={useRunSteps('R7', true, signal)} open />;
  }
  const { rerender } = render(<Listed signal={1} />);
  await waitFor(() => expect(lines()).toHaveLength(12));
  fireEvent.click(screen.getByText('Show 24 earlier (28 left)'));
  await waitFor(() => expect(lines()).toHaveLength(36));
  fireEvent.click(screen.getByRole('button', { name: /echo 10/ }));
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('echo 10'));
  // The first of the steps going at once fails and another starts; the screen is told something changed.
  server.put(entry(30, 'echo 30', { state: 'failed' }));
  server.put(entry(40, 'echo 40', { state: 'running' }));
  server.asked = [];
  rerender(<Listed signal={2} />);
  await waitFor(() => expect(lines()).toHaveLength(37));
  expect(server.asked).toEqual(['R7 since 40']);
  expect(lines()[0]).toContain('echo 4');
  expect(document.querySelector('[data-run-step=failed]')?.textContent).toContain('echo 30');
  expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('echo 10');
});

test('answers in any order: an older page never undoes a newer change, and another generation starts the list again', () => {
  const step = (n: number, state: RunStepEntry['state'], changed: number): RunStepEntry => ({ ...entry(n, `echo ${n}`, { state }), changed });
  const answer = (steps: RunStepEntry[]) => ({ steps, total: 30, generation: 1 });
  const listed = takeIn(null, answer([step(28, 'running', 5), step(29, 'running', 6)]), { caughtUp: 6 })!;
  // The page of earlier steps is asked for; meanwhile step 20 fails, and the read of changes comes back first.
  const changed = takeIn(listed, answer([step(20, 'failed', 9)]), { caughtUp: 9 })!;
  expect(changed.steps.map(each => each.n)).toEqual([28, 29]);
  const page = answer(Array.from({ length: 24 }, (_, at) => step(4 + at, 'running', 3)));
  const earlier = takeIn(changed, page, { from: 4 })!;
  expect(earlier.steps).toHaveLength(26);
  expect(earlier.steps.find(each => each.n === 20)?.state).toBe('failed');
  expect([earlier.from, earlier.version]).toEqual([4, 9]);
  // Taken in again in the other order, the list is the same.
  expect(takeIn(takeIn(listed, page, { from: 4 }), answer([step(20, 'failed', 9)]), { caughtUp: 9 })!.steps).toEqual(earlier.steps);
  expect(takeIn(earlier, { steps: [], total: 1, generation: 2 })).toBeNull();
});

test('a newer generation from any answer reads the list anew: a step still there stays open with its new text, one gone closes', async () => {
  server.put(entry(0, 'pnpm test'));
  server.put(entry(1, 'pnpm lint', { id: 'gone' }));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  fireEvent.click(await screen.findByRole('button', { name: /pnpm lint/ }));
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm lint'));
  // The output was replaced: step s0 is still there, with what it ran now; the step "gone" is not.
  server.generation = 2; server.steps = []; server.version = 0;
  server.put(entry(0, 'pnpm test --run'));
  server.put(entry(1, 'pnpm build', { id: 'new' }));
  server.asked = [];
  fireEvent.click(screen.getByRole('button', { name: /pnpm test/ }));
  // The opened step's answer is of the newer generation: the list is read again, and the step read once it holds it.
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm test --run'));
  expect(server.asked).toContain('R7 latest 12');
  expect(document.querySelectorAll('[data-run-step-input]')).toHaveLength(1);
  expect(screen.getByRole('button', { name: /pnpm build/ }).getAttribute('aria-expanded')).toBe('false');
});

/** Whether, at any point while `act` runs, the opened step showed something other than what it ran (a wait, nothing). */
async function everNotShown(act: () => void, until: () => boolean): Promise<boolean> {
  let gap = false;
  const look = () => { if (!document.querySelector('[data-run-step-input]')) gap = true; };
  const watch = new MutationObserver(look);
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  act(); look();
  await waitFor(() => expect(until()).toBe(true));
  watch.disconnect();
  return gap;
}

test('a step opened again keeps what it ran in sight while it is read again, even after the output was read anew', async () => {
  server.put(entry(0, 'pnpm test'));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  const row = await screen.findByRole('button', { name: /pnpm test/ });
  fireEvent.click(row);
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm test'));
  fireEvent.click(row);
  // The server let the Run's index go and read it again: the same step, now of a newer generation.
  server.generation = 2; server.steps = []; server.version = 0;
  server.put(entry(0, 'pnpm test --run'));
  const gap = await everNotShown(() => fireEvent.click(screen.getByRole('button', { name: /pnpm test/ })),
    () => document.querySelector('[data-run-step-input]')?.textContent === 'pnpm test --run');
  expect(gap, 'no wait or blank between what it showed and what it shows now').toBe(false);
});

test('a step read at once opens with what it ran, with no wait drawn first', async () => {
  server.put(entry(0, 'pnpm lint'));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  const row = await screen.findByRole('button', { name: /pnpm lint/ });
  let waited = false;
  const watch = new MutationObserver(() => { if (document.querySelector('[data-run-step-open] [role=status]') || screen.queryByText(/Reading/)) waited = true; });
  watch.observe(document.body, { childList: true, subtree: true, characterData: true });
  fireEvent.click(row);
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm lint'));
  watch.disconnect();
  expect(waited).toBe(false);
});

test('a step no longer found reads the list anew rather than standing on an error', async () => {
  server.put(entry(0, 'pnpm test'));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  const row = await screen.findByRole('button', { name: /pnpm test/ });
  // The output was replaced; the step read first is not found, then found again in the new list.
  server.generation = 2; server.missing = 1;
  fireEvent.click(row);
  await waitFor(() => expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm test'));
  expect(server.asked.filter(asked => asked === 'R7 latest 12')).toHaveLength(2);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('two steps of one Run under one tool call ID open apart', async () => {
  server.put(entry(0, 'echo first', { id: 'again' }));
  server.put(entry(1, 'echo second', { id: 'again' }));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  fireEvent.click(await screen.findByRole('button', { name: /echo first/ }));
  await waitFor(() => expect(document.querySelectorAll('[data-run-step-input]')).toHaveLength(1));
  expect(screen.getByRole('button', { name: /echo second/ }).getAttribute('aria-expanded')).toBe('false');
});

test('an edit too large to carry whole says how many more files it changed', async () => {
  server.put(entry(0, '/a.ts', { kind: 'edit', tool: 'file_change' }));
  server.details.set(0, { input: { text: 'add: /a.ts\n+x', omitted: 0, omittedFiles: 59_000 }, output: null });
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  fireEvent.click(await screen.findByRole('button', { name: /a\.ts/ }));
  await waitFor(() => expect(document.querySelector('[data-run-step-more-files]')?.textContent).toBe('and 59000 more files'));
});

test('a step whose details were too large to keep says so when opened', async () => {
  server.put(entry(0, 'echo hi'));
  server.details.set(0, { input: { text: 'echo hi', omitted: 0 }, output: null, detailsDropped: true });
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  fireEvent.click(await screen.findByRole('button', { name: /echo hi/ }));
  await waitFor(() => expect(document.querySelector('[data-run-step-dropped]')?.textContent).toBe('Its contents were too large, so the details could not be recorded'));
});

test('a step whose outcome could not be read is not shown done, and opened says why', async () => {
  server.put(entry(0, 'pnpm test', { state: 'unknown' }));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  fireEvent.click(await screen.findByRole('button', { name: /pnpm test/ }));
  expect(screen.getByText('Outcome unknown')).toBeTruthy();
  expect(screen.queryByText('Done')).toBeNull();
  expect(await screen.findByText(/whether this step went well is not known/)).toBeTruthy();
});

test('steps that cannot be read say so', async () => {
  server.refuse = true;
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toBe('The steps could not be read');
});

test('the work mark moves its own boxes by rotate and translate alone, so its motion neither lays out nor paints', () => {
  const { container } = render(<WorkMark />);
  const mark = container.querySelector('[data-work-mark]')!;
  expect(mark.querySelector('svg')).toBeNull();
  for (const name of ['mark-weave-turn', 'mark-weave-dot']) {
    const frames = stylesheet.slice(stylesheet.indexOf(`@keyframes ${name}`)).match(/^@keyframes[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/)![1]!;
    const properties = new Set([...frames.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]));
    expect([...properties].every(property => ['rotate', 'translate', 'animation-timing-function'].includes(property!))).toBe(true);
  }
});

test('a change reaching a long opened list draws again the changed step alone, not every row', () => {
  const rows = Array.from({ length: 600 }, (_, n) => ({ ...entry(n, `echo ${n}`), changed: n + 1 }));
  const listed = takeIn(null, { steps: rows, total: 600, generation: 1 }, { caughtUp: 600 })!;
  // As the list's hook gives them: the same callbacks from one read to the next.
  const earlier = () => {}, again = () => {};
  const read = (value: typeof listed) => ({ run: 'R7', listed: value, failed: false, earlier, again });
  const durations: { actual: number; base: number }[] = [];
  const page = (value: typeof listed) => <Profiler id="list" onRender={(_id, _phase, actual, base) => durations.push({ actual, base })}>
    <StepList steps={read(value)} open /></Profiler>;
  const { rerender } = render(page(listed));
  rerender(page(takeIn(listed, { steps: [{ ...rows[300]!, state: 'failed', changed: 601 }], total: 600, generation: 1 }, { caughtUp: 601 })!));
  const update = durations.at(-1)!;
  expect(document.querySelectorAll('[data-run-step=failed]')).toHaveLength(1);
  // The rows that did not change are not drawn again: the update costs a small part of drawing them all.
  expect(update.actual).toBeLessThan(update.base / 4);
});

test("a running turn's work changing draws that turn again, not an answered turn's work", () => {
  const at = '2026-11-01T00:00:00.000Z';
  // The live work of the turn at work, as the index carries it, at its nth step.
  const work = (n: number) => ({ conversation: undefined as unknown as string, turn: 'now', run: 'R8', name: null, count: 0, words: null,
    stepEvents: n, stepsStarted: n, steps: [{ id: `s${n}`, at, tool: 'Bash', kind: 'command' as const, text: `echo ${n}`, more: 0, about: null, state: 'running' as const, result: null }] });
  const store = createStore(() => ({ info: { coordinatorWork: work(1) } })) as unknown as WorkspaceStore;
  const drawn = { answered: 0, running: 0 };
  render(<WorkspaceContext.Provider value={store}>
    <Profiler id="answered" onRender={() => { drawn.answered++; }}><TurnWork turn={{ id: 'done', at, status: 'succeeded', workedBy: 'R7' }} /></Profiler>
    <Profiler id="running" onRender={() => { drawn.running++; }}><TurnWork turn={{ id: 'now', at, status: 'running' }} /></Profiler>
  </WorkspaceContext.Provider>);
  const before = { ...drawn };
  for (let n = 2; n <= 7; n++) act(() => { store.setState({ info: { coordinatorWork: work(n) } } as never); });
  expect(screen.getByText('echo 7')).toBeTruthy();
  expect(drawn.running - before.running).toBeGreaterThanOrEqual(6);
  expect(drawn.answered - before.answered, 'the answered turn is not drawn again').toBe(0);
});
