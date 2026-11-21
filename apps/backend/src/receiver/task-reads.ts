import { questionApplicable, questionSnapshot } from '../control/question-rules.js';

import { resultHead, reviewClosure, PARENT_VISIBLE_EVENTS, PROJECT_SCHEMA, compareHistoryEvents, currentReview, eventOf, historyCursor, renderContext, type TaskValues } from '@alpacawork/contract';
import { HISTORY_WINDOW_MAX, HISTORY_WINDOW_SIZE, historyWindowRequestSchema, viewReportLog, type HistoryWindowRequest, type TaskHistoryWindowDTO, type TaskProjectedViewDTO, type ControlIndexDTO, type ControlRunDTO, type ControlTaskDTO, type ControlTreeDTO, type HistoryCrewDTO, type PlacementDTO, type TaskHistoryDTO, type TaskPageRowDTO, type TaskRowDTO, type TaskTimelineDTO, type TaskViewDTO } from '@alpacawork/contract/control';
import { isRunEnded, isRunInTrouble, isRunMoving } from '@alpacawork/contract/run';
import { PROBLEM_CODE, Problem } from '@alpacawork/core';
import { closureOf, openQuestions, questionsOf, type TaskActor } from '@alpacawork/raw';
import { createHash } from 'node:crypto';
import { errorRunReason } from './row-facts.js';
import { controlTaskView } from '../control/task-dto.js';
import type { PublishedFrame, RecordsReader } from './projection-contract.js';
import { replyOf, withoutActivity } from './screen-derive.js';
import { resultHeadOf } from './workspace-records.js';
import { recordedRequests, recordedRun } from './projected-records.js';

/** Keep each head/latest moving representative and every running execution, without queued or ended history. */
export function currentPlacementRunIds(placements: readonly PlacementDTO[], runs: readonly ControlRunDTO[]): Set<string | null> {
  const ids = new Set(placements.map(placement => placement.headRunId));
  const placementIds = new Set(placements.map(placement => placement.id));
  const latestMoving = new Map<string, ControlRunDTO>();
  for (const run of runs) if (placementIds.has(run.placementId) && isRunMoving(run.state)) {
    if (run.state === 'running') ids.add(run.id);
    const prior = latestMoving.get(run.placementId);
    if (!prior || run.createdAt.localeCompare(prior.createdAt) > 0) latestMoving.set(run.placementId, run);
  }
  for (const run of latestMoving.values()) ids.add(run.id);
  return ids;
}

export type Kept<T> = Map<string, { value: T; json: string }>;

export type HomeRowDTO = ControlIndexDTO['home'][number];

export type ChildCounts = ControlIndexDTO['counts']['children'][string];

export type HistoryEvent = TaskHistoryDTO['events'][number];

export type TimelineStamp = { at: number; id: string; value: TaskTimelineDTO['events'][number] };

/** A Request's heading: the first line of its text. */
export const headline = (body: string) => body.split('\n', 1)[0] ?? '';

type NestedTask = Pick<TaskRowDTO, 'id' | 'parentId' | 'lifecycle'>;

/** Cost and running Runs follow logical parentage, including inactive branches and Tasks omitted from the live list. */
function* usageAncestors(id: string, byId: ReadonlyMap<string, NestedTask>): Generator<string> {
  const seen = new Set([id]);
  let parent = byId.get(id)?.parentId;
  while (parent !== undefined && parent !== null && !seen.has(parent)) {
    yield parent;
    seen.add(parent);
    parent = byId.get(parent)?.parentId;
  }
}

/** Event sources captured for one Task and its referenced ends, shared by History and timeline. */
type HistoryPlacement = Pick<PlacementDTO, 'id' | 'taskId' | 'profileKey' | 'responsible' | 'startedAt' | 'endedAt'>;
type HistoryTree = Pick<ControlTreeDTO, 'tasks' | 'runs' | 'requests' | 'dialogues' | 'historyFacts'> & { placements: readonly HistoryPlacement[] };

