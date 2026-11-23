import { questionSnapshot } from './question-rules.js';
import { questionView, incomingQuestions, relevantAnswers } from './question-views.js';
/**
 * The admission-time records delivered with a Request. Its message goes whole; the project policy first, then the other
 * parts, fit in priority order or become their read commands, within PROTOCOL_LIMITS.prompt. Display order is independent of fit
 * priority. A continuation carries current questions and the owner's explanation as well as new events. These
 * records precede the agent's interpretation of the new instruction; agents fetch current authoritative records.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { digest, MAX_INSTRUCTION_BYTES, questionsOf, type ChildObservations, type ChildVersions } from '@alpacawork/raw';
import { eventOf, PARENT_VISIBLE_EVENTS, isReviewMark, type HistoryEventKind } from '@alpacawork/contract';
import { terminal } from '@alpacawork/contract/task-policy';
import { isRunInTrouble } from '@alpacawork/contract/run';
import { PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import type { ControlSource } from './task-views.js';
import type { ControlSnapshot, TaskTree } from './task-store.js';
import { estimateExamples, type EstimateCondition } from './estimate-examples.js';
import { policyChain } from './project-settings.js';
import type { TaskContexts } from './task-context.js';
import { returnLines, openWorkLines, type ReturnLine } from './return-lines.js';
import type { Obligations } from './return-lifecycle.js';
import { languageLine } from '../receiver/person-state.js';

type LaunchTask = ControlSnapshot['tasks'][number];
/**
 * What a launch reads: the Task tree, the Tasks' contexts (task-context: the policy chain, the Task's and its parent's
 * values, the user's instructions and the children's conclusions all come from them), and the Tasks and Runs its
 * estimate examples are scored from.
 */
export type LaunchSource = Pick<ControlSource, 'tasks' | 'runRecords' | 'errors'> & { tree: TaskTree<LaunchTask>;
  contexts: TaskContexts; estimates?: ControlSource['estimates'] };
export const requestBodyFits = (body: string) => Buffer.byteLength(body) <= MAX_INSTRUCTION_BYTES;

const size = (text: string) => Buffer.byteLength(text);
/** A section: its heading and lines, then a blank line. */
const section = (heading: string, lines: readonly string[]) => `## ${heading}\n${lines.join('\n')}\n\n`;
/** A part a launch can do without: in full within the bytes it may take, or the command that reads it. */
type Part = { full: (bytes: number) => string; short: string; supplied?: () => void };
/**
 * The parts, in their order of need, each in full while the room left takes it, else as its command; a null part is
 * none. The room is the limit less the whole parts and every part's command, so the text stays within it: the whole
 * parts are bounded by their own owner (MAX_INSTRUCTION_BYTES) well below the limit.
 */
function fit(whole: string, parts: readonly (Part | null)[]): string[] {
  let room = PROTOCOL_LIMITS.prompt - size(whole) - parts.reduce((bytes, part) => bytes + size(part?.short ?? ''), 0);
  return parts.map(part => {
    if (part === null) return '';
    const full = part.full(room + size(part.short)), extra = size(full) - size(part.short);
    if (extra > room) return part.short;
    room -= extra;
    part.supplied?.();
    return full;
  });
}

function taskOf(tree: LaunchSource['tree'], taskId: string): LaunchTask {
  const task = tree.byId.get(taskId);
  if (!task) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: taskId }, { reason: { kind: 'task_does_not_exist' } });
  return task;
}
/** A Task's identity and its context: what a launch says of the Task and of its parent. */
const taskLine = (source: LaunchSource, task: LaunchTask) => {
  const context = source.contexts.context(task.id);
  return JSON.stringify({ id: task.id, title: task.meta.title, state: task.meta.state, ...context ? { context } : {} });
};
/** A Task's identity and context; when they do not fit, its identity and the command reading it. */
function taskPart(source: LaunchSource, task: LaunchTask, heading: string): Part {
  return { full: () => section(heading, [taskLine(source, task)]),
    short: section(heading, [JSON.stringify({ id: task.id, title: task.meta.title, state: task.meta.state }),
      `Too large to include. Read it with alpacawork task get --task ${task.id}.`]) };
}
/** The parent whose context a Task's text also carries: none when it is a project, whose context the chain carries. */
function parentOf(tree: LaunchSource['tree'], task: LaunchTask): LaunchTask | null {
  const parent = tree.ancestors(task.id)[0];
  return parent?.meta.kind === 'task' ? parent : null;
}

