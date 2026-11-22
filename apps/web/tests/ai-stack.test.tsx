import { afterEach, beforeAll, expect, test } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { AiStack } from '../src/features/panels/AiStack';
import { readAgentsDraft } from '../src/features/panels/agent-settings-draft';
import { readStack, stackIssues, writeStack, type StackRowDraft } from '../src/features/panels/ai-stack-draft';
beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(cleanup);

const read = readAgentsDraft('claude:\n  params:\n    model: [opus, fable]\n    effort: [medium, high]\n'
  + 'codex:\n  params:\n    model: [gpt-6.2-sol, gpt-6.1-terra]\n    effort: [medium, high]\n    fast: ["-", fast]\n');
if (!read.ok) throw new Error('unreadable');
const agents = read.value.agents;

test('rows are added, moved and removed in one ordered list, the same agent on several rows, and saved in that order', () => {
  let latest: StackRowDraft[] = [];
  function Form() {
    const [rows, setRows] = useState(readStack([{ agent: 'claude', values: { model: 'opus', effort: 'medium' } }]));
    return <AiStack rows={rows} agents={agents} onChange={next => { latest = next; setRows(next); }} />;
  }
  render(<Form />);
  // The first row is the default; it cannot move up, and the only row cannot be removed.
  expect(screen.getByRole('button', { name: 'Move row 1 up' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Remove row 1' })).toHaveProperty('disabled', true);
  // A fallback added starts as a copy of the last row, focused to be edited: it never picks a model by itself.
  fireEvent.click(screen.getByRole('button', { name: '+ Add a fallback AI' }));
  expect(writeStack(latest)).toEqual([{ agent: 'claude', values: { model: 'opus', effort: 'medium' } }, { agent: 'claude', values: { model: 'opus', effort: 'medium' } }]);
  expect(document.activeElement).toBe(screen.getByLabelText('Model in row 2'));
  // It repeats row 1, and the row says so.
  expect(document.querySelectorAll<HTMLElement>('[data-ai-stack-row]')[1]!.dataset.repeats).toBe('1');
  fireEvent.change(screen.getByLabelText('Agent in row 2'), { target: { value: 'codex' } });
  fireEvent.change(screen.getByLabelText('Effort in row 2'), { target: { value: 'high' } });
  fireEvent.click(screen.getByRole('button', { name: 'Move row 2 up' }));
  expect(writeStack(latest)).toEqual([{ agent: 'codex', values: { model: 'gpt-6.2-sol', effort: 'high', fast: null } }, { agent: 'claude', values: { model: 'opus', effort: 'medium' } }]);
  expect(document.querySelector('[data-ai-stack-row="codex"] [data-ai-stack-first]')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove row 2' }));
  expect(latest.map(row => row.agent)).toEqual(['codex']);
});

test('a row the agents no longer run is said on the row and keeps the stack from being saved', () => {
  const rows = readStack([{ agent: 'claude', values: { model: 'haiku', effort: 'medium' } }, { agent: 'grok', values: {} }]);
  const disabled = agents.map(agent => agent.name === 'codex' ? { ...agent, enabled: false } : agent);
  const issues = stackIssues([...rows, ...readStack([{ agent: 'codex', values: { model: 'gpt-6.2-sol' } }])], disabled);
  expect(issues.map(issue => issue.kind)).toEqual(['value', 'missing', 'disabled']);
  expect(stackIssues([], agents).map(issue => issue.kind)).toEqual(['empty']);
  render(<AiStack rows={rows} agents={agents} onChange={() => {}} />);
  // Each row the agents no longer run is marked, with its reason under it.
  const shown = [...document.querySelectorAll<HTMLElement>('[data-ai-stack-row]')];
  expect(shown.map(row => row.hasAttribute('data-invalid'))).toEqual([true, true]);
  expect(shown.map(row => row.querySelectorAll('[data-slot="field-error"]').length)).toEqual([1, 1]);
});
