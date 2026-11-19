import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { initializeControlFixture } from './helpers/control-fixture.ts';
/** Regressions using only synthetic roots and unlaunched Runs. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { RequestService, type RequestContext } from '@alpacawork/backend/test-dist/control/requests.js';
import { RunStore, depth } from '@alpacawork/runs';

const config = stringify({ "limits":{"automatic_per_placement":20}, agents: { "fake": fixtureAgentSetting('codex') } });

async function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-depth-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(config)); project = initializeControlFixture(root); }
  finally { writer.close(); }
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const task = (await commands.create({ parentId: project, userRequested: null, tasks: [{ title: 'Owner' }] })).tasks[0];
  const people = new PlacementStore(root);
  const owner = people.place({ taskId: task.id, agentId: people.createAgent().id, profileKey: 'fake', responsible: true });
  people.close();
  const service = new RequestService(root);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  t.after(() => store.close());
  const request = () => service.request({ taskId: task.id, body: 'work', requestId: 'req-1',
    expectedTaskHash: task.hash, expectedPlacementRevision: owner.revision }, { purpose: 'instruction', actor: { kind: 'human' } });
  const start = (id: string) => store.write(tx => tx.update({ ...tx.get(id)!, state: 'running',
    started_at: new Date().toISOString() }));
  return { root, commands, task, owner, service, store, request, start };
}

test('real child-Task delegation still rejects a ninth Run level', async t => {
  const h = await fixture(t);
  let parentTask = h.task;
  let parentRun = await h.request(), parentPlacement = h.owner.id;
  h.start(parentRun.runId);
  for (let level = 2; level <= 9; level++) {
    const child = (await new ControlTaskCommands(h.root, { kind: 'placement', placementId: parentPlacement }).create({ parentId: parentTask.id, userRequested: false,
      tasks: [{ title: `Level ${level}` }] })).tasks[0];
    const people = new PlacementStore(h.root);
    const placement = people.place({ taskId: child.id,
      agentId: people.createAgent().id, profileKey: 'fake', responsible: true });
    people.close();
    const input = { taskId: child.id, body: 'nested work', requestId: `level-${level}`,
      expectedTaskHash: child.hash, expectedPlacementRevision: placement.revision,
      targetPlacementId: placement.id };
    const context: RequestContext = { purpose: 'instruction', actor: { kind: 'placement', placementId: parentPlacement },
      actorRunId: parentRun.runId };
    if (level === 9) {
      await assert.rejects(h.service.request(input, context),
        (error: { code: string }) => error.code === 'too_deep');
      assert.equal(h.store.readRequests().some(item => item.id === input.requestId), false);
    } else {
      parentRun = await h.service.request(input, context);
      assert.equal(depth(h.store.snapshot().records ?? [], h.store.get(parentRun.runId)!), level);
      h.start(parentRun.runId);
      parentTask = child; parentPlacement = placement.id;
    }
  }
});
