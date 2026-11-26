import { assertRunReservation } from '../release/journal.js';
import { savedReplyLanguage } from '../receiver/person-state.js';
/**
 * A Request to a Task's placement (W0): its admission selects the placement, carries the returns waiting for a
 * responsible, and commits one Run.
 */
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Problem, PROBLEM_CODE, type ProblemCode, type ProblemReason } from '@alpacawork/core';
import { aiStackPrefixSchema, currentReview, reviewTarget, startsEstimateRound } from '@alpacawork/contract';
import { DELIVERY_STATE, requestReceiptSchema, requestInputSchema,
  type RequestInput, type RequestReceipt } from '@alpacawork/contract/control';
import type { RunRecord } from '@alpacawork/contract/run';
import { RunStore, admittedDelivery, automaticLimitReached, checkRunLimits, isUnfinished,
  type NewRequest, type RunTransaction, type StoredRequest } from '@alpacawork/runs';
import { ControlStore } from '@alpacawork/db';
import { speaksForUser, type ChildObservations, type TaskActor } from '@alpacawork/raw';
import { FileWriter } from '../raw/storage.js';
import { assignedSession, launchIfResumable, readAgentsSettings } from '../agents-settings.js';
import { TaskRepository, TaskTree, controlSnapshotView } from './task-store.js';
import { readTaskContexts } from './task-context.js';
import { TaskTransition } from './task-transition.js';
import { ReturnLifecycle } from './return-lifecycle.js';
import { returnLinesOf } from './return-lines.js';
import { requestAuthor, requestBodyFits, startText } from './start-text.js';
import { databaseEstimateExamples } from './estimate-examples.js';
import { assertRotationResolved, continuationSessionUnavailable, conversationForRequest, handoffForRequest, rotationForRequest, suppliedSnapshotForRequest } from './conversation-context.js';
import { requestCompaction } from '../runs/compactions.js';
import { verifyRequestAttachments } from './task-files.js';
import { launchDirectory } from './launch-directory.js';
import { launchCwd } from './project-settings.js';
import { freezeAiStack } from '../ai-stack.js';
import { placementReason, priorResult, resultDecision, type DecisionOptions, type PlacementOptions } from './action-reasons.js';
import { initialPlacementValues } from './placement-launch-values.js';
import { requestAiPlan } from './request-ai.js';
import { deliverable, isServerRequest, seatFactsOf, seatSettings, seatSourceOf } from './wake.js';

/**
 * Who sends a Request, and what its admission does besides. A person, the coordinator or a placement's Run sends as
 * the actor authorize decided, which alone says who may send; admission checks the Task's facts only. A Run names
 * itself (`actorRunId`), and the Request's Run keeps it as its caller. The server goes on with a seat by itself
 * (purpose return_continuation) with the returns ReturnRouter drew for it.
 */
export type RequestContext = {
  onReplay?: (db: DatabaseSync) => void;
  onAdmitted?: (db: DatabaseSync, placementId: string, tx: RunTransaction,
    request: NewRequest, run: RunRecord) => void;
} & (
  | { purpose: 'instruction'; actor: TaskActor; actorRunId?: string; answersQuestion?: { id: string; title: string; state: 'answered' | 'withdrawn' };
    reasons?: DecisionOptions & PlacementOptions }
  | { purpose: 'return_continuation'; returnIds: readonly string[] });
function reject(code: ProblemCode, message: string, reason: ProblemReason,
  taskHash: string | null, revision: number | null, headId: string | null): never {
  throw new Problem(code, message, { currentTaskHash: taskHash, currentPlacementRevision: revision, currentHeadRunId: headId, preserveDraft: true }, { reason });
}
/** A placement's Request must name the Run of the placement that sends it. */
const noCallerRun = () => new Problem(PROBLEM_CODE.forbidden, "A placement's Request comes from a Run of the placement", undefined,
  { reason: { kind: 'placement_s_request_comes_from_run_placement' } });
