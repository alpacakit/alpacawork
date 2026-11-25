import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import type { RunFullStep, RunStep, RunStepsRead } from '@alpacawork/contract/run';
import { StepList, WorkLine } from '../src/features/people/RunSteps';
import { AnswerSteps } from '../src/features/coordinator/parts';

// What the server gives for a Run's steps, and the Runs asked for.
const read = vi.hoisted(() => ({ asked: [] as string[], answer: (): Promise<unknown> => Promise.reject(new Error('unset')) }));
vi.mock('../src/data/run-steps', () => ({ readRunSteps: (run: string) => { read.asked.push(run); return read.answer(); } }));

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
beforeEach(() => { read.asked = []; });
afterEach(cleanup);

const step = (id: string, input: string, rest: Partial<RunFullStep> = {}): RunFullStep => ({ id, tool: 'Bash', kind: 'command', about: null,
  state: 'done', input: { text: input, cut: false }, output: null, ...rest });
const many = (count: number) => Array.from({ length: count }, (_, index) => step(`s${index}`, `echo ${index}`));
const shown = (value: RunStepsRead) => ({ read: value, failed: false });

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

test('the list starts at the latest steps, oldest first, and goes back on a press as far as the read holds', () => {
  render(<StepList steps={shown({ steps: many(30), older: 4, unread: false })} />);
  const lines = () => [...document.querySelectorAll('[data-run-step]')].map(item => item.textContent);
  expect(lines()).toHaveLength(12);
  expect(lines()[0]).toContain('echo 18');
  expect(lines().at(-1)).toContain('echo 29');
  fireEvent.click(screen.getByText('Show 18 earlier'));
  expect(lines()).toHaveLength(30);
  expect(lines()[0]).toContain('echo 0');
  // The 4 before the read are not there to show: that is said, not offered.
  expect(screen.getByText('Earlier steps are too long to show')).toBeTruthy();
});

test('a step opens to what it ran and what came back, in full, a failed one marked and a cut one said', () => {
  render(<StepList steps={shown({ older: 0, unread: false, steps: [
    step('1', 'pnpm build\n  && pnpm test', { state: 'failed', output: { text: 'FAIL amount.test.ts\n  expected 2', cut: true } })] })} />);
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(document.querySelector('[data-run-step-input]')).toBeNull();
  fireEvent.click(screen.getByRole('button'));
  expect(document.querySelector('[data-run-step-input]')?.textContent).toBe('pnpm build\n  && pnpm test');
  expect(document.querySelector('[data-run-step-output]')?.textContent).toContain('FAIL amount.test.ts\n  expected 2');
  expect(screen.getByText('The rest is too long and was left out')).toBeTruthy();
});

test('an answer\'s steps are read only once opened, then counted and listed', async () => {
  read.answer = async () => ({ steps: many(3), older: 0, unread: false });
  render(<AnswerSteps run="R7" />);
  expect(read.asked).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Steps behind this answer' }));
  expect(await screen.findByText('3 steps behind this answer')).toBeTruthy();
  expect(read.asked).toEqual(['R7']);
  expect(document.querySelectorAll('[data-run-step]')).toHaveLength(3);
});

test('steps that cannot be read say so', async () => {
  read.answer = () => Promise.reject(new Error('refused'));
  render(<AnswerSteps run="R7" />);
  fireEvent.click(screen.getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toBe('The steps could not be read');
});
