import { decideValues, seedValues } from './helpers/task-values.ts';
import { fixtureAgentSetting } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { runNumber } from '@alpacawork/contract/run';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { reconcileStateLinks } from '@alpacawork/backend/test-dist/control/task-reports.js';

/** The owner Runs' starts and ends in `project`, applied in one write as a ReturnRouter pass applies them first. */
export function reconcileLinks(root: string, project: string) {
  const control = new ControlStore(root);
  try {
    return control.write(db => {
      const store = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
      try { return store.write(runs => reconcileStateLinks({ store, runs }, project)); }
      finally { store.close(); }
    });
  } finally { control.close(); }
}

/**
 * One seat and its returns, with no process launched: the Task `task`, its responsible `owner` and its worker. A
 * person's and the owner Run's Requests go through task request's service, which opens the seat's wait cycle for a
 * placement's Request; a question goes through task report's. A Run starts and ends in the store, as its manager writes
 * it, and a pass is ReturnRouter's, which applies those boundaries and writes, delivers and settles the returns.
 */
export async function handlingFixture(t: { after(cleanup: () => void): unknown }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-handling-')));
  const project = initializeControlFixture(root);
  // No agent process runs here: use an adapter whose start assigns its session at admission.
  writeFileSync(join(root, 'config.yaml'), stringify({ "limits":{"automatic_per_placement":2000}, agents: { "fake": fixtureAgentSetting('claude') } }));
  const commands = new ControlTaskCommands(root, { kind: 'human' });
  // A question asks its Task's decide value.
  const task = (await commands.create({ parentId: project, userRequested: false,
    tasks: [{ title: 'Owner', values: { decide: [{ decide_kind: 'choose', decide_question: 'Please decide' }] } }] })).tasks[0]!;
  const current = async () => new ControlTaskStore(root).get(task.id);
  const owner = await assignResponsible(root, task, 'fake');
  const worker = (await new PlacementCommands(root).placeMember({ taskId: task.id, profileKey: 'fake',
    expectedTaskHash: (await current()).hash, expectedResponsibleRevision: owner.revision }, { kind: 'human' })).placement;
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const requests = new TaskRequestService(root), router = new ReturnRouter(root);
  const reconcile = () => reconcileLinks(root, project);
  const start = async (id: string) => {
    store.write(tx => tx.update({ ...tx.get(id)!, state: 'running', started_at: new Date().toISOString(), pids: { manager: 1, agent: 2 } }));
    await reconcile();
  };
  const end = (id: string, state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded') => {
    // A simulated successful reserved launch proves its initial receipt, as the real manager does.
    if (state === 'succeeded' && store.get(id)?.context?.rotationFrom &&
        !store.connection.prepare('SELECT 1 FROM run_attempts WHERE run_no=?').get(runNumber(id))) {
      uncertain(id);
      store.connection.prepare("UPDATE run_inputs SET state='taken' WHERE instruction_run_no=? AND initial=1").run(runNumber(id));
    }
    return store.write(tx => tx.finish({ ...tx.get(id)!, state,
      reason: state === 'failed' ? 'output' : state === 'cancelled' ? 'stopped' : null, ended_at: new Date().toISOString() },
    { state: 'present', text: 'result' }));
  };
  const person = { kind: 'human' } as const;
  /** A person, the user's proxy, asks the owner to work (W0): the Request carries the returns waiting for the seat. */
  const human = async () => { const result = await requests.request({ task: task.id, body: 'Work', opId: randomUUID(),
    expectedTaskHash: (await current()).hash, expectedPlacementRevision: owner.revision }, person, person);
    assert.equal(result.outcome.kind, 'request_accepted');
    if (result.outcome.kind !== 'request_accepted') throw new Error('Expected a work Request');
    return result.outcome.request; };
  /** The owner Run `caller` delegates to the worker: a Request in the seat's open wait cycle. */
  const delegate = async (caller: string, member = worker) => { const result = await requests.request({ task: task.id, body: 'Investigate',
    opId: randomUUID(), agent: member.id, expectedTaskHash: (await current()).hash,
    expectedPlacementRevision: member.revision }, { kind: 'placement', placementId: owner.id },
  { kind: 'run', runId: caller, placementId: owner.id, taskId: task.id, role: 'owner', responsible: true });
    assert.equal(result.outcome.kind, 'request_accepted');
    if (result.outcome.kind !== 'request_accepted') throw new Error('Expected a worker Request');
    return result.outcome.request; };
  /** The owner Run `runId` explicitly asks the parent (the user at project level) the question of its body; returns the question's ID. */
  const ask = async (runId: string, opId: string = randomUUID()) => {
    await new TaskReportService(root).report({ task: task.id, state: 'waiting', askTo: 'user', title: 'Question',
      description: 'Please decide', opId, expectedTaskHash: (await current()).hash },
    { kind: 'placement', placementId: owner.id },
    { kind: 'run', runId, placementId: owner.id, taskId: task.id, role: 'owner', responsible: true });
    return opId;
  };
  const pass = () => router.pass();
  const runOf = (requestId: string) => store.getRequest(requestId)!.runId!;
  /**
   * The worker's closing return delivered to the owner by a wake: the owner delegates and ends, the worker's end closes
   * its Request, and a pass wakes the owner with that return. `startWake` starts the wake's Run with its agent, which
   * takes the delivery.
   */
  const deliver = async (startWake = true) => {
    const first = await human(); await start(first.runId);
    const work = await delegate(first.runId); await start(work.runId);
    end(first.runId); await pass();
    end(work.runId);
    const dispatched = await pass();
    assert.equal(dispatched.acceptedRequestIds.length, 1);
    const wake = dispatched.acceptedRequestIds[0]!, run = runOf(wake);
    const answer = store.readReturns().find(row => row.requestId === work.requestId)!;
    if (startWake) await start(run);
    return { first, work, request: wake, run, answer };
  };
  /** The wake Run `run` succeeds: a pass consumes the deliveries its agent took. */
  const consume = async (run: string) => { end(run); await pass(); };
  /**
   * The agent's receipt of the input that carried `run`'s instruction is unknown, as a manager lost while handing it
   * over leaves it (run_inputs uncertain): into `run`'s own launch, or into `into`, the working Run it joined.
   */
  const uncertain = (run: string, into: string = run) => {
    const attempt = randomUUID();
    store.connection.prepare('INSERT INTO run_attempts(run_no,attempt_id,launch_json) VALUES (?,?,?)')
      .run(runNumber(into), attempt, '{}');
    store.connection.prepare('INSERT INTO run_inputs(input_id,attempt_id,instruction_run_no,content_digest,state,initial) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), attempt, runNumber(run), 'a'.repeat(64), 'uncertain', into === run ? 1 : 0);
  };
  return { root, project, task, owner, worker, store, commands, current, reconcile, start, end, human, delegate, ask,
    pass, runOf, deliver, consume, uncertain };
}
