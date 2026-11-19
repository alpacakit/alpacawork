/** One line parser from before start: a failed start records what it provably did not send, and nothing it did not see. */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { spawnBridge } from './helpers/bridge-process.ts';
import { scratch } from './helpers/managed-skills-fixture.ts';

const fixture = join(import.meta.dirname, 'fixtures/run-lifecycle-bridge.mjs');
function setup(t: TestContext, mode: string) {
  const area = scratch(t, 'alpacawork-bridge-start-'), gate = join(area, 'gate'), log = join(area, 'delivered.jsonl');
  const b = spawnBridge(t, [fixture, gate, mode, log], { cwd: area });
  return { ...b, open: () => writeFileSync(gate, ''), delivered: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
    /** A bad line after it proves the parser has reached everything sent before it. */
    seen: async () => {
      b.child.stdin.write('not an instruction\n');
      const until = Date.now() + 10_000;
      while (!b.stderr().includes('ignored an input line') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      assert.match(b.stderr(), /ignored an input line/);
    } };
}
const states = (rows: any[]) => rows.filter(row => String(row.type).startsWith('input.')).map(row => `${row.id}:${row.type}`);

for (const mode of ['reject', 'fatal-pending', 'fatal-then-success']) test(`${mode}: an input seen before a failed start is not_sent with no deliver`, async t => {
  const b = setup(t, mode);
  b.send('one', 'first');
  b.send('two', 'second');
  await b.seen();
  b.open();
  await b.until(rows => rows.filter(row => row.type === 'input.not_sent').length === 2, 'both not_sent');
  assert.deepEqual(b.events().filter(row => row.type === 'input.not_sent').map(row => [row.id, row.evidence]), [['one', 'transfer_not_started'], ['two', 'transfer_not_started']]);
  assert.equal(await b.exited, 1);
  assert.deepEqual(b.delivered(), []);
  assert.deepEqual(states(b.events()), ['one:input.not_sent', 'two:input.not_sent']);
});

test('nothing is guessed about a partial line or an input that never arrived', async t => {
  const b = setup(t, 'reject');
  b.child.stdin.write('{"id":"partial","te');
  b.open();
  assert.equal(await b.exited, 1);
  assert.deepEqual(states(b.events()), []);
  assert.deepEqual(b.delivered(), []);
});

test('an empty start failure records no input at all', async t => {
  const b = setup(t, 'reject');
  b.open();
  assert.equal(await b.exited, 1);
  assert.deepEqual(b.events(), []);
  assert.match(b.stderr(), /scripted start rejection/);
});

test('inputs seen during a successful start are delivered in order after it, once each', async t => {
  const b = setup(t, 'ok');
  b.send('one', 'first'); b.send('one', 'first'); b.send('two', 'second');
  await b.seen();
  assert.deepEqual(b.delivered(), [], 'deliver waits for start');
  b.open();
  await b.until(rows => rows.filter(row => row.type === 'input.taken').length === 2, 'both taken');
  b.child.stdin.end();
  assert.equal(await b.exited, 0);
  assert.deepEqual(b.delivered(), [{ id: 'one', text: 'first' }, { id: 'two', text: 'second' }]);
});

test('a reused ID with other text before start is fatal, not a deliver', async t => {
  const b = setup(t, 'ok');
  b.send('one', 'first'); b.send('one', 'other');
  await b.until(rows => rows.some(row => row.type === 'input.not_sent'), 'not_sent');
  b.open();
  assert.equal(await b.exited, 1);
  assert.match(b.stderr(), /Input ID reused with different content: one/);
  assert.deepEqual(b.delivered(), []);
});

test('deliver failure after a good start stays uncertain, never not_sent', async t => {
  const b = setup(t, 'deliver-throw');
  b.send('one', 'first');
  b.open();
  await b.until(rows => rows.some(row => row.type === 'input.uncertain'), 'uncertain');
  assert.equal(await b.exited, 1);
  assert.deepEqual(states(b.events()), ['one:input.uncertain']);
  assert.equal(b.delivered().length, 1);
});

test('an uncertain admission still settles when its delayed receipt arrives, with one deliver for a repeated ID', async t => {
  const b = setup(t, 'deliver-uncertain');
  b.send('one', 'first');
  b.open();
  await b.until(rows => rows.some(row => row.type === 'input.uncertain'), 'uncertain');
  b.send('one', 'first');
  await b.until(rows => rows.some(row => row.type === 'input.taken'), 'taken');
  b.child.stdin.end();
  assert.equal(await b.exited, 0);
  assert.equal(b.delivered().length, 1);
});

test('stdin closing during start waits for start, as it did when reading began after it', async t => {
  const b = setup(t, 'ok');
  b.send('one', 'first'); b.child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(b.delivered(), []);
  b.open();
  assert.equal(await b.exited, 0);
  assert.deepEqual(b.delivered(), [{ id: 'one', text: 'first' }]);
});

test('the real Pi bridge reports an input seen before its server failed as not_sent', async t => {
  const area = scratch(t, 'alpacawork-bridge-start-'), gate = join(area, 'gate'), pi = join(area, 'pi');
  writeFileSync(pi, `#!/usr/bin/env node\nimport('node:fs').then(({ existsSync }) => setInterval(() => { if (existsSync(${JSON.stringify(gate)})) process.exit(7); }, 5));\n`);
  chmodSync(pi, 0o755);
  const b = spawnBridge(t, [join(import.meta.dirname, 'fixtures/runtime-bridge.ts'), 'pi', '-o', join(area, 'result')], { cwd: area, env: { ...process.env, PATH: `${area}:${process.env.PATH}` } });
  b.send('one', 'hello'); b.child.stdin.write('marker\n');
  for (const until = Date.now() + 10_000; !b.stderr().includes('ignored an input line');) {
    assert.ok(Date.now() < until, 'parser reached the input');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  writeFileSync(gate, '');
  assert.equal(await b.exited, 1);
  assert.deepEqual(states(b.events()), ['one:input.not_sent']);
  assert.match(b.stderr(), /Pi RPC ended before bridge shutdown \(7\)/);
});
