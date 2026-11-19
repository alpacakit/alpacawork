/** Real Codex, opt-in only: build first, then node --test tests/manual/codex-isolation.ts.
 * Uses the current file credential, a disposable HOME, and four model turns. No existing managed thread is opened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnBridge } from '../helpers/bridge-process.ts';

test('real Codex isolates new history, shares file auth/config/skills, and resumes from a different process', { timeout: 180_000 }, async t => {
  const credential = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  assert.ok(existsSync(credential), 'This opt-in check needs file authentication. Keyring credentials are not extracted.');
  const area = realpathSync(mkdtempSync(join(tmpdir(), 'codex-isolation-real-')));
  // Child-test process cleanup finishes before the parent removes the disposable home.
  t.after(() => rmSync(area, { recursive: true, force: true }));
  await t.test('four turns in disposable storage', { timeout: 160_000 }, async t => {
  const source = join(area, '.codex'), target = join(area, '.codex-alpacawork');
  mkdirSync(source); mkdirSync(join(source, 'prompts')); mkdirSync(join(source, 'skills/fixture'), { recursive: true });
  symlinkSync(credential, join(source, 'auth.json'));
  const configured = randomUUID(), session = randomUUID(), skill = `fixture-${randomUUID()}`;
  writeFileSync(join(source, 'prompts/base.md'), `You are an assistant. Do not use tools. The configured token is ${configured}.`);
  writeFileSync(join(source, 'skills/fixture/SKILL.md'), `---\nname: ${skill}\ndescription: A skill for the isolation diagnostic.\n---\nNo tools are needed.\n`);
  writeFileSync(join(source, 'config.toml'), 'model_instructions_file="prompts/base.md"\nmodel_reasoning_effort="high"\n');
  const env = { ...process.env, HOME: area, CODEX_HOME: undefined, CODEX_SQLITE_HOME: join(area, 'ambient-db') };
  const bridge = join(import.meta.dirname, '../../apps/agent-cli/dist/cli.js');
  const invoke = async (args: string[], prompt: string, result: string, invocationEnv: NodeJS.ProcessEnv = env) => {
    const run = spawnBridge(t, [bridge, 'codex', '-m', 'gpt-6.1-sol', '-c', 'service_tier=default', '-s', 'read-only', '-o', result, ...args], { cwd: area, env: invocationEnv });
    run.send(randomUUID(), prompt);
    run.child.stdin.end();
    assert.equal(await run.exited, 0, 'Real Codex failed; inspect local login/model access without publishing credentials.');
    return { id: run.events().find(x => x.type === 'thread.started')?.thread_id, result: readFileSync(result, 'utf8').trim() };
  };
  const first = await invoke([], `Do not use tools. Reply with only 3 values separated by |: the configured token from your instructions, the name of the skill for the isolation diagnostic, and this session token: ${session}`, join(area, 'first.txt'));
  assert.equal(first.result, `${configured}|${skill}|${session}`);
  assert.ok(first.id);
  const second = await invoke(['resume', first.id], 'Do not use tools. Reply only with the session token from the previous user message.', join(area, 'second.txt'));
  assert.equal(second.id, first.id);
  assert.equal(second.result, session);
  assert.equal(realpathSync(join(target, 'auth.json')), realpathSync(credential));
  assert.equal(realpathSync(join(target, 'prompts')), join(source, 'prompts'));
  assert.equal(realpathSync(join(target, 'skills')), join(source, 'skills'));
  const files = (home: string) => existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions'), { recursive: true }).map(String) : [];
  assert.equal(files(source).filter(x => x.endsWith('.jsonl')).length, 0);
  assert.ok(files(target).some(x => x.includes(first.id)));
  const databases = readdirSync(target).filter(x => /^state_\d+\.sqlite$/.test(x));
  assert.ok(databases.length);
  assert.ok(databases.some(name => {
    const db = new DatabaseSync(join(target, name), { readOnly: true });
    try { return !!db.prepare('SELECT id FROM threads WHERE id = ?').get(first.id); }
    finally { db.close(); }
  }));
  // A separate, NEW fixture conversation simulates a thread made before the default changed.
  const older = await invoke([], `Do not use tools. Reply with only this old session token: ${session}`, join(area, 'old-first.txt'), { ...env, CODEX_HOME: source });
  assert.equal(older.result, session);
  const continued = await invoke(['resume', older.id], 'Do not use tools. Reply only with the old session token from the previous user message.', join(area, 'old-second.txt'));
  assert.equal(continued.id, older.id);
  assert.equal(continued.result, session);
  assert.ok(files(source).some(x => x.includes(older.id)));
  assert.equal(files(target).some(x => x.includes(older.id)), false);
  console.log(JSON.stringify({ version: execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' }).trim(),
    fileAuthShared: true, relativeConfigLoaded: true, skillCatalogLoaded: true, distinctProcessResumeRecall: true,
    newDefaultSourceSessionFiles: 0, targetSessionAndDatabase: true, olderFixtureResumedInPlace: true, macDesktopUI: 'manual confirmation required' }));
  });
});
