/** Real manager and journal, using a synthetic bridge and no control database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processIdentity } from '@alpacawork/core';
import { protocolFingerprint } from '@alpacawork/contract/run-protocol';
import { agentEnvironment } from '@alpacawork/backend/test-dist/runs/env.js';
import { executionFolder, publishLaunch } from '@alpacawork/backend/test-dist/runs/execution-files.js';

for (const resultCase of ['present', 'missing'] as const) test(`manager journals a synthetic bridge receipt and ${resultCase} reply`, { timeout: 15000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-manager-'));
  const id = 'R1', attempt = randomUUID(), inputId = randomUUID();
  const runFolder = join(root, '.alpacawork', 'runs', id);
  mkdirSync(runFolder, { recursive: true });
  const agent = fileURLToPath(new URL('./fixtures/stage3-runtime-agent.mjs', import.meta.url));
  const entry = join(root, 'manager.mjs');
  const managerModule = fileURLToPath(new URL('../apps/backend/test-dist/runs/manager.js', import.meta.url));
  writeFileSync(entry, `import {manageRun} from ${JSON.stringify(pathToFileURL(managerModule).href)}; await manageRun(...process.argv.slice(2));\n`);
  const launch = { protocol: 1 as const, workspaceId: randomUUID(), runId: id, attemptId: attempt, cwd: root,
    invocation: { mode: 'start' as const, session: null, launch: { adapter: 'codex' as const,
      argv: [process.execPath, agent, '{result}', resultCase], path: process.env.PATH!, values: {}, env: ['ADAPTER_FIXTURE', 'ADAPTER_FIXTURE_ROOT'] } },
    prompt: 'synthetic instruction', initialInputId: inputId, format: protocolFingerprint(), runMinutes: 0,
    commandSeconds: null, credential: 'a'.repeat(64), entry, version: 'synthetic', server: null, ancestors: [], release: null };
  publishLaunch(root, launch);
  const lock = openSync(join(runFolder, 'manager.lock'), 'w+');
  const source = { ...process.env, ADAPTER_FIXTURE: 'allowed', ADAPTER_FIXTURE_ROOT: root, ADAPTER_HIDDEN: 'forbidden' };
  const env = agentEnvironment(source, process.env.PATH!, undefined, launch.invocation.launch.env);
  const manager = spawn(process.execPath, [entry, root, id, attempt], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', lock] });
  closeSync(lock);
  let stderr = '';
  manager.stderr!.on('data', b => { stderr += String(b); });
  manager.stdout!.resume();
  const ended = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => manager.once('close', (code, signal) => resolve({ code, signal })));
  const identity = processIdentity(manager.pid!);
  t.diagnostic(`manager identity: ${JSON.stringify(identity)}`);
  const watchdog = setTimeout(() => {
    try { const current = processIdentity(manager.pid!);
      if (current.started === identity.started && current.bootId === identity.bootId) manager.kill('SIGKILL');
    } catch { /* Already exited. */ }
  }, 10000);
  try {
    const status = await ended;
    assert.deepEqual(status, { code: 0, signal: null }, stderr);
    const spool = executionFolder(root, id, attempt);
    const events = readdirSync(join(spool, 'events')).sort().map(name => JSON.parse(readFileSync(join(spool, 'events', name), 'utf8')));
    const agentIdentity = events.find(event => event.type === 'started')?.payload;
    assert.ok(agentIdentity); t.diagnostic(`agent identity: ${JSON.stringify(agentIdentity)}`);
    assert.equal(events.find(event => event.type === 'input_attempt')?.payload.inputId, inputId);
    assert.equal(events.find(event => event.type === 'input_taken')?.payload.inputId, inputId);
    const completion = events.find(event => event.type === 'completed').payload;
    if (resultCase !== 'present') {
      assert.deepEqual(completion.outcome, { state: 'failed', reason: 'output' });
      assert.equal(completion.result.state, resultCase);
    } else {
      assert.equal(completion.outcome.state, 'succeeded');
      const result = JSON.parse(readFileSync(join(spool, 'results', `${completion.result.digest}.bin`), 'utf8'));
      assert.deepEqual(result, { allowed: 'allowed', run: id, argv: [] });
    }
  } finally {
    clearTimeout(watchdog);
    if (manager.exitCode === null && manager.signalCode === null) {
      const current = processIdentity(manager.pid!);
      if (current.started === identity.started && current.bootId === identity.bootId) manager.kill('SIGKILL');
      await ended;
    }
    // If the manager failed before cleanup, signal only the recorded agent incarnation.
    const eventsPath = join(executionFolder(root, id, attempt), 'events');
    try {
      const started = readdirSync(eventsPath).map(name => JSON.parse(readFileSync(join(eventsPath, name), 'utf8')))
        .find(event => event.type === 'started')?.payload;
      if (started) {
        const current = processIdentity(started.pid);
        if (current.started === started.started && current.bootId === started.bootId && current.group === started.pid)
          process.kill(-started.pid, 'SIGKILL');
      }
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    rmSync(root, { recursive: true, force: true });
  }
});
