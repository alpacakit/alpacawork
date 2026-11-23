import { aiStackPrefixSchema } from './ai-stack.js';
import { selectionSchema } from './agent-settings.js';
/** Public entry values. Channels decode transport types; these schemas own input rules. */
import { z } from 'zod';
import { projectColorSchema } from '@alpacawork/raw/project-settings';
import { folderNameProblem } from './workspace-contract.js';
import { parseDocument } from 'yaml';
import { MAX_DOCUMENT } from '@alpacawork/raw/values';
import { descriptionSchema, reportTitleSchema, digestSchema, estimateMinutesSchema, instructionSchema,
  logIdSchema, quoteTextSchema, reportStateSchema, runIdSchema, taskIdSchema, projectIdSchema, taskKindSchema, taskStateSchema,
  titleSchema, urgentReasonSchema } from './fields.js';
import { runFileKindSchema } from './control-contract.js';
import { FIELD_TYPES, fieldIdSchema, valuesInputSchema } from './task-schema.js';
import { historyCursorSchema } from './history-events.js';
import { pushSubscriptionSchema } from './push-contract.js';
import { noticeStateSchema, pauseChoices, personalSettings, readSettingValue, validSetting, validSettingWrite, validTimeZone } from './personal-settings.js';
import { addAgentsIssues, configEditSchema } from './server-settings.js';

const nonempty = z.string().min(1);
const revision = z.number().int().positive();
const queryCount = z.union([z.number(), z.string().regex(/^[0-9]{1,9}$/).transform(Number)])
  .pipe(z.number().int().min(0).max(999999999));
const parent = z.union([taskIdSchema, z.literal('none')]);
const issue = (context: z.RefinementCtx, path: string, code: string, message: string) =>
  context.addIssue({ code: 'custom', path: [path], message, params: { kind: code } });
/** This PC's code location for a project Task: absolute, or from home (`~`, `~/…`); `''` turns it off. */
const projectCwd = z.string().trim().refine(value => value === '' || value.startsWith('/') || value === '~' || value.startsWith('~/'),
  { message: 'cwd must be an absolute path', params: { kind: 'absolute_path' } });
/** Input-only rules supply both validation issues and the command's help. */
type Keys<Value> = readonly [keyof Value & string, ...(keyof Value & string)[]];
export type InputRule<Value> =
  | { kind: 'required' | 'forbidden'; scope: string; applies: (value: Value) => boolean; keys: Keys<Value> }
  | { kind: 'one' | 'some'; keys: Keys<Value> };

const names = (keys: readonly string[], conjunction: 'and' | 'or', show: (key: string) => string) => keys.map(show)
  .reduce((text, key, index, all) => `${text}${index === all.length - 1 ? ` ${conjunction} ` : ', '}${key}`);
const identity = (key: string) => key;
const scopeText = (scope: string, show = identity) => scope.replace(/\{(\w+)\}/g, (_match, key: string) => show(key));
export function ruleHelp(rules: readonly InputRule<never>[], show = identity): string[] {
  return rules.map(rule => {
    switch (rule.kind) {
      case 'required': return `${scopeText(rule.scope, show)}, supply ${names(rule.keys, 'and', show)}.`;
      case 'forbidden': return `${scopeText(rule.scope, show)}, omit ${names(rule.keys, 'or', show)}.`;
      case 'one': return `Exactly one of ${names(rule.keys, 'or', show)}.`;
      case 'some': return `Supply ${names(rule.keys, 'or', show)}.`;
    }
  });
}
function checkRules<Value>(value: Value, context: z.RefinementCtx, rules: readonly InputRule<Value>[]): void {
  for (const rule of rules) {
    const given = rule.keys.filter(key => value[key] !== undefined);
    switch (rule.kind) {
      case 'required':
        if (rule.applies(value)) for (const key of rule.keys) if (value[key] === undefined)
          issue(context, key, 'required', `${key} is required (${scopeText(rule.scope)})`);
        break;
      case 'forbidden':
        if (rule.applies(value)) for (const key of given)
          issue(context, key, 'incompatible', `${key} is not allowed (${scopeText(rule.scope)})`);
        break;
      case 'one':
        if (given.length !== 1) issue(context, given[1] ?? rule.keys[0], 'exactly_one',
          `Supply exactly one of ${names(rule.keys, 'or', identity)}`);
        break;
      case 'some':
        if (!given.length) issue(context, rule.keys[0], 'required', `Supply ${names(rule.keys, 'or', identity)}`);
        break;
    }
  }
}

