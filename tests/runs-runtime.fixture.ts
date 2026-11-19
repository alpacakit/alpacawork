import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { reconcileCompletedRunFiles } from '@alpacawork/backend/test-dist/runs/gc.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { coordinatorCwd, planInputs, publishCommands } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { grantFixtureRequest, initializeControlFixture } from './helpers/control-fixture.ts';
/** Exercise the built internal manager with isolated roots and fake agents only. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { PlacementStore } from '@alpacawork/backend/test-dist/control/placements.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cleanupGroups } from './helpers/process-groups.ts';
export { processes } from './helpers/process-groups.ts';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { randomUUID } from 'node:crypto';
import { RunStore, type CreateRunFields, type RunTransaction } from '@alpacawork/runs';
import type { CoordinatorRunRecord, RunRecord, RuntimeRunRecord } from '@alpacawork/contract/run';
import { AGENTS_TEMPLATE, launchSnapshot, parseAgentsSettings, readAgentsSettings, type AgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { launch, settle, settleTransaction } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { ReturnRouter } from '@alpacawork/backend/test-dist/control/return-router.js';
import { ReturnLifecycle } from '@alpacawork/backend/test-dist/control/return-lifecycle.js';
import { TaskRepository } from '@alpacawork/backend/test-dist/control/task-store.js';
import { preserveTestFailure } from './helpers/failure-workspace.ts';

/** A settle point from outside the entries: its own store, closed afterwards. */
export async function settleAt(root: string, busyTimeoutMs: number) {
  const store = new RunStore(root, { busyTimeoutMs });
  try { return await settle(store); } finally { store.close(); }
}

