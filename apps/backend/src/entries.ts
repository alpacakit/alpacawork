import { AGENT_CHECK_MS, agentInspectionSchema } from '@alpacawork/contract';
import { managedInstallation } from './installation/setup.js';
import { localCaller } from '@alpacawork/contract/access-boundaries';
import { controlTaskHead } from './control/task-dto.js';
/** Task entry contracts: the HTTP entries of the commands, and the local CLI's administration of the server. */
import type { DatabaseSync } from 'node:sqlite';
import {
  codecs,
  defineEntry,
  defineEntryEndpoint,
  defineEntryNode,
  defineParameter,
  optional,
  required,
  type ParameterSet,
} from '@alpacakit/channels';
import { bindHttpEntry } from '@alpacakit/channels/http';
import { z } from 'zod';
import { coordinatorReplyGetInput } from '@alpacawork/contract/coordinator';
import { replySource, replyPage } from './coordinator/reply.js';
import { mayReadReply } from './coordinator/messages.js';
import { initializeInstallation } from './installation/setup.js';
import { InstallationStore, installationPath } from './installation/store.js';
import { bindCliOptions, textParameter } from '@alpacawork/cli-kit';
import { defaultParentAt, projectAtCwd, writeProjectLocation } from './control/project-settings.js';
import { inspectServerSettings, saveServerSettings } from './server-settings.js';
import { PROBLEM_CODE, Problem, parseInput } from '@alpacawork/core';
import { ControlStore } from '@alpacawork/db';
import { RunStore } from '@alpacawork/runs';
import { CONFIG_FILE, type TaskActor } from '@alpacawork/raw';
import { requestStop } from './runs/entry.js';
import { readRunFiles } from './runs/view.js';
import {
  dependencySetInput, dependencyClearInput, taskReturnsInput, taskGetInput, taskListInput, taskCreateInput, taskUpdateInput, taskMoveInput, taskLifecycleInput,
  taskReportInput, taskRequestInput, taskCommentInput, agentAssignInput, agentHandoverInput, agentReleaseInput,
  runGetInput, runStopInput, emptyInput, configSetInput, foldersInput, makeFolderInput,
  fieldGetInput, fieldUseInput, fieldSetInput, fieldDeleteInput,
} from '@alpacawork/contract/inputs';
import { deleteField, listFields, readSchema, setField } from './control/field-commands.js';
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
import { listFolders, makeFolder } from './control/folders.js';
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
  /** The actor authorize decided for a write, on what its node says it is to authorize (server.ts, `writeActFor`). */
  actor?: TaskActor;
  serve?: (root: string, port: number, options: { publicHost?: string; timing?: boolean }) => Promise<void>;
  /**
   * The request's idempotency key: `config set` keeps its own operation record under it, a comment's record takes it,
   * and a project's code location is published under one derived from it (`locationOperation`).
   */
  opId?: string;
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
/** The act the entry with `handler` declared (`withAct`); undefined for a CLI command's, which authorizes itself. */
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
/** Each write node binds its act to its handler (`writeNode`), as it binds its request limit. */
const writeActs = new WeakMap<object, (input: unknown, reading: WriteReading) => WriteAct>();
/**
 * The act of the write entry with `handler`: server.ts reads it before the write runs, in the write's transaction (on
 * a read for one that keeps its own operation record), and authorizes it.
 */
