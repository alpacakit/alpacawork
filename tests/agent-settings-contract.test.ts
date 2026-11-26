import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, defaultParamKeys } from '@alpacawork/contract/agent-adapters';
import { defaultAgentSetting, compileAgentSetting, agentSettingSchemaFor, agentSettingsSchema, parseParamValues,
  selectionSchema, type AgentSetting } from '@alpacawork/contract/agent-settings';
import { resolveAgentSelection, SelectionRequired, InvalidAgentSelection, AgentUnavailable, agentChoices } from '@alpacawork/contract/agent-selection';
import { resolveLaunchOptions, resolveLaunchArgv } from '@alpacawork/contract/launch-options';
import { agentLaunchSchema, agentInvocationSchema, coordinatorRestartSchema } from '@alpacawork/contract/agent-launch';
const modelsWithOptionalEffort = {
  ...defaultAgentSetting('grok'),
  params: { model: ['model-with-effort', 'fixed-model'], effort: ['high', 'low', 'medium'] },
  without: { 'fixed-model': ['effort'] },
};
const edited = (params: Record<string, string[]>, start: string, resume = start): AgentSetting =>
  ({ params: { model: [], ...params }, options: { base: 'a'.repeat(64), start, resume } });
function paths(profile: string, input: unknown): string[] {
  const result = agentSettingSchemaFor(profile).safeParse(input);
  assert.equal(result.success, false);
  return result.error!.issues.map(issue => issue.path.join('.'));
}
for (const id of BUILTIN_ADAPTER_IDS) test(`adapter ${id}: valid detached initial setting, fixed prefix/env, complete defaults`, () => {
  const initial = defaultAgentSetting(id); const adapter = AGENT_ADAPTERS[id];
  const compiled = compileAgentSetting(id, initial); const resolved = resolveAgentSelection(compiled);
  assert.deepEqual(Object.keys(initial.params), defaultParamKeys(id));
  assert.deepEqual(adapter.prefix, id === 'claude' ? ['claude'] : ['alpacawork-agent', id]);
  assert.match(adapter.referenceUrl, /^https:\/\//);
  assert.ok(!initial.env?.some(name => adapter.fixedEnv.includes(name)));
  for (const mode of ['start', 'resume'] as const) {
    const argv = resolveLaunchOptions(compiled.options[mode], resolved.effective, { session: 'synthetic-session', result: '/tmp/synthetic-result' });
    assert.ok(argv.length > 0); assert.ok(!argv.includes('-'));
  }
  initial.params.extra = ['x']; assert.equal(Object.hasOwn(compiled.setting.params, 'extra'), false);
});
test('omitted settings follow the adapter, explicit lists replace defaults, and exclusions apply only to optional choices', () => {
  const codex = agentSettingSchemaFor('codex').parse({});
  assert.deepEqual(codex.params, { model: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6-luna'],
    effort: ['high', 'low', 'medium', 'xhigh', 'max', 'ultra'], fast: ['-', 'fast'] });
  assert.deepEqual(codex.env, ['OPENAI_API_KEY']);
  assert.deepEqual(agentSettingSchemaFor('codex').parse({ params: { model: ['custom-model'] } }).params,
    { ...codex.params, model: ['custom-model'] });
  const claude = agentSettingSchemaFor('claude').parse({});
  assert.deepEqual(claude.params.model, ['opus', 'fable', 'sonnet', 'haiku']);
  assert.equal(Object.hasOwn(claude.params, 'fast'), false);
  assert.deepEqual(AGENT_ADAPTERS.claude.fixedEnv, ['CLAUDE_CONFIG_DIR']);
  assert.deepEqual(AGENT_ADAPTERS.codex.fixedEnv, ['CODEX_HOME']);
  assert.deepEqual(AGENT_ADAPTERS.grok.fixedEnv, ['GROK_HOME']);

  const schema = agentSettingSchemaFor('grok-alias');
  const { params, without } = modelsWithOptionalEffort;
  const configured = schema.parse({ adapter: 'grok', params, without });
  assert.deepEqual(configured.without, without);
  const blank = schema.parse({ adapter: 'grok', params: { model: [] }, env: [], without: {} });
  assert.deepEqual([blank.params.model, blank.env, blank.without], [[], [], {}]);
  const required = { ...edited(params, '[--model {model}] --effort {effort}'), adapter: 'grok' as const };
  assert.deepEqual(schema.parse(required).without, {});
  assert.equal(schema.safeParse({ ...required, without }).success, false);
});
test('param overrides keep adapter order and append custom keys in written order', () => {
  const setting = agentSettingSchemaFor('codex').parse({ params: { zebra: ['one'], effort: ['high', 'low'], alpha: ['two'] } });
  assert.deepEqual(Object.keys(setting.params), ['model', 'effort', 'fast', 'zebra', 'alpha']);
  assert.deepEqual(setting.params.effort, ['high', 'low']);
});
test('comma input trims at boundary; blank whole input means no candidates', () => {
  assert.deepEqual(parseParamValues('  high, low , medium '), ['high', 'low', 'medium']);
  assert.deepEqual(parseParamValues(' \n '), []); assert.deepEqual(parseParamValues('-, fast'), ['-', 'fast']);
  assert.deepEqual(parseParamValues('"a,b"'), ['"a', 'b"']); // quotes have no CSV meaning
});
for (const value of ['a,,b', ',a', 'a,', 'a,a', 'a,-', '-,-'])
  test(`comma input rejects empty/duplicate/misplaced unspecified/CSV extension: ${value}`, () => assert.throws(() => parseParamValues(value)));

test('strict schema rejects old DSL and accepts empty initial rows, disabled profiles and aliases', () => {
  assert.equal(agentSettingsSchema.safeParse({ 'claude-alias': { ...defaultAgentSetting('claude'), adapter: 'claude', enabled: false } }).success, true);
  assert.equal(agentSettingsSchema.safeParse({ codex: { params: { model: [], effort: [], fast: [] }, enabled: false } }).success, true);
  assert.ok(paths('alias', { params: {} }).includes('adapter'));
  assert.equal(agentSettingsSchema.safeParse({ alias: { adapter: 'unknown', params: {} } }).success, false);
  for (const name of ['start', 'resume', 'input', 'read', 'permission', 'choices', 'model'])
    assert.ok(paths('claude', { ...defaultAgentSetting('claude'), [name]: [] }).some(path => path === ''));
});
test('reserved names and malformed candidates have a path, not silent cleanup', () => {
  for (const name of ['session', 'result', 'input', 'permission', 'adapter', 'params', 'base', 'env', 'bad-key', 'trailing\n'])
    assert.ok(paths('copilot', { params: { [name]: ['v'] } }).some(path => path.startsWith('params')));
  assert.ok(paths('copilot', { params: { extra: ['x', 'x'] } }).includes('params.extra.1'));
  assert.ok(paths('copilot', { params: { extra: ['x', '-'] } }).includes('params.extra.1'));
  assert.ok(paths('copilot', { params: { extra: [' '] } }).includes('params.extra.0'));
});
test('required references across both modes reject empty/default-null and unknown variables', () => {
  assert.ok(paths('copilot', edited({ extra: [] }, '[{extra}]', '{extra}')).includes('params.extra'));
  assert.ok(paths('copilot', edited({ extra: ['-', 'x'] }, '{extra}')).includes('params.extra'));
  assert.ok(paths('copilot', edited({}, '{unknown}')).includes('options.start'));
  assert.ok(paths('copilot', edited({}, '{permission}')).includes('options.start'));
  assert.ok(paths('copilot', edited({}, '[unclosed')).includes('options.start'));
  assert.equal(agentSettingSchemaFor('copilot').safeParse(edited({ extra: [] }, '[{extra}]')).success, true);
});
test('without rejects missing model/row, required/unused row and duplicate keys at exact paths', () => {
  const params = { model: ['m'], effort: ['high'] };
  const value = { ...edited(params, '[{model}] {effort}'), without: { m: ['effort'] } };
  assert.ok(paths('copilot', value).includes('without.m.0'));
  assert.ok(paths('copilot', { ...value, without: { unknown: ['effort'] } }).includes('without.unknown'));
  assert.ok(paths('copilot', { ...value, without: { m: ['deleted'] } }).includes('without.m.0'));
  assert.ok(paths('copilot', { ...edited(params, '[{model}]'), without: { m: ['effort'] } }).includes('without.m.0'));
  assert.ok(paths('copilot', { ...edited(params, '[{model}] [{effort}]'), without: { m: ['effort', 'effort'] } }).includes('without.m.1'));
  assert.ok(paths('copilot', { ...edited(params, '[{model}]'), without: { m: ['model'] } }).includes('without.m.0'));
});
test('env permits additional names, rejects fixed/basic/internal names and values with paths', () => {
  for (const name of ['CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'ALPACAWORK_RUN', 'PEPE_TEST', 'NODE_OPTIONS', 'LC_ALL', 'KEY\n'])
    assert.ok(paths('claude', { ...defaultAgentSetting('claude'), env: [name] }).includes('env.0'));
  assert.ok(paths('claude', { ...defaultAgentSetting('claude'), env: ['KEY', 'KEY'] }).includes('env.1'));
  assert.ok(paths('claude', { ...defaultAgentSetting('claude'), env: ['KEY=secret'] }).includes('env.0'));
  assert.equal(agentSettingSchemaFor('claude').safeParse({ ...defaultAgentSetting('claude'), env: ['MY_KEY'] }).success, true);
  const result = agentSettingsSchema.safeParse({ alias: { ...defaultAgentSetting('claude'), adapter: 'claude', env: ['CLAUDE_CONFIG_DIR'] } });
  assert.equal(result.success, false); assert.deepEqual(result.error!.issues[0]!.path, ['alias', 'env', 0]);
});
test('selections distinguish omission/null, reject empty/-/reserved input, and offer only the written values', () => {
  assert.equal(selectionSchema.safeParse({ effort: null }).success, true);
  for (const value of [{ effort: '' }, { effort: '-' }, { effort: ' ' }, { permission: 'x' }]) assert.equal(selectionSchema.safeParse(value).success, false);
  const compiled = compileAgentSetting('codex', defaultAgentSetting('codex'));
  assert.deepEqual(agentChoices(compiled).find(choice => choice.key === 'effort')!.candidates, ['high', 'low', 'medium', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(agentChoices(compiled).find(choice => choice.key === 'fast')!.candidates, [null, 'fast']);
  assert.equal(resolveAgentSelection(compiled).values.fast, null);
  const claude = agentChoices(compileAgentSetting('claude', defaultAgentSetting('claude')));
  assert.deepEqual(claude.map(choice => [choice.key, choice.candidates.includes(null)]), [['model', false], ['effort', false]]);
  assert.deepEqual(agentChoices(compileAgentSetting('copilot', defaultAgentSetting('copilot'))).map(choice => choice.candidates), [[null]]);
});
test('explicit → previous → new-key default, including explicit and previous null on a - row', () => {
  const compiled = compileAgentSetting('codex', defaultAgentSetting('codex'));
  assert.deepEqual(resolveAgentSelection(compiled, { model: 'gpt-6.2-astra', fast: null }, { model: 'gpt-6.2-sol', effort: 'medium', fast: 'fast' }).values,
    { model: 'gpt-6.2-astra', effort: 'medium', fast: null });
  assert.equal(resolveAgentSelection(compiled, {}, { fast: null }).values.fast, null);
  assert.throws(() => resolveAgentSelection(compiled, { effort: null }), InvalidAgentSelection);
  assert.equal(resolveAgentSelection(compiled, { effort: 'low' }, { effort: 'deleted' }).values.effort, 'low');
  assert.throws(() => resolveAgentSelection(compiled, { effort: 'unknown' }), InvalidAgentSelection);
  assert.throws(() => resolveAgentSelection(compiled, { effort: '' }), InvalidAgentSelection);
});
test('disappeared previous values: reject rather than replace with the current default', () => {
  const compiled = compileAgentSetting('codex', defaultAgentSetting('codex'));
  assert.throws(() => resolveAgentSelection(compiled, {}, { effort: 'old-effort' }), (error: unknown) => {
    assert.ok(error instanceof SelectionRequired); assert.equal(error.code, 'selection_required');
    assert.deepEqual(error.problems, [{ key: 'effort', previous: 'old-effort', candidates: ['high', 'low', 'medium', 'xhigh', 'max', 'ultra'], reason: 'invalid_value', recovery: 'select_value' }]); return true;
  });
});
test('deleted and unused previous params remain actionable failures; previous null becomes invalid when required', () => {
  const compiled = compileAgentSetting('copilot', edited({ unused: ['x'], required: ['v'] }, '{required}'));
  for (const [previous, reason] of [[{ deleted: 'x' }, 'removed'], [{ unused: 'x' }, 'unused'], [{ required: null }, 'null_required']] as const)
    assert.throws(() => resolveAgentSelection(compiled, {}, previous), (error: unknown) => error instanceof SelectionRequired && error.problems[0]?.reason === reason);
  assert.throws(() => resolveAgentSelection(compiled, { unused: 'x' }), InvalidAgentSelection);
  assert.throws(() => resolveAgentSelection(compiled, { required: null }), InvalidAgentSelection);
});
test('without inactivity preserves valid latent values but never conceals deleted candidates', () => {
  const compiled = compileAgentSetting('grok', modelsWithOptionalEffort);
  const resolved = resolveAgentSelection(compiled, { model: 'fixed-model' }, { effort: 'medium' });
  assert.equal(resolved.values.effort, 'medium'); assert.equal(resolved.effective.effort, null);
  assert.equal(resolved.choices.find(choice => choice.key === 'effort')!.active, false);
  assert.ok(!resolveLaunchOptions(compiled.options.start, resolved.effective, { result: 'synthetic-result' }).includes('--effort'));
  assert.equal(resolveAgentSelection(compiled, { model: 'model-with-effort' }, resolved.values).effective.effort, 'medium');
  assert.throws(() => resolveAgentSelection(compiled, { model: 'fixed-model' }, { effort: 'deleted' }), SelectionRequired);
});
test('disabled admission is an explicit typed rejection', () => {
  const compiled = compileAgentSetting('copilot', { ...defaultAgentSetting('copilot'), enabled: false });
  assert.throws(() => resolveAgentSelection(compiled), AgentUnavailable);
});
test('launch shared schema retains adapter/argv/path/null values/env; restart is coordinator-only and invocation has mode', () => {
  const input = { adapter: 'codex', argv: ['alpacawork-agent', 'codex', '-o', '{result}'], path: '/synthetic/bin', values: { effort: null }, env: ['CODEX_HOME', 'MY_KEY'] };
  const launch = agentLaunchSchema.parse(input); input.argv.push('mutated'); input.env.length = 0;
  assert.deepEqual(launch.argv, ['alpacawork-agent', 'codex', '-o', '{result}']); assert.deepEqual(launch.values, { effort: null });
  assert.deepEqual(launch.env, ['CODEX_HOME', 'MY_KEY']);
  assert.equal(agentLaunchSchema.safeParse({ ...launch, restartArgv: [] }).success, false);
  assert.equal(agentInvocationSchema.safeParse({ mode: 'resume', launch }).success, true);
  assert.equal(agentInvocationSchema.safeParse({ mode: 'start', launch, restartArgv: ['x'] }).success, false);
  assert.equal(agentInvocationSchema.safeParse({ mode: 'unknown', launch }).success, false);
  assert.equal(coordinatorRestartSchema.safeParse({ restartArgv: null }).success, true);
  assert.deepEqual(coordinatorRestartSchema.parse({ restartArgv: ['alpacawork-agent', 'codex'] }).restartArgv, ['alpacawork-agent', 'codex']);
  assert.equal(agentLaunchSchema.safeParse({ ...launch, input: {} }).success, false);
});

test('admission snapshot freezes prefix, values and fixed+extra env; later config changes cannot alter execution', async () => {
  const { prepareAgentLaunch, ConversationAdapterMismatch } = await import('@alpacawork/contract/agent-launch');
  const { resolveLaunchArgv } = await import('@alpacawork/contract/launch-options');
  const setting = defaultAgentSetting('codex'); setting.params.model = ['synthetic {session} with spaces']; setting.env = ['SYNTHETIC_KEY'];
  const compiled = compileAgentSetting('codex', setting);
  const { launch } = prepareAgentLaunch(compiled, { mode: 'resume', path: '/synthetic/bin', explicit: { effort: 'low' }, previous: { adapter: 'codex', values: {} } });
  setting.enabled = false; setting.params.model = ['replacement']; setting.env = [];
  compiled.setting.params.model = ['also-replaced']; compiled.setting.env = ['OTHER_KEY'];
  assert.deepEqual(launch.values, { model: 'synthetic {session} with spaces', effort: 'low', fast: null });
  assert.deepEqual(launch.env, ['CODEX_HOME', 'SYNTHETIC_KEY']);
  assert.deepEqual(launch.argv.slice(0, 2), ['alpacawork-agent', 'codex']);
  assert.ok(!launch.argv.some(word => word.startsWith('service_tier')));
  const argv = resolveLaunchArgv(launch.argv, launch.values, { session: 'real-synthetic-session', result: '/tmp/synthetic-result' });
  assert.equal(argv[argv.indexOf('-m') + 1], 'synthetic {session} with spaces'); assert.equal(argv.at(-1), 'real-synthetic-session');
  assert.throws(() => prepareAgentLaunch(compiled, { mode: 'resume', path: 'x',
    previous: { adapter: 'claude', values: {} } }), ConversationAdapterMismatch);
});
test('admission retains without values but removes their whole argument group before freezing', async () => {
  const { prepareAgentLaunch } = await import('@alpacawork/contract/agent-launch');
  const { launch } = prepareAgentLaunch(compileAgentSetting('grok', modelsWithOptionalEffort), {
    mode: 'start', path: 'synthetic-path', explicit: { model: 'fixed-model', effort: 'medium' },
  });
  assert.equal(launch.values.effort, 'medium'); assert.equal(launch.argv.includes('--effort'), false);
});

test('coordinator resume freezes a start alternative from the same values; fresh invocation mode changes without rewriting the record', async () => {
  const { prepareCoordinatorLaunch, coordinatorLaunchAdmissionSchema } = await import('@alpacawork/contract/agent-launch');
  const { resolveLaunchArgv } = await import('@alpacawork/contract/launch-options');
  const setting = defaultAgentSetting('claude'); const compiled = compileAgentSetting('claude', setting);
  const saved = prepareCoordinatorLaunch(compiled, { mode: 'resume', path: '/synthetic/bin', explicit: { effort: 'low' }, previous: { adapter: 'claude', values: {} } });
  const before = structuredClone(saved);
  assert.equal(saved.mode, 'resume'); assert.ok(saved.restartArgv?.includes('--session-id'));
  assert.ok(saved.launch.argv.includes('--resume')); assert.equal(saved.launch.values.effort, 'low');
  assert.ok(saved.launch.argv.includes('--include-partial-messages'));
  assert.ok(saved.restartArgv?.includes('--include-partial-messages'));
  const fresh = agentInvocationSchema.parse({ mode: 'start', launch: { ...saved.launch, argv: saved.restartArgv } });
  assert.ok(resolveLaunchArgv(fresh.launch.argv, fresh.launch.values, { session: 'new-synthetic-session' }).includes('new-synthetic-session'));
  assert.deepEqual(saved, before);
  assert.equal(prepareCoordinatorLaunch(compiled, { mode: 'start', path: 'x' }).restartArgv, null);
  assert.equal(coordinatorLaunchAdmissionSchema.safeParse({ ...saved, restartArgv: null }).success, false);
  assert.equal(agentInvocationSchema.safeParse(saved).success, false);
});

test('candidate names that also exist on Object.prototype are ordinary values, never inherited without rules', () => {
  const compiled = compileAgentSetting('copilot', edited({ model: ['constructor', 'toString'], constructor: ['v'] }, '[{model}] [{constructor}]'));
  assert.deepEqual(resolveAgentSelection(compiled).values, { model: 'constructor', constructor: 'v' });
  assert.equal(resolveAgentSelection(compiled, { model: 'toString' }).effective.constructor, 'v');
});


test('pi keeps provider/model as one value, off as an ordinary value, and adapter-owned session environments', async () => {
  const { prepareAgentLaunch } = await import('@alpacawork/contract/agent-launch');
  const setting = defaultAgentSetting('pi');
  setting.params.model = ['openrouter/openai/synthetic-model'];
  const compiled = compileAgentSetting('pi', setting);
  const explicit = prepareAgentLaunch(compiled, { mode: 'start', path: '/synthetic/bin', explicit: { effort: 'off' } });
  const argv = resolveLaunchArgv(explicit.launch.argv, explicit.launch.values, { session: 'synthetic-session', result: '/synthetic/result' });
  assert.equal(explicit.launch.values.model, 'openrouter/openai/synthetic-model');
  assert.ok(argv.includes('openrouter/openai/synthetic-model'));
  assert.ok(argv.includes('off')); assert.equal(explicit.launch.values.effort, 'off');
  assert.throws(() => prepareAgentLaunch(compiled, { mode: 'start', path: '/synthetic/bin', explicit: { effort: null } }), InvalidAgentSelection);
  assert.deepEqual(explicit.launch.env, ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR']);
  assert.ok(paths('pi', { ...setting, env: ['PI_CODING_AGENT_DIR'] }).includes('env.0'));
});