function sameRequest(saved: StoredRequest, input: RequestInput): boolean {
  return saved.taskId === input.taskId &&
    (input.targetPlacementId === undefined || saved.placementId === input.targetPlacementId) &&
    saved.placementRevision === input.expectedPlacementRevision && saved.taskHash === input.expectedTaskHash &&
    (input.expectedHeadRunId === undefined || saved.headRunId === input.expectedHeadRunId) &&
    (input.mode === undefined || saved.mode === input.mode) && saved.body === input.body;
}
type AdmissionReceipt = RequestReceipt & { ignoredTaken?: true };
function receipt(saved: StoredRequest, run: RunRecord, context: RequestContext): AdmissionReceipt {
  const result = requestReceiptSchema.parse({ requestId: saved.id, placementId: saved.placementId, runId: run.id,
    deliveryState: saved.deliveryState, conversationRef: { provider: run.session?.provider ?? null,
      sessionId: run.session?.id ?? null, headRunId: saved.headRunId }, acceptedAt: saved.submittedAt });
  const ignoredTaken = context.purpose === 'instruction' && context.reasons?.taken !== undefined && !saved.reason?.taken;
  return { ...result, ...(ignoredTaken && { ignoredTaken: true }) };
}
/**
 * The Run of a saved Request, when `input` is a replay of it: the same input, author and launch choices. Anything else
 * under the ID is refused, and an aborted Request's ID is spent. A launch default is resolved once at admission, so a
 * replay compares only an explicit `cwd`.
 */
function replayedRun(saved: StoredRequest, input: RequestInput, context: RequestContext, author: TaskActor, cwd: string | undefined,
  taskHash: string | null, db: DatabaseSync, tx: RunTransaction): RunRecord {
  if (saved.deliveryState === DELIVERY_STATE.aborted)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request was aborted after a conflict; use a new operation ID', undefined,
      { reason: { kind: 'request_was_aborted_after_conflict_use_new_operation_id' } });
  const note = db.prepare('SELECT note_title,note_description FROM task_log WHERE request_id=?').get(saved.id);
  // Review is classified once from the admitted Task, not from its state on a later retry.
  const samePurpose = saved.purpose === context.purpose ||
    context.purpose === 'instruction' && saved.purpose === 'review_send_back';
  if (!sameRequest(saved, input) || !samePurpose ||
    (saved.answersQuestion ?? null) !== (context.purpose === 'instruction' ? context.answersQuestion?.id ?? null : null) ||
    (note?.note_title ?? null) !== (input.title ?? null) ||
    (note?.note_description ?? null) !== (input.description ?? null))
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID already has different input', undefined,
      { reason: { kind: 'request_id_already_has_different_input' } });
  if (!isDeepStrictEqual(saved.author, author))
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID belongs to another author', undefined, { reason: { kind: 'request_id_belongs_another_author' } });
  const { taken, placed } = saved.reason ?? {};
  const asked = context.purpose === 'instruction' ? context.reasons : undefined;
  // A decision without a result was ignored at admission. A retry compares only the decision that was kept.
  if (taken && (taken.code !== asked?.taken || (taken.cause ?? undefined) !== asked?.cause ||
    !isDeepStrictEqual(taken.aspects, asked?.aspects ?? []) || taken.note !== asked?.causeNote) ||
    placed?.code !== asked?.placedAs || placed?.note !== asked?.placedNote)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID already has different reasons', undefined,
      { reason: { kind: 'request_reasons_differ' } });
  const first = db.prepare('SELECT r.id,q.ai_prefix FROM requests q JOIN runs r ON r.request_id=q.id AND r.attempt=0 WHERE q.id=?').get(saved.id);
  const prefix = typeof first?.ai_prefix === 'string' ? aiStackPrefixSchema.parse(JSON.parse(first.ai_prefix)) : undefined;
  if (!isDeepStrictEqual(prefix, input.aiStack))
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID belongs to another AI stack');
  const run = first ? tx.get(`R${first.id}`) : null;
  if (!run) reject(PROBLEM_CODE.saveUnconfirmed, 'Request exists without a confirmed Run', { kind: 'request_exists_without_confirmed_run' }, taskHash, null, null);
  if (input.selected !== undefined && Object.entries(input.selected).some(([key, value]) => run.launch.values[key] !== value))
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID belongs to another launch choice', undefined,
      { reason: { kind: 'request_id_belongs_another_launch_choice' } });
  if (cwd !== undefined && cwd !== run.cwd)
    throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID belongs to another launch directory', undefined,
      { reason: { kind: 'request_id_belongs_another_launch_directory' } });
  return run;
}
/** Who a Request is recorded as from: the actor, or for a seat going on by itself, its own placement. */
function authorOf(context: RequestContext, targetPlacementId: string | undefined): TaskActor {
  if (context.purpose !== 'return_continuation') return context.actor;
  if (targetPlacementId === undefined || !context.returnIds.length)
    throw new Problem(PROBLEM_CODE.forbidden, 'Return continuation requires a destination and returns', undefined,
      { reason: { kind: 'return_continuation_requires_destination_and_returns' } });
  return { kind: 'placement', placementId: targetPlacementId };
}