export function writeActFor(handler: object): (input: unknown, reading: WriteReading) => WriteAct {
  const act = writeActs.get(handler);
  if (!act) throw new Error('A write entry names its act (writeNode)');
  return act;
}

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
function requireCaller(context: Context): Caller {
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
export function readNode<Schema extends Input, Result extends object>(name: string, description: string,
  parameters: ParameterSet, schema: Schema, run: (root: string, input: z.output<Schema>, context: Context) => Promise<Result>) {
  return defineEntryNode({ name, description, endpoints: [endpoint(name, parameters, 'GET', schema, run)] });
}
/**
 * A write: `act` says what it is to authorize, read on the write's connection; server.ts authorizes that before it
 * runs the write, and the write acts as the actor authorize decided.
 */
export function writeNode<Schema extends Input, Result extends object>(name: string, description: string,
  parameters: ParameterSet, schema: Schema, act: (input: z.output<Schema>, reading: WriteReading) => WriteAct,
  run: (root: string, input: z.output<Schema>, context: Context) => Promise<Result>, requestLimit = DEFAULT_REQUEST_LIMIT) {
  const write = withRequestLimit(endpoint(name, parameters, 'POST', schema, run), requestLimit);
  writeActs.set(write.handler, (input, reading) => act(parseInput(schema, input), reading));
  return defineEntryNode({ name, description, endpoints: [write] });
}

const taskId = textParameter('task', 'Task ID');
const expectedTaskHash = textParameter('expectedTaskHash', 'Current Task SHA-256 hash');
const optionalText = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.string(), requirement: optional(),
});
const optionalNumber = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.positiveInteger(), requirement: optional(),
});
const flag = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.boolean(), requirement: optional(),
});
const json = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.define({ schema: z.json(), shape: { kind: 'string' } }), requirement: optional(),
});
const revision = (name: string, description: string) => defineParameter({
  name, description, codec: codecs.positiveInteger(), requirement: required(),
});
const quote = optionalText('quote', 'Words to record with this coordinator write');
const sourceRequest = optionalText('sourceRequest', 'Screen Request this write records, delivered to this Run');
const opId = optionalText('opId', 'Idempotency key');
const expectedPlacementRevision = optionalNumber('expectedPlacementRevision', 'Current placement revision');

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

const getNode = readNode('get', 'Read one Task with its values and placements; more only when asked',
  [taskId, optionalText('log', 'Latest log entries'),
    optionalText('runs', 'Latest Runs'),
    flag('files', 'Include the Task folder\'s files'), flag('usage', 'Include Run totals'),
    flag('estimateExamples', 'Include recent estimate outcomes'), flag('openObligations', 'Include open sent Requests and undisposed returns'),
    optionalText('question', 'Question ID')],
  taskGetInput, async (root, input, context) => {
    const { readScope } = authorizeRead(root, context, { name: 'task.read' }, input.task);
    return readTaskView(root, input.task, { log: input.log, runs: input.runs,
      files: input.files === true, usage: input.usage === true, estimateExamples: input.estimateExamples === true,
      question: input.question, openObligations: input.openObligations === true }, readScope);
  });
const listNode = readNode('list', 'Read the Task tree, or search Tasks with a matching excerpt',
  [optionalText('under', 'Subtree root Task ID'), optionalText('depth', 'Levels below --under'),
    optionalText('text', 'Search text'),
    defineParameter({ name: 'in', description: 'Additional search places', codec: codecs.stringList(), requirement: optional() }),
    optionalText('limit', 'Maximum matching Tasks'),
    defineParameter({ name: 'state', description: 'States to include', codec: codecs.stringList(), requirement: optional() }),
    flag('all', 'Include archived and deleted Tasks'), optionalText('kind', 'task or project')],
  taskListInput, async (root, input, context) => {
    const { readScope } = authorizeRead(root, context, { name: 'task.list' }, null);
    return readTaskListView(root, { under: input.under, depth: input.depth, text: input.text, in: input.in, limit: input.limit, state: input.state,
      all: input.all === true, kind: input.kind }, readScope);
  });
const returnsNode = readNode('returns', 'Read returns and their full identities without acknowledging them',
  [taskId, optionalText('after', 'Previous return ID'), optionalNumber('limit', 'Page size')],
  taskReturnsInput, async (root, input, context) =>
    readTaskReturns(root, input, authorizeRead(root, context, { name: 'task.read' }, input.task).readScope ?? undefined));

