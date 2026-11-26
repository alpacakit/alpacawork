/**
 * Who may do what: the one table of grants and the pure decisions shared by authorization and command help.
 * Callers supply facts; this module neither reads the database nor identifies the caller.
 */
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
import { TASK_POLICY, evaluate } from './task-policy.js';
import { speaksForUser, type TaskActor, type TaskKind, type TaskState, type TaskBaseState } from '@alpacawork/raw';

type CoordinatorSource = Extract<TaskActor, { kind: 'main' }>['provider'];
type Provider = Exclude<CoordinatorSource, 'mcp'>;
/** Optional words recorded with a coordinator write; never an authorization input. */
export type Quote = NonNullable<Extract<TaskActor, { kind: 'main' }>['quote']>;
/**
 * Who calls, as resolveCaller identified them. A Run is one of a current placement (an owner Run is its Task's
 * responsible's). A coordinator speaks in the screen's conversation, through the agent its Run uses, or in an outside
 * Claude Code or Codex conversation; its screen Run identifies it without a turn lifecycle. Anyone else is a person.
 */
export type Caller =
  | { kind: 'run'; runId: string; placementId: string; taskId: string; role: 'owner' | 'worker'; responsible: boolean }
  | ({ kind: 'coordinator'; conversation: string } &
    ({ source: 'screen'; provider: Provider; runId: string } | { source: CoordinatorSource }))
  | { kind: 'human' };

/** One Task as the table reads it. */
export type TaskFacts = {
  id: string;
  kind: TaskKind;
  parentId: string | null;
  /** The project it belongs to (`TaskTree.owningProject`): itself for a project. */
  project: string;
  state: TaskState;
  userRequested: boolean;
  /** contract `awaitsReview`: waiting for the user's review, or such a wait held. */
  baseState: TaskBaseState; hold: boolean;
  /** Derived from the Task's own log; absence does not authorize question completion. */
  openUserQuestion?: boolean;
};
/** What a decision reads besides the caller and the action. */
export type Facts = {
  /**
   * The Task acted on: a new Task's parent (null for a root project), a stopped Run's Task, the Task a question was
   * asked on, the Task a file belongs to; null for an act about no Task.
   */
  task: TaskFacts | null;
  /** The project of a Run caller's own Task; null for any other caller. */
  runProject: string | null;
  /** The projects above that project, nearest first (their policies reach the Run's launches); none when left out. */
  runProjectsAbove?: readonly string[];
  /** The state of a Run caller's own Task (held keeps its Runs to the acts a row lets while held); null for any other. */
  runState: TaskState | null;
  /** Optional record fields; neither changes permission. */
  quote: Quote | null;
  message?: string;
};

type UpdateField = 'title' | 'values' | 'cwd' | 'color' | 'userRequested' | 'analysisSubject';
/** What the caller asks to do, with what decides who may do it. */
export type Action =
  /** One Task: task get, task returns, a question's text, a file read; run get reads its Run's Task. */
  | { name: 'task.read' }
  /** The tree (task list): a Run reads its own project's. */
  | { name: 'task.list' }
  /** task new, --plan-file too: --from-user (true), --no-from-user (false), or neither (null). */
  | { name: 'task.new'; kind: TaskKind; userRequested: boolean | null }
  | { name: 'task.update'; fields: readonly [UpdateField, ...UpdateField[]] }
  /** The new parent and the Tasks above it, nearest first. */
  | { name: 'task.move'; to: readonly string[] }
  | { name: 'task.archive' | 'task.delete' | 'task.restore' }
  /** task report --state: waiting is an owner's question, the user's review submission, or a hold's return. */
  | { name: 'task.report'; state: TaskState; checkpoint?: boolean; confirmation?: boolean }
  | { name: 'task.withdraw' }
  | { name: 'task.comment'; urgent: boolean }
  /** task request to the Task's responsible, or to a worker of the Task that --agent names. */
  | { name: 'task.request'; worker: boolean }
  /** task request --answers: whom the question asked (null: the user). */
  | { name: 'task.answer'; askedTo: string | null; closed?: boolean }
  | { name: 'agent.assign' | 'agent.release'; worker: boolean }
  | { name: 'agent.handover' }
  /** run stop: the Task acted on is the Run's. */
  | { name: 'run.stop' }
  | { name: 'file.write' }
  /** field list reads the workspace's field definitions; field set and field delete change them. */
  | { name: 'field.list' | 'field.set' | 'field.delete' }
  /** field use: the Task acted on is the project whose own schema it replaces. */
  | { name: 'field.use' }
  /**
   * screen: the person's screen (its index and the reads made from it, the person's own state it keeps, voice input).
   * runtime: the running serve's own control and status (quiesce, preflight, readiness, diagnostics), the release's.
   * release: building releases and switching this PC's serve between them, decided on the Run's own Task.
   */
  | { name: 'update.review' | 'update.confirm' | 'update.cancel' }
  /** settings get and settings set: the person's own settings, the screen's and the AI's reply language. */
  | { name: 'settings.read' | 'settings.set' }
  | { name: 'screen' | 'coordinator.screen' | 'runtime' | 'config.inspect' | 'config.set' | 'admin' | 'release' };

