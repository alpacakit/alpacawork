import { describe, expect, it } from 'vitest';
import type { AgentAvailability } from '@alpacawork/contract';
import { chosenAgents, firstAgentOf, startAgents, usableAgents } from '../src/features/setup/rules';
import type { AgentDraft } from '../src/features/panels/agent-settings-draft';

const agent = (name: string, enabled: boolean): AgentDraft => ({ id: name, originalName: name, name, adapter: name as AgentDraft['adapter'], enabled, params: [] });
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
    expect(added.map(each => [each.name, each.enabled])).toEqual([['codex', true], ['grok', true]]);
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
    expect(chosenAgents(configured, rows, on, 'claude')!.map(each => [each.name, each.enabled])).toEqual([['claude', true], ['codex', false], ['copilot', true]]);
    // Switched off, it is saved off, so coming back to this step does not switch it on again.
    const off = chosenAgents(configured, rows, { claude: false, copilot: true }, 'copilot')!;
    expect(off.map(each => [each.name, each.enabled])).toEqual([['copilot', true], ['claude', false], ['codex', false]]);
    // Codex signed in after that save, and switched on, stays behind the first agent the person chose.
    const later = startAgents(off, { availability: { copilot: seen('ready'), claude: seen('ready'), codex: seen('ready') } }, false);
    expect(firstAgentOf(usableAgents(later, { copilot: true, codex: true }), null)).toBe('copilot');
  });

  it('keeps config.yaml\'s order when a listed agent\'s CLI is missing', () => {
    const configured = [agent('codex', true), agent('grok', true), agent('copilot', true)];
    const rows = startAgents(configured, { availability: { codex: seen('ready'), grok: seen('not_found'), copilot: seen('ready') } }, false);
    expect(rows.map(row => row.name)).toEqual(['codex', 'copilot', 'grok']);
    expect(chosenAgents(configured, rows, { codex: true, copilot: true }, 'codex')).toBeNull();
  });

  it('leaves an agent whose CLI is missing as config.yaml has it', () => {
    const configured = [agent('codex', true), agent('grok', true)];
    const rows = startAgents(configured, { availability: { codex: seen('ready'), grok: seen('not_found') } }, false);
    expect(chosenAgents(configured, rows, { codex: true, grok: false }, 'codex')).toBeNull();
  });

  it('writes config.yaml only when the switches or the first agent differ from it', () => {
    const rows = startAgents(agents, { availability: { ...observed.availability, claude: seen('ready') } }, false);
    expect(chosenAgents(agents, rows, { codex: true, claude: false }, 'codex')).toBeNull();
    const both = chosenAgents(agents, rows, { codex: true, claude: true }, 'claude')!;
    expect(both.map(each => [each.name, each.enabled])).toEqual([['claude', true], ['codex', true], ['grok', false]]);
    // An agent the screen does not list keeps what config.yaml says.
    expect(chosenAgents(agents, rows, { codex: false, claude: true }, 'claude')!.find(each => each.name === 'grok')!.enabled).toBe(false);
  });

  it('starts requests on the picked agent while it is usable, else on the first usable one', () => {
    const rows = startAgents(agents, { availability: { codex: seen('ready'), claude: seen('ready') } }, false);
    const usable = usableAgents(rows, { codex: true, claude: true });
    expect(firstAgentOf(usable, 'claude')).toBe('claude');
    expect(firstAgentOf(usableAgents(rows, { codex: true, claude: false }), 'claude')).toBe('codex');
    expect(firstAgentOf([], null)).toBeNull();
  });
});
