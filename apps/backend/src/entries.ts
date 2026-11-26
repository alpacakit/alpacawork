import { readRunSummary } from './analysis/run-summary-read.js';
import { managedInstallation } from './installation/setup.js';
import { localCaller } from '@alpacawork/contract/access-boundaries';
import { controlTaskHead } from './control/task-dto.js';
/** Server implementations of shared commands and the local CLI’s workspace administration. */
import type { DatabaseSync } from 'node:sqlite';
import {
  codecs,
  defineEntry,
  defineEntryEndpoint,
  defineEntryNode,
  defineParameter,
  optional,
  type ParameterSet,
} from '@alpacakit/channels';
import { bindHttpEntry } from '@alpacakit/channels/http';
import { z } from 'zod';
import type { WriteGrant } from './control/file-journal.js';
import { removeTaskAttachment, moveTaskAttachments } from './control/task-files.js';
import type { CommandInput, CommandName } from '@alpacawork/contract/commands';
import { readCoordinatorMemo, setCoordinatorMemo } from './coordinator/memo.js';
import { replySource, replyPage } from './coordinator/reply.js';
import { mayReadReply } from './coordinator/messages.js';
import { initializeInstallation } from './installation/setup.js';
import { InstallationStore, installationPath } from './installation/store.js';
import { bindCliOptions, textParameter } from '@alpacawork/cli-kit';
import { defaultParentAt, projectAtCwd, writeProjectLocation } from './control/project-settings.js';
import { inspectServerSettings, readServerSettings, saveServerSettings } from './server-settings.js';
import { PROBLEM_CODE, Problem, parseInput } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import type { AnalysisSubject, TaskActor } from '@alpacawork/raw';
import { requestStop } from './runs/entry.js';
import { readRunFiles } from './runs/view.js';
import { readRunStepIndex } from './runs/run-steps.js';
import { readConditionsView } from './runs/conditions.js';
import { RUN_STEPS_PAGE_LIMIT } from '@alpacawork/contract/run';
import { emptyInput, configSetInput, chooseFolderInput, foldersInput, makeFolderInput } from '@alpacawork/contract/inputs';
import { deleteField, listFields, readSchema, setField } from './control/field-commands.js';
import { readValuesAt, readValuesChange } from './control/task-values-store.js';
import { now } from '@alpacawork/raw';
import { ReturnRouter } from './control/return-router.js';
import { readTaskReturns } from './control/return-views.js';
import { ControlTaskStore, TaskRepository, TaskTree } from './control/task-store.js';
import { withControlWrite } from './control/task-transition.js';
import { ControlTaskCommands } from './control/task-commands.js';
import { reportedTask, TaskReportService } from './control/report.js';
import { TaskRequestService } from './control/task-request.js';
import { comment } from './control/task-questions.js';
import { replyQuestion } from './control/question-rules.js';
import { readTaskListView, readTaskView } from './control/task-views.js';
import { readRunList } from './control/run-list.js';
import { chooseFolder, listFolders, makeFolder } from './control/folders.js';
import { resolveCaller, type CallerClaim } from './control/credentials.js';
import { authorize, commandAction, decide, runMayDo, type AccessCommand, type Action, type Caller, type CommandFacts, type Decision } from './control/authorize.js';
import { PlacementCommands } from './control/placement-commands.js';
import { selectWorkspace } from './workspace.js';

export interface Context {
  agentInspection?: import('./agents/availability.js').InspectionEnvironment;
  root?: string;
  changed?: () => void;
  /** The local CLI that administers the server: where it runs (`requireRoot`) and what it claims (`requireAdmin`). */
  cli?: { env: Readonly<Record<string, string | undefined>>; cwd: string };
  /**
   * Who calls an HTTP entry: server.ts resolves it (resolveCaller) when asked, and for a write before it begins; a
   * write's entry gets the caller its transaction checked again.
   */
  caller?: () => Caller;
  /** The actor authorize decided for a write, on what its node says it is to authorize (server.ts, the command’s act). */
  actor?: TaskActor;
  serve?: (root: string, port: number, options: { publicHost?: string; timing?: boolean; mcp?: boolean }) => Promise<void>;
  /**
   * The request's idempotency key: `config set` keeps its own operation record under it, a comment's record takes it,
   * and a project's code location is published under one derived from it (`locationOperation`).
   */
  opId?: string;
  /**
   * The request is this server's own page asking, opened at a loopback name, so its person is at this PC: the public
   * name may be another device, and another site open in the same browser asks cross-site (Fetch Metadata).
   */
  local?: boolean;
  /** Aborted when the request's connection is gone. */
  signal?: AbortSignal;
  readOperation?: (opId: string, caller: Caller) => unknown;
  grantFileWrite?: (task: string) => WriteGrant;
  fileChanged?: (task: string) => Promise<void>;
  /** A person's CLI working directory (its real path, `X-Alpacawork-Cwd`; null when not sent), for the cwd rule (`projectAtCwd`). */
  cwd?: string | null;
}