const newNode = writeNode('new', 'Create a Task, or a project, or sibling Tasks from a plan',
  [optionalText('title', 'Task title'), optionalText('kind', 'task or project'),
    optionalText('color', 'Required project color: #rrggbb, six lowercase hex digits'),
    optionalText('parent', 'Parent Task ID, or none for a top project'),
    optionalText('cwd', 'A project\'s code location on this PC'),
    optionalText('expectedParentHash', 'Current parent Task hash'), json('values', 'Field values by field ID'),
    optionalText('plan', 'Sibling Tasks as JSON'), flag('userRequested', 'Whether the user asked for it'), quote, sourceRequest],
  taskCreateInput, (input, { root, db, caller, cwd }) => ({
    action: commandAction('task.new', input),
    task: creationParent(root, db, input.parent, caller, cwd), quote: input.quote }),
  async (root, input, context) => {
    const parentId = readControl(root, db =>
      creationParent(root, db, input.parent, requireCaller(context), context.cwd ?? null));
    // taskCreateInput takes exactly one of --title and --plan-file.
    const { tasks } = await new ControlTaskCommands(root, requireActor(context)).create({ kind: input.kind, color: input.color, parentId,
      userRequested: input.userRequested ?? null, tasks: input.plan ?? [{ title: input.title!, values: input.values }],
      expectedParentHash: input.expectedParentHash });
    if (input.plan !== undefined) return { tasks };
    const task = tasks[0]!;
    if (input.cwd !== undefined) await writeProjectLocation(root, task.id, input.cwd, locationOperation(context));
    return { task };
  }, DOCUMENT_REQUEST_LIMIT);
const updateNode = writeNode('update', 'Change a Task\'s title, values or mark, or a project\'s code location or color',
  [taskId, optionalText('title', 'New title'), json('values', 'Changed field values by field ID; null clears one'),
    json('cwd', 'A project\'s code location on this PC; empty turns it off, null inherits'),
    optionalText('color', 'Project color: #rrggbb, six lowercase hex digits'),
    flag('userRequested', 'Whether the user asked for it'), quote, sourceRequest, expectedTaskHash],
  taskUpdateInput, input => taskAct('task.update', input),
  async (root, input, context) => {
    const { task } = await new ControlTaskCommands(root, requireActor(context)).update({ id: input.task,
      title: input.title, values: input.values, color: input.color, userRequested: input.userRequested,
      expectedTaskHash: input.expectedTaskHash });
    if (input.cwd !== undefined) await writeProjectLocation(root, input.task, input.cwd, locationOperation(context));
    return { task };
  }, DOCUMENT_REQUEST_LIMIT);
const reportNode = writeNode('report', 'Report a Task\'s state, ask its parent or the user, or withdraw a question',
  [optionalText('task', 'Task ID; a Run reports on its own Task when left out'), optionalText('state', 'New state'),
    optionalText('askTo', 'Question destination: ancestor Task ID or user'), optionalText('withdraw', 'Question ID to withdraw'), optionalText('title', 'Plain-text title'),
    optionalText('description', 'Description Markdown'), optionalText('urgent', 'Why the requester must read it now'),
    json('values', 'Changed field values saved with this owner report'),
    optionalText('nextConversation', 'new: prepare a new conversation for the next wake'),
    optionalText('aboutRun', 'The Run whose review it confirms'),
    optionalNumber('estimateMinutes', 'Remaining work estimate in minutes'), quote, sourceRequest, opId, expectedTaskHash,
    expectedPlacementRevision],
  taskReportInput, (input, { caller }) => {
    const task = reportedTask(input, caller);
    return { action: commandAction('task.report', input), task, quote: input.quote };
  },
  async (root, input, context) =>
    new TaskReportService(root).report(input, requireActor(context), requireCaller(context)),
  DOCUMENT_REQUEST_LIMIT);
