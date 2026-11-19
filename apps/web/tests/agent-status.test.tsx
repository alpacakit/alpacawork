import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { defaultAgentSetting } from '@alpacawork/contract/agent-settings';
import type { AgentAvailability } from '@alpacawork/contract';
import { readAgentsDraft, validateAgentsDraft, writeAgentsDraft, type AgentsDraft, type DraftResult } from '../src/features/panels/agent-settings-draft';
import { addAgentGuide, agentNotice, agentObservation, executableChoices, withCommand } from '../src/features/panels/agent-status';

function value<T>(result: DraftResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
const seen = (status: AgentAvailability['status'], paths: string[] = [], command: string | null = paths[0] ?? null): AgentAvailability =>
  ({ command, version: null, candidates: paths.map(path => ({ path, version: '1.0' })), status, nextAction: 'codex login',
    issue: status === 'not_found' ? 'Executable was not found' : null });

describe('the line a closed card adds', () => {
  it('is shown only for an agent known not to start', () => {
    expect(agentNotice('codex', seen('signed_out', ['/bin/codex']))).toEqual({ kind: 'signedOut', action: 'codex login' });
    expect(agentNotice('codex', seen('not_found'))).toEqual({ kind: 'notFound', executable: 'codex' });
    expect(agentNotice('codex', seen('not_found', [], '/gone/codex'))).toEqual({ kind: 'notFound', executable: '/gone/codex' });
    expect(agentNotice('codex', seen('ready', ['/bin/codex']))).toBeNull();
    expect(agentNotice('grok', seen('unknown', ['/bin/grok']))).toBeNull();
    expect(agentNotice('codex', undefined)).toBeNull();
  });
  it('reads a saved profile by its saved name, and a new one by its kind until it names a path', () => {
    const observations = { availability: { work: seen('signed_out', ['/a']) }, detected: { codex: seen('ready', ['/b']) } };
    const saved = value(readAgentsDraft('work:\n  adapter: codex\n  params: {}\n')).agents[0]!;
    expect(agentObservation({ ...saved, name: 'renamed' }, observations)?.status).toBe('signed_out');
    const added = { id: 'x', name: 'other', adapter: 'codex' as const, params: [] };
    expect(agentObservation(added, observations)?.status).toBe('ready');
    expect(agentObservation({ ...added, command: '/c' }, observations)).toBeUndefined();
  });
});

describe('the executable choices', () => {
  const detected = seen('ready', ['/first/codex', '/second/codex']);
  it('offers the PATH first as automatic and the other same-named commands beside it', () => {
    expect(executableChoices(undefined, detected)).toMatchObject({ automatic: { path: '/first/codex' }, others: [{ path: '/second/codex' }], selected: 'automatic' });
    expect(executableChoices('/second/codex', detected).selected).toBe('/second/codex');
    expect(executableChoices('/typed/codex', detected).selected).toBe('other');
  });
  it('keeps a pinned first command as its own choice', () => {
    expect(executableChoices('/first/codex', detected)).toMatchObject({ others: [{ path: '/first/codex' }, { path: '/second/codex' }], selected: '/first/codex' });
  });
});

describe('command in the saved agents', () => {
  const source = stringify({ agents: { codex: defaultAgentSetting('codex') } });
  const draft = () => value(readAgentsDraft(source, 'agents'));
  const write = (draft: AgentsDraft) => parse(value(writeAgentsDraft(draft))).agents.codex;
  it('writes a chosen path and removes it for automatic', () => {
    const pinned = { ...draft(), agents: [withCommand(draft().agents[0]!, '/opt/codex')] };
    expect(write(pinned)).toMatchObject({ command: '/opt/codex' });
    const read = value(readAgentsDraft(value(writeAgentsDraft(pinned)), 'agents'));
    expect(read.agents[0]!.command).toBe('/opt/codex');
    expect(write({ ...read, agents: [withCommand(read.agents[0]!, undefined)] })).not.toHaveProperty('command');
  });
  it('refuses a path that is not absolute, on the command field', () => {
    const issues = validateAgentsDraft({ ...draft(), agents: [withCommand(draft().agents[0]!, 'codex --x')] });
    expect(issues.map(issue => issue.field)).toEqual(['command']);
  });
});

describe('what the add control says under a chosen kind', () => {
  it('follows what the server saw: nothing to sign in when ready, the next step alone when signed out, else the general words', () => {
    expect(addAgentGuide('codex', seen('ready', ['/bin/codex']))).toEqual({ place: { path: '/bin/codex', version: null }, signIn: null });
    expect(addAgentGuide('codex', seen('signed_out', ['/bin/codex'])).signIn).toBe('signedOut');
    expect(addAgentGuide('grok', { ...seen('unknown', ['/bin/grok']), nextAction: null }).signIn).toBe('general');
    expect(addAgentGuide('codex', seen('not_found'))).toEqual({ place: 'missing', signIn: 'general' });
    expect(addAgentGuide('copilot', { ...seen('ready'), command: null })).toEqual({ place: null, signIn: null });
    expect(addAgentGuide('codex', undefined)).toEqual({ place: null, signIn: 'general' });
  });
});