function prepareHistory(tree: HistoryTree, questions: ReadonlyMap<string, TaskViewDTO['userQuestions']>) {
  const placements = new Map(tree.placements.map(placement => [placement.id, placement]));
  const allRuns = new Map(tree.runs.map(run => [run.id, run]));
  const byRequest = new Map(tree.runs.filter(run => run.requestId).map(run => [run.requestId!, run]));
  const logs = new Map(tree.tasks.flatMap(task => task.log.map(entry => [entry.id, { taskId: task.id, entry }] as const)));
  const runsByTask = new Map<string, Map<string, ControlRunDTO>>();
  for (const run of tree.runs) {
    const group = runsByTask.get(run.taskId) ?? new Map();
    group.set(run.id, run); runsByTask.set(run.taskId, group);
  }
  const requestsByTask = new Map<string, ControlTreeDTO['requests']>();
  for (const request of tree.requests) {
    const group = requestsByTask.get(request.taskId) ?? [];
    group.push(request); requestsByTask.set(request.taskId, group);
  }
  const dialoguesByTask = new Map<string, ControlTreeDTO['dialogues']>();
  for (const dialogue of tree.dialogues) {
    const group = dialoguesByTask.get(dialogue.taskId) ?? [];
    group.push(dialogue); dialoguesByTask.set(dialogue.taskId, group);
  }
  const userQuestions = new Set([...questions.values()].flatMap(branch => branch?.map(question => question.id) ?? []));
  const actualRun = (run: ControlRunDTO): ControlRunDTO => {
    const seen = new Set<string>();
    while (run.state === 'joined' && run.into && !seen.has(run.id)) {
      seen.add(run.id);
      const next = allRuns.get(run.into);
      if (!next) break;
      run = next;
    }
    return run;
  };
  const consumers = new Map<string, Map<string, Set<string>>>();
  /**
   * The one rule for a record's receiving end: the Run that consumed it (took it in and finished its turn), wherever it
   * was delivered. A wake that was never received, was released or is still unsettled names no Run.
   */
  const receivedBy = new Map<string, ControlRunDTO>();
  const causesByRun = new Map<string, Map<string, NonNullable<HistoryEvent['causes']>[number]>>();
  for (const delivery of tree.historyFacts.deliveries) {
    const receiving = byRequest.get(delivery.requestId);
    if (!receiving) continue;
    const run = actualRun(receiving).id;
    if (delivery.consumed && !receivedBy.has(delivery.logId)) {
      receivedBy.set(delivery.logId, actualRun(receiving));
    }
    const task = consumers.get(delivery.toTaskId) ?? new Map<string, Set<string>>();
    const group = task.get(delivery.logId) ?? new Set<string>();
    group.add(run); task.set(delivery.logId, group); consumers.set(delivery.toTaskId, task);
    const log = logs.get(delivery.logId);
    if (!log) continue;
    const causes = causesByRun.get(run) ?? new Map();
    causes.set(delivery.logId, { taskId: log.taskId, id: delivery.logId, kind: delivery.outcome, title: log.entry.title ?? '', at: log.entry.at });
    causesByRun.set(run, causes);
  }
  /** A Request's recipient as it was when the Request created its Run, else its placement's role. */
  const requestRole = (request: ControlTreeDTO['requests'][number]) => request.recipientRole === 'owner' ? 'owner'
    : request.recipientRole === 'worker' ? 'member' : tree.historyFacts.placementRoles[request.placementId];
  const receivingRun = (request: ControlTreeDTO['requests'][number]) => {
    const accepted = request.runId ? allRuns.get(request.runId) : byRequest.get(request.id);
    return accepted ? actualRun(accepted) : undefined;
  };
  /**
   * The one rule for a member's result: the Run that took a member Request in ended normally, so its final reply is
   * the result, and the newest Request that Run took in carries it (a Request joined into a Run that was working
   * shares that Run's one reply). Learnt when the Run ends, so an open History reads again then.
   */
  const results = new Map<string, ControlRunDTO>();
  const resultOf = new Map<string, string>();
  for (const request of [...tree.requests].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id))) {
    if (request.purpose === 'return_continuation' || requestRole(request) !== 'member') continue;
    const run = receivingRun(request);
    if (run?.state !== 'succeeded' || run.taskId !== request.taskId || !run.endedAt) continue;
    const earlier = resultOf.get(run.id);
    if (earlier) results.delete(earlier);
    results.set(request.id, run); resultOf.set(run.id, request.id);
  }
  return { tree, placements, allRuns, byRequest, runsByTask, requestsByTask, dialoguesByTask, userQuestions, actualRun, consumers, receivedBy, causesByRun,
    requestRole, receivingRun, results };
}

/**
 * A Task's records as its history's events, one each and none made up: its log entries that are events (eventOf; a
 * question says whether it is still open), its Requests (not a wake carrying returns: what it carries are their own
 * records' events), its Runs in trouble or whose accepted scope was invalidated, and its dialogues with the coordinator.
 * A failure is one row: a Run in trouble is its own, and the Task's entry into error that no Run in trouble explains (no report, a person's stop) is that
 * entry's, with the reason. A child's are only those its parent sees. History and the time view's notes are these.
 */