export const taskGetIncludes = [
  'agents', 'fields', 'closedQuestions', 'files', 'usage', 'estimateExamples', 'openObligations',
] as const;
export type TaskGetInclude = typeof taskGetIncludes[number];
export const taskGetInput = z.object({ task: taskIdSchema, log: queryCount.optional(), runs: queryCount.optional(),
  include: z.array(z.enum(taskGetIncludes)).optional(), question: logIdSchema.optional() }).strict();
export const taskListShape = z.object({ under: taskIdSchema.optional(), depth: queryCount.optional(),
  text: z.string().optional(), state: z.array(z.union([taskStateSchema, z.literal('all')])).optional(),
  all: z.boolean().optional(), kind: taskKindSchema.optional() });
export const taskSearchPlaceSchema = z.enum(['history', 'runs', 'files', 'work']);
export type TaskSearchPlace = z.infer<typeof taskSearchPlaceSchema>;
const searchOptions = { in: z.array(taskSearchPlaceSchema).min(1).optional(),
  limit: queryCount.pipe(z.number().min(1).max(10000)).optional(), cursor: z.string().min(1).max(1024).optional() };
export const taskListRules: readonly InputRule<{ text?: string; in?: unknown }>[] = [
  { kind: 'forbidden', scope: 'Without {text}', applies: value => !value.text, keys: ['in'] },
];
export const taskListInput = taskListShape.extend(searchOptions).strict().superRefine((value, context) => checkRules(value, context, taskListRules));
/**
 * One Task's fields, as a form picks them. Without a parent the server picks one from where the person works. Only a
 * project may be at the top (`none`) and name this PC's code location (`cwd`); without one it inherits its parent
 * project's. `fromUser` is --from-user (true) or --no-from-user (false); left out, the server marks it by who
 * creates it. `quote` records the user's words; `sourceRequest` attributes a screen write to a delivered message.
 */
const writeRecordShape = { quote: quoteTextSchema.optional(), sourceRequest: z.string().min(1).max(128).optional() };
export const taskCreateShape = z.object({ title: titleSchema, kind: taskKindSchema.optional(), parent: parent.optional(),
  cwd: projectCwd.optional(), color: projectColorSchema.optional(), values: valuesInputSchema.optional(),
  expectedParentHash: digestSchema.optional(), fromUser: z.boolean().optional(), ...writeRecordShape });
/** --plan-file: sibling Tasks made in one operation under one parent, with one mark; each is a title and its values. */
const taskPlan = z.array(z.object({ title: titleSchema, values: valuesInputSchema.optional() }).strict()).min(1);
/** The command takes one Task's title, or a plan in its place. */
const taskCreateFields = taskCreateShape.extend({ title: titleSchema.optional() });
type CreateChecks = z.output<typeof taskCreateFields> & { plan?: unknown };
export const taskCreateRules: readonly InputRule<CreateChecks>[] = [
  { kind: 'required', scope: 'With {kind} project', applies: value => value.kind === 'project',
    keys: ['color'] },
  { kind: 'one', keys: ['title', 'plan'] },
  { kind: 'forbidden', scope: 'With {plan}', applies: value => value.plan !== undefined,
    keys: ['values'] },
  { kind: 'forbidden', scope: 'With {kind} project', applies: value => value.kind === 'project',
    keys: ['plan', 'fromUser'] },
];
function checkTaskCreate(value: CreateChecks, context: z.RefinementCtx): void {
  checkRules(value, context, taskCreateRules);
  if (value.kind === 'project') return;
  if (value.parent === 'none') issue(context, 'parent', 'project_only', 'Only a project can be created without a parent');
  if (value.color !== undefined) issue(context, 'color', 'project_only', 'Only a project has color');
  if (value.cwd !== undefined) issue(context, 'cwd', 'project_only', 'Only a project has a cwd');
}
export const taskCreateInput = taskCreateFields.extend({ plan: taskPlan.optional() }).superRefine(checkTaskCreate);
/** A project's cwd: null drops its own, so it inherits its parent project's. */
export const taskUpdateShape = z.object({ task: taskIdSchema, title: titleSchema.optional(),
  values: valuesInputSchema.optional(), color: projectColorSchema.optional(), cwd: projectCwd.nullable().optional(),
  fromUser: z.boolean().optional(), ...writeRecordShape, expectedTaskHash: digestSchema });
