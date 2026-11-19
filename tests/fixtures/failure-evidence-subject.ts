/** Deliberate child failures let the parent inspect evidence after real fixture teardown. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setup as acceptance } from '../acceptance/harness.ts';
import { setup as runtime, until } from '../runs-runtime.fixture.ts';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { preserveTestFailure } from '../helpers/failure-workspace.ts';

const { kind, fault, fail, live, closed, report } = JSON.parse(process.env.ALPACAWORK_EVIDENCE_SUBJECT!);
test(`evidence subject ${kind}`, async t => {
  const h = await (kind === 'acceptance' ? acceptance(t) : runtime(t));
  if (live && 'pauseProjection' in h) h.pauseProjection();
  const run = 'seed' in h ? h.seed() : h.create('plain', live ? { gate: h.gate('capture') } : {});
  const store = 'getStore' in h ? h.getStore() : h.store;
  mkdirSync(store.folder(run.id), { recursive: true });
  writeFileSync(join(store.folder(run.id), 'manager.log'), 'pre-teardown diagnostic');
  if (live && 'server' in h) await h.server();
  writeFileSync(join(h.root, 'before-cleanup.txt'), 'subject still exists');
  writeFileSync(report, JSON.stringify({ root: h.root, run: run.id }));
  // A failing after hook can skip later hooks; observe actual cleanup on child exit.
  process.once('exit', () => writeFileSync(report, JSON.stringify({ root: h.root, run: run.id,
    removed: !existsSync(h.root) })));
  if (fault) {
    const original = fs.copyFileSync;
    fs.copyFileSync = (from, to, ...args) => {
      if (String(to).endsWith('/runtime-raw/config.yaml')) throw new Error('injected config copy fault');
      return original(from, to, ...args);
    };
    syncBuiltinESMExports();
    t.after(() => { fs.copyFileSync = original; syncBuiltinESMExports(); });
  }
  if (live && 'pauseProjection' in h) {
    const app = await startServer(h.root, 0);
    try {
      await until(() => h.store.runtimeGet(run.id)?.pids.agent, 'live capture subject manager starts');
      if (fail) assert.fail(`original ${kind} failure before teardown`);
    } catch (error) {
      await preserveTestFailure(t, h.root, { failure: { error }, origin: app.url,
        diagnostics: () => ({ task: new TaskRepository(h.root, h.store.connection).get(h.taskId), snapshot: h.store.snapshot(),
          callerError: error, serverStillOpen: true }) });
      throw error;
    } finally { await app.close(); }
  } else if (fail) {
    if (closed && 'pauseProjection' in h) { h.pauseProjection(); h.store.close(); }
    assert.fail(`original ${kind} failure before teardown`);
  }
});
