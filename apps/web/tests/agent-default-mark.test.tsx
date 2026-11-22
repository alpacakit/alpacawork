import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  // effort and fast follow the default; copilot's empty model default and empty variable list have nothing to follow.
  expect(screen.getAllByRole('button', { name: 'Built-in default' })).toHaveLength(3);
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
  // effort is not written, so it alone follows the default; model and the variables wait for a restore.
  expect(screen.getAllByRole('button', { name: 'Built-in default' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: /^Restore the default/ })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Restore the default for model' }));
  expect(screen.getAllByRole('button', { name: 'Built-in default' })).toHaveLength(2);
  expect(latest).not.toEqual(initial);
  // Saving writes no value equal to its default, so the written variables go too, and are followed when read again.
  const saved = writeAgentsDraft(latest);
  expect(saved.ok && parse(saved.value)).toEqual({ claude: {} });
});

test('each row marks the value tasks start on, and a pressed value moves to the front; a row starting on none offers no change', () => {
  const read = readAgentsDraft('claude:\n  params:\n    model: [opus, fable]\n    effort: ["-", high]\n');
  if (!read.ok) throw new Error('unreadable');
  const initial = read.value;
  let latest = initial;
  function Form() {
    const [draft, setDraft] = useState(initial);
    return <AgentSettings draft={draft} onChange={next => { latest = next; setDraft(next); }} />;
  }
  render(<Form />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand claude' }));
  const marks = () => [...document.querySelectorAll('[data-agent-start-values]')].map(row => row.textContent);
  expect(marks()).toEqual(['opusDefault for tasksfable']);
  fireEvent.click(screen.getByRole('button', { name: 'Make fable the default for tasks' }));
  expect(marks()).toEqual(['fableDefault for tasksopus']);
  const saved = writeAgentsDraft(latest);
  expect(saved.ok && parse(saved.value).claude.params).toEqual({ model: ['fable', 'opus'], effort: ['-', 'high'] });
});
