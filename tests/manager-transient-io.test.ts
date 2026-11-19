/** Real command-directory failure: preserve its cause, stop this manager's agent, and never invent completion. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, until, alive, receipts } from './runs-runtime.fixture.ts';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { attemptOf } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { executionFolder } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { platform } from '@alpacawork/core';
import { isLive, processRows } from './helpers/process-groups.ts';

test('a non-directory command spool reports its cause, exits and reclaims only its agent group', async t => {
  const h = await setup(t); h.pauseProjection();
  const run = h.create('plain', { group: true });
  await h.tick();
  const pids = await until(() => {
    new RunEventImporter(h.store).pass();
    const latest = h.store.get(run.id)!;
    return latest.pids.agent && latest.pids.manager && receipts(h.root).length === 3 && latest.pids;
  }, 'this manager and its three-generation fake agent started');
  const ownedAgentPids = receipts(h.root).map(receipt => receipt.pid);
  assert(ownedAgentPids.includes(pids.agent!));
  const attempt = attemptOf(h.store, run.id)!, spool = executionFolder(h.root, run.id, attempt.attemptId);
  const commands = join(spool, 'commands');
  rmSync(commands, { recursive: true, force: true });
  writeFileSync(commands, 'not a directory');
  await until(() => !alive(pids.manager!), 'failed manager exits after its cleanup');
  const failure = readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8');
  assert.match(failure, /Run manager failed:.*ENOTDIR/s);
  assert(failure.includes(commands), 'the original failing path is reported');
  assert.equal(platform.run.signalGroup(pids.agent!, 0), false, 'this agent group has no live member');
  await until(() => { const rows = processRows(); return ownedAgentPids.every(pid => !rows.some(row => row.pid === pid && isLive(row))); }, 'all recorded test agent PIDs ended');
  new RunEventImporter(h.store).pass();
  const events = readdirSync(join(spool, 'events')).filter(name => /^\d{12}\.json$/.test(name))
    .map(name => JSON.parse(readFileSync(join(spool, 'events', name), 'utf8')));
  assert.equal(events.some(event => event.type === 'completed'), false);
  assert.equal(h.store.connection.prepare('SELECT completed_digest FROM run_attempts WHERE attempt_id=?').get(attempt.attemptId)!.completed_digest, null);
  assert.notEqual(h.store.get(run.id)!.state, 'succeeded');
});