/**
 * Who a grant names. own: the Task's responsible Run. parent: the responsible Run of the Task's parent. placement: a
 * Run of a current placement of the Task. asked: whoever the question asked. responsible: the responsible Run of any
 * Task. user: a person or coordinator (raw speaksForUser).
 */
export type Seat = 'own' | 'parent' | 'placement' | 'asked' | 'responsible' | 'run' | 'user' | 'human';
/** What a grant also requires: of the Task, or (within) that a move keeps it below the Run's own Task. */
type Condition = 'held' | 'same_project' | 'project_above' | 'within';
type Grant = readonly [Seat, ...Condition[]];
/**
 * One act: who may do it, and whether a Run whose own Task is held may do it too (whatever Task it acts on).
 */
export type Row = { readonly grants: readonly Grant[]; readonly whileHeld?: true };

/**
 * Who may do what: the only table. A Run acts only in its own project (its seats include its Task, its Task's children,
 * the Task its question went to and project-wide records) and reads only there. While its own Task is held, a Run
 * only reads, reports work,
 * asks, withdraws and records (an urgent comment and a file are records too): the rows marked whileHeld.
 * It neither works on its own Task nor acts on its children, whom it would otherwise instruct, stop or rearrange.
 * Task management belongs to a person or coordinator. Approval requirements are skill promises; these grants do
 * not confer the owner's reporting, question, checkpoint or worker-instruction duties, or human-only server access.
 */
