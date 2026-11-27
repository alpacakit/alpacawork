import { bundleHookChange, bundleLifecycle, bundleVersion, prepareAutomationVersion, readBundleAutomation } from '@alpacawork/backend/test-dist/automations/bundle-store.js';
import { bundleCommands } from '@alpacawork/backend/test-dist/automations/bundle-commands.js';
import { BundleEngine } from '@alpacawork/backend/test-dist/automations/bundle-engine.js';
import { BundleReviews } from '@alpacawork/backend/test-dist/automations/bundle-review.js';
import { enqueueBundleRun, listBundleRuns, pruneBundleHistory, settleBundleRun } from '@alpacawork/backend/test-dist/automations/bundle-runs.js';
import { BundleRuntime, stopBundleRun } from '@alpacawork/backend/test-dist/automations/bundle-runtime.js';
import { receiveSignal } from '@alpacawork/backend/test-dist/automations/signals.js';
import { setTimeout as pause } from 'node:timers/promises';
import { coordinatorRunFor } from './helpers/coordinator-run.ts';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import { ChangeLog, ControlStore, keepControlChanges, touch } from '@alpacawork/db';
import { Problem, PROBLEM_CODE, digestBytes } from '@alpacawork/core';
import { DEFAULT_SCHEMA, DEFAULT_LIMITS } from '@alpacawork/contract';
import { RunStore } from '@alpacawork/runs';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { writeFieldDef, deleteFieldDef, writeProjectSchema, writeTaskValues } from '@alpacawork/backend/test-dist/control/task-values-store.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { setCoordinatorMemo } from '@alpacawork/backend/test-dist/coordinator/memo.js';
import { linkMessage, refuse } from '@alpacawork/backend/test-dist/coordinator/messages.js';
import { reserveAttempt, resolveUncertainInputs, planInputs } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { managerScript, settleTransaction, launch } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { EventJournal, executionFolder, identityOf, messageName } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { claimCompaction, latestCompactions, requestCompaction, settleCompaction } from '@alpacawork/backend/test-dist/runs/compactions.js';
import { changeFixture } from './helpers/change-fixture.ts';
import { changeAudit } from './helpers/control-change-audit.ts';
import { assignResponsible, grantFixtureRequest } from './helpers/control-fixture.ts';
import { fields } from './runs-fixtures.ts';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { writeSites, siteId, trackedSite, writeSiteStatus, observeWriteSites, type WriteSite } from './helpers/control-write-inventory.ts';

type ListedSite = WriteSite & { status: ReturnType<typeof writeSiteStatus> };
const inventory = JSON.parse(readFileSync(new URL('./fixtures/control-write-sites.json', import.meta.url), 'utf8')) as ListedSite[];

test('all control write statements retain an explicit classification and count', () => {
  assert.equal(new Set(inventory.map(siteId)).size, inventory.length,
    'distinct SQL sites require distinct execution evidence; identical statements must not share a coverage identity');
  const actual = writeSites(resolve('.')).map(site => ({ id: siteId(site), table: site.table, status: writeSiteStatus(site) }));
  assert.deepEqual(actual, inventory.map(site => ({ id: siteId(site), table: site.table, status: site.status })),
    'a new, removed or changed SQL write must update the source inventory');
});

