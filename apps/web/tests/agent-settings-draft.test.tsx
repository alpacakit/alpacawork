import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { AGENT_ADAPTERS, optionsBase } from '@alpacawork/contract/agent-adapters';
import { defaultAgentSetting } from '@alpacawork/contract/agent-settings';
import { agentOptionsVersion } from '../src/features/panels/agent-options-version';
import { optionPartText } from '../src/features/panels/agent-options-display';
import { parseLaunchOptions } from '@alpacawork/contract/launch-options';
import { firstEnabledAgent, withFirstAgent } from '../src/features/panels/agent-settings-order';
import { beginDraftOptionsEdit, followsDefaultEnv, followsDefaultParam, newAgentDraft, readAgentsDraft,
  resetDraftEnv, resetDraftOptions, resetDraftParam, unusedParamReason,
  updateDraftOptions, isOptionalDraftParam, validateAgentsDraft, writeAgentsDraft, type AgentsDraft, type DraftResult } from '../src/features/panels/agent-settings-draft';

function value<T>(result: DraftResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
const base = 'a'.repeat(64); // A test digest supplied by the integration boundary, never a production fallback.
const input = `# agents comment
agy: # profile comment
  params: # params comment
    model: [gemini-3.8-flash, claude-sonnet-4-6, gpt-oss-120b-medium] # choices comment
    effort: [high, low, medium]
  without: # keep model exceptions
    claude-sonnet-4-6: [effort] # exception comment
  env: [GEMINI_API_KEY]
claude:
  params:
    model: [opus]
    effort: [high, low]
`;

describe('agent form YAML boundary', () => {
  it('derives optional row display before an options base is available', () => {
    expect(isOptionalDraftParam(beginDraftOptionsEdit(newAgentDraft('codex', 'codex', 'a')), 'model')).toBe(true);
  });

  it('returns a YAML issue for an unresolved alias instead of throwing', () => {
    expect(readAgentsDraft('codex: *missing\n')).toMatchObject({ ok: false, issues: [expect.objectContaining({ field: 'yaml' })] });
  });

  it('keeps the API agents block and its wrapper comments when editing a typed draft', () => {
    const source = '# server note\nagents: # agents note\n  claude:\n    params:\n      model: [opus]\n      effort: [high]\n';
    const draft = value(readAgentsDraft(source, 'agents'));
    const agent = draft.agents[0]!;
    agent.params[0]!.values = 'opus, sonnet';
    const yaml = value(writeAgentsDraft(draft));
    expect(parse(yaml).agents.claude.params.model).toEqual(['opus', 'sonnet']);
    expect(yaml).toContain('# server note');
    expect(yaml).toContain('# agents note');
  });
  it('saves only changed values and restores overwritten rows to omitted defaults', () => {
    const source = '# workspace note\ncodex: # profile note\n  enabled: true\n  params:\n    model: [gpt-6.1-sol] # model note\n    effort: [high, low, medium, xhigh, max, ultra]\n  env: []\n';
    const draft = value(readAgentsDraft(source));
    const agent = draft.agents[0]!;
    const model = agent.params.find(row => row.key === 'model')!;
    const effort = agent.params.find(row => row.key === 'effort')!;
    // Written down, even a value equal to the default no longer follows it.
    expect(followsDefaultParam(agent, effort)).toBe(false);
    expect(followsDefaultParam(agent, model)).toBe(false);
    expect(followsDefaultEnv(agent)).toBe(false);
    const written = value(writeAgentsDraft(draft));
    expect(parse(written)).toEqual({ codex: { params: { model: ['gpt-6.1-sol'] }, env: [] } });
    for (const comment of ['workspace note', 'profile note', 'model note']) expect(written).toContain(`# ${comment}`);
    const reset = resetDraftEnv(resetDraftParam(agent, model.id));
    expect(followsDefaultEnv(reset)).toBe(true);
    expect(followsDefaultParam(reset, reset.params.find(row => row.key === 'model')!)).toBe(true);
    expect(parse(value(writeAgentsDraft({ ...draft, agents: [reset] })))).toEqual({ codex: {} });
  });
  it('writes new overrides in block style and keeps an existing populated flow map inline', () => {
    const draft = value(readAgentsDraft('agents:\n  claude: {}\n  codex: { env: [EXISTING_KEY] }\n', 'agents'));
    for (const agent of draft.agents) agent.env = [`${agent.name.toUpperCase()}_KEY`];
    const yaml = value(writeAgentsDraft(draft));
    expect(yaml).toMatch(/^  claude:\n    env:\n      - CLAUDE_KEY$/m);
    expect(yaml).toMatch(/^  codex: \{.*env:.*CODEX_KEY.*\}$/m);
    expect(parse(yaml)).toEqual({ agents: { claude: { env: ['CLAUDE_KEY'] }, codex: { env: ['CODEX_KEY'] } } });
  });
  it('preserves comments, model exceptions and candidate order while writing default rows in adapter order', () => {
    const draft = value(readAgentsDraft(input));
    const agy = draft.agents[0]!;
    const edited = { ...agy, enabled: false, params: [...agy.params].reverse().map(row => row.key === 'effort' ? { ...row, values: 'medium, high, low' } : row) };
    const source = value(writeAgentsDraft({ ...draft, agents: [draft.agents[1]!, edited] }));
    expect(Object.keys(parse(source))).toEqual(['claude', 'agy']);
    expect(Object.keys(parse(source).agy.params)).toEqual(['model', 'effort']);
    expect(parse(source).agy.params.effort).toEqual(['medium', 'high', 'low']);
    expect(parse(source).agy.without).toEqual({ 'claude-sonnet-4-6': ['effort'] });
    for (const comment of ['agents comment', 'profile comment', 'params comment', 'choices comment', 'keep model exceptions', 'exception comment']) expect(source).toContain(`# ${comment}`);
    expect(draft.source).toBe(input);
  });

  it('keeps comments on renamed profiles and added row keys', () => {
    const draft = value(readAgentsDraft(`custom: # alias
  adapter: codex
  params:
    model: [gpt-6.1-sol]
    effort: [high]
    fast: ['-', fast]
    extra: [one] # custom row
`));
    const agent = draft.agents[0]!;
    const changed = { ...agent, name: 'renamed', params: agent.params.map(row => row.key === 'extra' ? { ...row, key: 'verbosity', values: 'low, medium' } : row) };
    const source = value(writeAgentsDraft({ ...draft, agents: [changed] }));
    expect(parse(source).renamed.params.verbosity).toEqual(['low', 'medium']);
    expect(source).toContain('# alias'); expect(source).toContain('# custom row');
    expect(parse(source).renamed.params.extra).toBeUndefined();
  });

  it('keeps each row’s values and comments when two extra keys are swapped', () => {
    const draft = value(readAgentsDraft('codex:\n  params:\n    model: [gpt-6.1-sol]\n    effort: [high]\n    fast: [fast]\n    aa: [first] # keep first\n    bb: [second] # keep second\n'));
    const agent = draft.agents[0]!;
    const swapped = { ...agent, params: agent.params.map(row => row.key === 'aa' ? { ...row, key: 'bb' } : row.key === 'bb' ? { ...row, key: 'aa' } : row) };
    const source = value(writeAgentsDraft({ ...draft, agents: [swapped] }));
    expect(parse(source).codex.params).toMatchObject({ bb: ['first'], aa: ['second'] });
    expect(source).toMatch(/bb:.*# keep first/);
    expect(source).toMatch(/aa:.*# keep second/);
    const renamedAndAdded = { ...agent, params: [
      ...agent.params.map(row => row.key === 'aa' ? { ...row, key: 'cc' } : row),
      { id: 'new-aa', key: 'aa', values: 'third' },
    ] };
    const reused = value(writeAgentsDraft({ ...draft, agents: [renamedAndAdded] }));
    expect(parse(reused).codex.params).toMatchObject({ cc: ['first'], aa: ['third'] });
    expect(reused).toMatch(/cc:.*# keep first/);
  });

  it('adds complete new option variables once, preserves existing rows and reports unused status', () => {
    const agent = newAgentDraft('codex', 'codex', 'codex');
    const edited = updateDraftOptions(agent, { base,
      start: AGENT_ADAPTERS.codex.options.start + ' [-c model_verbosity={verbosity}] [--new {custom}]',
      resume: AGENT_ADAPTERS.codex.options.resume + ' [--verbose {verbosity}] [--session {session}] {reserved',
    });
    expect(edited.params.slice(agent.params.length).map(row => row.key)).toEqual(['verbosity', 'custom']);
    expect(updateDraftOptions(edited, edited.options!).params).toEqual(edited.params);
    expect(unusedParamReason(edited, 'verbosity')).toBeNull();
    const noReference = updateDraftOptions(edited, { base, ...AGENT_ADAPTERS.codex.options });
    expect(noReference.params).toEqual(edited.params);
    expect(unusedParamReason(noReference, 'verbosity')).toBe('options');
    expect(unusedParamReason(resetDraftOptions(noReference), 'verbosity')).toBe('adapter');
    expect(unusedParamReason(agent, 'model')).toBeNull();
  });

  it('maps shared validation errors to candidate rows, keys, option modes and environment names', () => {
    const agent = newAgentDraft('codex', 'codex', 'codex');
    const draft: AgentsDraft = { source: '{}', agents: [{ ...agent, env: ['CODEX_HOME'],
      params: [...agent.params.map(row => row.key === 'model' ? { ...row, values: 'one,,one' } : row),
        { id: 'reserved-row', key: 'session', values: 'bad' }],
      options: { base, start: '{model} [', resume: AGENT_ADAPTERS.codex.options.resume } }] };
    const errors = validateAgentsDraft(draft);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'codex', rowId: agent.params[0]!.id, field: 'values', index: 1 }),
      expect.objectContaining({ rowId: 'reserved-row', field: 'key' }),
    ]));
    // A malformed record key blocks contextual refinement in Zod. Fix it and test the mode error separately.
    const corrected = { ...draft, agents: [{ ...draft.agents[0]!, params: agent.params }] };
    expect(validateAgentsDraft(corrected)).toEqual(expect.arrayContaining([expect.objectContaining({ agentId: 'codex', field: 'start' }), expect.objectContaining({ field: 'env' })]));
    expect(writeAgentsDraft(draft).ok).toBe(false);
  });

  it('defers errors derived from unreadable candidate values while retaining independent errors', () => {
    const agent = { ...newAgentDraft('claude', 'claude', 'claude'), without: { 'claude-fable-5-1': ['effort'] } };
    const candidates = (model: string, effort = 'high, low') => ({ ...agent, params: agent.params.map(row =>
      row.key === 'model' ? { ...row, values: model } : row.key === 'effort' ? { ...row, values: effort } : row) });
    const draft = (edited: typeof agent): AgentsDraft => ({ source: '{}', agents: [edited] });
    const unreadable = candidates('opus,,claude-fable-5-1', 'high,,low');
    const issues = validateAgentsDraft(draft(unreadable));
    expect(issues).toHaveLength(2);
    for (const row of unreadable.params.filter(row => row.key === 'model' || row.key === 'effort'))
      expect(issues).toContainEqual(expect.objectContaining({ rowId: row.id, field: 'values' }));
    expect(writeAgentsDraft(draft(unreadable)).ok).toBe(false);
    const independent = { ...unreadable, options: { base, start: '[', resume: AGENT_ADAPTERS.claude.options.resume } };
    expect(validateAgentsDraft(draft(independent))).toContainEqual(expect.objectContaining({ field: 'start' }));
    expect(validateAgentsDraft(draft(candidates('opus, claude-fable-5-1')))).toEqual([]);
    for (const effort of ['high, low', 'high,,low'])
      expect(validateAgentsDraft(draft(candidates('opus', effort)))).toContainEqual(expect.objectContaining({ field: 'without' }));
  });

  it('refuses duplicate rows/names and maps invalid profile names without silently overwriting input', () => {
    const agent = newAgentDraft('codex', 'codex', 'codex');
    expect(validateAgentsDraft({ source: '{}', agents: [{ ...agent, params: [...agent.params, { id: 'duplicate', key: 'model', values: 'another' }] }] }))
      .toContainEqual(expect.objectContaining({ rowId: 'duplicate', field: 'key' }));
    expect(validateAgentsDraft({ source: '{}', agents: [agent, { ...agent, id: 'another' }] }))
      .toContainEqual(expect.objectContaining({ agentId: 'another', field: 'name' }));
    expect(validateAgentsDraft({ source: '{}', agents: [{ ...agent, name: 'Bad name', adapter: 'codex' }] }))
      .toContainEqual(expect.objectContaining({ agentId: 'codex', field: 'name' }));
    expect(readAgentsDraft('claude: [')).toMatchObject({ ok: false });
  });

  it('restores defaults by deleting options while preserving params, without and comments', () => {
    const config = { agy: { ...defaultAgentSetting('agy'), params: { effort: ['low'] }, without: {},
      options: { base, ...AGENT_ADAPTERS.agy.options, start: `${AGENT_ADAPTERS.agy.options.start} --fixture` } } };
    const draft = value(readAgentsDraft(stringify(config)));
    const agent = draft.agents[0]!;
    const reset = resetDraftOptions(agent);
    const source = value(writeAgentsDraft({ ...draft, agents: [reset] }));
    expect(parse(source).agy).toEqual({ params: { effort: ['low'] }, without: {} });
    expect(reset.params).toEqual(agent.params); expect(reset.without).toEqual(agent.without);
    expect(reset.options).toBeUndefined(); expect(agent.options).toBeDefined();
  });

  it('retains paths for hidden without errors and references to a deleted row', () => {
    const agent = newAgentDraft('agy', 'agy', 'agy');
    const broken = { ...agent, without: { 'claude-sonnet-4-6': ['custom'] } };
    expect(validateAgentsDraft({ source: '{}', agents: [broken] })).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'without', path: ['agy', 'without', 'claude-sonnet-4-6', 0] }),
      expect.objectContaining({ field: 'key', path: ['agy', 'params', 'custom'] }),
    ]));
  });

  it('shows quoted literals with the same meaning as the launch-options AST', () => {
    for (const source of ['--label "hello world" --literal "[keep]"', '--empty ""', `--quote 'a"b'"'"'c'`, '[--label "two words" --value {model}]']) {
      const ast = parseLaunchOptions(source);
      const preview = ast.map(node => node.kind === 'word' ? node.parts.map(optionPartText).join('')
        : '[' + node.words.map(word => word.parts.map(optionPartText).join('')).join(' ') + ']').join(' ');
      expect(parseLaunchOptions(preview)).toEqual(ast);
    }
  });

  it('uses the contract base for new edits, detects changed defaults, and never saves a missing base', () => {
    const agent = newAgentDraft('claude', 'claude', 'claude');
    const version = agentOptionsVersion(agent);
    const opened = beginDraftOptionsEdit(agent, version.base);
    expect(parse(value(writeAgentsDraft({ source: '{}', agents: [opened] }))).claude).toEqual({});
    const edited = updateDraftOptions(opened, { ...opened.options!, start: opened.options!.start + ' --fixture' });
    expect(parse(value(writeAgentsDraft({ source: '{}', agents: [edited] }))).claude.options.base).toBe(optionsBase('claude'));
    expect(agentOptionsVersion(edited).changed).toBe(false);
    expect(agentOptionsVersion({ ...edited, options: { ...edited.options!, base: '0'.repeat(64) } }).changed).toBe(true);
    const pending = beginDraftOptionsEdit(agent);
    expect(writeAgentsDraft({ source: '{}', agents: [pending] })).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ field: 'base' })]) });
    expect(writeAgentsDraft({ source: '{}', agents: [resetDraftOptions(pending)] }).ok).toBe(true);
  });

  it('picks the first agent by moving it to the top, keeping the others in order and disabled ones disabled', () => {
    const agents = [
      { ...newAgentDraft('grok', 'grok', 'off'), enabled: false },
      newAgentDraft('claude', 'claude', 'first'), newAgentDraft('codex', 'codex', 'last'),
    ];
    expect(firstEnabledAgent(agents)).toBe('first');
    const next = withFirstAgent(agents, 'last');
    expect(next.map(agent => agent.id)).toEqual(['last', 'off', 'first']);
    expect(firstEnabledAgent(next)).toBe('last');
    expect(next.find(agent => agent.id === 'off')!.enabled).toBe(false);
    expect(agents.map(agent => agent.id)).toEqual(['off', 'first', 'last']);
  });
});