export class RequestService {
  constructor(readonly root: string) {}
  async request(input: RequestInput, context: RequestContext): Promise<AdmissionReceipt> {
    return this.requestIn(input, context);
  }
  /** Admission inside an existing control transaction (closed-question answers use the same atomic write). */
  requestIn(input: RequestInput, context: RequestContext, connection?: DatabaseSync): AdmissionReceipt {
    if (!requestBodyFits(input.body))
      throw new Problem(PROBLEM_CODE.tooLarge, 'Request text exceeds 160 KiB', undefined, { reason: { kind: 'request_text_exceeds_160_kib' } });
    requestInputSchema.refine(value => context.purpose !== 'return_continuation' ||
      value.title === undefined && value.description === undefined,
      { path: ['title'], message: 'A return continuation has no Task note' }).parse(input);
    const cwd = input.cwd === undefined ? undefined : launchDirectory(this.root, input.cwd);
    // Whoever may instruct the placement chooses what its next Run starts with; automatic returns do not.
    if (input.selected !== undefined && context.purpose === 'return_continuation')
      throw new Problem(PROBLEM_CODE.invalidInput, 'Launch choices come with an instruction or a send-back', undefined,
        { reason: { kind: 'launch_choices_come_with_instruction_or_send_back_field_left_out_keeps_conversation_s_value' } });
    const author = authorOf(context, input.targetPlacementId);
    const fromPlacement = context.purpose !== 'return_continuation' && context.actor.kind === 'placement';
    if (fromPlacement && context.actorRunId === undefined) throw noCallerRun();
    const writer = new FileWriter(this.root), control = connection ? null : new ControlStore(this.root);
    let store: RunStore | undefined;
    let result: AdmissionReceipt;
    try {
      const write = <T>(action: (db: DatabaseSync) => T): T => connection ? action(connection) : control!.write(action);
      result = write(db => {
        // The Task's own project is what an admission reads (`TaskRepository.projectFor`).
        const tasks = new TaskRepository(this.root, db), project = tasks.projectFor(input.taskId);
        const snapshot = tasks.related(input.taskId);
        const task = snapshot.tasks.find(item => item.id === input.taskId);
        // Placement writes hold this Task lock, so this read agrees with the transaction below.
        store = new RunStore(this.root, { busyTimeoutMs: 10_000 }, false, db);
        const runSnapshot = store.snapshot(project, snapshot.tasks.map(task => task.id)), allRuns = runSnapshot.records;
        if (!allRuns) throw runSnapshot.runError;
        const requestsById = new Map(runSnapshot.requests.map(request => [request.id, request]));
        const saved = store.write(tx => {
          const callerRun = context.purpose === 'return_continuation' || context.actorRunId === undefined
            ? null : tx.get(context.actorRunId);
          if (fromPlacement && !callerRun) throw noCallerRun();
          const previous = tx.getRequest(input.requestId);
          if (previous) {
            const existingRun = replayedRun(previous, input, context, author, cwd, task?.hash ?? null, db, tx);
            context.onReplay?.(db);
            return { request: previous, run: existingRun };
          }
          assertRunReservation(this.root);
          if (db.prepare('SELECT 1 FROM task_log WHERE id=?').get(input.requestId))
            throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Request ID belongs to a Task decision', undefined, { reason: { kind: 'request_id_belongs_task_decision' } });
          if (!task || task.meta.lifecycle !== 'active')
            throw new Problem(PROBLEM_CODE.notFound, 'Active task does not exist', undefined, { reason: { kind: 'active_task_does_not_exist' } });
          verifyRequestAttachments(writer, task.id, input.requestId, input.body, db);
          // All owner instructions invalidate a review at admission through TaskTransition.
          const serverRequest = context.purpose === 'return_continuation' &&
            isServerRequest(runSnapshot.returns.filter(row => context.returnIds.includes(row.id)));
          const settings = readAgentsSettings(this.root);
          if (!settings.ok) throw settings.error;
          const limits = settings.config.limits;
          const placement = input.targetPlacementId
            ? tx.getPlacement(input.targetPlacementId) : tx.responsiblePlacement(input.taskId);
          if (!placement) reject(PROBLEM_CODE.responsibleMissing, 'Task needs a responsible placement', { kind: 'task_needs_responsible_placement' }, task.hash, null, null);
          if (!placement.active || placement.taskId !== task.id)
            reject(PROBLEM_CODE.conflict, 'Target is not a current placement of the Task', { kind: 'target_not_current_placement_task' }, task.hash, placement.revision, null);
          if (context.purpose === 'return_continuation') {
            if (!placement.responsible)
              reject(PROBLEM_CODE.handoffPending, 'Return destination changed', { kind: 'return_destination_changed' }, task.hash, placement.revision, null);
            // The router chose the wake at its own read point; the seat's facts now decide it again, and which returns go.
            const seat = seatFactsOf(seatSourceOf(snapshot.tasks, { ...runSnapshot,
              records: tx.returnRuns(project, snapshot.tasks.map(task => task.id)) }, seatSettings(settings)), task.id);
            const wake = deliverable(seat, seat.pending);
            if (wake.block) reject(PROBLEM_CODE.conflict, `Return seat cannot resume: ${wake.block.code}`, wake.block.human && wake.block.problemReason ? wake.block.problemReason : { kind: 'return_seat_cannot_resume', wakeBlockCode: String(wake.block.code) }, task.hash, placement.revision, null);
            if (!isDeepStrictEqual(new Set(wake.rows.map(row => row.id)), new Set(context.returnIds)))
              reject(PROBLEM_CODE.conflict, 'Returns changed before admission', { kind: 'returns_changed_before_admission' }, task.hash, placement.revision, null);
          }
          // Read receipt facts before a person's retry resolves unknown inputs in this transaction.
          const rotation = placement.responsible ? rotationForRequest({ store: store!, runs: tx }, task.id, placement.id) : null;
          const resolvesUnknown = context.purpose !== 'return_continuation' && placement.responsible && speaksForUser(context.actor);
          assertRotationResolved(rotation, resolvesUnknown, input.mode);
          const lifecycle = new ReturnLifecycle(db, tx, snapshot.tasks, project, undefined, this.root);
          // On the user's behalf, what the responsible may not have taken goes again, ending the queued Runs it rode in,
          // before the conversation is read: this Request neither waits for nor resumes them.
          if (resolvesUnknown) lifecycle.resendUnconfirmed(task.id, placement.id);
          const runs = tx.conversationRuns(placement.id);
          const head = tx.conversationHead(placement.id);
          const refuse: (code: ProblemCode, message: string, reason: ProblemReason) => never = (code, message, reason) =>
            reject(code, message, reason, task.hash, placement.revision, head?.id ?? null);
          if (task.hash !== input.expectedTaskHash || placement.revision !== input.expectedPlacementRevision)
            refuse(PROBLEM_CODE.conflict, 'Task or placement changed; reload before retrying', { kind: 'task_or_placement_changed' });
          if (input.compact && !head)
            refuse(PROBLEM_CODE.notResumable, 'There is no conversation to compact yet', { kind: 'compaction_without_conversation' });
          if (input.expectedHeadRunId !== undefined && input.expectedHeadRunId !== (head?.id ?? null))
            refuse(PROBLEM_CODE.conflict, 'Conversation head changed; reload before retrying', { kind: 'conversation_head_changed' });
          const plan = requestAiPlan(db, settings.config, placement, input, head, runs);
          const profile = plan.agent;
          const setting = settings.config.agents[profile];
          const handoff = placement.responsible ? handoffForRequest({ store: store!, runs: tx }, task, placement.id, runs) : null;
          const facts: Parameters<typeof conversationForRequest>[0] = { rotation, handoff, resolvesUnknown,
            agent: plan.continuationAgent, explicit: input.compact ? 'continue' : input.mode, head, direct: !fromPlacement,
            resume: setting && setting.enabled !== false ? 'available' : 'profile_unavailable' };
          const preferred = conversationForRequest(facts);
          const snapshotLaunch = (mode: 'new' | 'continue') => plan.snapshot(mode, process.env.PATH ?? '',
            () => initialPlacementValues(task.meta.log, placement.id, tx.runsOfTask(task.id), input.mode));
          const automaticReset = context.purpose === 'return_continuation' && plan.returnsToConfiguredValues &&
            preferred.mode === 'continue';
          const preparedResume = automaticReset ? launchIfResumable(() => snapshotLaunch('continue')) : undefined;
          const { mode, rotationFrom, unsentNew, newConversation } = automaticReset && !preparedResume
            ? conversationForRequest({ ...facts, resume: 'choices_unavailable' }) : preferred;
          // A compaction continues the same conversation, as the sender asked or as the seat's last report prepared it.
          // Asked for, it follows the rules of a new conversation: it is no reservation for after a Run ends.
          if (input.compact && mode !== 'continue')
            refuse(PROBLEM_CODE.notResumable, 'This request starts a new conversation (another AI, or an unsent new one), so there is nothing to compact',
              { kind: 'compaction_with_new_conversation' });
          if (input.compact && runs.some(isUnfinished))
            refuse(PROBLEM_CODE.handoffPending, 'Cannot compact the conversation while a Run is unfinished',
              { kind: 'cannot_compact_while_run_unfinished' });
          const compaction = input.compact ?? (mode === 'continue' ? handoff?.compact : null) ?? null;
          if (unsentNew && input.mode === 'continue')
            refuse(PROBLEM_CODE.notResumable, 'An unsent new conversation cannot resume', { kind: 'conversation_session_unavailable' });
          if (mode === 'continue' && cwd !== undefined && cwd !== head?.cwd)
            throw new Problem(PROBLEM_CODE.invalidInput, 'A continued conversation must use the previous Run directory', undefined,
              { reason: { kind: 'continued_conversation_must_use_previous_run_directory' }, issues: [{ path: 'cwd', code: 'incompatible',
                message: 'A continued conversation must use the previous Run directory' }] });
          if (mode === 'continue' && !head)
            refuse(PROBLEM_CODE.notResumable, 'There is no conversation to continue', { kind: 'there_no_conversation_continue' });
          // A placement's Request and a seat's own continuation are automatic: they count toward the placement's limit.
          if (fromPlacement || context.purpose === 'return_continuation') {
            const ancestry = [task, ...new TaskTree(snapshot.tasks).ancestors(task.id)].map(item => item.id);
            if (automaticLimitReached(runSnapshot.requests, placement.id, ancestry, limits.automatic_per_placement))
              refuse(PROBLEM_CODE.automaticLimit, 'Automatic requests reached the placement limit', { kind: 'automatic_requests_reached_placement_limit' });
          }
          if (head?.state === 'needs_review' || head?.reason === 'conversation_busy')
            refuse(head.reason === 'conversation_busy' ? PROBLEM_CODE.conversationBusy : PROBLEM_CODE.handoffPending, 'Conversation requires review before another request', { kind: 'conversation_requires_review_before_another_request' });
          if (mode === 'new' && runs.some(isUnfinished))
            refuse(PROBLEM_CODE.handoffPending, 'Cannot start a new conversation while a Run is unfinished', { kind: 'cannot_start_new_conversation_while_run_unfinished' });
          if (mode === 'continue' && head && continuationSessionUnavailable(head))
            refuse(PROBLEM_CODE.notResumable, 'Conversation session is unavailable', { kind: 'conversation_session_unavailable' });
          // A seat going on by itself is called by the Task's last owner Run at any placement (not a joined one, nor
          // one whose Request was withdrawn), so it adds no depth and a stop of that Run reaches it.
          const caller = context.purpose === 'return_continuation'
            ? tx.runsOfTask(task.id).filter(run => run.role === 'owner' && run.state !== 'joined' &&
              requestsById.get(run.requestId)?.deliveryState !== DELIVERY_STATE.aborted).map(run => ({ run: run.id })).at(-1) ?? null
            : callerRun ? { run: callerRun.id } : null;
          // The authorized caller, current settings, and committed Run graph are
          // all known here. Decide before inserting a Request or staging a Run.
          const limit = checkRunLimits(tx.forAdmission(caller?.run), { caller, continues: context.purpose === 'return_continuation',
            task: task.id, role: placement.responsible ? 'owner' : 'worker',
            resumes: mode === 'continue' ? head!.id : null }, limits);
          if (limit === PROBLEM_CODE.tooDeep) refuse(limit, 'This request would exceed the allowed child-run depth; continue in an existing run or simplify the delegation chain.',
            { kind: 'request_would_exceed_allowed_child_run_depth_continue_existing_run_or_simplify_delegation_chain' });
          if (limit) refuse(limit, 'This parent has reached its total child-run limit; completed children still count toward this limit.',
            { kind: 'parent_has_reached_total_child_run_limit_completed_children_still_count_toward_limit' });
          const launch = preparedResume ?? snapshotLaunch(mode);
          if (!launch.ok) refuse(launch.code === 'not_resumable' ? PROBLEM_CODE.notResumable : PROBLEM_CODE.responsibleMissing, 'Responsible profile cannot launch this request', { kind: 'responsible_profile_cannot_launch_request' });
          const session = mode === 'continue' ? head!.session : assignedSession(launch.launch, profile);
          const deliveryState = admittedDelivery(mode === 'continue', session, runs);
          // A placement's Request waits in its sender's wait cycle: the calling Run's Task.
          const waitCycleId = fromPlacement && callerRun ? lifecycle.cycleFor(callerRun.task) : null;
          const unfinished = tx.unfinishedIn([task.id]).length !== 0;
          const review = context.purpose === 'instruction' && !context.answersQuestion && placement.responsible &&
            speaksForUser(context.actor) && currentReview(task.meta, unfinished) !== null;
          const aboutRun = review ? reviewTarget(task.meta, head, unfinished) : null;
          const reasons = context.purpose === 'instruction' && !context.answersQuestion ? context.reasons ?? {} : undefined;
          const placed = reasons && placementReason(reasons, author, input.selected !== undefined || input.aiStack !== undefined);
          const taken = reasons && resultDecision(reasons, author,
            priorResult(tx, task, placement.id, author, callerRun?.task ?? null, aboutRun));
          const request: NewRequest = { id: input.requestId, taskId: task.id, placementId: placement.id,
            placementRevision: placement.revision, taskHash: task.hash, waitCycleId, headRunId: head?.id ?? null,
            aboutRunId: aboutRun,
            ...(taken || placed ? { reason: { ...(taken && { taken }), ...(placed && { placed }) } } : {}),
            mode, body: input.body, purpose: review ? 'review_send_back' : context.purpose, author,
            submittedAt: new Date().toISOString(), deliveryState,
            aiExplicit: input.aiStack !== undefined || Object.keys(input.selected ?? {}).length > 0,
            aiPrefix: input.aiStack,
            aiStack: freezeAiStack(settings.config, { agent: profile, values: launch.launch.values },
              plan.following),
            answersQuestion: context.purpose === 'instruction' ? context.answersQuestion?.id ?? null : null };
          // Project inherited work before inserting this admission: its Request has no Run/caller witness yet.
          const openObligations = placement.responsible ? lifecycle.openObligations(task.id) : undefined;
          tx.insertRequest(request);
          // A continuation reserves the pending returns the router drew at its read point, even while other Requests
          // remain open. Carried returns wait for a Request to the seat.
          // Any other Request to a responsible, and the server's own (W0, the same serverRequest admission decided on),
          // carries what else waits for the seat; a worker's carries nothing.
          const reserved = context.purpose === 'return_continuation' ? context.returnIds : [];
          if (context.purpose === 'return_continuation' && !lifecycle.reserve(reserved, request.id))
            refuse(PROBLEM_CODE.conflict, 'Returns changed before admission', { kind: 'returns_changed_before_admission' });
          const carries = context.purpose === 'return_continuation' ? serverRequest : placement.responsible;
          if (carries) lifecycle.carry(task.id, request.id);
          const carriedRows = carries ? tx.returns(project, [task.id]).filter(row => !reserved.includes(row.id) &&
            row.deliveries.some(delivery => delivery.wakeRequestId === request.id && delivery.releasedAt === null)) : [];
          // What changed below since the conversation's previous Request; a new conversation starts from nothing.
          const lastRun = mode === 'continue' ? runs.at(-1) : undefined;
          const since = lastRun ? requestsById.get(lastRun.requestId)?.submittedAt ?? null : null;
          // The start text shows the records this admission decided on, before its own Run exists.
          const estimateExamples = databaseEstimateExamples(this.root, db, { agent: profile, values: launch.launch.values }, project);
          const admitted = new TaskTransition().appendRequestReference({ store: store!, runs: tx }, task.id, request.id, input);
          const admittedTasks = snapshot.tasks.map(item => item.id === task.id ? admitted : item);
          const body = context.purpose === 'instruction' && context.answersQuestion
            ? `This message was sent as a reply to the ${context.answersQuestion.state === 'withdrawn' ? 'withdrawn' : 'answered'} question ${context.answersQuestion.id} "${context.answersQuestion.title}". Full text of the question: alpacawork task get --task ${task.id} --question ${context.answersQuestion.id}\n\n${input.body}`
            : input.body;
          const children: ChildObservations = {};
          let suppliedSnapshot: string | undefined;
          const needsOpenWork = placement.responsible && (mode === 'new' || carriedRows.some(row => row.outcome === 'handover') ||
            reserved.some(id => tx.getReturn(id)?.outcome === 'handover'));
          const admittedTree = new TaskTree(admittedTasks);
          const prompt = startText({ source: { tasks: controlSnapshotView({ ...snapshot, tasks: admittedTasks }).tasks,
            tree: admittedTree, contexts: readTaskContexts(db, admittedTree), runRecords: allRuns, errors: [],
            estimates: () => estimateExamples }, taskId: task.id,
          responsible: placement.responsible, mode, replyLanguage: savedReplyLanguage(this.root),
          author: requestAuthor(context.purpose, author.kind, placement.responsible), at: request.submittedAt.replace(/\.\d{3}Z$/, 'Z'), body,
          condition: { agent: profile, values: launch.launch.values },
          voidsEstimate: startsEstimateRound(request, { role: placement.responsible ? 'owner' : 'worker' }), since,
          carried: returnLinesOf(lifecycle, carriedRows),
          ...(needsOpenWork ? { openObligations } : {}),
          ...(placement.responsible ? { observedChildren: children, childVersions: handoff?.checkpoint.children,
            previousChildren: lastRun?.context?.children,
            heldSnapshot: mode === 'continue' && head ? suppliedSnapshotForRequest({ store: store!, runs: tx }, head, runs) : undefined,
            onSnapshotSupplied: version => { suppliedSnapshot = version; } } : {}) });
          const run = tx.create({ task: task.id, placementId: placement.id, requestId: request.id,
            agent: profile, role: placement.responsible ? 'owner' : 'worker', resumes: mode === 'continue' ? head!.id : null,
            ...(newConversation ? { newConversation } : {}), continues: false, session, caller,
            ...(placement.responsible ? { context: { children,
              ...(suppliedSnapshot ? { suppliedSnapshot } : {}),
              ...(handoff ? { snapshotFrom: handoff.id } : {}),
              ...(rotationFrom ? { rotationFrom } : {}) } } : {}),
            cwd: mode === 'continue' ? head!.cwd : cwd ?? launchCwd(this.root, db, task.id),
            launch: launch.launch }, prompt);
          if (compaction) requestCompaction(db, run, compaction.focus, input.compact !== undefined, request.submittedAt);
          new TaskTransition().captureStartGrant({ store: store!, runs: tx }, task.id, request.id, author);
          context.onAdmitted?.(db, placement.id, tx, request, run);
          return { request: tx.getRequest(request.id)!, run };
        });
        return receipt(saved.request, saved.run, context);
      });
    } finally { store?.close(); control?.close(); writer.close(); }
    return result;
  }
}