test('seeded real operations cover writers and every committed row change has its own journal key', async t => {
  const { root, after } = changeFixture(t), previousPath = process.env.PATH;
  const versionFixture = join(root, 'judge-version.sh');
  writeFileSync(versionFixture, '#!/bin/sh\nprintf "2.1.330 (Claude Code)\\n"\n', { mode: 0o700 });
  process.env.PATH = installAgentStub(root, 'claude', [versionFixture]);
  after(() => {
    for (const directory of ['agent-bin', 'tool-bin']) rmSync(join(root, directory), { recursive: true, force: true });
  });
  after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  const setting = fixtureAgentSetting('claude');
  setting.params = Object.fromEntries(Object.keys(setting.params).map(key => [key, []]));
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { fake: setting, claude: {} } }));
  const journal = keepControlChanges(root, new ChangeLog(1024)); after(journal.close);
  const audit = changeAudit(root, journal.log); after(audit.close);
  const observed = observeWriteSites(inventory); after(observed.close);
  const control = new ControlStore(root); after(() => control.close());
  const runs = new RunStore(root, { busyTimeoutMs: 1000 }); after(() => runs.close());
  const commands = new ControlTaskCommands(root, { kind: 'human' }), tasks = new ControlTaskStore(root);
  const pending: string[] = [];
  const step = async <T>(name: string, work: () => T | Promise<T>, kinds: string[] = []) => {
    const checked = await audit.step(name, work, kinds); pending.push(...checked.pending); return checked.result;
  };
  const write = <T>(work: (db: DatabaseSync) => T): T => control.write(work);
  const human = { kind: 'human' } as const;
  const newTask = async (title: string) => (await step('create Task', () => commands.create({ parentId: 'P1',
    userRequested: false, tasks: [{ title, values: { decide: [{ decide_kind: 'choose', decide_question: 'Which direction?' }] } }] }))).tasks[0]!;
  const first = await newTask('First audited task'), second = await newTask('Second audited task');
  const cache = join(root, '.automations');
  after(() => {
    if (existsSync(cache)) for (const entry of readdirSync(cache, { recursive: true, withFileTypes: true })) {
      if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o700);
    }
  });
  const files = [{ path: 'main.ts', source: `
export const config = { on: { event: 'signal' }, limits: { perDay: 10, tasksPerRun: 1 }, uses: { send: ['synthetic'] } };
/** Proceed with a synthetic delivery. */
export function trigger() { return { run: true, reason: 'Accepted' }; }
/** Record a synthetic delivery. */
export async function run({ event, alp, signal }) {
  if (event.items.some(item => item.data?.hold)) {
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { summary: 'Released' };
  }
  await alp.tasks.create({ title: 'Delivery task', request: false, data: { example: true } });
  return { summary: 'Delivery recorded', report: 'Synthetic evidence' };
}
` }];
  const ordered = async <T>(work: () => T | Promise<T>) => work();
  const runtime = new BundleRuntime(root, 'http://127.0.0.1:1', ordered);
  const reviews = new BundleReviews(root, async () => ({ kind: 'answer', model: 'synthetic',
    text: JSON.stringify({ state: 'fix', summary: 'Synthetic acknowledgment', findings: [] }) }));
  const context = () => ({ caller: () => human, actor: human, bundleRuntime: runtime, bundleReviews: reviews, opId: randomUUID() });
  const date = () => new Date();
  const syntheticEvent = () => ({ kind: 'signal' as const, ref: randomUUID(), at: date().toISOString(), manual: true,
    count: 1, firstAt: date().toISOString(), lastAt: date().toISOString(),
    items: [{ at: date().toISOString(), by: { kind: 'human' as const }, key: 'fixture', data: null }] });
  const lifecycleAt = async (id: string, action: Parameters<typeof bundleLifecycle>[3]) =>
    write(db => bundleLifecycle(db, root, readBundleAutomation(db, id), action, human, date()));
  const engine = new BundleEngine(root, ordered, () => runtime.kick());
  const awaitRun = async (id: string, settled: boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      runtime.kick();
      const run = control.read(db => listBundleRuns(db, readBundleAutomation(db, id), 1)[0]);
      if (run && (settled ? run.finishedAt !== null : run.phase === 'run')) return run;
      await pause(25);
    }
    return assert.fail(`Automation ${id} did not ${settled ? 'settle' : 'start'}`);
  };
  try {
    const prepared = prepareAutomationVersion(root, files);
    await step('preview the bundle before saving', () => runtime.preview('P1', null, prepared, syntheticEvent(), human, true));
    const { automation: draft } = await step('save and review an automation bundle', () =>
      bundleCommands['automation/new'].run(root, { under: 'P1', name: 'Audit delivered signals', files }, context()));
    const id = draft.id;
    const hook = (operation: 'create' | 'rotate' | 'delete') => write(db =>
      bundleHookChange(db, readBundleAutomation(db, id), operation, randomBytes(32).toString('base64url'), human, date().toISOString()));
    for (const operation of ['create', 'rotate', 'delete'] as const) await step(`${operation} hook`, () => hook(operation));
    const to = { under: 'P1', name: 'synthetic', url: 'https://example.invalid/' };
    await step('save a synthetic destination', async () => {
      const registration = { ...context(), verifyAutomationHttp: async () => null };
      const verified = await bundleCommands['automation/destination-set'].prepareWrite(root, to, registration);
      return bundleCommands['automation/destination-set'].run(root, to, { ...registration, ...verified });
    });
    await step('enable the automation bundle', () => lifecycleAt(id, { kind: 'enabled', acknowledge: true }));
    await step('preview a saved automation', () => {
      const { automation, version } = control.read(db => {
        const automation = readBundleAutomation(db, id);
        return { automation, version: bundleVersion(db, automation.uuid, automation.latest) };
      });
      return runtime.preview('P1', automation, version, syntheticEvent(), human, true);
    });
    const signal = (data: { n: number } | { hold: true }) =>
      write(db => receiveSignal(db, { automation: id, data }, human, randomUUID(), date()));
    await step('receive and group delivered signals', () => {
      for (let n = 1; n <= 21; n++) signal({ n });
    });
    await step('start and complete a signal run with task reference data', async () => {
      await engine.scan();
      const result = await awaitRun(id, true);
      assert.equal(result.state, 'done', result.reason ?? undefined);
    });
    await step('admit a signal whose action can be stopped', async () => {
      signal({ hold: true });
      await engine.scan();
      const active = await awaitRun(id, false);
      assert.equal(active.state, 'running');
    });
    await step('stop the running automation', async () => {
      write(db => {
        const automation = readBundleAutomation(db, id);
        const active = listBundleRuns(db, automation, 1)[0]!;
        stopBundleRun(db, automation, active.number, active.version, date());
      });
      const result = await awaitRun(id, true);
      assert.equal(result.state, 'stopped');
    });
    await step('accept and then cancel a new signal', () => signal({ n: 1 }));
    await step('disable the automation bundle and settle its pending signal', () => lifecycleAt(id, { kind: 'disabled' }));
    await step('record and group refused runs', () => write(db => {
      const automation = readBundleAutomation(db, id);
      for (const reason of ['audit_daily_limit', 'audit_daily_limit']) {
        enqueueBundleRun(db, automation, automation.latest, syntheticEvent(), 'live', date(), { kind: reason, reason: 'Synthetic refusal' });
      }
    }));
    await step('record and resolve an automation failure', () => write(db => {
      const automation = readBundleAutomation(db, id);
      const failed = enqueueBundleRun(db, automation, automation.latest, syntheticEvent(), 'live', date());
      settleBundleRun(db, automation, failed.number, date(), { state: 'failed', failedPhase: 'run', reason: 'Synthetic failure' });
      const recovered = enqueueBundleRun(db, automation, automation.latest, syntheticEvent(), 'live', date());
      settleBundleRun(db, automation, recovered.number, date(), { state: 'done', summary: 'Available again' });
    }));
    await step('save a changed draft', () => bundleCommands['automation/save'].run(root, { automation: id,
      expectedHash: control.read(db => readBundleAutomation(db, id)).hash,
      files: files.map(file => ({ ...file, source: file.source.replace('Synthetic evidence', 'Updated synthetic evidence') })),
    }, context()));
    await step('prune expired reference data while preserving recent run metadata', () =>
      write(db => pruneBundleHistory(db, new Date(Date.now() + 32 * 86_400_000))));
    await step('prune expired automation runs', () =>
      write(db => pruneBundleHistory(db, new Date(Date.now() + 100 * 86_400_000))));
  } finally {
    engine.close();
    await runtime.close();
  }
  const field = { id: 'audit_item', title: 'Audit item', type: 'text', many: false,
    maxChars: 100, maxItems: null, hint: '', members: [] };
  await step('define field', () => write(db => writeFieldDef(db, field, '2026-11-16T00:00:00Z')));
  await step('set schema', () => write(db => writeProjectSchema(db, 'P1', [...DEFAULT_SCHEMA, field.id])));
  await step('replace values', () => write(db => {
    writeTaskValues(db, first.id, { audit_item: 'one', goal: 'a goal' });
    writeTaskValues(db, second.id, { audit_item: 'two' });
  }));
  await step('remove inherited schema', () => write(db => writeProjectSchema(db, 'P1', null)));
  await step('delete field values across Tasks', () => write(db => deleteFieldDef(db, field.id)));
  await step('set dependencies', async () => commands.dependencies({ task: first.id, after: [second.id], expectedTaskHash: (await tasks.get(first.id)).hash }));
  await step('remove dependencies', async () => commands.dependencies({ task: first.id, after: [], expectedTaskHash: (await tasks.get(first.id)).hash }));

  let seed = 0x51a7;
  for (let index = 0; index < 32; index++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const id = (seed >>> 0) % 2 ? first.id : second.id;
    if ((seed >>> 0) % 3 === 0) await step(`random values ${index}`, () => write(db => writeTaskValues(db, id,
      index % 2 ? { goal: `Goal ${index}` } : { goal: `Goal ${index}`, notes: 'Synthetic note' })));
    else await step(`random title ${index}`, async () => commands.update({ id, title: `Audited ${index}`, expectedTaskHash: (await tasks.get(id)).hash }));
  }
  await step('place move destination owner', async () => assignResponsible(root, await tasks.get(second.id), 'fake'));
  await step('change logical parent', async () => commands.move({ id: first.id, parentId: second.id,
    expectedTaskHash: (await tasks.get(first.id)).hash }), ['wait_cycle', 'return', 'delivery', 'resolution']);
  await step('restore logical parent', async () => commands.move({ id: first.id, parentId: 'P1',
    expectedTaskHash: (await tasks.get(first.id)).hash }), ['wait_cycle', 'return', 'delivery', 'resolution']);

  const placements = new PlacementStore(root); after(() => placements.close());
  const member = await step('place member', () => placements.createAndPlace({ taskId: first.id, profileKey: 'fake', responsible: false }));
  await step('responsible handover', () => placements.setResponsible(member.placement.id, member.placement.revision));
  await step('release idle placement', () => placements.release(member.placement.id, member.placement.revision + 1));
  const owner = await step('assign responsible', async () => assignResponsible(root, await tasks.get(first.id), 'fake'));
  const requested = await step('admit work', async () => new TaskRequestService(root).request({ task: first.id,
    body: 'Do synthetic work', opId: randomUUID(), expectedTaskHash: (await tasks.get(first.id)).hash,
    expectedPlacementRevision: owner.revision }, human, human), ['wait_cycle', 'return', 'delivery', 'resolution']);
  assert.equal(requested.outcome.kind, 'request_accepted');
  if (requested.outcome.kind !== 'request_accepted') return;
  const runId = requested.outcome.request.runId;
  const attempt = await step('reserve execution', () => runs.write(tx => {
    const run = tx.get(runId)!;
    const attempt = reserveAttempt(runs, tx, run, managerScript, DEFAULT_LIMITS);
    tx.update({ ...run, state: 'running', started_at: new Date().toISOString() });
    return attempt;
  }));
  await step('arrange taken initial input', () => runs.write(() => {
    runs.connection.prepare("UPDATE run_inputs SET state='taken' WHERE input_id=?").run(attempt.initialInputId);
    touch(runs.connection, { kind: 'input', id: attempt.initialInputId });
  }));
  await step('admit another input', async () => new TaskRequestService(root).request({ task: first.id,
    body: 'A second synthetic instruction', opId: randomUUID(), expectedTaskHash: (await tasks.get(first.id)).hash,
    expectedPlacementRevision: owner.revision }, human, human), ['wait_cycle', 'return', 'delivery', 'resolution']);
  await step('reserve live input', () => planInputs(runs));
  const caller = { kind: 'run', runId, placementId: owner.id, taskId: first.id, role: 'owner', responsible: true } as const;
  const actor = { kind: 'placement', placementId: owner.id } as const;
  const question = randomUUID();
  await step('restore question value', () => control.write(db => writeTaskValues(db, first.id,
    { decide: [{ decide_kind: 'choose', decide_question: 'Which direction?' }] })));
  await step('ask question', async () => new TaskReportService(root).report({ task: first.id, state: 'waiting', askTo: 'user',
    title: 'Choose a direction', description: 'Synthetic question', opId: question, expectedTaskHash: (await tasks.get(first.id)).hash },
  actor, caller), ['wait_cycle', 'return', 'delivery', 'resolution']);
  await step('answer question with full text', () => new TaskRequestService(root).request({ task: first.id,
    body: 'A synthetic answer with its full text', answers: question, opId: randomUUID() }, human, human),
  ['wait_cycle', 'return', 'delivery', 'resolution']);
  await step('stop Task', async () => new TaskReportService(root).report({ task: first.id, state: 'stopped',
    title: 'Stop synthetic work', opId: randomUUID(), expectedTaskHash: (await tasks.get(first.id)).hash }, human, human),
  ['wait_cycle', 'return', 'delivery', 'resolution']);
  await step('finish Run', () => runs.write(tx => {
    const run = tx.get(runId)!;
    tx.finish({ ...run, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() }, { state: 'missing', text: null });
  }));

  const coordinator = new CoordinatorConversation(root);
  const conversation = await step('open conversation', () => coordinator.read());
  const archivedMessage = randomUUID();
  await step('admit an older coordinator message', () => coordinator.ask({
    conversationId: conversation.id, id: archivedMessage, text: 'Earlier exchange', attachments: [],
  }));
  await step('finish the older exchange', () => runs.write(tx => {
    const run = tx.coordinatorHead(conversation.id)!;
    const at = new Date().toISOString();
    tx.update({ ...run, state: 'running', started_at: at });
    tx.finish({ ...run, state: 'succeeded', started_at: at, ended_at: at }, { state: 'present', text: 'Earlier reply' });
  }));
  const folder = join(root, '.alpacawork', 'coordinator', conversation.id, 'attachments', archivedMessage);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'note.txt'), 'Synthetic attachment');
  await step('reserve a coordinator reset', () => coordinator.reset(conversation.id, randomUUID()));
  const messageId = randomUUID();
  await step('coordinator message', () => coordinator.ask({ id: messageId, conversationId: conversation.id,
    text: 'Inspect the synthetic task', attachments: [], tasks: [second.id] }));
  const messageRun = coordinatorRunFor(runs, messageId);
  await step('link explicit recipients', () => control.write(db => linkMessage(db, messageRun)));
  await step('record refusal after a rolled-back mutation', () => {
    assert.throws(() => control.write(db => {
      db.prepare("UPDATE tasks SET title='Discarded mutation' WHERE external_id=?").run(second.id);
      touch(db, { kind: 'task', id: second.id });
      throw new Error('discard mutation');
    }), /discard mutation/);
    control.write(db => refuse(db, messageId, second.id, new Problem(PROBLEM_CODE.conflict, 'Synthetic refusal')));
  });
  const decision = await step('reserve queued launches', () => settleTransaction(runs, readAgentsSettings(root)),
    ['wait_cycle', 'return', 'delivery', 'resolution', 'input']);
  assert.ok(decision.launches.length > 0, 'the fixture reaches the real launch reservation');
  await step('save the active coordinator memo', () => write(db => setCoordinatorMemo(db, {
    kind: 'coordinator', source: 'screen', provider: 'claude', conversation: conversation.id, runId: messageRun.id,
  }, 'Keep the synthetic direction')));
  await step('expire an older attachment', () => coordinator.sweepAttachments(Date.now() + 31 * 86400_000));
  await step('record failed manager launch', () => launch(runs, decision, { script: join(root, 'absent-manager.mjs') }),
    ['wait_cycle', 'return', 'delivery', 'resolution', 'input']);
  await step('clear conversation', () => coordinator.clear(conversation.id));

  // Arrange an input receipt separately, so setup keys cannot mask the operation under test.
  await step('arrange uncertain receipt', () => runs.write(() => {
    runs.connection.prepare("UPDATE run_inputs SET state='uncertain' WHERE input_id=?").run(attempt.initialInputId);
    touch(runs.connection, { kind: 'input', id: attempt.initialInputId });
  }));
  await step('resolve uncertain receipt', () => runs.write(tx => resolveUncertainInputs(runs.connection, tx, owner.id)));

  // Exercise the other owner's actual writes too. Only their missing keys remain expected failures.
  const seat = await newTask('Return lifecycle audit');
  const seatOwner = await step('place result reader', () => placements.createAndPlace({ taskId: seat.id, profileKey: 'fake', responsible: true }));
  const seatWorker = await step('place result worker', () => placements.createAndPlace({ taskId: seat.id, profileKey: 'fake', responsible: false }));
  const queue = (placementId: string, role: 'owner' | 'worker', callerId?: string, cycleId: string | null = null) => runs.write(tx => {
    const id = randomUUID(), placement = tx.getPlacement(placementId)!;
    tx.insertRequest({ id, taskId: seat.id, placementId, placementRevision: placement.revision,
      taskHash: seat.hash, waitCycleId: cycleId, headRunId: null, mode: 'new', body: 'Synthetic audit input',
      purpose: 'instruction', author: callerId ? { kind: 'placement', placementId: seatOwner.placement.id } : human,
      submittedAt: new Date().toISOString(), deliveryState: 'queued' });
    grantFixtureRequest(runs, tx, id);
    return tx.create(fields({ task: seat.id, placementId, requestId: id, role, agent: 'fake', cwd: root,
      caller: callerId ? { run: callerId } : null }), 'Synthetic audit input');
  });
  const lifecycle = <T>(work: (owner: ReturnLifecycle) => T) => runs.write(tx => work(new ReturnLifecycle(
    runs.connection, tx, new TaskRepository(root, runs.connection).snapshot().tasks)));
  const returnKinds = ['wait_cycle', 'return', 'delivery', 'resolution'];
  const sender = await step('queue delegating owner', () => queue(seatOwner.placement.id, 'owner'));
  await step('start delegating owner', () => runs.write(tx => tx.update({ ...sender, state: 'running', started_at: new Date().toISOString() })));
  const cycle = await step('open wait cycle', () => lifecycle(owner => owner.cycleFor(seat.id)), returnKinds);
  const worker = await step('queue delegated work', () => queue(seatWorker.placement.id, 'worker', sender.id, cycle));
  await step('start delegated work', () => runs.write(tx => tx.update({ ...worker, state: 'running', started_at: new Date().toISOString() })));
  await step('finish delegated work', () => runs.write(tx => tx.finish({ ...tx.get(worker.id)!, state: 'failed', reason: 'exit',
    ended_at: new Date().toISOString() }, { state: 'missing', text: null })));
  await step('close delegated work and cycle', () => lifecycle(owner => owner.reconcile()), returnKinds);
  const closing = runs.readReturns().find(row => row.requestId === worker.requestId)!;
  assert.ok(closing, 'a real delegated Request has its closing return');
  await step('hold undelivered result', () => lifecycle(owner => owner.hold([closing.id], 'invalid_settings')), returnKinds);
  const wake = await step('queue result reader', () => queue(seatOwner.placement.id, 'owner'));
  await step('carry held result', () => lifecycle(owner => owner.carry(seat.id, wake.requestId)), returnKinds);
  await step('start result reader', () => runs.write(tx => tx.update({ ...wake, state: 'running', started_at: new Date().toISOString(),
    pids: { manager: null, agent: 4_194_305 } })));
  await step('finish result reader', () => runs.write(tx => tx.finish({ ...tx.get(wake.id)!, state: 'succeeded',
    ended_at: new Date().toISOString() }, { state: 'present', text: 'Synthetic processed result' })));
  await step('receive and consume result', () => lifecycle(owner => owner.reconcile()), returnKinds);
  const cause = (await tasks.get(seat.id)).meta.log[0]!.id;
  await step('publish work notice', () => lifecycle(owner => owner.notice('work_changed', seat.id, cause)), returnKinds);
  const cancelledWake = await step('queue cancelled delivery', () => queue(seatOwner.placement.id, 'owner'));
  await step('carry work notice', () => lifecycle(owner => owner.carry(seat.id, cancelledWake.requestId)), returnKinds);
  await step('cancel delivery', () => runs.write(tx => tx.abortRequest(cancelledWake, cancelledWake.requestId)));
  await step('release cancelled delivery', () => lifecycle(owner => owner.reconcile()), returnKinds);
  await step('stop result seat', async () => new TaskReportService(root).report({ task: seat.id, state: 'stopped',
    title: 'Stop audited seat', opId: randomUUID(), expectedTaskHash: (await tasks.get(seat.id)).hash }, human, human), returnKinds);
  await step('resolve undelivered notice', () => lifecycle(owner => owner.reconcile()), returnKinds);

  const importedTask = await newTask('Execution event audit');
  const importedSeat = await step('place import subject', () => placements.createAndPlace({ taskId: importedTask.id,
    profileKey: 'fake', responsible: true }));
  const importedRun = await step('queue import subject', () => runs.write(tx => {
    const id = randomUUID();
    tx.insertRequest({ id, taskId: importedTask.id, placementId: importedSeat.placement.id, placementRevision: 1,
      taskHash: importedTask.hash, waitCycleId: null, headRunId: null, mode: 'new', body: 'Import audit',
      purpose: 'instruction', author: human, submittedAt: new Date().toISOString(), deliveryState: 'queued' });
    grantFixtureRequest(runs, tx, id);
    return tx.create(fields({ task: importedTask.id, placementId: importedSeat.placement.id, requestId: id,
      role: 'owner', agent: 'fake', cwd: root }), 'Import audit');
  }));
  const importedAttempt = await step('reserve import subject', () => runs.write(tx => {
    const reserved = reserveAttempt(runs, tx, importedRun, managerScript, DEFAULT_LIMITS);
    tx.update({ ...importedRun, state: 'running', started_at: new Date().toISOString() }); return reserved;
  }));
  const spool = executionFolder(root, importedRun.id, importedAttempt.attemptId), events = new EventJournal(spool, identityOf(importedAttempt));
  events.append('claimed', { managerPid: 4_194_305, managerStarted: 'synthetic', bootId: 'synthetic' });
  events.append('spawn_intent', { initialInputId: importedAttempt.initialInputId });
  events.append('input_attempt', { inputId: importedAttempt.initialInputId, instructionRunId: importedRun.id,
    contentDigest: digestBytes(importedAttempt.prompt) });
  const importer = new RunEventImporter(runs);
  await step('import transfer attempt', () => importer.pass([importedRun.id]), ['input', 'attempt']);
  events.append('input_taken', { inputId: importedAttempt.initialInputId, receipt: { evidence: 'synthetic transfer' } });
  await step('import transfer receipt', () => importer.pass([importedRun.id]), ['input', 'attempt']);
  const brokenEvent = join(spool, 'events', messageName(5));
  writeFileSync(brokenEvent, 'malformed synthetic event');
  await step('diagnose broken execution event', () => importer.pass([importedRun.id]), ['input', 'attempt']);
  rmSync(brokenEvent);
  await step('recover execution diagnostic', () => importer.pass([importedRun.id]), ['input', 'attempt']);

  // A conversation whose later Runs compact it.
  const compactTask = await newTask('Compaction audit');
  const compactSeat = await step('place compaction subject', () => placements.createAndPlace({ taskId: compactTask.id,
    profileKey: 'fake', responsible: true }));
  const conversationRun = (resumes: string | null) => runs.write(tx => {
    const id = randomUUID();
    tx.insertRequest({ id, taskId: compactTask.id, placementId: compactSeat.placement.id, placementRevision: 1,
      taskHash: compactTask.hash, waitCycleId: null, headRunId: null, mode: resumes ? 'continue' : 'new', body: 'Compaction audit',
      purpose: 'instruction', author: human, submittedAt: new Date().toISOString(), deliveryState: 'queued' });
    grantFixtureRequest(runs, tx, id);
    return tx.create(fields({ task: compactTask.id, placementId: compactSeat.placement.id, requestId: id, role: 'owner',
      agent: 'fake', cwd: root, resumes, session: { provider: 'fake', id: 'compaction-audit-session' } }), 'Compaction audit');
  });
  const talked = await step('queue first conversation turn', () => conversationRun(null));
  await step('start first conversation turn', () => runs.write(tx => tx.update({ ...talked, state: 'running', started_at: new Date().toISOString() })));
  await step('finish first conversation turn', () => runs.write(tx => tx.finish({ ...tx.get(talked.id)!, state: 'succeeded',
    ended_at: new Date().toISOString() }, { state: 'present', text: 'Synthetic reply' })));
  // A queued Run moved to another AI before it was sent (AI fallback), and a placement with its own AI rows.
  const rebound = await step('queue a Run to rebind', () => conversationRun(null));
  await step('rebind a queued Run', () => runs.write(tx => tx.rebindQueued({ ...tx.get(rebound.id)! },
    { aiStack: [{ agent: 'fake', values: {} }], prompt: 'Rebound audit' })));
  await step('cancel the rebound Run', () => runs.write(tx => tx.abortRequest(tx.get(rebound.id)!, rebound.requestId)));
  const rowsTask = await newTask('Placement AI rows audit');
  await step('assign a responsible with AI rows', async () => new PlacementCommands(root).placeNewResponsible({ taskId: rowsTask.id,
    profileKey: 'fake', expectedTaskHash: (await tasks.get(rowsTask.id)).hash, aiStack: ['stop'] }, human));
  // A compaction rides the Run of its instruction: asked for, carried by its resumed launch, and each way it ends.
  const at = () => new Date().toISOString();
  const latest = () => control.write(db => latestCompactions(db, [compactSeat.placement.id]).get(compactSeat.placement.id)?.state);
  const compacting = async (name: string) => {
    const run = await step(`queue ${name}`, () => conversationRun(talked.id));
    await step(`ask to compact before ${name}`, () => write(db => requestCompaction(db, run, null, true, at())));
    return run;
  };
  const resumed = await compacting('resumed turn');
  assert.equal(latest(), 'pending');
  const carrying = await step('reserve compacting launch', () => runs.write(tx => {
    const reserved = reserveAttempt(runs, tx, resumed, managerScript, DEFAULT_LIMITS);
    tx.update({ ...resumed, state: 'running', started_at: at() }); return reserved;
  }));
  assert.ok(carrying.compaction, 'a resumed launch carries the compaction');
  const settle = (outcome: Parameters<typeof settleCompaction>[2]) => write(db => settleCompaction(db, carrying.attemptId, outcome, at()));
  const carry = (run: { id: string }, mode: 'start' | 'resume' = 'resume') => write(db => claimCompaction(db, run.id,
    carrying.attemptId, { launch: carrying.invocation.launch, mode }, at()));
  await step('settle compacted', () => settle({ state: 'compacted', message: null }));
  assert.equal(latest(), 'compacted');
  const unanswered = await compacting('an unanswered turn');
  await step('carry it', () => carry(unanswered));
  await step('settle without an answer', () => settle(null));
  assert.equal(latest(), 'unknown', 'sent with its instruction and never answered');
  const anew = await compacting('a turn that starts anew');
  await step('drop it at a new conversation', () => carry(anew, 'start'));
  assert.equal(latest(), 'dropped');
  const unsent = await compacting('an unsent turn');
  await step('carry the unsent one', () => carry(unsent));
  await step('arrange an unsent initial input', () => runs.write(() => {
    runs.connection.prepare("UPDATE run_inputs SET state='not_sent' WHERE input_id=?").run(carrying.initialInputId);
    touch(runs.connection, { kind: 'input', id: carrying.initialInputId });
  }));
  await step('drop it with its unsent instruction', () => settle(null));
  assert.equal(latest(), 'dropped');
  await step('keep one the agent cannot compact as dropped', async () => {
    const run = await conversationRun(talked.id);
    write(db => requestCompaction(db, { ...run, launch: { ...run.launch, adapter: 'copilot', values: {} } }, null, false, at()));
  });
  assert.equal(latest(), 'dropped', 'Copilot cannot compact on its automatic choice of model');


  const missing = inventory.filter(site => trackedSite(site) && !observed.seen.has(siteId(site)));
  assert.deepEqual(missing.map(site => `${site.file}:${site.line} ${site.sql}`), [], 'every write site classified for exercise executes at least once');
  await t.test('return routing records carry every committed journal key', () => {
    assert.deepEqual({ missingKeys: pending,
      unexercisedSites: inventory.filter(site => site.status === 'pending-routing' && !observed.seen.has(siteId(site))).map(siteId) },
    { missingKeys: [], unexercisedSites: [] });
  });
});

test('the independent row oracle fails when a managed writer omits its touch', async t => {
  const { root, after } = changeFixture(t), journal = keepControlChanges(root); after(journal.close);
  const audit = changeAudit(root, journal.log); after(audit.close);
  const store = new ControlStore(root); after(() => store.close());
  await assert.rejects(audit.step('deliberately unmarked mutation', () => store.write(db => {
    db.prepare("UPDATE tasks SET title='Missing notification' WHERE external_id='P1'").run();
  })), /missing tasks/);
});
