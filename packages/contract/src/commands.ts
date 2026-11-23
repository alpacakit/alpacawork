import { uiLocales } from '@alpacawork/core/ui-language';
import { AGENT_CHECK_MS, agentInspectionInput } from './server-settings.js';
import { codecs, createOutputContract, defineEntry, defineEntryEndpoint, defineEntryNode, defineEntryTree, optional, required, verifyEntryOutput,
  type EntryChannelBinding, type EntryTreeDefinition, type EntryTreeEndpoint, type ErasedEntryDefinition, type ParameterSet } from '@alpacakit/channels';
import { bindHttpEntry, type HttpEntryBinding } from '@alpacakit/channels/http';
import { attachmentsPath, taskFilePath } from './task-file-route.js';
import { parseInput } from '@alpacawork/core';
import { commandPath, commandPrefix } from './command-path.js';
import { errorEntrySchema, problemReasonSchema } from './problem.js';
import { personalSettingsResponseSchema } from './personal-settings.js';
import { RESOLUTION_REASONS, RETURN_OUTCOMES } from './return-outcomes.js';
import { stopResponseSchema } from './run-contract.js';
import { beforeRestoreOperationSchema, unknownAfterRestoreOperationSchema } from './recovery.js';
import { attachmentResultSchema, placementSchema, startOrderSchema, taskLifecycleSchema, projectShelfInfoSchema, projectShelfSchema, taskPlanResultSchema, taskWriteResultSchema, taskReportResultSchema,
  taskRequestResultSchema, taskPlacementResultSchema, controlRunFilesSchema, workspaceUrlSchema } from './control-contract.js';
import { serverSettingsSchema } from './server-settings.js';
import { z } from 'zod';
import { coordinatorReplyGetInput } from './coordinator-contract.js';
import { fieldGetResultSchema, fieldListResultSchema, fieldSetResultSchema, fieldDeleteResultSchema, PROJECT_SCHEMA, PROJECT_SUMMARY } from './task-schema.js';
import { ESTIMATE_MINUTES, MAX_CONTROL_BODY, MAX_DETAIL_LENGTH, MAX_INSTRUCTION_BYTES } from '@alpacawork/raw/values';
import { digestSchema, REPORT_TITLE_GUIDE_WIDTH, REPORT_TITLE_MAX_WIDTH, reportStateSchema, runIdSchema, taskIdSchema,
  taskKindSchema, taskStateSchema } from './fields.js';
import {
  dependencySetInput, dependencyClearInput, taskReturnsInput, taskListInput, taskGetInput, taskCreateInput, taskUpdateInput, taskReportInput,
  taskRequestInput, taskCommentInput, taskMoveInput, taskLifecycleInput, agentAssignInput,
  agentHandoverInput, agentReleaseInput, runGetInput, runStopInput,
  fieldSetInput, configSetShape, emptyInput, personSettingsSetShape, fieldGetInput, fieldDeleteInput, fieldUseInput,
  fieldUseRules, taskGetIncludes, type InputRule,
  ruleHelp, taskListRules, taskCreateRules, taskUpdateRules, taskReportRules, taskRequestRules, agentAssignRules,
} from './inputs.js';

/** How an input is entered on the CLI. Its key is also the REST parameter name. */
export type CommandOption = {
  key: string;
  description: string;
  kind: 'text' | 'boolean' | 'number' | 'list' | 'file' | 'json';
  max?: number;
  jsonFile?: true;
  nullable?: true;
  jsonScalar?: true;
  queryCount?: true;
  local?: true;
};
export function commandFlag(option: Pick<CommandOption, 'key' | 'kind'>): string {
  return '--' + option.key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()) +
    (option.kind === 'file' ? '-file' : '');
}

export function commandRuleHelp(command: Command, showFlags = false): string[] {
  return ruleHelp(command.rules ?? [], key => {
    const option = showFlags && command.options.find(option => option.key === key);
    return option ? commandFlag(option) : key;
  });
}

const groups: Readonly<Record<string, string>> = {
  dependency: 'Task execution order',
  project: 'Project management',
  task: 'Tasks: read, plan, request work, report and record',
  'task file': 'Files in a Task folder',
  'task attachment': 'Files attached to a request',
  agent: 'The responsible and the members placed on a Task',
  run: 'Run results and stopping',
  coordinator: 'Coordinator conversation references',
  'coordinator reply': 'Answers referenced by the current Run’s messages',
  field: 'The fields Tasks write: read a Task\'s, choose a project\'s, define the ones every project shares',
  config: 'Server settings in config.yaml',
  settings: 'Display, notification and reply-language settings (one set per server)',
  workspace: 'Workspace operations',
  operation: 'What a write saved, by its op-id',
};

/** CLI write contract; server operation IDs remain mandatory. Offline stop-local has its own explicit UUID. */
export const cliWriteHelp = 'The CLI generates one random operation ID when --op-id is omitted. It resends only the same prepared request after an unknown save result, at most 3 writes within 65 seconds. Specify --op-id if you need to check after process loss; automatic IDs are not saved to disk. Failure detail includes the ID and check command. A new CLI invocation is a new operation.';

