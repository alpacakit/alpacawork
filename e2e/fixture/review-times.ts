import { fixtureAgentSetting } from '../../tests/helpers/agent-stub.ts';
import { stringify } from 'yaml';
/**
 * Awaiting review rows beside a task at work, through the real services, on an isolated workspace. Each task is
 * user-requested and its owner reports as it would: an estimate, then a question to the user with its Run ended (`asked`),
 * the same with the Run still going (`askedRunning`), a question asked before any estimate (`pending`), and a report sent
 * for review (`review`). `idle` has an estimate and its Run ended on a request to a child that asks the user, so it
 * waits in Idle. `working` has an estimate, a progress report after it (`progress`, the report a press on the line opens) and its Run
 * going, with no question. The two Runs that go last output now, so a page clock set later sees that output as old.
 */
import { mkdtempSync, openSync, closeSync, realpathSync, rmSync, writeFileSync, constants } from 'node:fs';
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
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { startServer } from './server.ts';
import { test } from '../fixtures.ts';

export async function reviewTimes() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-review-times-')));
  const project = initializeControlFixture(root);
  writeFileSync(join(root, 'config.yaml'), stringify({ limits: { parallel: 8, automatic_per_placement: 2000 }, agents: { fake: fixtureAgentSetting('codex') } }));
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  const requests = new TaskRequestService(root), reports = new TaskReportService(root);
  const person = { kind: 'human' } as const;
  const current = (id: string) => new ControlTaskStore(root).get(id);
  const start = async (id: string) => {
    store.write(tx => tx.update({ ...tx.get(id)!, state: 'running', started_at: new Date().toISOString(), pids: { manager: 1, agent: 2 } }));
    await reconcileLinks(root, project);
  };
  // A Run goes while its manager lock is held, until `close`.
  const locks: number[] = [];
  const hold = (id: string) => {
    store.prepareFolder(id);
    const fd = openSync(join(store.folder(id), RUN_FILES.managerLock), constants.O_RDWR | constants.O_CREAT, 0o600);
    if (!tryLock(fd)) throw new Error(`Manager lock of ${id} is taken`);
    locks.push(fd);
  };
  /** The Run's last output, now: a page clock set later sees it as old. */
  const output = (id: string) => writeFileSync(join(store.folder(id), RUN_FILES.activity),
    JSON.stringify({ at: new Date().toISOString(), kind: 'output', toolName: null, doing: null, note: null }));
  const end = (id: string) => store.write(tx => tx.finish({ ...tx.get(id)!, state: 'succeeded', reason: null, ended_at: new Date().toISOString() }, { state: 'present', text: 'result' }));
  /**
   * A task whose owner's Run has started: a user-requested one on the user's request, or a child of `from` on its owner's
   * request.
   */
  const working = async (title: string, from?: { id: string; placementId: string; run: Parameters<TaskRequestService['request']>[2] }) => {
    const task = (await commands.create({ parentId: from?.id ?? project, userRequested: !from, tasks: [{ title, values: { decide: [{ decide_question: 'Which one?', decide_note: 'A or B.' }] } }] })).tasks[0]!;
    const owner = await assignResponsible(root, await current(task.id), 'fake');
    const input = { task: task.id, body: 'Work', opId: randomUUID(), expectedTaskHash: (await current(task.id)).hash,
      expectedPlacementRevision: owner.revision };
    const outcome = (await (from ? requests.request(input, { kind: 'placement', placementId: from.placementId }, from.run)
      : requests.request(input, person, person))).outcome as unknown as { kind: string; request: { runId: string } };
    if (outcome.kind !== 'request_accepted') throw new Error(JSON.stringify(outcome));
    const runId = outcome.request.runId;
    await start(runId);
    const actor = { kind: 'placement', placementId: owner.id } as const;
    const run = { kind: 'run', runId, placementId: owner.id, taskId: task.id, role: 'owner', responsible: true } as const;
    const report = async (fields: { state: 'doing' | 'waiting' | 'done'; title: string; description: string; estimateMinutes?: number; askTo?: 'user' }) =>
      reports.report({ task: task.id, ...fields, opId: randomUUID(), expectedTaskHash: (await current(task.id)).hash }, actor, run)
        .then(result => result.outcome.opId);
    return { id: task.id, runId, placementId: owner.id, run, report };
  };
  const estimate = (task: Awaited<ReturnType<typeof working>>) => task.report({ state: 'doing', title: 'Until the report', description: 'Working', estimateMinutes: 30 });
  const ask = (task: Awaited<ReturnType<typeof working>>) => task.report({ state: 'waiting', askTo: 'user', title: 'Which one?', description: 'A or B' });

  const asked = await working('Asked after an estimate');
  await estimate(asked); await ask(asked); end(asked.runId);
  const askedRunning = await working('Asked with its Run still going');
  await estimate(askedRunning); await ask(askedRunning); hold(askedRunning.runId); output(askedRunning.runId);
  const pending = await working('Asked before an estimate');
  await ask(pending); end(pending.runId);
  const review = await working('Sent for review');
  await estimate(review); await review.report({ state: 'done', title: 'Done', description: 'Ready for review' }); end(review.runId);
  const idle = await working('Idle after an estimate');
  await estimate(idle);
  const asking = await working('A child asking the user', idle);
  await ask(asking); end(asking.runId); end(idle.runId);
  const doing = await working('At work with an estimate');
  await estimate(doing);
  const progress = await doing.report({ state: 'doing', title: 'Reconciliation in progress', description: 'Halfway' });
  hold(doing.runId); output(doing.runId);
  await new ReturnRouter(root).pass(); await reconcileLinks(root, project);
  return {
    root, project, asked: asked.id, askedRunning: askedRunning.id, pending: pending.id, review: review.id, idle: idle.id, working: doing.id, progress,
    close: () => { for (const fd of locks) { unlock(fd); closeSync(fd); } store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/**
 * A case on this scene, served on its own workspace with the page's clock left to the case. A live page can reconnect its
 * event stream while serve is closing, so the browser's clients are released before the server (coordinator-media).
 */
export const reviewTimesTest = test.extend<{ scene: Awaited<ReturnType<typeof reviewTimes>> }>({
  fixedTime: false,
  context: async ({ context, runtime: _runtime }, use) => {
    try { await use(context); } finally { await context.close(); }
  },
  scene: async ({}, use) => {
    const fixture = await reviewTimes();
    try { await use(fixture); } finally { fixture.close(); }
  },
  runtime: async ({ scene }, use) => {
    const server = await startServer(scene.root, 0);
    try { await use({ root: scene.root, origin: new URL(server.url).origin }); } finally { await server.close(); }
  },
});
