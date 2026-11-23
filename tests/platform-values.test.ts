/** Task value edits through the CLI and HTTP boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { area, run, cli, start, request } from './helpers/platform-http.ts';

test('task update --values-file changes only the fields sent and records each edit in the log', async () => {
  const source = join(area, 'values.json');
  const before = (await request(await start(), 'commands/task/get?task=T2&log=1000')).body.task;
  const initialVersion = (await request(await start(), 'workspace/live')).body.tasks.find((task: { id: string }) => task.id === 'T2').version;
  let expected = before.hash;
  for (const [index, [patch, values]] of ([
    [{ notes: '# New notes\n日本語 😀' }, { notes: '# New notes\n日本語 😀' }],
    [{ goal: 'Ship it' }, { notes: '# New notes\n日本語 😀', goal: 'Ship it' }],
    [{ notes: null }, { goal: 'Ship it' }],
  ] as const).entries()) {
    writeFileSync(source, JSON.stringify(patch));
    const saved = await cli('task', 'update', '--task', 'T2', '--values-file', source, '--expected-task-hash', expected);
    assert.deepEqual(saved.task.values, values);
    assert.equal(saved.task.version, initialVersion + index + 1);
    const log = (await request(await start(), 'commands/task/get?task=T2&log=1000')).body.task.log;
    assert.deepEqual(log.slice(0, before.log.length), before.log);
    assert.equal(log.length, before.log.length + index + 1);
    assert.deepEqual([log.at(-1)?.kind, log.at(-1)?.actor, log.at(-1)?.changedFields], ['body_updated', { kind: 'human' }, ['values']]);
    assert.deepEqual((await cli('task', 'get', '--task', 'T2')).task.values, values);
    expected = saved.task.hash;
  }
  writeFileSync(source, JSON.stringify({ conclusion: 'With a title' }));
  const both = await cli('task', 'update', '--task', 'T2', '--title', 'Retitled', '--values-file', source, '--expected-task-hash', expected);
  assert.deepEqual([both.task.title, both.task.values], ['Retitled', { goal: 'Ship it', conclusion: 'With a title' }]);
  assert.deepEqual((await request(await start(), 'commands/task/get?task=T2&log=1000')).body.task.log.slice(-2).map((entry: { kind: string }) => entry.kind),
    ['retitled', 'body_updated']);
});

test('task update --values-file refuses a stale hash, an unknown Task and unreadable or non-JSON files without writing', async () => {
  const source = join(area, 'values.json');
  const before = (await cli('task', 'get', '--task', 'T2')).task;
  writeFileSync(source, JSON.stringify({ notes: 'New' }));
  const reject = async (args: string[], code = 'invalid_input') => {
    const result = await run(['task', 'update', ...args, '--op-id', `reject-${args.join('-').length}`]);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, code);
    return result;
  };
  await reject(['--task', 'T2', '--values-file', source, '--expected-task-hash', '0'.repeat(64)], 'conflict');
  await reject(['--task', 'T999', '--values-file', source, '--expected-task-hash', before.hash], 'not_found');
  const args = ['--task', 'T2', '--values-file', source, '--expected-task-hash', before.hash];
  writeFileSync(source, Buffer.from([0xff, 0xfe]));
  assert.match((await reject(args)).stderr, /UTF-8/);
  writeFileSync(source, '- ゴール: a Markdown line');
  const invalidJson = JSON.parse((await reject(args)).stderr).error;
  assert.ok(invalidJson.issues.some((issue: { path: string; code: string }) =>
    issue.path === 'values' && issue.code === 'invalid_json'));
  rmSync(source);
  assert.match((await reject(args)).stderr, /Cannot read --values-file/);
  mkdirSync(source);
  assert.match((await reject(args)).stderr, /regular file/);
  rmSync(source, { recursive: true });
  assert.equal((await cli('task', 'get', '--task', 'T2')).task.hash, before.hash, 'no refusal wrote');
});

test('task update over HTTP takes values as JSON and refuses other shapes without writing', async () => {
  const app = await start();
  let expected = (await cli('task', 'get', '--task', 'T2')).task.hash;
  const saved = await request(app, 'commands/task/update', { task: 'T2', values: { notes: 'HTTP notes' }, expectedTaskHash: expected });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.task.values.notes, 'HTTP notes');
  expected = saved.body.task.hash;
  for (const [input, status, code] of [
    [{ task: 'T2', values: { notes: 'new' }, expectedTaskHash: '0'.repeat(64) }, 409, 'conflict'],
    [{ task: 'T999', values: { notes: 'new' }, expectedTaskHash: expected }, 404, 'not_found'],
    [{ task: 'T2', values: { notes: 'new' } }, 400, 'invalid_input'],
    [{ task: 'T2', values: 'notes', expectedTaskHash: expected }, 400, 'invalid_input'],
    [{ task: 'T2', values: { notes: 1 }, expectedTaskHash: expected }, 400, 'invalid_input'],
    [{ task: 'T2', body: 'Markdown', expectedTaskHash: expected }, 400, 'invalid_input'],
    [{ task: 'T2', 'values-file': 'local-only', expectedTaskHash: expected }, 400, 'invalid_input'],
  ] as const) {
    const result = await request(app, 'commands/task/update', input);
    assert.equal(result.status, status, JSON.stringify(input));
    assert.equal(result.body.error.code, code);
  }
  assert.equal((await cli('task', 'get', '--task', 'T2')).task.hash, expected, 'no refusal wrote');
});