const option = (kind: CommandOption['kind']) =>
  (key: string, description: string, extra: Pick<CommandOption, 'nullable' | 'local' | 'jsonScalar' | 'queryCount'> = {}): CommandOption =>
    ({ key, description, kind, ...extra });
const text = option('text'), number = option('number'), boolean = option('boolean'), list = option('list'), json = option('json');
const file = (key: string, max: number, description: string, jsonFile?: true): CommandOption =>
  ({ key, description: `${description} (a UTF-8 file's absolute path, or - for stdin)`, kind: 'file', max, jsonFile });
const help = (...lines: string[]) => `\n${lines.join('\n')}`;
/** The agents block, as config get returns it and config set saves it. */
const agentsHelp = 'agents: profiles in order; a coordinator message that names no agent goes to the first enabled one. ' +
  'Each can set adapter (for another name), enabled, ' +
  'command (an absolute executable path without arguments; omit for server PATH, unavailable for bundled runtimes), ' +
  'params (candidate lists by key, first choice first; a leading - offers leaving the option out), ' +
  'env (additional variable names), without (model-specific keys to omit), and options. Omitted settings use the defaults of this version. ' +
  'Use [] for an empty candidate or environment list, and {} for an empty without map.';

/** The settings a person or the coordinator changes from the command line (settings get, settings set). */
const settingsHelp = `language: the screen's language (${uiLocales.join(', ')}). ai.language: the language the AI replies to the user in, ` +
  'a BCP 47 tag such as ja-JP, or null while none is chosen; the screen does not show it. ' +
  'The others are the screen\'s theme and notification choices, as settings get lists them.';

type CommandKind = 'read' | 'write' | 'run';
export type FileBinding = {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  query?: readonly string[];
  headers?: Readonly<Record<string, string>>;
  contentDigest?: string;
  body?: 'bytes';
  response?: 'bytes';
};
type CommandDetails = {
  help?: string;
  attachesDiffs?: 'description';
  rules?: readonly InputRule<never>[];
  output: z.ZodType;
  file?: FileBinding;
};
type Input = z.ZodObject;

function command<Schema extends Input>(kind: CommandKind, description: string, schema: Schema,
  options: CommandOption[], details: CommandDetails) {
  return { kind, description, schema, options, ...details };
}
const filePath = z.string().min(1).max(1024).refine(value =>
  !value.startsWith('/') && !value.includes('\\') &&
  value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
  'Safe Task-relative path required');
export const taskFileGetInput = z.object({ task: taskIdSchema, path: filePath });
export const taskFilePutInput = taskFileGetInput.extend({ expectedDigest: digestSchema.optional() });
export const attachmentInput = z.object({ task: taskIdSchema, requestId: z.string().min(1), name: z.string().min(1) });
export const attachmentMoveInput = z.object({ task: taskIdSchema, from: z.string().min(1), to: z.string().min(1) });

const taskId = text('task', 'Task ID (T<number>) or project ID (P<number>)');
const expectedTaskHash = text('expectedTaskHash', 'Current Task SHA-256 hash (task get)');
const placementRevision = number('expectedPlacementRevision', 'Current placement revision (task get)');
const quote = text('quote', 'Optional record of the user’s words; the server does not match them or use them as permission');
const sourceRequest = text('sourceRequest', 'Screen message ID this write records; its own or a message delivered to the current Run');
const fromUser = boolean('fromUser', 'Whether the user asked for this Task; only directly below a project, never a child Task');
const reportTitle = text('title', `Plain text, one line; aim for display width ${REPORT_TITLE_GUIDE_WIDTH} ` +
  `(wide=2, other=1), rejected above ${REPORT_TITLE_MAX_WIDTH}. Markdown is not rendered`);
/** A description counts characters, each at most 4 UTF-8 bytes. */
const descriptionFile = file('description', MAX_DETAIL_LENGTH * 4, 'Description Markdown: ' +
  'headings, paragraphs, line breaks, lists, quotes, tables, fenced code, bold, inline code, links and images');
/** Where a writer reads how to write a Task's values, and a project's own (no Task's schema names those). */
const TASK_VALUES_GUIDE = 'field get';
const PROJECT_VALUES_GUIDE = `${TASK_VALUES_GUIDE}; a project's own values, ${PROJECT_SCHEMA.join(' and ')}: field list`;
/** A write's values: only the fields it changes, as `guide` describes them. */
const valuesFile = (description: string, guide = TASK_VALUES_GUIDE) => file('values', MAX_CONTROL_BODY, `${description}: a JSON object of ` +
  `field ID to value; a field left out keeps its value, null clears it, a list is replaced whole (${guide})`, true);
const urgent = (what: string) => text('urgent', `Why the requester must read ${what} now (one line)`);
const schemaTask = text('task', 'Task ID; left out, a Run\'s own Task, else the project the cwd rule ' +
  '(alpacawork -h) gives, else the default schema');