export const fake = join(import.meta.dirname, 'fixtures/fake-run-agent.mjs');
export const now = () => new Date().toISOString();
export async function until<T>(check: () => T | null | undefined | false, message: string, timeout = 12_000): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check(); if (value) return value;
    if (performance.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(20);
  }
}
export function alive(pid: number, group = false): boolean {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true; throw error; }
}
type Receipt = { pid: number; pgid: number; branch: string; env: Record<string, string>; prompt: string; cwd: string };
export function receipts(root: string): Receipt[] {
  const dir = join(root, 'processes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => { try { return [JSON.parse(readFileSync(join(dir, name), 'utf8'))]; } catch { return []; } });
}
const readOrManager=(path:string)=>{try{return readFileSync(path,'utf8').slice(-5000)}catch{return null}};
export async function setup(t: TestContext, limits: Partial<AgentsSettings['limits']> = {}, refusedPath?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-b2-')));
  const { taskId, ownerPlacementId, memberPlacementId, memberPlacementIds } = await initializeRuntimeParticipants(root);
  const store = new RunStore(root, { busyTimeoutMs: 3000 });
  const path = installAgentStub(root, 'claude', [process.execPath, fake, '--root', root, '--format', 'claude']);
  installAgentStub(root, 'alpacawork-agent', [process.execPath, fake, '--root', root, '--format', 'codex']);
  const config = {
    limits: { parallel: 4, run_minutes: 0, ...limits },
    agents: {
      plain: fixtureAgentSetting('codex'), claude: fixtureAgentSetting('claude'),
      codex: fixtureAgentSetting('codex'), own: fixtureAgentSetting('codex'), missing: fixtureAgentSetting('codex'),
    },
  };
  writeFileSync(join(root, 'config.yaml'), stringify(config, { aliasDuplicateObjects: false }));
  // A minimal serve projection pump: managers publish facts instead of opening this database.
  let projectionPaused = false;
  // The same transient/review fault policy applies to synchronous projection and
  // asynchronous settle. Intentional rejected result files stay available for the test.
  const projectionError = (error: unknown) => {
    if (!['busy', 'runs_unavailable'].includes((error as { code?: string }).code ?? '')) throw error;
  };
  const projection = setInterval(() => {
    if (projectionPaused) return;
    try {
      const imported = new RunEventImporter(store).pass();
      planInputs(store); publishCommands(store);
      for (const run of store.read()) reconcileCompletedRunFiles(store, run);
      if (imported.some(id => ['succeeded', 'failed', 'cancelled'].includes(store.runtimeGet(id)?.state ?? '')))
        void tick().catch(projectionError);
    } catch (error) { projectionError(error); }
  }, 100);
  t.after(async () => {
    clearInterval(projection);
    try {
      await preserveTestFailure(t, root, { diagnostics: () => {
        // Fault subjects may hand the writer to serve and close this fixture's connection.
        const observer = RunStore.openReadable(root, { busyTimeoutMs: 1000 });
        if (!observer) throw new Error('Failure diagnostics database is missing');
        try { return { task: new TaskRepository(root, observer.connection).get(taskId),
          snapshot: observer.snapshot(), processes: receipts(root) }; }
        finally { observer.close(); }
      } });
    } finally {
      try { await cleanupGroups(root); }
      finally { store.close(); rmSync(root, { recursive: true, force: true }); }
    }
  });
  const createIn = (tx: RunTransaction, agent = 'plain', plan: object = {}, extra: Partial<CreateRunFields> = {}) => {
    const settings = readAgentsSettings(root); assert.equal(settings.ok, true);
    if (!settings.ok) throw settings.error;
    const role = extra.role ?? (extra.caller && 'run' in extra.caller ? 'worker' : 'owner');
    const snapshot = launchSnapshot(settings.config, agent, extra.resumes ? 'resume' : 'start', path, {}, extra.resumes ? tx.get(extra.resumes)?.launch : undefined);
    assert.equal(snapshot.ok, true); if (!snapshot.ok) throw new Error(snapshot.code);
    const workerCount = tx.all().filter(item => item.role === 'worker').length;
    const requestId = extra.requestId ?? randomUUID();
    const placementId = extra.placementId ?? (role === 'worker'
      ? memberPlacementIds[workerCount % memberPlacementIds.length]! : ownerPlacementId);
    // A caller Run's Request comes from its placement and waits in its Task's open wait cycle, as admission records it.
    const sender = extra.caller ? tx.get(extra.caller.run) : null;
    if (extra.caller && !sender) throw new Error(`caller ${extra.caller.run} is missing`);
    const tasks = new TaskRepository(root, store.connection);
    const waitCycleId = sender ? new ReturnLifecycle(store.connection, tx, tasks.related(sender.task).tasks,
      tasks.projectFor(sender.task)).cycleFor(sender.task) : null;
    tx.insertRequest({ id: requestId, taskId, placementId,
      placementRevision: 1, taskHash: '0'.repeat(64), waitCycleId, headRunId: null, mode: 'new',
      body: 'fixture work', purpose: 'instruction',
      author: sender ? { kind: 'placement', placementId: sender.placementId } : { kind: 'human' }, submittedAt: now(), deliveryState: 'queued' });
    grantFixtureRequest(store, tx, requestId);
    const run = tx.create({ task: taskId, agent, role,
      placementId,
      requestId, resumes: null, continues: false,
      caller: null, cwd: root, launch: agent === 'missing' ? { ...snapshot.launch, argv: [join(root, 'does-not-exist')] } : snapshot.launch, ...extra,
      session: extra.session ?? (extra.resumes ? tx.get(extra.resumes)?.session : null) ??
        (snapshot.launch.adapter === 'claude' ? { provider: agent, id: `claude-${tx.all().length + 1}` } : null) }, JSON.stringify(plan));
    return run;
  };
  const create = (agent = 'plain', plan: object = {}, extra: Partial<CreateRunFields> = {}) => {
    const run = store.write(tx => createIn(tx, agent, plan, extra));
    store.prepareFolder(run.id);
    return run;
  };
  const createIndependent = (agent = 'plain', plan: object = {}, extra: Partial<CreateRunFields> = {}) => {
    const people=new PlacementStore(root);let placementId: string;try{placementId=people.createAndPlace({taskId,profileKey:agent,responsible:false}).placement.id}finally{people.close()}
    return create(agent,plan,{role:'worker',placementId,...extra});
  };
  /**
   * A message to the screen's coordinator, queued as the Run that answers it in the open conversation, with `plan` as
   * its prompt: no Task, placement or credential, and the agent's start command. The scheduler launches it as any
   * Run; `store.read()` reads it, as the Task-side reads leave it out.
   */
  const createCoordinator = (plan: object = {}, agent = 'plain'): CoordinatorRunRecord => {
    const settings = readAgentsSettings(root); assert.equal(settings.ok, true);
    if (!settings.ok) throw settings.error;
    const snapshot = launchSnapshot(settings.config, agent, 'start', path);
    assert.equal(snapshot.ok, true); if (!snapshot.ok) throw new Error(snapshot.code);
    const conversationId = new CoordinatorConversation(root).read().id, requestId = randomUUID();
    const run = store.write(tx => {
      tx.insertConversationRequest({ id: requestId, conversationId, headRunId: tx.coordinatorHead(conversationId)?.id ?? null,
        mode: 'new', body: 'fixture message', submittedAt: now(), deliveryState: 'queued' });
      return tx.createCoordinatorRun({ conversationId, requestId, agent, resumes: null, session: snapshot.launch.adapter === 'claude' ? { provider: 'claude', id: randomUUID() } : null,
        cwd: coordinatorCwd(root), restartArgv: null, launch: snapshot.launch, message: { context: null, attachments: [], intent: null } },
      JSON.stringify(plan));
    });
    store.prepareFolder(run.id);
    return run;
  };
  // A Task's Run or the coordinator's: these read the Run as the execution layer does (`runtimeGet`).
  const finish = (run: RuntimeRunRecord, state: 'succeeded' | 'failed' = 'succeeded') => store.write(tx => {
    const latest = tx.runtimeGet(run.id)!;
    if (latest.state === 'queued') tx.update({ ...latest, state: 'running', started_at: now() });
    tx.finish({ ...tx.runtimeGet(run.id)!, state, reason: state === 'failed' ? 'exit' : null, exit: { code: state === 'failed' ? 1 : 0, signal: null }, ended_at: now() },
      state === 'succeeded' ? { state: 'present', text: 'fixture reply' } : { state: 'missing', text: null });
  });
  const waitState = (run: RuntimeRunRecord, state: RuntimeRunRecord['state'], timeout?: number) => until(() => {
    const latest = store.runtimeGet(run.id);
    if (latest?.ended_at && latest.state !== state) throw new Error(`${run.id}: expected ${state}, observed ${latest.state} (${latest.reason})`);
    return latest?.state === state && latest;
  }, `${run.id} becomes ${state}`, timeout).catch(error=>{console.error(JSON.stringify({run:run.id,current:store.runtimeGet(run.id),inputs:store.connection.prepare('SELECT input_id,state FROM run_inputs').all(),managerLog:readOrManager(join(store.folder(run.id),'manager.log'))}));throw error});
  /** Result commit, manager exit, and serve's exchange cleanup have distinct lifetimes. */
  const waitExchangeCleanup = async (run: Pick<RuntimeRunRecord, 'id'>) => {
    await until(() => {
      const latest = store.runtimeGet(run.id);
      return latest?.pids.manager && !alive(latest.pids.manager);
    }, 'manager finished cleanup');
    const result = store.getText(run.id)?.resultState;
    if (result !== 'too_large' && result !== 'unreadable')
      await until(() => !existsSync(join(store.folder(run.id), 'result.tmp')), 'serve removes the committed exchange file');
  };
  const ready = (run: RuntimeRunRecord) => until(() => {
    const latest = store.runtimeGet(run.id); return latest?.pids.agent && receipts(root).find(r => r.pid === latest.pids.agent);
  }, `${run.id} agent ready`);
  const gate = (name: string) => join(root, name);
  const release = (name: string) => writeFileSync(gate(name), 'go');
  const continuations = (parent: RunRecord) => store.read().filter(r => r.resumes !== null && r.caller?.run === parent.id && r.role === parent.role);
  let managerScript: string | undefined;
  /** Freeze only manager monotonic time; agents and OS process cleanup stay real. */
  const clock = () => {
    assert.equal(managerScript, undefined, 'install the clock before launching a manager');
    const source = join(root, 'manager-clock'), observed = join(root, 'manager-clock-observed');
    writeFileSync(source, '0');
    managerScript = join(root, 'clock-manager.mjs');
    writeFileSync(managerScript, `import { readFileSync, writeFileSync } from 'node:fs';
      Object.defineProperty(performance, 'now', { value: () => {
        const value = Number(readFileSync(${JSON.stringify(source)}, 'utf8'));
        // Acknowledge after the caller has evaluated its deadline and sent any signal.
        queueMicrotask(() => writeFileSync(${JSON.stringify(observed)}, String(value)));
        return value;
      }});
      await import(${JSON.stringify(new URL('../apps/backend/dist/run-manager.js', import.meta.url).href)});
    `);
    const set = (milliseconds: number) => {
      writeFileSync(source + '.tmp', String(milliseconds));
      renameSync(source + '.tmp', source);
    };
    return {
      /** Moves the time without waiting for the manager to read it. */
      set,
      async advanceTo(milliseconds: number) {
        set(milliseconds);
        await until(() => existsSync(observed) && readFileSync(observed, 'utf8') === String(milliseconds),
          `manager observes monotonic time ${milliseconds}`);
      },
    };
  };
  const tick = async () => {
    if (!managerScript) return settleAt(root, 3000);
    // Unlike settle(), clock-driven ticks only launch and skip lost-manager cleanup.
    return launch(store, await settleTransaction(store, readAgentsSettings(root)), { script: managerScript });
  };
  const pass = () => new ReturnRouter(root).pass();
  return { root, store, config, path, taskId, ownerPlacementId, memberPlacementId, memberPlacementIds,
    pauseProjection: () => { projectionPaused = true; },
    create, createIn, createIndependent, createCoordinator, finish, waitState, waitExchangeCleanup, ready, gate, release, continuations, clock,
    tick, pass };
}

/** Server-facing cases need a real Task, in the fixture's project, for their low-level Run fixture; returns its ID. */
async function initializeServerTask(root: string): Promise<string> {
  const writer = new FileWriter(root);
  let project: string;
  try { project = initializeControlFixture(root); } finally { writer.close(); }
  return (await new ControlTaskCommands(root, { kind: 'human' })
    .create({ parentId: project, userRequested: false, tasks: [{ title: 'Runtime fixture' }] })).tasks[0].id;
}

/** Direct RunStore cases still need the current Task and its owner/member placements. */
async function initializeRuntimeParticipants(root: string) {
  const taskId = await initializeServerTask(root);
  const people = new PlacementStore(root);
  try {
    const owner = people.createAndPlace({ taskId, profileKey: 'claude', responsible: true });
    const members = Array.from({ length: 4 }, (_, index) => people.createAndPlace({ taskId,
      profileKey: 'plain', responsible: false }));
    return { taskId, ownerPlacementId: owner.placement.id, memberPlacementId: members[0]!.placement.id,
      memberPlacementIds: members.map(item => item.placement.id) };
  } finally { people.close(); }
}