/**
 * Each project's summary and full policy under its name, from the root to the Task's own project.
 * If the chain does not fit, include the command that reads its projects.
 */
function policyPart(source: LaunchSource, taskId: string): Part | null {
  const chain = policyChain(source.tree, source.contexts, taskId);
  if (!chain.length) return null;
  const heading = 'Project policy';
  return { full: () => section(heading, ['Listed from the root project down.',
    ...chain.map(link => {
      const summary = link.summary && `Summary: ${link.summary.replace(/\s*[\r\n\u2028\u2029]\s*/gu, ' ')}`;
      const body = [summary, link.policy].filter(Boolean).join('\n\n');
      return `\n### ${link.title} (${link.project})\n${body}`;
    })]),
  short: section(heading, [`Too large to include. Read the policies of ${chain.map(link => link.project).join(', ')} with ` +
    'alpacawork task get --task <project ID>.']) };
}
/**
 * Whether a project of the chain saved its values or schema or changed its title (the chain names each project), or
 * the Task or one above it moved, after `since`.
 */
const chainChanged = (tree: LaunchSource['tree'], task: LaunchTask, since: number) =>
  [task, ...tree.ancestors(task.id)].some(each => each.meta.log.some(entry => Date.parse(entry.at) > since &&
    (entry.kind === 'moved' || (entry.kind === 'body_updated' || entry.kind === 'retitled') && each.meta.kind === 'project')));

/**
 * The top Task under this project owns the user's instructions (its user_instructions value); descendants never
 * substitute their own. The top Task's own launch carries them in its context (`ownCarried`) and not again here.
 */
function userInstructionsPart(source: LaunchSource, task: LaunchTask, since: number | null, ownCarried: boolean): Part | null {
  const { tree } = source;
  const ancestry = [task, ...tree.ancestors(task.id)].filter(each => each.meta.kind === 'task');
  const top = ancestry.at(-1);
  if (!top || top.id === task.id && ownCarried) return null;
  // As with the policy chain, value/schema updates and moves invalidate the admission-time context.
  if (since !== null && !chainChanged(tree, task, since) && !top.meta.log.some(entry =>
    (entry.kind === 'body_updated' || entry.checkpoint !== undefined) && Date.parse(entry.at) > since)) return null;
  const value = source.contexts.value(top.id, 'user_instructions');
  const lines = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (!lines.length) return null;
  const heading = 'User instructions (background; your scope is the part the request gives you)';
  return { full: () => section(heading, [JSON.stringify({ task: top.id, lines })]),
    short: section(heading, [`Read "User instructions" with alpacawork task get --task ${top.id}.`]) };
}

/**
 * A child's line: its state, its conclusion (the line a parent sums a child up by), how many questions, answers and
 * urgent reports, and the questions to the parent it withdrew or a stop expired, of its records after `since` (all of
 * them, null: a new conversation). Its records are those its parent sees (contract eventOf and PARENT_VISIBLE_EVENTS,
 * as the parent's history, which shows the Task's entry into error and a Run in trouble (failed or needs_review) as an
 * error); its comments are not told. Since a time, a child is told when such a record came; in a new conversation,
 * every child not finished is told as it is now.
 */
