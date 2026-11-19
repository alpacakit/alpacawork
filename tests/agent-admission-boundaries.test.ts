import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, type AdapterDescription } from '@alpacawork/contract/agent-adapters';
import { SYSTEM_VARIABLE_NAMES } from '@alpacawork/contract/agent-variables';
import { defaultAgentSetting, compileAgentSetting, agentSettingSchemaFor, agentSettingsSchema, type AgentSetting } from '@alpacawork/contract/agent-settings';
import { prepareAgentLaunch, prepareCoordinatorLaunch, InvalidLaunchAdmission, ConversationAdapterMismatch,
  agentLaunchSchema, agentInvocationSchema, type LaunchAdmission } from '@alpacawork/contract/agent-launch';
import { resolveAgentSelection, SelectionRequired, InvalidAgentSelection, type SelectionProblem } from '@alpacawork/contract/agent-selection';
import { parseLaunchOptions, resolveLaunchOptions, resolveLaunchArgv, MissingOptionValue, InvalidLaunchOptions } from '@alpacawork/contract/launch-options';
const path = '/synthetic/bin';
const edited = (params: Record<string, string[]>, start: string, resume = start): AgentSetting =>
  ({ params: { model: [], ...params }, options: { base: 'a'.repeat(64), start, resume } });
const compiledCodex = () => compileAgentSetting('codex', defaultAgentSetting('codex'));
const problem = (call: () => unknown): SelectionProblem => {
  let result: SelectionProblem | undefined;
  assert.throws(call, (error: unknown) => {
    assert.ok(error instanceof SelectionRequired); assert.equal(error.code, 'selection_required');
    assert.equal(error.problems.length, 1); result = error.problems[0]; return true;
  });
  return result!;
};

// Compiled by quick's Node typecheck, never executed: mode/history and supply coverage are type contracts too.
function admissionTypeContract(accept: (input: LaunchAdmission) => void): void {
  // @ts-expect-error resume must identify its previous adapter and values
  accept({ mode: 'resume', path });
  // @ts-expect-error start cannot carry a previous conversation, including via a non-literal variable
  accept({ mode: 'start', path, previous: { adapter: 'codex', values: {} } });
  const mixed = { mode: 'start' as const, path, previous: { adapter: 'codex' as const, values: {} } };
  // @ts-expect-error structural extra previous is also forbidden
  accept(mixed);
  // @ts-expect-error system availability is derived from adapter, not admission input
  accept({ mode: 'start', path, availableSystem: ['session'] });
  // @ts-expect-error every adapter declares both modes
  const incomplete: AdapterDescription['system'] = { start: ['result'] };
  // @ts-expect-error only the shared system namespace may be supplied
  const unknown: AdapterDescription['system'] = { start: ['permission'], resume: [] };
  void incomplete; void unknown;
}
void admissionTypeContract;

