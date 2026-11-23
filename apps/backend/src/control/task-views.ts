import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { TaskTextMatches, readTaskSearch, type SearchTask, type SearchError } from './task-search.js';
import type { TaskGetInclude, TaskSearchPlace } from '@alpacawork/contract/inputs';
import { dependencyStatus } from './dependencies.js';
import { ProjectShelf } from './project-shelf.js';
import { questionSnapshot } from './question-rules.js';
import { questionView, incomingQuestions, relevantAnswers, decisionsMade } from './question-views.js';
/**
 * The only read views of `task get` and `task list`. The CLI and the start text
 * both use them, so an agent can fetch exactly what it was given, in one shape.
 * A read takes the scope authorize gave its caller (readScope: a Run's project) and compares no membership itself.
 */
import { Problem, PROBLEM_CODE, hasCode, type ProblemReason } from '@alpacawork/core';
import { PROJECT_SUMMARY, questionText, reviewTarget, sumUsage, type ControlRunDTO } from '@alpacawork/contract';
import { taskFileRoute } from '@alpacawork/contract/task-file-route';
import type { ReadRunRecord } from '@alpacawork/contract/run';
import { isRunEnded, compareRunIds, hasContinuableSession } from '@alpacawork/contract/run';
import { byTaskNumber } from '@alpacawork/contract/moved';
import { openQuestions, questionsOf, type AskedLog, type TaskKind, type TaskLog,
  type TaskState, type TaskValues } from '@alpacawork/raw';
import { valuesText } from '@alpacawork/contract';
import { schemaFor, type TaskFields } from './task-values-store.js';
import { ControlTaskStore, TaskRepository, TaskTree, controlSnapshotView, readControl, type ControlSnapshot, type TaskListContents } from './task-store.js';
import { projectSummary } from './project-settings.js';
import { controlRuns, projectPlacements, readControlRecords } from './tree.js';
import { taskFiles } from './task-files.js';
import { estimateExamples, databaseEstimateExamples, type EstimateCondition } from './estimate-examples.js';
import { markMessages, requestedByUser, saidAt } from '../coordinator/messages.js';
import { FileWriter } from '../raw/storage.js';
import { ownerHeadsOf } from './wake.js';
import { returnFacts } from './return-rules.js';
import { openObligationsOf, type Obligations } from './return-lifecycle.js';

type ReadError = { code: string; message: string; path: string; reason?: ProblemReason };
type SourceTask = ReturnType<typeof controlSnapshotView>['tasks'][number];
/** What a read takes beside the records: when the utterances it reads of were said, and an answer's fixed text. */
type Words = {
  /** When each utterance a Task's mark quotes was said, by Request ID (messages.saidAt). */
  said: ReadonlyMap<string, string>;
  /** The fixed full text (log_texts) of the answer to the question the read was for, by its log ID. */
  answerTexts: ReadonlyMap<string, string>;
};
const NO_WORDS: Words = { said: new Map(), answerTexts: new Map() };
/** One read of Task records, placements and Run records, with the words asked for; no replies, requests or files. */
export type ControlSource = {
  root: string; tasks: SourceTask[]; tree: TaskTree<ControlSnapshot<TaskValues | undefined>['tasks'][number]>;
  /** The workspace's fields and each project's own schema, at the Tasks' read point. */
  fields: TaskFields;
  placements: ReturnType<typeof projectPlacements>;
  runs: ControlRunDTO[]; runRecords: readonly ReadRunRecord[];
  /** Each placement's latest owner Run at the Runs' read point (wake ownerHeadsOf): the Run a review confirms. */
  heads: ReadonlyMap<string, ReadRunRecord>;
  questions: ReturnType<typeof questionSnapshot>;
  /** Admission's conversation head for each placement, including workers; distinct from the review's owner head. */
  conversationHeads: ReadonlyMap<string, string | null>;
  openObligations: (taskId: string) => Obligations | null;
  errors: ReadError[];
  estimates?: (condition: EstimateCondition) => ReturnType<typeof estimateExamples>;
} & Words;