const requestNode = writeNode('request', 'Ask a Task\'s responsible to work or answer its question',
  [taskId, textParameter('body', 'The instruction or answer'),
    optionalText('title', 'Task history note title'), optionalText('description', 'Task history note Markdown; requires title'),
    optionalText('answers', 'Question ID'),
    optionalText('agent', 'Member placement ID'),
    flag('newConversation', 'Begin a new conversation'), optionalText('cwd', 'Absolute launch directory'),
    optionalText('aiStack', 'AI stack as JSON'), optionalText('selected', 'Launch choices as JSON'), quote, sourceRequest, opId, optionalText('expectedTaskHash', 'Current Task hash'),
    expectedPlacementRevision, optionalText('expectedHeadRun', 'Expected conversation head')],
  taskRequestInput, (input, { root, db }) => {
    const answers = input.answers;
    if (answers === undefined) return taskAct('task.request', input, {
      worker: input.agent !== undefined && isWorker(root, db, input.task, input.agent) });
    // An answer goes to whom the question asked, fixed when it was asked.
    const question = replyQuestion(input.task, new TaskRepository(root, db).get(input.task).meta.log, answers);
    return taskAct('task.request', input, { askedTo: question.asked.askedTo, closed: question.closing !== null });
  },
  async (root, input, context) =>
    new TaskRequestService(root).request(input, requireActor(context), requireCaller(context)),
  LARGE_REQUEST_LIMIT);
const commentNode = writeNode('comment', 'Add a comment without changing Task state; urgent sends it to the requester now',
  [taskId, textParameter('title', 'Plain-text comment title'), optionalText('description', 'Description Markdown'),
    optionalText('urgent', 'Why the requester must read it now'), quote, sourceRequest, expectedTaskHash],
  taskCommentInput, input => taskAct('task.comment', input),
  async (root, input, context) => {
    const caller = requireCaller(context), actor = requireActor(context), id = operationId(context);
    return withControlWrite(root, (tx, db) => {
      comment(tx, { actor, runId: caller.kind === 'run' ? caller.runId : null,
        taskId: input.task, opId: id, expectedTaskHash: input.expectedTaskHash, title: input.title,
        description: input.description, urgentReason: input.urgent });
      return { task: controlTaskHead(new TaskRepository(root, db).get(input.task)) };
    });
  });
const dependencySetNode = writeNode('set', 'Replace a Task’s dependencies before its first start',
  [taskId, defineParameter({ name: 'after', description: 'Tasks that must finish first', codec: codecs.stringList(), requirement: required() }), expectedTaskHash, quote, sourceRequest, opId], dependencySetInput,
  input => taskAct('task.request', input),
  async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).dependencies(input));
const dependencyClearNode = writeNode('clear', 'Clear a Task’s dependencies before its first start',
  [taskId, expectedTaskHash, quote, sourceRequest, opId], dependencyClearInput,
  input => taskAct('task.request', input),
  async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).dependencies({ ...input, after: [] }));
const moveNode = writeNode('move', 'Change a Task\'s parent within its project without changing its ID or path',
  [taskId, textParameter('parent', 'New parent Task ID in the same project'), quote, sourceRequest, expectedTaskHash], taskMoveInput,
  (input, { root, db }) => {
    if (input.parent === 'none') return taskAct('task.move', input);
    const tasks = new TaskRepository(root, db), tree = new TaskTree(tasks.branch(tasks.projectFor(input.parent)));
    return taskAct('task.move', input, { to: [input.parent, ...tree.ancestors(input.parent).map(task => task.id)] });
  },
  async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).move({ id: input.task,
    parentId: input.parent === 'none' ? null : input.parent, expectedTaskHash: input.expectedTaskHash }));
const lifecycleNode = (action: 'archive' | 'delete' | 'restore') => writeNode(action,
  action === 'restore' ? 'Restore an archived or deleted Task' :
    `${action === 'archive' ? 'Archive' : 'Mark'} a Task ${action === 'delete' ? 'deleted; ' : 'and '}keep its files`,
  [taskId, quote, sourceRequest, expectedTaskHash], taskLifecycleInput,
  input => taskAct(`task.${action}`, input),
  async (root, input, context) =>
    new ControlTaskCommands(root, requireActor(context)).lifecycle({ id: input.task, action,
      expectedTaskHash: input.expectedTaskHash }));

/** A placement write answers with the placement and its Task as they now are. */
const placementReceipt = async <Agent>(root: string, agent: Agent, task: string) =>
  ({ agent, task: controlTaskHead(await new ControlTaskStore(root).get(task)) });