const taskGetResultSchema = z.looseObject({
  task: z.looseObject({
    id: taskIdSchema, kind: taskKindSchema, parentId: taskIdSchema.nullable(), projectId: taskIdSchema,
    title: z.string(), state: taskStateSchema, baseState: taskStateSchema, hold: z.boolean(),
    lifecycle: taskLifecycleSchema, hash: digestSchema, folder: z.string(),
    values: z.record(z.string(), z.json()).optional(),
  }),
  shelf: projectShelfInfoSchema,
  agents: z.array(placementSchema),
  questions: z.array(z.looseObject({ id: z.string(), taskId: taskIdSchema, applicable: z.boolean() })),
  dependencies: startOrderSchema,
  errors: z.array(errorEntrySchema),
});
const operationResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('committed'), status: z.number().int(), body: z.json() }).strict(),
  z.object({ state: z.literal('committed_pending_delivery'), message: z.string() }).strict(),
  z.object({ state: z.enum(['not_found', 'needs_review', 'pending']) }).strict(),
  beforeRestoreOperationSchema, unknownAfterRestoreOperationSchema,
]);

const returnDeliverySchema = z.object({
  wakeRequestId: z.string(), reservedAt: z.string(), receivedAt: z.string().nullable(),
  consumedAt: z.string().nullable(), releasedAt: z.string().nullable(), releaseReason: z.string().nullable(),
}).strict();
const taskReturnsResultSchema = z.object({
  returns: z.array(z.object({
    id: z.string(), requestId: z.string().nullable(), outcome: z.enum(RETURN_OUTCOMES), toTaskId: taskIdSchema,
    boundaryRunId: runIdSchema.nullable(), causeLogId: z.string().nullable(), holdReason: z.string().nullable(),
    holdProblemReason: problemReasonSchema.nullable(), createdAt: z.string(),
    deliveries: z.array(returnDeliverySchema),
    resolution: z.object({ at: z.string(), reason: z.enum(RESOLUTION_REASONS) }).strict().nullable(),
    disposition: z.enum(['pending', 'carried', 'in_flight', 'disposed']),
    urgentReason: z.string().nullable(), receiptUnknown: z.boolean(),
  }).strict()),
  nextAfter: z.string().nullable(),
}).strict();
const workspaceReturnsSchema = z.object({
  acceptedRequestIds: z.array(z.string()),
  held: z.array(z.object({ taskId: taskIdSchema, reason: z.string(), project: taskIdSchema.optional() }).strict()),
}).strict();
const replyPageSchema = z.object({
  id: z.string(), answeredAt: z.string(), from: z.number().int().positive(), to: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(), text: z.string(), next: z.number().int().positive().nullable(),
}).strict();
const fileResultSchema = z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).strict();

const taskListResultSchema = z.object({
  tasks: z.array(z.object({
    id: taskIdSchema, kind: taskKindSchema, parentId: taskIdSchema.nullable(), lifecycle: taskLifecycleSchema,
    title: z.string(), state: taskStateSchema, summary: z.string().optional(),
    match: z.looseObject({
      kind: z.enum(['id', 'title', 'values', 'history', 'runs', 'files', 'work']),
      excerpt: z.string(), otherMatches: z.number().int().nonnegative(),
    }).optional(),
  }).strict()),
  errors: z.array(errorEntrySchema), omitted: z.number().int().positive().optional(), cursor: z.string().optional(),
}).strict();