for (const [name, prepare] of [['agent', prepareAgentLaunch], ['coordinator', prepareCoordinatorLaunch]] as const) {
  test(`resume history required (${name}): JS omission and incomplete previous are code-bearing rejections`, () => {
    const compiled = compiledCodex();
    for (const input of [
      { mode: 'resume', path }, { mode: 'resume', path, previous: undefined }, { mode: 'resume', path, previous: null },
      { mode: 'resume', path, previous: {} }, { mode: 'resume', path, previous: { adapter: 'codex' } },
      { mode: 'resume', path, previous: { values: {} } }, { mode: 'resume', path, previous: { adapter: 'codex', values: undefined } },
    ]) assert.throws(() => prepare(compiled, input as LaunchAdmission), (error: unknown) => {
      assert.ok(error instanceof InvalidLaunchAdmission); assert.equal(error.code, 'invalid_launch_admission');
      assert.ok(error.issues.some(issue => issue.path[0] === 'previous')); return true;
    });
  });
  test(`new conversation (${name}): reject previous, then resolve a proper start from current defaults`, () => {
    const compiled = compiledCodex();
    for (const previous of [{ adapter: 'codex', values: { effort: 'deleted' } }, null, undefined])
      assert.throws(() => prepare(compiled, { mode: 'start', path, previous } as LaunchAdmission), InvalidLaunchAdmission);
    const { launch } = prepare(compiled, { mode: 'start', path });
    assert.equal(launch.values.effort, 'high');
    assert.equal(prepare(compiled, { mode: 'start', path, explicit: { fast: null } }).launch.values.fast, null);
  });
  test(`resume (${name}): retain actual previous values/null and refuse the wrong adapter`, () => {
    const compiled = compiledCodex();
    const previous = { adapter: 'codex' as const, values: { model: 'gpt-6.2-astra', effort: 'low', fast: null } };
    assert.deepEqual(prepare(compiled, { mode: 'resume', path, previous }).launch.values, previous.values);
    assert.equal(prepare(compiled, { mode: 'resume', path, previous: { adapter: 'codex', values: { fast: null } } }).launch.values.fast, null);
    assert.throws(() => prepare(compiled, { mode: 'resume', path, previous: { adapter: 'claude', values: {} } }),
      (error: unknown) => error instanceof ConversationAdapterMismatch && error.code === 'new_conversation_required');
  });
  test(`admission (${name}): reject caller system overrides and invalid mode instead of using a fallback`, () => {
    const compiled = compiledCodex();
    for (const input of [{ mode: 'start', path, availableSystem: ['prompt'] }, { mode: 'unexpected', path }, null])
      assert.throws(() => prepare(compiled, input as LaunchAdmission), InvalidLaunchAdmission);
  });
}

test('coordinator restart uses the accepted resume values and start declaration without readmitting history as a new start', () => {
  const compiled = compileAgentSetting('claude', defaultAgentSetting('claude'));
  const saved = prepareCoordinatorLaunch(compiled, { mode: 'resume', path, previous: { adapter: 'claude', values: { effort: 'low' } } });
  const before = structuredClone(saved);
  assert.ok(saved.restartArgv); assert.ok(saved.restartArgv.includes('--session-id')); assert.ok(!saved.restartArgv.includes('--resume'));
  const fresh = agentInvocationSchema.parse({ mode: 'start', launch: { ...saved.launch, argv: saved.restartArgv } });
  const argv = resolveLaunchArgv(fresh.launch.argv, fresh.launch.values, { session: 'fresh-synthetic-session' });
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low'); assert.ok(argv.includes('fresh-synthetic-session'));
  assert.deepEqual(saved, before);
  assert.equal(prepareCoordinatorLaunch(compiled, { mode: 'start', path }).launch.values.effort, 'medium');
});

for (const reason of ['removed', 'unused'] as const) for (const value of ['x', null])
  test(`recovery ${reason}, previous=${value}: new conversation required; null is not permission to delete history`, () => {
    const compiled = compileAgentSetting('copilot', edited(reason === 'removed' ? {} : { extra: ['x'] }, 'literal'));
    const previous = { adapter: 'copilot' as const, values: { extra: value } };
    const issue = problem(() => prepareAgentLaunch(compiled, { mode: 'resume', path, previous }));
    assert.deepEqual(issue, { key: 'extra', previous: value, candidates: [], reason, recovery: 'new_conversation' });
    assert.throws(() => prepareAgentLaunch(compiled, { mode: 'resume', path, previous, explicit: { extra: null } }), InvalidAgentSelection);
    const fresh = prepareAgentLaunch(compiled, { mode: 'start', path });
    assert.deepEqual(fresh.launch.values, {}); assert.deepEqual(fresh.launch.argv, ['alpacawork-agent', 'copilot', 'literal']);
  });