/**
 * When the `messages` were submitted, and the fixed text of the answer that closed `question` (if one did); a read
 * asking neither opens nothing.
 */
function readWords(root: string, messages: readonly string[], question?: string): Words {
  if (!messages.length && question === undefined) return NO_WORDS;
  return readControl(root, db => {
    const rows = question === undefined ? [] : db.prepare(`SELECT log_id, text FROM log_texts
      WHERE log_id = (SELECT log_id FROM task_log_question WHERE question_log_id = ?)`).all(question);
    return { said: saidAt(db, messages),
      answerTexts: new Map(rows.map(row => [String(row.log_id), String(row.text)])) };
  });
}

/** Every Task of the workspace with every word its views read but a question's text. */
export async function readControlSource(root: string): Promise<ControlSource> {
  const snapshot = await new ControlTaskStore(root).snapshot();
  return sourceFromSnapshot(root, snapshot, null,
    readWords(root, markMessages(snapshot.tasks.map(task => task.meta.log))));
}

function sourceFromSnapshot(root: string, snapshot: ControlSnapshot<TaskValues | undefined>, scope: string | null,
  words: Words, taskIds?: readonly string[], estimatesScope: string | null = scope): ControlSource {
  const view = controlSnapshotView(snapshot);
  const tree = new TaskTree(snapshot.tasks);
  const read = readControlRecords(root, scope ?? undefined, taskIds), records = read.snapshot?.records ?? [];
  const error = read.error, placed = read.snapshot?.placements ?? [];
  // Keep complete Run reads and runtime projection even for lists: their
  // faults (including malformed state history) have always failed the command.
  const runs = controlRuns(root, records);
  const responsible = new Set(placed.filter(placement => placement.active && placement.responsible).map(placement => placement.taskId));
  const facts = returnFacts(snapshot.tasks.map(task => ({ ...task.meta, responsible: responsible.has(task.id) })),
    records, read.snapshot?.returns ?? []);
  const questions = questionSnapshot(snapshot.tasks);
  return { root: view.root, tasks: view.tasks, tree, fields: snapshot.fields, questions,
    placements: projectPlacements(root, placed, view.tasks, error ? null : runs), runs, runRecords: records,
    heads: read.snapshot ? ownerHeadsOf(records, read.snapshot.requests) : new Map(),
    conversationHeads: read.snapshot?.headRunIds ?? new Map(), ...words,
    openObligations: taskId => read.snapshot && !error
      ? openObligationsOf(taskId, read.snapshot.requests, read.snapshot.returns, facts, questions) : null,
    estimates: condition => readControl(root, db => databaseEstimateExamples(root, db, condition, estimatesScope ?? undefined)),
    errors: error ? [error] : [] };
}

type TaskViewOptions = { log?: number; runs?: number; include?: readonly TaskGetInclude[];
  /** A question of the Task (its asking log's ID) to include with its full text and state. */
  question?: string };

