import { decideValues, seedValues } from './helpers/task-values.ts';
import type { TaskValues } from '@alpacawork/contract';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import assert from 'node:assert/strict';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { reconcileLinks } from './return-handling.fixture.ts';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore } from '@alpacawork/runs';
import type { RunRecord } from '@alpacawork/contract/run';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore, TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';

const human = { kind: 'human' } as const;
/** A body whose decide section a question asks: a question's full text is there. */
/** Values with one question, so the Task can ask. */
export const DECIDE = { decide: [{ decide_question: 'Which way?' }] };
/** A Task's responsible, by its placement. */
export type Responsible = { id: string; placementId: string };
/** A Run of a Task's responsible: what it reports and asks as. */
export type Seat = Responsible & { runId: string };

/**
 * Tasks of the fixture's project driven as the server drives them, with no process launched. A person creates the
 * Tasks, places their responsibles and asks them to work (task request), or a responsible's Run asks its child; the
 * Run starts and ends in the store, as its manager writes it, and its start and end are applied as a pass applies them
 * (reconcileLinks). The responsible's Run reports, asks and withdraws as its own caller; a person, the user's proxy,
 * holds, returns from a hold, answers, confirms and stops. Each acts as authorize decides it would: these call the
 * services that act after it.
 */
export async function taskFlow(t: { after(cleanup: () => void): unknown }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-task-flow-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = initializeControlFixture(root);
  // No process runs in this fixture; admission assigns the session for each new launch.
  const setting = fixtureAgentSetting('claude');
  // These synthetic requests deliberately admit no model or effort. Keep that absence explicit.
  setting.params = Object.fromEntries(Object.keys(setting.params).map(key => [key, []]));
  writeFileSync(join(root, 'config.yaml'), stringify({ agents: { fake: setting } }), { mode: 0o600 });
  const commands = new ControlTaskCommands(root, human), tasks = new ControlTaskStore(root);
  const get = (id: string) => tasks.get(id);
  const state = async (id: string) => (await get(id)).meta.state;
  const reconcile = () => reconcileLinks(root, project);
  const store = <T>(work: (runs: RunStore) => T): T => {
    const runs = new RunStore(root, { busyTimeoutMs: 1_000 });
    try { return work(runs); } finally { runs.close(); }
  };
  /** A task below `parentId` (the project when left out), not yet anyone's work: the user's request only when marked. */
  const plan = async (title: string, options: { parentId?: string; userRequested?: boolean; values?: TaskValues } = {}) =>
    (await commands.create({ parentId: options.parentId ?? project, userRequested: options.userRequested ?? false,
      tasks: [{ title, values: options.values ?? DECIDE }] })).tasks[0]!.id as string;
  /** A planned task with its responsible placed. */
  const task = async (title: string, options: Parameters<typeof plan>[1] = {}): Promise<Responsible> => {
    const id = await plan(title, options);
    return { id, placementId: (await assignResponsible(root, await get(id), 'fake')).id };
  };
  /** Task `to`'s responsible is asked to work by `from`'s Run, or by a person; returns its Run, still queued. */
  const request = async (to: Responsible, from?: Seat): Promise<Seat> => {
    const revision = store(runs => runs.getPlacement(to.placementId)!.revision);
    const input = { task: to.id, body: 'Do the work', opId: randomUUID(), expectedTaskHash: (await get(to.id)).hash,
      expectedPlacementRevision: revision };
    const { outcome } = from === undefined ? await new TaskRequestService(root).request(input, human, human)
      : await new TaskRequestService(root).request(input, { kind: 'placement', placementId: from.placementId },
        { kind: 'run', runId: from.runId, placementId: from.placementId, taskId: from.id, role: 'owner', responsible: true });
    if (outcome.kind !== 'request_accepted') throw new Error('Expected an accepted work Request');
    return { ...to, runId: outcome.request.runId };
  };
  /** The Run starts, and its start is applied. */
  const start = (seat: Seat) => {
    store(runs => runs.write(tx => tx.update({ ...tx.get(seat.runId)!, state: 'running',
      started_at: new Date().toISOString() })));
    reconcileLinks(root, store(runs => new TaskRepository(root, runs.connection).projectFor(seat.id)));
  };
  /** Task `to`'s responsible works: asked by `from`'s Run or by a person, its Run has started. */
  const work = async (to: Responsible, from?: Seat) => {
    const seat = await request(to, from);
    start(seat);
    return seat;
  };
  /** The Run ends, and its end is applied. */
  const end = (seat: Seat, ended: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') => {
    store(runs => runs.write(tx => tx.finish({ ...tx.get(seat.runId)!, state: ended,
      reason: ended === 'failed' ? 'exit' as const : ended === 'cancelled' ? 'stopped' as const : null,
      ended_at: new Date().toISOString() },
    ended === 'succeeded' ? { state: 'present', text: 'done' } : { state: 'missing', text: null })));
    reconcileLinks(root, store(runs => new TaskRepository(root, runs.connection).projectFor(seat.id)));
  };
  const run = (seat: Seat): RunRecord => store(runs => runs.get(seat.runId)!);
  const asRun = (seat: Seat) => [{ kind: 'placement', placementId: seat.placementId } as const,
    { kind: 'run', runId: seat.runId, placementId: seat.placementId, taskId: seat.id, role: 'owner', responsible: true } as const] as const;
  /** The responsible's Run reports on its own Task: doing, done (urgent with a reason) or stopped. */
  const report = async (seat: Seat, reported: 'doing' | 'done' | 'stopped', urgent?: string) =>
    new TaskReportService(root).report({ task: seat.id, state: reported, title: `${reported} report`, description: `The work is ${reported}.`, urgent,
      opId: randomUUID(), expectedTaskHash: (await get(seat.id)).hash }, ...asRun(seat));
  /** The responsible's Run asks its chosen destination the question of its Task's body; returns the question's ID. */
  const ask = async (seat: Seat, askTo?: string) => {
    const opId = randomUUID();
    await new TaskReportService(root).report({ task: seat.id, state: 'waiting', askTo: askTo ?? ((await get((await get(seat.id)).meta.parentId!)).meta.kind === 'project' ? 'user' : (await get(seat.id)).meta.parentId!), title: 'Which way?',
      description: 'A or B', opId, expectedTaskHash: (await get(seat.id)).hash }, ...asRun(seat));
    return opId;
  };
  /** The responsible's Run withdraws its open question. */
  const withdraw = async (seat: Seat, questionId: string) =>
    new TaskReportService(root).report({ task: seat.id, withdraw: questionId, opId: randomUUID(),
      expectedTaskHash: (await get(seat.id)).hash }, ...asRun(seat));
  /** Whom the question asked answers it: the asking Task's parent's Run, or a person for the user. */
  const answer = async (taskId: string, questionId: string, by?: Seat) => {
    const input = { task: taskId, body: 'This way', answers: questionId, opId: randomUUID() };
    const service = new TaskRequestService(root);
    return by === undefined ? service.request(input, human, human) : service.request(input, ...asRun(by));
  };
  /** A person, the user's proxy, holds Task `id`, returns it from the hold to its source, or stops it. */
  const person = async (id: string, reported: import('@alpacawork/raw').TaskState) =>
    new TaskReportService(root).report({ task: id, state: reported, title: `${reported} by the user`, opId: randomUUID(),
      expectedTaskHash: (await get(id)).hash }, human, human);
  /** A person confirms the review of Task `id`'s Run `aboutRun`, at its responsible's revision. */
  const confirm = async (id: string, aboutRun: string) => {
    const revision = store(runs => runs.readPlacements(reader => reader.responsiblePlacement(id))!.revision);
    return new TaskReportService(root).report({ task: id, state: 'done', aboutRun, opId: randomUUID(),
      expectedTaskHash: (await get(id)).hash, expectedPlacementRevision: revision }, human, human);
  };
  /** The current turn ends awaiting its results; the router's real wake starts and its agent takes those results. */
  const receive = async (seat: Seat): Promise<Seat> => {
    end(seat);
    const dispatched = await new ReturnRouter(root).pass(undefined, { project });
    const received = store(runs => dispatched.acceptedRequestIds.map(id => runs.getRequest(id)!)
      .find(request => request.taskId === seat.id));
    assert.ok(received?.runId, 'The real router must wake this seat with its result');
    const next = { ...seat, runId: received.runId };
    start(next);
    // The real manager's started agent proves the initial input receipt (ReturnLifecycle.returnReceipt).
    store(runs => runs.write(tx => tx.update({ ...tx.get(next.runId)!, pids: { manager: 1, agent: 2 } })));
    return next;
  };
  return { root, project, commands, get, state, reconcile, store, plan, task, request, start, work, end, run, report, receive,
    ask, withdraw, answer, person, confirm };
}