/**
 * Largest JSON body the receiver reads for an Entry. The definition binds it to its
 * handler, so the server never switches on a route name.
 */
const DEFAULT_REQUEST_LIMIT = 16 * 1024;
export const LARGE_REQUEST_LIMIT = 512 * 1024;
/** JSON escaping can expand a 1 MiB UTF-8 document to six ASCII bytes per byte. */
export const DOCUMENT_REQUEST_LIMIT = 7 * 1024 * 1024;
const requestLimits = new WeakMap<object, number>();
export function withRequestLimit<Endpoint extends { readonly handler: object }>(
  endpoint: Endpoint,
  bytes: number,
): Endpoint {
  requestLimits.set(endpoint.handler, bytes);
  return endpoint;
}
export function requestLimitFor(handler: object): number {
  return requestLimits.get(handler) ?? DEFAULT_REQUEST_LIMIT;
}
/**
 * What each HTTP entry that is no CLI command is to authorize, bound to its handler as its request limit
 * is: server.ts identifies the caller and asks authorize for it before it reads the request. null names no act of the
 * table: an observation.
 */
const entryActs = new WeakMap<object, Action | null>();
export function withAct<Endpoint extends { readonly handler: object }>(endpoint: Endpoint, act: Action | null): Endpoint {
  entryActs.set(endpoint.handler, act);
  return endpoint;
}
/** The action declared by a screen entry, or null for a public observation. */
export function entryActFor(handler: object): Action | null | undefined {
  return entryActs.get(handler);
}
/**
 * The person's screen: its index and the reads made from it, and the person's own state the screen keeps (settings,
 * read checkpoints, presence, notification devices), the host status and the folders it shows. A Run or a coordinator
 * has none.
 */
export const SCREEN: Action = { name: 'screen' };
/** What a write is to authorize: its act, the Task it acts on (Target.task) and optional words to record. */
type WriteAct = { action: Action; task: string | null; quote?: string };
/** Where a write's act is read: the write's connection, its caller, and the working directory a person's CLI sent. */
type WriteReading = { root: string; db: DatabaseSync; caller: Caller; cwd: string | null };

export function requireRoot(context: Context, intent: 'inspect' | 'existing' = 'inspect'): string {
  if (context.cli) {
    const selection = selectWorkspace({ explicit: context.root, ...context.cli,
      record: managedInstallation(context.cli.env) ?? new InstallationStore(installationPath(context.cli.env)).read(), intent });
    return selection.root;
  }
  if (context.root !== undefined) return context.root;
  throw new Problem(PROBLEM_CODE.invalidInput, '--workspace is required', undefined,
    { reason: { kind: 'workspace_required' }, issues: [{ path: 'workspace', code: 'required', message: '--workspace is required' }] });
}
/**
 * Whether the local CLI may do `action` (an administration of the server, or a release). The local CLI speaks for no
 * conversation, so a Run's credential in its environment, even an incomplete one, is all it can claim; anyone else is a
 * person. A person's act reads no facts, so the table decides it without the database, which maintenance may yet have
 * to migrate, and a person's release on no workspace needs none. A Run's is decided on its own Task in the workspace
 * (`root`), which is read only then, and only for an act the table lets a Run do.
 */