function childLine(source: LaunchSource, taskId: string, child: LaunchTask, since: number | null,
  versions?: ChildVersions): string[] {
  const after = since ?? Number.NEGATIVE_INFINITY;
  const events = child.meta.log.filter(entry => Date.parse(entry.at) > after).map(eventOf)
    .filter(kind => kind !== null && PARENT_VISIBLE_EVENTS.has(kind));
  const inTrouble = PARENT_VISIBLE_EVENTS.has('error') && source.runRecords.some(run => run.task === child.id &&
    isRunInTrouble(run.state) && Date.parse(run.ended_at ?? run.started_at ?? run.created_at) > after);
  const withdrawn = questionsOf(child.meta.log).filter(({ asked, closing }) => asked.askedTo === taskId &&
    closing !== null && closing.kind !== 'answered' && Date.parse(closing.at) > after).map(({ asked }) => asked.id);
  if (versions ? versions[child.id] === child.hash :
    since === null ? terminal(child.meta.baseState) : !events.length && !inTrouble && !withdrawn.length) return [];
  const count = (kind: HistoryEventKind) => events.filter(event => event === kind).length;
  const [asked, answered, urgent] = [count('question'), count('answer'), count('urgent')];
  const conclusion = source.contexts.value(child.id, 'conclusion');
  return [`- Child task ${child.id} "${child.meta.title}": ` + [`state ${child.meta.state}`,
    // One line per child: a conclusion of several lines reads on it with spaces.
    ...conclusion === undefined ? [] : [`conclusion: ${String(conclusion).replace(/\s*\n\s*/g, ' ')}`],
    ...asked || answered ? [`questions ${asked}, answers ${answered}`] : [], ...urgent ? [`urgent ${urgent}`] : [],
    ...withdrawn.length ? [`withdrawn questions: ${withdrawn.join(', ')}`] : []].join('; ')];
}
/** What changed below since the conversation's previous Request; in a new conversation, the children not finished. */
function childrenPart(source: LaunchSource, taskId: string, since: number | null, versions?: ChildVersions,
  observed?: ChildObservations, previous?: ChildObservations): Part | null {
  const children = source.tree.children(taskId).filter(child => child.meta.lifecycle !== 'deleted');
  const supplied = children.flatMap(child => {
    const lines = childLine(source, taskId, child, since, versions);
    return lines.length ? [{ child, lines: versions ? lines.map(line => `${line} (${previous?.[child.id] === child.hash ? 'shown before' : 'new'}; version ${child.hash})`) : lines }] : [];
  });
  const removed = versions ? Object.keys(versions).filter(id => !children.some(child => child.id === id)) : [];
  const lines = [...supplied.flatMap(each => each.lines), ...removed.map(id => `- Child task ${id}: moved from under this parent, or deleted`)];
  if (!lines.length) return null;
  const heading = versions ? 'Changes since the snapshot (per child)' :
    since === null ? 'Child tasks now (unfinished ones)' : 'Changes since the previous request (per child)';
  const short = `${since === null ? 'Unfinished children' : 'Changed children'}: ${lines.length}. Too large to include. ` +
    `Read the list with alpacawork task list --under ${taskId} --depth 1, and a child's conclusion and version with alpacawork task get --task <child ID>.`;
  return { full: () => section(heading, lines), short: section(heading, [short]), supplied: () => {
    if (!observed) return;
    for (const { child } of supplied) observed[child.id] = child.hash;
    for (const id of removed) observed[id] = null;
  } };
}

/**
 * The responsible's own Task as it was recorded at admission: its ID, title and context; none without values. A part
 * this conversation was given whole before (`held`, its version) is named by its command only; one shortened or read
 * with errors acknowledges no version.
 */
function ownPart(source: LaunchSource, task: LaunchTask, held: string | undefined,
  supplied: ((version: string) => void) | undefined): Part | null {
  const heading = 'Task', context = source.contexts.context(task.id);
  if (!context) return null;
  const full = section(heading, [
    'The task record as of when this request was accepted, before the request is applied. Check it against the request and the current records, and update your judgment.',
    JSON.stringify({ id: task.id, title: task.meta.title, context })]);
  const version = digest(Buffer.from(full));
  if (version === held) return {
    full: () => section(heading, [`Same version as the record this conversation was already given in full. Read it with alpacawork task get --task ${task.id} if you need it.`]),
    short: section(heading, [`Read it with alpacawork task get --task ${task.id}.`]),
  };
  return { full: () => full,
    short: section(heading, [`Too large to include. Read it with alpacawork task get --task ${task.id}.`]),
    ...(supplied ? { supplied: () => supplied(version) } : {}) };
}