export const taskUpdateRules: readonly InputRule<z.output<typeof taskUpdateShape>>[] = [
  { kind: 'some', keys: ['title', 'values',
    'cwd', 'color', 'fromUser'] },
];
const checkTaskUpdate = (value: z.output<typeof taskUpdateShape>, context: z.RefinementCtx) =>
  checkRules(value, context, taskUpdateRules);
export const taskUpdateInput = taskUpdateShape.superRefine(checkTaskUpdate);
export const taskMoveShape = z.object({ task: taskIdSchema, parent, ...writeRecordShape, expectedTaskHash: digestSchema });
export const taskMoveInput = taskMoveShape;
export const taskLifecycleInput = z.object({ task: taskIdSchema, ...writeRecordShape, expectedTaskHash: digestSchema });

export const taskReturnsInput = z.object({ task: taskIdSchema, after: z.string().optional(), limit: z.number().int().min(1).max(200).optional() });
/**
 * task report: the Task's state, a question (--state waiting), or a question's withdrawal. Without `task` a Run reports
 * on its own Task. `urgent` is why a done report goes to the requester now; `aboutRun` the Run whose review a done
 * report confirms.
 */
export const taskReportShape = z.object({ task: taskIdSchema.optional(), state: reportStateSchema.optional(),
  askTo: z.union([z.literal('user'), taskIdSchema]).optional(), withdraw: logIdSchema.optional(), title: reportTitleSchema.optional(), description: descriptionSchema.optional(),
  urgent: urgentReasonSchema.optional(), aboutRun: runIdSchema.optional(),
  values: valuesInputSchema.optional(), nextConversation: z.literal('new').optional(),
  estimateMinutes: estimateMinutesSchema.optional(), ...writeRecordShape,
  expectedTaskHash: digestSchema, expectedPlacementRevision: revision.optional() });
/**
 * What a report's input alone decides. A question's --title and --description-file are the server's to require: the
 * same --state waiting returns a Task held from review, which needs neither. So are where a done report goes, the state
 * a held Task returns to, an urgent report's requester (refused when it is the user) and who may report.
 */
export const taskReportRules: readonly InputRule<z.output<typeof taskReportShape>>[] = [
  { kind: 'forbidden', scope: 'Other than {state} waiting', applies: value => value.state !== 'waiting',
    keys: ['askTo'] },
  { kind: 'required', scope: 'With {nextConversation}', applies: value => value.nextConversation !== undefined,
    keys: ['values'] },
  { kind: 'forbidden', scope: 'Other than an owner doing, waiting or done report',
    applies: value => value.withdraw !== undefined || value.aboutRun !== undefined || !['doing', 'waiting', 'done'].includes(value.state ?? ''),
    keys: ['values', 'nextConversation'] },
  { kind: 'one', keys: ['state', 'withdraw'] },
  { kind: 'required', scope: 'With {description}', applies: value => value.description !== undefined,
    keys: ['title'] },
  { kind: 'forbidden', scope: 'With {withdraw}', applies: value => value.withdraw !== undefined,
    keys: ['title', 'description'] },
  { kind: 'forbidden', scope: 'Other than {state} done', applies: value => value.state !== 'done',
    keys: ['urgent', 'aboutRun'] },
  { kind: 'required', scope: 'With {aboutRun}', applies: value => value.aboutRun !== undefined,
    keys: ['expectedPlacementRevision'] },
  { kind: 'forbidden', scope: 'With {state} done or {withdraw}',
    applies: value => value.state === 'done' || value.withdraw !== undefined,
    keys: ['estimateMinutes'] },
];
export const taskReportInput = taskReportShape.superRefine((value, context) =>
  checkRules(value, context, taskReportRules));