const assignNode = writeNode('assign', 'Assign a responsible agent or a member',
  [taskId, textParameter('role', 'responsible or member'), optionalText('person', 'Existing agent ID for a member'),
    optionalText('profile', 'Launch profile'), optionalText('selected', 'Initial launch choices as JSON'), optionalText('aiStack', 'AI stack as JSON'),
    expectedTaskHash, optionalText('replace', 'Responsible placement to replace'),
    optionalNumber('expectedPlacementRevision', 'Replacement revision'),
    optionalNumber('expectedResponsibleRevision', 'Current responsible revision'), quote, sourceRequest], agentAssignInput,
  input => taskAct('agent.assign', input),
  async (root, input, context) => {
    const commands = new PlacementCommands(root), actor = requireActor(context);
    const agent = input.role === 'responsible'
      ? await commands.placeNewResponsible({ taskId: input.task, profileKey: input.profile,
        selected: input.selected, aiStack: input.aiStack,
        expectedTaskHash: input.expectedTaskHash, replacePlacementId: input.replace,
        expectedPlacementRevision: input.expectedPlacementRevision }, actor)
      : await commands.placeMember({ taskId: input.task, agentId: input.person, profileKey: input.profile,
        selected: input.selected, aiStack: input.aiStack,
        expectedTaskHash: input.expectedTaskHash,
        expectedResponsibleRevision: responsibleRevision(input.expectedResponsibleRevision) }, actor);
    return placementReceipt(root, agent, input.task);
  });
const handoverNode = writeNode('handover', 'Transfer responsibility to an active placement',
  [taskId, textParameter('agent', 'Placement ID'), expectedTaskHash,
    revision('expectedPlacementRevision', 'Current placement revision'), quote, sourceRequest], agentHandoverInput,
  input => taskAct('agent.handover', input),
  async (root, input, context) => {
    const agent = await new PlacementCommands(root).setResponsible({ taskId: input.task, placementId: input.agent,
      expectedTaskHash: input.expectedTaskHash, expectedPlacementRevision: input.expectedPlacementRevision },
    requireActor(context));
    return placementReceipt(root, agent, input.task);
  });
const releaseNode = writeNode('release', 'End an idle placement without losing its history',
  [taskId, textParameter('agent', 'Placement ID'), expectedTaskHash,
    revision('expectedPlacementRevision', 'Current placement revision'),
    optionalNumber('expectedResponsibleRevision', 'Current responsible revision for a member'), quote, sourceRequest], agentReleaseInput,
  (input, { root, db }) => taskAct('agent.release', input, { worker: isWorker(root, db, input.task, input.agent) }),
  async (root, input, context) => {
    const commands = new PlacementCommands(root), actor = requireActor(context);
    const placement = { taskId: input.task, placementId: input.agent, expectedTaskHash: input.expectedTaskHash,
      expectedPlacementRevision: input.expectedPlacementRevision };
    // The same fact its act took for authorize: a member's release answers to the responsible's revision.
    const agent = readControl(root, db => isWorker(root, db, input.task, input.agent))
      ? await commands.releaseMember({ ...placement,
        expectedResponsibleRevision: responsibleRevision(input.expectedResponsibleRevision) }, actor)
      : await commands.release(placement, actor);
    return placementReceipt(root, agent, input.task);
  });

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
const runFilesNode = readNode('get', 'Read a bounded run prompt or result with explicit file status',
  [textParameter('run', 'Run ID'), optionalText('kind', 'result (default) or prompt')], runGetInput,
  async (root, input, context) => {
    authorizeRead(root, context, { name: 'task.read' }, readControl(root, db => runTask(root, db, input.run)));
    return readRunFiles(root, input.run, input.kind ?? 'result');
  });
