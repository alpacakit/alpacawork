import { decideValues, seedValues } from './helpers/task-values.ts';
import { fixtureAgentSetting, inertFixtureLaunch, installAgentStub } from './helpers/agent-stub.ts';
import { stringify } from 'yaml';
import { managerScript } from '@alpacawork/backend/test-dist/runs/scheduler.js';
import { grantFixtureRequest } from './helpers/control-fixture.ts';
import { preserveTestFailure } from './helpers/failure-workspace.ts';
/**
 * Who calls a write, as the server tells them apart (resolveCaller): a person, a Run by its credential, an outside
 * Claude Code or Codex conversation with no hook registration, and the screen's coordinator Run. Everyone acts
 * through the CLI and HTTP. A Run is written to the store as its manager records it and holds its manager's lock, so
 * serve counts it alive; no agent is launched.
 */
import { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { bootIdentity, Problem, tryLock } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { commandCatalog } from '@alpacawork/contract/commands';
import { problemSchema } from '@alpacawork/contract/problem';
import { RUN_FILES, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { startServer } from '@alpacawork/backend/test-dist/receiver/server.js';
import { issueRunCredential } from '@alpacawork/backend/test-dist/control/credentials.js';
import { CoordinatorConversation } from '@alpacawork/backend/test-dist/coordinator/conversation.js';
import { launchSnapshot, readAgentsSettings } from '@alpacawork/backend/test-dist/agents-settings.js';
import { coordinatorCwd, reserveAttempt } from '@alpacawork/backend/test-dist/runs/execution-control.js';
import { EventJournal, executionFolder, identityOf } from '@alpacawork/backend/test-dist/runs/execution-files.js';
import { openRunFile } from '@alpacawork/backend/test-dist/runs/files.js';
import { ControlTaskCommands } from '@alpacawork/backend/test-dist/control/task-commands.js';
import { ControlTaskStore } from '@alpacawork/backend/test-dist/control/task-store.js';
import { TaskRequestService } from '@alpacawork/backend/test-dist/control/task-request.js';
import { TaskReportService } from '@alpacawork/backend/test-dist/control/report.js';
import { assignResponsible, initializeControlFixture } from './helpers/control-fixture.ts';
import { cliRun } from './helpers/http-cli.ts';
import { reconcileLinks } from './return-handling.fixture.ts';

/** Agents whose launch fails at once: a Request the server launches runs nothing. */
export const NO_AGENT_CONFIG = stringify({ agents: {
  claude: fixtureAgentSetting('claude'), codex: fixtureAgentSetting('codex'),
} });
/** A process ID no system gives out: a Run's recorded manager and agent, which nothing may signal. */
const NO_PROCESS = 4_194_305;
const person = { kind: 'human' } as const;
const now = () => new Date().toISOString();

/** An outside Claude Code conversation, as its CLI names it (Codex: CODEX_THREAD_ID). */
export const claudeConversation = (conversation: string) => ({ CLAUDE_CODE_SESSION_ID: conversation });
export const codexConversation = (conversation: string) => ({ CODEX_THREAD_ID: conversation });

/** A write carries its own operation ID unless one is named; the contract's command table says which commands write. */
const withOpId = (args: string[]) =>
  commandCatalog.commands.some(spec => spec.kind === 'write' && spec.words.every((word, i) => args[i] === word)) && !args.includes('--op-id')
    ? [...args, '--op-id', randomUUID()] : args;
/** The CLI against `url` as `env` names the caller (a person when it names no one), with its exit status and output. */
type CliObservation = { at: string; args: string[]; input: string; end?: string;
  result?: Awaited<ReturnType<typeof cliRun>>; error?: string };
// Diagnostic observations belong to the fixture lifetime, never to the product's request or payload Owners.
const cliObservations = new Map<string, CliObservation[]>();
export async function run(url: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  const prepared = withOpId(args), observation: CliObservation = { at: now(), args: prepared, input };
  cliObservations.get(new URL(url).origin)?.push(observation);
  try { return observation.result = await cliRun(url, prepared, env, input); }
  catch (error) { observation.error = String(error); throw error; }
  finally { observation.end = now(); }
}
/** What the CLI wrote, or its refusal thrown as the Problem it answered with. */
export async function call(url: string, args: string[], env: NodeJS.ProcessEnv = {}, input = '') {
  const result = await run(url, args, env, input);
  if (result.code === 0) return JSON.parse(result.stdout);
  let body: unknown = null;
  try { body = JSON.parse(result.stderr); } catch { /* Not a refusal: the failure is reported whole below. */ }
  const refused = problemSchema.safeParse(body);
  if (!refused.success) throw new Error(result.stderr + result.stdout);
  const { code, message, detail, issues } = refused.data.error;
  throw new Problem(code, message, detail, { issues });
}
/** An HTTP request to the server with the headers a caller sends, answered as a status and its JSON. */
export async function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(new URL(path, url), { method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'X-Alpacawork-Op-Id': randomUUID(), ...headers } });
  return { status: response.status, body: await response.json() };
}
/** The headers an outside conversation's own request carries (its hook's, or a CLI's in that conversation). */
export const conversationHeaders = (conversation: string, provider: 'claude' | 'codex' = 'claude') =>
  ({ 'X-Alpacawork-Provider': provider, 'X-Alpacawork-Conversation': conversation });
