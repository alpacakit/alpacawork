import { fixtureAgentSetting } from '../../tests/helpers/agent-stub.ts';
import { stringify } from 'yaml';
/**
 * A tree of Tasks whose Runs really go, through the real services, on an isolated workspace. `busy` has its owner and
 * a member running, a child and a grandchild running, a child that reported done while its Run still goes (no page loads
 * it), and a child whose Run is still queued. `single` has only its owner running; `queuedOnly` only a queued Run; `asked`
 * waits on the reader with its Run going; `crowded` has 128 Runs going, for the count's three digits. Its limit of one
 * running Run keeps the queued ones queued while serve runs.
 */
import { closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assignResponsible, initializeControlFixture } from '../../tests/helpers/control-fixture.ts';
import { reconcileLinks } from '../../tests/return-handling.fixture.ts';
import { RunStore } from '@alpacawork/runs';
import { RUN_FILES } from '@alpacawork/contract/run';
import { tryLock, unlock } from '@alpacawork/core';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { startServer } from './server.ts';
import { test } from '../fixtures.ts';

export async function runningRuns() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-running-runs-')));
  const project = initializeControlFixture(root);
  // initializeControlFixture installs the claude stub as /usr/bin/false on its isolated PATH.
  writeFileSync(join(root, 'config.yaml'), stringify({ limits: { parallel: 1, automatic_per_placement: 2000 }, agents: { fake: fixtureAgentSetting('claude') }, coordinatorAiStack: [{ agent: 'fake', values: {} }] }));
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  const requests = new TaskRequestService(root), reports = new TaskReportService(root);
  const person = { kind: 'human' } as const;
  const current = (id: string) => new ControlTaskStore(root).get(id);
  const locks = new Map<string, number>();
  /** A Run goes while its manager lock is held. */
  const start = async (id: string) => {
    store.write(tx => tx.update({ ...tx.get(id)!, state: 'running', started_at: new Date().toISOString(), pids: { manager: 1, agent: 2 } }));
    store.prepareFolder(id);
    const fd = openSync(join(store.folder(id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
    if (!tryLock(fd)) throw new Error(`Manager lock of ${id} is taken`);
    locks.set(id, fd);
    await reconcileLinks(root, project);
  };
  const release = (id: string) => { const fd = locks.get(id)!; unlock(fd); closeSync(fd); locks.delete(id); };
  const end = async (id: string) => {
    release(id);
    store.write(tx => tx.finish({ ...tx.get(id)!, state: 'succeeded', reason: null, ended_at: new Date().toISOString() }, { state: 'present', text: 'result' }));
    await reconcileLinks(root, project);
  };
  const accepted = (result: { outcome: unknown }) => {
    const outcome = result.outcome as { kind: string; request: { runId: string } };
    if (outcome.kind !== 'request_accepted') throw new Error(JSON.stringify(outcome));
    return outcome.request.runId;
  };
  type Owned = { id: string; placementId: string; runId: string; run: Parameters<TaskRequestService['request']>[2] };
  /** A Task whose owner's Run exists: a top one on the user's request, or a child of `from` on its owner's. */
  const task = async (title: string, from?: Owned, go = true): Promise<Owned> => {
    const made = (await commands.create({ parentId: from?.id ?? project, userRequested: !from, tasks: [{ title, values: { decide: [{ decide_question: 'Which one?', decide_note: 'A or B.' }] } }] })).tasks[0]!;
    const owner = await assignResponsible(root, await current(made.id), 'fake');
    const input = { task: made.id, body: 'Work', opId: randomUUID(), expectedTaskHash: (await current(made.id)).hash, expectedPlacementRevision: owner.revision };
    const runId = accepted(await (from ? requests.request(input, { kind: 'placement', placementId: from.placementId }, from.run) : requests.request(input, person, person)));
    if (go) await start(runId);
    return { id: made.id, placementId: owner.id, runId, run: { kind: 'run', runId, placementId: owner.id, taskId: made.id, role: 'owner', responsible: true } as Owned['run'] };
  };
  const report = async (on: Owned, fields: { state: 'doing' | 'waiting' | 'done'; title: string; description: string; estimateMinutes?: number; askTo?: 'user' }) =>
    reports.report({ task: on.id, ...fields, opId: randomUUID(), expectedTaskHash: (await current(on.id)).hash }, { kind: 'placement', placementId: on.placementId }, on.run);
  /** A member on `on`, asked by its owner, with a Run of its own. */
  const member = async (on: Owned, go = true) => {
    const expectedResponsibleRevision = store.write(tx => tx.getPlacement(on.placementId)!.revision);
    const placement = (await new PlacementCommands(root).placeMember({ taskId: on.id, profileKey: 'fake', expectedTaskHash: (await current(on.id)).hash, expectedResponsibleRevision },
      { kind: 'placement', placementId: on.placementId })).placement;
    const runId = accepted(await requests.request({ task: on.id, agent: placement.id, body: 'Help', opId: randomUUID(),
      expectedTaskHash: (await current(on.id)).hash, expectedPlacementRevision: placement.revision }, { kind: 'placement', placementId: on.placementId }, on.run));
    if (go) await start(runId);
    return runId;
  };

  const busy = await task('A long and detailed task that runs with a member and children under it');
  await report(busy, { state: 'doing', title: 'Until the report', description: 'Working', estimateMinutes: 60 });
  const busyMember = await member(busy);
  const child = await task('A child at work', busy);
  const grandchild = await task('A grandchild at work', child);
  const finishing = await task('A child that reported done while its Run still goes', busy);
  await report(finishing, { state: 'done', title: 'Done', description: 'Done' });
  const waiting = await task('A child whose Run is still queued', busy, false);
  const single = await task('A task with only its owner running');
  const queuedOnly = await task('A task with only a queued Run', undefined, false);
  const asked = await task('A task asking the reader with its Run going');
  await report(asked, { state: 'waiting', askTo: 'user', title: 'Which one?', description: 'A or B' });
  const crowded = await task('A crowded task, whose count has three digits, with a title long enough to meet it at the end of the row');
  await report(crowded, { state: 'doing', title: 'Until the report', description: 'Working', estimateMinutes: 600 });
  for (let at = 0; at < 127; at++) await member(crowded);
  return {
    root, project, busy: busy.id, single: single.id, queuedOnly: queuedOnly.id, asked: asked.id, crowded: crowded.id,
    busyMember, grandchildRun: grandchild.runId, finishingRun: finishing.runId, waitingRun: waiting.runId, queuedOnlyRun: queuedOnly.runId, singleRun: single.runId, start, end,
    close: () => { for (const id of [...locks.keys()]) release(id); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** A case on this scene, served on its own workspace; the browser's clients go before the server (review-times). */
export const runningRunsTest = test.extend<{ scene: Awaited<ReturnType<typeof runningRuns>> }>({
  fixedTime: false,
  context: async ({ context, runtime: _runtime }, use) => {
    try { await use(context); } finally { await context.close(); }
  },
  scene: async ({}, use) => {
    const fixture = await runningRuns();
    try { await use(fixture); } finally { fixture.close(); }
  },
  runtime: async ({ scene }, use) => {
    const server = await startServer(scene.root, 0);
    try { await use({ root: scene.root, origin: new URL(server.url).origin }); } finally { await server.close(); }
  },
});