const definitions = {
  'project/shelf': command('read', 'Read archived projects and their restore targets', emptyInput, [], { output: projectShelfSchema }),
  'task/list': command('read', 'Read the Task tree, or search Tasks with a matching excerpt', taskListInput, [
    text('under', 'Subtree root Task ID, listed first'),
    number('depth', 'Levels below --under (1 = direct children), or below the top', { queryCount: true }),
    text('text', 'Case-insensitive substring in ID, title or any value; all states unless --state is set'),
    list('in', 'Add search places (history, runs, files, work); repeatable or comma-separated. ' +
      'history: reports, questions, answers and requests (light); runs: results, never prompts (light); ' +
      'files: Task documents outside work/ (more I/O); work: documents under work/ (heaviest)'),
    number('limit', 'Maximum rows per page (default 100; includes ancestors)', { queryCount: true }),
    text('cursor', 'Cursor from the previous page, for the same filters'),
    list('state', `States to include (${[...taskStateSchema.options, 'all'].join(', ')}); repeatable or comma-separated`),
    boolean('all', 'Include archived and deleted Tasks'),
    text('kind', `Only Tasks of this kind (${taskKindSchema.options.join(' or ')}); their ancestors still lead the path`),
  ], { rules: taskListRules, output: taskListResultSchema, help: help(
    `Project rows show ${PROJECT_SUMMARY} as summary when it is set and the caller may read the project.`,
    'ID, title and values are always searched. Without --in no History, Requests, Runs or files are read.',
    'files/work: md, txt, json, csv, html up to 1 MiB each; node_modules is excluded.',
    'Each match shows one excerpt (about 80 characters), its source and other match count; ancestors have none.',
    'Unreadable sources appear in errors; extension/size exclusions are not errors.') }),
  'task/get': command('read', 'Read one Task with its values, placements, open questions and the Run under review; ' +
    'more only when asked', taskGetInput, [
    taskId,
    number('log', 'Latest log entries to include', { queryCount: true }),
    number('runs', 'Latest Runs to include', { queryCount: true }),
    list('include', `Additional data: ${taskGetIncludes.join(', ')}. agents includes inactive placements. Repeatable or comma-separated`),
    text('question', 'A question\'s ID: its full text as asked, whether it is open, answered, withdrawn or expired, ' +
      'and its answer\'s full text once answered'),
  ], { output: taskGetResultSchema }),
  'task/new': command('write', 'Create a Task, or a project, with optional field values; or sibling Tasks from a plan',
    taskCreateInput, [
      text('title', 'Task title'),
      text('color', 'Project color: required with --kind project; six lowercase hex digits #rrggbb'),
      text('kind', `${taskKindSchema.options.join(' or ')}; task when left out`),
      text('parent', 'Parent Task ID, or none for a top project; left out, the project the cwd rule ' +
        '(alpacawork -h) gives, refused when it gives none (a Run names it)'),
      text('cwd', 'A project\'s code location on this PC (absolute, or ~/…); empty turns it off'),
      text('expectedParentHash', 'Current parent Task SHA-256 hash'),
      valuesFile('Field values', PROJECT_VALUES_GUIDE),
      file('plan', MAX_CONTROL_BODY, 'Sibling Tasks made at once under the parent, with one mark: ' +
        'a JSON array of {"title", "values"?}', true),
      fromUser, quote, sourceRequest,
    ], { rules: taskCreateRules, output: z.union([taskWriteResultSchema, taskPlanResultSchema]), help: help(
      'A Run creates below its own Task, with --parent and --expected-parent-hash; its Tasks are internal.',
      'Only the parent Task’s responsible Run creates children; ask it for additional results with task request.',
      'A person\'s Task is the user\'s unless --no-from-user; the coordinator supplies --from-user or ' +
        '--no-from-user.',
      'The coordinator records the user’s words with --quote when creating a project for them.') }),
  'task/update': command('write', 'Change a Task\'s title or field values, a project\'s code location or color, or whether the ' +
    'user asked for the Task, in one save', taskUpdateInput, [
    taskId,
    text('title', 'New title'),
    valuesFile('Changed field values', PROJECT_VALUES_GUIDE),
    text('cwd', 'A project\'s code location on this PC (absolute, or ~/…); empty turns it off; null inherits', { nullable: true }),
    text('color', 'Project color: six lowercase hex digits #rrggbb; omitted keeps the current color'),
    fromUser, quote, sourceRequest, expectedTaskHash,
  ], { rules: taskUpdateRules, output: taskWriteResultSchema, help: help(
    '--quote records the user’s words; permission to carry out their decision is governed by the skill.',
    'A Task awaiting review turns internal only after it is confirmed or sent back.') }),
  'task/returns': command('read', 'Read returns and their full identities without acknowledging them',
    taskReturnsInput, [taskId, text('after', 'Previous return ID'), number('limit', 'Page size (1–200)')], { output: taskReturnsResultSchema }),
  'task/request': command('write', 'Ask a Task\'s responsible to work: an instruction (to a member with --agent), ' +
    'or an answer to its question (--answers)', taskRequestInput, [
    taskId,
    file('instruction', MAX_INSTRUCTION_BYTES, 'The instruction or answer'),
    text('answers', 'ID of the question this answers'),
    text('agent', 'Member placement receiving the instruction'),
    boolean('newConversation', 'Begin a new conversation'),
    text('cwd', 'Absolute launch directory for a new conversation (default: the code location on this PC ' +
      'that the Task\'s project sets or inherits, else the workspace root)'),
    json('selected', 'Launch choices as a JSON object: a candidate string, or null where the candidates begin with - (or none are written). A field left out ' +
      'keeps the conversation\'s value. Only a Request without --new-conversation to a placement with no Run yet takes its ' +
      'initial choice; any other new conversation, --new-conversation included, takes the first candidate'),
    json('aiStack', 'AI rows to use before the server stack, as JSON: [{"agent":"claude","values":{"model":"opus"}},"stop"]'),
    quote, sourceRequest, expectedTaskHash, placementRevision,
    text('expectedHeadRun', 'The target placement conversation head from task get agents.headRunId'),
  ], { rules: taskRequestRules, output: taskRequestResultSchema, help: help(
    'An answer takes no version. An answer to a question already answered or withdrawn goes to the Task as an ordinary instruction from the answerer (its outcome names the question); an expired question refuses it.',
    "An instruction uses the current Task hash and placement revision. An instruction accepted by the responsible withdraws the Task's old question or review and returns it to doing, including a late answer sent as an instruction. Member instructions do not reopen the responsible's work.") }),
  'task/report': command('write', 'Report a Task\'s state, ask an ancestor Task or the user a question (--state waiting --ask-to <Task ID>|user), or withdraw a question',
    taskReportInput, [
      text('task', 'Task ID; a Run reports on its own Task when left out'),
      text('state', `New state: ${reportStateSchema.options.join(', ')}`),
      text('askTo', 'Question destination: an ancestor Task ID or user (directly); required when a Run asks'),
      text('withdraw', 'ID of the question to withdraw'),
      reportTitle, descriptionFile,
      valuesFile('Changed field values, saved atomically with this owner report'),
      text('nextConversation', 'new: start the next conversation from these values after this Run succeeds'),
      urgent('this done report'),
      text('aboutRun', 'The Run whose review this done report confirms; omit for a Task snapshot review (task get)'),
      number('estimateMinutes', `Remaining work estimate in minutes (${ESTIMATE_MINUTES.min}–${ESTIMATE_MINUTES.max})`),
      quote, sourceRequest, expectedTaskHash, placementRevision,
    ], { attachesDiffs: 'description', rules: taskReportRules, output: taskReportResultSchema,
      help: help('Code containing git diff between commits automatically attaches the submitted diff.',
      'An owner completion report (--state done) requires --title and --description-file with nonblank text. Task values and attachments do not replace the summary. Confirming a review or returning a held Task needs neither.',
      'A Run asking on its own Task (--state waiting): --title and --description-file (its summary) required; the full ' +
        'question goes in the decide value, --ask-to <Task ID>|user chooses an ancestor Task or the user explicitly. Returning a Task held ' +
        'from review (--state waiting) needs neither.',
      "A new question withdraws this Task's open question; a Task has at most one awaited reply (a question or a review). A question asked while the Task waits for review returns it to doing.",
      'An own Run reporting doing resumes work and withdraws its old question or review; use task update to save only values. A done report also withdraws its own open question; open questions asked of this Task still keep it from finishing.',
      'Outside a Run, --state waiting submits a done Task requested by the user for review. ' +
        'It reviews the Task snapshot and creates no question or Run.',
      'Done: a Task the user asked for goes to review, any other is done; done on a Task awaiting review ' +
        'confirms it. A Run review requires --about-run and --expected-placement-revision; a Task snapshot review ' +
        'needs neither. Both require --expected-task-hash. Stopped stops the Task, its subtree and their Runs.',
      'Managers return a held Task with --state <current baseState>. This only removes hold; it does not confirm a review or resume a stopped Task. Own progress and questions preserve hold. Todo and error only return a hold. Holds preserve Runs, requests and children.',
      "For a multiline description: alpacawork task report ... --title 'Summary' --description-file - <<'EOF'",
      'Markdown description here',
      'EOF') }),
  'task/comment': command('write', 'Add a comment without changing Task state; --urgent sends it to the requester now',
    taskCommentInput, [taskId, reportTitle, descriptionFile, urgent('this comment'), quote, sourceRequest, expectedTaskHash],
    { attachesDiffs: 'description', output: taskWriteResultSchema, help: help('Code containing git diff between commits automatically attaches the submitted diff.') }),
  'dependency/set': command('write', 'Replace a Task’s dependencies before its first start', dependencySetInput,
    [taskId, list('after', 'Tasks that must finish first (comma-separated IDs)'), expectedTaskHash, quote, sourceRequest],
    { output: taskWriteResultSchema.extend({ dependencies: startOrderSchema }) }),
  'dependency/clear': command('write', 'Clear a Task’s dependencies before its first start', dependencyClearInput,
    [taskId, expectedTaskHash, quote, sourceRequest], { output: taskWriteResultSchema.extend({ dependencies: startOrderSchema }) }),
  'task/move': command('write', 'Change a Task\'s parent within its project without changing its ID or path', taskMoveInput,
    [taskId, text('parent', 'New parent Task ID in the same project'), quote, sourceRequest, expectedTaskHash], { output: taskWriteResultSchema }),
  'task/archive': command('write', 'Archive a Task and keep its files', taskLifecycleInput, [taskId, quote, sourceRequest, expectedTaskHash], { output: taskWriteResultSchema }),
  'task/delete': command('write', 'Mark a Task deleted; keep its files', taskLifecycleInput, [taskId, quote, sourceRequest, expectedTaskHash],
    { output: taskWriteResultSchema, help: help('The coordinator follows the skill’s approval rule and records the user’s words with --quote.') }),
  'task/restore': command('write', 'Restore an archived or deleted Task', taskLifecycleInput, [taskId, quote, sourceRequest, expectedTaskHash], { output: taskWriteResultSchema }),
  'task/file/get': command('read', 'Download a file of the Task folder', taskFileGetInput, [
    taskId, text('path', 'File path in the Task folder'), text('output', 'File to write; it must not exist yet', { local: true }),
  ], { output: fileResultSchema, file: { method: 'GET', path: taskFilePath, query: ['path'], response: 'bytes' } }),
  'task/file/put': command('write', 'Upload a file into the Task folder', taskFilePutInput, [
    taskId, text('path', 'File path in the Task folder'), text('file', 'Local file to upload', { local: true }),
    text('expectedDigest', 'SHA-256 of the file it replaces; left out, the path must be new'),
  ], { output: fileResultSchema.extend({ digest: digestSchema }), file: { method: 'PUT', path: taskFilePath, query: ['path'], headers: { expectedDigest: 'X-Alpacawork-Expected-Digest' }, contentDigest: 'X-Alpacawork-Content-Digest', body: 'bytes' } }),
  'task/attachment/put': command('write', 'Attach a file to a request, for its instruction to link',
    attachmentInput, [taskId, text('requestId', 'The request (its op-id) the file goes with'),
      text('name', 'File name'), text('file', 'Local file to attach', { local: true })],
    { output: attachmentResultSchema, file: { method: 'POST', path: attachmentsPath, query: ['requestId', 'name'], body: 'bytes' } }),
  'task/attachment/remove': command('write', 'Remove a file attached to a request', attachmentInput,
    [taskId, text('requestId', 'The request (its op-id) the file goes with'), text('name', 'File name')],
    { output: z.object({ removed: z.literal(true) }).strict() }),
  'task/attachment/move': command('write', 'Move the files attached to one request to another', attachmentMoveInput,
    [taskId, text('from', 'Request ID the files go with'), text('to', 'Request ID they are to go with')],
    { output: z.array(attachmentResultSchema) }),
  'agent/assign': command('write', 'Assign a responsible agent or a member', agentAssignInput, [
    taskId, text('role', 'responsible or member'), text('person', 'Existing agent ID for a member'),
    text('profile', 'Launch profile, defaulting to the first AI row'), json('selected', 'Initial launch choices as a JSON object: a candidate string, or null where the candidates begin with - (or none are written); ' +
      'only a Request without --new-conversation while the placement has no Run yet starts from them; ' +
      'any other new conversation, --new-conversation included, starts from the first candidates'),
    json('aiStack', 'AI rows to use for this placement before the server stack, as JSON, with an optional final "stop"'),
    expectedTaskHash, text('replace', 'Responsible placement to replace'),
    number('expectedPlacementRevision', 'Revision of the responsible placement it replaces'),
    number('expectedResponsibleRevision', 'Current responsible revision'), quote, sourceRequest,
  ], { rules: agentAssignRules, output: taskPlacementResultSchema }),
  'agent/handover': command('write', 'Transfer responsibility to an active placement; it learns the Task\'s state and open work',
    agentHandoverInput, [taskId, text('agent', 'Placement ID'), expectedTaskHash, placementRevision, quote, sourceRequest], { output: taskPlacementResultSchema }),
  'agent/release': command('write', 'End an idle placement without losing its history', agentReleaseInput, [
    taskId, text('agent', 'Placement ID'), expectedTaskHash, placementRevision,
    number('expectedResponsibleRevision', 'Current responsible revision when releasing a member'), quote, sourceRequest,
  ], { output: taskPlacementResultSchema, help: help('Releasing a member: --expected-responsible-revision required.',
    'A responsible is released only from a Task without children or work under way; replace any other ' +
      'by agent handover or agent assign --replace.') }),
  'run/get': command('read', 'Read a bounded run prompt or result with explicit file status', runGetInput,
    [text('run', 'Run ID'), text('kind', 'result (default) or prompt, the delivered start text')], { output: controlRunFilesSchema }),
  'run/stop': command('write', 'Stop a Run; task report --state stopped stops a Task with its subtree', runStopInput,
    [text('run', 'Run ID'), quote, sourceRequest], { output: stopResponseSchema }),
  'field/get': command('read', 'Read the shape of the values a Task writes, as JSON Schema: its fields in order, each with ' +
    'how to write it, naming the project the order comes from. A project\'s ID gives the fields of the Tasks in it; a project\'s own values ' +
    `(${PROJECT_SCHEMA.join(', ')}) are in field list. A field\'s definition is changed with field set`, fieldGetInput, [text('version', 'Previously read schema version'), schemaTask],
    { output: fieldGetResultSchema }),
  'field/use': command('write', 'Choose the fields a project\'s Tasks use and their order, or inherit the nearest project above\'s',
    fieldUseInput, [text('task', 'Project ID (P<number>) whose Tasks use these fields'),
      list('fields', 'Field IDs in order, system fields included (decide, user_instructions, conclusion, notes)'),
      boolean('inherit', 'Drop the project\'s own fields and use the nearest project above\'s'),
      quote, sourceRequest, expectedTaskHash], { rules: fieldUseRules, output: taskWriteResultSchema, help: help(
      'A field left out keeps its stored values; they show again when it comes back.') }),
  'field/list': command('read', 'Read every field definition, with where each is used: the fields projects choose for their Tasks, and ' +
    `a project\'s own values (${PROJECT_SCHEMA.join(', ')}). maxChars and maxItems are the size to aim for; a write is refused past about 1.3 times it`, emptyInput, [],
    { output: fieldListResultSchema }),
  'field/set': command('write', 'Add a field definition or change one; it changes for every project using it. A field that comes with the app changes only --required', fieldSetInput, [
    text('field', 'Field ID: lowercase letters, digits and _ starting with a letter'),
    text('title', 'Title shown to writers and on screen'), text('type', 'text or schema (an item of member fields)'),
    boolean('many', 'A list of values'),
    number('maxChars', 'A text\'s target characters, said in the description; a write is refused past about 1.3 times it. Use null for a schema', { nullable: true }),
    number('maxItems', 'A list\'s target items, said in the description; a write is refused past about 1.3 times it. Use null for a single value', { nullable: true }),
    text('hint', 'How to write the value besides its size: the JSON Schema description writers read, after the size words'),
    list('members', 'A schema field\'s member field IDs in order; the first, a single text, names each item'),
    boolean('required', 'Require a value before reporting done. ' +
      'It applies where a project\'s fields list the field, not to a member inside another field'),
    boolean('create', 'Only add a new field: refused when the field ID already exists'),
    quote, sourceRequest,
  ], { output: fieldSetResultSchema, help: help('A key left out keeps its current value; a new field needs --title and --type. With --create an existing ID is refused instead of changed.',
    'System fields keep their type; the question fields never change. A field with stored values keeps its type, list shape and members. Stored values are not rewritten: a new size applies to the next write.') }),
  'field/delete': command('write', 'Delete a field definition the workspace added, with its stored values', fieldDeleteInput,
    [text('field', 'Field ID'), quote, sourceRequest], {
      output: fieldDeleteResultSchema, help: help('A default field, or one a project or another field still uses, is refused.') }),
  'workspace/returns': command('write', 'Retry returns and wakes now', emptyInput, [], { output: workspaceReturnsSchema }),
  'workspace/url': command('read', 'Read the running workspace UI URL', emptyInput, [], { output: workspaceUrlSchema }),
  'config/get': command('read', 'Read saved limits, agents and AI stacks', emptyInput, [],
    { output: serverSettingsSchema, help: help(agentsHelp,
      'agentsText gives the YAML as written, agents gives effective values, and catalog gives adapter defaults.') }),
  'config/inspect': command('run', 'Check executable paths, versions and sign-in status', agentInspectionInput,
    [text('adapter', 'Adapter to inspect with --command'), text('command', 'Absolute executable path to inspect (version only)')],
    { output: serverSettingsSchema, help: help(
      `Host observations share a ${AGENT_CHECK_MS / 1000}-second deadline and are never saved. availability is keyed by profile and detected by adapter.`,
      'With --adapter codex --command /absolute/path/to/codex, inspected gives a version-only observation.',
      'If the response is lost, the result is unknown. The CLI never sends this command again automatically.') }),
  'config/set': command('write', 'Save the screen\'s part of config.yaml', configSetShape, [
    text('config', 'Limits and optional aiStack and coordinatorAiStack as YAML'), text('agents', 'The agents block as written'),
    text('expectedConfigHash', 'Current config.yaml hash'),
  ], { output: serverSettingsSchema, help: help(agentsHelp,
    'The agents block is saved as written. Delete a setting to follow the defaults in future updates.',
    'A new request or conversation uses the saved agents; a Run already accepted keeps the launch it was accepted with.') }),
  'settings/get': command('read', 'Read the shared settings and their revision', emptyInput, [],
    { output: personalSettingsResponseSchema, help: help(settingsHelp) }),
  'settings/set': command('write', 'Save one shared setting', personSettingsSetShape, [
    text('key', 'Setting key, as settings get lists it'),
    text('value', 'New value: text, true, false, or null', { jsonScalar: true }),
    text('expectedRevision', 'Current settings revision (settings get)'),
    text('timeZone', 'Browser time zone'),
  ], { output: personalSettingsResponseSchema, help: help(settingsHelp,
    'The values the server keeps itself (push.mutedUntil, push.quietResumedUntil) are refused. The screen shows a saved change at once.') }),
  'coordinator/reply/get': command('read', 'Read an answer referenced by a message delivered to the current screen Run (1,200 characters)', coordinatorReplyGetInput,
    [text('message', 'Reply source Request ID'), number('from', 'First character, starting at 1')], { output: replyPageSchema }),
  'operation/get': command('read', 'Read what a write saved, by its op-id', z.object({ opId: z.string().min(1) }),
    [text('opId', 'The --op-id the write was sent with')], { output: operationResultSchema }),
};

