import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
/** Release readiness checks the real settings readers without changing serve's startup rules. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { cliCommand } from './helpers/cli-session.ts';

const valid = stringify({ agents: { "fake": fixtureAgentSetting('codex') } });
const invalid = [
  ['obsolete launch', 'agents: {fake: {start: [/usr/bin/false], coordinator: {start: [old]}}}\n'],
  ['limits', valid + 'limits: {parallel: 0}\n'],
  ['YAML', 'agents: ['],
  ['unknown section', valid + 'unknown: {}\n'],
  ['project location', valid + 'projects: {P1: {cwd: relative}}\n'],
  ['encoding', Buffer.from([0xff])],
] as const;

test('unreadable config refuses readiness while the running serve answers diagnostics and recovers after repair', { timeout: 30_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-readiness-')));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); rmSync(root, { recursive: true, force: true }); });
  initializeControlFixture(root);
  const file = join(root, 'config.yaml');
  writeFileSync(file, valid, { mode: 0o600 });
  server = await startServer(root, 0);
  const readiness = () => fetch(new URL('/api/runtime/readiness', server!.url));
  for (const [name, bytes] of invalid) {
    writeFileSync(file, bytes);
    const response = await readiness(), body = await response.json();
    assert.equal(response.status, 503, name);
    assert.equal(body.configReadable, false, name);
    assert.equal(body.state, 'accepting', 'Settings failure must not change the serve lifecycle');
    assert.deepEqual(readFileSync(file), Buffer.from(bytes), 'readiness never repairs config');
    const page = await fetch(new URL('/', server.url));
    assert.equal(page.status, 200, `${name}: the screen settings are repaired from still opens`);
    assert.match(page.headers.get('content-type') ?? '', /^text\/html/, name);
    assert.equal((await page.text()).includes('name="alpacawork-voice"'), false, `${name}: unreadable voice is no voice`);
  }
  rmSync(file);
  assert.equal((await readiness()).status, 503, 'missing settings');
  assert.equal((await fetch(new URL('/api/runtime/diagnostics', server.url))).status, 200);
  writeFileSync(file, valid, { mode: 0o600 });
  const response = await readiness(), body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.configReadable, true);
  assert.equal(body.state, 'accepting');
});

test('initial release ignores configured voice and Jev while keeping settings usable', { timeout: 30_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-readiness-')));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); rmSync(root, { recursive: true, force: true }); });
  initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), valid + 'voice: {provider: local, endpoint: "http://127.0.0.1:9/v", model: m}\njev: {endpoint: "http://127.0.0.1:9/decision"}\n', { mode: 0o600 });
  server = await startServer(root, 0);
  assert.equal((await (await fetch(new URL('/', server.url))).text()).includes('name="alpacawork-voice"'), false);
  const settings = await (await fetch(new URL('/api/commands/config/get', server.url))).json();
  assert.equal(Object.hasOwn(settings, 'jev'), false);
  const { readJevSettings, evaluateJev } = await import('../apps/backend/test-dist/jev.js');
  assert.equal(readJevSettings(root), null);
  await assert.rejects(evaluateJev(root, { state: '', questions: { q: { type: 'noul' } } }, {
    request: async () => { throw new Error('Disabled Jev must never contact its provider'); },
  }), (error: any) => error.code === 'disabled');
  const voice = await fetch(new URL('/api/voice/token', server.url), { method: 'POST' });
  assert.equal(voice.status, 404);
  assert.equal((await voice.json()).error.code, 'not_found');
  const { commandFetch } = await import('./helpers/command-fetch.ts');
  for (const section of ['voice', 'jev']) {
    const refused = await commandFetch(new URL('/api/commands/config/set', server.url), { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        config: `limits: ${JSON.stringify(settings.limits)}\n${section}: {}\n`,
        agents: settings.agentsText, expectedConfigHash: settings.hash,
      }) });
    assert.equal(refused.status, 400, `${section} cannot be enabled through config/set`);
  }
  assert.equal((await (await fetch(new URL('/api/runtime/readiness', server.url))).json()).configReadable, true);
});

test('a settings error names the broken line without the value written on it', { timeout: 60_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-readiness-')));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => { await server?.close(); rmSync(root, { recursive: true, force: true }); });
  initializeControlFixture(root);
  const file = join(root, 'config.yaml');
  writeFileSync(file, valid, { mode: 0o600 });
  server = await startServer(root, 0);
  for (const line of ['token=VALUE', 'SECRET=VALUE', 'CLIENT_SECRET=VALUE', 'AWS_SECRET_ACCESS_KEY=VALUE', 'GITHUB_TOKEN=VALUE',
    'private_key=VALUE', 'access_key=VALUE', '{"token": "VALUE"}', '\n  client_secret: VALUE']) {
    writeFileSync(file, `${valid}limits: [ ${line}\n`);
    const read = await cliCommand(server.url, ['config', 'get'], {});
    const said = read.stdout + read.stderr;
    assert.match(said, /invalid_settings/, line);
    assert.match(said, /\[redacted\]/, `${line}: the broken line is still named`);
    assert.doesNotMatch(said, /VALUE/, line);
  }
  // Each as the whole file's broken tail, read through the CLI and the ways in that need no credentials.
  const far = 'x'.repeat(60);
  for (const tail of ['limits: [ {token: VALUE}', 'limits: [ {note: safe, token: my VALUE phrase, more: safe}', "limits: [ {'token': 'VALUE'}",
    'limits: [ {token: \'VALUE\'}', 'limits: [ https://example.test/p?token=VALUE&page=2', 'limits: [ redis://:VALUE@example.test', 'limits: token: VALUE',
    'limits: note token: VALUE', 'limits: note, token: VALUE', 'limits: [ "--token", "VALUE"', 'limits: [ --token VALUE', "password: 'it's VALUE' x",
    'password: "pa"VALUE" x', 'token: VALUE: x', 'token: | VALUE', 'token: VALUE\ntoken: VALUE', '- token: VALUE',
    'limits: [ {"token": "VALUE"} x', `limits: [ ${far}, OPENAI_API_KEY: VALUE }} ${far}`, `limits: [ ${far}_token: VALUE }}`,
    'limits: [ {password: abc,VALUE, note: safe}', 'limits: [ {password: abc]VALUE}', "limits: [ {token: 'a' VALUE, b: c}", 'limits: [ password="a b" VALUE',
    `password: "${far}${far},VALUE${far}" x`, 'token: "a\nVALUE" x', 'limits: [ {token:\nVALUE}', 'limits: { token: a\nVALUE: x }', 'limits: [ --token\nVALUE', 'token: a\nVALUE',
    'token: | my VALUE: x', 'secret_key: VALUE: x', 'limits: [ {SECRET_KEY: VALUE}',
    'token: "\\UVALUEXYZ"', 'limits: [ {token: "\\UVALUEXYZ"}', 'token: a\n^VALUE', 'limits: [ {token:\n^VALUE}', 'token: !<VALUE>', 'token: !VALUE!']) {
    writeFileSync(file, `${valid}${tail}\n`);
    const read = await cliCommand(server.url, ['config', 'get'], {});
    const said = read.stdout + read.stderr;
    assert.match(said, /invalid_settings/, tail);
    assert.doesNotMatch(said, /VALUE/, tail);
    assert.match(said, /\[redacted\]/, tail);
    for (const path of ['/', '/api/runtime/readiness', '/api/runtime/diagnostics'])
      assert.doesNotMatch(await (await fetch(new URL(path, server.url))).text(), /VALUE/, `${tail} at ${path}`);
  }
});
