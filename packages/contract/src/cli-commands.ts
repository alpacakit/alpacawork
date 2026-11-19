import { uiLocales } from '@alpacawork/core/ui-language';
import { AGENT_CHECK_MS, agentInspectionSchema } from './server-settings.js';
/** The ordinary CLI's wire commands and what -h says of them. The receiver can register these paths and schemas. */
import { z } from 'zod';
import { coordinatorReplyGetInput } from './coordinator-contract.js';
import { ESTIMATE_MINUTES, MAX_CONTROL_BODY, MAX_DETAIL_LENGTH, MAX_INSTRUCTION_BYTES } from '@alpacawork/raw/values';
import { digestSchema, REPORT_TITLE_GUIDE_WIDTH, REPORT_TITLE_MAX_WIDTH, reportStateSchema, taskIdSchema,
  taskKindSchema, taskStateSchema } from './fields.js';
import {
  dependencySetInput, dependencyClearInput, taskReturnsCliInput, taskListCliInput, taskGetCliInput, taskCreateCliInput, taskUpdateCliInput, taskReportCliInput,
  taskRequestCliInput, taskCommentInput, taskMoveInput, taskLifecycleInput, agentAssignCliInput,
  agentHandoverInput, agentReleaseInput, runGetInput, runStopInput,
  configSetShape, emptyInput, personSettingsSetInput, fieldGetInput, fieldSetCliInput, fieldDeleteInput, fieldUseInput,
  fieldUseRules,
  ruleHelp, taskListRules, taskCreateRules, taskUpdateRules, taskReportRules, taskRequestRules, agentAssignRules,
} from './inputs.js';

/**
 * One flag of a command. `key` is its name in camel case (`valuesFile` is `--values-file`); `wire` is the input key it
 * sends, when not `key`. The CLI reads it by `kind`: text `--key <value>` as written; number `--key <value>` as a
 * number; boolean `--key`, sending `value` (true when left out); list `--key <value>`, repeatable, as the list of its
 * comma-separated values; file `--key <path>`, the UTF-8 text of the file at that absolute path, or of stdin for `-`,
 * at most `max` bytes.
 */