const CARRIED = 'Carried over (arrived earlier, not yet handled)';
/** The returns carried to this Request, drawn by return-lines within the bytes the part may take. */
const carriedPart = (taskId: string, carried: readonly ReturnLine[]): Part | null => carried.length ? {
  full: bytes => section(CARRIED, [returnLines(carried, bytes - size(section(CARRIED, ['']))).body]),
  short: section(CARRIED, [`${carried.length} carried over. Read them with alpacawork task returns --task ${taskId}.`]),
} : null;

function obligationsPart(taskId: string, obligations: Obligations): Part {
  const lines = openWorkLines(taskId, obligations);
  return { full: () => section('Open work', [lines.full]), short: section('Open work', [lines.short]) };
}

function examplesPart(source: LaunchSource, taskId: string, condition: EstimateCondition, voidsEstimate: boolean): Part {
  const heading = 'Estimate examples (read before you estimate)';
  const lines = [
    // Said in the one text every request carries, whether it starts a conversation or joins a running one.
    ...voidsEstimate ? ['Any estimate you gave earlier is void with this request. Using the examples below, give a new one first, following the owner procedure in the alpacawork skill.'] : [],
    'Up to the 3 most recent tasks run by the same agent with all the same launch selections. For what the values mean and how to estimate, see the owner procedure in the alpacawork skill.',
  ];
  return { full: () => section(heading, [...lines, JSON.stringify(source.estimates?.(condition) ?? estimateExamples(source, condition))]),
    short: section(heading, [...lines,
      `The examples are too large to include. Get them with alpacawork task get --task ${taskId} --estimate-examples.`]) };
}

const READ_GUIDE = section('Reading records', [
  '- Task and placements: alpacawork task get --task <ID> (-h lists what more it reads on request)',
  '- Full text of a question: alpacawork task get --task <ID> --question <question ID>',
  '- Tree: alpacawork task list --under <ID> (conclusion and version: each task\'s get)',
  '- Returns and notices that arrived: alpacawork task returns --task <ID>',
  '- A Run\'s result: alpacawork run get --run <ID> (the launch prompt it received: --kind prompt)',
  '- Usage: alpacawork -h, alpacawork <group> <verb> -h',
]);
/** What a responsible writes with; a worker changes no Task and asks nothing, so it is not told. */
const WRITE_GUIDE = section('Writing records', [
  '- Procedure, roles and reporting: the alpacawork skill. Each command\'s contract: alpacawork <group> <verb> -h',
  '- Fields and how to write their values: alpacawork field get (save with --values-file on task update / task report)',
]);

export type StartTextInput = {
  source: LaunchSource; taskId: string; responsible: boolean;
  mode: 'new' | 'continue'; at: string; body: string;
  condition?: EstimateCondition;
  /** This request is logged as an instruction or send-back to the responsible, which voids its earlier estimate. */
  voidsEstimate?: boolean;
  /**
   * When the conversation's previous Request was submitted: what changed below since then is told. Null for a new
   * conversation, which is told each child not finished as it is now. RequestService sets it.
   */
  since: string | null;
  /**
   * The returns ReturnLifecycle.carry reserved to this Request, the answers and questions that came while the seat
   * failed among them; none to a worker. A handover reaches the seat as such a notice line, never as a section of its
   * own. RequestService sets them.
   */
  carried: readonly ReturnLine[];
  /** The common authoritative read for new owners and handovers, including those continuing a worker's conversation. */
  openObligations?: Obligations;
  /** Only versions actually supplied in full are added; replacing a section with a fetch command acknowledges none. */
  observedChildren?: ChildObservations;
  childVersions?: ChildVersions;
  previousChildren?: ChildObservations;
  /** The version of the own Task part supplied whole with a proved receipt in this conversation (ownPart). */
  heldSnapshot?: string;
  /** Called only when fit includes the whole own Task part, never for a shortened one or one read with errors. */
  onSnapshotSupplied?: (version: string) => void;
  /** The user's saved language (`ai.language`); every launch, an owner's or a member's, is told it. None: not told. */
  replyLanguage?: string | null;
  /**
   * Who wrote the Request's text, told as its first line so that the agent can tell the user's own words from text an
   * agent wrote (the skill's "Policy" ranks them). RequestService sets it from the recorded author; none: not told.
   */
  author?: RequestAuthor;
};
export type RequestAuthor = 'user' | 'coordinator' | 'above' | 'owner' | 'alpacawork';
/**
 * Who wrote a Request, from how it was admitted: a seat going on by itself is alpacawork's; otherwise its recorded
 * actor. A placement writes to an owner from a task above (its parent, or an ancestor answering a question), and to a
 * member as that task's owner.
 */
