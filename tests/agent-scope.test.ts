/** Removing an executable kind must not hide history or silently rewrite settings. */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { checkAgentsConfigText } from '@alpacawork/contract';
import { agentLaunchSchema } from '@alpacawork/contract/agent-launch';
import { compileAgentSetting } from '@alpacawork/contract/agent-settings';
import { RunStore } from '@alpacawork/runs';
import { readControlTree } from './helpers/control-tree.ts';
import { readServerSettings } from '@alpacawork/backend/test-dist/server-settings.js';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { createOriginal, copyWorkspace, profiles, removeWorkspace } from '../scripts/dev-fixtures/fixture.ts';
import { cliRun, isolatedServe } from './helpers/http-cli.ts';
import { setup } from './runs-runtime.fixture.ts';
import { bootIdentity } from '@alpacawork/core';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { settleTransaction, closeLaunches } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { recoverExecution } from '@alpacawork/backend/test-dist/runs/recovery.js';
import { readRunFiles } from '@alpacawork/backend/test-dist/runs/view.js';

const retired = ['retired-kind', 'unavailable-kind'];
function workspace(t: TestContext) {
  const area = mkdtempSync(join(tmpdir(), 'agent-scope-'));
  const original = createOriginal({ ...profiles.small, seed: 'agent-scope' }, join(area, 'cache'));
  const copy = copyWorkspace(original.root, join(area, 'workspace'));
  t.after(() => { removeWorkspace(copy.root); removeWorkspace(original.root); rmSync(area, { recursive: true, force: true }); });
  return copy.root;
}

test('retired kinds keep ended Run history readable in the tree, task and run commands', async t => {
  const root = workspace(t), db = new DatabaseSync(join(root, '.alpacawork/alpacawork.sqlite'));
  try {
    for (const [index, adapter] of retired.entries()) {
      const row = db.prepare('SELECT record FROM runs WHERE id=?').get(index + 1)!;
      const record = JSON.parse(String(row.record));
      record.agent = adapter; record.launch.adapter = adapter;
      // Failed history with a real stdout file reaches optional diagnostic enrichment too.
      record.state = 'failed'; record.reason = 'exit'; record.exit.code = 1;
      record.session = { provider: adapter, id: 'synthetic-session' };
      db.prepare('UPDATE runs SET record=? WHERE id=?').run(JSON.stringify(record), index + 1);
      const folder = join(root, '.alpacawork/runs', record.id);
      mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'stdout.log'), '{}\n');
      assert.equal(agentLaunchSchema.safeParse(record.launch).success, true, 'exchanged identities are historical facts');
      assert.throws(() => compileAgentSetting(adapter, { params: {} }), /unavailable in this version/);
    }
  } finally { db.close(); }
  const store = RunStore.openReadable(root, { busyTimeoutMs: 0 })!;
  try { for (const [index, adapter] of retired.entries()) assert.equal(store.get(`R${index + 1}`)!.launch.adapter, adapter); }
  finally { store.close(); }
  const tree = await readControlTree(root);
  assert.deepEqual(tree.errors, []);
  for (const adapter of retired) assert.equal(tree.runs.find(run => run.agent === adapter)?.takesInput, false);
  const server = await isolatedServe(root);
  try {
    const listed = await cliRun(server.url, ['task', 'list']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).errors, []);
    for (const [index, adapter] of retired.entries()) {
      const task = await cliRun(server.url, ['task', 'get', '--task', `T${index + 2}`, '--runs', '10']);
      assert.equal(task.code, 0, task.stderr);
      const data = JSON.parse(task.stdout);
      assert.deepEqual(data.errors, []);
      assert.ok(data.runs.some(run => run.id === `R${index + 1}`));
      const run = await cliRun(server.url, ['run', 'get', '--run', `R${index + 1}`]);
      assert.equal(run.code, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.files[0].state, 'present');
      assert.ok(result.files[0].text.includes(`Synthetic result ${index + 1}`));
    }
  } finally { await server.stop(); }
});

