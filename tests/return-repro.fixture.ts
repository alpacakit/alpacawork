import { decideValues, seedValues } from './helpers/task-values.ts';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { cliCommand, textFile } from './helpers/cli-session.ts';
/** Counterexamples driven through the public `workspace returns` entry. */
import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { FileWriter } from '@alpacawork/backend/test-dist/raw/storage.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { PlacementCommands } from '@alpacawork/backend/test-dist/control/placement-commands.js';
import { RunEventImporter } from '@alpacawork/backend/test-dist/runs/event-importer.js';
import { readControlTree } from './helpers/control-tree.ts';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { RunStore } from '@alpacawork/runs';
import type { RunRecord } from '@alpacawork/contract/run';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { RoutingOwner } from '@alpacawork/backend/test-dist/receiver/routing-owner.js';
import { awaitsReview, problemSchema, userTurn } from '@alpacawork/contract';
import { commandCatalog } from '@alpacawork/contract/commands';
import { Problem } from '@alpacawork/core';
import { reconcileLinks } from './return-handling.fixture.ts';
import { stringify } from 'yaml';
import { fixtureAgentSetting, installAgentStub } from './helpers/agent-stub.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
import { POLL_INTERVAL_MS } from '@alpacawork/backend/test-dist/poll-interval.js';

const config = (limit = 20, adapter: 'claude' | 'codex' = 'claude') => stringify({
  limits: { parallel: 1, automatic_per_placement: limit },
  agents: { fake: { ...fixtureAgentSetting(adapter), env: [] } },
});
const servers = new Map<string, Awaited<ReturnType<typeof startServer>>>();
/** The user's outside Codex conversation, where the coordinator speaks for the user. */
const COORDINATOR = 'return-repro-coordinator';
/** A Run calls with its credential, as its manager hands it over. */
const asRun = (root: string, runId: string) =>
  ({ ALPACAWORK_RUN: runId, ALPACAWORK_RUN_TOKEN: issueRunCredential(root, runId) });
/** A write carries its own operation ID unless one is named; the contract's command table says which commands write. */
const withOpId = (args: string[]) =>
  commandCatalog.commands.some(spec => spec.kind === 'write' && spec.words.every((word, i) => args[i] === word)) && !args.includes('--op-id')
    ? [...args, '--op-id', randomUUID()] : args;
/** The CLI against the fixture's server at `root`; `env` names who calls (a person when it names no one). */
async function execute(root: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  const server = servers.get(root);
  if (!server) throw new Error(`No test HTTP server for ${root}`);
  const given = input ? args.map(arg => arg === '-' ? textFile(input) : arg) : args;
  const { code: status, stdout, stderr } = await cliCommand(server.url, given, env);
  return { status, stdout, stderr };
}
/** What the CLI wrote, or its refusal thrown as the Problem it answered with. */
async function call(root: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  const result = await execute(root, withOpId(args), env, input);
  if (result.status === 0) return JSON.parse(result.stdout);
  let body: unknown = null;
  // Commander prints its own line before the JSON refusal.
  try { body = JSON.parse(result.stderr.trim().split('\n').at(-1)!); } catch { /* Not a refusal: the failure is reported whole below. */ }
  const refused = problemSchema.safeParse(body);
  if (!refused.success) throw new Error(result.stderr + result.stdout);
  const { code, message, detail, issues } = refused.data.error;
  throw new Problem(code, message, detail, { issues });
}
/** A person's command. */
const cli = (root: string, ...args: string[]) => call(root, args);
/** The user's ball on Task `id`, as the tree sends it; null when it is not the user's move. */
const userBall = async (root: string, id: string) => userTurn((await readControlTree(root)).balls[id] ?? null);
type Pass = { acceptedRequestIds: string[]; held: Array<{ taskId: string; reason: string }> };
const pass = (root: string): Promise<Pass> => cli(root, 'workspace', 'returns');
const asyncPass = (root: string, extraEnv: Record<string, string> = {}): Promise<Pass> =>
  call(root, ['workspace', 'returns'], extraEnv);
