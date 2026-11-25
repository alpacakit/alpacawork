import { AnalysisReader, warmAnalysisWhenIdle } from '../analysis/reads.js';
import { startTallyJob } from '../analysis/tally-job.js';
import { openTallyScope } from '../analysis/tally-scope.js';
import { mcpRequestBytes, type McpFileReadOptions } from '@alpacawork/contract/mcp';
import { installMcpRoute } from './mcp-route.js';
import { readMcpFile } from './mcp-file.js';
import { appRoot } from '../app-paths.js';
import { uiLocaleOrDefault } from '@alpacawork/core/ui-language';
import { resumeKnownUpdates } from '../release/update-controller.js';
import { TelemetryService } from '../telemetry/service.js';
import { monitorTelemetry } from '../telemetry/monitor.js';
import { installTelemetryRoutes } from '../telemetry/routes.js';
import { countCliWrites } from '../telemetry/server-writes.js';
import { placementAgent } from '../telemetry/report.js';
import { monitorUpdates } from '../release/update-discovery.js';
import { clientContract } from './client-contract.js';
import { beforeRestoreOperationSchema,unknownAfterRestoreOperationSchema } from '@alpacawork/contract/recovery';
import { priorRecoveryOperation,assertRestoredMutation } from '../release/recovery-operations.js';
import { assertServeAdmission, assertMutationIdentity, restoreId, restoreIdentity, releaseAdmission, RESTORE_HEADER, RECOVERY_PROTOCOL, workspaceJournal } from '../release/journal.js';
import { awaitRecoveryCommit } from '../release/recovery-readiness.js';
import { readGroup } from '../release/recovery-data.js';
import { TASK_ID_PATTERN } from '@alpacawork/raw/task-id';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { publishedProjectLocations } from '../control/project-settings.js';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { constants as zlib, createGzip, type Gzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import { type ContentfulStatusCode } from 'hono/utils/http-status';
import { getRequestListener } from '@hono/node-server';
import { compress } from 'hono/compress';
import { collectHttpRoutes, type HttpRegistration } from '@alpacakit/channels/http';
import { defaultSettings } from '@alpacawork/contract';
import { ControlStore, keepControlChanges, keepControlTables, holdControlWriter, restoreControlWal } from '@alpacawork/db';
import { INDEX_HEARTBEAT_MS, type ControlTreeDTO } from '@alpacawork/contract/control';
import { type RawValueMap } from '@alpacakit/channels';
import { commandLinks, commandOrigin } from './command-links.js';
import { screenTree, serverCommandTree, serverCommands, PUBLIC_HOST_PATTERN, type Context, type ServeOptions } from './entries.js';
import { claimOf, identify, jsonHeaders, requestScope, preflightEntryClaim } from './request-scope.js';
import { startReadThread, type ReadThread } from './read-thread.js';
import { errorBody, failure, faultReason, FILE_MODE, PROBLEM_CODE, Problem, RETRY } from '@alpacawork/core';
import { CONFIG_FILE } from '@alpacawork/raw';
import { entryActFor, requestLimitFor, SCREEN } from '../entries.js';
import { operationReadActions } from '@alpacawork/contract/access-boundaries';
import { RunStore } from '@alpacawork/runs';
import { controlDatabasePath } from '@alpacawork/db';
import { ExplicitMigrationRequired } from '@alpacawork/db';
import { refuseSandboxedCaller } from '../runs/entry.js';
import { RunReviewState } from '../runs/reviews.js';
import { publishWorkspaceIdentity, importLocalStops } from '../runs/local-stops.js';
import { StopDeliveryOwner, inspectExecution } from '../runs/execution-control.js';
import { RunEventImporter } from '../runs/event-importer.js';
import { WorkspaceFileThread, type WatchedRun } from './workspace-file-thread.js';
import { ProjectionOwner } from './projection-owner.js';
import { RoutingOwner } from './routing-owner.js';
import { controlTaskView } from '../control/task-dto.js';
import type { PublishedFrame, TaskBundle } from './projection-contract.js';
import type { ChangeSeq } from '@alpacawork/db';
import { ServeLifecycle } from './lifecycle.js';
import { thisRelease } from '../release/location.js';
import { managerScript, retryBusy, settle } from '../runs/scheduler.js';
import { connectionPath } from '@alpacawork/contract/connection';
import { createPerformanceReceiver } from '../edition.js';
import { createWebAssets } from './web-assets.js';
import { installVoiceRoutes, readVoiceSettings } from '../voice.js';
import { unreadEnvironmentFile } from '../environment-file.js';
import { hostPushKey, holdingKeys, PushStore, type PushSender, type HeldNotice } from './push.js';
import { HostMonitor } from '../host/monitor.js';
import { AgentLimitsMonitor } from '../agents/limits.js';
import type { HostSource } from '../host/measure.js';
import { hostPushEvent } from '../host/alert.js';
import type { RunRoot } from '../host/measure.js';
import { readUnfinishedRunRecords } from '../runs/view.js';
import { readAgentsSettings } from '../agents-settings.js';
import { readServerSettings } from '../server-settings.js';
import type { EnvironmentFile, HostNotice } from '@alpacawork/contract';
import { Presence, type PresenceStatus } from './presence.js';
import { readControlEnvironment } from '../control/tree.js';
import { taskFolder } from '../control/task-store.js';
import { installTaskFileRoutes, installAttachmentFileRoutes } from './file-routes.js';
import { installCoordinatorRoutes } from './coordinator-routes.js';
import { installRunStepsRoutes } from './run-steps-routes.js';
import { CoordinatorConversation } from '../coordinator/conversation.js';
import { ReturnRouter } from '../control/return-router.js';
import { createFirstRunState, createNoticeState, createPersonSettings, UNSAVED_SETTINGS } from './person-state.js';
import { FirstRunSkills } from '../installation/first-run-skills.js';
import { resolveCaller, type CallerClaim } from '../control/credentials.js';
import { authorize, reportTaskFacts, type Action, type Caller } from '../control/authorize.js';
import { refuse, messageForRun, sourceMessage, deliveredMessages, pendingInput } from '../coordinator/messages.js';
import { taskIdSchema, runIdSchema } from '@alpacawork/contract/fields';
import { RUN_FILES, runFolder, runNumber } from '@alpacawork/contract/run';
import { POLL_INTERVAL_MS } from '../poll-interval.js';

/** `environmentFile`: what `serve` read as it started (environment-file.ts); a receiver started without one read none. */
export type ServerOptions = ServeOptions & { pushSender?: PushSender; hostSource?: HostSource; environmentFile?: EnvironmentFile;
  agentInspection?: import('../agents/availability.js').InspectionEnvironment };

async function body(request: Request, limit: number): Promise<RawValueMap> {
  if (request.headers.get('content-type') !== 'application/json')
    throw new Problem(PROBLEM_CODE.invalidInput, 'Content-Type must be application/json', undefined, { reason: { kind: 'content_type_must_application_json' } });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.length;
    if (size > limit) throw new Problem(PROBLEM_CODE.tooLarge, `Request exceeds ${limit / 1024} KiB`, undefined, { reason: { kind: 'request_exceeds_kib', limit: String(limit / 1024) } });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString()) as RawValueMap;
  } catch {
    throw new Problem(PROBLEM_CODE.invalidInput, 'Expected JSON', undefined, { reason: { kind: 'expected_json' } });
  }
}
/** resolveCaller again inside a write, on its connection: it imports nothing there and opens no other connection. */
function identifyIn(root: string, db: DatabaseSync, claim: CallerClaim): Caller {
  const store = new RunStore(root, { busyTimeoutMs: 0 }, true, db);
  try { return resolveCaller(root, claim, store); } finally { store.close(); }
}
/** What a saved command response names: a Task write's Task, a plan's Tasks, and a stop's Runs. */
const receiptNames = z.object({ task: z.object({ id: z.string() }).optional(), tasks: z.array(z.object({ id: z.string() })).optional(),
  cancelled: z.array(z.string()).optional(), stop_requested: z.array(z.string()).optional() });