export function requireLocal(context: Context, action: { name: 'admin' | 'release' }, root: () => string): Caller {
  const env: Readonly<Record<string, string | undefined>> = context.cli?.env ?? {};
  const claim: CallerClaim = localCaller.claimsRun(env)
    ? { run: { runId: env.ALPACAWORK_RUN ?? '', token: env.ALPACAWORK_RUN_TOKEN ?? '' } } : {};
  if (!claim.run) {
    const decided = decide(resolveCaller('', claim, null), action, { task: null, runProject: null, runState: null, quote: null });
    if (decided instanceof Problem) throw decided;
    return {kind:'human'};
  }
  const workspace = root();
  const store = runMayDo(action.name) ? RunStore.openReadable(workspace, { busyTimeoutMs: 1000 }) : null;
  try {
    const caller = resolveCaller(workspace, claim, store);
    authorize(store!.connection, caller, action, { task: caller.kind === 'run' ? caller.taskId : null, quote: null });
    return caller;
  } finally { store?.close(); }
}
/** Only a person administers the server from this PC (`requireLocal`). */
export const requireAdmin = (context: Context, root: () => string): void => { requireLocal(context, { name: 'admin' }, root); };
/** Who calls an HTTP entry, as server.ts resolves it; throws resolveCaller's refusal. */
export function requireCaller(context: Context): Caller {
  if (!context.caller) throw new Error('server.ts names the caller of an HTTP entry');
  return context.caller();
}
function requireActor(context: Context): TaskActor {
  if (!context.actor) throw new Error('server.ts authorizes a write before its entry runs');
  return context.actor;
}

/** One read of the control database; inside a write, on the write's own connection, which ControlStore borrows. */
function readControl<T>(root: string, read: (db: DatabaseSync) => T): T {
  const store = new ControlStore(root, { busyTimeoutMs: 1000 }, true);
  try { return store.read(read); } finally { store.close(); }
}
/** A read entry asks authorize on its own read: throws the refusal; a Run's decision names the project it reads. */
export function authorizeRead(root: string, context: Context, action: Action, task: string | null): Decision {
  return readControl(root, db => authorize(db, requireCaller(context), action, { task, quote: null }));
}

type Input = z.ZodType<Record<string, unknown>>;
function endpoint<Schema extends Input, Result extends object>(name: string, parameters: ParameterSet,
  method: 'GET' | 'POST', schema: Schema, run: (root: string, input: z.output<Schema>, context: Context) => Promise<Result>) {
  const entry = defineEntry({ name, parameters, project: ({ values }) => values });
  return defineEntryEndpoint(entry, {
    handler: async (input: Record<string, unknown>, context: Context) => {
      const result = await run(requireRoot(context), parseInput(schema, input), context);
      if (method === 'POST') context.changed?.();
      return result;
    },
    channels: [bindHttpEntry({ method })],
  });
}
const optionalText = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.string(), requirement: optional(),
});

const flag = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.boolean(), requirement: optional(),
});

/** The act of a write on the Task it names, with the words it records. */
const taskAct = (command: AccessCommand, input: { task: string; quote?: string } & Record<string, unknown>, facts?: CommandFacts): WriteAct =>
  ({ action: commandAction(command, input, facts), task: input.task, quote: input.quote });
/** The ID a write's records take: the request's idempotency key. */
function operationId(context: Context): string {
  if (!context.opId) throw new Problem(PROBLEM_CODE.invalidInput, 'This write requires an operation ID', undefined, { reason: { kind: 'write_requires_operation_id' } });
  return context.opId;
}
/**
 * A project's code location goes to this PC's config.yaml after its Task write and before the operation commits, so a
 * refused location leaves no Task write. Its own operation ID derives from the request's, so a rerun replays it.
 */
const locationOperation = (context: Context) => `${operationId(context)}:location`;

