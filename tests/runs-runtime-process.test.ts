/** Real agent process groups: termination, launch and lost-manager recovery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLock } from '@alpacawork/core';
import { launchSnapshot, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { launch } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { alive, processes, receipts, setup, until } from './runs-runtime.fixture.ts';

// A timeout ends through the same termination as a stop; runs-runtime (f) checks it removes the whole group.
test('agent process group and stop cleanup', async t => {
  const h = await setup(t, { run_minutes: 0 }), clock = h.clock();
  const settings = readAgentsSettings(h.root); assert.ok(settings.ok);
  const snapshot = launchSnapshot(settings.config, 'plain', 'start', h.path); assert.ok(snapshot.ok);
  const run = h.create('plain', { group: true, stubborn: true }, { launch: snapshot.launch });
  await h.tick(); const receipt = await h.ready(run);
  const family = await until(() => { const rs = receipts(h.root); return rs.length === 3 && rs; }, 'three generations ready');
  const agent = processes(h.root).find(p => p.pid === receipt.pid)!;
  assert.equal(agent.pgid, receipt.pid);
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, stop_requested: true }));
  await until(() => existsSync(join(h.root, 'term-grandchild')), 'grandchild received SIGTERM');
  await clock.advanceTo(9_999);
  assert.ok(alive(family.find(r => r.branch === 'grandchild')!.pid), 'SIGKILL waits for the ten-second grace');
  await clock.advanceTo(10_000);
  const ended = await h.waitState(run, 'cancelled', 18_000);
  assert.equal(ended.reason, 'stopped');
  await until(() => family.every(r => !alive(r.pid)) && !alive(receipt.pid, true), 'all agent descendants and their group gone');
});

test('normal start, resume and nonzero exit', async t => {
  const h = await setup(t);
  const settings = readAgentsSettings(h.root); assert.ok(settings.ok);
  const launch = launchSnapshot(settings.config, 'plain', 'start', h.path);
  assert.ok(launch.ok);
  const snapshot = { ...launch.launch };
  const original = h.create('plain', { gate: h.gate('start'), output: 'accepted' }, { launch: snapshot });
  await h.tick(); const receipt = await h.ready(original);
  assert.equal(processes(h.root).find(p => p.pid === receipt.pid)!.pgid, receipt.pid);
  h.release('start'); await h.waitState(original, 'succeeded');
  assert.equal(h.store.getText(original.id)?.result, 'accepted');
  const originalSession = h.store.get(original.id)!.session;
  for (const exit of [0, 7]) {
    const resume = launchSnapshot(settings.config, 'plain', 'resume', h.path, {}, snapshot); assert.ok(resume.ok);
    const resumed = { ...snapshot, argv: resume.launch.argv };
    const run = h.create('plain', { exit, gate: h.gate(`resume-${exit}`) }, { resumes: original.id, session: originalSession, launch: resumed });
    await h.tick(); const receipt = await h.ready(run);
    assert.equal(processes(h.root).find(p => p.pid === receipt.pid)!.pgid, receipt.pid);
    h.release(`resume-${exit}`); const ended = await h.waitState(run, exit ? 'failed' : 'succeeded');
    assert.equal(ended.reason, exit ? 'exit' : null);
    assert.equal(ended.exit!.code, exit);
  }
});
test('graceful stop preserves manager outcome and other runs', async t => {
  const h = await setup(t);
  const settings = readAgentsSettings(h.root); assert.ok(settings.ok);
  const snapshot = launchSnapshot(settings.config, 'plain', 'start', h.path); assert.ok(snapshot.ok);
  const run = h.create('plain', { group: true }, { launch: snapshot.launch });
  const other = h.create('plain', { gate: h.gate('other') },
    { role: 'worker', placementId: h.memberPlacementId });
  await h.tick(); const receipt = await h.ready(run); const otherReceipt = await h.ready(other);
  await until(() => receipts(h.root).length === 4, 'both agents and descendants ready');
  const family = receipts(h.root).filter(r => r.pid !== otherReceipt.pid);
  assert.ok(family.every(r => r.pgid === receipt.pid), 'all three generations share the agent process group');
  const started = performance.now();
  h.store.write(tx => tx.update({ ...tx.get(run.id)!, stop_requested: true }));
  const ended = await h.waitState(run, 'cancelled', 5000);
  assert.equal(ended.reason, 'stopped');
  await until(() => family.every(r => !alive(r.pid)) && !alive(receipt.pid, true), 'graceful family and group gone');
  assert.ok(performance.now() - started < 5000, 'a cooperative process group stops within a few seconds');
  assert.ok(alive(otherReceipt.pid));
  h.release('other'); await h.waitState(other, 'succeeded');
});

test('an unreconciled temporary reply stops launch and stays available for review', async t => {
  const h = await setup(t), run = h.create('own');
  writeFileSync(join(h.store.folder(run.id), 'result.tmp'), 'uncommitted reply');
  await h.tick();
  await until(() => readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8').includes('requires review'), 'manager refused old output');
  await until(() => { const fd = openRunFile(h.store.folder(run.id), 'manager.lock', constants.O_RDWR);
    try { return tryLock(fd); } finally { closeSync(fd); } }, 'manager lock released');
  await h.tick();
  assert.equal(h.store.get(run.id)?.state, 'needs_review');
  assert.equal(h.store.getText(run.id)?.result, null);
  assert.equal(readFileSync(join(h.store.folder(run.id), 'result.tmp'), 'utf8'), 'uncommitted reply');
  assert.equal(receipts(h.root).length, 0);
});

test('a lost manager never invents a successful exit from output after the group ends', async t => {
  const h = await setup(t);
  const owner = h.create('claude', { gate: h.gate('owner'), output: 'owner reply' });
  const worker = h.create('claude', { gate: h.gate('worker'), exit: 3 }, { role: 'worker', placementId: h.memberPlacementId });
  await h.tick();
  const pids = await Promise.all([owner, worker].map(async run => {
    await h.ready(run);
    return h.store.get(run.id)!.pids;
  }));
  for (const { manager } of pids) process.kill(manager!, 'SIGKILL');
  await until(() => pids.every(({ manager }) => !alive(manager!)), 'managers gone');
  assert.deepEqual((await h.tick()).lost.sort(), [owner.id, worker.id].sort());
  assert.deepEqual((await h.tick()).closed, [], 'a live agent group keeps its Run for a person');
  assert.equal(h.store.get(owner.id)!.state, 'needs_review');

  h.release('owner'); h.release('worker');
  await until(() => pids.every(({ agent }) => !alive(agent!, true)), 'agent groups gone');
  assert.deepEqual((await h.tick()).closed.sort(), [owner.id, worker.id].sort());
  for (const run of [owner, worker]) {
    const held = h.store.get(run.id)!;
    assert.equal(held.state, 'failed');
    assert.equal(held.reason, 'exit');
    assert.equal(held.exit, null);
  }
  assert.equal(h.store.getText(owner.id)?.result, 'owner reply', 'the orphan reply is preserved without inventing a successful exit');
  assert.equal(h.store.getText(worker.id)?.resultState, 'missing');
  await h.pass();
});