export const ACTIONS = {
  /** A Run reads its own project, and the projects above it whose policies its launches carry. */
  'task.read': { grants: [['run', 'same_project'], ['run', 'project_above'], ['user']], whileHeld: true },
  'task.list': { grants: [['run'], ['user']], whileHeld: true },
  /** Directly below a project. Children have their own grant. */
  'task.new': { grants: [['own'], ['user']] },
  'task.new.child': { grants: [['own']] },
  /** A task requested by the user, as the person or coordinator records it. */
  'task.new.from_user': { grants: [['user']] },
  'task.new.project': { grants: [['user']] },
  'task.update.title': { grants: [['own'], ['parent'], ['user']] },
  /** A Task's values; a project's are its summary and its policy. */
  'task.update.values': { grants: [['own'], ['parent'], ['user']] },
  'task.update.analysisSubject': { grants: [['own'], ['parent'], ['user']] },
  'task.update.cwd': { grants: [['user']] },
  'task.update.color': { grants: [['user']] },
  'task.update.userRequested': { grants: [['user']] },
  'task.move': { grants: [['parent', 'within'], ['user']] },
  'task.archive': { grants: [['user']] },
  'task.delete': { grants: [['user']] },
  'task.restore': { grants: [['user']] },
  /** Own reports preserve holds; management reports to the current base restore them. */
  'task.report.doing': { grants: [['own'], ['user', 'held']], whileHeld: true },
  'task.report.waiting': { grants: [['own']], whileHeld: true },
  /** The user's proxy submits a finished Task's result for review; the transition checks the Task's facts. */
  'task.review': { grants: [['user']] },
  'task.report.done': { grants: [['own']] },
  'task.checkpoint': { grants: [['own']] },
  /** The user's proxy completes a Task awaiting review or an answer to its own question to the user, held or not.
   * An explicit review target retains its meaning; ReviewService checks freshness when a review is required. */
  'task.confirm': { grants: [['user']] },
  'task.report.stopped': { grants: [['own'], ['parent'], ['user']] },
  'task.report.restore': { grants: [['parent', 'held'], ['user', 'held']] },
  'task.report.held': { grants: [['user']] },
  'task.withdraw': { grants: [['own']], whileHeld: true },
  'task.comment': { grants: [['run', 'same_project'], ['user']], whileHeld: true },
  'task.comment.urgent': { grants: [['own']], whileHeld: true },
  /** A parent responsible, person or coordinator instructs the Task's responsible. */
  'task.request': { grants: [['parent'], ['user']] },
  'task.request.worker': { grants: [['own']] },
  /**
   * A failed request from the user is retried only by their proxy. Stopping a waiting review also remains their
   * decision; an ordinary instruction to that waiting Task uses the usual parent/user grant.
   */
  'task.request.user': { grants: [['user']] },
  'task.report.stopped.user': { grants: [['user']] },
  'task.answer': { grants: [['asked']] },
  'agent.assign': { grants: [['parent'], ['user']] },
  'agent.handover': { grants: [['parent'], ['user']] },
  'agent.release': { grants: [['parent'], ['user']] },
  'agent.assign.worker': { grants: [['own'], ['user']] },
  'agent.release.worker': { grants: [['own'], ['user']] },
  'run.stop': { grants: [['parent'], ['user']] },
  'file.write': { grants: [['placement'], ['human']], whileHeld: true },
  'field.list': { grants: [['run'], ['user']], whileHeld: true },
  /** Field definitions are shared by every project: only a person or the coordinator changes them. */
  'field.set': { grants: [['user']] },
  'field.delete': { grants: [['user']] },
  /** A project's schema (which fields, in what order): also a responsible Run of a Task in that project. */
  'field.use': { grants: [['responsible', 'same_project'], ['user']] },
  'update.review': { grants: [['human']] },
  'update.confirm': { grants: [['human']] },
  'update.cancel': { grants: [['human']] },
  'screen': { grants: [['human']] },
  'coordinator.screen': { grants: [['human']] },
  'runtime': { grants: [['human']] },
  'config.inspect': { grants: [['user']] },
  'config.set': { grants: [['user']] },
  /**
   * The person's settings, read and saved by the person and the coordinator that talks with them. A Run hears the user
   * only through quoted words, so it neither reads nor changes them.
   */
  'settings.read': { grants: [['user']] },
  'settings.set': { grants: [['user']] },
  'admin': { grants: [['human']] },
  /** A project's policy names who releases: a person, or the responsible of the Task the user asked for it. */
  'release': { grants: [['own'], ['human']] },
} as const satisfies Record<string, Row>;
export type Act = keyof typeof ACTIONS;
/** Whether the table lets some Run do `act`: else no Run's facts need reading to refuse it. */
export const runMayDo = (act: Act): boolean =>
  (ACTIONS[act].grants as readonly Grant[]).some(([seat]) => seat !== 'user' && seat !== 'human');

/** Who the history and a Request record as acting, and where a Run reads. */
export type Decision = { actor: TaskActor; readScope: string | null };

/** Shared report meaning for authorization and execution. A Run manages other Tasks, reports on its own. */
export function reportIntent(task: Pick<TaskFacts, 'id' | 'baseState' | 'hold' | 'openUserQuestion'>, state: TaskState,
  caller: Caller, confirmation = false) {
  return evaluate(TASK_POLICY.intent, { ...task, state,
    reporter: caller.kind !== 'run' ? 'outside' : caller.taskId === task.id ? 'own' : 'other', confirmation });
}

