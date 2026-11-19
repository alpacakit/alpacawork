import { installAgentStub } from './helpers/agent-stub.ts';
/** Exercise the actual manager and recovery against Linux scopes, with bounded synthetic agents only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { platform, processRows, isLiveProcess } from '@alpacawork/core';
import { launch, settleTransaction, settle } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { requestStop } from '@alpacawork/backend/test-dist/runs/entry.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { recoverExecution } from '@alpacawork/backend/test-dist/runs/recovery.js';
import { stringify } from 'yaml';
import { setup, until } from './runs-runtime.fixture.ts';
import { backendBundleWith } from './helpers/backend-bundle.ts';

const runtime = `/run/user/${process.getuid?.()}`;
const env = { ...process.env, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
const scoped = process.platform === 'linux' && spawnSync('systemd-run',
  ['--user', '--scope', '--quiet', '--collect', '--', 'true'], { env, stdio: 'ignore', timeout: 5000 }).status === 0;
const gone = (pid: number) => !processRows().some(p => p.pid === pid && isLiveProcess(p));
type Receipt = { agent: number; away: number; scope: string };
const journalMarker = 'var EventJournal = class';
const journalBundle = pathToFileURL(backendBundleWith(resolve('.'), journalMarker)).href;

// The manager and recovery clean a Run's scope the same way whatever its role, so every ending runs for an owner. A
// worker is placed as its own Run, and a coordinator is stopped by its own flag and watches its commands: one each.
const cases = [...(['natural', 'stop', 'fault', 'lost', 'lost-refused'] as const).map(ending => ({ role: 'owner' as const, ending })),
  { role: 'worker' as const, ending: 'natural' as const }, { role: 'coordinator' as const, ending: 'stop' as const }];
for (const { role, ending } of cases) {
  {
    test(`${role} ${ending}: completion reclaims detached commands and preserves another Run scope`,
      { skip: scoped ? false : 'Linux user systemd is unavailable; real scope cleanup not exercised', timeout: 25_000 }, async t => {
        const h = await setup(t);
        if (ending.startsWith('lost')) h.pauseProjection();
        installAgentStub(h.root, 'alpacawork-agent', [process.execPath, resolve('tests/fixtures/run-unit-agent.mjs'), h.root]);
        const run = role === 'coordinator' ? h.createCoordinator({ id: 'subject' }) :
          role === 'worker' ? h.createIndependent('plain', { id: 'subject' }) : h.create('plain', { id: 'subject' });
        const other = h.createIndependent('plain', { id: 'foreign' });
        const script = join(h.root, 'scope-manager.mjs');
        // Instrument the emitted class the real manager imports, not a separate test-dist class.
        const injection = `
          import { existsSync as fixtureScopeExists } from 'node:fs';
          const fixtureJournalAppend = EventJournal.prototype.append;
          EventJournal.prototype.append = function(type, payload) {
            const event = fixtureJournalAppend.call(this, type, payload);
            if (${JSON.stringify(ending)} === 'fault' && process.argv[3] === ${JSON.stringify(run.id)} && type === 'input_taken') {
              const deadline = Date.now() + 5000;
              while (!fixtureScopeExists(${JSON.stringify(join(h.root, 'subject-fault-ready'))})) {
                if (Date.now() > deadline) throw new Error('synthetic scope observation deadline');
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
              }
              throw new Error('injected observation failure after detached command starts');
            }
            return event;
          };
        `;
        writeFileSync(script, `
          import { registerHooks } from 'node:module';
          let instrumented = false;
          registerHooks({ load(url, context, next) {
            const result = next(url, context);
            if (url !== ${JSON.stringify(journalBundle)}) return result;
            const source = String(result.source);
            if (source.split(${JSON.stringify(journalMarker)}).length !== 2)
              throw new Error('Expected exactly one emitted EventJournal class');
            instrumented = true;
            return { ...result, source: source + ${JSON.stringify(injection)} };
          } });
          await import(${JSON.stringify(journalBundle)});
          if (!instrumented) throw new Error('Expected EventJournal module was not instrumented');
          await import(${JSON.stringify(new URL('../apps/backend/dist/run-manager.js', import.meta.url).href)});
        `);
        const before = { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
        try {
          // The scheduler uses the host environment to place each manager in its own scope.
          Object.assign(process.env, { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS });
          await launch(h.store, await settleTransaction(h.store, readAgentsSettings(h.root)), { script });
        } finally {
          for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        const receipt = async (id: string) => {
          const path = join(h.root, `${id}-unit.json`);
          await until(() => existsSync(path), `${id} detached command ready`);
          return JSON.parse(readFileSync(path, 'utf8')) as Receipt;
        };
        const own = await receipt('subject'), foreign = await receipt('foreign');
        t.diagnostic(JSON.stringify({ role, ending, own, foreign }));
        assert.notEqual(own.scope, foreign.scope, 'the other Run owns a different scope');
        assert.match(own.scope, /alpacawork-run-.*\.scope/);
        assert.notEqual(own.agent, own.away, 'the detached command leads a different group');
        assert.equal(platform.run.commandProcesses(own.away, null).find(p => p.pid === own.away)?.session, own.away);
        // Input has reached the agent; fault cleanup waits until the test observes the live scope/session.
        if (ending === 'fault') {
          t.diagnostic('both receipts and scope/session liveness checked; releasing observation fault');
          h.release('subject-fault-ready');
        }
        if (ending === 'natural') h.release('subject-finish');
        if (ending === 'stop') {
          if (role === 'coordinator') h.store.write(tx => tx.update({ ...tx.runtimeGet(run.id)!, stop_requested: true }));
          else requestStop(h.root, { run: run.id });
        }
        if (ending.startsWith('lost')) {
          new RunEventImporter(h.store).pass();
          const manager = h.store.runtimeGet(run.id)!.pids.manager!;
          process.kill(manager, 'SIGKILL');
          await until(() => gone(manager), 'lost manager exits');
          // Recovery sees a vanished agent group, but still must reclaim what escaped it.
          platform.run.signalGroup(own.agent, 'SIGKILL');
          await until(() => gone(own.agent), 'agent group exits');
          if (ending === 'lost-refused') {
            const stop = t.mock.method(platform.run, 'stopUnitOthers', async recorded => {
              assert.ok(recorded);
              assert.equal(recorded.scope, own.scope.trim());
              const unit = /\/([^/]+)\.scope/.exec(own.scope)![1]!;
              assert.equal(recorded.ours(unit), true);
              assert.equal(recorded.ours(/\/([^/]+)\.scope/.exec(foreign.scope)![1]!), false);
              throw new Error('injected scope cleanup refusal');
            });
            try {
              await settle(h.store);
              await recoverExecution(h.store);
              assert.equal(h.store.runtimeGet(run.id)!.state, 'needs_review', 'failed cleanup never confirms completion');
              assert.equal(gone(own.away), false, 'the detached process still needs cleanup');
              assert.ok(stop.mock.callCount() > 0);
            } finally { stop.mock.restore(); }
          } else await settle(h.store);
          await recoverExecution(h.store);
        }
        if (ending === 'fault') {
          await until(() => readFileSync(join(h.store.folder(run.id), 'manager.log'), 'utf8').includes('injected observation failure'),
            'manager reports injected observation failure');
          // Do not let recovery hide a failed manager finally block.
          await until(() => gone(own.agent) && gone(own.away), 'finally reclaims the whole scope');
        } else {
          await until(() => { new RunEventImporter(h.store).pass();
            return ['succeeded', 'cancelled', 'failed'].includes(h.store.runtimeGet(run.id)!.state); }, 'Run completion');
          assert.ok(gone(own.agent) && gone(own.away), 'completion is published only after the detached command stops');
          if (ending === 'natural') assert.equal(h.store.runtimeGet(run.id)!.state, 'succeeded');
          if (ending === 'stop') assert.equal(h.store.runtimeGet(run.id)!.state, 'cancelled');
          if (ending.startsWith('lost')) assert.equal(h.store.runtimeGet(run.id)!.state, 'failed', 'a lost exit never invents success');
        }
        assert.ok(!gone(foreign.agent) && !gone(foreign.away), 'another Run and its detached command remain alive');
        h.release('foreign-finish');
        await until(() => gone(foreign.agent) && gone(foreign.away), 'unrelated Run also cleans up its own scope');
      });
  }
}