for (const [old, reason] of [['gone', 'invalid_value'], [null, 'null_required']] as const)
  test(`recovery ${reason}: caller can select an existing value and resume`, () => {
    const compiled = compileAgentSetting('copilot', edited({ extra: ['x'] }, '--extra {extra}'));
    const previous = { adapter: 'copilot' as const, values: { extra: old } };
    const issue = problem(() => prepareAgentLaunch(compiled, { mode: 'resume', path, previous }));
    assert.deepEqual(issue, { key: 'extra', previous: old, candidates: ['x'], reason, recovery: 'select_value' });
    assert.equal(prepareAgentLaunch(compiled, { mode: 'resume', path, previous, explicit: { extra: 'x' } }).launch.values.extra, 'x');
  });

for (const id of BUILTIN_ADAPTER_IDS) for (const mode of ['start', 'resume'] as const)
  test(`system supply ${id}/${mode}: contextual save validation and admission share the declared namespace`, () => {
    const expected = id === 'claude' ? ['session'] : mode === 'start' ? ['result'] : ['result', 'session'];
    assert.deepEqual(AGENT_ADAPTERS[id].system[mode], expected);
    for (const variable of SYSTEM_VARIABLE_NAMES) for (const grouped of [false, true]) {
      const setting = defaultAgentSetting(id);
      setting.options = { base: 'b'.repeat(64), ...AGENT_ADAPTERS[id].options, [mode]: grouped ? `[--x {${variable}}]` : `--x {${variable}}` };
      const validated = agentSettingSchemaFor(id).safeParse(setting);
      if (!expected.includes(variable)) {
        assert.equal(validated.success, false, `${id}/${mode} must reject ${variable}`);
        assert.ok(validated.error!.issues.some(issue => issue.path.join('.') === `options.${mode}` && issue.message.includes(variable)));
      } else {
        assert.equal(validated.success, true);
        const compiled = compileAgentSetting(id, setting);
        const admission: LaunchAdmission = mode === 'start' ? { mode, path } :
          { mode, path, previous: { adapter: id, values: resolveAgentSelection(compiled).values } };
        const { launch } = prepareAgentLaunch(compiled, admission);
        assert.ok(launch.argv.includes(`{${variable}}`), 'admission must retain a supplied optional system reference');
        const argv = resolveLaunchArgv(launch.argv, launch.values, { session: 'synthetic-session', result: 'synthetic-result' });
        assert.ok(argv.includes(`synthetic-${variable}`));
      }
    }
  });
test('system supply validation does not require protocol flags or session/result references in edited options', () => {
  for (const id of BUILTIN_ADAPTER_IDS) {
    const setting = defaultAgentSetting(id);
    // Retain optional params used by hidden without; remove only system/protocol references.
    const source = Object.keys(setting.params).map(key => `[{${key}}]`).join(' ');
    setting.options = { base: 'b'.repeat(64), start: source, resume: source };
    assert.equal(agentSettingSchemaFor(id).safeParse(setting).success, true);
    const compiled = compileAgentSetting(id, setting);
    const fresh = prepareAgentLaunch(compiled, { mode: 'start', path }).launch;
    const resumed = prepareAgentLaunch(compiled, { mode: 'resume', path, previous: { adapter: id, values: fresh.values } }).launch;
    for (const launch of [fresh, resumed]) {
      assert.ok(!launch.argv.includes('{session}')); assert.ok(!launch.argv.includes('{result}'));
      assert.doesNotThrow(() => resolveLaunchArgv(launch.argv, launch.values, {}));
    }
  }
});
test('boundary parser/missing-value errors expose stable codes for callers', () => {
  assert.throws(() => parseLaunchOptions('['), (e: unknown) => e instanceof InvalidLaunchOptions && e.code === 'invalid_launch_options');
  assert.throws(() => resolveLaunchOptions(parseLaunchOptions('{model}'), {}, {}),
    (e: unknown) => e instanceof MissingOptionValue && e.code === 'missing_option_value' && e.source === 'selection');
  assert.throws(() => resolveLaunchArgv(['{session}'], {}, {}),
    (e: unknown) => e instanceof MissingOptionValue && e.code === 'missing_option_value' && e.source === 'system');
});