export function recordEvents(context: ReturnType<typeof prepareHistory>, task: ControlTaskDTO, fromChild: boolean,
  viewId = fromChild ? task.parentId ?? task.id : task.id, withRequests = false): HistoryEvent[] {
  const { tree, placements, allRuns, byRequest, actualRun, receivedBy, causesByRun } = context;
  const choices = (run: ControlRunDTO | undefined) => run ? { modelId: run.modelId, effort: run.effort } : {};
  const roleOf = (run: ControlRunDTO) => tree.historyFacts.runRoles[run.id] ?? tree.historyFacts.placementRoles[run.placementId] ?? 'owner';
  /** The Coordinator Run that took a screen message, as a record's Coordinator end. */
  const coordinatorOf = (message: string | null | undefined) => {
    const run = message ? tree.historyFacts.coordinatorRuns[message] : undefined;
    return run ? { coordinator: { profileKey: run.agent, modelId: run.modelId, effort: run.effort } } : {};
  };
  const questionStates = new Map(questionsOf(task.log).map(q => [q.asked.id, closureOf(q)?.kind ?? null]));
  const open = new Set(openQuestions(task.log).map(asked => asked.id));
  const runs = context.runsByTask.get(task.id) ?? new Map<string, ControlRunDTO>();
  const consumers = context.consumers.get(viewId);
  const authorOf = (actor: TaskActor | null, runId?: string): NonNullable<HistoryEvent['author']> => {
    if (actor?.kind === 'human' || actor?.kind === 'main') return { kind: actor.kind };
    const placement = actor?.kind === 'placement' ? placements.get(actor.placementId) : undefined;
    if (!placement) return { kind: 'unknown' };
    const run = runId ? allRuns.get(runId) : undefined;
    const agent = { profileKey: placement.profileKey, ...choices(run?.placementId === placement.id ? run : undefined) };
    if (placement.taskId !== task.id) return { kind: 'parent', taskId: placement.taskId, ...agent };
    const role = (runId && tree.historyFacts.runRoles[runId]) || tree.historyFacts.placementRoles[placement.id];
    return role ? { kind: role, ...agent } : { kind: 'unknown' };
  };
  const events: HistoryEvent[] = [];
  const event = (id: string, kind: HistoryEvent['kind'], at: string, title: string, summary: string,
    state: HistoryEvent['state'] = null, actor: TaskActor | null = null, runId?: string): HistoryEvent => {
    const consumedBy = [...consumers?.get(id) ?? []];
    const received = receivedBy.get(id);
    const writing = runId ? allRuns.get(runId) : undefined;
    // Include deliveries fed through joined Runs as well as the Run's initial request.
    const causes = fromChild && writing ? [...causesByRun.get(actualRun(writing).id)?.values() ?? []]
      .sort((a, b) => a.at.localeCompare(b.at)) : [];
    return { id, kind, taskId: task.id, fromChild, at, ...(kind === 'question' ? { open: open.has(id), ...(questionStates.get(id) ? { closure: questionStates.get(id)! } : {}), userQuestion: context.userQuestions.has(id) } : {}), state,
      by: actor === null || actor.kind === 'placement' ? null : actor.kind, ...(actor ? { author: authorOf(actor, runId) } : {}), title, summary,
      ...(actor && actor.kind !== 'placement' && 'message' in actor && actor.message ? { message: actor.message } : {}),
      ...(actor?.kind === 'main' ? { quote: actor.quote, ...coordinatorOf(actor.message) } : {}),
      ...(received ? { recipient: { role: roleOf(received), profileKey: received.agent, ...choices(received) } } : {}),
      ...(runId ? { runId } : {}), ...(fromChild && consumedBy.length ? { consumedBy } : {}), ...(fromChild && causes.length ? { causes } : {}) };
  };
  for (const entry of task.log) {
    const dependencies = entry.kind === 'dependencies_changed' ? entry.dependencies : undefined;
    const kind = dependencies ? 'changed' : eventOf(entry);
    if (kind === 'error') {
      const run = entry.runId === undefined ? undefined : runs.get(entry.runId);
      if (!run || !isRunInTrouble(run.state)) events.push(event(entry.id, kind, entry.at, errorRunReason(run), '', entry.toState, entry.actor, entry.runId));
    } else if (kind) events.push({ ...event(entry.id, kind, entry.at, entry.title ?? '', entry.description ?? '', entry.toState,
      entry.actor, entry.kind === 'review_approved' ? undefined : entry.runId),
      ...(dependencies ? { dependencies } : {}),
      ...(kind === 'review' ? reviewClosure(task.log, entry.id) : {}),
      ...(entry.kind === 'asked' ? { askedTo: entry.askedTo ?? 'user' } : {}),
      ...(entry.kind === 'answered' ? { answers: entry.questionId, ...(tree.historyFacts.answerTexts[entry.id] !== undefined ? { answerText: tree.historyFacts.answerTexts[entry.id] } : {}) } : {}) });
  }
  const references = new Map(task.log.filter(entry => entry.kind === 'request_accepted' || entry.kind === 'review_sent_back')
    .map(entry => [entry.id, entry]));
  for (const request of context.requestsByTask.get(task.id) ?? []) if (request.purpose !== 'return_continuation') {
    const record = references.get(request.id);
    const recipient = placements.get(request.placementId);
    const accepted = request.runId ? allRuns.get(request.runId) : byRequest.get(request.id);
    const receiving = context.receivingRun(request);
    const role = context.requestRole(request);
    const result = context.results.get(request.id);
    events.push({ ...event(request.id, 'request', request.submittedAt, headline(request.body), request.body, null,
      request.author),
      author: authorOf(request.author, accepted?.caller?.run),
      ...(record?.answers ? { answers: record.answers } : {}),
      ...(recipient && role ? { recipient: { role, profileKey: recipient.profileKey, ...choices(receiving) } } : {}), ...(record?.title ? { note: { title: record.title, description: record.description } } : {}),
      ...(result && recipient && role === 'member' ? { result: { runId: result.id, at: result.endedAt! } } : {}) });
  }
  for (const run of runs.values()) {
    // Reading why accepted work ended is independent of whether it is a business error needing intervention.
    const kind = isRunInTrouble(run.state) ? 'error'
      : run.state === 'cancelled' && run.reason === 'scope_invalidated' ? 'run_end' : null;
    // The Run that stopped is the row's writer: its Task's responsible or member, by what it ran with.
    const placement = placements.get(run.placementId);
    if (kind) events.push({ ...event(run.id, kind, run.endedAt ?? run.startedAt ?? run.createdAt, run.reason ?? run.state, ''),
      ...(kind === 'error' && run.errorCause ? { cause: run.errorCause } : {}),
      ...(placement?.taskId === task.id ? { author: { kind: roleOf(run), profileKey: placement.profileKey, ...choices(run) } } : {}) });
  }
  for (const dialogue of context.dialoguesByTask.get(task.id) ?? [])
    events.push({ ...event(dialogue.messageId, 'dialogue', dialogue.at, dialogue.words, dialogue.answer ?? ''), author: { kind: 'human' }, ...coordinatorOf(dialogue.messageId),
      wordsKey: createHash('sha256').update(dialogue.words).digest('hex') });
  // A parent's History also shows what was asked of its child, so an exchange between them reads from both ends.
  // A child's instructions to its own members are that child's work, read in its own History as its other records are.
  return fromChild ? events.filter(item => withRequests && item.kind === 'request' && item.recipient?.role !== 'member' || PARENT_VISIBLE_EVENTS.has(item.kind) && item.kind !== 'review' &&
    !(item.kind === 'question' && item.askedTo === 'user')) : events;
}

