/** Actual config set saves through each coordinator identity, with durable attribution and Run refusals. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { AGENT_ADAPTERS, optionsBase } from '@alpacawork/contract/agent-adapters';
import { ControlStore } from '@alpacawork/db';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { assignResponsible } from './helpers/control-fixture.ts';
import { call, run, callerWorkspace, claudeConversation, codexConversation } from './coordinator-caller.fixture.ts';

for (const identity of ['claude', 'codex', 'screen'] as const) {
  test(`config set as ${identity} coordinator saves all limits and agents, with one attributed journal record`, async t => {
    const w = callerWorkspace(t);
    const conversation = `config-${identity}`;
    const screen = identity === 'screen' ? w.screenRun({ words: 'Change the configuration', session: conversation }) : null;
    const url = await w.start();
    if (screen) await w.startScreenRun(url, screen);
    const env = identity === 'codex' ? codexConversation(conversation) : claudeConversation(conversation);
    const before = await call(url, ['config', 'get'], env);
    const limits = { parallel: 3, run_minutes: 5, depth: 9, children_per_run: 12,
      automatic_per_placement: 13, attachment_mib: 70, coordinator_run_minutes: 6, coordinator_command_seconds: 5 };
    // Candidates, extra environment names and launch options have no coordinator-only filter.
    const definitions = parse(before.agentsText);
    definitions.agents.codex.params.model = ['gpt-6.1-sol', 'gpt-6.1-terra'];
    definitions.agents.codex.env = ['FIXTURE_PROVIDER_KEY'];
    definitions.agents.codex.options = { base: optionsBase('codex'),
      start: AGENT_ADAPTERS.codex.options.start + ' --fixture-option',
      resume: AGENT_ADAPTERS.codex.options.resume + ' --fixture-option' };
    const agents = stringify(definitions);
    const opId = randomUUID(), began = new Date().toISOString();
    const args = ['config', 'set', '--config', stringify({ limits }), '--agents', agents,
      '--expected-config-hash', before.hash, '--op-id', opId];
    const saved = await call(url, args, env);
    assert.deepEqual(saved.limits, limits);
    assert.equal(saved.agentsText, agents);
    const { availability, detected, ...reread } = await call(url, ['config', 'get'], env);
    assert.deepEqual(reread, saved);
    assert.equal(availability, undefined); assert.equal(detected, undefined);
    assert.deepEqual(await call(url, args, env), saved, 'retry replays the original operation');
    const store = new ControlStore(w.root, { busyTimeoutMs: 1000 }, true);
    try {
      const records = store.connection.prepare('SELECT * FROM file_operations WHERE op_id=?').all(opId);
      assert.equal(records.length, 1);
      const row = records[0]!;
      assert.deepEqual([row.destination_path, row.state, row.old_digest, row.new_digest],
        ['config.yaml', 'published', before.hash, saved.hash]);
      const receipt = JSON.parse(String(row.result_json));
      assert.deepEqual(receipt.audit.actor, { kind: 'main', provider: identity === 'screen' ? 'claude' : identity,
        conversationId: screen?.conversation ?? conversation });
      assert.ok(receipt.audit.at >= began && receipt.audit.at <= new Date().toISOString());
      assert.deepEqual(receipt.body, saved, 'the record retains what was saved');
    } finally { store.close(); }
    const stale = await run(url, [...args.slice(0, -2), '--op-id', randomUUID()], env);
    assert.equal(JSON.parse(stale.stderr).error.code, 'conflict');
    assert.equal((await call(url, ['config', 'get'], env)).hash, saved.hash);
  });
}

test('responsible and member Runs cannot save configuration, even with a current hash', async t => {
  const w = callerWorkspace(t), commands = new ControlTaskCommands(w.root, { kind: 'human' });
  const task = (await commands.create({ parentId: w.project, userRequested: null, tasks: [{ title: 'Configuration caller' }] })).tasks[0];
  const owner = await assignResponsible(w.root, task, 'codex');
  const member = (await new PlacementCommands(w.root).placeMember({ taskId: task.id, profileKey: 'codex',
    expectedTaskHash: (await new ControlTaskStore(w.root).get(task.id)).hash, expectedResponsibleRevision: owner.revision }, { kind: 'human' })).placement;
  const runs = [w.heldRun({ task: task.id, placementId: owner.id }),
    w.heldRun({ task: task.id, placementId: member.id, role: 'worker' })];
  const url = await w.start(), before = await call(url, ['config', 'get']);
  const bytes = readFileSync(join(w.root, 'config.yaml'));
  for (const held of runs) {
    const result = await run(url, ['config', 'set', '--config', stringify({ limits: { ...before.limits, parallel: 7 } }),
      '--agents', before.agentsText, '--expected-config-hash', before.hash], held.env);
    assert.equal(result.code, 2, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, 'forbidden');
    assert.equal(JSON.parse(result.stderr).error.detail.action, 'config.set');
    assert.deepEqual(readFileSync(join(w.root, 'config.yaml')), bytes);
  }
});
