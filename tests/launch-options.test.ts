import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseLaunchOptions, resolveLaunchOptions, optionReferences, completeOptionReferences,
  missingOptionParams, InvalidLaunchOptions, MissingOptionValue } from '@alpacawork/contract/launch-options';
const resolve = (source: string, values: Record<string, string | null> = {}, system = {}) =>
  resolveLaunchOptions(parseLaunchOptions(source), values, system);

test('grammar: whitespace, quote fragments, empty quotes, quoted brackets and literal backslashes', () => {
  assert.deepEqual(resolve(`  "a b"c 'a"b' '' "" "[literal]" ']' C:\\temp a\\ b\tc\nd `),
    ['a bc', 'a"b', '', '', '[literal]', ']', 'C:\\temp', 'a\\', 'b', 'c', 'd']);
  assert.deepEqual(resolve(`'a'"b"c ''d [plain 'two words']`), ['abc', 'd', 'plain', 'two words']);
  assert.deepEqual(resolve(''), []);
});
for (const source of [`"unclosed`, `'unclosed`, '[unclosed', 'stray ]', '[[nested]]', '{bad-name}', '{}', '{unfinished', '}'])
  test(`reject invalid grammar: ${source}`, () => assert.throws(() => parseLaunchOptions(source), InvalidLaunchOptions));

test('group omission: one missing variable omits every flag and argument in the group', () => {
  assert.deepEqual(resolve('before [--pair {model} {effort} after] end', { model: 'm', effort: null }), ['before', 'end']);
  assert.deepEqual(resolve('[--pair {model} {effort}]', { model: 'm' }), []);
  assert.deepEqual(resolve('[--pair {model} {effort}]', { model: 'm', effort: 'high' }), ['--pair', 'm', 'high']);
  assert.deepEqual(resolve('[--result {result}]', {}, {}), []);
});
test('an unconditional reference is required even when it also occurs inside a group', () => {
  const ast = parseLaunchOptions('[--optional {model}] {model} --out {result}');
  assert.deepEqual([...optionReferences(ast).required], ['model']);
  assert.deepEqual([...optionReferences(ast).system], ['result']);
  assert.throws(() => resolveLaunchOptions(ast, { model: null }, { result: '/tmp/synthetic-result' }), MissingOptionValue);
  assert.throws(() => resolve('{result}'), (e: unknown) => e instanceof MissingOptionValue && e.source === 'system');
});
test('single substitution: selected values containing {session} remain literal, system values stay distinct', () => {
  const values = { model: 'a {session} $HOME $(echo NO) `echo NO` ; *' };
  const result = resolve('-m {model} --session {session} "pre{model}post"', values, { session: 'synthetic-session' });
  assert.deepEqual(result, ['-m', values.model, '--session', 'synthetic-session', `pre${values.model}post`]);
  // Exercise the consumer boundary: an actual process receives exactly these arguments, without a shell.
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...result], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.deepEqual(JSON.parse(child.stdout), result);
  assert.deepEqual(resolve('{session}', { session: 'untrusted' }, { session: 'system' }), ['system']);
});
test('replacement values are never tokenized, and cannot create groups or options', () => {
  assert.deepEqual(resolve('[--model {model}] tail', { model: 'a b [--flag] "quote" \\path' }),
    ['--model', 'a b [--flag] "quote" \\path', 'tail']);
  assert.deepEqual(resolve('"{model}"', { model: ' ' }), [' ']);
});
test('draft complete references: shared lexer tolerates unfinished input without inventing rows', () => {
  assert.deepEqual(completeOptionReferences('[-c {verbosity}] {session} {verbosity} {permission} {not_done', '"{temperature}'),
    ['verbosity', 'session', 'permission', 'temperature']);
  assert.deepEqual(missingOptionParams({ verbosity: ['low'] }, '{verbosity} {session} {permission} {new_key} {bad-name} {'), ['new_key']);
  assert.deepEqual(missingOptionParams({ preserved: ['value'] }, ''), []);
});

test('prepared argv keeps original references until systems are known; quote/group syntax is not parsed again', async () => {
  const { prepareLaunchOptions, resolveLaunchArgv } = await import('@alpacawork/contract/launch-options');
  const values = { model: '{session} with spaces' };
  const ast = parseLaunchOptions('"[literal]" "" [--model {model}] [--session {session}] --out {result}');
  const argv = prepareLaunchOptions(ast, values, ['result']);
  assert.deepEqual(argv, ['[literal]', '', '--model', '{model}', '--out', '{result}']);
  assert.deepEqual(resolveLaunchArgv(argv, values, { result: 'out {model}' }), ['[literal]', '', '--model', '{session} with spaces', '--out', 'out {model}']);
  assert.throws(() => prepareLaunchOptions(parseLaunchOptions('{session}'), {}, []), MissingOptionValue);
});