/** Request-specific reads still format through the same views as launch text, within the caller's `scope`. */
export async function readTaskView(root: string, id: string, options: TaskViewOptions, scope: string | null) {
  let taskIds: string[] | undefined;
  // Usage and open obligations add up other Tasks' Runs and Requests. Any other read of one Task shows its own Runs, and
  // of other Tasks' histories only the questions that concern it, so it reads no more than those.
  const includes = new Set(options.include);
  const usage = includes.has('usage');
  const own = !usage && !includes.has('openObligations');
  let histories: string[] | undefined;
  const project = readControl(root, db => {
    const repository = new TaskRepository(root, db);
    // A direct project usage read includes nested projects' work.
    if (scope === null && usage && db.prepare('SELECT kind FROM tasks WHERE external_id=?').get(id)?.kind === 'project')
      taskIds = repository.relatedIds([id]);
    if (own) histories = questionHistories(db, id);
    return repository.projectFor(id);
  });
  const read = scope ?? project;
  // authorize supplies a project for a Run; a direct connection derives the Task's own.
  const snapshot = await new ControlTaskStore(root).viewSnapshot({ task: id }, taskIds === undefined ? read : undefined, taskIds, histories ?? 'all');
  const task = snapshot.tasks.find(item => item.id === id);
  const words = readWords(root, markMessages(task ? [task.meta.log] : []), options.question);
  const view = taskView(own
    ? sourceFromSnapshot(root, snapshot, read, words, [id], scope)
    : sourceFromSnapshot(root, snapshot, taskIds === undefined ? read : null, words, taskIds, scope), id, options);
  return { ...view, dependencies: readControl(root, db => dependencyStatus(db, id)) };
}
/**
 * The Tasks whose histories a read of `id` shows: its own, those with a question asked of it (incomingQuestions,
 * decisionsMade), and those below it that asked anything (relevantAnswers reads a question on its way up through it).
 */
function questionHistories(db: DatabaseSync, id: string): string[] {
  const rows = db.prepare(`WITH RECURSIVE below(id) AS (SELECT id FROM tasks WHERE external_id = ?
      UNION ALL SELECT t.id FROM tasks t JOIN below ON t.parent_id = below.id)
    SELECT DISTINCT t.external_id AS task FROM task_log l CROSS JOIN tasks t ON t.id = l.task_id
    WHERE json_extract(l.entry, '$.kind') = 'asked' AND (json_extract(l.entry, '$.askedTo') = ? OR l.task_id IN below)`).all(id, id);
  return [id, ...rows.map(row => String(row.task))];
}

export async function readTaskListView(root: string, options: TaskListOptions, scope: string | null) {
  const snapshot = await new ControlTaskStore(root).listSnapshot(options.text ? 'search' : 'summary', scope ?? undefined);
  // The default list reads no historical Requests, inputs, returns or Run results.
  // Extra search places are read only after visibility and list filters are applied.
  const view = controlSnapshotView(snapshot);
  const tree = new TaskTree(snapshot.tasks);
  return taskListView({ tasks: view.tasks, tree, errors: [], contents: snapshot.contents }, options, (tasks, found, errors) =>
      // Other projects' rows lead the tree; their additional content is outside a Run's read grant.
      readTaskSearch(root, tasks.filter(task => scope === null || tree.owningProject(task.id) === scope),
        options.in ?? [], found, errors));
}

function taskValues(task: SourceTask): TaskValues {
  if (task.values === undefined) throw new Problem(PROBLEM_CODE.readFailed, 'Task values were not read', undefined, { reason: { kind: 'task_body_was_not_read' } });
  return task.values as TaskValues;
}

/** A Task's files by their server-relative URL (`taskFileRoute`), resolved by the server at the response boundary. */
function folderFiles(source: ControlSource, task: SourceTask) {
  let files: ReturnType<typeof taskFiles> = new Map();
  try {
    const writer = new FileWriter(source.root);
    try { files = taskFiles(writer, [task.path]); }
    finally { writer.close(); }
  } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  return (files.get(task.path) ?? []).map(file => ({ path: taskFileRoute(task.id, file.name),
    size: file.size, at: file.at, ...(file.readable === false ? { readable: false as const } : {}) }));
}

/** The last n items; 0 is none (slice(-0) would be all). */
const latest = <T>(items: readonly T[], n: number) => items.slice(Math.max(0, items.length - n));

/**
 * A question of the Task with its state, its full text (contract questionText of what it fixed when asked) and, once
 * answered, the answer's fixed text (what a delivered answer's short line sends here for); another Task's is not found.
 */