export const requestAuthor = (purpose: string, actor: 'human' | 'main' | 'placement', toOwner: boolean): RequestAuthor =>
  purpose === 'return_continuation' ? 'alpacawork' : actor === 'human' ? 'user' : actor === 'main' ? 'coordinator'
    : toOwner ? 'above' : 'owner';
const AUTHOR_LINE: Record<RequestAuthor, string> = {
  user: 'Written by the user.',
  coordinator: 'Written by the coordinator.',
  // An owner hears from its parent, or from an ancestor answering a question it asked.
  above: 'Written by the owner of a task above this one.',
  owner: "Written by this task's owner.",
  alpacawork: 'Sent by alpacawork.',
};

export function startText({ source, taskId, responsible, mode, at, body, condition, voidsEstimate = false, since,
  carried, openObligations, observedChildren, childVersions, previousChildren, heldSnapshot, onSnapshotSupplied,
  replyLanguage, author }: StartTextInput): string {
  const { tree } = source, task = taskOf(tree, taskId), continued = mode === 'continue';
  const sinceAt = since === null ? null : Date.parse(since);
  // A continuation repeats the policy chain only when it changed.
  const policyChanged = !continued || sinceAt === null || chainChanged(tree, task, sinceAt);
  const policy = policyChanged ? policyPart(source, taskId) : null;
  const message = section('Request', author ? [AUTHOR_LINE[author], body] : [body]);
  const language = replyLanguage ? languageLine(replyLanguage) : '';
  if (!responsible) {
    const head = `[alpacawork] Request for task ${taskId}. You are a member of this task. Do not change the task's values, state, questions or placements. Put anything you need decided in your final reply, with your result and what you verified. If you have not read the alpacawork skill (including after the conversation was compacted), read it before you go on.\n` + language +
      `Below are the records as of ${at}, when the request was accepted. When you need the task's values, read them with alpacawork task get --task ${taskId}.\n\n`;
    const parent = continued ? null : parentOf(tree, task);
    const guide = continued ? '' : READ_GUIDE;
    const instructions = userInstructionsPart(source, task, continued ? sinceAt : null, !continued);
    const [projects, original, own, above] = fit(head + message + guide,
      [policy, instructions, continued ? null : taskPart(source, task, 'Task'), parent && taskPart(source, parent, 'Parent task')]);
    return head + projects + original + own + above + message + guide;
  }
  const head = continued
    ? `[alpacawork] Request for task ${taskId} (continuing the same conversation). You are the owner of this task. If you have not read the alpacawork skill (including after the conversation was compacted), read it before you go on.\n` + language +
      `Below are the records as of ${at}, when the request was accepted.\n\n`
    : `[alpacawork] Request for task ${taskId}. You are the owner of this task. Read the alpacawork skill before you go on.\n` +
      language +
      `Below are the records as of ${at}, when the request was accepted. For the current questions, placements and other records, read alpacawork task get --task ${taskId}.\n\n`;
  const guide = continued ? '' : READ_GUIDE + WRITE_GUIDE;
  const parent = continued ? null : parentOf(tree, task);
  const openWork = questionPart(source, taskId, sinceAt, carried);
  const instructions = userInstructionsPart(source, task, continued ? sinceAt : null, true);
  const [projects, kept, questions, obligations, original, own, changes, above, examples] = fit(head + message + guide, [
    policy, carriedPart(taskId, carried), openWork, openObligations ? obligationsPart(taskId, openObligations) : null, instructions,
    ownPart(source, task, continued && !source.errors.length ? heldSnapshot : undefined,
      !source.errors.length ? onSnapshotSupplied : undefined),
    childrenPart(source, taskId, sinceAt, childVersions, observedChildren, previousChildren),
    parent && taskPart(source, parent, 'Parent task'),
    condition && (!continued || voidsEstimate) ? examplesPart(source, taskId, condition, voidsEstimate) : null]);
  return head + projects + original + own + above + changes + kept + questions + obligations + examples + message + guide;
}