/** The acts an action is, given its Task: an update is one act per field it changes. */
export function actsOf(action: Action, task: TaskFacts | null, caller: Caller): readonly Act[] {
  const userDecides = task !== null && evaluate(TASK_POLICY.requestAuthority, { ...task,
    purpose: action.name === 'task.report' && action.state === 'stopped' ? 'stop' : 'instruction' }).code === 'user_decides';
  switch (action.name) {
    case 'task.new':
      return [action.kind === 'project' ? 'task.new.project' : action.userRequested === true ? 'task.new.from_user' : task?.kind === 'task' ? 'task.new.child' : 'task.new'];
    case 'task.update': return action.fields.map(field => `task.update.${field}` as const);
    case 'task.report': {
      const intent = task ? reportIntent(task, action.state, caller, !!action.confirmation).code : 'unknown';
      // An explicit review target keeps its meaning after the Task leaves waiting.
      // ReviewService checks its freshness; it never becomes an owner's done report or an unhold.
      if (intent === 'confirm') return ['task.confirm'];
      if (action.checkpoint && (action.state === 'doing' || action.state === 'waiting' || action.state === 'done'))
        return ['task.checkpoint', `task.report.${action.state}` as const];
      if (intent === 'unhold') return ['task.report.restore'];
      if (intent === 'submit_review') return ['task.review'];
      if (action.state === 'todo' || action.state === 'error') return ['task.report.restore'];
      if (action.state === 'done') return ['task.report.done'];
      if (action.state === 'stopped') return [userDecides ? 'task.report.stopped.user' : 'task.report.stopped'];
      return [`task.report.${action.state}` as const];
    }
    case 'task.comment': return [action.urgent ? 'task.comment.urgent' : 'task.comment'];
    case 'task.answer': return action.closed && userDecides ? ['task.answer', 'task.request.user'] : ['task.answer'];
    case 'task.request': return [action.worker ? 'task.request.worker' : userDecides ? 'task.request.user' : 'task.request'];
    case 'agent.assign': return [action.worker ? 'agent.assign.worker' : 'agent.assign'];
    case 'agent.release': return [action.worker ? 'agent.release.worker' : 'agent.release'];
    default: return [action.name];
  }
}

function recordedActor(caller: Caller, quote: Quote | null, message?: string): TaskActor {
  switch (caller.kind) {
    case 'run': return { kind: 'placement', placementId: caller.placementId };
    case 'human': return { kind: 'human' };
    case 'coordinator': return { kind: 'main', provider: caller.source === 'screen' ? caller.provider : caller.source,
      conversationId: caller.conversation, ...(quote ? { quote } : {}), ...(message ? { message } : {}) };
  }
}

/** The running owner Run of the current responsible placement of `taskId`. */
const responsibleRun = (caller: Caller, taskId: string | null | undefined) =>
  caller.kind === 'run' && caller.role === 'owner' && caller.responsible && caller.taskId === taskId;

function seated(seat: Seat, caller: Caller, actor: TaskActor, action: Action, task: TaskFacts | null): boolean {
  switch (seat) {
    case 'own': return responsibleRun(caller, task?.id);
    case 'parent': return responsibleRun(caller, task?.parentId);
    case 'placement': return caller.kind === 'run' && (caller.role === 'worker' || caller.responsible) &&
      caller.taskId === task?.id;
    // An answer goes to the question's askedTo, fixed when it was asked: the user's proxy, or that Task's responsible.
    case 'asked': return action.name === 'task.answer' &&
      (action.askedTo === null ? speaksForUser(actor) : responsibleRun(caller, action.askedTo));
    case 'responsible': return caller.kind === 'run' && caller.role === 'owner' && caller.responsible;
    case 'run': return caller.kind === 'run';
    case 'user': return speaksForUser(actor);
    case 'human': return caller.kind === 'human';
  }
}

function meets(condition: Condition, caller: Caller, action: Action, facts: Facts): boolean {
  const task = facts.task;
  switch (condition) {
    case 'held': return task?.hold === true;
    case 'same_project': return task !== null && task.project === facts.runProject;
    case 'project_above': return task?.kind === 'project' && (facts.runProjectsAbove ?? []).includes(task.id);
    case 'within': return caller.kind === 'run' && action.name === 'task.move' && action.to.includes(caller.taskId);
  }
}

export const SEAT_TEXT: Record<Seat, string> = {
  own: "the Task's responsible Run",
  parent: "the responsible Run of the Task's parent",
  placement: "a Run of the Task's current placement",
  asked: "whoever the question asked",
  responsible: 'a responsible Run',
  run: 'a Run',
  user: 'a person or the coordinator',
  human: 'a person',
};
export const CONDITION_TEXT: Record<Condition, string> = {
  held: 'while the Task is held',
  same_project: 'in its own project',
  project_above: 'reading a project above its own',
  within: "keeping the Task below the Run's own",
};
const describeGrant = ([seat, ...conditions]: Grant) =>
  [SEAT_TEXT[seat], ...conditions.map(condition => CONDITION_TEXT[condition])].join(' ');

/**
 * Whether the caller may do the action: the actor to record and a Run's read scope (its own project; null reads every project); else the refusal.
 */