/** These questions of a Task, oldest first, each with what it asks as its record fixed it. */
function questionViews(task: ControlTaskDTO, selected: ReturnType<typeof questionsOf>, tasks: ReturnType<typeof questionSnapshot>): NonNullable<TaskViewDTO['questions']> {
  return selected.map(question => {
    const asked = question.asked;
    return { id: asked.id, taskId: task.id, destination: asked.askedTo === null ? { kind: 'user' } : { kind: 'task', taskId: asked.askedTo }, applicable: questionApplicable(task.id, asked, tasks),
      title: asked.title ?? '', summary: asked.description ?? '', askedAt: asked.at, state: closureOf(question)?.kind ?? 'open',
      ...(question.closing ? { closedAt: question.closing.at } : {}), decide: asked.decide };
  });
}

/**
 * Who stood at each named Task over a History page's time: its placements, and their Runs from the last one
 * begun before the page's oldest event to the first one begun after its newest, so every end of a row on the page can
 * say its agent without the reader holding finished Tasks.
 */
function historyCrews(tree: { placements: readonly HistoryPlacement[]; runs: readonly ControlRunDTO[] }, named: ReadonlySet<string>,
  oldest: string | undefined, newest: string | undefined): Map<string, HistoryCrewDTO> {
  const crews = new Map<string, HistoryCrewDTO>();
  if (!oldest || !newest) return crews;
  const placed = new Map(tree.placements.filter(placement => named.has(placement.taskId)).map(placement => [placement.id, placement]));
  const begun = (run: ControlRunDTO) => run.startedAt ?? run.createdAt;
  const runsOf = new Map<string, ControlRunDTO[]>();
  for (const run of tree.runs) if (placed.has(run.placementId)) runsOf.set(run.placementId, [...runsOf.get(run.placementId) ?? [], run]);
  for (const placement of placed.values()) {
    const crew = crews.get(placement.taskId) ?? { placements: [], runs: [] };
    crew.placements.push({ id: placement.id, profileKey: placement.profileKey, responsible: placement.responsible, startedAt: placement.startedAt, endedAt: placement.endedAt });
    const runs = (runsOf.get(placement.id) ?? []).sort((a, b) => begun(a).localeCompare(begun(b)));
    const before = runs.filter(run => begun(run) < oldest).length, after = runs.findIndex(run => begun(run) > newest);
    const first = Math.max(0, before - 1);
    for (const run of runs.slice(first, after < 0 ? runs.length : after + 1))
      crew.runs.push({ id: run.id, placementId: run.placementId, agent: run.agent, modelId: run.modelId, effort: run.effort, at: begun(run) });
    crews.set(placement.taskId, crew);
  }
  return crews;
}