/** The Tasks a saved command response is about, read on `db`: the Tasks it names and those of the Runs it names. */
function receiptTasks(root: string, db: DatabaseSync, body: unknown): string[] {
  const names = receiptNames.safeParse(body);
  if (!names.success) return [];
  const { task, tasks = [], cancelled = [], stop_requested = [] } = names.data;
  const runs = new RunStore(root, { busyTimeoutMs: 0 }, true, db);
  try {
    return [...task ? [task.id] : [], ...tasks.map(item => item.id),
      ...[...cancelled, ...stop_requested].flatMap(run => runs.get(run)?.task ?? [])];
  } finally { runs.close(); }
}
/** Recorded words are optional; authorization never reads or verifies their content. */
function recordedQuote(caller: Caller, text: string | undefined): string | null {
  if (text === undefined) return null;
  if (caller.kind !== 'coordinator')
    throw new Problem(PROBLEM_CODE.invalidInput, 'Only the coordinator quotes the user', undefined,
      { reason: { kind: 'only_coordinator_quotes_user' }, issues: [{ path: 'quote', code: 'coordinator_only', message: '--quote is the coordinator\'s' }] });
  return text;
}
function screenRunning(db: DatabaseSync, caller: Caller): void {
  if (caller.kind === 'coordinator' && caller.source === 'screen' &&
      !db.prepare("SELECT 1 FROM runs WHERE id=? AND conversation_id=? AND state='running'").get(runNumber(caller.runId), caller.conversation))
    throw new Problem(PROBLEM_CODE.forbidden, 'Coordinator Run is not running', undefined,
      { reason: { kind: 'coordinator_run_not_running' } });
}
/** Resolve only schema-safe existing targets, before parsing the full mutation can reject other fields. */
function rawTarget(db: DatabaseSync, value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const task = Object.hasOwn(raw, 'task') ? raw.task : raw.parent;
  if (task !== undefined) return taskIdSchema.safeParse(task).success &&
    db.prepare('SELECT 1 FROM tasks WHERE external_id=?').get(String(task)) ? String(task) : undefined;
  if (runIdSchema.safeParse(raw.run).success) {
    const run = db.prepare('SELECT task_id FROM runs WHERE id=?').get(runNumber(String(raw.run)));
    if (run?.task_id !== null && run?.task_id !== undefined) return String(run.task_id);
  }
  if (typeof raw.agent === 'string' && raw.agent.length <= 128) {
    const placement = db.prepare('SELECT task_id FROM placements WHERE id=?').get(raw.agent);
    if (placement) return String(placement.task_id);
  }
  if (typeof raw.withdraw === 'string' && raw.withdraw.length <= 128) {
    const task = db.prepare('SELECT t.external_id FROM task_log l JOIN tasks t ON t.id=l.task_id WHERE l.id=?').get(raw.withdraw);
    if (task) return String(task.external_id);
  }
  return undefined;
}
function recordMessage(db: DatabaseSync, caller: Caller, sourceRequest: string | undefined): string | undefined {
  if (caller.kind === 'coordinator' && caller.source === 'screen') return sourceMessage(db, caller.runId, sourceRequest);
  if (sourceRequest !== undefined)
    throw new Problem(PROBLEM_CODE.invalidInput, 'Only screen coordinator writes name a source Request', undefined,
      { reason: { kind: 'only_screen_source_request' } });
  return undefined;
}
/** The Fetch view of a Node request's headers. */
function toHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers))
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) result.append(name, item);
  return result;
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, jsonHeaders);
  res.end(JSON.stringify(value));
}
function connectionFile(root: string, url: string, publicUrl: string | null, generation: string) {
  const filename = connectionPath(root), directoryPath = dirname(filename),
    temporary = filename + '.' + randomUUID() + '.tmp';
  try {
    const fd = openSync(temporary, 'wx', FILE_MODE);
    try {
      writeFileSync(fd, JSON.stringify({ url, publicUrl, generation, runManager: managerScript }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, filename);
    const directory = openSync(directoryPath, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return filename;
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** An SSE response, gzip-compressed when the client accepts it; every write is flushed as one event. */
type Subscriber = { open(): void; write(text: string): void; end(): void; destroyed(): boolean; backlog(): number };
function subscribe(res: ServerResponse, gzip: boolean): Subscriber {
  let zip: Gzip | undefined;
  return {
    open() {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        // A finished subscription closes its connection instead of returning it to an idle pool.
        Connection: 'close',
        'X-Accel-Buffering': 'no',
        ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
      });
      if (gzip) {
        zip = createGzip({ flush: zlib.Z_SYNC_FLUSH });
        zip.pipe(res);
      }
      // A resumed cursor may have no delta. Open the connection now so clients
      // can recover pending work without waiting for the next heartbeat.
      res.flushHeaders();
    },
    write(text) { (zip ?? res).write(text); },
    end() { (zip ?? res).end(); },
    destroyed: () => res.destroyed,
    backlog: () => res.writableLength + (zip?.writableLength ?? 0),
  };
}
export async function startServer(root: string, port: number, options: ServerOptions = {}) {
  refuseSandboxedCaller();
  const publicHost = options.publicHost;
  if (publicHost !== undefined && !PUBLIC_HOST_PATTERN.test(publicHost))
    throw new Problem(PROBLEM_CODE.invalidInput, 'public-host must be host[:port] in lower case', undefined,
      { reason: { kind: 'public_host_must_host_port_lower_case' } });
  // `serve --timing`: one JSON line on stderr per reconciliation pass and per tree publication.
  const timing = options.timing
    ? (fields: Record<string, unknown>) => console.error(JSON.stringify({ timing: new Date().toISOString(), ...fields }))
    : undefined;
  await resumeKnownUpdates(root).catch(error=>console.error('Update resume needs attention',error));
  assertServeAdmission(root,thisRelease());
  if(thisRelease())await awaitRecoveryCommit(root,thisRelease()!,port);
  const releaseWriter = holdControlWriter(root);
  const changes = keepControlChanges(root);
  const releaseRecords = keepControlTables(root);
  const startupCleanup: (() => void | Promise<void>)[] = [];
  try {
  const bootstrap = new ControlStore(root); bootstrap.close();
  const walRestored = restoreControlWal(root);
  const initial = readControlEnvironment(root);
  if (initial.errors.some(error => error.path !== '.alpacawork/alpacawork.sqlite'))
    throw new Problem(PROBLEM_CODE.invalidRoot, 'Workspace requires repair or explicit migration before serve', { errors: initial.errors },
      { reason: { kind: 'workspace_requires_repair_or_explicit_migration_before_serve' } });
  if (initial.errors.some(error => error.path === '.alpacawork/alpacawork.sqlite')) {
    let existingRuns: RunStore | null = null;
    try { existingRuns = RunStore.openReadable(root, { busyTimeoutMs: 0 }); }
    catch (error) {
      if (error instanceof ExplicitMigrationRequired)
        throw new Problem(PROBLEM_CODE.invalidRoot, 'Run database requires explicit migration before serve', { errors: initial.errors },
          { reason: { kind: 'run_database_requires_explicit_migration_before_serve' }, cause: error });
    } finally { existingRuns?.close(); }
  }
  root = initial.root;
  const coordinator = new CoordinatorConversation(root, () => republish('coordinator'));
  // Reading predates recovery: an unfinished Run that ends during startup is new, unread information.
  await coordinator.seedSeen();
  const serveAsset = createWebAssets(root);
  // Startup recovery reads bodies only for leftover terminal exchange files.
  // A committed reply is safe to clean; a mismatch must remain available for review.
  const runReviews = new RunReviewState();
  let startupRunsReadable = true;
  if (!initial.errors.length) {
    const existing = RunStore.openReadable(root, { busyTimeoutMs: 0 });
    try { for (const run of existing?.read() ?? []) runReviews.cleanup(existing!, run); }
    catch (error) { startupRunsReadable = false; console.error('Startup Run review could not be read', error); }
    finally { existing?.close(); }
  }
  // Push needs a contact for VAPID (RFC 8292); Apple rejects localhost, so the tailnet name is used when there is one.
  const push = await PushStore.open(root, { subject: `https://${publicHost ?? 'localhost'}`, sender: options.pushSender });
  startupCleanup.push(() => push.close());
  const telemetry = new TelemetryService(root);
  const presence = new Presence(() => performance.now(), () => telemetry.mark({ kind: 'activity' }));
  let runs: RunStore | undefined,
    settling: Promise<void> | undefined, settleError: string | undefined;
  let orderedTail: Promise<void> = Promise.resolve(), queuedWrites = 0, queuedReads = 0;
  // Request bodies are read before entering this lane. A stalled upload cannot
  // keep the periodic reconciliation behind later writes indefinitely.
  function ordered<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = orderedTail;
    let release!: () => void;
    orderedTail = new Promise<void>(resolve => { release = resolve; });
    const queued = performance.now();
    return previous.then(async () => {
      const started = performance.now();
      try { return await work(); } finally { timing?.({ step: 'write', queueMs: started - queued, bodyMs: performance.now() - started }); }
    }).finally(release);
  }
  async function orderedWrite<T>(work: () => Promise<T> | T): Promise<T> {
    queuedWrites++;
    try { return await lifecycle.run(() => ordered(work)); }
    finally { queuedWrites--; }
  }
  const settleAbort = new AbortController();
  const loopDelay = timing ? monitorEventLoopDelay({ resolution: 10 }) : undefined;
  function recordLoopDelay() {
    if (!loopDelay) return;
    timing?.({ step: 'event_loop', maxMainThreadMs: loopDelay.max / 1e6, maxStallMs: loopDelay.max / 1e6 });
    loopDelay.reset();
  }
  const runStore = () => runs ??= new RunStore(root, { busyTimeoutMs: 0 });
  /** The agent can act before its manager's next receipt poll. Import the named input before deciding its record link. */
  async function refreshInputEvidence(runId: string, target: { sourceRequest?: string; replyTo?: string }): Promise<void> {
    const store = runStore(), importer = new RunEventImporter(store), deadline = performance.now() + 2000;
    for (;;) {
      importer.pass([runId]);
      if (!pendingInput(store.connection, runId, target)) return;
      if (performance.now() >= deadline)
        throw new Problem(PROBLEM_CODE.handoffPending, 'The input receipt is not confirmed yet; retry this operation', undefined,
          { reason: { kind: 'coordinator_request_not_delivered' } });
      await delay(20);
    }
  }
  const tallySince = openTallyScope(root);
  const analysis = new AnalysisReader(root, tallySince, changes.log);
  startupCleanup.push(() => analysis.close());
  let stopAnalysisTally: (() => Promise<void>) | undefined, stopAnalysisWarm: (() => void) | undefined;
  const context: Context = { root, push, presence, analysis, agentInspection: options.agentInspection };
  const generation = randomUUID();
  startupCleanup.push(() => runs?.close());
  const stopDelivery = new StopDeliveryOwner(runStore());
  const readAbort = new AbortController();
  const lifecycle = new ServeLifecycle(root, generation, async () => { await orderedTail; await projection?.drain(); }, () => stopDelivery.gate(), async () => {
    readAbort.abort(new Problem(PROBLEM_CODE.unavailable, 'Serve is quiescing', undefined, { reason: { kind: 'serve_quiescing' } }));
    projection?.pause();
  });
  /** One read of the control database, on its own connection. */
  function readControl<T>(work: (db: DatabaseSync) => T): T {
    const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
    try { return control.read(work); } finally { control.close(); }
  }
  /**
   * authorize on a read of the control database, for an act that writes nothing there: the screen's index and reads
   * (it holds every project, so it is a person's), a file read, the coordinator API, quiesce.
   */
  const authorizeRead = (caller: Caller, action: Action, task: string | null = null) =>
    readControl(db => authorize(db, caller, action, { task, quote: null }));
  const personSettings = createPersonSettings(root);
  const noticeState = createNoticeState(root);
  let latestSettings = defaultSettings();
  let settingsReadable = false;
  let pushNoticesError = false;
  let publishedPresence: PresenceStatus = { state: 'away', until: null };
  context.presenceSettings = () => latestSettings;
  let pushSettingsError = false;
  const personRevisions: import('@alpacawork/contract/control').ControlIndexDTO['person'] = { settings: personSettings.revision(), notices: noticeState.revision(), coordinator: null };
  context.personSettings = personSettings;
  context.noticeState = noticeState;
  const firstRun = createFirstRunState(root);
  context.firstRun = firstRun;
  const firstRunSkills = new FirstRunSkills({ locale: () => uiLocaleOrDefault(personSettings.values().language) });
  context.skills = firstRunSkills;
  /** The screens subscribed to the index. */
  const streams = new Set<Subscriber>();
  const arrival = new AsyncLocalStorage<{ floor: ChangeSeq }>();
  const fileObserved = new Map<string, ChangeSeq>();
  const fileLists = new Map<string, TaskBundle['files']>();
  const fileFaults = new Map<string, ControlTreeDTO['errors'][number]>();
  const watchedRuns = new Map<string, Map<string, { id: import('@alpacawork/contract').RunId; task: string; state: string }>>();
  let projection: ProjectionOwner;
  let routing: RoutingOwner;
  let executionPrompt = true, coordinatorDirty = true;
  let lastDemand = changes.log.latest;
  const watcher = WorkspaceFileThread.start(root, observation => {
    const previousFaults = fileFaults.size;
    if (observation.healthy) fileFaults.delete('');
    for (const result of observation.fileLists) { fileLists.set(result.task, result.files); fileFaults.delete(result.task); }
    for (const fault of observation.faults) fileFaults.set(fault.task ?? '', { code: PROBLEM_CODE.readFailed,
      path: fault.path ?? (fault.task ? taskFolder(fault.task) : 'tasks'), message: fault.message, reason: faultReason(new Error(fault.message)) });
    const observed = changes.log.append([...observation.keys, ...(observation.faults.length || fileFaults.size !== previousFaults ? [{ kind: 'person' as const, id: 'file-health' }] : [])]);
    for (const result of observation.fileLists) fileObserved.set(result.task, observed);
    if (observation.paths.some(path => path.includes('/protocol/') || path.includes('/local-stops/'))) executionPrompt = true;
  });
  const releaseExecutionDemand = changes.log.subscribe(() => {
    const range = changes.log.read('projection');
    if (range.kind === 'overflow') { executionPrompt = true; coordinatorDirty = true; }
    else for (const batch of range.batches) if (batch.seq > lastDemand) {
      for (const key of batch.keys) {
        if (['request', 'run', 'attempt', 'start_grant', 'stop_epoch'].includes(key.kind)) executionPrompt = true;
        if (['conversation', 'dialogue', 'refusal', 'config'].includes(key.kind) || key.kind === 'person' && key.id === 'coordinator') coordinatorDirty = true;
        if (!coordinatorDirty && ['run', 'activity', 'request'].includes(key.kind)) {
          coordinatorDirty = readControl(db => {
            const row = key.kind === 'request' ? db.prepare('SELECT task_id FROM requests WHERE id=?').get(key.id)
              : db.prepare('SELECT task_id FROM runs WHERE id=?').get(Number(key.id.replace(/^R/, '')));
            return !!row && row.task_id === null;
          });
        }
      }
    }
    lastDemand = range.through;
  });
  startupCleanup.push(() => watcher.close(), () => releaseExecutionDemand());
  async function openedTask(reference: string | undefined) {
    const task = reference?.split(/[\\/]/).at(-1);
    if (!task || !new RegExp(`^${TASK_ID_PATTERN}$`).test(task)) return;
    await watcher.openedTask(task);
    const scope = arrival.getStore(), observed = fileObserved.get(task);
    if (scope && observed !== undefined && observed > scope.floor) scope.floor = observed;
  }
  function readPersonalSettings() {
    try {
      latestSettings = personSettings.values();
      settingsReadable = true;
      pushSettingsError = false;
    } catch (error) {
      settingsReadable = false;
      if (!pushSettingsError) console.error('Task Push settings could not be read', error);
      pushSettingsError = true;
    }
  }
  let observingPush: Promise<void> | undefined;
  const pushPending = new Map<string, number>();
  let pushObservationError = false;
  let coordinatorWork: ReturnType<typeof coordinator.work> = null;
  async function personalProjection() {
    readPersonalSettings();
    personRevisions.settings = settingsReadable ? personSettings.revision() ?? UNSAVED_SETTINGS : null; personRevisions.notices = noticeState.revision();
    if (coordinatorDirty) try {
      const snapshot = coordinator.snapshot(generation);
      personRevisions.coordinator = { id: snapshot.conversation.id, revision: snapshot.revision };
      coordinatorWork = coordinator.work(); coordinatorDirty = false;
    } catch (error) { console.error('Coordinator projection could not be read', error); }
    publishedPresence = presence.status(latestSettings);
    return { person: { ...personRevisions }, presence: publishedPresence, host: hostNotice, coordinatorWork,
      errors: [...fileFaults.values(), ...runReviews.issues, ...(settleError ? [{ code: PROBLEM_CODE.readFailed,
        path: '.alpacawork/runs', message: settleError, reason: faultReason(new Error(settleError)) }] : [])] };
  }
  function queuePushObservation() {
    if (observingPush || lifecycle.state !== 'accepting' || !settingsReadable || !pushPending.size) return;
    observingPush = lifecycle.run(async () => {
      const frame = projection.current;
      if (!frame || frame.records.environment().errors.length) return;
      const pending = [...pushPending], ids = pending.map(([id]) => id), changed = new Map<string, Map<string, HeldNotice>>();
      for (const id of ids) {
        const bundle = frame.records.bundle(id), value = frame.derived(id);
        const listed = bundle && frame.records.shelf().listed.has(frame.records.projectOf(id));
        changed.set(id, listed && value ? holdingKeys([controlTaskView(bundle.task)], value.ball ? { [id]: value.ball } : {},
          parent => frame.records.bundle(parent)?.task.meta) : new Map());
      }
      await push.observeChanged(changed, latestSettings, Date.now());
      for (const [id, version] of pending) if (pushPending.get(id) === version) pushPending.delete(id);
      pushObservationError = false;
    }).catch(error => {
      if (!pushObservationError) console.error('Task Push observation failed', error);
      pushObservationError = true;
    }).finally(() => { observingPush = undefined; });
  }
  function republish(id = 'metadata') { changes.log.append([{ kind: 'person', id }]); }
  projection = new ProjectionOwner({ root, generation, log: changes.log, observations: { files: task => fileLists.get(task) ?? [] },
    run: work => lifecycle.run(work), accepting: () => lifecycle.state === 'accepting', personal: personalProjection, locations: () => publishedProjectLocations(root), timing,
    fault: error => console.error('Projection catch-up failed', error),
    published: (frame, previous, work, full, fileRuns) => {
      if (full || work.through > work.after || work.tasks.size) routing.enqueue(work, full);
      const ids = full ? new Set([...frame.records.taskIds(), ...previous?.records.taskIds() ?? []])
        : new Set([...(frame.patch?.tasks.upsert.map(row => row.id) ?? []), ...(frame.patch?.tasks.remove ?? []), ...work.tasks]);
      for (const id of ids) {
        pushPending.set(id, frame.pv);
        if (previous && previous.records.bundle(id)?.task.meta !== frame.records.bundle(id)?.task.meta)
          for (const child of new Set([...previous.records.children(id), ...frame.records.children(id)])) pushPending.set(child, frame.pv);
      }
      const runUpserts: WatchedRun[] = [...fileRuns.upsert], runRemovals: import('@alpacawork/contract').RunId[] = [...fileRuns.remove];
      for (const id of ids) {
        const old = watchedRuns.get(id) ?? new Map(), next = new Map();
        for (const run of frame.records.bundle(id)?.runs ?? []) if (run.state === 'running' || run.state === 'failed') {
          const fact = { id: run.id, task: id, state: run.state };
          next.set(run.id, fact);
          if (old.get(run.id)?.state !== run.state) runUpserts.push(fact);
        }
        for (const run of old.keys()) if (!next.has(run)) runRemovals.push(run as import('@alpacawork/contract').RunId);
        if (next.size) watchedRuns.set(id, next); else watchedRuns.delete(id);
      }
      if (runUpserts.length || runRemovals.length) watcher.updateRuns({ upsert: runUpserts, remove: runRemovals });
      const event = full ? 'index' : 'patch', body = full ? projection.index() : frame.patch && JSON.stringify(frame.patch);
      if (body) for (const subscriber of streams) publish(subscriber, frame, projection.rev, event, body);
      queuePushObservation();
    } });
  startupCleanup.push(() => projection.close());
  const router = new ReturnRouter(root, miss => timing?.({ ...miss }));
  routing = new RoutingOwner(changes.log, router, () => projection.current, work => ordered(work),
    overdue => lifecycle.state !== 'accepting' || !overdue && (queuedWrites > 0 || queuedReads > 0), timing, async overdue => {
      if (starting || lifecycle.state !== 'accepting' || !projection.current) return false;
      const floor = changes.log.latest;
      if (overdue || projection.current.applied >= floor) return true;
      // Do not hold the routing deadline while the projection catches up.
      void projection.read(floor).catch(error => console.error('Projection read failed', error));
      return false;
    });
  startupCleanup.push(() => routing.close());
  context.readFrame = () => projection.read(arrival.getStore()?.floor ?? changes.log.latest, readAbort.signal);
  /** The one test of whether the screen still shows the person's presence; reports, manual away and the poll ask it. */
  function publishPresence(current: PresenceStatus) {
    if (current.state !== publishedPresence.state || current.until !== publishedPresence.until) republish();
  }
  context.presenceChanged = () => publishPresence(presence.status(latestSettings));
  let hostNotice: HostNotice | null = null;
  /**
   * Running Runs and their agent processes, read from their own connection so a sample never joins a settle transaction.
   * A coordinator Run has no Task and so no title: whoever shows it names it in the reader's language.
   */
  const runningRoots = (): RunRoot[] => {
    const records = projection.current?.records;
    return readUnfinishedRunRecords(root).flatMap(run => run.state === 'running' && run.pids.agent !== null ? [{
      runId: run.id, taskId: run.task, title: run.task === null ? '' : records?.bundle(run.task)?.task.meta.title ?? '', role: run.role,
      model: run.launch.values.model?.trim() || null, pid: run.pids.agent }] : []);
  };
  const host = new HostMonitor({ root, runs: runningRoots, source: options.hostSource,
    parallel: () => { const settings = readAgentsSettings(root); return settings.ok ? settings.config.limits.parallel : null; },
    noticeChanged: notice => { hostNotice = notice; republish(); },
    episodeStarted: (episode, sample) => {
      if (settingsReadable && latestSettings['push.host'] === true)
        void push.record(hostPushEvent(episode, sample, uiLocaleOrDefault(latestSettings.language))).catch(error => console.error('Host Push event could not be saved', error));
    },
    episodeHeld: start => push.holdHost(start === null ? null : hostPushKey(start)),
    log: line => console.error(line) });
  context.host = host;
  context.limits = new AgentLimitsMonitor({ environment: options.agentInspection,
    config: async () => { const settings = readAgentsSettings(root); return settings.ok ? settings.config : null; } });
  /** One SSE event. A subscriber that has stopped reading is dropped rather than buffered without bound. */
  function publish(subscriber: Subscriber, feed: Pick<PublishedFrame, 'generation'>, rev: number, event: 'index' | 'patch', data: string) {
    try {
      if (subscriber.destroyed() || subscriber.backlog() > 4 * 1024 * 1024) {
        streams.delete(subscriber);
        subscriber.end();
        return;
      }
      subscriber.write(`id: ${feed.generation}:${rev}\nevent: ${event}\ndata: ${data}\n\n`);
    } catch {
      // A disconnected viewer owns no publication progress and cannot reject a healthy screen read.
      streams.delete(subscriber);
      try { subscriber.end(); } catch { /* The socket is already closed. */ }
    }
  }
  context.changed = () => { changes.log.append([{ kind: 'config', id: CONFIG_FILE }]); };
  context.personChanged = (kind, revision) => {
    if (personRevisions[kind] === revision) return;
    personRevisions[kind] = revision;
    if (kind === 'settings') readPersonalSettings();
    changes.log.append([{ kind: 'person', id: kind }]);
  };

  // Hono owns API routing and JSON replies. Host/Origin checks, static assets and SSE stay
  // on the raw Node response below.
  const api = new Hono();
  const mcpRequests = new WeakSet<Request>();
  const mcpReads = new WeakMap<Request, McpFileReadOptions>();
  installMcpRoute(api, { root, enabled: options.mcp === true, publicHost, version: options.mcp ? z.object({ version: z.string() }).parse(
      JSON.parse(readFileSync(join(appRoot(import.meta.url), 'package.json'), 'utf8'))).version : '',
    readJson: request => body(request, mcpRequestBytes),
    forward: (request, fileRead) => {
      mcpRequests.add(request);
      if (fileRead) mcpReads.set(request, fileRead);
      return api.fetch(request);
    },
    authorizeUpload: (claim, task) => { authorizeRead(identify(root, claim), { name: 'file.write' }, task); },
  });
  // JSON answers are compressed when the browser accepts it; the index is mostly repeated keys.
  api.use('/api/*', compress({ encoding: 'gzip' }));
  const commandRoutes = collectHttpRoutes(serverCommandTree.tree);
  const screenRoutes = collectHttpRoutes(screenTree);
  const routeActs = new Map<string, Action | null | undefined>();
  screenRoutes.forEach(route => routeActs.set(`${route.method} /api${route.path}`, entryActFor(route.handler)));
  /** Each request's claim and working directory, read before any route; its caller, once resolved (`callerOf`). */
  const scopes = new WeakMap<Request, ReturnType<typeof requestScope> & { caller?: Caller }>();
  const scopeOf = (request: Request) => scopes.get(request)!;
  /** Who calls (resolveCaller): resolved when first asked, and kept for the rest of the request. */
  const callerOf = (request: Request): Caller => {
    const scope = scopeOf(request);
    return scope.caller ??= identify(root, scope.claim);
  };
  /** Whether an operation ID already saved a command's or a file's write. */
  const operationRecorded = (id: string) =>
    readControl(db => !!db.prepare('SELECT 1 FROM cli_operations WHERE op_id=? UNION ALL SELECT 1 FROM file_operations WHERE op_id=?').get(id, id));
  api.use('/api/*', clientContract());
  api.use('/api/*', async (c, next) => {
    const url = new URL(c.req.url);
    const cli = c.req.header('x-alpacawork-client') === 'cli';
    const command = serverCommands.get(`${c.req.method} ${url.pathname}`);
    scopes.set(c.req.raw, requestScope(c.req.raw.headers, cli, cli && command?.implementation.replayFromRun === true, mcpRequests.has(c.req.raw)));
    const mutation = !['GET','HEAD','OPTIONS'].includes(c.req.method) && url.pathname !== '/api/runtime/quiesce';
    if (mutation) {
      lifecycle.admit();
      // Resolve credentials without session-import side effects before the common restore gate.
      readControl(db=>identifyIn(root,db,scopeOf(c.req.raw).claim));
      const sentRestoreId = c.req.header(RESTORE_HEADER) ?? null;
      const operationId = c.req.header('X-Alpacawork-Op-Id') ?? null;
      if (command?.kind === 'run') {
        if (sentRestoreId === null) {
          const message = 'Restore ID is required to execute a command';
          throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
            { reason: { kind: 'validation_error' }, issues: [{ path: RESTORE_HEADER, code: 'required', message }] });
        }
        if (operationId !== null) {
          const message = 'An execution does not take an operation ID';
          throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
            { reason: { kind: 'validation_error' }, issues: [{ path: 'X-Alpacawork-Op-Id', code: 'invalid_value', message }] });
        }
      }
      assertRestoredMutation(root, sentRestoreId, operationId, operationRecorded);
    }
    if(!['/api/update/status','/api/update/review','/api/update/confirm','/api/update/cancel','/api/runtime/readiness','/api/runtime/preflight','/api/runtime/quiesce','/api/runtime/recovery'].includes(url.pathname)&&releaseAdmission(root)==='maintenance')
      throw new Problem(PROBLEM_CODE.unavailable,'Release maintenance is incomplete',undefined,{reason:{kind:'release_maintenance_incomplete'}});
    // A command's caller is resolved before it runs: a refused claim reads and writes nothing, and a coordinator Run's
    // session is imported before its write begins (resolveCaller). The screen's routes ask when they need.
    if (cli) {
      preflightEntryClaim(root, routeActs.get(`${c.req.method} ${c.req.path}`), scopeOf(c.req.raw).claim);
      callerOf(c.req.raw);
    }
    return next();
  });
  // Each CLI write counts once it is saved, by its caller's way; the screen's writes count on the screen.
  api.use('/api/*', countCliWrites(telemetry, { caller: callerOf, task: id => readControl(db => reportTaskFacts(db, id)),
    agentOf: placement => placementAgent(root, placement),
    recorded: operationRecorded }));
  installTelemetryRoutes(api, telemetry, request => { authorizeRead(callerOf(request), SCREEN); });
  installVoiceRoutes(api, root, request => { authorizeRead(callerOf(request), SCREEN); });
  // Settings shows where the file is and why a line of it set nothing. The report holds nothing read from the file.
  const environmentFile = options.environmentFile ?? unreadEnvironmentFile(process.env);
  api.get('/api/environment-file', c => {
    authorizeRead(callerOf(c.req.raw), SCREEN);
    return c.json(environmentFile, 200, { 'Cache-Control': 'no-store' });
  });
  /** Observe the committed file bytes in the worker before publishing their file-list mark. */
  function attachmentChanged(task?: string) {
    return (task === undefined ? watcher.repair() : openedTask(task))
      .catch(error => console.error('Written Task files could not be observed', error));
  }
  const fileOptions = {
    /** A file read is a read of its Task. */
    authorizeRead: (request: Request, task: string) => { authorizeRead(callerOf(request), { name: 'task.read' }, task); },
    /**
     * A write is file.write: refused here before its bytes are read, and asked again, for the caller identified again,
     * in the transaction FileJournal reserves it in (its grant), so that an upload outliving its Run writes nothing.
     */
    authorizeWrite: (request: Request, task: string) => {
      authorizeRead(callerOf(request), { name: 'file.write' }, task);
      const { claim } = scopeOf(request);
      return (db: DatabaseSync) =>
        authorize(db, identifyIn(root, db, claim), { name: 'file.write' }, { task, quote: null });
    },
    mcpRead: (request: Request, task: string, path: string) => {
      const read = mcpReads.get(request);
      return read ? readMcpFile(root, task, path, commandOrigin(request, publicHost), read) : undefined;
    },
    changed: attachmentChanged,
    links: (request: Request, value: unknown) => commandLinks(value, commandOrigin(request, publicHost)),
    mutate: <T>(work: () => T | Promise<T>) => lifecycle.run(work),
  };
  installTaskFileRoutes(api, root, fileOptions);
  installAttachmentFileRoutes(api, root, fileOptions);
  // The conversation lives in the control database: its writes take the ordered lane, so their commits reach the index
  // like any other (`readConversationRevision`) and quiesce waits for that publication.
  installCoordinatorRoutes(api, root, generation, coordinator, request => {
    authorizeRead(callerOf(request), { name: 'coordinator.screen' });
  }, orderedWrite);
  // A Run's steps are read as `run get` reads its result: a read of its Task; a coordinator's Run is the conversation's.
  installRunStepsRoutes(api, root, (request, id) => {
    const caller = callerOf(request);
    return readControl(db => {
      const store = new RunStore(root, { busyTimeoutMs: 0 }, true, db);
      try {
        const run = store.runtimeGet(id);
        if (!run) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', { run: id }, { reason: { kind: 'run_does_not_exist' } });
        authorize(db, caller, run.task ? { name: 'task.read' } : { name: 'coordinator.screen' }, { task: run.task ?? null, quote: null });
        return run;
      } finally { store.close(); }
    });
  });
  api.get('/api/runtime/recovery',c=>{
    // Identity is information, never a credential. Credential syntax/Run validity still uses the existing caller Owner.
    callerOf(c.req.raw);
    return c.json({protocol:RECOVERY_PROTOCOL,restoreId:restoreId(root)},200,jsonHeaders);
  });
  const readOperation = (opId: string, caller: Caller) => {
    const control = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
    try {
      // The operation ID alone names an operation, a command's or a file's; what it saved is read as a read of the
      // Tasks it names (a Run reads only its own project's), and one naming no Task is the person's.
      const found = control.read(db => {
        const read = (tasks: readonly string[]) => {
          for (const { action, task } of operationReadActions(tasks)) authorize(db, caller, action, { task, quote: null });
        };
        const row = db.prepare('SELECT status,response_json FROM cli_operations WHERE op_id=?').get(opId);
        const file = db.prepare(`SELECT o.state,o.result_json,t.external_id AS task FROM file_operations o
          LEFT JOIN tasks t ON t.id = o.task_uuid WHERE o.op_id=?`).get(opId);
        const fileTasks = file?.task === null || file?.task === undefined ? [] : [String(file.task)];
        if (row) {
          const body: unknown = JSON.parse(String(row.response_json));
          read([...fileTasks, ...receiptTasks(root, db, body)]);
          if (stopDelivery.hasPendingOperation(opId, db)) return {
            state: 'committed_pending_delivery',
            message: 'Retry the original write with the same input, operation ID and restore ID.',
          };
          return { state: 'committed', status: Number(row.status), body };
        }
        if (!file) {
          const restored=restoreIdentity(root);
          if(!restored)return {state:'not_found'};
          const prior=priorRecoveryOperation(root,opId);
          if(prior) {
            read(prior.tasks);
            return beforeRestoreOperationSchema.parse({state:'before_restore',restoreId:restored.id,previous:prior,notFoundProvesUnexecuted:false});
          }
          // An absence following rollback never proves that the operation was not executed.
          read([]);
          return unknownAfterRestoreOperationSchema.parse({state:'unknown_after_restore',restoreId:restored.id,notFoundProvesUnexecuted:false});
        }
        read(fileTasks);
        if (file.state !== 'published')
          return { state: file.state === 'needs_review' ? 'needs_review' : 'pending' };
        const receipt = JSON.parse(String(file.result_json)) as { status: number; body: unknown };
        return { state: 'committed', status: receipt.status, body: receipt.body };
      });
      return found;
    } finally { control.close(); }
  };
  function register<Values extends RawValueMap, Input>(route: HttpRegistration<Values, Input, Context, unknown>,
    spec?: ReturnType<typeof serverCommands.get>) {
    const implementation = spec?.implementation;
    const writes = spec?.kind === 'write', runs = spec?.kind === 'run', act = spec ? null : entryActFor(route.handler);
    if (act === undefined) throw new Error(`An HTTP entry that is no CLI command declares its act: ${route.method} /api${route.path}`);
    api.on(route.method, '/api' + route.path, async (c) => {
      const { claim, cwd } = scopeOf(c.req.raw);
      const links = (value: unknown) => spec ? commandLinks(value, commandOrigin(c.req.raw, publicHost)) : value;
      // An entry that is no command is authorized by the act it declares, before its request is read.
      preflightEntryClaim(root, act, claim);
      if (act) authorizeRead(callerOf(c.req.raw), act);
      const needsInputEvidence = writes || implementation?.inputEvidence;
      const pinned = needsInputEvidence ? callerOf(c.req.raw) : undefined;
      const rawValues = route.method === 'GET' ? undefined
        : route.path === '/presence/away' || route.path === '/presence/resume' ? {}
        : await body(c.req.raw, implementation?.limit ?? requestLimitFor(route.handler));
      // One admission owns the complete write or referenced-reply read, including imported evidence and refusal records.
      const execute = async () => {
        const refusing: { request?: string; task?: string } = {};
        try {
          if (pinned?.kind === 'coordinator' && pinned.source === 'screen') {
            const source = rawValues && typeof rawValues === 'object' ? (rawValues as Record<string, unknown>).sourceRequest : undefined;
            readControl(db => {
              refusing.request = messageForRun(db, pinned.runId);
              refusing.task = rawTarget(db, rawValues);
            });
            await refreshInputEvidence(pinned.runId, {
              ...(typeof source === 'string' ? { sourceRequest: source } : {}),
              ...implementation?.inputEvidence?.(key => c.req.query(key)),
            });
            readControl(db => {
              if (typeof source === 'string' && deliveredMessages(db, pinned.runId).includes(source)) refusing.request = source;
            });
          }
          const values = route.method === 'GET' ? route.input.parseQuery(c.req.queries()) : route.input.parse(rawValues!);
          const requestContext = { ...context, caller: () => callerOf(c.req.raw), cwd,
            readFrame: context.readFrame,
            readLive: async () => {
              await context.readFrame!();
              return new Response(projection.index(), { headers: jsonHeaders });
            },
            readOperation, opId: c.req.header('x-alpacawork-op-id'),
            grantFileWrite: (task: string) => fileOptions.authorizeWrite(c.req.raw, task),
            fileChanged: attachmentChanged };
          if (runs) {
            const caller = callerOf(c.req.raw);
            const { actor } = readControl(db => {
              const action = implementation!.act!(values as Record<string, unknown>, { root, db, caller, cwd });
              return authorize(db, caller, action.action, { task: action.task, quote: null });
            });
            const output = await route.handler(values as never, { ...requestContext, actor } as never);
            return c.json(links(output), 200, jsonHeaders);
          }
          if (writes) {
            const opId = c.req.header('x-alpacawork-op-id');
            if (!opId || opId.length > 256 || /[\r\n]/.test(opId))
              throw new Problem(PROBLEM_CODE.unavailable, 'Reload the client before checking or sending this operation: X-Alpacawork-Op-Id is required', undefined,
                { reason: { kind: 'reload_client_before_checking_or_sending_operation_x_alpacawork_op_id_required' } });
            const operation = spec.id;
            // Identified once before the write begins, where a Run's session may still be imported (resolveCaller).
            const caller = callerOf(c.req.raw);
            if (implementation?.journaled) {
              // It keeps its own operation record, so it is authorized on a read of the control database.
              const { actor } = readControl(db => {
                const act = implementation.act!(values as Record<string, unknown>, { root, db, caller, cwd });
                return authorize(db, caller, act.action, { task: act.task, quote: null });
              });
              const saved = await route.handler(values as never, { ...requestContext, actor, opId } as never);
              return c.json(links(saved), 200, jsonHeaders);
            }
            const control = new ControlStore(root);
            try {
              const fingerprint = createHash('sha256').update(JSON.stringify({
                operation, input: values, runId: claim.run?.runId ?? null,
              })).digest('hex');
              // A replay answers with its saved response; a new write is checked and written in this one transaction.
              const receipt = await control.writeOperationAsync({ opId, operation, fingerprint }, async () => {
                const db = control.connection;
                // Keep the HTTP-start Run pinned; a newer Run in the same session never inherits this operation.
                const current = identifyIn(root, db, claim);
                if (pinned?.kind === 'coordinator' && pinned.source === 'screen' &&
                    (current.kind !== 'coordinator' || current.source !== 'screen' || current.runId !== pinned.runId))
                  throw new Problem(PROBLEM_CODE.forbidden, 'Coordinator Run changed while the operation waited', undefined,
                    { reason: { kind: 'coordinator_run_changed' } });
                screenRunning(db, current);
                const sourceRequest = values && typeof values === 'object' && 'sourceRequest' in values
                  ? values.sourceRequest as string | undefined : undefined;
                const message = recordMessage(db, current, sourceRequest);
                const act = implementation!.act!(values as Record<string, unknown>, { root, db, caller: current, cwd }), action = act.action;
                const quote = recordedQuote(current, act.quote);
                const decision = authorize(db, current, action, { task: act.task, quote, message });
                const body = await route.handler(values as never,
                  { ...requestContext, caller: () => current, actor: decision.actor, changed: undefined } as never);
                return { status: 200, body };
              });
              // The Owner applies the same success contract to fresh and immutable replayed receipts.
              stopDelivery.completeOperation(opId);
              return c.json(links(receipt.body), receipt.status as ContentfulStatusCode, jsonHeaders);
            } finally { control.close(); }
          }
          if (!spec && route.path === '/task/view' && route.method === 'GET')
            await openedTask(c.req.query('task') ?? c.req.query('address'));
          const result = await route.handler(values as never, requestContext as never);
          return result instanceof Response ? result : c.json(links(result), 200, jsonHeaders);
        } catch (error) {
          // The mutation transaction has rolled back. Preserve the actual failure, including unknown/check snapshots.
          if (refusing.request !== undefined && refusing.task !== undefined) {
            try {
              const audit = new ControlStore(root);
              try { audit.write(db => refuse(db, refusing.request!, refusing.task!, failure(error))); }
              finally { audit.close(); }
            } catch (cause) { console.warn('A refused coordinator write was not recorded for its Request', cause); }
          }
          throw error;
        }
      };
      if (runs) return lifecycle.run(execute);
      return writes || !spec && route.method === 'POST' || implementation?.inputEvidence ? orderedWrite(execute) : execute();
    });
  }
  commandRoutes.forEach(route => {
    const spec = serverCommands.get(`${route.method} /api${route.path}`);
    if (!spec) throw new Error(`Missing command registration for ${route.method} ${route.path}`);
    register(route, spec);
  });
  screenRoutes.forEach(route => register(route));
  const RUNTIME: Action = { name: 'runtime' };
  api.post('/api/runtime/quiesce', async c => {
    authorizeRead(callerOf(c.req.raw), RUNTIME);
    return c.json(await lifecycle.quiesce(), 200, jsonHeaders);
  });
  api.get('/api/runtime/preflight', c => {
    authorizeRead(callerOf(c.req.raw), RUNTIME);
    return c.json(inspectExecution(runStore()), 200, jsonHeaders);
  });
  api.get('/api/runtime/readiness', async c => {
    authorizeRead(callerOf(c.req.raw), RUNTIME);
    // Invalid settings must not commit a release switch. Keep serve available for diagnostics and repair.
    let configReadable = !(await readServerSettings(root)).error;
    try { readVoiceSettings(root); } catch { configReadable = false; }
    const execution = inspectExecution(runStore());
    return c.json({ state: lifecycle.state, configReadable, generation, newRunLaunches:lifecycle.state==='accepting'&&releaseAdmission(root)==='accepting'?'enabled':'paused',
      ...execution, pending: execution.contractUsers.length }, configReadable ? 200 : 503, jsonHeaders);
  });
  api.get('/api/runtime/diagnostics', c => {
    authorizeRead(callerOf(c.req.raw), RUNTIME);
    return c.json(runStore().connection.prepare('SELECT run_no,attempt_id,diagnostic FROM run_attempts WHERE diagnostic IS NOT NULL').all(), 200, jsonHeaders);
  });
  api.notFound((c) => {
    const problem = new Problem(PROBLEM_CODE.notFound, 'Unknown endpoint', undefined, { reason: { kind: 'unknown_endpoint' } });
    return c.json(errorBody(problem), problem.status as ContentfulStatusCode, jsonHeaders);
  });
  api.onError((error, c) =>
    c.json(errorBody(error), failure(error).status as ContentfulStatusCode, jsonHeaders),
  );
  const handleApi = getRequestListener(api.fetch, { overrideGlobalObjects: false });
  // Node enforces requestTimeout/headersTimeout only when it sweeps its connections, and
  // it sweeps every 30s by default -- so a stalled connection was held six times longer
  // than the 5s those timeouts declare. Sweeping every second bounds the overrun to one
  // sweep. The sweep only looks at connections whose request has not finished arriving,
  // so an /api/events subscriber is left alone however long it stays open.
  // The client/proxy owns idle connection expiry. Node's keep-alive deadline can race a proxy
  // reusing that connection and reset a POST before admission. Header/body deadlines below still
  // bound incomplete requests; server.close() closes idle connections when serve ends.
  const performanceReceiver = createPerformanceReceiver?.(root);
  const server = createServer({ connectionsCheckingInterval: 1000, keepAliveTimeout: 0 }, async (req, res) => {
    const floor = changes.log.latest;
    try {
      const address = server.address();
      // A closing serve has ended its streams and beats no more: a screen subscribing again on a connection it still
      // holds retries this until the next serve answers. Once it stops listening it has no address, which is no
      // other host either; other requests are served until then.
      if (closing && (!address || req.url?.split('?')[0] === '/api/events'))
        throw new Problem(PROBLEM_CODE.unavailable, 'Server is closing', undefined, { reason: { kind: 'server_closing' } });
      const boundPort = typeof address === 'object' && address ? address.port : 0;
      const host = req.headers.host;
      // Loopback names reach this listener directly over http; the public name only
      // through tailscale serve, which terminates TLS and passes Host through unchanged.
      const local = [boundPort, readThread?.port].some(bound => host === `127.0.0.1:${bound}` || host === `localhost:${bound}`);
      if (!local && !(publicHost !== undefined && host === publicHost))
        throw new Problem(PROBLEM_CODE.forbidden, 'Host is not this local service', undefined, { reason: { kind: 'host_not_local_service' } });
      const origin = `${local ? 'http' : 'https'}://${host}`;
      const url = new URL(req.url ?? '/', origin);
      // The installed app's share target (manifest.webmanifest) is answered by its Service Worker. A share that reaches
      // here (no worker in control yet) opens the screen instead of an error page; what was shared is not kept. The
      // share comes from another app, so it is let through before the origin check: it changes nothing.
      if (url.pathname === '/share' && req.method === 'POST') {
        req.resume();
        res.writeHead(303, { Location: '/' });
        res.end();
        return;
      }
      if (req.headers.origin !== undefined && req.headers.origin !== origin)
        throw new Problem(PROBLEM_CODE.forbidden, 'Cross-origin request rejected', undefined, { reason: { kind: 'cross_origin_request_rejected' } });
      if (performanceReceiver?.handle(req, res, origin)) return;
      if (url.pathname === '/api/identity' && req.method === 'GET') {
        send(res, 200, { generation, root });
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/welcome')) {
        // A new workspace opens on its setup until it is finished; every other opens on the page. The answer is the
        // person's own and changes when they finish, so the redirect is never kept by a cache.
        let pathname: string;
        try { const state = firstRun.get().state; pathname = state && !state.finishedAt ? '/welcome' : '/'; }
        catch (error) {
          // An unreadable record is said where it is read: on the setup, which says it and offers to read it again.
          if (!(error instanceof Problem && error.reason?.kind === 'cannot_read_repair_file_before_editing')) throw error;
          pathname = '/welcome';
        }
        if (url.pathname !== pathname) {
          res.writeHead(302, { Location: pathname + url.search, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        // Choose the first screen language on navigation, before the page reads the settings.
        const language = req.headers['accept-language'];
        if (language && lifecycle.state === 'accepting' && releaseAdmission(root) === 'accepting') {
          try {
            const revision = await lifecycle.run(() => personSettings.initializeLanguage(language));
            if (revision) context.personChanged?.('settings', revision);
          } catch { /* An unreadable settings file is reported by the settings read. */ }
        }
        // Both addresses are the one packaged page; any other address has no page of its own.
        if (serveAsset('/', req.headers, res)) return;
        throw new Problem(PROBLEM_CODE.unavailable, 'Build the browser application with pnpm build', undefined,
          { reason: { kind: 'build_browser_application_with_pnpm_build' } });
      }
      if (req.method === 'GET' && serveAsset(url.pathname, req.headers, res)) return;
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const cursor = req.headers['last-event-id'];
        if (cursor !== undefined && (typeof cursor !== 'string' || !/^[-\w]+:[0-9]+$/.test(cursor)))
          throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid Last-Event-ID', undefined, { reason: { kind: 'invalid_last_event_id' } });
        authorizeRead(identify(root, claimOf(toHeaders(req.headers))), SCREEN);
        const subscriber = subscribe(res, /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')));
        // The client may leave during the initial scan. Register cleanup before
        // awaiting it, or that response can enter streams after its close event.
        res.once('close', () => streams.delete(subscriber));
        queuedReads++;
        try { await projection.read(floor, readAbort.signal); }
        finally { queuedReads--; }
        if (res.destroyed) return;
        subscriber.open();
        streams.add(subscriber);
        publish(subscriber, projection.current!, projection.rev, 'index', projection.index());
        return;
      }
      // Hono answers HEAD with the GET route; this service never registered HEAD, so keep it 404.
      if (req.method === 'HEAD') throw new Problem(PROBLEM_CODE.notFound, 'Unknown endpoint', undefined, { reason: { kind: 'unknown_endpoint' } });
      // Keep ordinary incomplete bodies at five seconds while uploads can use the longer server request deadline.
      if (url.pathname !== '/api/voice/transcriptions' && !url.pathname.match(/^\/api\/(?:tasks\/[^/]+|coordinator)\/attachments$/) && !(req.method === 'PUT' && url.pathname.match(/^\/api\/tasks\/[^/]+\/file$/)) && !req.complete) {
        const deadline = setTimeout(() => {
          if (!req.complete && !res.headersSent) {
            res.writeHead(408, { Connection: 'close' });
            res.end();
          }
        }, 5000);
        req.once('close', () => clearTimeout(deadline));
        res.once('close', () => clearTimeout(deadline));
      }
      const reading = req.method === 'GET' && ['/api/task/view', '/api/task/history', '/api/task/search',
        '/api/task/finished', '/api/task/shelved', '/api/task/timeline', '/api/task/timeline-axis', '/api/workspace/live'].includes(url.pathname);
      if (reading) {
        queuedReads++;
        let released = false;
        const release = () => { if (!released) { released = true; queuedReads--; } };
        res.once('finish', release); res.once('close', release);
      }
      await arrival.run({ floor }, () => handleApi(req, res));
    } catch (error) {
      if (!res.headersSent) send(res, failure(error).status, errorBody(error));
      else res.end();
    }
  });
  // The default 50 MiB attachment takes about 25 minutes at 0.3 Mbit/s on a slow tailnet link; keep the
  // short header deadline separately. limits.attachment_mib above the default needs a faster link.
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 5000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closing: Promise<void> | undefined;
  let stopUpdates:(()=>Promise<void>)|undefined;
  let stopTelemetry:(()=>Promise<void>)|undefined;
  // The address everyone uses: its thread answers reads and passes everything else to `server`, on a port of its own.
  let readThread: ReadThread | undefined;
  let starting = true;
  function close(): Promise<void> {
    return (closing ??= (async () => {
      let drainFault: unknown;
      if (!starting) try { await lifecycle.quiesce(); } catch (error) { drainFault = error; }
      try {
      await stopTelemetry?.();
      stopAnalysisWarm?.();
      await stopAnalysisTally?.();
      analysis.close();
      await firstRunSkills.close();
      await stopUpdates?.();
      clearInterval(timer);
      recordLoopDelay(); loopDelay?.disable();
      releaseExecutionDemand();
      await readThread?.stop();
      await watcher.close();
      for (const subscriber of streams) subscriber.end();
      host.close();
      const deadline = setTimeout(() => settleAbort.abort(new Error('Server is closing')), 10_000);
      try {
        await performanceReceiver?.close();
        if (server.listening) await new Promise<void>((done) => server.close(() => done()));
        // Only now: a connection it passes on may still be carrying the answer to a write that committed.
        await readThread?.close();
        await settling;
      } finally { clearTimeout(deadline); }
      // A background read can fail while a caller is closing its fixture root.
      // Closing still owns every open handle and must finish cleanup.
      const released = await Promise.allSettled([projection.close(), routing.close(), push.close()]);
      runs?.close();
      const rejected = released.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      } finally {
        releaseRecords();
        changes.close();
        releaseWriter();
      }
      if (drainFault) throw drainFault;
    })().catch(error => { closing = undefined; throw error; }));
  }
  try {
    startupCleanup.length = 0; // close() now owns every allocated serving resource.
    // Publish persisted stop intent before listening, routing or new launch.
    publishWorkspaceIdentity(runStore());
    if (startupRunsReadable) {
      importLocalStops(runStore());
      stopDelivery.gate();
      new RunEventImporter(runStore()).pass();
    }
    // The first index includes registration's repair demand. A failed attempt proceeds with the existing poll path.
    await watcher.initialized;
    await projection.start();
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('No listener address');
    readThread = await startReadThread({ root, port, publicHost: publicHost ?? null, backendPort: address.port, answers: walRestored });
    const base = `http://127.0.0.1:${readThread.port}`;
    const publicUrl = publicHost === undefined ? null : `https://${publicHost}/`;
    const connection = connectionFile(root, base, publicUrl, generation);
    stopUpdates=monitorUpdates(root,error=>console.error('Update discovery needs attention',error));
    stopTelemetry=monitorTelemetry(telemetry);
    host.start();
    stopAnalysisTally = startTallyJob(root, tallySince, changes.log, batch => analysis.updateTallies(batch));
    stopAnalysisWarm = warmAnalysisWhenIdle(analysis, () => lifecycle.state === 'accepting' && !queuedWrites && !queuedReads);
    let lastSettle = 0, lastHeartbeat = Date.now(), lastCheck = 0, lastAudit = Date.now();
    let auditing: Promise<void> | undefined;
    loopDelay?.enable();
    timer = setInterval(() => {
      const now = Date.now();
      if (lifecycle.state !== 'accepting') return;
      const settleDue = now - lastSettle >= 30_000;
      const executionDue = executionPrompt || !settling && new RunEventImporter(runStore()).hasPublishedTail();
      if (!settling && (settleDue || executionDue)) {
        executionPrompt = false;
        settling = lifecycle.run(async () => {
          await ordered(async () => {
            const started = performance.now(), revision = runReviews.revision;
            const { skipped } = await settle(runStore(), operation => retryBusy(operation, settleAbort.signal), () => lifecycle.state === 'accepting', runReviews);
            lastSettle = Date.now();
            const next = skipped.length ? `Skipped queued runs: ${skipped.map(item => `${item.run} (${item.reason})`).join(', ')}.` : undefined;
            if (next !== settleError || revision !== runReviews.revision) { settleError = next; republish(); }
            coordinator.sweepAttachments();
            timing?.({ step: 'settle', settleMs: performance.now() - started });
          });
        }).catch(error => {
          if (!settleAbort.signal.aborted) { console.error('Run reconciliation failed', error); settleError = failure(error).message; republish(); }
        }).finally(() => { settling = undefined; });
      }
      void routing.pass().catch(error => console.error('Routing reader failed', error));
      queuePushObservation();
      if (!auditing && now - lastAudit >= projection.auditInterval) {
        lastAudit = now;
        auditing = lifecycle.run(() => projection.audit(16)).catch(error => console.error('Projection audit failed', error))
          .finally(() => { auditing = undefined; });
      }
      if (now - lastCheck >= 10_000) {
        lastCheck = now;
        recordLoopDelay();
      }
      const currentPresence = presence.status(latestSettings, now);
      const shown = projection.current;
      publishPresence(currentPresence);
      if (settingsReadable && shown && !shown.records.environment().errors.length)
        void lifecycle.run(async () => {
          const { state } = await noticeState.get();
          pushNoticesError = false;
          await push.tick(now, currentPresence, state, uiLocaleOrDefault(latestSettings.language));
        }).catch(error => {
          if (!pushNoticesError) console.error('Push notice state could not be read', error);
          pushNoticesError = true;
        });
      const beat = now - lastHeartbeat >= INDEX_HEARTBEAT_MS;
      if (beat) lastHeartbeat = now;
      for (const subscriber of streams) {
        if (subscriber.destroyed()) streams.delete(subscriber);
        else if (beat) subscriber.write(': collector heartbeat (not agent liveness)\n\n');
      }
    }, POLL_INTERVAL_MS);
    starting = false;
    return {
      server,
      context,
      /** The screen's index (every active project); undefined until its first read. */
      feed: () => projection.current ? projection : undefined,
      url: base + '/',
      publicUrl: publicUrl ?? undefined,
      connection,
      generation,
      /** A trusted in-process file writer uses the same publication path as the file routes. */
      filesChanged: attachmentChanged,
      /** A trusted in-process writer committed records it does not name: every reader of the changes reads all again. */
      recordsChanged: () => { changes.log.appendUnknown(); },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
  } catch (error) {
    await Promise.allSettled(startupCleanup.reverse().map(async release => { await release(); }));
    releaseRecords(); changes.close(); releaseWriter(); throw error;
  }
}
