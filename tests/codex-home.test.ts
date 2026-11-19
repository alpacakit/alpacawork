import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCodexHome, originalCodexThread, prepareCodexHome } from '../apps/agent-cli/src/codex-home.ts';

test('explicit CODEX_HOME is untouched and default isolation requires file authentication', () => {
  assert.equal(defaultCodexHome({ CODEX_HOME: '/caller/owns/this' }, '/unused'), null);
  assert.throws(() => defaultCodexHome({ CODEX_HOME: '' }), /must not be empty/);
  assert.throws(() => defaultCodexHome({}, '/nonexistent-t57'), /auth.json/);
});

test('inputs and known relative configuration files remain shared, session and SQLite storage do not', t => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-')));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const source = join(area, '.codex'), target = join(area, '.codex-alpacawork');
  mkdirSync(source); mkdirSync(join(source, 'custom'));
  writeFileSync(join(source, 'auth.json'), 'test-only');
  writeFileSync(join(source, 'config.toml'), 'model="test"');
  writeFileSync(join(source, 'custom/prompt.md'), 'original instructions');
  mkdirSync(join(source, 'skills')); writeFileSync(join(source, 'skills/SKILL.md'), 'original skill');
  mkdirSync(join(source, 'sessions')); writeFileSync(join(source, 'state_5.sqlite'), 'private history');
  const config = { model_instructions_file: join(source, 'custom/prompt.md') };
  const home = defaultCodexHome({}, area)!;
  prepareCodexHome(home, config);
  prepareCodexHome(home, config);
  assert.equal(readFileSync(join(target, 'custom/prompt.md'), 'utf8'), 'original instructions');
  assert.equal(realpathSync(join(target, 'skills')), join(source, 'skills'));
  assert.equal(existsSync(join(target, 'sessions')), false);
  assert.equal(existsSync(join(target, 'state_5.sqlite')), false);
  assert.equal(lstatSync(target).mode & 0o777, 0o700);
  // Credential updates and newly installed skills have one writable source.
  writeFileSync(join(target, 'auth.json'), 'refreshed-test-only');
  assert.equal(readFileSync(join(source, 'auth.json'), 'utf8'), 'refreshed-test-only');
  writeFileSync(join(source, 'skills/new.md'), 'new skill');
  assert.equal(readFileSync(join(target, 'skills/new.md'), 'utf8'), 'new skill');
});

test('conflicting inputs, keyring and linked state fail without overwriting existing files', t => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-')));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const source = join(area, '.codex'), target = join(area, '.codex-alpacawork');
  mkdirSync(source); mkdirSync(target);
  writeFileSync(join(source, 'auth.json'), 'source');
  writeFileSync(join(target, 'auth.json'), 'keep');
  assert.throws(() => prepareCodexHome({ source, target }, { cli_auth_credentials_store: 'keyring' }), /file authentication/);
  assert.throws(() => prepareCodexHome({ source, target }, {}), /conflicts/);
  assert.equal(readFileSync(join(target, 'auth.json'), 'utf8'), 'keep');
  symlinkSync(join(source, 'sessions'), join(target, 'sessions'), 'dir');
  assert.throws(() => prepareCodexHome({ source, target }, {}), /state must not/);
});

test('a requested existing rollout is located in place; unrelated and ambiguous IDs are not adopted', t => {
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-')));
  t.after(() => rmSync(area, { recursive: true, force: true }));
  const source = join(area, '.codex'), target = join(area, '.codex-alpacawork');
  const folder = join(source, 'sessions/2026/10/15');
  mkdirSync(folder, { recursive: true });
  const id = '0199e4ba-1111-7111-8111-111111111111';
  const file = join(folder, `rollout-test-${id}.jsonl`);
  writeFileSync(file, 'unchanged');
  assert.equal(originalCodexThread({ source, target }, id), file);
  assert.equal(originalCodexThread({ source, target }, '../anything'), null);
  assert.equal(originalCodexThread({ source, target }, '0199e4ba-1111-7111-8111-222222222222'), null);
  assert.equal(readFileSync(file, 'utf8'), 'unchanged');
  assert.equal(existsSync(target), false);
  writeFileSync(join(folder, `rollout-duplicate-${id}.jsonl`), 'duplicate');
  assert.throws(() => originalCodexThread({ source, target }, id), /Multiple original/);
});