/**
 * task request: an instruction to the Task's responsible (or, with `agent`, a member), or an answer to its
 * question (`answers`), all in `instruction`. Revisions are shared with the answer path, never an alias.
 */
export const taskRequestShape = z.object({ task: taskIdSchema, instruction: instructionSchema, answers: logIdSchema.optional(),
  agent: nonempty.optional(), newConversation: z.boolean().optional(),
  cwd: nonempty.optional(), selected: selectionSchema.optional(), aiStack: aiStackPrefixSchema.optional(), ...writeRecordShape,
  expectedTaskHash: digestSchema.optional(), expectedPlacementRevision: revision.optional(),
  expectedHeadRun: runIdSchema.optional() });
type RequestChecks = Omit<z.output<typeof taskRequestShape>, 'selected' | 'aiStack'> & { selected?: unknown; aiStack?: unknown };
/** What a request's input alone decides; the question's asker, the review and who may request are the server's. */
export const taskRequestRules: readonly InputRule<RequestChecks>[] = [
  { kind: 'forbidden', scope: 'With {answers}', applies: value => value.answers !== undefined,
    keys: ['agent', 'newConversation',
      'cwd', 'selected', 'aiStack', 'expectedHeadRun',
      'expectedTaskHash', 'expectedPlacementRevision'] },
  { kind: 'required', scope: 'Without {answers}', applies: value => value.answers === undefined, keys: ['expectedTaskHash'] },
  { kind: 'required', scope: 'Without {answers}', applies: value => value.answers === undefined,
    keys: ['expectedPlacementRevision'] },
];
const checkTaskRequest = (value: RequestChecks, context: z.RefinementCtx) => checkRules(value, context, taskRequestRules);
export const taskRequestInput = taskRequestShape.strict().superRefine(checkTaskRequest);
/** `urgent` is why the comment goes to the requester now. */
export const taskCommentInput = z.object({ task: taskIdSchema, title: reportTitleSchema,
  description: descriptionSchema.optional(), urgent: urgentReasonSchema.optional(), ...writeRecordShape,
  expectedTaskHash: digestSchema });

export const agentAssignShape = z.object({ task: taskIdSchema, role: z.enum(['responsible', 'member']),
  person: nonempty.optional(), profile: nonempty.optional(), selected: selectionSchema.optional(), aiStack: aiStackPrefixSchema.optional(), ...writeRecordShape,
  expectedTaskHash: digestSchema, replace: nonempty.optional(),
  expectedPlacementRevision: revision.optional(), expectedResponsibleRevision: revision.optional() });
const replaceKeys = ['replace', 'expectedPlacementRevision'] as const;
type AssignChecks = Omit<z.output<typeof agentAssignShape>, 'selected' | 'aiStack'> & { selected?: unknown; aiStack?: unknown };
export const agentAssignRules: readonly InputRule<AssignChecks>[] = [
  { kind: 'required', scope: 'Replacing a responsible', applies: value => value.role === 'responsible' &&
    (value.replace !== undefined || value.expectedPlacementRevision !== undefined), keys: replaceKeys },
  { kind: 'forbidden', scope: 'With {role} responsible', applies: value => value.role === 'responsible',
    keys: ['person', 'expectedResponsibleRevision'] },
  { kind: 'required', scope: 'With {role} member', applies: value => value.role === 'member',
    keys: ['expectedResponsibleRevision'] },
  { kind: 'forbidden', scope: 'With {role} member', applies: value => value.role === 'member', keys: replaceKeys },
];
export const agentAssignInput = agentAssignShape.superRefine((value, context) =>
  checkRules(value, context, agentAssignRules));
export const agentHandoverInput = z.object({ task: taskIdSchema, agent: nonempty,
  ...writeRecordShape, expectedTaskHash: digestSchema, expectedPlacementRevision: revision });
export const agentReleaseInput = agentHandoverInput.extend({ expectedResponsibleRevision: revision.optional() });

