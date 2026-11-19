/** The user's environment file: what it sets, what it never sets, when it is left unread, and that it is never quoted. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { environmentFileSchema } from '@alpacawork/contract';
import { applyEnvironmentFile, environmentFilePath, environmentFileProblems } from '@alpacawork/backend/test-dist/environment-file.js';
import { agentEnvironment } from '@alpacawork/backend/test-dist/runs/env.js';

/** A HOME of this test's own: the file is never looked for in the real one. */
function home(t: TestContext) {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-environment-file-')));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { HOME: area, XDG_CONFIG_HOME: join(area, 'config'), PATH: '/synthetic/bin' };
  const path = join(area, 'config', 'alpacawork', 'env');
  mkdirSync(dirname(path), { recursive: true });
  /** The file anew with this text and mode, whatever was there. */
  const write = (text: string | Buffer, mode = 0o600) => { rmSync(path, { force: true }); writeFileSync(path, text); chmodSync(path, mode); };
  return { area, env, path, write };
}

test('the file is in the user configuration directory', () => {
  assert.equal(environmentFilePath({ HOME: '/synthetic/home' }), '/synthetic/home/.config/alpacawork/env');
  assert.equal(environmentFilePath({ HOME: '/synthetic/home', XDG_CONFIG_HOME: '/synthetic/config' }), '/synthetic/config/alpacawork/env');
});

test('no file sets nothing, reports nothing and logs nothing', t => {
  const h = home(t), before = { ...h.env };
  const report = applyEnvironmentFile(h.env);
  assert.deepEqual(report, { path: h.path, state: 'absent', applied: 0, skipped: [] });
  assert.deepEqual(h.env, before);
  assert.deepEqual(environmentFileProblems(report), []);
});

test('each line sets one variable as written, and the file replaces what the server inherited', t => {
  const h = home(t);
  h.env.INHERITED = 'from the shell';
  h.env.UNTOUCHED = 'kept';
  h.write([
    '﻿# keys for the server', '',
    'PLAIN=plain-value',
    '  SPACED =not a name',
    'TRIMMED=  around  ',
    'DOUBLE="in double quotes"',
    "SINGLE=' kept spaces '",
    'UNMATCHED="left as written',
    'EQUALS=a=b==',
    'EMPTY=',
    'INHERITED=from the file',
    'CRLF=windows\r',
    'HASH=value # not a comment',
    'DO_NOT_TRACK=1',
    'ALPACAWORK_TELEMETRY_DISABLED=1',
  ].join('\n'));
  const report = applyEnvironmentFile(h.env);
  assert.deepEqual(report, { path: h.path, state: 'read', applied: 12, skipped: [{ line: 4, reason: 'malformed' }] });
  assert.deepEqual(h.env, { HOME: h.area, XDG_CONFIG_HOME: join(h.area, 'config'), PATH: '/synthetic/bin', UNTOUCHED: 'kept',
    PLAIN: 'plain-value', TRIMMED: 'around', DOUBLE: 'in double quotes', SINGLE: ' kept spaces ', UNMATCHED: '"left as written',
    EQUALS: 'a=b==', EMPTY: '', INHERITED: 'from the file', CRLF: 'windows', HASH: 'value # not a comment',
    DO_NOT_TRACK: '1', ALPACAWORK_TELEMETRY_DISABLED: '1' });
});

test('names the server depends on are never set, and each is reported by its line', t => {
  const h = home(t), before = { ...h.env };
  const pinned = ['HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'ALPACAWORK_MANAGED_RELEASES', 'ALPACAWORK_RUN', 'ALPACAWORK_RUN_TOKEN', 'ALPACAWORK_SERVER', 'ALPACAWORK_WORKSPACE',
    'NODE_OPTIONS', 'NODE_PATH'];
  h.write([...pinned.map(name => `${name}=/pinned-secret/${name}`), 'ALLOWED=yes'].join('\n') + '\n');
  const report = applyEnvironmentFile(h.env);
  assert.deepEqual(report, { path: h.path, state: 'read', applied: 1, skipped: pinned.map((_, index) => ({ line: index + 1, reason: 'reserved' })) });
  assert.deepEqual(h.env, { ...before, ALLOWED: 'yes' });
  assert.equal(environmentFileProblems(report).length, pinned.length);
});