export type CommandName = keyof typeof definitions;
type ByteCommand = 'task/file/get' | 'task/file/put' | 'task/attachment/put';
export function byteBinding(id: ByteCommand): FileBinding {
  const binding = definitions[id].file;
  if (!binding) throw new Error(`Missing byte binding for ${id}`);
  return binding;
}
export type CommandInput<Name extends CommandName> = z.output<(typeof definitions)[Name]['schema']>;
export type CommandHandler<Context> = (input: Record<string, unknown>, context: Context) => unknown;
export type Command = ReturnType<typeof command> & {
  id: CommandName;
  words: readonly string[];
  path: string;
  method: 'GET' | 'POST' | 'PUT';
  access: string;
};

function compileCommand(id: CommandName): Command {
  const definition = definitions[id];
  const words = id.split('/');
  const { options } = definition;
  const access = id.startsWith('task/file/') || id.startsWith('task/attachment/')
    ? `task.${words.slice(1).join('-')}`
    : words.length === 2 ? words.join('.') : `${words.slice(0, -1).join(' ')}.${words.at(-1)}`;
  return { ...definition, id, words, options, access,
    path: definition.file?.path ?? commandPath(id),
    method: definition.file?.method ?? (definition.kind === 'read' ? 'GET' : 'POST') };
}