export const runGetInput = z.object({ run: runIdSchema, kind: runFileKindSchema.optional() });
/** run stop stops one Run; a Task with its subtree stops by task report --state stopped. */
export const runStopInput = z.object({ run: runIdSchema, ...writeRecordShape });
/**
 * field get: the schema a Task uses (its nearest project's, inherited where that has none of its own); `version` held
 * from an earlier read omits an unchanged schema.
 */
export const fieldGetInput = z.object({ version: z.string().optional(), task: taskIdSchema.optional() });
/**
 * field set: one field's definition; a key left out keeps the current value (a new field needs title and type). The
 * server merges and checks the whole definition (contract fieldDefSchema) and the catalog it makes.
 */
export const fieldSetShape = z.object({ field: fieldIdSchema, title: z.string().optional(), type: z.enum(FIELD_TYPES).optional(),
  many: z.boolean().optional(), maxChars: z.number().int().positive().nullable().optional(),
  maxItems: z.number().int().positive().nullable().optional(), hint: z.string().optional(),
  members: z.array(fieldIdSchema).optional(), required: z.boolean().optional(),
  /** Only add: a field ID the workspace already has is refused (field_exists) rather than changed. */
  create: z.boolean().optional(), ...writeRecordShape });
export const fieldSetInput = fieldSetShape;
export const fieldDeleteInput = z.object({ field: fieldIdSchema, ...writeRecordShape });
/** field use: a project's own fields in order (system fields included), or --inherit to drop its own. */
export const fieldUseShape = z.object({ task: taskIdSchema, fields: z.array(fieldIdSchema).min(1).optional(),
  inherit: z.boolean().optional(), ...writeRecordShape, expectedTaskHash: digestSchema });
export const fieldUseRules: readonly InputRule<z.output<typeof fieldUseShape>>[] = [
  { kind: 'one', keys: ['fields', 'inherit'] },
];
export const fieldUseInput = fieldUseShape.superRefine((value, context) => checkRules(value, context, fieldUseRules));
export const emptyInput = z.object({});

export const configSetShape = z.object({ config: z.string(), agents: z.string(), expectedConfigHash: digestSchema });
/**
 * A folder to list (absolute, or `~` and below); none lists where projects' code usually is. `prefix` keeps the names
 * starting with it (any case); hidden folders on request.
 */
export const foldersInput = z.object({ path: z.string().trim().optional(), prefix: z.string().optional(),
  hidden: z.boolean().optional() });
export const makeFolderInput = z.object({ path: z.string().trim(), name: z.string().trim().refine(name => !folderNameProblem(name),
  { message: 'This folder name cannot be used', params: { kind: 'folder_name' } }) });
export const configSetInput = configSetShape.transform((value, context) => {
  const bytes = new TextEncoder().encode(value.config).length + new TextEncoder().encode(value.agents).length;
  if (bytes > MAX_DOCUMENT) issue(context, '', 'too_big', 'Settings must be at most 1 MiB');
  let edit: z.output<typeof configEditSchema> | undefined;
  try {
    const document = parseDocument(value.config, { uniqueKeys: true });
    for (const problem of [...document.errors, ...document.warnings])
      issue(context, '', 'yaml', problem.message);
    if (!document.errors.length && !document.warnings.length) {
      const parsed = configEditSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
      if (parsed.success) edit = parsed.data;
      else for (const problem of parsed.error.issues) context.addIssue({ ...problem });
    }
  } catch (error) {
    issue(context, '', 'yaml', error instanceof Error ? error.message : 'Invalid YAML');
  }
  addAgentsIssues(value.agents, context);
  return edit === undefined ? z.NEVER : { ...value, edit };
});
export type ConfigSetValues = z.output<typeof configSetInput>;
export const validTaskFileName = (name: string): boolean =>
  !!name && !name.startsWith('/') && name.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && !part.includes('\0'));
export const taskFileInput = z.object({ task: taskIdSchema,
  name: nonempty.refine(validTaskFileName, 'Invalid task file path') });
/** Browser-facing host[:port], without a scheme or path. */
export const PUBLIC_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?$/;
export const serveInput = z.object({ port: z.string().transform(Number).pipe(z.number().int().min(0).max(65535)),
  'public-host': z.string().regex(PUBLIC_HOST_PATTERN).optional(), timing: z.boolean().optional(), mcp: z.boolean().optional() });