export function current<T>(state: { tree?: T }): T {
  if (!state.tree) throw new Error('Index must be read before it is served');
  return state.tree;
}


export function pageRow(state: { children: Readonly<Record<string, ChildCounts>> }, row: TaskRowDTO, moved: ReadonlyMap<string, number>): TaskPageRowDTO {
  const { stateLog, ball, question, ...rest } = row;
  const mark = (entry: typeof stateLog[number] | undefined) => {
    if (!entry) return null;
    return entry;
  };
  const children = state.children[row.id];
  const stateMark = mark([...stateLog].reverse().find(entry => entry.toState !== null));
  const latestReport = mark([...stateLog].reverse().find(entry => entry.kind === 'reported'));
  return { ...rest, ...(ball ? { ball } : {}), ...(question ? { question } : {}),
    movedAt: moved.get(row.id) ?? 0,
    stateMark, latestReport: latestReport?.id === stateMark?.id ? null : latestReport,
    childCounts: { live: children?.live ?? 0, finished: children?.finished ?? 0 } };
}

/** The visible rows a Task's Runs count under, by the parentage the running count (runningRuns) follows. */
export function lanesAbove(state: { rows: ReadonlyMap<string, { value: NestedTask }> }, own: ReadonlySet<string>) {
  const byId = new Map([...state.rows.values()].map(({ value }) => [value.id, value]));
  const known = new Map<string, string[]>();
  return (id: string) => {
    let lanes = known.get(id);
    if (!lanes) known.set(id, lanes = [...usageAncestors(id, byId)].filter(parent => own.has(parent)));
    return lanes;
  };
}

// Reads from one immutable published frame.

function requireBundle(records: RecordsReader, id: string) {
  const bundle = records.bundle(id);
  if (!bundle) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task: id }, { reason: { kind: 'task_does_not_exist' } });
  return bundle;
}

/** The small question tree this Task reads: itself, its ancestors, and fixed destinations. */
function questionNodes(records: RecordsReader, id: string) {
  const own = requireBundle(records, id);
  const ids = new Set([id, ...records.ancestors(id), ...questionsOf(own.task.meta.log).flatMap(({ asked }) => asked.askedTo ? [asked.askedTo] : [])]);
  return questionSnapshot([...ids].flatMap(key => {
    const bundle = records.bundle(key);
    return bundle ? [bundle.task] : [];
  }));
}