const stopNode = writeNode('stop', 'Stop a Run and the Runs it called', [textParameter('run', 'Run ID'), quote, sourceRequest], runStopInput,
  (input, { root, db }) => ({ action: commandAction('run.stop', input), task: runTask(root, db, input.run), quote: input.quote }),
  async (root, input, context) => {
    const actor = requireActor(context);
    const { result } = requestStop(root, input, context.opId);
    for (const [taskId, runIds] of stoppedByTask(root, [...result.cancelled, ...result.stop_requested]))
      await new ControlTaskCommands(root, actor).recordRunStop({ id: taskId, runIds });
    return result;
  });

const schemaTaskParameter = optionalText('task', 'Task ID; left out, a Run\'s own Task, else the cwd rule\'s project');
const fieldGetNode = readNode('get', 'Read the JSON Schema of a Task\'s values, naming the project its fields come from',
  [optionalText('version', 'Previously read schema version'), schemaTaskParameter], fieldGetInput,
  async (root, input, context) => readSchema(root, schemaTask(root, input.task, context), input.version));
const fieldUseNode = writeNode('use', 'Choose the fields a project\'s Tasks use and their order, or inherit',
  [taskId, defineParameter({ name: 'fields', description: 'Field IDs in order', codec: codecs.stringList(), requirement: optional() }),
    flag('inherit', 'Use the nearest project above\'s fields'), quote, sourceRequest, expectedTaskHash],
  fieldUseInput, input => ({ action: { name: 'field.use' }, task: input.task, quote: input.quote }),
  async (root, input, context) => new ControlTaskCommands(root, requireActor(context)).setSchema({ task: input.task,
    fields: input.inherit ? null : input.fields!, expectedTaskHash: input.expectedTaskHash }));
const fieldListNode = readNode('list', 'Read the field definitions every project can use', [], emptyInput,
  async (root, _input, context) => { authorizeRead(root, context, { name: 'field.list' }, null); return listFields(root); });
const fieldSetNode = writeNode('set', 'Add a field definition or change one (a field that comes with the app changes only --required)',
  [textParameter('field', 'Field ID'), optionalText('title', 'Title'), optionalText('type', 'text or schema'),
    flag('many', 'A list of values'), flag('required', 'Needed before a done report'), json('maxChars', 'Target characters, or null'), json('maxItems', 'Target items, or null'),
    optionalText('hint', 'How to write the value'),
    defineParameter({ name: 'members', description: 'Member field IDs in order', codec: codecs.stringList(), requirement: optional() }),
    flag('create', 'Only add a new field: refuse an existing field ID'), quote, sourceRequest],
  fieldSetInput, input => ({ action: { name: 'field.set' }, task: null, quote: input.quote }),
  async (root, input) => setField(root, input, now()));
const fieldDeleteNode = writeNode('delete', 'Delete a field definition the workspace added, with its values',
  [textParameter('field', 'Field ID'), quote, sourceRequest], fieldDeleteInput,
  input => ({ action: { name: 'field.delete' }, task: null, quote: input.quote }),
  async (root, input) => deleteField(root, input.field));
const configGetNode = readNode('get', `Read limits and agents; optionally check executable and sign-in status in ${CONFIG_FILE}`,
  [optionalText('adapter', 'Adapter to inspect with command'), optionalText('command', 'Absolute executable path to inspect with adapter (version only)'),
    flag('check', `Check executable paths, versions and sign-in status (up to ${AGENT_CHECK_MS / 1000} seconds)`)], agentInspectionSchema,
  (root, input, context) => inspectServerSettings(root, input, context.agentInspection));
/** It keeps its own operation record (`journaled`): the receiver does not wrap it in a control write. */
const configSetNode = writeNode('set', `Save the screen's part of ${CONFIG_FILE}`,
  [textParameter('config', 'limits as YAML'), textParameter('agents', 'The agents block as written'),
    textParameter('expectedConfigHash', `Current ${CONFIG_FILE} hash`)], configSetInput,
  () => ({ action: { name: 'config.set' }, task: null }),
  (root, input, context) => saveServerSettings(root, input, context.opId, requireActor(context)), DOCUMENT_REQUEST_LIMIT);

