import { afterEach, beforeAll, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { startI18n, i18n } from '@alpacawork/i18n';
import type { RunStep } from '@alpacawork/contract/run';
import { RunSteps } from '../src/features/people/RunSteps';

beforeAll(async () => { await startI18n(); await i18n.changeLanguage('en'); });
afterEach(cleanup);

const step = (id: string, text: string, rest: Partial<RunStep> = {}): RunStep => ({ id, at: '2026-11-24T00:00:00Z', tool: 'Bash', text,
  more: 0, about: null, state: 'done', result: null, ...rest });
const steps = [
  step('1', 'pnpm build'),
  step('2', 'pnpm test', { state: 'failed', result: { text: 'FAIL amount.test.ts', more: 4 } }),
  step('3', 'git status', { result: { text: 'clean', more: 0 } }),
  step('4', 'pnpm test --rerun', { state: 'running' }),
];

test('folded, only the latest step is drawn, saying it is still running', () => {
  render(<RunSteps steps={steps} open={false} />);
  expect(screen.getByText('pnpm test --rerun')).toBeTruthy();
  expect(screen.getByText('Running')).toBeTruthy();
  expect(screen.queryByText('git status')).toBeNull();
  expect(screen.queryByText('FAIL amount.test.ts')).toBeNull();
});

test('open, the steps before the latest are drawn up to the trail, and only a failed one says what came back', () => {
  render(<RunSteps steps={steps} open trail={2} />);
  expect(screen.getByText('pnpm test --rerun')).toBeTruthy();
  expect(screen.getByText('git status')).toBeTruthy();
  expect(screen.getByText('pnpm test')).toBeTruthy();
  expect(screen.queryByText('pnpm build')).toBeNull();
  expect(screen.getByText('FAIL amount.test.ts')).toBeTruthy();
  expect(screen.getByText('Failed')).toBeTruthy();
  expect(screen.queryByText('clean')).toBeNull();
});

test('with no steps, nothing is drawn', () => {
  const { container } = render(<RunSteps steps={[]} open />);
  expect(container.innerHTML).toBe('');
});