function questionDetail(source: ControlSource, task: SourceTask, questionId: string) {
  const question = questionsOf(task.log).find(item => item.asked.id === questionId);
  if (!question) throw new Problem(PROBLEM_CODE.notFound, 'Question does not exist on this Task', { task: task.id, question: questionId },
    { reason: { kind: 'question_does_not_exist_on_task' } });
  const fixed = (logId: string) => {
    const text = source.answerTexts.get(logId);
    if (text === undefined) throw new Problem(PROBLEM_CODE.readFailed, 'Answer text was not read', undefined, { reason: { kind: 'answer_text_was_not_read' } });
    return text;
  };
  const answer = question.closing?.kind === 'answered' ? fixed(question.closing.id) : null;
  const snapshot = source.questions;
  return { ...questionView(snapshot.get(task.id)!, question, snapshot), text: questionText(question.asked.decide),
    ...(answer === null ? {} : { answer, answerId: question.closing!.id, answeredAt: question.closing!.at }) };
}

export function taskView(source: ControlSource, id: string, options: TaskViewOptions = {}) {
  const task = source.tasks.find(item => item.id === id);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', undefined, { reason: { kind: 'task_does_not_exist' } });
  const shelf = new ProjectShelf(source.tree.tasks.filter(item => item.meta.kind === 'project')).of(source.tree.owningProject(id));
  const values = taskValues(task);
  const include = new Set(options.include);
  const usage = include.has('usage') ? (() => {
    const now = Date.now();
    const ownRuns = source.runs.filter(run => run.taskId === id);
    const subtreeIds = new Set([id, ...source.tree.descendants(id).map(child => child.id)]);
    return { own: sumUsage(ownRuns, now),
      subtree: sumUsage(source.runs.filter(run => subtreeIds.has(run.taskId)), now) };
  })() : undefined;
  const responsible = source.placements.find(item => item.taskId === id && item.responsible && item.active);
  const wantsEstimates = include.has('estimateExamples');
  const reference = wantsEstimates && responsible && source.runRecords.filter(run =>
    run.task === id && run.placementId === responsible.id).sort(compareRunIds).at(-1);
  const estimateCondition = reference ? { agent: reference.agent, values: reference.launch.values } : null;
  const questionTasks = source.questions;
  const head = responsible ? source.heads.get(responsible.id) ?? null : null;
  const candidates = source.placements.filter(item => item.taskId === task.id && (item.active || include.has('agents')));
  const agents = candidates.map(item => {
    const headRunId = source.conversationHeads.get(item.id) ?? null;
    const head = headRunId ? source.runRecords.find(run => run.id === headRunId) : undefined;
    return { ...item, headRunId,
      ...(source.errors.some(error => error.code === PROBLEM_CODE.runsUnavailable) || headRunId && !head
        ? {} : { previousValues: head && hasContinuableSession(head) ? { ...head.launch.values } : null }) };
  });
  const questions = questionsOf(task.log)
    .filter(question => include.has('closedQuestions') || question.closing === null)
    .map(question => questionView(questionTasks.get(task.id)!, question, questionTasks));
  return {
    shelf,
    task: { ...(task.kind === 'project' ? { settings: task.settings } : {}), id: task.id, kind: task.kind, projectId: source.tree.owningProject(task.id), parentId: task.parentId,
      userRequested: task.userRequested, folder: taskFileRoute(task.id), lifecycle: task.lifecycle, title: task.title,
      state: task.state, baseState: task.baseState, hold: task.hold, hash: task.hash,
      // Its values, and the fields of the schema it uses in order with where that comes from (field get reads them).
      ...(Object.keys(values).length ? { values } : {}), ...(include.has('fields') ? { fields: schemaFor(source.tree, source.fields.schemas, task.id) } : {}),
      ...(options.log === undefined ? {} : { log: latest(task.log, options.log) }),
      ...(include.has('files') ? { files: folderFiles(source, task) } : {}) },
    questions,
    incomingQuestions: source.errors.length ? null : incomingQuestions(task.id, questionTasks),
    decisionsMade: source.errors.length ? null : decisionsMade(task.id, questionTasks),
    relevantAnswers: source.errors.length ? null : relevantAnswers(task.id, questionTasks),
    // The Run a confirmation or a send-back names (--about-run), as the ball and the approval check read it.
    reviewRun: reviewTarget(task, head, source.runRecords.some(run => run.task === task.id && !isRunEnded(run.state))),
    requestedByUser: requestedByUser(task.log, message => source.said.get(message)),
    ...(options.question === undefined ? {} : { question: questionDetail(source, task, options.question) }),
    agents,
    ...(include.has('openObligations') ? { openObligations: source.openObligations(task.id) } : {}),
    ...(usage ? { usage } : {}),
    ...(wantsEstimates ? { estimateExamples: estimateCondition
      ? (source.estimates?.(estimateCondition) ?? estimateExamples(source, estimateCondition)) : null } : {}),
    ...(options.runs === undefined ? {} : { runs: latest(source.runs.filter(item => item.taskId === task.id)
      .sort(compareRunIds), options.runs) }),
    errors: source.errors,
  };
}