/** The local CLI's: it makes the workspace a server runs in. */
const initEntry = defineEntry({ name: 'init', parameters: [], project: () => ({}) });
const initNode = defineEntryNode({ name: 'init', description: 'Create a new workspace (default ~/alpacawork); does not register a service',
  endpoints: [defineEntryEndpoint(initEntry, {
    handler: (input: unknown, context: Context) => {
      parseInput(emptyInput, input);
      requireAdmin(context, () => requireRoot(context));
      if (!context.cli) throw new Problem(PROBLEM_CODE.forbidden, 'init is only available from the local CLI', undefined,
        { reason: { kind: 'init_only_available_from_local_cli' } });
      return initializeInstallation({ explicit: context.root, ...context.cli });
    }, channels: [bindCliOptions(initEntry.parameters)] })] });
const workspaceReturnsNode = writeNode('returns', 'Retry returns and wakes', [], emptyInput,
  () => ({ action: { name: 'admin' }, task: null }), root => new ReturnRouter(root).pass());
/** A person's folder fields: HTTP only, with the same screen authorization for listing and making. */
const foldersNode = defineEntryNode({ name: 'folders',
  description: 'List the folders in a folder of this PC, for choosing a project\'s code location',
  endpoints: [withAct(endpoint('folders', [optionalText('path', 'Folder to list (absolute or ~/…)'),
    optionalText('prefix', 'Only names starting with this'), flag('hidden', 'Include hidden folders')], 'GET', foldersInput,
  async (root, input) => listFolders(root, input)), SCREEN)],
  children: [defineEntryNode({ name: 'new', description: 'Make one folder and choose it for a project',
    endpoints: [withAct(endpoint('new', [textParameter('path', 'Parent folder (absolute or ~/…)'),
      textParameter('name', 'New folder name')], 'POST', makeFolderInput,
      async (root, input) => makeFolder(root, input)), SCREEN)] })] });

const replyGetNode = readNode('get', "Read an answer referenced by this Run's messages",
  [textParameter('message', 'Reply source Request ID'), optionalNumber('from', 'First character (1-based)')], coordinatorReplyGetInput,
  async (root, input, context) => readControl(root, db => {
    const caller = requireCaller(context);
    if (caller.kind !== 'coordinator' || !mayReadReply(db, caller, input.message))
      throw new Problem(PROBLEM_CODE.forbidden, 'This Run does not reference that reply', undefined,
        { reason: { kind: 'reply_target_unavailable' } });
    return replyPage(replySource(db, caller.conversation, input.message), input.from);
  }));

export const commandGroups = {
  dependency: defineEntryNode({ name: 'dependency', description: 'Task execution order', children: [dependencySetNode, dependencyClearNode] }),
  coordinator: defineEntryNode({ name: 'coordinator', description: 'Coordinator references', children: [
    defineEntryNode({ name: 'reply', description: 'Referenced answers', children: [replyGetNode] })] }),
  task: defineEntryNode({ name: 'task', description: 'Task records and instructions',
    children: [getNode, listNode, newNode, updateNode, returnsNode, requestNode, reportNode, commentNode, moveNode,
      lifecycleNode('archive'), lifecycleNode('delete'), lifecycleNode('restore')] }),
  agent: defineEntryNode({ name: 'agent', description: 'People and placements',
    children: [assignNode, handoverNode, releaseNode] }),
  run: defineEntryNode({ name: 'run', description: 'Run results and stopping', children: [runFilesNode, stopNode] }),
  field: defineEntryNode({ name: 'field', description: 'The fields Tasks write: a Task\'s, a project\'s choice, the shared definitions',
    children: [fieldGetNode, fieldListNode, fieldUseNode, fieldSetNode, fieldDeleteNode] }),
  config: defineEntryNode({ name: 'config', description: `Server settings in ${CONFIG_FILE}`,
    children: [configGetNode, configSetNode] }),
  workspace: defineEntryNode({ name: 'workspace', description: 'Workspace operations',
    children: [initNode, workspaceReturnsNode, foldersNode] }),
} as const;