export type CliOption = {
  key: string;
  description: string;
  kind: 'text' | 'boolean' | 'number' | 'list' | 'file';
  wire?: string;
  value?: boolean;
  max?: number;
};
export type CliCommand = {
  group: string;
  name: string;
  /** What the command does, as -h says. */
  description: string;
  /**
   * What -h shows after the options, from a blank line: the input rules (inputs' rule tables, `ruleHelp`) and the
   * server's rules a caller needs to know.
   */
  help?: string;
  method: 'GET' | 'POST';
  /** Path relative to the server origin. */
  path: string;
  /** Checks the input the CLI builds from its flags; its output is what the CLI sends. */
  schema: z.ZodType;
  options: readonly CliOption[];
  /** A server transaction or journal is required for this command. */
  mutation?: true;
  /** The command keeps its own operation record (it also writes config.yaml); the server does not wrap it. */
  journaled?: true;
  /** The CLI attaches commit diffs found in this Markdown input before preparing its immutable write. */
  attachesDiffs?: 'description';
  file?: 'get' | 'put' | 'attachment-put' | 'attachment-remove' | 'attachment-move';
};
/** The words the CLI actually registers, shared with safe activity classification. */
export function cliCommandWords(spec: CliCommand): string[] {
  const group = spec.file?.startsWith('attachment-') ? `${spec.group} attachment`
    : spec.file ? `${spec.group} file` : spec.group;
  const name = spec.file?.startsWith('attachment-') ? spec.file.slice('attachment-'.length) : spec.file || spec.name;
  return [...group.split(' '), name];
}
/** What -h says of each group, by the words the CLI shows before a command's name (`task file get`). */
export const cliGroups: Readonly<Record<string, string>> = {
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

const option = (kind: CliOption['kind']) =>
  (key: string, description: string, more: Pick<CliOption, 'wire' | 'value'> = {}): CliOption =>
    ({ key, description, kind, ...more });
const text = option('text'), number = option('number'), boolean = option('boolean'), list = option('list');
const file = (key: string, wire: string, max: number, description: string): CliOption =>
  ({ key, description: `${description} (a UTF-8 file's absolute path, or - for stdin)`, kind: 'file', wire, max });
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

const command = (group: string, name: string, method: 'GET' | 'POST', description: string, schema: z.ZodType,
  options: CliOption[], extra: Partial<CliCommand> = {}): CliCommand => ({
  group, name, method, description, path: `/api/${group}/${name}`, schema, options, ...extra,
});
const task = (name: string, description: string, schema: z.ZodType, options: CliOption[],
  extra: Partial<CliCommand> = {}) =>
  command('task', name, 'POST', description, schema, options, { mutation: true, ...extra });
const agent = (name: string, description: string, schema: z.ZodType, options: CliOption[],
  extra: Partial<CliCommand> = {}) =>
  command('agent', name, 'POST', description, schema, options, { mutation: true, ...extra });

const filePath = z.string().min(1).max(1024).refine(value =>
  !value.startsWith('/') && !value.includes('\\') &&
  value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
  'Safe Task-relative path required');
/** A Task file's URL, the same for every reader (CLI, screen, an agent's start text); no path names the Task's folder. */
export const taskFileRoute = (task: string, path = '') =>
  `/api/tasks/${encodeURIComponent(task)}/file?path=${encodeURIComponent(path)}`;
/** The reverse of `taskFileRoute`: the Task and path a URL of that route names; null for any other URL, or one with no path. */
export function parseTaskFileRoute(url: Pick<URL, 'pathname' | 'searchParams'>): { task: string; path: string } | null {
  const route = /^\/api\/tasks\/([^/]+)\/file$/.exec(url.pathname);
  const path = url.searchParams.get('path');
  if (!route || !path) return null;
  try { return { task: decodeURIComponent(route[1]!), path }; } catch { return { task: route[1]!, path }; }
}
export const taskFileGetInput = z.object({ task: taskIdSchema, path: filePath });
export const taskFilePutInput = taskFileGetInput.extend({ expectedDigest: digestSchema.optional() });
export const attachmentInput = z.object({ task: taskIdSchema, requestId: z.string().min(1), name: z.string().min(1) });
export const attachmentMoveInput = z.object({ task: taskIdSchema, from: z.string().min(1), to: z.string().min(1) });

const taskId = text('task', 'Task ID (T<number>) or project ID (P<number>)');
const expectedTaskHash = text('expectedTaskHash', 'Current Task SHA-256 hash (task get)');
const placementRevision = number('expectedPlacementRevision', 'Current placement revision (task get)');
const quote = text('quote', 'Optional record of the user’s words; the server does not match them or use them as permission');
const sourceRequest = text('sourceRequest', 'Screen message ID this write records; its own or a message delivered to the current Run');
const fromUser = boolean('fromUser', 'The user asked for this Task; only directly below a project, never a child Task', { wire: 'userRequested' });
const internal = boolean('internal', 'The agents\' own work, not a request of the user',
  { wire: 'userRequested', value: false });
const reportTitle = text('title', `Plain text, one line; aim for display width ${REPORT_TITLE_GUIDE_WIDTH} ` +
  `(wide=2, other=1), rejected above ${REPORT_TITLE_MAX_WIDTH}. Markdown is not rendered`);
/** A description counts characters, each at most 4 UTF-8 bytes. */
const descriptionFile = file('descriptionFile', 'description', MAX_DETAIL_LENGTH * 4, 'Description Markdown: ' +
  'headings, paragraphs, line breaks, lists, quotes, tables, fenced code, bold, inline code, links and images');
/** A write's values: only the fields it changes, as field get describes them. */
const valuesFile = (description: string) => file('valuesFile', 'values', MAX_CONTROL_BODY, `${description}: a JSON object of ` +
  'field ID to value; a field left out keeps its value, null clears it, a list is replaced whole (field get)');
const urgent = (what: string) => text('urgent', `Why the requester must read ${what} now (one line)`);
const schemaTask = text('task', 'Task ID; left out, a Run\'s own Task, else the project the cwd rule ' +
  '(alpacawork -h) gives, else the default schema');

export const cliCommands: readonly CliCommand[] = [
  command('project', 'shelf', 'GET', 'Read archived projects and their restore targets', emptyInput, []),
  command('task', 'list', 'GET', 'Read the Task tree, or search Tasks with a matching excerpt', taskListCliInput, [
    text('under', 'Subtree root Task ID, listed first'),
    text('depth', 'Levels below --under (1 = direct children), or below the top'),
    text('text', 'Case-insensitive substring in ID, title or any value; all states unless --state is set'),
    list('in', 'Add search places (history, runs, files, work); repeatable or comma-separated. ' +
      'history: reports, questions, answers and requests (light); runs: results, never prompts (light); ' +
      'files: Task documents outside work/ (more I/O); work: documents under work/ (heaviest)'),
    text('limit', 'Maximum matching Tasks (default 50); newest Task numbers win; omitted count is returned'),
    list('state', `States to include (${[...taskStateSchema.options, 'all'].join(', ')}); repeatable or comma-separated`),
    boolean('all', 'Include archived and deleted Tasks'),
    text('kind', `Only Tasks of this kind (${taskKindSchema.options.join(' or ')}); their ancestors still lead the path`),
  ], { help: help(...ruleHelp(taskListRules),
    'ID, title and values are always searched. Without --in no History, Requests, Runs or files are read.',
    'files/work: md, txt, json, csv, html up to 1 MiB each; node_modules is excluded.',
    'Each match shows one excerpt (about 80 characters), its source and other match count; ancestors have none.',
    'Unreadable sources appear in errors; extension/size exclusions are not errors.') }),
  command('task', 'get', 'GET', 'Read one Task with its values, placements, open questions and the Run under review; ' +
    'more only when asked', taskGetCliInput, [
    taskId,
    text('log', 'Latest log entries to include'),
    text('runs', 'Latest Runs to include'),
    boolean('files', 'Include files in the Task folder with their URLs'),
    boolean('usage', 'Include own and subtree token and elapsed Run totals'),
    boolean('estimateExamples', 'Include recent estimate outcomes for the current responsible Run conditions'),
    boolean('openObligations', 'Include open sent Requests with their text and undisposed returns from the same authoritative records'),
    text('question', 'A question\'s ID: its full text as asked, whether it is open, answered, withdrawn or expired, ' +
      'and its answer\'s full text once answered'),
  ]),
  task('new', 'Create a Task, or a project, with optional field values; or sibling Tasks from a plan',
    taskCreateCliInput, [
      text('title', 'Task title'),
      text('color', 'Project color: required with --kind project; six lowercase hex digits #rrggbb'),
      text('kind', `${taskKindSchema.options.join(' or ')}; task when left out`),
      text('parent', 'Parent Task ID, or none for a top project; left out, the project the cwd rule ' +
        '(alpacawork -h) gives, refused when it gives none (a Run names it)'),
      text('cwd', 'A project\'s code location on this PC (absolute, or ~/…); empty turns it off'),
      text('expectedParentHash', 'Current parent Task SHA-256 hash'),
      valuesFile('Field values'),
      file('planFile', 'plan', MAX_CONTROL_BODY, 'Sibling Tasks made at once under the parent, with one mark: ' +
        'a JSON array of {"title", "values"?}'),
      fromUser, internal, quote, sourceRequest,
    ], { help: help(...ruleHelp(taskCreateRules),
      'A Run creates below its own Task, with --parent and --expected-parent-hash; its Tasks are internal.',
      'Only the parent Task’s responsible Run creates children; ask it for additional results with task request.',
      'A person\'s Task is the user\'s unless --internal; the coordinator supplies --from-user or ' +
        '--internal.',
      'The coordinator records the user’s words with --quote when creating a project for them.') }),
  task('update', 'Change a Task\'s title or field values, a project\'s code location or color, or whether the ' +
    'user asked for the Task, in one save', taskUpdateCliInput, [
    taskId,
    text('title', 'New title'),
    valuesFile('Changed field values'),
    text('cwd', 'A project\'s code location on this PC (absolute, or ~/…); empty turns it off'),
    text('color', 'Project color: six lowercase hex digits #rrggbb; omitted keeps the current color'),
    fromUser, internal, quote, sourceRequest, expectedTaskHash,
  ], { help: help(...ruleHelp(taskUpdateRules),
    '--quote records the user’s words; permission to carry out their decision is governed by the skill.',
    'A Task awaiting review turns internal only after it is confirmed or sent back.') }),
  command('task', 'returns', 'GET', 'Read returns and their full identities without acknowledging them',
    taskReturnsCliInput, [taskId, text('after', 'Previous return ID'), text('limit', 'Page size (1–200)')]),
  task('request', 'Ask a Task\'s responsible to work: an instruction (to a member with --agent), ' +
    'or an answer to its question (--answers)', taskRequestCliInput, [
    taskId,
    file('instructionFile', 'body', MAX_INSTRUCTION_BYTES, 'The instruction or answer'),
    text('answers', 'ID of the question this answers'),
    text('agent', 'Member placement receiving the instruction'),
    boolean('newConversation', 'Begin a new conversation'),
    text('cwd', 'Absolute launch directory for a new conversation (default: the code location on this PC ' +
      'that the Task\'s project sets or inherits, else the workspace root)'),
    text('selected', 'Launch choices as a JSON object: a candidate string, or null where the candidates begin with - (or none are written). A field left out ' +
      'keeps the conversation\'s value. Only a Request without --new-conversation to a placement with no Run yet takes its ' +
      'initial choice; any other new conversation, --new-conversation included, takes the first candidate'),
    quote, sourceRequest, expectedTaskHash, placementRevision,
    text('expectedHeadRun', 'The target placement conversation head from task get agents.headRunId'),
  ], { help: help(...ruleHelp(taskRequestRules),
    'An answer takes no version. An answer to a question already answered or withdrawn goes to the Task as an ordinary instruction from the answerer (its outcome names the question); an expired question refuses it.',
    "An instruction uses the current Task hash and placement revision. An instruction accepted by the responsible withdraws the Task's old question or review and returns it to doing, including a late answer sent as an instruction. Member instructions do not reopen the responsible's work.") }),
  task('report', 'Report a Task\'s state, ask an ancestor Task or the user a question (--state waiting --ask-to <Task ID>|user), or withdraw a question',
    taskReportCliInput, [
      text('task', 'Task ID; a Run reports on its own Task when left out'),
      text('state', `New state: ${reportStateSchema.options.join(', ')}`),
      text('askTo', 'Question destination: an ancestor Task ID or user (directly); required when a Run asks'),
      text('withdraw', 'ID of the question to withdraw'),
      reportTitle, descriptionFile,
      valuesFile('Changed field values, saved atomically with this owner report'),
      text('nextConversation', 'new: start the next conversation from these values after this Run succeeds'),
      urgent('this done report'),
      text('aboutRun', 'The Run whose review this done report confirms; omit for a Task snapshot review (task get)'),
      number('estimate', `Remaining work estimate in minutes (${ESTIMATE_MINUTES.min}–${ESTIMATE_MINUTES.max})`,
        { wire: 'estimateMinutes' }),
      quote, sourceRequest, expectedTaskHash, placementRevision,
    ], { attachesDiffs: 'description', help: help('Code containing git diff between commits automatically attaches the submitted diff.', ...ruleHelp(taskReportRules),
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
  task('comment', 'Add a comment without changing Task state; --urgent sends it to the requester now',
    taskCommentInput, [taskId, reportTitle, descriptionFile, urgent('this comment'), quote, sourceRequest, expectedTaskHash],
    { attachesDiffs: 'description', help: help('Code containing git diff between commits automatically attaches the submitted diff.') }),
  command('dependency', 'set', 'POST', 'Replace a Task’s dependencies before its first start', dependencySetInput,
    [taskId, list('after', 'Tasks that must finish first (comma-separated IDs)'), expectedTaskHash, quote, sourceRequest], { mutation: true }),
  command('dependency', 'clear', 'POST', 'Clear a Task’s dependencies before its first start', dependencyClearInput,
    [taskId, expectedTaskHash, quote, sourceRequest], { mutation: true }),
  task('move', 'Change a Task\'s parent within its project without changing its ID or path', taskMoveInput,
    [taskId, text('parent', 'New parent Task ID in the same project'), quote, sourceRequest, expectedTaskHash]),
  task('archive', 'Archive a Task and keep its files', taskLifecycleInput, [taskId, quote, sourceRequest, expectedTaskHash]),
  task('delete', 'Mark a Task deleted; keep its files', taskLifecycleInput, [taskId, quote, sourceRequest, expectedTaskHash],
    { help: help('The coordinator follows the skill’s approval rule and records the user’s words with --quote.') }),
  task('restore', 'Restore an archived or deleted Task', taskLifecycleInput, [taskId, quote, sourceRequest, expectedTaskHash]),
  command('task', 'file-get', 'GET', 'Download a file of the Task folder', taskFileGetInput, [
    taskId, text('path', 'File path in the Task folder'), text('output', 'File to write; it must not exist yet'),
  ], { path: '/api/tasks/:task/file', file: 'get' }),
  command('task', 'file-put', 'POST', 'Upload a file into the Task folder', taskFilePutInput, [
    taskId, text('path', 'File path in the Task folder'), text('file', 'Local file to upload'),
    text('expectedDigest', 'SHA-256 of the file it replaces; left out, the path must be new'),
  ], { path: '/api/tasks/:task/file', file: 'put', mutation: true }),
  command('task', 'attachment-put', 'POST', 'Attach a file to a request, for its instruction to link',
    attachmentInput, [taskId, text('requestId', 'The request (its op-id) the file goes with'),
      text('name', 'File name'), text('file', 'Local file to attach')],
    { path: '/api/tasks/:task/attachments', file: 'attachment-put', mutation: true }),
  command('task', 'attachment-remove', 'POST', 'Remove a file attached to a request', attachmentInput,
    [taskId, text('requestId', 'The request (its op-id) the file goes with'), text('name', 'File name')],
    { path: '/api/tasks/:task/attachments', file: 'attachment-remove', mutation: true }),
  command('task', 'attachment-move', 'POST', 'Move the files attached to one request to another', attachmentMoveInput,
    [taskId, text('from', 'Request ID the files go with'), text('to', 'Request ID they are to go with')],
    { path: '/api/tasks/:task/attachments/move', file: 'attachment-move', mutation: true }),
  agent('assign', 'Assign a responsible agent or a member', agentAssignCliInput, [
    taskId, text('role', 'responsible or member'), text('person', 'Existing agent ID for a member'),
    text('profile', 'Launch profile'), text('selected', 'Initial launch choices as a JSON object: a candidate string, or null where the candidates begin with - (or none are written); ' +
      'only a Request without --new-conversation while the placement has no Run yet starts from them; ' +
      'any other new conversation, --new-conversation included, starts from the first candidates'),
    expectedTaskHash, text('replace', 'Responsible placement to replace'),
    number('expectedPlacementRevision', 'Revision of the responsible placement it replaces'),
    number('expectedResponsibleRevision', 'Current responsible revision'), quote, sourceRequest,
  ], { help: help(...ruleHelp(agentAssignRules)) }),
  agent('handover', 'Transfer responsibility to an active placement; it learns the Task\'s state and open work',
    agentHandoverInput, [taskId, text('agent', 'Placement ID'), expectedTaskHash, placementRevision, quote, sourceRequest]),
  agent('release', 'End an idle placement without losing its history', agentReleaseInput, [
    taskId, text('agent', 'Placement ID'), expectedTaskHash, placementRevision,
    number('expectedResponsibleRevision', 'Current responsible revision when releasing a member'), quote, sourceRequest,
  ], { help: help('Releasing a member: --expected-responsible-revision required.',
    'A responsible is released only from a Task without children or work under way; replace any other ' +
      'by agent handover or agent assign --replace.') }),
  command('run', 'get', 'GET', 'Read a bounded run prompt or result with explicit file status', runGetInput,
    [text('run', 'Run ID'), text('kind', 'result (default) or prompt, the delivered start text')]),
  command('run', 'stop', 'POST', 'Stop a Run; task report --state stopped stops a Task with its subtree', runStopInput,
    [text('run', 'Run ID'), quote, sourceRequest], { mutation: true }),
  command('field', 'get', 'GET', 'Read the shape of the values a Task writes, as JSON Schema: its fields in order, each with ' +
    'how to write it, naming the project the order comes from. A field\'s definition is changed with field set', fieldGetInput, [text('version', 'Previously read schema version'), schemaTask]),
  command('field', 'use', 'POST', 'Choose the fields a project\'s Tasks use and their order, or inherit the nearest project above\'s',
    fieldUseInput, [text('task', 'Project ID (P<number>) whose own fields these are'),
      list('fields', 'Field IDs in order, system fields included (decide, user_instructions, conclusion, notes)'),
      boolean('inherit', 'Drop the project\'s own fields and use the nearest project above\'s'),
      quote, sourceRequest, expectedTaskHash], { mutation: true, help: help(...ruleHelp(fieldUseRules),
      'A field left out keeps its stored values; they show again when it comes back.') }),
  command('field', 'list', 'GET', 'Read the field definitions every project can use, with where each is used', emptyInput, []),
  command('field', 'set', 'POST', 'Add a field definition or change one; it changes for every project using it. A field that comes with the app changes only --required', fieldSetCliInput, [
    text('field', 'Field ID: lowercase letters, digits and _ starting with a letter'),
    text('title', 'Title shown to writers and on screen'), text('type', 'text or schema (an item of member fields)'),
    text('many', 'true: a list of values; false: one value'),
    text('maxChars', 'A text\'s target characters, said in the description; a write is refused past about 1.3 times it. None for a schema'),
    text('maxItems', 'A list\'s target items, said in the description; a write is refused past about 1.3 times it. None for a single value'),
    text('hint', 'How to write the value besides its size: the JSON Schema description writers read, after the size words'),
    list('members', 'A schema field\'s member field IDs in order; the first, a single text, names each item'),
    text('required', 'true: a done report is refused while the field has no value; false: optional (the default). ' +
      'It applies where a project\'s fields list the field, not to a member inside another field'),
    boolean('create', 'Only add a new field: refused when the field ID already exists'),
    quote, sourceRequest,
  ], { mutation: true, help: help('A key left out keeps its current value; a new field needs --title and --type. With --create an existing ID is refused instead of changed.',
    'System fields keep their type; the question fields never change. A field with stored values keeps its type, list shape and members. Stored values are not rewritten: a new size applies to the next write.') }),
  command('field', 'delete', 'POST', 'Delete a field definition the workspace added, with its stored values', fieldDeleteInput,
    [text('field', 'Field ID'), quote, sourceRequest], { mutation: true,
      help: help('A default field, or one a project or another field still uses, is refused.') }),
  command('workspace', 'returns', 'POST', 'Retry returns and wakes now', emptyInput, [], { mutation: true }),
  command('workspace', 'url', 'GET', 'Read the running workspace UI URL', emptyInput, []),
  command('config', 'get', 'GET', 'Read limits and agents; optionally check executable and sign-in status', agentInspectionSchema,
    [text('adapter', 'Adapter to inspect with --command'), text('command', 'Absolute executable path to inspect (version only; requires --adapter)'),
      boolean('check', `Check executable paths, versions and sign-in status (up to ${AGENT_CHECK_MS / 1000} seconds)`)],
    { help: help(agentsHelp,
      'agentsText is the YAML as written, agents gives the effective values, and catalog gives the defaults for each adapter.',
      'Ordinary reads start no executables. Add --check for host observations. availability is keyed by profile; detected is keyed by adapter. Each has command, version, candidates (path and version on server PATH), status (ready, signed_out, unknown, not_found), nextAction and issue. Observations are fresh and never saved; all checks share one 10-second deadline without calling a model.',
      'With --check --adapter codex --command /absolute/path/to/codex, inspected returns a version-only observation for that path. Existing settings and accepted Runs are unchanged.') }),
  command('config', 'set', 'POST', 'Save the screen\'s part of config.yaml', configSetShape, [
    text('config', 'limits as YAML'), text('agents', 'The agents block as written'),
    text('expectedConfigHash', 'Current config.yaml hash'),
  ], { mutation: true, journaled: true, help: help(agentsHelp,
    'The agents block is saved as written. Delete a setting to follow the defaults in future updates.',
    'A new request or conversation uses the saved agents; a Run already accepted keeps the launch it was accepted with.') }),
  command('settings', 'get', 'GET', 'Read the shared settings and their revision', emptyInput, [],
    { help: help(settingsHelp) }),
  command('settings', 'set', 'POST', 'Save one shared setting', personSettingsSetInput, [
    text('key', 'Setting key, as settings get lists it'),
    text('value', 'New value: the text itself, true or false, or null for none'),
    text('expectedRevision', 'Current settings revision (settings get)'),
  ], { mutation: true, help: help(settingsHelp,
    'The values the server keeps itself (push.mutedUntil, push.quietResumedUntil) are refused. The screen shows a saved change at once.') }),
  command('coordinator reply', 'get', 'GET', 'Read an answer referenced by a message delivered to the current screen Run (1,200 characters)', coordinatorReplyGetInput,
    [text('message', 'Reply source Request ID'), number('from', 'First character, starting at 1')], { path: '/api/coordinator/reply/get' }),
  command('operation', 'get', 'GET', 'Read what a write saved, by its op-id', z.object({ opId: z.string().min(1) }),
    [text('opId', 'The --op-id the write was sent with')]),
];