/** The opened row reads no descendant aggregate. Its ancestor names do not require their list rows. */
export function projectedView(frame: PublishedFrame, id: string): TaskProjectedViewDTO {
  const records = frame.records, bundle = requireBundle(records, id), derived = frame.derived(id);
  if (!derived) throw new Error(`Published Task has no derived row: ${id}`);
  const task = { ...controlTaskView(bundle.task), files: [...bundle.files ?? []] };
  const questions = questionNodes(records, id);
  const ownQuestions = questionViews(task, questionsOf(task.log), questions);
  const decisionsAvailable = records.environment().errors.length === 0;
  const mark = task.kind === 'task' && task.lifecycle === 'active'
    ? currentReview(task, bundle.runs.some(run => !isRunEnded(run.state))) : null;
  const placements = [...derived.placements];
  const ids = currentPlacementRunIds(placements, derived.runs);
  const schema = task.kind === 'project' ? { fields: [...PROJECT_SCHEMA], from: null }
    : records.schemaOf(records.projectOf(id));
  return { generation: frame.generation, sourcePv: frame.pv,
    task: { ...task, log: viewReportLog(task.log, new Set(placements.filter(item => item.responsible).map(item => item.id))) },
    row: derived.row,
    ancestors: [...records.ancestors(id)].reverse().flatMap(key => {
      const ancestor = records.bundle(key)?.task;
      return ancestor ? [{ id: ancestor.id, title: ancestor.meta.title, parentId: ancestor.meta.parentId,
        kind: ancestor.meta.kind, lifecycle: ancestor.meta.lifecycle }] : [];
    }),
    ...withoutActivity({ placements, runs: derived.runs.filter(run => ids.has(run.id)) }),
    requestHeads: recordedRequests(records, id).map(({ body, ...request }) => ({ ...request,
      headline: headline(body), bodyBytes: Buffer.byteLength(body, 'utf8') })),
    values: { values: task.values, fields: [...schema.fields], from: schema.from,
      context: renderContext(schema.fields, task.values as TaskValues, records.catalog()) },
    reply: replyOf(bundle),
    questions: ownQuestions,
    userQuestions: decisionsAvailable ? ownQuestions.filter(question => question.state === 'open' && question.destination.kind === 'user' && question.applicable)
      .map(question => ({ ...question, destination: { kind: 'user' as const }, taskTitle: task.title })) : null,
    userReviews: decisionsAvailable ? mark ? [{ id: mark.id, taskId: id, taskTitle: task.title,
      title: mark.title ?? task.title, summary: mark.description ?? null, submittedAt: mark.at }] : [] : null,
    requestedByUser: bundle.requestedByUser };
}

/**
 * Only the records named by an event source: its author/receiving ends and cause records, never every Task of a project.
 * The existing event rules take this local snapshot, so History and timeline continue to share their one event owner.
 */
function recordedHistory(records: RecordsReader, id: string): ReturnType<typeof prepareHistory> {
  const own = requireBundle(records, id);
  const task = { ...controlTaskView(own.task), files: [...own.files ?? []] };
  const runs = new Map<string, ControlRunDTO>();
  const placements = new Map<string, HistoryPlacement>();
  const runRoles: HistoryTree['historyFacts']['runRoles'] = {};
  const placementRoles: HistoryTree['historyFacts']['placementRoles'] = {};
  const addPlacement = (key: string) => {
    if (placements.has(key)) return;
    const owner = records.placementOwner(key);
    const bundle = owner ? records.bundle(owner) : undefined;
    const placement = bundle?.placements.find(item => item.id === key);
    if (!placement) return;
    placementRoles[key] = placement.responsible ? 'owner' : 'member';
    placements.set(key, placement);
  };
  const addRun = (key: string) => {
    if (runs.has(key)) return;
    const raw = records.run(key);
    if (!raw) return;
    // The folder facts its owner's records captured say a failure's cause; History never rereads the folder.
    const owner = records.runOwner(key), errorCause = owner ? records.bundle(owner)?.runFiles?.get(key)?.errorCause : undefined;
    runs.set(key, { ...recordedRun(raw), ...errorCause ? { errorCause } : {} });
    runRoles[key] = raw.role === 'owner' ? 'owner' : 'member';
    addPlacement(raw.placementId);
    if (raw.into) addRun(raw.into);
    if (raw.caller) addRun(raw.caller.run);
  };
  const requests = new Map(recordedRequests(records, id).map(request => [request.id, request]));
  for (const run of own.runs) addRun(run.id);
  for (const placement of own.placements) addPlacement(placement.id);
  for (const request of own.requests) {
    addPlacement(request.placementId);
    const run = request.runId ?? records.runByRequest(request.id);
    if (run) addRun(run);
  }
  const deliveries: HistoryTree['historyFacts']['deliveries'] = [];
  const causes = new Map<string, Set<string>>();
  for (const owner of new Set([id, ...records.returnsByCauseTask(id)])) {
    for (const row of records.bundle(owner)?.returns ?? []) {
      if (row.causeLogId === null || owner !== id && records.logOwner(row.causeLogId) !== id) continue;
      const source = records.logOwner(row.causeLogId);
      if (source && source !== id) {
        const logs = causes.get(source) ?? new Set<string>();
        logs.add(row.causeLogId); causes.set(source, logs);
      }
      for (const delivery of row.deliveries) {
        deliveries.push({ logId: row.causeLogId, toTaskId: row.toTaskId, requestId: delivery.wakeRequestId,
          outcome: row.outcome, consumed: delivery.consumedAt !== null });
        const run = records.runByRequest(delivery.wakeRequestId);
        if (run) addRun(run);
      }
    }
  }
  // prepareHistory indexes receiving Runs by their original Request, including those that joined another Run.
  const coordinatorRuns: HistoryTree['historyFacts']['coordinatorRuns'] = {};
  const rememberMessage = (message: string | null | undefined) => {
    const run = message ? records.coordinatorRun(message) : undefined;
    if (message && run) coordinatorRuns[message] = run;
  };
  const author = (actor: TaskActor) => {
    if (actor.kind === 'placement') addPlacement(actor.placementId);
    else if (actor.kind === 'main') rememberMessage(actor.message);
  };
  for (const log of own.task.meta.log) author(log.actor);
  for (const request of own.requests) author(request.author);
  for (const dialogue of own.dialogues) rememberMessage(dialogue.messageId);
  const tree: HistoryTree = {
    tasks: [task, ...[...causes].flatMap(([key, logs]) => {
      const bundle = records.bundle(key);
      return bundle ? [{ ...controlTaskView(bundle.task), files: [], log: bundle.task.meta.log.filter(log => logs.has(log.id)) }] : [];
    })],
    placements: [...placements.values()], runs: [...runs.values()], requests: [...requests.values()],
    dialogues: [...own.dialogues],
    historyFacts: { answerTexts: { ...own.answerTexts }, placementRoles, runRoles, deliveries, coordinatorRuns },
  };
  const nodes = questionNodes(records, id);
  const applicable = records.environment().errors.length ? [] : questionViews(task, questionsOf(own.task.meta.log), nodes)
    .filter(question => question.state === 'open' && question.destination.kind === 'user' && question.applicable)
    .map(question => ({ ...question, destination: { kind: 'user' as const }, taskTitle: own.task.meta.title }));
  return prepareHistory(tree, new Map([[id, applicable]]));
}

