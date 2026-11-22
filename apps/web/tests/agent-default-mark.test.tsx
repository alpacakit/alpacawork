import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { parse } from 'yaml';
import { i18n, startI18n } from '@alpacawork/i18n';
import { AGENT_ADAPTERS } from '@alpacawork/contract/agent-adapters';
import { AgentSettings } from '../src/features/panels/AgentSettings';
import { newAgentDraft, readAgentsDraft, writeAgentsDraft, type AgentsDraft } from '../src/features/panels/agent-settings-draft';
beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(cleanup);

test('a changed default value can be restored, and only fields with a default offer it', () => {
  const codex = newAgentDraft('codex', 'codex', 'codex');
  const changed = { ...codex, params: codex.params.map(row => row.key === 'model' ? { ...row, values: 'mine' } : row) };
  const onChange = vi.fn();
  render(<AgentSettings draft={{ source: '{}', agents: [changed, newAgentDraft('copilot', 'copilot', 'copilot')] } satisfies AgentsDraft} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand codex' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand copilot' }));
  expect(screen.getAllByRole('button', { name: /^Restore the default/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Restore the default for model' }));
  const model = onChange.mock.lastCall![0].agents[0].params.find((row: { key: string }) => row.key === 'model');
  expect(model.values).toBe(AGENT_ADAPTERS.codex.defaultParams.model!.join(', '));
  expect(document.activeElement).toBe(screen.getAllByLabelText(/model/, { selector: 'textarea' })[0]);
});

test('a value written in config.yaml stays until restored, even when it equals the default', () => {
  const read = readAgentsDraft('claude:\n  params:\n    model: [opus, fable]\n  env: [ANTHROPIC_API_KEY]\n');
  if (!read.ok) throw new Error('unreadable');
  const initial = read.value;
  let latest = initial;
  function Form() {
    const [draft, setDraft] = useState(initial);
    return <AgentSettings draft={draft} onChange={next => { latest = next; setDraft(next); }} />;
  }
  render(<Form />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand claude' }));
  // model and the variables are written, so they wait for a restore; effort is not.
  expect(screen.getAllByRole('button', { name: /^Restore the default/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Restore the default for model' }));
  expect(screen.getAllByRole('button', { name: /^Restore the default/ })).toHaveLength(1);
  expect(latest).not.toEqual(initial);
  // Saving writes no value equal to its default, so the written variables go too, and are followed when read again.
  const saved = writeAgentsDraft(latest);
  expect(saved.ok && parse(saved.value)).toEqual({ claude: {} });
});

test('the task defaults: one row per enabled agent, a value from each used row, the marked agent first, and a default no longer offered said', () => {
  const read = readAgentsDraft('claude:\n  params:\n    model: [opus, fable]\n    effort: [medium, high]\n    tier: [a, b]\n  defaults:\n    effort: max\n'
    + 'codex:\n  params:\n    model: [gpt-6.2-sol, gpt-6.1-terra]\n    effort: [medium, high, low]\n    fast: ["-", fast]\n'
    + 'copilot:\n  enabled: false\n');
  if (!read.ok) throw new Error('unreadable');
  const initial = read.value;
  let latest = initial;
  function Form() {
    const [draft, setDraft] = useState(initial);
    return <AgentSettings draft={draft} onChange={next => { latest = next; setDraft(next); }} />;
  }
  render(<Form />);
  const rows = () => [...document.querySelectorAll<HTMLElement>('[data-task-default]')];
  // A disabled agent has no row; a row the launch options do not use (tier) has no value to pick.
  expect(rows().map(row => row.dataset.taskDefault)).toEqual(['claude', 'codex']);
  expect(screen.queryByLabelText('tier for claude')).toBeNull();
  // A written default no longer among the values: the first stands in, and the row says so.
  expect(screen.getByLabelText<HTMLSelectElement>('Effort for claude').value).toBe('medium');
  expect(rows()[0]!.textContent).toContain('“max” is no longer a value, so “medium” is used');
  fireEvent.click(within(rows()[1]!).getByRole('radio'));
  fireEvent.change(screen.getByLabelText('Effort for codex'), { target: { value: 'high' } });
  expect(latest.agents.map(agent => agent.name)).toEqual(['codex', 'claude', 'copilot']);
  const saved = writeAgentsDraft(latest);
  expect(saved.ok && parse(saved.value).codex.defaults).toEqual({ effort: 'high' });
});