export function decide(caller: Caller, action: Action, facts: Facts): Decision | Problem {
  // A Run read without its project would read every project.
  if (caller.kind === 'run' && facts.runProject === null)
    return new Problem(PROBLEM_CODE.forbidden, "A Run acts only in its own project, and the Run's project was not read", undefined,
      { reason: { kind: 'run_acts_only_own_project_and_run_s_project_was_not_read' } });
  // The coordinator always says whose Task it creates: it has no default mark.
  if (action.name === 'task.new' && action.kind === 'task' && caller.kind === 'coordinator' && action.userRequested === null)
    return new Problem(PROBLEM_CODE.invalidInput, 'The coordinator creates a Task with --from-user or --no-from-user', undefined,
      { reason: { kind: 'coordinator_creates_task_with_from_user_or_internal' }, issues: [{ path: 'fromUser', code: 'required', message: '--from-user or --no-from-user is required' }] });
  const actor = recordedActor(caller, facts.quote, facts.message);
  const acts = actsOf(action, facts.task, caller);
  for (const act of acts) {
    const row: Row = ACTIONS[act];
    if (caller.kind === 'run' && facts.runState === 'held' && !row.whileHeld)
      return new Problem(PROBLEM_CODE.forbidden, `${act} is not for a Run while its own Task is held`, { action: act },
        { reason: { kind: 'not_for_run_while_own_task_held', action: String(act) } });
    if (!row.grants.some(([seat, ...conditions]) => seated(seat, caller, actor, action, facts.task) &&
        conditions.every(condition => meets(condition, caller, action, facts))))
      return new Problem(PROBLEM_CODE.forbidden, `${act} is for ${row.grants.map(describeGrant).join('; or ')}`, { action: act },
        { reason: act === 'task.new.child' ? { kind: 'child_by_its_responsible' }
          : { kind: 'authorization_required', action: act, grants: row.grants } });
  }
  return { actor, readScope: caller.kind === 'run' ? facts.runProject : null };
}

/** Commands whose validated input determines an authorization action. */
export type AccessCommand = 'task.new' | 'task.update' | 'task.report' | 'task.request' | 'task.comment' |
  'task.move' | 'task.archive' | 'task.delete' | 'task.restore' | 'agent.assign' | 'agent.handover' | 'agent.release' | 'run.stop';
export type CommandFacts = { worker?: boolean; askedTo?: string | null; closed?: boolean; to?: readonly string[] };
const UPDATE_FIELDS: readonly UpdateField[] = ['title', 'values', 'cwd', 'color', 'userRequested', 'analysisSubject'];

/**
 * Translate validated command input once, for both the entry and help examples. Database facts must be supplied
 * explicitly when an argument names a placement, question or destination; guessing them could change permission.
 */
export function commandAction(command: AccessCommand, input: Readonly<Record<string, unknown>>, facts: CommandFacts = {}): Action {
  switch (command) {
    case 'task.new': return { name: command, kind: (input.kind ?? 'task') as TaskKind,
      userRequested: (input.fromUser ?? null) as boolean | null };
    case 'task.update': {
      const [first, ...rest] = UPDATE_FIELDS.filter(field => input[field === 'userRequested' ? 'fromUser' : field] !== undefined);
      if (first === undefined) throw new Error('taskUpdateInput asks for a field to change');
      return { name: command, fields: [first, ...rest] };
    }
    case 'task.report': return input.state === undefined ? { name: 'task.withdraw' } :
      { name: command, state: input.state as TaskState, checkpoint: input.values !== undefined,
        confirmation: input.aboutRun !== undefined };
    case 'task.request': {
      if (input.answers !== undefined) {
        if (facts.askedTo === undefined) throw new Error('An answer requires the question destination');
        return { name: 'task.answer', askedTo: facts.askedTo, closed: facts.closed };
      }
      if (input.agent !== undefined && facts.worker === undefined) throw new Error('A member instruction requires placement facts');
      return { name: command, worker: facts.worker ?? false };
    }
    case 'task.comment': return { name: command, urgent: input.urgent !== undefined };
    case 'task.move': {
      if (input.parent !== 'none' && facts.to === undefined) throw new Error('A move requires destination ancestors');
      return { name: command, to: facts.to ?? [] };
    }
    case 'agent.assign': return { name: command, worker: input.role === 'member' };
    case 'agent.release': {
      if (facts.worker === undefined) throw new Error('A release requires placement facts');
      return { name: command, worker: facts.worker };
    }
    default: return { name: command };
  }
}