/** The Task of Run `runId`; a coordinator's Run is no Task's, so it is not found. */
function runTask(root: string, db: DatabaseSync, runId: string): string {
  const store = new RunStore(root, { busyTimeoutMs: 0 }, true, db);
  try {
    const task = store.get(runId)?.task;
    if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', { run: runId }, { reason: { kind: 'run_does_not_exist' } });
    return task;
  } finally { store.close(); }
}
/** Whether placement `placementId` of `task` is a member (a worker) rather than its responsible. */
function isWorker(root: string, db: DatabaseSync, task: string, placementId: string): boolean {
  const store = new RunStore(root, { busyTimeoutMs: 0 }, true, db);
  try {
    const placement = store.getPlacement(placementId);
    if (!placement || placement.taskId !== task)
      throw new Problem(PROBLEM_CODE.notFound, 'Placement does not exist on this Task', { task, agent: placementId },
        { reason: { kind: 'placement_does_not_exist_on_task' } });
    return !placement.responsible;
  } finally { store.close(); }
}
/**
 * The parent a Task is created under: the named one, none for a top project; else, for a person and the coordinator,
 * the cwd rule's project (`defaultParentAt`). A Run creates below its own Task and names it.
 */
function creationParent(root: string, db: DatabaseSync, parent: string | undefined, caller: Caller,
  cwd: string | null): string | null {
  if (parent !== undefined) return parent === 'none' ? null : parent;
  if (caller.kind === 'run')
    throw new Problem(PROBLEM_CODE.invalidInput, 'A Run creates below its own Task and names it with --parent', undefined,
      { reason: { kind: 'run_creates_below_own_task_and_names_it_with_parent' }, issues: [{ path: 'parent', code: 'required', message: '--parent is required' }] });
  return defaultParentAt(root, db, cwd, 'parent');
}
/** A member's placement changes against the responsible's revision. */
function responsibleRevision(value: number | undefined): number {
  if (value !== undefined) return value;
  throw new Problem(PROBLEM_CODE.invalidInput, 'A member needs --expected-responsible-revision', undefined,
    { reason: { kind: 'member_needs_expected_responsible_revision' }, issues: [{ path: 'expectedResponsibleRevision', code: 'required',
      message: '--expected-responsible-revision is required' }] });
}
/**
 * The Task whose schema field get returns: the named one; else a Run's own; else the cwd rule's project, and null (the
 * default schema) when the rule gives none. A Run reads only its own project's.
 */
function schemaTask(root: string, task: string | undefined, context: Context): string | null {
  const caller = requireCaller(context);
  const named = task ?? (caller.kind === 'run' ? caller.taskId
    : readControl(root, db => projectAtCwd(root, db, context.cwd ?? null, 'task')));
  if (named !== null) authorizeRead(root, context, { name: 'task.read' }, named);
  return named;
}

/** A placement write answers with the placement and its Task as they now are. */
const placementReceipt = async <Agent>(root: string, agent: Agent, task: string) =>
  ({ agent, task: controlTaskHead(await new ControlTaskStore(root).get(task)) });

/** The Runs a stop reached by their Task, for its audit; the stop stands whether this reads or not. */
function stoppedByTask(root: string, ids: readonly string[]): Map<string, string[]> {
  const unread = (cause?: unknown) => new Problem(PROBLEM_CODE.saveUnconfirmed, 'Runs stopped but their audit could not be read', undefined,
    { reason: { kind: 'runs_stopped_but_their_audit_could_not_read' }, ...(cause === undefined ? {} : { cause }) });
  const store = RunStore.openExisting(root, { busyTimeoutMs: 0 });
  if (!store) throw unread();
  try {
    const affected = new Map<string, string[]>();
    for (const run of ids.flatMap(id => store.get(id) ?? [])) affected.set(run.task, [...(affected.get(run.task) ?? []), run.id]);
    return affected;
  } catch (error) { throw unread(error); }
  finally { store.close(); }
}

/** The local CLI's: it makes the workspace a server runs in. */
const initEntry = defineEntry({ name: 'init', parameters: [], project: () => ({}) });
export const initNode = defineEntryNode({ name: 'init', description: 'Create a new workspace (default ~/alpacawork); does not register a service',
  endpoints: [defineEntryEndpoint(initEntry, {
    handler: (input: unknown, context: Context) => {
      parseInput(emptyInput, input);
      requireAdmin(context, () => requireRoot(context));
      if (!context.cli) throw new Problem(PROBLEM_CODE.forbidden, 'init is only available from the local CLI', undefined,
        { reason: { kind: 'init_only_available_from_local_cli' } });
      return initializeInstallation({ explicit: context.root, ...context.cli });
    }, channels: [bindCliOptions(initEntry.parameters)] })] });

