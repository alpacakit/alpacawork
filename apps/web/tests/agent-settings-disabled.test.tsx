import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as bareRender, screen } from '@testing-library/react';
import { i18n, startI18n } from '@alpacawork/i18n';
import { AgentSettings } from '../src/features/panels/AgentSettings';
import { beginDraftOptionsEdit, newAgentDraft, type AgentsDraft } from '../src/features/panels/agent-settings-draft';
import { WithQueries } from './fixtures';
import { queryClient } from '../src/data/query-client';

// Drawn as the screen draws it, inside the queries' provider: an agent's mark reads the server settings.
const render = (ui: Parameters<typeof bareRender>[0]) => bareRender(ui, { wrapper: WithQueries });
beforeAll(async () => { startI18n(); await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); queryClient.clear(); });

test('open portal actions stop editing when the parent disables the form', () => {
  const draft: AgentsDraft = { source: '{}', agents: [beginDraftOptionsEdit(newAgentDraft('codex', 'codex', 'codex'), 'a'.repeat(64))] };
  for (const surface of ['add', 'reset'] as const) {
    const onChange = vi.fn();
    const view = render(<AgentSettings draft={draft} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand codex' }));
    fireEvent.click(screen.getByRole('button', { name: surface === 'add' ? '+ Add agent' : 'Restore defaults' }));
    view.rerender(<AgentSettings draft={draft} onChange={onChange} disabled />);
    const action = screen.getByRole('button', { name: surface === 'add' ? 'Add' : 'Restore defaults' });
    expect(action.matches(':disabled')).toBe(true);
    fireEvent.click(action);
    expect(onChange).not.toHaveBeenCalled();
    view.unmount();
  }
});

test('editing saved launch options keeps the defaults they were written from', () => {
  const edited = beginDraftOptionsEdit(newAgentDraft('codex', 'codex', 'codex'), '0'.repeat(64));
  const onChange = vi.fn();
  render(<AgentSettings draft={{ source: '{}', agents: [edited] }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Expand codex' }));
  fireEvent.change(screen.getByLabelText('New conversation'), { target: { value: `${edited.options!.start} --x` } });
  expect(onChange.mock.lastCall![0].agents[0].options.base).toBe('0'.repeat(64));
});