export const pushSubscribeInput = z.object({ subscription: pushSubscriptionSchema,
  label: z.string().min(1).max(80) });
export const pushUnsubscribeInput = z.object({ id: z.string().min(1).max(64) });
export const taskViewInput = z.union([
  z.object({ task: taskIdSchema }),
  z.object({ address: z.string().min(1).max(1024) }),
]);
/**
 * A History page: older than `before` (the previous page's nextBefore, a historyCursor), at `after` or later (the newest
 * time the reader holds; records of that time come again).
 */
export const taskHistoryInput = z.object({ task: taskIdSchema, before: historyCursorSchema.optional(),
  after: z.iso.datetime({ offset: true }).optional(),
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(80)).optional(),
  children: z.union([z.literal('1'), z.literal('0')]).optional() });
/** The project Task whose subtree (nested projects included) a list is narrowed to, as the screen shows it; none for all. */
const projectScope = projectIdSchema.optional();
export const taskSearchInput = z.object({ text: z.string().max(1024), scope: projectScope,
  after: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(80)).optional() });
const pageLimit = z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(20));
export const taskFinishedInput = z.object({ parent: z.union([taskIdSchema, z.literal('root')]), scope: projectScope,
  after: z.string().min(1).max(1024).optional(), limit: pageLimit.optional() });
export const taskShelvedInput = z.object({ scope: projectScope,
  after: z.string().min(1).max(1024).optional(), limit: pageLimit.optional() });
export const taskTimelineAxisInput = z.object({ lanes: z.string().max(8192) });
export const taskTimelineInput = z.object({
  lanes: z.string().max(8192),
  from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }),
  limit: z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(1).max(2000)).optional(),
}).refine(value => Date.parse(value.from) <= Date.parse(value.to), 'Invalid time range');
export const personSettingsSetShape = z.object({ key: nonempty, value: z.union([z.string(), z.boolean(), z.null()]),
  expectedRevision: nonempty, timeZone: z.string().optional() });
/** A setting's value is read by its kind first (`readSettingValue`): the command line's `true`, `null` or `ja-jp`. */
export const personSettingsSetInput = personSettingsSetShape.transform(value =>
  ({ ...value, value: readSettingValue(personalSettings, value.key, value.value) as string | boolean | null })).superRefine((value, context) => {
  if (!personalSettings.some(setting => setting.key === value.key))
    issue(context, 'key', 'unknown_setting', 'Unknown personal setting');
  else if (!validSettingWrite(personalSettings, value.key, value.value))
    issue(context, 'value', 'invalid_setting', 'Invalid setting value');
  if (value.timeZone !== undefined && !validSetting(personalSettings, 'push.timeZone', value.timeZone))
    issue(context, 'timeZone', 'invalid_time_zone', 'Invalid time zone');
});
/** Page-instance state; event ages are milliseconds on the page's own clock. */
export const presenceReportInput = z.object({
  screen: z.string().min(1).max(128), seq: z.number().int().positive(),
  touchSeq: z.number().int().nonnegative(),
  touchedAgo: z.number().finite().nonnegative().nullable(),
  hiddenAgo: z.number().finite().nonnegative().nullable(),
}).strict();
export type PresenceReport = z.infer<typeof presenceReportInput>;
export const presencePauseInput = z.object({ duration: z.enum(pauseChoices),
  timeZone: z.string().refine(validTimeZone, 'Invalid time zone') });
export const personNoticesSaveInput = z.object({ state: noticeStateSchema, expectedRevision: z.string().nullable() });
export const workspaceInput = z.object({ workspace: z.string().refine(value => value.trim() !== '',
  '--workspace must name a directory').optional() });

/** Replace the execution order of a Task that has never started. */
export const dependencyClearInput = z.object({ task: taskIdSchema, ...writeRecordShape, expectedTaskHash: digestSchema }).strict();
export const dependencySetInput = dependencyClearInput.extend({ after: z.array(taskIdSchema).min(1).refine(ids => new Set(ids).size === ids.length, 'Duplicate dependency') });
