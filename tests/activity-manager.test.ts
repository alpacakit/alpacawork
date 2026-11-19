import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { readRunActivity } from '@alpacawork/backend/test-dist/runs/activity.js';
import { setup, until } from './runs-runtime.fixture.ts';
import { launchSnapshot } from '@alpacawork/backend/test-dist/agents-settings.js';

test("manager shows both agents' work with no activity settings", async t => {
  const h = await setup(t);
  const config = parse(readFileSync(join(h.root, 'config.yaml'), 'utf8'));
  for (const name of ['claude', 'codex']) assert.equal(Object.hasOwn(config.agents[name], 'read'), false);
  const launch = (agent: 'claude' | 'codex') => {
    const snapshot = launchSnapshot(h.config, agent, 'start', join(h.root, 'agent-bin'));
    assert.equal(snapshot.ok, true); if (!snapshot.ok) throw new Error(snapshot.code);
    return snapshot.launch;
  };
  const claude = h.create('claude', { activity: true, activityCommand: 'alpacawork task list', gate: h.gate('claude-output') },
    { launch: launch('claude') });
  const codex = h.create('codex', { activity: true, activityCommand: 'alpacawork task get --task T157', gate: h.gate('codex-output') },
    { placementId: h.memberPlacementId, role: 'worker', launch: launch('codex') });
  await h.tick();
  await Promise.all([h.ready(claude), h.ready(codex)]);
  for (const [run, command] of [[claude, 'task.list'], [codex, 'task.get']] as const) {
    const activity = await until(() => {
      const value = readRunActivity(h.store.folder(run.id));
      return value?.doing?.command ? value : null;
    }, `${run.id} work from product-owned reader`);
    assert.equal(activity.doing?.command, command);
    assert.doesNotMatch(readFileSync(join(h.store.folder(run.id), 'activity.json'), 'utf8'), /T157|alpacawork/);
  }
  h.release('claude-output'); h.release('codex-output');
  await Promise.all([h.waitState(claude, 'succeeded'), h.waitState(codex, 'succeeded')]);
  for (const run of [claude, codex]) assert.equal(readRunActivity(h.store.folder(run.id))?.doing, null);
});
