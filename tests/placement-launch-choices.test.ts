import { stringify } from 'yaml';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import { taskLogSchema } from '@alpacawork/raw/task-log-schema';
import { agentAssignInput } from '@alpacawork/contract/inputs';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { initializeControlFixture, currentTaskHash } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';

const human = { kind: 'human' } as const;
const setting = { ...fixtureAgentSetting('claude'), params: { model: ['large', 'small'], effort: ['high', 'low'] } };
const config = stringify({ agents: { choice: setting } });

async function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-placement-choices-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), config);
  const task = (await new ControlTaskCommands(root, human).create({ parentId: project, userRequested: false,
    tasks: [{ title: 'Selected responsible' }] })).tasks[0];
  const commands = new PlacementCommands(root);
  const hash = () => currentTaskHash(root, task.id);
  const logs = async () => (await new ControlTaskStore(root).get(task.id)).meta.log;
  const place = (selected?: Record<string, string>) => commands.placeNewResponsible({ taskId: task.id,
    profileKey: 'choice', expectedTaskHash: hash(), selected }, human);
  const instruct = (placement: { revision: number }, selected?: Record<string, string>, newConversation?: boolean) =>
    new TaskRequestService(root).request({ task: task.id, body: 'Continue the task', opId: randomUUID(),
      expectedTaskHash: hash(), expectedPlacementRevision: placement.revision, selected, newConversation }, human, human);
  const values = (id: string) => {
    const runs = new RunStore(root, { busyTimeoutMs: 0 });
    try { return runs.get(id)!.launch.values; } finally { runs.close(); }
  };
  const finish = (id: string) => {
    const runs = new RunStore(root, { busyTimeoutMs: 0 });
    try {
      runs.write(tx => {
        tx.update({ ...tx.get(id)!, state: 'running', started_at: new Date().toISOString() });
        tx.finish({ ...tx.get(id)!, state: 'succeeded', ended_at: new Date().toISOString() }, { state: 'present', text: 'Done' });
      });
    } finally { runs.close(); }
  };
  return { root, project, task, commands, hash, logs, place, instruct, values, finish };
}

test('agent assign decodes selected JSON once and reports malformed selection input', () => {
  const input = { task: 'T3', role: 'responsible', profile: 'choice', expectedTaskHash: 'a'.repeat(64),
    selected: { model: 'small' } };
  assert.deepEqual(agentAssignInput.parse(input).selected, { model: 'small' });
  for (const selected of ['{', '[]', '{"effort":7}'])
    assert.equal(agentAssignInput.safeParse({ ...input, selected }).success, false);
});

test('a request stop takes precedence over a now unavailable placement fallback', async t => {
  const h = await setup(t);
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { choice: setting, later: setting },
    aiStack: [{ agent: 'choice', values: { model: 'large' } }] }, { aliasDuplicateObjects: false }));
  const { placement } = await h.commands.placeNewResponsible({ taskId: h.task.id, expectedTaskHash: h.hash(),
    aiStack: [{ agent: 'choice', values: { model: 'large' } }, { agent: 'later', values: { model: 'small' } }] }, human);
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { choice: setting },
    aiStack: [{ agent: 'choice', values: { model: 'large' } }] }));
  for (const aiStack of [[{ agent: 'choice', values: { model: 'large' } }, 'stop'], ['stop']] as const) {
    const result = await new TaskRequestService(h.root).request({ task: h.task.id, body: 'Continue here only', opId: randomUUID(),
      expectedTaskHash: h.hash(), expectedPlacementRevision: placement.revision, aiStack: [...aiStack] }, human, human);
    if (result.outcome.kind !== 'request_accepted') throw new Error('Request must be accepted');
    assert.equal(h.values(result.outcome.request.runId).model, 'large');
    h.finish(result.outcome.request.runId);
  }
});

test('only the immutable placement creation record can carry launchValues', async t => {
  const h = await setup(t), placed = await h.place({ model: 'small' });
  const entry = (await h.logs()).find(log => log.placementId === placed.placement.id)!;
  assert.deepEqual(entry.launchValues, { model: 'small' }, 'defaults are resolved at launch, not frozen by assignment');
  assert.equal(taskLogSchema.safeParse(entry).success, true);
  for (const changed of [
    { ...entry, placementRevision: 2 },
    { ...entry, placementEffect: 'released' },
    { ...entry, kind: 'reported', placementId: undefined, placementRevision: undefined, placementEffect: undefined },
  ]) assert.equal(taskLogSchema.safeParse(changed).success, false);
});

test('an invalid placement selection rejects before creating a person, placement or log', async t => {
  const h = await setup(t), before = h.hash();
  await assert.rejects(h.place({ model: 'missing' }), { code: 'invalid_input' });
  assert.equal(h.hash(), before);
  const store = new PlacementStore(h.root);
  try { assert.deepEqual([store.agents(), store.placements()], [[], []]); } finally { store.close(); }
});