/** Open questions are supplied from their logs even after their notification was consumed, including handover. */
function questionPart(source: LaunchSource, taskId: string, since: number | null, carried: readonly ReturnLine[]): Part | null {
  const tasks = questionSnapshot(source.tree.byId.values()), task = tasks.get(taskId)!;
  const own = questionsOf(task.log).filter(q => q.closing === null).map(q => questionView(task, q, tasks));
  // Carry the waits closed since the owner's last publication, regardless of cancelled/unreceived Requests.
  // Request timestamps (since) cannot describe that lifetime, including when records share a timestamp.
  let publication = -1;
  for (const [index, entry] of task.log.entries())
    if (entry.kind === 'asked' || entry.stage?.action === 'report_done' || isReviewMark(entry)) publication = index;
  const afterPublication = new Set(task.log.slice(publication + 1).map(entry => entry.id));
  const withdrawn = questionsOf(task.log).filter(q => q.closing?.kind === 'question_withdrawn' &&
    q.closing.originCauseId && afterPublication.has(q.closing.id)).map(q => questionView(task, q, tasks));
  const submission = task.log[publication];
  const review = submission && isReviewMark(submission) && task.log.slice(publication + 1).some(entry =>
    entry.kind === 'linked' && entry.originCauseId && entry.stage?.ruleId === 'RW02' && entry.stage.baseState === 'doing')
    ? { reportId: submission.id, runId: submission.runId ?? null, title: submission.title, summary: submission.description,
      readCommand: `alpacawork task get --task ${taskId} --log ${task.log.length - publication}`,
      ...(submission.runId ? { resultCommand: `alpacawork run get --run ${submission.runId}` } : {}) } : null;
  const resumed = withdrawn.length || review ? section('Your waits withdrawn on resume', [
    `${withdrawn.length + Number(review !== null)} withdrawn. Read the original questions and this input, and put the points you still need into one new question.`,
    ...withdrawn.map(q => `${q.id}: ${q.readCommand}`),
    ...(review ? [`Awaiting review ${review.reportId}${review.runId ? ` (${review.runId})` : ''}: ${review.readCommand}`] : []),
  ]) : '';
  const incoming = incomingQuestions(taskId, tasks);
  const moved = (id: string) => {
    const seen = new Set<string>();
    for (let node = tasks.get(id); node && !seen.has(node.id); node = node.parentId ? tasks.get(node.parentId) : undefined) {
      seen.add(node.id);
      if (node.log.some(l => l.kind === 'moved' && Date.parse(l.at) > (since ?? Infinity))) return true;
    }
    return false;
  };
  const returned = new Set(carried.flatMap(line => 'from' in line && line.from.by === 'child' ? [line.from.taskId] : []));
  const relevant = relevantAnswers(taskId, tasks).filter(q => since === null ? !q.sourceFinished || returned.has(q.taskId) : Date.parse(q.answeredAt) > since || moved(q.taskId));
  const closed = [...tasks.values()].flatMap(node => questionsOf(node.log).filter(q => q.closing &&
    q.asked.askedTo === taskId && since !== null && Date.parse(q.closing.at) > since).map(q => questionView(node, q, tasks)));
  if (!own.length && !incoming.length && !relevant.length && !closed.length && !resumed && !source.errors.length) return null;
  const heading = 'Questions as they stand now (receiving a notice is not answering)';
  const read = `alpacawork task get --task ${taskId}`;
  const total = own.length + incoming.length + relevant.length + closed.length + withdrawn.length + Number(review !== null);
  const short = resumed + section(heading, [`${total} in all. ${source.errors.length ? 'Unverified because a read failed. ' : ''}Read questions/incomingQuestions/relevantAnswers with ${read}, and each fixed full text with its readCommand.`]);
  const content = section(heading, [JSON.stringify({ questions: own, incomingQuestions: source.errors.length ? null : incoming,
    relevantAnswers: source.errors.length ? null : relevant, closedQuestions: closed, withdrawnQuestions: withdrawn, invalidatedReview: review })]);
  return { full: () => total <= 20 && size(content) <= 4096 ? resumed + content : short, short };
}