type TaskListOptions = { under?: string; depth?: number; text?: string;
  in?: readonly TaskSearchPlace[]; limit?: number; cursor?: string;
  state?: readonly (TaskState | 'all')[]; kind?: TaskKind; all?: boolean };

/** Match one field at a time, so a query cannot span two different facts. */
export function matchesTaskText(text: string, fields: readonly string[]): boolean {
  const needle = text.toLocaleLowerCase();
  return fields.some(value => value.toLocaleLowerCase().includes(needle));
}

/** The first line of `values` with `text` in it (matched as matchesTaskText), cut to about 80 characters around it. */
export function lineWithText(text: string, values: TaskValues): string {
  const needle = text.toLocaleLowerCase();
  const line = valuesText(values).split('\n').find(each => each.toLocaleLowerCase().includes(needle))?.trim() ?? '';
  const from = Math.max(0, line.toLocaleLowerCase().indexOf(needle) - 30);
  return `${from > 0 ? '…' : ''}${line.slice(from, from + 80)}${from + 80 < line.length ? '…' : ''}`;
}

export function taskListView(source: Pick<ControlSource, 'tasks' | 'tree' | 'errors'> & { contents?: TaskListContents }, options: TaskListOptions = {},
  readExtra?: (tasks: SearchTask[], found: TaskTextMatches, errors: SearchError[]) => void) {
  if (options.under !== undefined && !source.tree.byId.has(options.under))
    throw new Problem(PROBLEM_CODE.notFound, 'Subtree root does not exist', undefined, { reason: { kind: 'subtree_root_does_not_exist' } });
  const ancestors = (id: string): ReturnType<ControlSource['tree']['ancestors']> | null => {
    try { return source.tree.ancestors(id); }
    catch (error) {
      // The source reports the broken relationship. Other positions remain usable.
      if (error instanceof Problem && (error.code === PROBLEM_CODE.parentUnavailable ||
        error.code === PROBLEM_CODE.conflict || error.code === PROBLEM_CODE.tooDeep)) return null;
      throw error;
    }
  };
  // Distance below --under (itself 0), or below the forest (a root Task is 1).
  const distance = (task: SourceTask): number | null => {
    if (options.under !== undefined && task.id === options.under) return 0;
    const path = ancestors(task.id);
    if (path === null) return null;
    if (options.under === undefined) return path.length + 1;
    const index = path.findIndex(ancestor => ancestor.id === options.under);
    return index < 0 ? null : index + 1;
  };
  const listed = new ProjectShelf(source.tree.tasks.filter(item => item.meta.kind === 'project')).listed;
  const scope = source.tasks.filter(task => {
    const steps = distance(task);
    return steps !== null && (options.depth === undefined || steps <= options.depth) &&
      (options.all || task.lifecycle === 'active' && listed.has(source.tree.owningProject(task.id)));
  });
  const inScope = new Set(scope.map(task => task.id));
  const candidates = scope.filter(task =>
    (options.kind === undefined || task.kind === options.kind) &&
    (options.state === undefined
      ? (Boolean(options.text) || task.state !== 'done')
      : (options.state.includes('all') || options.state.includes(task.state))));
  const errors = [...source.errors];
  const { contents } = source;
  const searchValues = (task: SourceTask) => contents?.mode === 'search' ? contents.values.get(task.id) : taskValues(task);
  const found = options.text ? new TaskTextMatches(options.text) : null;
  if (found) {
    for (const task of candidates) {
      found.add(task.id, { kind: 'title' }, task.title);
      const values = searchValues(task);
      if (values !== undefined) found.add(task.id, { kind: 'values' }, valuesText(values));
      found.add(task.id, { kind: 'id' }, task.id);
    }
    readExtra?.(candidates, found, errors);
  }
  const matching = candidates.filter(task => !found || found.matches.has(task.id));
  const selected = new Set(matching.map(task => task.id));
  const direct = new Set(selected);
  // Keep the path to each match visible, even when a parent is done or did not match --text or --kind.
  for (const id of direct) for (const ancestor of ancestors(id) ?? []) {
    if (inScope.has(ancestor.id)) selected.add(ancestor.id);
  }
  const positions = new Map(scope.filter(task => selected.has(task.id))
    .map(task => [task.id, distance(task)!]));
  const sortPosition = (a: CursorPosition, b: CursorPosition) => a.depth - b.depth || byTaskNumber(a, b);
  const visible = scope.filter(task => positions.has(task.id))
    .map(task => ({ task, position: { id: task.id, depth: positions.get(task.id)! } }))
    .sort((a, b) => sortPosition(a.position, b.position));
  const filter = filterFingerprint(options);
  const after = options.cursor === undefined ? null : readCursor(options.cursor, filter);
  const remaining = after === null ? visible : visible.filter(row => sortPosition(row.position, after) > 0);
  const page = remaining.slice(0, options.limit ?? 100);
  const omitted = remaining.length - page.length;
  return {
    tasks: page.map(({ task }) => {
      const summary = task.kind !== 'project' ? '' : projectSummary(contents?.mode === 'summary' ? contents.summaries.get(task.id)
        : (contents?.mode === 'search' ? contents.values.get(task.id) : task.values)?.[PROJECT_SUMMARY]);
      return { id: task.id, kind: task.kind, parentId: task.parentId, lifecycle: task.lifecycle, title: task.title, state: task.state,
        ...(summary ? { summary } : {}),
        ...(found && direct.has(task.id) ? { match: found.matches.get(task.id)! } : {}) };
    }),
    ...(omitted > 0 ? { omitted, cursor: Buffer.from(JSON.stringify({ ...page.at(-1)!.position, filter })).toString('base64url') } : {}),
    errors,
  };
}

type CursorPosition = { id: string; depth: number };
const cursorSchema = z.object({ id: z.string().regex(/^[TP][1-9][0-9]*$/), depth: z.number().int().min(0),
  filter: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

function filterFingerprint(options: TaskListOptions): string {
  return createHash('sha256').update(JSON.stringify([
    options.under, options.depth, options.text, [...new Set(options.in)].sort(),
    [...new Set(options.state)].sort(), options.kind, !!options.all,
  ])).digest('hex');
}

function readCursor(encoded: string, filter: string): CursorPosition {
  let candidate: unknown;
  try { candidate = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch (cause) {
    throw new Problem(PROBLEM_CODE.invalidInput, 'Invalid task list cursor', undefined,
      { cause, issues: [{ path: 'cursor', code: 'invalid_value', message: 'Invalid task list cursor' }] });
  }
  const cursor = cursorSchema.safeParse(candidate);
  if (!cursor.success || cursor.data.filter !== filter) {
    const message = 'Cursor requires the same task list filters';
    throw new Problem(PROBLEM_CODE.invalidInput, message, undefined,
      { issues: [{ path: 'cursor', code: 'invalid_value', message }] });
  }
  return cursor.data;
}
