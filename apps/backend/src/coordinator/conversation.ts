import { assertRunReservation } from '../release/journal.js';
/**
 * The screen's coordinator conversation, one open at a time (`coordinator_conversations`). Each conversation Request
 * has a coordinator Run, or is aborted without a Run when cancelled before admission. The Run layer queues, starts,
 * takes in, times out and ends coordinator Runs as it does any Run. This admits, withdraws, sends now and clears
 * messages; conversation-view.ts draws those records, with no second copy. Person-state owns conversation-scoped
 * answer observations.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { Problem, PROBLEM_CODE, parseInput } from '@alpacawork/core';
import { ControlStore, touch } from '@alpacawork/db';
import { resolveAgentLaunchArgv } from '@alpacawork/contract/agent-launch';
import { DEFAULT_LIMITS } from '@alpacawork/contract';
import { DELIVERY_STATE } from '@alpacawork/contract/control';
import { coordinatorRunRecordSchema, type CoordinatorRunRecord } from '@alpacawork/contract/run';
import { inputUnsettled } from '@alpacawork/contract/run-protocol';
import type { coordinatorMessageInputSchema, CoordinatorConversation as ConversationView,
  CoordinatorMessage, CoordinatorReadAck, CoordinatorSnapshot } from '@alpacawork/contract/coordinator';
import { coordinatorMessageContent, coordinatorMessageDigest, coordinatorReadInputSchema } from '@alpacawork/contract/coordinator';
import { RunStore, admittedDelivery, currentRequestRun, isUnfinished, type RunTransaction } from '@alpacawork/runs';
import { authorize } from '../control/authorize.js';
import { TaskRepository } from '../control/task-store.js';
import { assertQuestionReplyApplicable, questionSnapshot, replyQuestion } from '../control/question-rules.js';
import { assignedSession, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { agentEnvironment } from '../runs/env.js';
import { StopDeliveryOwner, coordinatorCwd } from '../runs/execution-control.js';
import { createCoordinatorReadState } from '../receiver/person-state.js';
import { assertSkillInvocations, coordinatorSkills } from './skills.js';
import { coordinatorInputText, coordinatorLaunchFor, coordinatorReplyLanguage, coordinatorTurnNumber, prepareCoordinatorStart } from './continuation.js';
import { activeCoordinatorRuns, visible } from './requests.js';
import { coordinatorBoundary, coordinatorResetMemo, pendingCoordinatorReset, replayCoordinatorReset, reserveCoordinatorReset } from './resets.js';
import { assertManagedSkillsVersion } from './managed-skills-version.js';
import { admittedMessageDigest, completedAnswer, coordinatorBusy, failedRun, handovers, historyPage, messageStatus, recentReadableIds, view, type Conversation } from './conversation-view.js';
import { actedTasks } from './messages.js';
import { replySource, replyPrompt } from './reply.js';
import { coordinatorAttachmentFile, coordinatorFolders, coordinatorRequestId, discardCoordinatorFiles } from './files.js';
import { readRecentWork } from '../runs/recent-work.js';
import { readRunActivityView } from '../agents/context-limits.js';
import { runFolder, tookSteps } from '@alpacawork/contract/run';
import type { ControlIndexDTO } from '@alpacawork/contract/control';

type Message = z.output<typeof coordinatorMessageInputSchema>;
const OPTIONS = { busyTimeoutMs: 10_000 };

/** The open conversation, if there is one yet. */
function current(db: DatabaseSync): Conversation | null {
  const row = db.prepare('SELECT id FROM coordinator_conversations WHERE cleared_at IS NULL').get();
  return row ? { id: String(row.id) } : null;
}
function begin(db: DatabaseSync): Conversation {
  const conversation = { id: randomUUID() };
  db.prepare('INSERT INTO coordinator_conversations(id, started_at) VALUES (?, ?)').run(conversation.id, new Date().toISOString());
  touch(db, { kind: 'conversation', id: conversation.id });
  return conversation;
}
/** The conversation the screen names, which must be the open one: a screen that read it before a clear is refused. */
function opened(db: DatabaseSync, id: string): Conversation {
  const conversation = current(db);
  if (conversation?.id !== id) throw new Problem(PROBLEM_CODE.conflict, 'Conversation has changed', undefined, { reason: { kind: 'conversation_has_changed' } });
  return conversation;
}
/** The Request under a message ID, whichever conversation or Task it went to. */
function sent(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT conversation_id, delivery_state, coordinator_turn_no, coordinator_files_expired_at FROM requests WHERE id = ?').get(id);
  return row ? { conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    turn: row.coordinator_turn_no, filesExpired: row.coordinator_files_expired_at !== null, withdrawn: row.delivery_state === DELIVERY_STATE.aborted } : null;
}
/** A message in this conversation and its Run; null once it was withdrawn. */
function shown(db: DatabaseSync, tx: RunTransaction, conversation: Conversation, id: string): CoordinatorRunRecord | null {
  const request = sent(db, id);
  if (!request || request.conversationId !== conversation.id || !request.withdrawn && request.turn === null)
    throw new Problem(PROBLEM_CODE.notFound, 'Coordinator message is not in this conversation', undefined, { reason: { kind: 'coordinator_message_not_conversation' } });
  if (request.withdrawn) return null;
  const row = db.prepare(currentRequestRun('?')).get(id);
  const run = row ? tx.runtimeGet(`R${row.id}`) : null;
  if (run?.role !== 'coordinator') throw new Error(`Coordinator message ${id} has no Run`);
  return run;
}
/**
 * What the coordinator is given for a message: its words, what a press meant, the questions
 * the words answer, the files.
 */
