import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { RunStore } from '@alpacawork/runs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import YAML from 'yaml';
import { generate } from '../e2e/fixture/generate.ts';

test('performance copy keeps current Task, Run, and file data without legacy roots or live credentials', t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-perf-copy-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, 'source'), destination = join(parent, 'destination');
  mkdirSync(source);
  generate(source);
  const config = YAML.stringify({ agents: { codex: fixtureAgentSetting('codex') } });
  writeFileSync(join(source, 'config.yaml'), config);
  writeFileSync(join(source, 'global.md'), '# Goal\n');
  mkdirSync(join(source, 'T999'));
  writeFileSync(join(source, 'T999', 'index.md'), 'legacy task');
  mkdirSync(join(source, 'tasks', 'T2', 'files'), { recursive: true });
  writeFileSync(join(source, 'tasks', 'T2', 'files', 'brief.txt'), 'current file');
  symlinkSync('brief.txt', join(source, 'tasks', 'T2', 'files', 'brief-link.txt'));
  writeFileSync(join(source, '.alpacawork', 'workspace'), '');
  for (const name of ['connection.json', 'push.json', 'run-credential.key', 'runs.sqlite'])
    writeFileSync(join(source, '.alpacawork', name), 'legacy or private');
  const script = new URL('../e2e/perf/copy-root.mjs', import.meta.url);
  const copied = spawnSync(process.execPath, [script.pathname, source, destination], { encoding: 'utf8' });
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(readFileSync(join(source, 'config.yaml'), 'utf8'), config);
  const agent = YAML.parse(readFileSync(join(destination, 'config.yaml'), 'utf8')).agents.codex;
  assert.equal(agent.enabled, false);
  const store = new RunStore(destination, { busyTimeoutMs: 0 });
  try { assert.ok(store.read().every(run => run.launch.argv.length === 1 && run.launch.argv[0] === '/usr/bin/false')); }
  finally { store.close(); }
  const rows = (root: string) => {
    const db = new DatabaseSync(join(root, '.alpacawork', 'alpacawork.sqlite'), { readOnly: true });
    try { return [db.prepare('SELECT count(*) AS count FROM tasks').get().count,
      db.prepare('SELECT count(*) AS count FROM runs').get().count]; }
    finally { db.close(); }
  };
  assert.deepEqual(rows(destination), rows(source));
  assert.match(copied.stdout, new RegExp(`${rows(source)[0]} tasks`));
  assert.deepEqual(readdirSync(join(destination, '.alpacawork', 'runs')),
    readdirSync(join(source, '.alpacawork', 'runs')));
  assert.equal(readFileSync(join(destination, 'tasks', 'T2', 'files', 'brief.txt'), 'utf8'), 'current file');
  assert.equal(readlinkSync(join(destination, 'tasks', 'T2', 'files', 'brief-link.txt')), 'brief.txt');
  for (const name of ['global.md', 'T999']) assert.equal(existsSync(join(destination, name)), false);
  for (const name of ['connection.json', 'push.json', 'run-credential.key', 'runs.sqlite', 'runs.sqlite.lock'])
    assert.equal(existsSync(join(destination, '.alpacawork', name)), false);
  assert.equal(readFileSync(join(destination, '.alpacawork', 'workspace'), 'utf8'), '');
});

test('performance copy rejects an old root before creating a destination', t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-perf-old-')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const source = join(parent, 'source'), destination = join(parent, 'destination');
  mkdirSync(join(source, '.alpacawork'), { recursive: true });
  writeFileSync(join(source, 'config.yaml'), 'agents:\n  codex:\n    start: [codex]\n');
  writeFileSync(join(source, '.alpacawork', 'runs.sqlite'), 'old database');
  const script = new URL('../e2e/perf/copy-root.mjs', import.meta.url);
  const copied = spawnSync(process.execPath, [script.pathname, source, destination], { encoding: 'utf8' });
  assert.notEqual(copied.status, 0);
  assert.match(copied.stderr, /Missing control database/);
  assert.equal(existsSync(destination), false);
});
