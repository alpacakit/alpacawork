import { RunStore } from '@alpacawork/runs';
import { createTimelineScene } from './timeline-scene.ts';
import { parseAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { controlDatabasePath } from '@alpacawork/db';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { runRecordSchema } from '@alpacawork/contract/run';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from './fixture.ts';

const digest = (root: string) => createHash('sha256').update(readFileSync(controlDatabasePath(root))).digest('hex');
function setup(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'dev-fixture-test-'));
  // Restore permissions only in our own temporary sandbox.
  t.after(() => { chmodSync(root, 0o700); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('small and perf generate exact counts, valid contracts and independent writable workspaces', t => {
  const sandbox = setup(t);
  for (const profile of ['small', 'perf'] as const) {
    const spec = { ...profiles[profile], seed: 'test-v1' };
    const original = createOriginal(spec, join(sandbox, 'cache'));
    try {
      assert.equal(original.reused, false);
      const before = digest(original.root);
      assert.equal(createOriginal(spec, join(sandbox, 'cache')).reused, true);
      const a = copyWorkspace(original.root, join(sandbox, profile + '-a'));
      const b = copyWorkspace(original.root, join(sandbox, profile + '-b'));
      try {
        assert.equal(statSync(controlDatabasePath(original.root)).mode & 0o222, 0);
        assert.notEqual(statSync(controlDatabasePath(a.root)).ino, statSync(controlDatabasePath(b.root)).ino);
        const config = parseAgentsSettings(readFileSync(join(a.root, 'config.yaml'), 'utf8'));
        assert.equal(config.agents.fixture.enabled, false, 'a served sample cannot launch a provider');
        const db = new DatabaseSync(controlDatabasePath(a.root));
        try {
          assert.equal(db.prepare('SELECT count(*) n FROM tasks').get()!.n, spec.tasks);
          assert.equal(db.prepare('SELECT count(*) n FROM task_log').get()!.n, spec.logs);
          assert.equal(db.prepare('SELECT count(*) n FROM runs').get()!.n, spec.runs);
          assert.equal(db.prepare('SELECT next_number FROM task_sequence').get()!.next_number, spec.tasks + 1);
          assert.equal(db.prepare('SELECT next_number FROM run_sequence').get()!.next_number, spec.runs + 1);
          for (const row of db.prepare('SELECT entry FROM task_log').all()) taskLogSchema.parse(JSON.parse(String(row.entry)));
          for (const row of db.prepare('SELECT record FROM runs').all()) {
            const run = runRecordSchema.parse(JSON.parse(String(row.record)));
            assert.equal(run.cwd, a.root); assert.equal(run.state, 'succeeded');
          }
          db.prepare("UPDATE tasks SET title='Changed only in a' WHERE external_id='T2'").run();
        } finally { db.close(); }
        const other = new DatabaseSync(controlDatabasePath(b.root), { readOnly: true });
        try { assert.equal(other.prepare("SELECT title FROM tasks WHERE external_id='T2'").get()!.title, 'Synthetic task 2'); }
        finally { other.close(); }
        assert.equal(digest(original.root), before);
        assert.throws(() => copyWorkspace(original.root, a.root), /exist/i);
      } finally { removeWorkspace(a.root); removeWorkspace(b.root); }
    } finally { removeWorkspace(original.root); }
  }
});

test('custom counts, deterministic logical data, seed separation and malformed inputs', t => {
  const sandbox = setup(t), spec = { tasks: 7, logs: 121, runs: 15, seed: 'custom' };
  const a = createOriginal(spec, join(sandbox, 'a')), b = createOriginal(spec, join(sandbox, 'b'));
  try {
    assert.equal(a.key, b.key);
    const read = (root: string) => { const db = new DatabaseSync(controlDatabasePath(root), { readOnly: true });
      try { return ['tasks', 'task_log', 'runs', 'requests', 'returns'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
      finally { db.close(); } };
    assert.deepEqual(read(a.root), read(b.root));
    const changed = createOriginal({ ...spec, seed: 'another' }, join(sandbox, 'a'));
    try { assert.notEqual(a.key, changed.key); } finally { removeWorkspace(changed.root); }
    for (const invalid of [{ tasks: 1 }, { logs: 6 }, { runs: -1 }, { tasks: NaN }, { logs: 1.5 }])
      assert.throws(() => createOriginal({ ...spec, ...invalid }, join(sandbox, 'bad')));
    assert.equal(existsSync(join(sandbox, 'bad')), false);
  } finally { removeWorkspace(a.root); removeWorkspace(b.root); }
});

test('refuse unmarked removal, links and damaged originals without touching existing content', t => {
  const sandbox = setup(t), a = createOriginal({ ...profiles.small, seed: 'guard' }, join(sandbox, 'cache'));
  const unrelated = join(sandbox, 'unrelated'); mkdirSync(unrelated); writeFileSync(join(unrelated, 'keep'), 'keep');
  assert.throws(() => removeWorkspace(unrelated));
  const link = join(sandbox, 'link'); symlinkSync(a.root, link);
  assert.throws(() => copyWorkspace(link, join(sandbox, 'copy')));
  assert.throws(() => removeWorkspace(link));
  chmodSync(join(a.root, 'config.yaml'), 0o600); writeFileSync(join(a.root, 'config.yaml'), 'damaged');
  assert.throws(() => copyWorkspace(a.root, join(sandbox, 'damaged-copy')), /changed/);
  assert.equal(readFileSync(join(unrelated, 'keep'), 'utf8'), 'keep');
  rmSync(link); removeWorkspace(a.root);
});

test('timeline scene reloads every Task and Coordinator Run with its conversation reply', t => {
  const sandbox = mkdtempSync(join(tmpdir(), 'dev-fixture-timeline-'));
  const cache = join(sandbox, 'cache'), destination = join(sandbox, 'timeline');
  t.after(() => {
    if (existsSync(destination)) removeWorkspace(destination);
    if (existsSync(cache)) for (const entry of readdirSync(cache)) removeWorkspace(join(cache, entry));
    rmSync(sandbox, { recursive: true, force: true });
  });
  const scene = createTimelineScene(destination, cache);
  const store = new RunStore(scene.root, { busyTimeoutMs: 0 });
  try {
    const runs = store.read();
    assert.ok(runs.some(run => run.role !== 'coordinator'));
    const dialogue = runs.filter(run => run.role === 'coordinator');
    assert.equal(dialogue.length, 1);
    const reply = dialogue[0]!;
    assert.equal(reply.state, 'succeeded');
    assert.equal(reply.message.context, scene.open.middle);
    assert.deepEqual(reply.message.tasks, [scene.open.middle]);
    assert.ok(store.getText(reply.id)?.result, 'the conversation keeps its reply');
  } finally { store.close(); }
});