function launchText(id: string, message: CoordinatorMessage, body: string, files: readonly (readonly [string, string])[]) {
  return [`Request ID of this input: ${id}. Add --source-request ${id} to the records of what you do for this input.`, body,
    message.intent === null ? '' : `Screen action: ${JSON.stringify(message.intent)}`,
    message.answers === undefined ? '' : `Questions being answered: ${JSON.stringify(message.answers)}`,
    ...files.map(([name, file]) => `![${name}](${file})`)].filter(Boolean).join('\n');
}
export class CoordinatorConversation {
  private readonly observations;
  /** A derived pointer refreshed with the same DB snapshot as the conversation, never a second Run state. */
  private running: CoordinatorRunRecord | null = null;
  constructor(private readonly root: string, private readonly readChanged: () => void = () => {}) {
    this.observations = createCoordinatorReadState(root);
  }
  /** A personal-file replacement invalidates the same conversation digest as a control commit. */
  seenRevision(): string | null { return this.observations.revision(); }
  private project(db: DatabaseSync, store: RunStore, conversation: Conversation, settings = readAgentsSettings(this.root)): ConversationView {
    const active = activeCoordinatorRuns(db, conversation.id);
    this.running = active.find(run => run.state === 'running') ?? null;
    const history = view(db, store, conversation, this.seen(conversation.id), active);
    const next = settings.ok ? coordinatorLaunchFor(db, settings.config, conversation.id) : null;
    const limits = settings.ok ? settings.config.limits : DEFAULT_LIMITS;
    const ended = pendingCoordinatorReset(db, conversation.id) ? null : db.prepare(`SELECT r.record FROM requests q
      JOIN runs r ON r.id=(${currentRequestRun('q.id')}) WHERE q.conversation_id=?
      AND ${visible} AND q.coordinator_turn_no>=?
      AND r.state IN ('succeeded','failed','cancelled') ORDER BY q.coordinator_turn_no DESC LIMIT 1`)
      .get(conversation.id, coordinatorBoundary(db, conversation.id));
    const run = ended ? coordinatorRunRecordSchema.parse(JSON.parse(String(ended.record))) : null;
    return { ...history, nextLaunch: next?.row ? { agent: next.row.agent, values: next.appliedValues } : null,
      context: run ? readRunActivityView(this.root, run)?.context ?? null : null,
      autoReset: { tokens: limits.coordinator_reset_tokens, percent: limits.coordinator_reset_percent } };
  }
  /** Only this small projection is sampled for stdout changes. */
  work(): ControlIndexDTO['coordinatorWork'] {
    const run = this.running;
    if (!run) return null;
    const label = readRecentWork(runFolder(this.root, run.id)), activity = readRunActivityView(this.root, run);
    const steps = activity?.steps ?? [], words = activity?.note?.text ?? null, context = activity?.context ?? null;
    return label || steps.length || words || context || tookSteps(activity) ? {
      conversation: run.conversationId, turn: run.requestId, run: run.id, context,
      name: label?.name ?? null, count: label?.count ?? 0, steps, stepEvents: activity?.stepEvents ?? 0,
      stepsStarted: activity?.stepsStarted ?? 0, words } : null;
  }
  private seen(conversationId: string): ReadonlySet<string> {
    const observed = this.observations.get()?.value;
    return new Set(observed?.conversationId === conversationId ? observed.seen : []);
  }
  /** Seeds a fresh reader and trims existing observations at startup, before recovery can finish another reply. */
  async seedSeen(): Promise<void> {
    await this.observations.change(saved => this.control(true, db => {
      const conversation = current(db) ?? begin(db);
      const eligible = recentReadableIds(db, conversation.id);
      const seen = !saved ? eligible : saved.conversationId === conversation.id
        ? eligible.filter(id => saved.seen.includes(id)) : [];
      return { conversationId: conversation.id, seen: seen.sort() };
    }));
  }
  async markSeen(conversationId: string, seen: readonly string[]): Promise<CoordinatorReadAck> {
    const input = parseInput(coordinatorReadInputSchema, { conversationId, seen: [...seen] });
    const ids = [...new Set(input.seen)].sort();
    let before: string | null | undefined;
    try {
      await this.observations.change((saved, revision) => this.control(false, db => {
        before = revision;
        const conversation = opened(db, input.conversationId);
        if (ids.some(id => !completedAnswer(db, conversation.id, id)))
          throw new Problem(PROBLEM_CODE.invalidInput, 'Seen IDs must identify completed answers in this conversation', undefined,
            { reason: { kind: 'coordinator_seen_ids_must_be_completed_answers' } });
        const union = new Set(saved?.conversationId === conversation.id ? saved.seen : []);
        for (const id of ids) union.add(id);
        return { conversationId: conversation.id, seen: recentReadableIds(db, conversation.id).filter(id => union.has(id)).sort() };
      }));
      return { conversationId: input.conversationId, seen: ids };
    } finally {
      if (before !== undefined && before !== this.seenRevision()) this.readChanged();
    }
  }
  /** A write borrows one control transaction for conversation rows, Requests, and Runs. */
  private control<T>(write: boolean, work: (db: DatabaseSync, store: RunStore) => T): T {
    const control = new ControlStore(this.root, OPTIONS, !write);
    let store: RunStore | undefined;
    try {
      const run = (db: DatabaseSync) => work(db, store = new RunStore(this.root, OPTIONS, !write, db));
      return write ? control.write(run) : control.read(run);
    } finally { store?.close(); control.close(); }
  }
  turns(input: { conversationId: string; before?: string; around?: string }) {
    return this.control(false, (db, store) => {
      const id = opened(db, input.conversationId).id;
      return historyPage(db, store, id, input, this.seen(id));
    });
  }
  messageStatus(id: string) {
    coordinatorRequestId(id);
    return this.control(false, db => messageStatus(db, current(db)?.id ?? '', id));
  }
  resetMemo(id: string) {
    return this.control(false, db => coordinatorResetMemo(db, current(db)?.id ?? '', id));
  }
  reset(conversationId: string, operation: string) {
    return this.control(true, (db, store) => {
      const conversation = opened(db, conversationId);
      const saved = replayCoordinatorReset(db, conversationId, operation);
      if (!saved && coordinatorBusy(db, store, conversationId))
        throw new Problem(PROBLEM_CODE.coordinatorBusy, 'The coordinator can be reset after its reply');
      const reset = saved ?? reserveCoordinatorReset(db, conversationId, { kind: 'asked' }, new Date().toISOString(), operation);
      return { conversation: this.project(db, store, conversation), reset };
    });
  }
  /** One object supplies the response, identity and digest; no second read or stored view. */
  snapshot(generation: string, conversation = this.read()): CoordinatorSnapshot {
    return { root: this.root, generation, revision: createHash('sha256').update(JSON.stringify(conversation)).digest('hex'), conversation };
  }
  /** The open conversation; the first read of a workspace opens one. */
  read(): ConversationView {
    return this.control(false, (db, store) => { const conversation = current(db); return conversation && this.project(db, store, conversation); })
      ?? this.control(true, (db, store) => this.project(db, store, current(db) ?? begin(db)));
  }
  async skills(conversationId: string) {
    const settings = readAgentsSettings(this.root);
    if (!settings.ok) return { status: 'unavailable', profile: '', skills: [], reason: 'settings' };
    const next = this.control(false, db => coordinatorLaunchFor(db, settings.config, opened(db, conversationId).id));
    if (next.row === null) return { status: 'unavailable', profile: '', skills: [], reason: 'launch' };
    const { launch } = next, session = next.continued?.session?.id ?? null;
    return coordinatorSkills({ profile: next.row.agent, adapter: launch.adapter, root: this.root,
      argv: resolveAgentLaunchArgv(launch, { session: session ?? 'catalog-session', result: 'catalog-result' }),
      env: agentEnvironment(process.env, launch.path, undefined, launch.env), session });
  }
  /**
   * Queues one message: its Request and the coordinator Run that answers it, in one transaction, with what the agent is
   * given (`text`) fixed now. It goes on in the conversation's agent session when it can, else starts one.
   */
  private queue(db: DatabaseSync, tx: RunTransaction, config: AgentsSettings, conversation: Conversation,
    input: { id: string; body: string; message: CoordinatorMessage; replyTo?: string | null; text: string }) {
    const head = tx.coordinatorHead(conversation.id), active = activeCoordinatorRuns(db, conversation.id);
    const next = coordinatorLaunchFor(db, config, conversation.id);
    if (next.row === null) throw next.error;
    const { launch, continued } = next, agent = next.row.agent;
    const captured = { text: input.text, language: coordinatorReplyLanguage(this.root) };
    const text = coordinatorInputText(captured);
    if (input.message.skills?.length) {
      assertSkillInvocations(launch.adapter, input.body, input.message.skills);
      assertManagedSkillsVersion(input.message.skills);
    }
    const session = continued ? continued.session : assignedSession(launch, agent);
    assertRunReservation(this.root);
    tx.insertConversationRequest({ id: input.id, conversationId: conversation.id, headRunId: head?.id ?? null,
      mode: continued ? 'continue' : 'new', body: input.body, replyTo: input.replyTo, submittedAt: new Date().toISOString(),
      deliveryState: admittedDelivery(!!continued, session, active), coordinatorInput: captured,
      aiStack: [next.row, ...next.following] });
    // Validate that the input can still start if the current session ends before it reaches the head of the queue.
    if (!prepareCoordinatorStart(db, conversation.id, coordinatorTurnNumber(db, input.id), [captured]))
      throw new Problem(PROBLEM_CODE.tooLarge, 'Coordinator message is too large', undefined, { reason: { kind: 'coordinator_message_too_large' } });
    tx.createCoordinatorRun({ conversationId: conversation.id, requestId: input.id, agent, resumes: continued?.id ?? null,
      session, cwd: coordinatorCwd(this.root), launch, message: input.message }, text);
  }
  /**
   * Admits a message. Its words are the screen's own (the Request's body); an intent goes with them as it is, and the
   * screen's Task by its ID. A cancelled ID always stays cancelled, regardless of later payload.
   * Otherwise the same ID must carry exactly the same input.
   */
  ask(input: Message): ConversationView {
    coordinatorRequestId(input.id);
    const settings = readAgentsSettings(this.root);
    return this.control(true, (db, store) => {
      const conversation = opened(db, input.conversationId);
      const message = coordinatorMessageContent(input);
      store.write(tx => {
        const previous = sent(db, input.id);
        if (previous) {
          const ours = previous.conversationId === conversation.id;
          if (ours && previous.withdrawn) return;
          const same = ours && previous.turn !== null &&
            admittedMessageDigest(db, conversation.id, input.id) === coordinatorMessageDigest(input);
          if (!same) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Message ID belongs to different input', undefined, { reason: { kind: 'message_id_belongs_different_input' } });
          return;
        }
        if (message.retryOf !== undefined) {
          // A failed message is sent again once: the one sent in its place answers for it, and is what is sent again next.
          const original = shown(db, tx, conversation, message.retryOf);
          if (!original || !failedRun(original))
            throw new Problem(PROBLEM_CODE.conflict, 'Only a failed message can be sent again', undefined, { reason: { kind: 'message_has_already_been_sent' } });
          if (db.prepare(`SELECT 1 FROM runs r JOIN requests q ON q.id=r.request_id
            WHERE r.conversation_id=? AND r.conversation_id IS NOT NULL AND json_extract(r.record,'$.message.retryOf')=?
              AND q.delivery_state <> 'aborted'`).get(conversation.id, message.retryOf))
            throw new Problem(PROBLEM_CODE.conflict, 'Message has already been sent again', undefined, { reason: { kind: 'message_already_sent_again' } });
        }
        if (!settings.ok) throw settings.error;
        const acted = [...actedTasks(message)];
        const present = new Set(acted.length ? db.prepare(`SELECT external_id FROM tasks
          WHERE external_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(acted)).map(row => String(row.external_id)) : []);
        for (const task of acted)
          if (!present.has(task))
            throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', { task }, { reason: { kind: 'task_does_not_exist' } });
        const tasks = new TaskRepository(this.root, db);
        for (const reference of message.answers ?? []) {
          const task = tasks.get(reference.task), question = replyQuestion(task.id, task.meta.log, reference.question);
          authorize(db, { kind: 'human' }, { name: 'task.answer', askedTo: question.asked.askedTo,
            closed: question.closing !== null }, { task: task.id, quote: null });
          assertQuestionReplyApplicable(task.id, question, questionSnapshot(tasks.related(task.id).tasks));
        }
        const reply = input.replyTo ? replySource(db, conversation.id, input.replyTo) : null;
        const files = message.attachments.map(name => [name, coordinatorAttachmentFile(this.root, conversation.id, input.id, name)] as const);
        this.queue(db, tx, settings.config, conversation, { id: input.id, body: input.text, message, replyTo: input.replyTo,
          text: [reply ? replyPrompt(reply) : '',
            launchText(input.id, message, input.text, files)].filter(Boolean).join('\n') });
      });
      return this.project(db, store, conversation, settings);
    });
  }
  /** Aborts a queued Request, or records a pre-admission cancellation under the same primary key as ask. */
  withdraw(conversationId: string, id: string): ConversationView {
    coordinatorRequestId(id);
    return this.control(true, (db, store) => {
      const conversation = opened(db, conversationId);
      store.write(tx => {
        if (!sent(db, id)) {
          tx.insertConversationRequest({ id, conversationId: conversation.id, headRunId: null, mode: 'new', body: '',
            submittedAt: new Date().toISOString(), deliveryState: DELIVERY_STATE.aborted });
          return;
        }
        const run = shown(db, tx, conversation, id);
        if (!run) return;
        if (run.state !== 'queued' || inputUnsettled(handovers(db, [run.id]).get(run.id)?.state))
          throw new Problem(PROBLEM_CODE.conflict, 'Message has already been sent', undefined, { reason: { kind: 'message_has_already_been_sent' } });
        tx.abortRequest(run, id);
      });
      return this.project(db, store, conversation);
    });
  }
  /** Asks that a waiting message go to the agent at work now; the Run layer hands it over when it can. */
  sendNow(conversationId: string, id: string): ConversationView {
    return this.control(true, (db, store) => {
      const conversation = opened(db, conversationId);
      store.write(tx => {
        const run = shown(db, tx, conversation, id);
        // Asking again, as when the HTTP answer was lost, changes nothing.
        if (run?.state === 'joined' || run?.state === 'queued' && run.joinRequested) return;
        if (run?.state !== 'queued') throw new Problem(PROBLEM_CODE.conflict, 'Message has already left the queue', undefined, { reason: { kind: 'message_has_already_left_queue' } });
        const working = activeCoordinatorRuns(db, conversation.id).find(item => item.state === 'running');
        if (!working || pendingCoordinatorReset(db, conversation.id))
          throw new Problem(PROBLEM_CODE.conflict, 'Message cannot reach the working agent; it remains queued', undefined,
            { reason: { kind: 'message_cannot_reach_working_agent_it_remains_queued' } });
        tx.setJoinRequested(run.id);
      });
      return this.project(db, store, conversation);
    });
  }
  /**
   * Ends the conversation and opens a new one: its waiting messages are withdrawn and its working Run is stopped. Its
   * files go with the next sweep.
   */
  clear(conversationId: string): ConversationView {
    const stopping = this.control(true, (db, store) => {
      const conversation = opened(db, conversationId);
      const stops = store.write(tx => {
        let stopped = false;
        for (const run of activeCoordinatorRuns(db, conversation.id)) {
          if (run.state === 'queued') tx.abortRequest(run, run.requestId);
          else if (isUnfinished(run)) {
            if (!run.stop_requested) tx.update({ ...run, stop_requested: true });
            new StopDeliveryOwner(store).reserve(run.id);
            stopped = true;
          }
        }
        return stopped;
      });
      db.prepare('UPDATE coordinator_conversations SET cleared_at = ?,memo_text=NULL,memo_updated_at=NULL,memo_through_turn_no=NULL WHERE id = ?').run(new Date().toISOString(), conversation.id);
      db.prepare('DELETE FROM coordinator_reset_ops WHERE reset_id IN (SELECT id FROM coordinator_resets WHERE conversation_id=?)').run(conversation.id);
      db.prepare('DELETE FROM coordinator_resets WHERE conversation_id=?').run(conversation.id);
      touch(db, { kind: 'conversation', id: conversation.id });
      begin(db);
      return stops;
    });
    if (stopping) {
      const store = new RunStore(this.root, OPTIONS);
      try { new StopDeliveryOwner(store).gate(); } finally { store.close(); }
    }
    return this.read();
  }
  /**
   * Runs a change to the files of messages not yet sent in the open conversation (`ids`, their Request IDs); a sent
   * message's files are fixed. `operation` is given the conversation, whose folder holds them.
   */
  attachments<T>(conversationId: string, ids: readonly string[], operation: (conversation: string) => T): T {
    for (const id of ids) coordinatorRequestId(id);
    this.control(false, db => {
      opened(db, conversationId);
      // Admission transfers files from the draft to its message. Withdrawal releases that
      // ownership back to the draft; a request in another conversation never grants access.
      const owned = ids.some(id => {
        const request = sent(db, id);
        return request && (request.conversationId !== conversationId || !request.withdrawn);
      });
      if (owned) throw new Problem(PROBLEM_CODE.conflict, 'Sent attachments cannot be changed', undefined, { reason: { kind: 'sent_attachments_cannot_changed' } });
    });
    return operation(conversationId);
  }
  /** Reads a copy kept with an answer in the open conversation: one its Run ended with (`answerFiles`) as ready. */
  readAnswerFile<T>(id: string, name: string, operation: (conversation: string) => T): T {
    coordinatorRequestId(id);
    const conversation = this.control(false, (db, store) => {
      const open = current(db);
      if (!open) return null;
      const request = sent(db, id);
      if (request?.conversationId !== open.id || request.filesExpired || request.withdrawn) return null;
      const row = db.prepare(currentRequestRun('?')).get(id);
      const runtime = row ? store.runtimeGet(`R${row.id}`) : null;
      const run = runtime?.role === 'coordinator' ? runtime : null;
      return run?.answerFiles?.some(file => file.state === 'ready' && file.name === name) ? open.id : null;
    });
    if (conversation === null) throw new Problem(PROBLEM_CODE.notFound, 'Answer file is not in this conversation', undefined, { reason: { kind: 'answer_file_not_conversation' } });
    return operation(conversation);
  }
  /** Reads a file of a message in the open conversation: one not sent yet, sent, or cancelled (retained for input recovery). */
  readAttachment<T>(id: string, operation: (conversation: string) => T): T {
    coordinatorRequestId(id);
    const conversation = this.control(false, db => {
      const open = current(db), request = sent(db, id);
      return open && (!request || request.conversationId === open.id && !request.filesExpired) ? open.id : null;
    });
    if (conversation === null) throw new Problem(PROBLEM_CODE.notFound, 'Coordinator attachment is not in this conversation', undefined,
      { reason: { kind: 'coordinator_attachment_not_conversation' } });
    return operation(conversation);
  }
  /** Serve's periodic maintenance removes a turn's files only after its age and reset boundary both qualify. */
  sweepAttachments(now = Date.now()): void {
    const settings = readAgentsSettings(this.root);
    const days = settings.ok ? settings.config.limits.coordinator_attachment_days : DEFAULT_LIMITS.coordinator_attachment_days;
    const cutoff = days > 0 ? new Date(Math.max(-8.64e15, now - days * 86400_000)).toISOString() : null;
    const folders = coordinatorFolders(this.root);
    const expired = this.control(true, db => {
      const unowned = db.prepare('SELECT 1 FROM coordinator_conversations WHERE id=? AND cleared_at IS NOT NULL');
      const open = current(db);
      const requests: string[] = [];
      if (open) {
        const before = coordinatorBoundary(db, open.id);
        const candidates = new Set([...coordinatorFolders(this.root, open.id), ...coordinatorFolders(this.root, open.id, 'answers')]);
        const eligible = db.prepare(`SELECT q.coordinator_files_expired_at,
          q.coordinator_turn_no < ? AND r.state NOT IN ('queued','running','needs_review')
            AND datetime(q.submitted_at)<=datetime(?) AND q.delivery_state <> 'aborted' AS eligible
          FROM requests q JOIN runs r ON r.id=(${currentRequestRun('q.id')}) WHERE q.id=? AND q.conversation_id=?`);
        const mark = db.prepare('UPDATE requests SET coordinator_files_expired_at=? WHERE id=?');
        for (const id of candidates) {
          const row = eligible.get(before, cutoff, id, open.id);
          if (row?.coordinator_files_expired_at) requests.push(id);
          else if (row?.eligible) {
            mark.run(new Date(now).toISOString(), id);
            touch(db, { kind: 'request', id });
            requests.push(id);
          }
        }
      }
      return { open, requests, cleared: folders.filter(folder => unowned.get(folder)) };
    });
    for (const conversation of expired.cleared) {
      try { discardCoordinatorFiles(this.root, conversation); }
      catch (error) { console.error('Coordinator attachment cleanup failed', { conversation }, error); }
    }
    if (!expired.open || !expired.requests.length) return;
    const conversation = expired.open.id;
    for (const id of expired.requests) {
      try { discardCoordinatorFiles(this.root, conversation, id); }
      catch (error) { console.error('Coordinator attachment cleanup failed', { conversation, id }, error); }
    }
  }
}
