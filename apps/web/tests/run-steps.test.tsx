import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import type { RunStep, RunStepDetail, RunStepEntry } from '@alpacawork/contract/run';
import { StepList, WorkLine, useRunSteps } from '../src/features/people/RunSteps';
import { AnswerSteps } from '../src/features/coordinator/parts';

// The server's side: one Run's steps and what each ran, read as the screen asks for them.
const server = vi.hoisted(() => ({
  steps: [] as RunStepEntry[], details: new Map<number, RunStepDetail>(), refuse: false, asked: [] as string[],
}));
vi.mock('../src/data/run-steps', () => ({
  readRunSteps: async (run: string, range: { from?: number; limit: number }) => {
    server.asked.push(`${run} ${range.from ?? 'latest'} ${range.limit}`);
    if (server.refuse) throw new Error('refused');
    const total = server.steps.length, from = range.from ?? Math.max(0, total - range.limit);
    return { from, total, steps: server.steps.slice(from, from + range.limit) };
  },
  readRunStep: async (run: string, n: number) => {
    server.asked.push(`${run} step ${n}`);
    return server.details.get(n) ?? { input: { text: server.steps[n]!.text, omitted: 0 }, output: null };
  },
}));

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => { server.steps = []; server.details = new Map(); server.refuse = false; server.asked = []; });
afterEach(cleanup);

const entry = (n: number, text: string, rest: Partial<RunStepEntry> = {}): RunStepEntry => ({ n, id: `s${n}`, tool: 'Bash', kind: 'command',
  text, more: 0, about: null, state: 'done', ...rest });
const lines = () => [...document.querySelectorAll('[data-run-step]')].map(item => item.textContent);

test('the work line says the tool and what it runs on one line, or how many steps are listed under it', () => {
  const latest: RunStep = { id: '1', at: '2026-11-24T00:00:00Z', tool: 'command_execution', kind: 'command', text: 'pnpm test --filter web', more: 2,
    about: null, state: 'running', result: null };
  const { rerender, container } = render(<WorkLine step={latest} />);
  expect(container.querySelector('[data-work-mark]')).toBeTruthy();
  expect(screen.getByText('Bash')).toBeTruthy();
  expect(screen.getByText('pnpm test --filter web')).toBeTruthy();
  rerender(<WorkLine step={latest} label="12 steps so far" />);
  expect(screen.queryByText('pnpm test --filter web')).toBeNull();
  expect(screen.getByText('12 steps so far')).toBeTruthy();
});

test('an answer\'s steps are read only once opened, the latest first, and every earlier one a page at a time', async () => {
  server.steps = Array.from({ length: 300 }, (_, n) => entry(n, `echo ${n}`));
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
  server.steps = [entry(0, 'pnpm build', { more: 1, state: 'failed' })];
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

test('when any step the screen was told of changes, the list is read again: an earlier step failing while a later one runs', async () => {
  server.steps = [entry(0, 'pnpm test', { state: 'running' }), entry(1, 'pnpm lint', { state: 'running' })];
  function Listed({ version }: { version: string }) {
    return <StepList steps={useRunSteps('R7', true, version)} />;
  }
  const { rerender } = render(<Listed version="s0:running s1:running" />);
  await waitFor(() => expect(document.querySelectorAll('[data-run-step=running]')).toHaveLength(2));
  server.steps = [entry(0, 'pnpm test', { state: 'failed' }), entry(1, 'pnpm lint', { state: 'running' })];
  rerender(<Listed version="s0:failed s1:running" />);
  await waitFor(() => expect(document.querySelector('[data-run-step=failed]')?.textContent).toContain('pnpm test'));
  expect(document.querySelectorAll('[data-run-step=running]')).toHaveLength(1);
});

test('steps that cannot be read say so', async () => {
  server.refuse = true;
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toBe('The steps could not be read');
});