/**
 * A task request as `actor` sends it through the CLI: a person, a Run by its credential, or the coordinator (`main`),
 * with the CLI's exit status and output, for a test to read a refusal.
 */
async function requestAttempt(root: string, taskId: string, hash: string, revision: number,
  actor: { run?: string; main?: boolean } = {}, agent?: string) {
  const env = actor.run ? asRun(root, actor.run) : actor.main ? { CODEX_THREAD_ID: COORDINATOR } : {};
  return execute(root, withOpId(['task', 'request', '--task', taskId, '--instruction-file', '-',
    '--expected-task-hash', hash, '--expected-placement-revision', String(revision), ...(agent ? ['--agent', agent] : [])]),
  env, 'Please handle this');
}
// `workspace returns` can leave a detached manager running after its CLI exits.
// Finish those processes before removing the workspace they can still write to.
async function stopFixtureProcesses(root: string) {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
      .split('\n').filter(line => line.includes(root))
      .map(line => ({ pid: Number(line.match(/^\s*(\d+)\s/)?.[1]), line }))
      .filter(item => Number.isInteger(item.pid) && item.pid > 0);
    if (processes.length === 0) return;
    for (const { pid, line } of processes) {
      try { process.kill(pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(`Cannot stop fixture process: ${line}`, { cause: error });
      }
    }
    if (performance.now() >= deadline) throw new Error(`Fixture processes still running: ${root}`);
    await delay(20);
  }
}

/**
 * T and U, the user's requests, and C, T's own work below it, in the fixture's project, each with its responsible (OT,
 * OU, OC) and T and C with a worker (WT, WC). Everyone acts through the CLI as the server identifies them: a person,
 * a Run by its credential, the coordinator quoting the user. A Run starts and ends in the store, as its manager writes
 * it; no agent runs unless a pass launches one.
 */