test('retired settings report the kind and YAML line through config, screen errors and request refusal without writing', async t => {
  const root = workspace(t), path = join(root, 'config.yaml');
  const server = await startServer(root, 0);
  try {
    writeFileSync(path, 'agents:\n  retired-kind:\n    params: {}\n  custom:\n    adapter: unavailable-kind\n    params: {}\n');
    const combined = JSON.parse((await cliRun(server.url, ['config', 'get'])).stdout);
    assert.deepEqual(combined.error.reason.issues.map((issue: { line: number }) => issue.line), [3, 5]);
    assert.match(combined.error.message, /retired-kind.*unavailable in this version.*unavailable-kind.*unavailable in this version/);
    for (const adapter of retired) for (const alias of [false, true]) {
      const text = `# preserved by failed reads\nagents:\n  ${alias ? 'custom' : adapter}:\n${alias ? `    adapter: ${adapter}\n` : ''}    params: {}\n`;
      writeFileSync(path, text);
      const checked = checkAgentsConfigText(text);
      const issues: { line: number | null; message: string }[] = checked.issues;
      assert.equal(checked.agents, null);
      // An absent adapter points at the profile's mapping; an explicit one points at its scalar value.
      assert.ok(issues.some(issue => issue.line === 4 && issue.message.includes(adapter) && /unavailable in this version/.test(issue.message)));
      const settings = await readServerSettings(root);
      assert.equal(settings.error?.code, 'invalid_settings');
      assert.match(settings.error!.message, /unavailable in this version/);
      const tree = await readControlTree(root);
      assert.equal(tree.writable, false);
      assert.ok(tree.errors.some(error => error.message.includes(adapter)));
      const config = await cliRun(server.url, ['config', 'get']);
      assert.equal(config.code, 0, config.stderr);
      assert.match(config.stdout, /unavailable in this version/);
      const refused = await cliRun(server.url, ['task', 'request', '--task', 'T2', '--instruction-file', '-',
        '--expected-task-hash', tree.tasks.find(task => task.id === 'T2')!.hash,
        '--expected-placement-revision', String(tree.placements.find(placement => placement.taskId === 'T2')!.revision)], {}, 'Synthetic request');
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /unavailable in this version/);
      assert.equal(readFileSync(path, 'utf8'), text);
    }
  } finally { await server.close(); }
});

for (const phase of ['launch', 'recovery']) test(`an unfinished retired runtime ends as failed with an actionable reason during ${phase}`, async t => {
  const h = await setup(t);
  const run = h.create('plain', {}, { launch: { adapter: 'retired-kind', argv: ['/usr/bin/false'], path: h.path, values: {}, env: [] } });
  if (phase === 'launch') {
    await h.tick();
    await h.waitState(run, 'failed');
  } else {
    h.pauseProjection();
    const decision = await settleTransaction(h.store, readAgentsSettings(h.root));
    closeLaunches(decision.launches);
    const attempt = attemptOf(h.store, run.id)!;
    // A previously started provider is provably gone; no real provider or process is involved.
    h.store.connection.prepare('UPDATE run_attempts SET started_json=? WHERE attempt_id=?')
      .run(JSON.stringify({ pid: 2147483647, started: 'nonexistent', bootId: bootIdentity(), group: 2147483647, scope: null }), attempt.attemptId);
    h.store.write(tx => tx.update({ ...tx.get(run.id)!, state: 'needs_review', reason: 'manager_lost' }));
    assert.deepEqual(await recoverExecution(h.store), [run.id]);
  }
  const ended = h.store.get(run.id)!;
  assert.equal(ended.state, 'failed');
  assert.equal(ended.reason, 'launch');
  assert.notEqual(ended.ended_at, null);
  const result = readRunFiles(h.root, run.id, 'result');
  assert.equal(result.files[0]!.state, 'present');
  assert.match(result.files[0]!.text!, /retired-kind.*unavailable in this version/);
  assert.deepEqual((await readControlTree(h.root)).errors, []);
});