/** A person's folder fields: HTTP only, with the same screen authorization for listing and making. */
export const foldersNode = defineEntryNode({ name: 'folders',
  description: 'List the folders in a folder of this PC, for choosing a project\'s code location',
  endpoints: [withAct(endpoint('folders', [optionalText('path', 'Folder to list (absolute or ~/…)'),
    optionalText('prefix', 'Only names starting with this'), flag('hidden', 'Include hidden folders')], 'GET', foldersInput,
  async (root, input) => listFolders(root, input)), SCREEN)],
  children: [defineEntryNode({ name: 'new', description: 'Make one folder and choose it for a project',
    endpoints: [withAct(endpoint('new', [textParameter('path', 'Parent folder (absolute or ~/…)'),
      textParameter('name', 'New folder name')], 'POST', makeFolderInput,
      async (root, input) => makeFolder(root, input)), SCREEN)] }),
  defineEntryNode({ name: 'choose', description: 'Show this PC\'s own folder chooser to a person at this PC and answer the folder chosen',
    endpoints: [withAct(endpoint('choose', [optionalText('path', 'Folder to open at (absolute or ~/…)'),
      textParameter('title', 'Title of the chooser')], 'GET', chooseFolderInput,
      async (root, input, context) => chooseFolder(root, input, { local: context.local === true, signal: context.signal })), SCREEN)] })] });

export type JsonCommandName = Exclude<CommandName, `task/file/${string}` | 'task/attachment/put'>;
export type ServerCommand<Input, C extends Context = Context> = {
  run: (root: string, input: Input, context: C) => unknown;
  act?: (input: Input, reading: WriteReading) => WriteAct;
  limit?: number;
  journaled?: true;
  replayFromRun?: true;
  inputEvidence?: (query: (name: string) => string | undefined) => { replyTo?: string };
  readThread?: (input: Input) => boolean;
};
type LocalCommands = Exclude<JsonCommandName, `analysis/${string}` | `settings/${string}` | 'project/shelf' | 'workspace/url' | 'operation/get' | 'help' | 'guide'>;

function lifecycleCommand(action: 'archive' | 'delete' | 'restore'): ServerCommand<CommandInput<'task/archive'>> {
  return {
    act: input => taskAct(`task.${action}`, input),
    run: (root, input, context) => new ControlTaskCommands(root, requireActor(context)).lifecycle({
      id: input.task, action, expectedTaskHash: input.expectedTaskHash,
    }),
  };
}

/** A Task reference in a write carries the same read grant as task get. */
function authorizeAnalysisSubject(root: string, context: Context, subject: AnalysisSubject | null | undefined): void {
  if (subject?.kind === 'task')
    authorizeRead(root, context, { name: 'task.read' }, subject.task);
}