for (const id of BUILTIN_ADAPTER_IDS) test(`internal env rejection ${id}: config and admission share the CODEX_SQLITE_HOME prohibition`, () => {
  const setting = defaultAgentSetting(id); setting.env = ['CODEX_SQLITE_HOME'];
  const saved = agentSettingSchemaFor(id).safeParse(setting);
  assert.equal(saved.success, false); assert.ok(saved.error!.issues.some(issue => issue.path.join('.') === 'env.0'));
  const compiled = compileAgentSetting(id, defaultAgentSetting(id));
  compiled.setting.env = ['CODEX_SQLITE_HOME']; // Simulate an unvalidated/mutated caller; no environment values are read.
  for (const prepare of [prepareAgentLaunch, prepareCoordinatorLaunch])
    assert.throws(() => prepare(compiled, { mode: 'start', path }), (error: unknown) =>
      error instanceof z.ZodError && error.issues.some(issue => issue.path.join('.') === `env.${AGENT_ADAPTERS[id].fixedEnv.length}`));
});
test('internal env rule also protects the shared launch shape while preserving fixed conversation env names', () => {
  const input = { adapter: 'codex', argv: ['alpacawork-agent', 'codex'], path, values: {} };
  assert.equal(agentLaunchSchema.safeParse({ ...input, env: ['CODEX_SQLITE_HOME'] }).success, false);
  assert.equal(agentLaunchSchema.safeParse({ ...input, env: ['CODEX_HOME', 'SYNTHETIC_KEY'] }).success, true);
});
for (const id of BUILTIN_ADAPTER_IDS) test(`built-in profile ${id}: reject a different adapter, allow matching adapter and explicit alias`, () => {
  const other = id === 'claude' ? 'codex' : 'claude';
  const setting = { ...defaultAgentSetting(other), adapter: other };
  const result = agentSettingSchemaFor(id).safeParse(setting);
  assert.equal(result.success, false); assert.ok(result.error!.issues.some(issue => issue.path.join('.') === 'adapter'));
  assert.equal(agentSettingSchemaFor(id).safeParse({ ...defaultAgentSetting(id), adapter: id }).success, true);
  assert.equal(agentSettingsSchema.safeParse({ 'custom-alias': setting }).success, true);
});

test('hidden without model reference keeps its old diagnostic and identifies the visible model row without deleting hidden data', () => {
  const setting = { ...defaultAgentSetting('grok'), without: { 'removed-model': ['effort'] } };
  const before = structuredClone(setting);
  const result = agentSettingsSchema.safeParse({ custom: { ...setting, adapter: 'grok' } });
  assert.equal(result.success, false);
  const paths = result.error!.issues.map(issue => issue.path.join('.'));
  assert.ok(paths.includes('custom.without.removed-model')); assert.ok(paths.includes('custom.params.model'));
  assert.deepEqual(setting, before);
});
for (const state of ['deleted', 'unused', 'required'] as const)
  test(`hidden without ${state} param: retain without path and identify the affected visible row`, () => {
    const setting = { ...edited({ model: ['m'], ...(state === 'deleted' ? {} : { extra: ['x'] }) },
      state === 'unused' ? '[{model}]' : state === 'required' ? '[{model}] {extra}' : '[{model}] [{extra}]'), without: { m: ['extra'] } };
    const before = structuredClone(setting);
    const result = agentSettingSchemaFor('copilot').safeParse(setting); assert.equal(result.success, false);
    const paths = result.error!.issues.map(issue => issue.path.join('.'));
    assert.ok(paths.includes('without.m.0')); assert.ok(paths.includes('params.extra')); assert.deepEqual(setting, before);
  });