/** The one event-source builder, also used by timeline's folded lanes. */
export function recordedEvents(records: RecordsReader, id: string, fromChild = false, viewId = id, withRequests = false): HistoryEvent[] {
  const context = recordedHistory(records, id);
  return recordEvents(context, context.tree.tasks.find(task => task.id === id)!, fromChild, viewId, withRequests)
    .map(event => {
      const head = event.result ? resultHeadOf(records.run(event.result.runId)) ?? undefined : undefined;
      return head === undefined || !event.result ? event : { ...event, result: { ...event.result, head: resultHead(head) } };
    }).sort(compareHistoryEvents);
}

type ObservedRead = { method: keyof RecordsReader; args: unknown[]; value: unknown };
const sameRead = (left: unknown, right: unknown) => Object.is(left, right) ||
  Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

/** Keep the read dependencies beside each source so a child's change rebuilds only that child's events. */
function observeRecords(records: RecordsReader) {
  const reads: ObservedRead[] = [];
  const seen = new Set<string>();
  const reader = new Proxy(records, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      const result = Reflect.apply(value, target, args);
      const key = JSON.stringify([property, args]);
      if (!seen.has(key)) { reads.push({ method: property as keyof RecordsReader, args, value: result }); seen.add(key); }
      return result;
    };
  } });
  return { reader, reads };
}
function readsUnchanged(records: RecordsReader, reads: readonly ObservedRead[]): boolean {
  return reads.every(read => {
    const method = records[read.method];
    return typeof method === 'function' && sameRead(read.value, Reflect.apply(method, records, read.args));
  });
}