export const taskCommands = {
  'task/get': {
    run: async (root, input, context) => {
      const { readScope } = authorizeRead(root, context, { name: 'task.read' }, input.task);
      return readTaskView(root, input.task, { log: input.log, runs: input.runs, question: input.question, include: input.include }, readScope);
    },
    readThread: ({ include }) => !include?.some(key => ['files', 'usage', 'openObligations', 'estimateExamples'].includes(key)),
  },
  'task/list': {
    run: async (root, input, context) => {
      const { readScope } = authorizeRead(root, context, { name: 'task.list' }, null);
      return readTaskListView(root, { under: input.under, depth: input.depth, text: input.text, in: input.in, limit: input.limit, cursor: input.cursor, state: input.state,
        all: input.all === true, kind: input.kind }, readScope);
    },
    readThread: ({ text, in: places }) => !text && !places?.length,
  },
  'task/returns': {
    run: async (root, input, context) =>
    readTaskReturns(root, input, authorizeRead(root, context, { name: 'task.read' }, input.task).readScope ?? undefined),
    readThread: () => true,
  },
  'task/values': {
    run: async (root, input, context) => {
      authorizeRead(root, context, { name: 'task.read' }, input.task);
      return readControl(root, db => input.changeLog !== undefined
        ? readValuesChange(db, input.task, input.changeLog) : readValuesAt(db, input.task, input.at!));
    },
    readThread: () => true,
  },
  'task/new': {
    act: (input, { root, db, caller, cwd }) => ({
    action: commandAction('task.new', input),
    task: creationParent(root, db, input.parent, caller, cwd), quote: input.quote }),
    run: async (root, input, context) => {
      const parentId = readControl(root, db =>
        creationParent(root, db, input.parent, requireCaller(context), context.cwd ?? null));
      const drafts = input.plan ?? [{ title: input.title!, values: input.values, analysisSubject: input.analysisSubject }];
      for (const draft of drafts) authorizeAnalysisSubject(root, context, draft.analysisSubject);
      const { tasks } = await new ControlTaskCommands(root, requireActor(context)).create({ kind: input.kind, color: input.color, parentId,
        userRequested: input.fromUser ?? null, tasks: drafts,
        expectedParentHash: input.expectedParentHash });
      if (input.plan !== undefined) return { tasks };
      const task = tasks[0]!;
      if (input.cwd !== undefined) await writeProjectLocation(root, task.id, input.cwd, locationOperation(context));
      return { task };
    },
    limit: DOCUMENT_REQUEST_LIMIT,
  },
  'task/update': {
    act: input => taskAct('task.update', input),
    run: async (root, input, context) => {
      authorizeAnalysisSubject(root, context, input.analysisSubject);
      const { task, result } = await new ControlTaskCommands(root, requireActor(context)).update({ id: input.task,
        title: input.title, values: input.values, color: input.color, userRequested: input.fromUser, analysisSubject: input.analysisSubject,
        expectedTaskHash: input.expectedTaskHash, trigger: input.trigger, triggerNote: input.triggerNote });
      if (input.cwd !== undefined) await writeProjectLocation(root, input.task, input.cwd, locationOperation(context));
      return { task, ...(result && { ignoredTrigger: true as const }) };
    },
    limit: DOCUMENT_REQUEST_LIMIT,
  },
  'task/report': {
    act: (input, { caller }) => {
      const task = reportedTask(input, caller);
      return { action: commandAction('task.report', input), task, quote: input.quote };
    },
    run: async (root, input, context) =>
    new TaskReportService(root).report({ ...input, opId: operationId(context) }, requireActor(context), requireCaller(context)),
    limit: DOCUMENT_REQUEST_LIMIT,
    replayFromRun: true,
  },
  'task/request': {
    act: (input, { root, db }) => {
      const answers = input.answers;
      if (answers === undefined) return taskAct('task.request', input, {
        worker: input.agent !== undefined && isWorker(root, db, input.task, input.agent) });
      // An answer goes to whom the question asked, fixed when it was asked.
      const question = replyQuestion(input.task, new TaskRepository(root, db).get(input.task).meta.log, answers);
      return taskAct('task.request', input, { askedTo: question.asked.askedTo, closed: question.closing !== null });
    },
    run: async (root, { instruction, ...input }, context) =>
      new TaskRequestService(root).request({ ...input, body: instruction, opId: operationId(context) },
        requireActor(context), requireCaller(context)),
    limit: LARGE_REQUEST_LIMIT,
  },
  'task/comment': {
    act: input => taskAct('task.comment', input),
    run: async (root, input, context) => {
      const caller = requireCaller(context), actor = requireActor(context), id = operationId(context);
      return withControlWrite(root, (tx, db) => {
        comment(tx, { actor, runId: caller.kind === 'run' ? caller.runId : null,
          taskId: input.task, opId: id, expectedTaskHash: input.expectedTaskHash, title: input.title,
          description: input.description, urgentReason: input.urgent });
        return { task: controlTaskHead(new TaskRepository(root, db).get(input.task)) };
      });
    },
  },
  'dependency/set': {
    act: input => taskAct('task.request', input),
    run: async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).dependencies(input),
  },
  'dependency/clear': {
    act: input => taskAct('task.request', input),
    run: async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).dependencies({ ...input, after: [] }),
  },
  'task/move': {
    act: (input, { root, db }) => {
      if (input.parent === 'none') return taskAct('task.move', input);
      const tasks = new TaskRepository(root, db), tree = new TaskTree(tasks.branch(tasks.projectFor(input.parent)));
      return taskAct('task.move', input, { to: [input.parent, ...tree.ancestors(input.parent).map(task => task.id)] });
    },
    run: async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).move({ id: input.task,
    parentId: input.parent === 'none' ? null : input.parent, expectedTaskHash: input.expectedTaskHash }),
  },
  'agent/assign': {
    act: input => taskAct('agent.assign', input),
    run: async (root, input, context) => {
      const commands = new PlacementCommands(root), actor = requireActor(context);
      const launch = { selected: input.selected, aiStack: input.aiStack, placedAs: input.placedAs, placedNote: input.placedNote };
      const agent = input.role === 'responsible'
        ? await commands.placeNewResponsible({ taskId: input.task, profileKey: input.profile,
          ...launch,
          expectedTaskHash: input.expectedTaskHash, replacePlacementId: input.replace,
          expectedPlacementRevision: input.expectedPlacementRevision }, actor)
        : await commands.placeMember({ taskId: input.task, agentId: input.person, profileKey: input.profile,
          ...launch,
          expectedTaskHash: input.expectedTaskHash,
          expectedResponsibleRevision: responsibleRevision(input.expectedResponsibleRevision) }, actor);
      return placementReceipt(root, agent, input.task);
    },
  },
  'agent/handover': {
    act: input => taskAct('agent.handover', input),
    run: async (root, input, context) => {
      const agent = await new PlacementCommands(root).setResponsible({ taskId: input.task, placementId: input.agent,
        expectedTaskHash: input.expectedTaskHash, expectedPlacementRevision: input.expectedPlacementRevision,
        placedAs: input.placedAs, placedNote: input.placedNote }, requireActor(context));
      return placementReceipt(root, agent, input.task);
    },
  },
  'agent/release': {
    act: (input, { root, db }) => taskAct('agent.release', input, { worker: isWorker(root, db, input.task, input.agent) }),
    run: async (root, input, context) => {
      const commands = new PlacementCommands(root), actor = requireActor(context);
      const caller = requireCaller(context);
      const placement = { taskId: input.task, placementId: input.agent, expectedTaskHash: input.expectedTaskHash,
        expectedPlacementRevision: input.expectedPlacementRevision, taken: input.taken, cause: input.cause,
        aspects: input.aspects, causeNote: input.causeNote };
      // The same fact its act took for authorize: a member's release answers to the responsible's revision.
      const agent = readControl(root, db => isWorker(root, db, input.task, input.agent))
        ? await commands.releaseMember({ ...placement,
          expectedResponsibleRevision: responsibleRevision(input.expectedResponsibleRevision) }, actor)
        : await commands.release(placement, actor, caller.kind === 'run' ? caller.taskId : null);
      return placementReceipt(root, agent, input.task);
    },
  },
  'run/get': {
    run: async (root, input, context) => {
      authorizeRead(root, context, { name: 'task.read' }, readControl(root, db => runTask(root, db, input.run)));
      return readRunFiles(root, input.run, input.kind ?? 'result');
    },
    readThread: () => true,
  },
  'run/steps': {
    run: async (root, input, context) => {
      authorizeRead(root, context, { name: 'task.read' }, readControl(root, db => runTask(root, db, input.run)));
      const index = await readRunStepIndex(root, input.run);
      if (input.step === undefined) return index ? index.range(input.from, input.limit ?? RUN_STEPS_PAGE_LIMIT)
        : { steps: [], total: 0, version: 0, complete: true, generation: 0 };
      const detail = index ? await index.detail(input.step) : null;
      if (!detail) throw new Problem(PROBLEM_CODE.notFound, 'Step does not exist', { run: input.run }, { reason: { kind: 'run_does_not_exist' } });
      return detail;
    },
    readThread: () => true,
  },
  'run/conditions': {
    run: async (root, input, context) => {
      authorizeRead(root, context, { name: 'task.read' }, readControl(root, db => runTask(root, db, input.run)));
      return readConditionsView(root, input.run);
    },
    readThread: () => true,
  },
  'run/summary': {
    run: async (root, input, context) => {
      authorizeRead(root, context, { name: 'task.read' }, readControl(root, db => runTask(root, db, input.run)));
      return readRunSummary(root, input.run);
    },
    readThread: () => true,
  },
  'run/list': {
    run: async (root, input, context) =>
      readRunList(root, input, authorizeRead(root, context, { name: 'task.list' }, null).readScope),
    readThread: () => true,
  },
  'run/stop': {
    act: (input, { root, db }) => ({ action: commandAction('run.stop', input), task: runTask(root, db, input.run), quote: input.quote }),
    run: async (root, input, context) => {
      const actor = requireActor(context);
      const { result } = requestStop(root, input, context.opId);
      for (const [taskId, runIds] of stoppedByTask(root, [...result.cancelled, ...result.stop_requested]))
        await new ControlTaskCommands(root, actor).recordRunStop({ id: taskId, runIds });
      return result;
    },
  },
  'field/get': {
    run: async (root, input, context) => readSchema(root, schemaTask(root, input.task, context), input.version),
    readThread: () => true,
  },
  'field/use': {
    act: input => ({ action: { name: 'field.use' }, task: input.task, quote: input.quote }),
    run: async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).setSchema({ task: input.task,
    fields: input.inherit ? null : input.fields!, expectedTaskHash: input.expectedTaskHash }),
  },
  'field/list': {
    run: async (root, _input, context) => { authorizeRead(root, context, { name: 'field.list' }, null); return listFields(root); },
  },
  'field/set': {
    act: input => ({ action: { name: 'field.set' }, task: null, quote: input.quote }),
    run: async (root, input) => setField(root, input, now()),
  },
  'field/delete': {
    act: input => ({ action: { name: 'field.delete' }, task: null, quote: input.quote }),
    run: async (root, input) => deleteField(root, input.field),
  },
  'config/get': {
    run: root => readServerSettings(root),
  },
  'config/inspect': {
    act: () => ({ action: { name: 'config.inspect' }, task: null }),
    run: (root, input, context) => inspectServerSettings(root, input, context.agentInspection),
  },
  'task/attachment/remove': {
    journaled: true,
    act: ({ task }) => ({ action: { name: 'file.write' }, task }),
    run: async (root, input, context) => {
      const result = await removeTaskAttachment(root, input.task, input.requestId, input.name,
        operationId(context), context.grantFileWrite!(input.task));
      await context.fileChanged!(input.task);
      return result;
    },
  },
  'task/attachment/move': {
    journaled: true,
    act: ({ task }) => ({ action: { name: 'file.write' }, task }),
    run: async (root, input, context) => {
      const result = await moveTaskAttachments(root, input.task, input.from, input.to,
        operationId(context), context.grantFileWrite!(input.task));
      await context.fileChanged!(input.task);
      return result;
    },
  },
  'config/set': {
    act: () => ({ action: { name: 'config.set' }, task: null }),
    run: (root, input, context) => saveServerSettings(root, parseInput(configSetInput, input), context.opId, requireActor(context)),
    limit: DOCUMENT_REQUEST_LIMIT,
    journaled: true,
  },
  'workspace/returns': {
    act: () => ({ action: { name: 'admin' }, task: null }),
    run: root => new ReturnRouter(root).pass(),
  },
  'coordinator/memo/get': {
    run: (root, _input, context) => readControl(root, db => readCoordinatorMemo(db, requireCaller(context))),
  },
  'coordinator/memo/set': {
    act: () => ({ action: { name: 'coordinator.memo' }, task: null }),
    run: (root, input, context) => withControlWrite(root, (_tx, db) => setCoordinatorMemo(db, requireCaller(context), input.text)),
  },
  'coordinator/reply/get': {
    run: async (root, input, context) => readControl(root, db => {
      const caller = requireCaller(context);
      if (caller.kind !== 'coordinator' || !mayReadReply(db, caller, input.message))
        throw new Problem(PROBLEM_CODE.forbidden, 'This Run does not reference that reply', undefined,
          { reason: { kind: 'reply_target_unavailable' } });
      return replyPage(replySource(db, caller.conversation, input.message), input.from);
    }),
    inputEvidence: query => ({ replyTo: query('message') }),
  },
  'task/archive': lifecycleCommand('archive'),
  'task/delete': lifecycleCommand('delete'),
  'task/restore': lifecycleCommand('restore'),
} satisfies { [Name in LocalCommands]: ServerCommand<CommandInput<Name>> };
