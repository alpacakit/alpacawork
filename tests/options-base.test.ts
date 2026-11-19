import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { AGENT_ADAPTERS, BUILTIN_ADAPTER_IDS, optionsBase } from '@alpacawork/contract/agent-adapters';
import { fingerprintOptions, sha256Utf8 } from '../packages/contract/dist/options-base.js';

const oracle = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

test('SHA-256 matches known vectors, padding/block boundaries and UTF-8', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ];
  for (const [text, expected] of vectors) assert.equal(sha256Utf8(text!), expected);
  for (const length of [1, 55, 56, 63, 64, 65, 119, 120, 127, 128]) {
    const text = 'a'.repeat(length);
    assert.equal(sha256Utf8(text), oracle(text), `UTF-8 bytes: ${length}`);
  }
  for (const text of ['日本語 🦙 e\u0301\0\n', '\ud800', '🦙'.repeat(14)])
    assert.equal(sha256Utf8(text), oracle(text));
});

test('public optionsBase is stable canonical start/resume SHA-256 for every adapter', () => {
  for (const id of BUILTIN_ADAPTER_IDS) {
    const { start, resume } = AGENT_ADAPTERS[id].options;
    const value = optionsBase(id);
    assert.match(value, /^[0-9a-f]{64}$/);
    assert.equal(value, oracle(JSON.stringify([start, resume])));
    assert.equal(optionsBase(id), value);
  }
});

test('both defaults and their order affect base; object key order and extra fields do not', () => {
  const options = { start: '--model {model}', resume: '--session {session}' };
  const base = fingerprintOptions(options);
  assert.notEqual(fingerprintOptions({ ...options, start: options.start + ' ' }), base);
  assert.notEqual(fingerprintOptions({ ...options, resume: options.resume + ' ' }), base);
  assert.notEqual(fingerprintOptions({ start: options.resume, resume: options.start }), base);
  const extra = { ...options, defaultParams: { model: ['provider/changed'] },
    prefix: ['different'], defaultEnv: ['OTHER'], referenceUrl: 'https://example.invalid/' };
  assert.equal(fingerprintOptions(extra), base);
  assert.equal(fingerprintOptions({ resume: options.resume, start: options.start }), base);
});

test('browser bundle computes the same synchronous bases without Node or WebCrypto', async () => {
  const result = await build({ configFile: false, logLevel: 'silent',
    build: { write: false, minify: false, target: 'es2022',
      lib: { entry: fileURLToPath(new URL('../packages/contract/src/agent-adapters.ts', import.meta.url)),
        name: 'AgentAdapters', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0] : result;
  assert.ok(output && 'output' in output);
  const chunk = output.output.find(item => item.type === 'chunk');
  assert.ok(chunk && chunk.type === 'chunk');
  const browser = runInNewContext(`${chunk.code}\nAgentAdapters;`, { TextEncoder }, { timeout: 1000 }) as
    Pick<typeof import('@alpacawork/contract/agent-adapters'), 'optionsBase'>;
  for (const id of BUILTIN_ADAPTER_IDS) assert.equal(browser.optionsBase(id), optionsBase(id));
});
