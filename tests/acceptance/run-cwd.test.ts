import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { cli, cliEntry, execute, fake, http, setup, until } from './harness.ts';

test('new conversations choose cwd; continuations keep it; invalid cwd is rejected at CLI and HTTP', async t => {
  const h = await setup(t, 1);
  assert.ok(h.task && h.placement);
  const settings = readAgentsSettings(h.root);
  assert.equal(settings.ok, true);
  if (!settings.ok) return;
  assert.equal(settings.config.agents.fake.adapter, 'claude');
  assert.match(readFileSync(fake, 'utf8'), /Fake agent requires an isolated temporary alpacawork root/);
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-worktree-')));
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-worktree-')));
  t.after(() => { rmSync(worktree, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const restricted = { env: { PATH: '/usr/bin:/bin' } };
  const bodyFile = join(worktree, 'instruction.md');
  writeFileSync(bodyFile, 'Synthetic work only');
  const currentTask = async () => {
    const current=await cli(h.root,'task get',{task:h.task!.id},restricted);assert.equal(current.code,0,current.stderr);return current.body.task;
  };
  // The fake agent reports nothing, so each Run's end errs the Task; the next instruction retries it.
  const settled=()=>until(async()=>{const task=await currentTask();return task.state==='error'&&task},'the Run that ended without a report errs its task');
  const sent = async (options: Record<string, string> = {}) => {
    const task=h.records().length?await settled():await currentTask();
    return cli(h.root, 'task request', { task: h.task!.id, 'instruction-file': bodyFile, 'op-id': randomUUID(),
      'expected-task-hash': task.hash, 'expected-placement-revision': String(h.placement!.revision), ...options }, restricted);
  };
  const accepted = async (options: Record<string, string> = {}) => {
    const answer = await sent(options);
    assert.equal(answer.code, 0, answer.stderr);
    const run = await h.waitState(answer.body.outcome.request.runId, 'succeeded');
    return run;
  };

  const defaultRun = await accepted();
  assert.equal(defaultRun.cwd, h.root);
  assert.equal(defaultRun.launch.argv[0], join(defaultRun.launch.path, 'claude'));
  assert.equal(defaultRun.launch.path, join(process.env.HOME!, 'acceptance-bin'), 'only the fixture HOME supplies executables');
  const executable = readFileSync(join(defaultRun.launch.path, 'claude'), 'utf8');
  assert.ok(executable.startsWith(`#!${process.execPath}\n`));
  assert.ok(executable.includes(JSON.stringify(fake)));
  const selected = await accepted({ 'new-conversation': '', cwd: worktree });
  assert.equal(selected.cwd, worktree);
  const agent = JSON.parse(readFileSync(join(h.root, 'processes', `${selected.pids.agent}.json`), 'utf8'));
  assert.equal(agent.cwd, worktree);
  assert.equal(agent.env.ALPACAWORK_WORKSPACE, h.root);
  assert.equal(agent.env.ALPACAWORK_RUN, selected.id);
  assert.equal(agent.env.PATH, process.env.PATH);
  const app = await h.server();
  const expired = await execute(worktree, cliEntry, ['--server', app.url, 'task', 'get', '--task', h.task.id], agent.env).done;
  assert.equal(expired.code, 2);
  assert.equal(expired.body.error.code, 'forbidden');
  const directEnv = { ...agent.env };
  delete directEnv.ALPACAWORK_RUN;
  delete directEnv.ALPACAWORK_RUN_TOKEN;
  const inner = await execute(worktree, cliEntry, ['--server', app.url, 'task', 'get', '--task', h.task.id], directEnv).done;
  assert.equal(inner.code, 0, inner.stderr);
  assert.equal(JSON.parse(inner.stdout).task.id, h.task.id);
  const continued = await accepted();
  assert.equal(continued.resumes, selected.id);
  assert.equal(continued.cwd, worktree);
  assert.equal(continued.launch.argv[0], defaultRun.launch.argv[0]);
  assert.equal(continued.launch.path, defaultRun.launch.path);

  const before = h.records().length;
  const mismatch = await sent({ cwd: other });
  assert.equal(mismatch.code, 2);
  assert.equal(mismatch.body.error.code, 'invalid_input');
  assert.equal(mismatch.body.error.issues[0].path, 'cwd');
  assert.match(mismatch.body.error.message, /previous Run directory/);
  assert.equal(h.records().length, before);

  const httpNew = await http(app.url, 'task/request', {
    task: h.task.id, expectedTaskHash: (await settled()).hash, body: 'HTTP new conversation', opId: randomUUID(),
    expectedPlacementRevision: h.placement.revision,
    newConversation: true, cwd: other });
  assert.equal(httpNew.status, 200, JSON.stringify(httpNew.body));
  const httpRun = await h.waitState(httpNew.body.outcome.request.runId, 'succeeded');
  assert.equal(httpRun.cwd, other);
  const rootAgain = await http(app.url, 'task/request', {
    task: h.task.id, expectedTaskHash: (await settled()).hash, body: 'Explicit root', opId: randomUUID(),
    expectedPlacementRevision: h.placement.revision,
    newConversation: true, cwd: h.root });
  assert.equal(rootAgain.status, 200, JSON.stringify(rootAgain.body));
  const rootRun = await h.waitState(rootAgain.body.outcome.request.runId, 'succeeded');
  assert.equal(rootRun.cwd, h.root);

  const nested = join(h.root, 'nested'); mkdirSync(nested);
  for (const cwd of ['relative', join(worktree, 'missing'), bodyFile, nested]) {
    const rejected = await http(app.url, 'task/request', {
      task: h.task.id, expectedTaskHash: (await settled()).hash, body: 'Invalid directory', opId: randomUUID(),
      expectedPlacementRevision: h.placement.revision,
      newConversation: true, cwd });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    assert.equal(rejected.body.error.code, 'invalid_input');
    assert.equal(rejected.body.error.issues[0].path, 'cwd');
  }
  assert.equal(h.records().length, before + 2);
  h.integrity();
});