test('a first conversation uses creation selections, continuation keeps them and an explicit new conversation takes current defaults', async t => {
  const h = await setup(t), { placement } = await h.place({ model: 'small' });
  // A separate service and store read after assignment represent a later client/server lifetime.
  const first = await h.instruct(placement);
  assert.deepEqual(h.values(first.outcome.request.runId), { model: 'small', effort: 'high' });
  h.finish(first.outcome.request.runId);
  const override = await h.instruct(placement, { model: 'large', effort: 'low' });
  assert.deepEqual(h.values(override.outcome.request.runId), { model: 'large', effort: 'low' });
  h.finish(override.outcome.request.runId);
  const continued = await h.instruct(placement);
  assert.deepEqual(h.values(continued.outcome.request.runId), { model: 'large', effort: 'low' });
  h.finish(continued.outcome.request.runId);
  const restarted = await h.instruct(placement, undefined, true);
  assert.deepEqual(h.values(restarted.outcome.request.runId), { model: 'large', effort: 'high' });
});

test('member promotion retains the member creation choices and adds no second choice snapshot', async t => {
  const h = await setup(t), owner = await h.place();
  const member = await h.commands.placeMember({ taskId: h.task.id, profileKey: 'choice',
    expectedTaskHash: h.hash(), expectedResponsibleRevision: owner.placement.revision,
    selected: { model: 'small', effort: 'low' } }, human);
  const promoted = await h.commands.setResponsible({ taskId: h.task.id, placementId: member.placement.id,
    expectedTaskHash: h.hash(), expectedPlacementRevision: member.placement.revision }, human);
  const changes = (await h.logs()).filter(log => log.placementId === member.placement.id);
  assert.deepEqual(changes.map(log => log.launchValues), [{ model: 'small', effort: 'low' }, undefined]);
  const first = await h.instruct(promoted.placement);
  assert.deepEqual(h.values(first.outcome.request.runId), { model: 'small', effort: 'low' });
});

test('automatic handover wakes the new responsible with its creation choices', async t => {
  const h = await setup(t), old = await h.place();
  const first = await h.instruct(old.placement);
  h.finish(first.outcome.request.runId);
  reconcileLinks(h.root, h.project);
  const next = await h.commands.placeNewResponsible({ taskId: h.task.id, profileKey: 'choice', selected: { effort: 'low' },
    expectedTaskHash: h.hash(), replacePlacementId: old.placement.id,
    expectedPlacementRevision: old.placement.revision }, human);
  const dispatched = await new ReturnRouter(h.root).pass(undefined, { project: h.project });
  assert.equal(dispatched.acceptedRequestIds.length, 1, JSON.stringify(dispatched));
  const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
  try {
    const run = runs.read().find(run => run.placementId === next.placement.id)!;
    assert.ok(run);
    assert.deepEqual(run.launch.values, { model: 'large', effort: 'low' });
  } finally { runs.close(); }
});

test('a low-level placement with no creation record legitimately takes current defaults', async t => {
  const h = await setup(t), store = new PlacementStore(h.root);
  let placement;
  try { placement = store.createAndPlace({ taskId: h.task.id, profileKey: 'choice', responsible: true }).placement; }
  finally { store.close(); }
  assert.equal((await h.logs()).some(log => log.placementId === placement.id), false);
  const first = await h.instruct(placement);
  assert.deepEqual(h.values(first.outcome.request.runId), { model: 'large', effort: 'high' });
});

test('creation choices remain explicit while current defaults supply unselected fields', async t => {
  const h = await setup(t), { placement } = await h.place({ model: 'small' });
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { choice: { ...setting, params: { ...setting.params, effort: ['low', 'high'] } } } }));
  const first = await h.instruct(placement);
  assert.deepEqual(h.values(first.outcome.request.runId), { model: 'small', effort: 'low' });
});

test('without keeps a creation choice latent and omits its argv group when the model changes', async t => {
  const h = await setup(t);
  writeFileSync(join(h.root, 'config.yaml'), stringify({ agents: { choice: {
    ...setting, params: { model: ['flash', 'fixed'], effort: ['high', 'low'] }, without: { fixed: ['effort'] },
  } } }));
  const before = h.hash();
  await assert.rejects(h.place({ model: 'fixed', effort: 'missing' }), { code: 'invalid_input' });
  assert.equal(h.hash(), before);
  const { placement } = await h.place({ model: 'flash', effort: 'low' });
  const first = await h.instruct(placement, { model: 'fixed' });
  assert.deepEqual(h.values(first.outcome.request.runId), { model: 'fixed', effort: 'low' });
  const runs = new RunStore(h.root, { busyTimeoutMs: 0 });
  try { assert.equal(runs.get(first.outcome.request.runId)!.launch.argv.includes('--effort'), false); }
  finally { runs.close(); }
});

test('two creation records for one placement are an explicit storage fault', async t => {
  const h = await setup(t), { placement } = await h.place({ model: 'small' });
  const entry = (await h.logs()).find(log => log.placementId === placement.id)!;
  const { placementLaunchValues } = await import('@alpacawork/backend/test-dist/control/placement-launch-values.js');
  assert.throws(() => placementLaunchValues([entry, { ...entry, id: 'another-creation' }], placement.id),
    { code: 'runs_unavailable' });
});
