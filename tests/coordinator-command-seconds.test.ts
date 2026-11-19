import { installAgentStub } from './helpers/agent-stub.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { platform, processIdentity } from '@alpacawork/core';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { runScope } from '@alpacawork/backend/test-dist/runs/launch-agent.js';
import { executionFolder, names } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { setup, until } from './runs-runtime.fixture.ts';
import { setTimeout as delay } from 'node:timers/promises';
const live = (pid: number) => platform.run.started(pid) !== null;
const fixture = join(import.meta.dirname, 'fixtures/command-session-agent.mjs');

// Launches branch on coordinator or not; an owner stands for every Task Run.
for (const role of ['coordinator', 'owner'] as const) test(`manager applies command seconds only to ${role}`, { timeout: 20000 }, async t => {
  const h = await setup(t, { coordinator_command_seconds: 2 });
  installAgentStub(h.root, 'alpacawork-agent', [process.execPath, fixture]);
  writeFileSync(join(h.root, 'config.yaml'), stringify(h.config));
  const plan = Object.fromEntries(['ready', 'short', 'away', 'finish'].map(key => [key, join(h.root, key)]));
  const run = role === 'coordinator' ? h.createCoordinator(plan) : h.create('plain', plan);
  await h.tick();
  await until(() => existsSync(plan.ready), 'fixture ready');
  const pids = JSON.parse(readFileSync(plan.ready, 'utf8'));
  const away = Number(readFileSync(plan.away, 'utf8'));
  // Cleanup owns only the PIDs recorded by this fixture, including reparented sessions outside the root group.
  t.after(() => { for (const pid of [pids.resident, pids.command, away]) {
    try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {}
  } });
  const launch = attemptOf(h.store, run.id)!;
  assert.equal(launch.commandSeconds, role === 'coordinator' ? 2 : null);
  const initialScope = runScope(h.root, run.id, processIdentity(pids.root).scope);
  if (role === 'coordinator') {
    // Changing settings while running cannot change the reserved limit.
    h.config.limits.coordinator_command_seconds = 30;
    writeFileSync(join(h.root, 'config.yaml'), stringify(h.config));
    await until(() => !live(pids.command), 'long session killed', 8000);
    if (initialScope !== null) await until(() => !live(away), 'reparented session killed');
    else t.diagnostic('no scope: reparented session is outside the fallback descendant tree');
    assert.ok(live(pids.root)); assert.ok(live(pids.resident));
    const spool = executionFolder(h.root, run.id, launch.attemptId);
    // A live journal can contain unpublished temporary files; use its canonical listing.
    const unpublished = join(spool, 'events', 'tmp-unpublished');
    writeFileSync(unpublished, '{partial');
    const commandStopped = () => names(join(spool, 'events')).map(name => JSON.parse(readFileSync(join(spool, 'events', name), 'utf8')))
      .filter(event => event.type === 'command_stopped');
    // The command dies a moment before the watch records its KILL.
    await until(() => commandStopped().some(event => event.payload.signal === 'SIGKILL'), 'the KILL is recorded', 8000);
    const stopped = commandStopped();
    unlinkSync(unpublished);
    assert.ok(stopped.some(event => event.payload.signal === 'SIGTERM'));
    assert.ok(stopped.some(event => event.payload.signal === 'SIGKILL'));
    assert.ok(stopped.every(event => !event.payload.pids.includes(pids.resident) && !event.payload.pids.includes(pids.root) && !event.payload.pids.includes(pids.short)));
  } else {
    await delay(4200); assert.ok(live(pids.command)); assert.ok(live(pids.resident));
  }
  assert.deepEqual(JSON.parse(readFileSync(plan.short, 'utf8')), { code: 0, signal: null });
  writeFileSync(plan.finish, 'finish');
  await h.waitState(run, 'succeeded'); await h.waitExchangeCleanup(run);
});

test('a launch recorded before command limits still reads, without a limit', async t => {
  const h = await setup(t);
  const run = h.createCoordinator({});
  await h.tick();
  const launch = attemptOf(h.store, run.id)!;
  const { commandSeconds: _, ...recorded } = JSON.parse(String(h.store.connection.prepare('SELECT launch_json FROM run_attempts WHERE attempt_id=?').get(launch.attemptId)!.launch_json));
  h.store.connection.prepare('UPDATE run_attempts SET launch_json=? WHERE attempt_id=?').run(JSON.stringify(recorded), launch.attemptId);
  assert.equal(attemptOf(h.store, run.id)!.commandSeconds, undefined);
});