test('a line that is not NAME=VALUE or repeats a name is skipped alone; nothing of the file is quoted', t => {
  const h = home(t);
  h.write([
    'FIRST=first-secret',
    'export EXPORTED=exported-secret',
    'no-equals-secret',
    'c2VjcmV0LWFzLW5hbWU=',
    '1DIGIT=digit-secret',
    'DASH-ED=dash-secret',
    'FIRST=second-secret',
    'NUL=nul\0secret',
    '=leading-secret',
    'LAST=last-secret',
  ].join('\n'));
  const report = applyEnvironmentFile(h.env);
  assert.deepEqual(report.skipped, [{ line: 2, reason: 'malformed' }, { line: 3, reason: 'malformed' }, { line: 5, reason: 'malformed' },
    { line: 6, reason: 'malformed' }, { line: 7, reason: 'duplicate' }, { line: 8, reason: 'malformed' }, { line: 9, reason: 'malformed' }]);
  assert.equal(report.applied, 3);
  assert.equal(h.env.FIRST, 'first-secret');
  assert.equal(h.env.LAST, 'last-secret');
  // A value put on a line of its own can look like a name. The report and the log say where, never what.
  assert.equal(h.env.c2VjcmV0LWFzLW5hbWU, '');
  environmentFileSchema.parse(report);
  for (const said of [JSON.stringify(report), ...environmentFileProblems(report)])
    for (const written of ['secret', 'FIRST', 'LAST', 'EXPORTED', 'c2VjcmV0', 'DASH', 'DIGIT'])
      assert.equal(said.includes(written), false, `${written} is quoted in: ${said}`);
});

test('a file others can read or write, of another user, or not a regular file is left wholly unread, with its reason', t => {
  const h = home(t), before = { ...h.env }, text = 'UNSAFE_KEY=unsafe-secret\n';
  const unread = (state: string) => {
    const report = applyEnvironmentFile(h.env);
    assert.deepEqual(report, { path: h.path, state, applied: 0, skipped: [] });
    assert.deepEqual(h.env, before);
    const lines = environmentFileProblems(report);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes(h.path) && lines[0]!.includes(state));
    assert.equal(lines[0]!.includes('unsafe-secret') || lines[0]!.includes('UNSAFE_KEY'), false);
  };
  for (const mode of [0o640, 0o604, 0o620, 0o602, 0o644, 0o666]) { h.write(text, mode); unread('permissions'); }

  h.write(Buffer.from([0x4b, 0x3d, 0xff, 0xfe]));
  unread('unreadable');
  h.write(text, 0o000);
  // Root reads a file of mode 000; no test runs as root, but say so rather than fail there.
  if (process.getuid!() !== 0) unread('unreadable');

  h.write(text);
  t.mock.method(process, 'getuid', () => 4_000_000);
  unread('owner');
  t.mock.restoreAll();

  rmSync(h.path);
  const elsewhere = join(h.area, 'elsewhere');
  writeFileSync(elsewhere, text, { mode: 0o600 });
  symlinkSync(elsewhere, h.path);
  unread('not_regular_file');
  rmSync(h.path);
  mkdirSync(h.path);
  unread('not_regular_file');

  // The same file, made safe, is read: the reasons above were the file's, not the test's.
  rmSync(h.path, { recursive: true });
  h.write(text);
  assert.equal(applyEnvironmentFile(h.env).state, 'read');
  assert.equal(h.env.UNSAFE_KEY, 'unsafe-secret');
});

test('a folder above the file may be a symbolic link', t => {
  const h = home(t), real = join(h.area, 'dotfiles');
  rmSync(join(h.area, 'config'), { recursive: true });
  mkdirSync(join(real, 'alpacawork'), { recursive: true });
  symlinkSync(real, join(h.area, 'config'));
  h.write('LINKED=yes\n');
  assert.equal(applyEnvironmentFile(h.env).state, 'read');
  assert.equal(h.env.LINKED, 'yes');
});

test('a variable of the file reaches only the agent whose settings list its name', t => {
  const h = home(t);
  h.write('FILE_KEY=file-secret\nOTHER_KEY=other-secret\nHTTPS_PROXY=http://proxy.invalid:8080\n');
  applyEnvironmentFile(h.env);
  const listed = agentEnvironment(h.env, '/snapshot/bin', undefined, ['FILE_KEY']);
  assert.equal(listed.FILE_KEY, 'file-secret');
  assert.equal(listed.OTHER_KEY, undefined);
  const unlisted = agentEnvironment(h.env, '/snapshot/bin', undefined, []);
  assert.equal(unlisted.FILE_KEY, undefined);
  assert.equal(unlisted.OTHER_KEY, undefined);
  // What every agent is given anyway (a proxy) may come from the file too.
  assert.equal(unlisted.HTTPS_PROXY, 'http://proxy.invalid:8080');
});