function parametersOf(command: Command): ParameterSet {
  return command.options.filter(option => !option.local).map(option => {
    const field = command.schema.shape[option.key];
    if (!field) throw new Error(`Missing field for ${command.id}: ${option.key}`);
    const codec = option.jsonFile || option.jsonScalar || option.nullable || option.kind === 'json'
      ? codecs.json(z.json())
      : option.kind === 'boolean' ? codecs.boolean()
      : option.kind === 'number' && !option.queryCount
        ? codecs.positiveInteger()
      : option.kind === 'list' ? codecs.stringList()
      : codecs.string();
    return { name: option.key, description: option.description, codec,
      requirement: field.isOptional() ? optional() : required() };
  });
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;

type CommandEndpoint<Context> = EntryTreeEndpoint<ErasedEntryDefinition, CommandHandler<Context>,
  readonly EntryChannelBinding<'http', HttpEntryBinding>[]>;
type Group<Context> = {
  readonly name: string;
  readonly description: string;
  readonly children: Map<string, Group<Context>>;
  readonly endpoints: CommandEndpoint<Context>[];
};
function group<Context>(name: string, description: string): Group<Context> {
  return { name, description, children: new Map(), endpoints: [] };
}
function nodeFor<Context>(group: Group<Context>): ReturnType<typeof defineEntryNode<readonly CommandEndpoint<Context>[]>> {
  const children = Array.from(group.children.values(), nodeFor<Context>);
  return defineEntryNode({ name: group.name, description: group.description, endpoints: group.endpoints, children });
}

/** One tree of entry definitions, with handlers supplied by the caller's adapter. */
type BoundCommand<Context> = Command & {
  handler: CommandHandler<Context>;
  parse: (values: Record<string, unknown>) => Record<string, unknown>;
};
export function commandTree<Context>(implement: (command: Command, verify: (value: unknown) => JsonValue) => CommandHandler<Context>):
  { tree: EntryTreeDefinition<CommandEndpoint<Context>>; cliRoot: ReturnType<typeof nodeFor<Context>>; commands: readonly BoundCommand<Context>[] } {
  const root = group<Context>('alpacawork', 'Task tree and agent runs');
  const commands = (Object.keys(definitions) as CommandName[]).map(compileCommand).map(command => {
    const parse = (values: Record<string, unknown>) => parseInput(command.schema, values) as Record<string, unknown>;
    const entry = defineEntry({
      name: command.words.at(-1)!,
      parameters: parametersOf(command),
      project: ({ values }) => parse(values),
      output: createOutputContract(command.output as z.ZodType<JsonValue>),
    });
    const handler = implement(command, value => verifyEntryOutput(entry, value as JsonValue));
    const endpoint = defineEntryEndpoint(entry, {
      handler,
      channels: command.file ? [] : [bindHttpEntry({ method: command.method })],
    });
    let parent = root;
    const path: string[] = [];
    for (const word of command.words) {
      path.push(word);
      let child = parent.children.get(word);
      if (!child) {
        const description = path.length === command.words.length ? command.description : groups[path.join(' ')];
        if (description === undefined) throw new Error(`Missing command group description for ${path.join(' ')}`);
        child = group<Context>(word, description);
        parent.children.set(word, child);
      }
      parent = child;
    }
    parent.endpoints.push(endpoint);
    return { ...command, handler, parse };
  });
  const logical = nodeFor(root);
  const http = defineEntryNode({ name: 'alpacawork', description: logical.description, children: [
    nodeFor({ ...root, name: commandPrefix }),
  ] });
  return { tree: defineEntryTree(http), cliRoot: logical, commands };
}

/** Metadata for callers that classify or construct command requests. */
export const commandCatalog = commandTree<never>(() => () => {
  throw new Error('The command catalog does not execute commands');
});
