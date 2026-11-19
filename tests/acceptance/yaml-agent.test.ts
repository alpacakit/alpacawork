import { fixtureAgentSetting, installAgentStub } from '../helpers/agent-stub.ts';
import { stringify } from 'yaml';
/** YAML-only shell agents enter through format 2 Placement and Request. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { alive, cli, http, setup, until } from './harness.ts';

async function local(t: TestContext, sessionAgent = false) {
  const h = await setup(t, 4, false);
  const initialized = await cli(h.root, 'workspace init');
  assert.equal(initialized.code, 0, initialized.stderr);
  // A new workspace has one project, T1, where a person's Task goes when it names no parent.
  const created = await cli(h.root, 'task new', { title: 'Local reviewer' });
  assert.equal(created.code, 0, created.stderr);
  const task = created.body.task;
  installAgentStub(h.root, 'claude', [process.execPath,
    resolve('tests/fixtures/local-reviewer-adapter.mjs'), h.root, resolve('tests/fixtures/local-reviewer.sh')]);
  // The shell reviewer needs only these utilities. Both provider entry names
  // are local stubs; no inherited/system PATH is available to the manager.
  process.env.PATH = join(h.root, 'agent-bin');
  for (const command of ['ps', 'mkdir', 'sed', 'sleep'])
    symlinkSync(`/bin/${command}`, join(process.env.PATH, command));
  const definitions = stringify({ 'local-reviewer': fixtureAgentSetting('claude'), 'local-reviewer-s': fixtureAgentSetting('claude') });
  // Append beneath the existing agents map, retaining the product-generated built-ins.
  appendFileSync(join(h.root, 'config.yaml'), definitions.split('\n').filter(Boolean).map(line => '  ' + line).join('\n') + '\n');
  const people = new PlacementStore(h.root);
  const placement = people.place({ taskId: task.id, agentId: people.createAgent('Local reviewer').id,
    profileKey: sessionAgent ? 'local-reviewer-s' : 'local-reviewer', responsible: true });
  people.close();
  const start = async (body: string, mode: 'new' | 'continue' = 'new') => {
    const bodyFile = join(h.root, `request-${randomUUID()}.md`);
    writeFileSync(bodyFile, body);
    const head = h.records().filter(run => run.placementId === placement.id).at(-1);
    const current = await cli(h.root, 'task get', { task: task.id });
    const input = { task: task.id, 'instruction-file': bodyFile, 'op-id': randomUUID(),
      'expected-task-hash': current.body.task.hash, 'expected-placement-revision': String(placement.revision),
      ...(head ? { 'expected-head-run': head.id } : {}),
      ...(mode === 'new' && head ? { 'new-conversation': '' } : {}) };
    const submitted = await cli(h.root, 'task request', input);
    assert.equal(submitted.code, 0, submitted.stderr);
    return h.getStore().get(submitted.body.outcome.request.runId)!;
  };
  /** The reviewer reports nothing, so its Run's end errs the Task; the next instruction retries it. */
  const retry = async (body: string, mode: 'new' | 'continue') => {
    await until(async () => {
      const current = await cli(h.root, 'task get', { task: task.id });
      return current.code === 0 && current.body.task.state === 'error';
    }, 'the Run that ended without a report errs its task');
    return start(body, mode);
  };
  const result = (id: string) => h.getStore().getText(id)!.result!;
  const localReceipts = () => existsSync(join(h.root, 'local-processes')) ? readdirSync(join(h.root, 'local-processes')).map(name => {
    const [session, mode, ...prompt] = readFileSync(join(h.root, 'local-processes', name), 'utf8').trimEnd().split('\n');
    return { pid: Number(name), session, mode, prompt: prompt.join('\n') };
  }) : [];
  return { ...h, task, placement, start, retry, result, localReceipts };
}

test('E: YAML shell profile and responsible Placement are visible before any Request', async t => {
  const h = await local(t), app = await h.server();
  const tree = await http(app.url, 'workspace/live');
  assert.equal(tree.status, 200);
  assert.ok(tree.body.profiles.some((profile: { key: string }) => profile.key === 'local-reviewer'));
  const placement = tree.body.placements.find((item: { id: string }) => item.id === h.placement.id);
  assert.deepEqual([placement?.taskId, placement?.profileKey, placement?.responsible, placement?.active],
    [h.task.id, 'local-reviewer', true, true]);
  assert.deepEqual(h.records(), []);
});

test('E: appended YAML shell profile survives settings saves and handles success and failure', async t => {
  const h = await local(t), app = await h.server();
  const settings = await http(app.url, 'config/get');
  const saved = await http(app.url, 'config/set', { config: JSON.stringify({ limits: settings.body.limits }),
    agents: settings.body.agentsText, expectedConfigHash: settings.body.hash });
  assert.equal(saved.status, 200);
  const tree = await http(app.url, 'workspace/live'); assert.equal(tree.status, 200);
  assert.deepEqual(tree.body.profiles.map((profile: { key: string }) => profile.key), ['claude', 'codex', 'local-reviewer', 'local-reviewer-s']);
  const placement = tree.body.placements.find((item: { id: string }) => item.id === h.placement.id);
  assert.deepEqual([placement?.taskId, placement?.profileKey, placement?.responsible, placement?.active],
    [h.task.id, 'local-reviewer', true, true]);
  const run = await h.start('review this'); await h.waitState(run.id, 'succeeded');
  assert.equal(run.launch.adapter, 'claude');
  assert.match(h.result(run.id), /review this/);
  const failed = await h.retry('fail', 'new'); const ended = await h.waitState(failed.id, 'failed');
  assert.equal(ended.reason, 'exit'); assert.deepEqual(ended.exit, { code: 7, signal: null });
  assert.equal(readFileSync(join(h.getStore().folder(failed.id), 'stderr.log'), 'utf8'), 'local reviewer rejected the prompt\n');
  assert.equal(h.localReceipts().length, 2); h.integrity();
});

test('E: YAML-only shell agent stop terminates its background process group', async t => {
  const h = await local(t), run = await h.start('long');
  await until(() => existsSync(h.gate('local-child')), 'shell background child');
  const child = Number(readFileSync(h.gate('local-child'), 'utf8'));
  const running = await until(() => { const r = h.getStore().get(run.id)!; return r.pids.agent && r; }, 'shell pid');
  assert.equal(alive(child), true);
  const stop = await cli(h.root, 'run stop', { run: run.id }); assert.equal(stop.code, 0, stop.stderr);
  const cancelled = await h.waitState(run.id, 'cancelled'); assert.equal(cancelled.reason, 'stopped');
  await until(() => !alive(child) && !alive(running.pids.agent!, true), 'whole shell group gone');
  assert.equal(h.localReceipts().length, 1); h.integrity();
});

test('E: YAML session and continuation use the responsible Placement head', async t => {
  const h = await local(t, true), started = await h.start('first review');
  const parent = await h.waitState(started.id, 'succeeded');
  assert.ok(parent.session);
  const next = await h.retry('reply review', 'continue');
  const ended = await h.waitState(next.id, 'succeeded');
  assert.deepEqual(ended.session, parent.session);
  assert.equal(ended.resumes, parent.id);
  assert.match(h.result(next.id), /reply review/);
  assert.deepEqual(h.localReceipts().map(r => r.session), [parent.session.id, parent.session.id]);
  h.integrity();
});