/** Polls `check` until it gives a value, as a test waits for serve's periodic pass. */
export async function until<T>(check: () => T | Promise<T>, message: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Deadline: ${message}`);
    await delay(50);
  }
}

/**
 * The user's question on a Task of `project` the user asked for: its responsible's Run, which the user's request
 * started, asks the Task's decide value and ends, as its manager and task report write it. Returns the
 * Task and the question's ID. Before serve starts.
 */
export async function askUser(root: string, project: string, profile: string) {
  const tasks = new ControlTaskStore(root);
  const task = (await new ControlTaskCommands(root, person).create({ parentId: project, userRequested: true,
    tasks: [{ title: 'Question', values: { decide: [{ decide_question: 'Choose an option' }] } }] })).tasks[0];
  const owner = await assignResponsible(root, task, profile);
  const { outcome: { request } } = await new TaskRequestService(root).request({ task: task.id, body: 'Work',
    opId: randomUUID(), expectedTaskHash: (await tasks.get(task.id)).hash, expectedPlacementRevision: owner.revision },
  person, person);
  const store = new RunStore(root, { busyTimeoutMs: 1000 });
  const question = randomUUID();
  try {
    store.write(tx => tx.update({ ...tx.get(request.runId), state: 'running', started_at: now() }));
    await new TaskReportService(root).report({ task: task.id, state: 'waiting', askTo: 'user', title: 'Which one?',
      description: 'Please decide', opId: question, expectedTaskHash: (await tasks.get(task.id)).hash },
    { kind: 'placement', placementId: owner.id },
    { kind: 'run', runId: request.runId, placementId: owner.id, taskId: task.id, role: 'owner', responsible: true });
    store.write(tx => tx.finish({ ...tx.get(request.runId), state: 'succeeded', ended_at: now() },
      { state: 'present', text: 'Asked' }));
  } finally { store.close(); }
  reconcileLinks(root, project);
  return { task: task.id, question };
}

/** A Run the fixture holds: its Request, and the attempt its events are journaled in (null when it has none). */
type HeldRun = { id: string; requestId: string; attempt: ReturnType<typeof reserveAttempt> | null };

/**
 * A workspace (the root project P1 and a test project below it) whose agents never run. Its Runs hold their managers'
 * locks until serve has stopped, so serve neither finds them lost nor recovers them.
 */
export function callerWorkspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpacawork-callers-')));
  const oldPath = process.env.PATH;
  process.env.PATH = installAgentStub(root, 'claude');
  t.after(() => { process.env.PATH = oldPath; });
  writeFileSync(join(root, 'config.yaml'), NO_AGENT_CONFIG);
  const project = initializeControlFixture(root);
  const locks: number[] = [];
  const calls: CliObservation[] = [];
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try {
      await preserveTestFailure(t, root, { origin: server?.url, diagnostics: () => ({ calls }) });
    } finally {
      // Capture first; serve still stops before the locks open, so synthetic Runs cannot be found lost.
      try { await server?.close(); }
      finally {
        if (server) cliObservations.delete(new URL(server.url).origin);
        for (const lock of locks) closeSync(lock);
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
  const control = <T>(work: (db: DatabaseSync) => T, write = false): T => {
    const store = new ControlStore(root, { busyTimeoutMs: 10_000 }, !write);
    try { return write ? store.write(work) : store.read(work); } finally { store.close(); }
  };
  /**
   * Creates a Run with `create`, holds its manager's lock and, unless it is to stay queued, starts it as the scheduler
   * does: its attempt reserved (`attempt`, for events to be journaled), running, its Request confirmed.
   */
  const hold = (create: (store: RunStore) => RuntimeRunRecord, options: { running: boolean; attempt: boolean }): HeldRun => {
    const store = new RunStore(root, { busyTimeoutMs: 10_000 });
    try {
      const created = create(store);
      store.prepareFolder(created.id);
      const lock = openRunFile(store.folder(created.id), RUN_FILES.managerLock, constants.O_RDWR | constants.O_CREAT);
      locks.push(lock);
      assert.equal(tryLock(lock), true);
      if (!options.running) return { id: created.id, requestId: created.requestId, attempt: null };
      const settings = readAgentsSettings(root);
      if (!settings.ok) throw settings.error;
      const attempt = store.write(tx => {
        const current = tx.runtimeGet(created.id);
        const reserved = options.attempt ? reserveAttempt(store, tx, current, managerScript, settings.config.limits) : null;
        tx.update({ ...current, state: 'running', started_at: now() });
        tx.updateRequest(current.requestId, 'queued');
        return reserved;
      });
      return { id: created.id, requestId: created.requestId, attempt };
    } finally { store.close(); }
  };
  /**
   * Journals what a Run's manager writes as it starts the agent (`session`: the conversation its output names), for
   * the importer: serve's pass, or resolveCaller's own import.
   */
  const journal = (held: HeldRun, session?: string): void => {
    const launch = held.attempt;
    assert.ok(launch, 'a Run started with an attempt');
    const events = new EventJournal(executionFolder(root, held.id, launch.attemptId), identityOf(launch));
    events.append('claimed', { managerPid: NO_PROCESS, managerStarted: null, bootId: bootIdentity() });
    events.append('spawn_intent', { initialInputId: launch.initialInputId });
    events.append('started', { pid: NO_PROCESS, started: null, bootId: bootIdentity(), group: NO_PROCESS, scope: null });
    if (session !== undefined) events.append('session', { id: session });
  };
  return {
    root, project,
    /** Observe formal HTTP arrival in concurrency tests without changing request handling. */
    get httpServer() { return server?.server; },
    async start(): Promise<string> {
      server = await startServer(root, 0);
      cliObservations.set(new URL(server.url).origin, calls);
      return server.url;
    },
    /** A file in the workspace with `text`, for a command's --*-file option. */
    file(name: string, text: string): string {
      const path = join(root, `${randomUUID()}-${name}`);
      writeFileSync(path, text);
      return path;
    },
    /**
     * A Run of `task`'s placement, written as its manager records it: queued behind a Request the user has not
     * confirmed, so serve never launches it, or started with it confirmed (`running`). `session` is the agent's
     * conversation, null until the Run's own output names it. Its credential is `env`.
     */
    heldRun(input: { task: string; placementId: string; role?: 'owner' | 'worker'; session?: string | null;
      running?: boolean; attempt?: boolean }) {
      const session = input.session === undefined ? randomUUID() : input.session;
      const held = hold(store => store.write(tx => {
        const placement = tx.getPlacement(input.placementId);
        const requestId = randomUUID();
        tx.insertRequest({ id: requestId, taskId: input.task, placementId: input.placementId,
          placementRevision: placement.revision, taskHash: '0'.repeat(64), waitCycleId: null, headRunId: null,
          mode: 'new', body: 'Fixture work', purpose: 'instruction', author: person, submittedAt: now(),
          deliveryState: 'recorded_unconfirmed' });
        grantFixtureRequest(store, tx, requestId);
        return tx.create({ task: input.task, placementId: input.placementId, requestId, agent: 'codex',
          role: input.role ?? 'owner', resumes: null, continues: false,
          session: session === null ? null : { provider: 'codex', id: session }, caller: null, cwd: root,
          launch: inertFixtureLaunch('codex') }, 'Fixture work');
      }), { running: input.running ?? true, attempt: input.attempt ?? false });
      return { ...held, env: { ALPACAWORK_RUN: held.id, ALPACAWORK_RUN_TOKEN: issueRunCredential(root, held.id) } };
    },
    /**
     * The screen's message `words` and the coordinator Run answering it, started as the scheduler starts it (its start is imported by `startScreenRun`). Before serve starts, which would launch it.
     */
    screenRun(input: { words: string; submittedAt?: string; session: string | null; agent?: 'claude' | 'codex'; replyTo?: string; running?: boolean; tasks?: string[] }) {
      assert.equal(server, undefined, 'serve would launch a queued coordinator Run');
      const agent = input.agent ?? 'claude';
      const settings = readAgentsSettings(root);
      if (!settings.ok) throw settings.error;
      const snapshot = launchSnapshot(settings.config, agent, 'start', join(root, 'agent-bin'));
      if (!snapshot.ok) throw new Error(snapshot.code);
      const conversation = new CoordinatorConversation(root).read().id;
      const held = hold(store => store.write(tx => {
        const requestId = randomUUID();
        tx.insertConversationRequest({ id: requestId, conversationId: conversation,
          headRunId: tx.coordinatorHead(conversation)?.id ?? null, mode: 'new', body: input.words, replyTo: input.replyTo,
          submittedAt: input.submittedAt ?? now(), deliveryState: 'queued' });
        return tx.createCoordinatorRun({ conversationId: conversation, requestId, agent, resumes: null,
          session: input.session === null ? null : { provider: agent, id: input.session }, cwd: coordinatorCwd(root),
          restartArgv: null, launch: snapshot.launch, message: { context: null, attachments: [], intent: null, ...(input.tasks ? { tasks: input.tasks } : {}) } }, input.words);
      }), { running: input.running ?? true, attempt: input.running ?? true });
      return { ...held, conversation };
    },
    journal,
    /** Import the screen Run's start; its existing Request records subsequent writes. */
    async startScreenRun(url: string, held: HeldRun) {
      journal(held);
      await call(url, ['workspace', 'returns']);
      await until(() => control(db => db.prepare('SELECT 1 FROM run_attempts WHERE run_no=? AND started_json IS NOT NULL')
        .get(Number(held.id.slice(1)))), 'serve imports the Run start');
      return held.requestId;
    },
    /** A held Run ends, as its manager records it. */
    end(held: { id: string }, state: 'succeeded' | 'cancelled' = 'succeeded', text = 'Done'): void {
      const store = new RunStore(root, { busyTimeoutMs: 10_000 });
      try {
        store.write(tx => tx.finish({ ...tx.runtimeGet(held.id), state, ended_at: now(),
          reason: state === 'cancelled' ? 'stopped' : null },
          state === 'succeeded' ? { state: 'present', text } : { state: 'missing', text: null }));
      } finally { store.close(); }
    },
  };
}