async function fixture(t: TestContext, limit = 20, sleepy = false) {
  // These counterexamples advance business work explicitly through workspace returns. Projection remains live.
  const manualRouting = t.mock.method(RoutingOwner.prototype, 'pass', async () => {});
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-review-')));
  const previousPath = process.env.PATH;
  let openedStore: RunStore | undefined;
  let projection: ReturnType<typeof setInterval> | undefined;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try {
      clearInterval(projection);
      await preserveTestFailure(t, root, { origin: app?.url });
    } finally {
      try {
        const receipt = join(root, 'native-receipt.json');
        if (existsSync(receipt)) t.diagnostic(readFileSync(receipt, 'utf8'));
        servers.delete(root);
        await app?.close();
      } finally {
        try { await stopFixtureProcesses(root); }
        finally {
          openedStore?.close(); rmSync(root, { recursive: true, force: true });
          if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        }
      }
    }
  });
  const writer = new FileWriter(root);
  let project: string;
  try { writer.save('config.yaml', null, Buffer.from(config(limit))); project = initializeControlFixture(root); }
  finally { writer.close(); }
  if (sleepy) {
    // Keep the actual native input/receipt boundary, with the original 30s lifetime.
    const entry = join(root, 'native-fake.mjs');
    writeFileSync(entry, `import {createInterface} from 'node:readline';\n` +
      `import {writeFileSync} from 'node:fs';\n` +
      `setTimeout(()=>process.exit(124),30000);\n` +
      `const args=process.argv.slice(2),session=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];\n` +
      `const lines=createInterface({input:process.stdin});\n` +
      `const input=await new Promise(done=>lines.once('line',line=>done(JSON.parse(line))));lines.close();\n` +
      `writeFileSync(${JSON.stringify(join(root, 'native-receipt.json'))},JSON.stringify({root:${JSON.stringify(root)},pid:process.pid,ppid:process.ppid,argv:process.argv,input:input.uuid}));\n` +
      `for(const value of [{type:'system',subtype:'init',session_id:session},{type:'command_lifecycle',state:'started',command_uuid:input.uuid}])process.stdout.write(JSON.stringify(value)+'\\n');\n`);
    installAgentStub(root, 'claude', [process.execPath, entry]);
  }
  symlinkSync('/bin/ps', join(root, 'agent-bin/ps'));
  process.env.PATH = join(root, 'agent-bin');
  const commands = new ControlTaskCommands(root, { kind: 'human' }), tasks = new ControlTaskStore(root);
  // A question asks the decide section of its Task's body.
  const create = async (title: string, parentId: string, userRequested: boolean) => (await commands.create({ parentId,
    userRequested, tasks: [{ title, values: { decide: [{ decide_kind: 'choose', decide_question: 'Which way?' }] } }] })).tasks[0];
  const responsible = async (id: string) => assignResponsible(root, await tasks.get(id), 'fake');
  const member = async (id: string, responsibleRevision: number) => (await new PlacementCommands(root).placeMember({
    taskId: id, profileKey: 'fake', expectedTaskHash: (await tasks.get(id)).hash,
    expectedResponsibleRevision: responsibleRevision }, { kind: 'human' })).placement;
  const T = await create('T', project, true), U = await create('U', project, true);
  // A task with a child keeps its responsible, so T has one before C is created below it.
  const OT = await responsible(T.id), OU = await responsible(U.id);
  const C = await create('C', T.id, false);
  const OC = await responsible(C.id);
  const WT = await member(T.id, OT.revision), WC = await member(C.id, OC.revision);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  openedStore = store;
  const current = async (id: string) => {
    reconcileLinks(root, project);
    return tasks.get(id);
  };
  const hashOf = async (id: string) => (await current(id)).hash;
  /**
   * Task `taskId` is asked to work by `env`'s caller (a person when it names no one), in a new conversation when `fresh`;
   * returns the Request's receipt.
   */
  const request = async (taskId: string, revision: number, body: string, env: NodeJS.ProcessEnv, placementId?: string,
    fresh = false) =>
    (await call(root, ['task', 'request', '--task', taskId, ...(placementId ? ['--agent', placementId] : []),
      ...(fresh ? ['--new-conversation'] : []), '--instruction-file', '-', '--expected-task-hash', await hashOf(taskId),
      '--expected-placement-revision', String(revision)], env, body)).outcome.request;
  /** A person, the user's proxy, asks Task `taskId`'s responsible to work. */
  const human = (taskId: string, revision: number, body = 'Do the work') => request(taskId, revision, body, {});
  /**
   * The Run `caller` asks a placement of Task `taskId`: its child's responsible, or a worker of its own Task; in a new
   * conversation when `fresh` (without it, a placement with a conversation continues it).
   */
  const agent = (taskId: string, placementId: string, revision: number, caller: string, fresh = false) =>
    request(taskId, revision, 'Please handle this', asRun(root, caller), placementId, fresh);
  const start = (id: string) => store.write(tx => tx.update({ ...tx.get(id)!, state: 'running',
    started_at: new Date().toISOString(), pids: { manager: 1, agent: 2 } }));
  const end = (id: string, state: 'succeeded' | 'failed' | 'cancelled' = 'succeeded', reason: RunRecord['reason'] = null) =>
    store.write(tx => tx.finish({ ...tx.get(id)!, state,
      reason: reason ?? (state === 'failed' ? 'output' : state === 'cancelled' ? 'stopped' : null),
      ended_at: new Date().toISOString() },
      state === 'succeeded' ? { state: 'present', text: 'done' } : { state: 'missing', text: null }));
  /** The Task's responsible Run `runId` reports doing, done (which waits for the user's review on T and U) or stopped. */
  const report = async (runId: string, taskId: string, state: 'doing' | 'done' | 'stopped') =>
    call(root, ['task', 'report', '--task', taskId, '--state', state, '--title', `${state} report`, '--description-file', '-',
      '--expected-task-hash', await hashOf(taskId)], asRun(root, runId), 'The work is reported.');
  /** The responsible Run asks the selected parent or user the question of its body; returns the question's ID. */
  const ask = async (runId: string, taskId: string, askTo?: string) => {
    const id = randomUUID();
    await call(root, ['task', 'report', '--task', taskId, '--state', 'waiting', '--ask-to', askTo ?? ((await current((await current(taskId)).meta.parentId!)).meta.kind === 'project' ? 'user' : (await current(taskId)).meta.parentId!), '--title', 'Which way?',
      '--description-file', '-', '--expected-task-hash', await hashOf(taskId), '--op-id', id], asRun(root, runId),
    'Which way?');
    return id;
  };
  /** Whom the question asked answers it: the Run `runId` of the requesting Task, or, without one, a person for the user. */
  const answer = async (taskId: string, questionId: string, runId?: string) =>
    call(root, ['task', 'request', '--task', taskId, '--answers', questionId, '--instruction-file', '-'],
      runId === undefined ? {} : asRun(root, runId), 'This way');
  /** The responsible Run `runId` withdraws its question `questionId` on Task `taskId`. */
  const withdraw = async (runId: string, taskId: string, questionId: string) =>
    call(root, ['task', 'report', '--task', taskId, '--withdraw', questionId, '--expected-task-hash', await hashOf(taskId)],
      asRun(root, runId));
  /** The responsible Run `runId` has Task `taskId`'s requester read a note now: a comment, or its done report. */
  const urgent = async (runId: string, taskId: string, by: 'comment' | 'done' = 'comment') =>
    call(root, by === 'comment'
      ? ['task', 'comment', '--task', taskId, '--title', 'Read this now', '--urgent', 'It changes the plan',
        '--expected-task-hash', await hashOf(taskId)]
      : ['task', 'report', '--task', taskId, '--state', 'done', '--title', 'done report', '--description-file', '-', '--urgent', 'It changes the plan',
        '--expected-task-hash', await hashOf(taskId)], asRun(root, runId), by === 'done' ? 'The result changes the plan.' : '');
  /** T's or U's responsible Run `runId` reports done and ends: the Task awaits the user's review of that Run. */
  const reachReview = async (runId: string, taskId: string) => {
    await report(runId, taskId, 'done');
    end(runId);
    assert.ok(awaitsReview((await current(taskId)).meta), `${taskId} awaits the user's review`);
  };
  /**
   * The user tells the coordinator to accept Run `aboutRun`'s work: the words open the coordinator's turn, and the
   * coordinator confirms Task `taskId`'s review quoting them, at the revision of the Task's responsible.
   */
  const confirm = async (taskId: string, aboutRun: string, words = 'Please mark this complete') => {

    const revision = store.readPlacements(reader => reader.responsiblePlacement(taskId))!.revision;
    return call(root, ['task', 'report', '--task', taskId, '--state', 'done', '--about-run', aboutRun,
      '--expected-task-hash', await hashOf(taskId), '--expected-placement-revision', String(revision), '--quote', words],
    { CODEX_THREAD_ID: COORDINATOR });
  };
  /** A person, the user's proxy, holds Task `id`, returns it from the hold, or stops it. */
  const personReport = async (id: string, state: 'held' | 'doing' | 'waiting' | 'stopped', title: string) =>
    call(root, ['task', 'report', '--task', id, '--state', state, '--title', title, '--expected-task-hash', await hashOf(id)]);
  const runOf = (requestId: string) => store.readRequests().find(item => item.id === requestId)!.runId!;
  const interval = globalThis.setInterval;
  globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...args: unknown[]) =>
    interval(callback, ms === POLL_INTERVAL_MS ? 3600000 : ms, ...args)) as typeof setInterval;
  try { app = await startServer(root, 0); } finally { globalThis.setInterval = interval; }
  servers.set(root, app);
  projection=setInterval(()=>new RunEventImporter(store).pass(),100);
  const restart = async () => { await app!.close(); app=await startServer(root,0); servers.set(root,app); return app; };
  return { root, app, restart, enableAutomaticRouting: () => manualRouting.mock.restore(), project, T, U, C, OT, OU, OC, WT, WC, commands, store, current, human, agent, start, end,
    report, ask, answer, withdraw, urgent, reachReview, confirm, personReport, runOf };
}


export { config, cli, pass, requestAttempt, asyncPass, fixture, userBall };