/** Slice by cursor position, including an absent/deleted boundary; timestamps alone cannot describe a History window. */
export function historyWindow(events: readonly HistoryEvent[], input: HistoryWindowRequest): Pick<TaskHistoryWindowDTO, 'events' | 'oldestKey' | 'hasOlder'> {
  const request = historyWindowRequestSchema.parse(input);
  // The list is newest first, in code-unit cursor order (the same comparison as compareHistoryEvents).
  const boundary = (key: string) => {
    let low = 0, high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const cursor = historyCursor(events[middle]!);
      if (cursor >= key) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  let start = 0, end: number;
  switch (request.mode) {
    case 'latest': end = Math.min(events.length, HISTORY_WINDOW_SIZE); break;
    case 'older': start = boundary(request.before); end = Math.min(events.length, start + request.limit); break;
    case 'since': end = Math.min(boundary(request.since), request.keep); break;
    case 'protect':
      if (request.protect < request.since) throw new Problem(PROBLEM_CODE.invalidInput, 'Protected event is outside the held window');
      // The protected position widens the window as far as it, never narrows it: the window `since` would read (the
      // newest HISTORY_WINDOW_SIZE of what is held) stays, so rows below the protected one are not cut and read back.
      end = Math.max(boundary(request.protect), Math.min(boundary(request.since), HISTORY_WINDOW_SIZE));
      if (end > HISTORY_WINDOW_MAX) throw new Problem(PROBLEM_CODE.conflict, 'History window is too large',
        { limit: HISTORY_WINDOW_MAX }, { reason: { kind: 'history_window_too_large', limit: HISTORY_WINDOW_MAX } });
      break;
  }
  const page = events.slice(start, end), oldestKey = page.length ? historyCursor(page.at(-1)!) : null;
  return { events: page, oldestKey, hasOlder: end < events.length };
}

type EventPart = { events: HistoryEvent[]; reads: ObservedRead[]; checkedPv: PublishedFrame['pv'] };
type HistoryOrder = { parts: Map<string, EventPart>; events: HistoryEvent[] };

/** Per-generation event orders. Requests slice the held order; only a changed source is removed and merged back. */
export class ProjectedHistory {
  private generation: string | undefined;
  private readonly orders = new Map<string, HistoryOrder>();

  events(frame: PublishedFrame, id: string): readonly HistoryEvent[] {
    if (this.generation !== frame.generation) { this.orders.clear(); this.generation = frame.generation; }
    requireBundle(frame.records, id);
    const order = this.orders.get(id) ?? { parts: new Map<string, EventPart>(), events: [] };
    const keys = new Map([[id, false], ...frame.records.children(id).map(child => [child, true] as const)]);
    const removed = new Set<HistoryEvent>(), changed: EventPart[] = [];
    for (const [key, part] of order.parts) if (!keys.has(key)) {
      for (const event of part.events) removed.add(event);
      order.parts.delete(key);
    }
    for (const [key, child] of keys) {
      let part = order.parts.get(key);
      if (!part || part.checkedPv !== frame.pv && !readsUnchanged(frame.records, part.reads)) {
        for (const event of part?.events ?? []) removed.add(event);
        const { reader, reads } = observeRecords(frame.records);
        part = { events: recordedEvents(reader, key, child, id, child), reads, checkedPv: frame.pv };
        order.parts.set(key, part); changed.push(part);
      }
      part.checkedPv = frame.pv;
    }
    if (removed.size || changed.length) {
      const kept = order.events.filter(event => !removed.has(event));
      // Startup combines all sources once; a child's change merges only that child's already sorted events.
      const added = changed.length === 1 ? changed[0]!.events : changed.flatMap(part => part.events).sort(compareHistoryEvents);
      const merged: HistoryEvent[] = [];
      let left = 0, right = 0;
      while (left < kept.length || right < added.length) {
        if (right >= added.length || left < kept.length && compareHistoryEvents(kept[left]!, added[right]!) <= 0)
          merged.push(kept[left++]!);
        else merged.push(added[right++]!);
      }
      order.events = merged;
    }
    // Retain recently opened Tasks; browsing history must not retain the whole workspace.
    this.orders.delete(id);
    this.orders.set(id, order);
    if (this.orders.size > 64) this.orders.delete(this.orders.keys().next().value!);
    return order.events;
  }

  read(frame: PublishedFrame, id: string, request: HistoryWindowRequest = { mode: 'latest' }): TaskHistoryWindowDTO {
    const window = historyWindow(this.events(frame, id), request);
    const named = new Set(window.events.flatMap(event => [event.taskId, ...(event.author?.kind === 'parent' ? [event.author.taskId] : []),
      ...(event.dependencies ? [...event.dependencies.after, ...event.dependencies.previous] : []),
      ...(event.askedTo && event.askedTo !== 'user' ? [event.askedTo] : []), ...(event.causes ?? []).map(cause => cause.taskId)]));
    const bundles = [...named].flatMap(key => {
      const bundle = frame.records.bundle(key);
      return bundle ? [bundle] : [];
    });
    const crews = historyCrews({ placements: bundles.flatMap(bundle => bundle.placements.map(placement =>
      ({ ...placement, responsible: placement.active && placement.responsible }))),
      runs: bundles.flatMap(bundle => bundle.runs.map(recordedRun)) }, named, window.events.at(-1)?.at, window.events[0]?.at);
    return { generation: frame.generation, sourcePv: frame.pv, ...window,
      tasks: Object.fromEntries(bundles.map(bundle => [bundle.task.id, { title: bundle.task.meta.title, parentId: bundle.task.meta.parentId,
        ...(crews.has(bundle.task.id) ? { crew: crews.get(bundle.task.id)! } : {}) }])) };
  }
}
