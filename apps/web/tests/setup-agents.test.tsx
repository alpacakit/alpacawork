import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { parse } from 'yaml';
import { DEFAULT_LIMITS } from '@alpacawork/contract';
import { AgentsStep } from '../src/features/setup/AgentsStep';
import type { AgentAvailability } from '@alpacawork/contract';
import { chosenAgents, firstAgentOf, startAgents, usableAgents } from '../src/features/setup/rules';
import type { AgentDraft } from '../src/features/panels/agent-settings-draft';

// The step's reads, as the server answers them: each read is the same object from render to render, as a query's is.
const given = vi.hoisted(() => ({ settings: {} as { data: unknown }, status: {} as { data: unknown }, saved: [] as { agents: string }[] }));
vi.mock('../src/data/queries', () => ({
  useServerSettings: () => given.settings,
  useAgentStatus: () => given.status,
  useSaveServerSettings: () => ({ mutateAsync: async (input: { agents: string }) => { given.saved.push(input); return {}; } }),
  useWorkspaceInfo: (select: (info: { root: string }) => unknown) => select({ root: '/fixture' }),
}));
const telemetry = { status: { data: { state: 'on' } }, choose: async () => true };
vi.mock('../src/features/telemetry/data', () => ({ useTelemetry: () => telemetry }));

const agent = (name: string, enabled: boolean): AgentDraft => ({ id: name, originalName: name, name, adapter: name as AgentDraft['adapter'], enabled, params: [] });
// config.yaml after a setup has saved once: every kind is listed, the ones not given here off.
const kinds = ['claude', 'codex', 'grok', 'pi', 'copilot'];
const saved = (...listed: AgentDraft[]) => [...listed, ...kinds.filter(kind => !listed.some(each => each.name === kind)).map(kind => agent(kind, false))];
const seen = (status: AgentAvailability['status']): AgentAvailability =>
  ({ command: '/bin/x', version: null, candidates: [], status, nextAction: status === 'signed_out' ? 'claude auth login' : null, issue: null });

