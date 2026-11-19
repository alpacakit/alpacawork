import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { RunStore } from '@alpacawork/runs';
import { bootIdentity, digestBytes } from '@alpacawork/core';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { reserveAttempt, planInputs } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { initializeControlFixture } from './helpers/control-fixture.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';

test('send now bypasses a waiting message with different choices', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-bypass-'));
  let store: RunStore | undefined;
  try {
    initializeControlFixture(root);
    writeFileSync(join(root, 'config.yaml'), stringify({ agents: { fake: fixtureAgentSetting('codex') } }));
    store = new RunStore(root, { busyTimeoutMs: 1000 });
    const conversation = new CoordinatorConversation(root), cid = conversation.read().id;
    const ask = (effort: string) => {
      const id = randomUUID();
      conversation.ask({ conversationId: cid, id, text: `Use effort ${effort}`, selected: { effort }, attachments: [] });
      return store!.coordinatorRuns(cid).find(run => run.requestId === id)!;
    };
    const first = ask('high');
    const launch = store.write(tx => {
      const run = tx.runtimeGet(first.id)!;
      const attempt = reserveAttempt(store!, tx, run, resolve('apps/backend/dist/run-manager.js'),
        { run_minutes: 5, coordinator_run_minutes: 5, coordinator_command_seconds: 10 });
      tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
      return attempt;
    });
    const journal = new EventJournal(executionFolder(root, first.id, launch.attemptId), identityOf(launch));
    journal.append('claimed', { managerPid: process.pid, managerStarted: 'synthetic', bootId: bootIdentity() });
    journal.append('spawn_intent', { initialInputId: launch.initialInputId });
    journal.append('input_attempt', { inputId: launch.initialInputId, instructionRunId: first.id, contentDigest: digestBytes(launch.prompt) });
    journal.append('input_taken', { inputId: launch.initialInputId, receipt: { evidence: 'synthetic' } });
    journal.append('session', { id: 'established-same-session' });
    new RunEventImporter(store).pass();
    const waiting = ask('low'), sent = ask('high');
    assert.equal(sent.resumes, waiting.id); assert.equal(waiting.resumes, first.id);
    assert.deepEqual(sent.launch.values, first.launch.values);
    assert.notDeepEqual(waiting.launch.values, sent.launch.values);
    assert.deepEqual(sent.session, store.runtimeGet(first.id)!.session);
    assert.deepEqual(waiting.session, sent.session);
    conversation.sendNow(cid, sent.requestId);
    planInputs(store);
    const inputs = store.connection.prepare('SELECT instruction_run_no FROM run_inputs WHERE initial=0').all();
    assert.deepEqual(inputs.map(row => Number(row.instruction_run_no)), [Number(sent.id.slice(1))]);
    assert.equal(store.runtimeGet(waiting.id)!.state, 'queued');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