describe('the setup\'s agents', () => {
  const agents = [agent('codex', true), agent('claude', false), agent('grok', false)];
  const observed = { availability: { codex: seen('ready'), claude: seen('signed_out'), grok: seen('not_found') } };

  it('lists every supported kind, ready only when the check confirmed it, and the ones whose CLI is missing last', () => {
    expect(startAgents(agents, observed, false)).toEqual([
      { name: 'codex', adapter: 'codex', status: 'ready', signIn: null, command: 'codex', configured: true },
      { name: 'claude', adapter: 'claude', status: 'signedOut', signIn: 'claude auth login', command: 'claude', configured: true },
      { name: 'grok', adapter: 'grok', status: 'missing', signIn: null, command: 'grok', configured: true }]);
    // A supported kind config.yaml does not list is shown too when its CLI is missing, and cannot be enabled.
    const absent = startAgents([agent('codex', true)], { availability: { codex: seen('ready') }, detected: { pi: seen('not_found'), grok: seen('unknown') } }, false);
    expect(absent.map(row => [row.name, row.status])).toEqual([['codex', 'ready'], ['grok', 'found'], ['pi', 'missing']]);
    expect(usableAgents(absent, { codex: true, pi: true })).toEqual(['codex']);
    // Switched on, a kind config.yaml did not list is added to it; one whose CLI is missing is never written.
    const added = chosenAgents([agent('codex', true)], absent, { codex: true, grok: true, pi: true }, 'codex')!;
    expect(added.map(each => [each.name, each.enabled])).toEqual([['codex', true], ['claude', false], ['grok', true], ['pi', false], ['copilot', false]]);
    expect(startAgents(agents, undefined, true).map(row => row.status)).toEqual(['checking', 'checking', 'checking']);
    // A kind with no sign-in check (or a check that did not answer) can still take work, as in Settings.
    const found = startAgents([agent('pi', true)], { availability: { pi: seen('unknown') } }, false);
    expect(found.map(row => row.status)).toEqual(['found']);
    expect(usableAgents(found, { pi: true })).toEqual(['pi']);
  });

  it('places a kind signed in after config.yaml was made where alpacawork\'s order puts it, so it can be the default', () => {
    // A new config.yaml lists only what was signed in then; Claude Code's check answered only on the screen.
    const configured = [agent('copilot', true)];
    const rows = startAgents(configured, { availability: { copilot: seen('ready') }, detected: { claude: seen('ready'), codex: seen('signed_out') } }, false);
    expect(rows.map(row => row.name)).toEqual(['claude', 'codex', 'copilot']);
    const on = { claude: true, copilot: true };
    expect(firstAgentOf(usableAgents(rows, on), null)).toBe('claude');
    expect(chosenAgents(configured, rows, on, 'claude')!.map(each => [each.name, each.enabled])).toEqual([['claude', true], ['codex', false], ['grok', false], ['pi', false], ['copilot', true]]);
    // Switched off, it is saved off, so coming back to this step does not switch it on again.
    const off = chosenAgents(configured, rows, { claude: false, copilot: true }, 'copilot')!;
    expect(off.map(each => [each.name, each.enabled])).toEqual([['copilot', true], ['claude', false], ['codex', false], ['grok', false], ['pi', false]]);
    // Codex signed in, or Grok installed, after that save stays behind the first agent the person chose.
    const later = startAgents(off, { availability: { copilot: seen('ready'), claude: seen('ready'), codex: seen('ready') } }, false);
    expect(firstAgentOf(usableAgents(later, { copilot: true, codex: true }), null)).toBe('copilot');
  });

  it('keeps config.yaml\'s order when a listed agent\'s CLI is missing', () => {
    const configured = saved(agent('codex', true), agent('grok', true), agent('copilot', true));
    const rows = startAgents(configured, { availability: { codex: seen('ready'), grok: seen('not_found'), copilot: seen('ready') } }, false);
    expect(rows.map(row => row.name)).toEqual(['codex', 'copilot', 'claude', 'pi', 'grok']);
    expect(chosenAgents(configured, rows, { codex: true, copilot: true }, 'codex')).toBeNull();
  });

  it('leaves an agent whose CLI is missing as config.yaml has it', () => {
    const configured = saved(agent('codex', true), agent('grok', true));
    const rows = startAgents(configured, { availability: { codex: seen('ready'), grok: seen('not_found') } }, false);
    expect(chosenAgents(configured, rows, { codex: true, grok: false }, 'codex')).toBeNull();
  });

  it('writes config.yaml only when the switches or the first agent differ from it', () => {
    const all = saved(...agents);
    const rows = startAgents(all, { availability: { ...observed.availability, claude: seen('ready') } }, false);
    expect(chosenAgents(all, rows, { codex: true, claude: false }, 'codex')).toBeNull();
    const both = chosenAgents(all, rows, { codex: true, claude: true }, 'claude')!;
    expect(both.map(each => [each.name, each.enabled])).toEqual([['claude', true], ['codex', true], ['grok', false], ['pi', false], ['copilot', false]]);
    // An agent the screen does not list keeps what config.yaml says.
    expect(chosenAgents(all, rows, { codex: false, claude: true }, 'claude')!.find(each => each.name === 'grok')!.enabled).toBe(false);
  });

  it('starts requests on the picked agent while it is usable, else on the first usable one', () => {
    const rows = startAgents(agents, { availability: { codex: seen('ready'), claude: seen('ready') } }, false);
    const usable = usableAgents(rows, { codex: true, claude: true });
    expect(firstAgentOf(usable, 'claude')).toBe('claude');
    expect(firstAgentOf(usableAgents(rows, { codex: true, claude: false }), 'claude')).toBe('codex');
    expect(firstAgentOf([], null)).toBeNull();
  });

  it('says an agent the check has no answer for is found, never signed out', () => {
    const rows = startAgents([agent('codex', true), agent('pi', true)], { availability: { codex: seen('signed_out') } }, false);
    expect(rows.map(row => [row.name, row.status])).toEqual([['codex', 'signedOut'], ['pi', 'found']]);
  });
});

describe('leaving the agents step', () => {
  it('saves the agents that cannot take work as disabled when the person continues without an agent', async () => {
    // Setup in the terminal enabled Codex; the server's check sees it signed out, and no other agent is usable.
    given.settings = { data: { hash: 'a'.repeat(64), agentsText: 'agents:\n  claude:\n    enabled: false\n  codex: {}\n', agents: {}, catalog: [],
      limits: { ...DEFAULT_LIMITS } } };
    given.status = { data: { availability: { codex: seen('signed_out'), claude: seen('signed_out') } }, isPending: false, isFetching: false } as never;
    given.saved = [];
    const next = vi.fn();
    const view = render(<QueryClientProvider client={new QueryClient()}><AgentsStep onBack={vi.fn()} onNext={next} /></QueryClientProvider>);
    // The way on that the step offers when no agent can take work.
    const without = await waitFor(() => view.container.querySelector<HTMLButtonElement>('[data-setup-without-agent]')!);
    fireEvent.click(without);
    await waitFor(() => expect(next).toHaveBeenCalled());
    expect(given.saved).toHaveLength(1);
    expect(parse(given.saved[0]!.agents).agents.codex.enabled).toBe(false);
  });
});
