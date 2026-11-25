import { assertRunReservation } from '../release/journal.js';
/**
 * The screen's coordinator conversation, one open at a time (`coordinator_conversations`). Each conversation Request
 * has a coordinator Run, or is aborted without a Run when cancelled before admission. The Run layer queues, starts,
 * takes in, times out and ends coordinator Runs as it does any Run. This admits, withdraws, sends now and clears
 * messages; conversation-view.ts draws those records, with no second copy. Person-state owns conversation-scoped
 * answer observations.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';
import { Problem, PROBLEM_CODE, parseInput } from '@alpacawork/core';
import { ControlStore, touch } from '@alpacawork/db';
import { resolveAgentLaunchArgv } from '@alpacawork/contract/agent-launch';
import { DELIVERY_STATE, type RequestMode } from '@alpacawork/contract/control';
import type { CoordinatorRunRecord } from '@alpacawork/contract/run';
import { inputUnsettled, PROTOCOL_LIMITS } from '@alpacawork/contract/run-protocol';
import type { coordinatorMessageInputSchema, CoordinatorConversation as ConversationView,
  CoordinatorMessage, CoordinatorReadAck, CoordinatorSnapshot } from '@alpacawork/contract/coordinator';
import { coordinatorReadInputSchema } from '@alpacawork/contract/coordinator';
import { RunStore, admittedDelivery, isUnfinished, type RunTransaction } from '@alpacawork/runs';
import { authorize } from '../control/authorize.js';
import { TaskRepository } from '../control/task-store.js';
import { assertQuestionReplyApplicable, questionSnapshot, replyQuestion } from '../control/question-rules.js';
import { assignedSession, readAgentsSettings, type AgentsSettings } from '../agents-settings.js';
import { agentEnvironment } from '../runs/env.js';
import { StopDeliveryOwner, coordinatorCwd } from '../runs/execution-control.js';
import { createCoordinatorReadState, languageLine, savedReplyLanguage } from '../receiver/person-state.js';
import { assertSkillInvocations, coordinatorSkills } from './skills.js';
import { coordinatorNextLaunch } from './continuation.js';
import { assertManagedSkillsVersion } from './managed-skills-version.js';
import { failedRun, handovers, readable, view, type Conversation } from './conversation-view.js';
import { actedTasks } from './messages.js';
import { replySource, replyPrompt } from './reply.js';
import { coordinatorAttachmentFile, coordinatorFolders, coordinatorRequestId, discardCoordinatorFiles } from './files.js';
import { readRecentWork } from '../runs/recent-work.js';
import { readRunActivity } from '../runs/activity.js';
import { runFolder } from '@alpacawork/contract/run';
import type { ControlIndexDTO } from '@alpacawork/contract/control';

type Message = z.output<typeof coordinatorMessageInputSchema>;
const OPTIONS = { busyTimeoutMs: 10_000 };
/** What the background first turn asks: the reading a first message would otherwise wait for, and nothing else. */
const WARM_PROMPT = 'Load the alpacawork skill and its coordinator reference, and do nothing else. Reply only with: ready';

/** The open conversation, if there is one yet. */
function current(db: DatabaseSync): Conversation | null {
  const row = db.prepare('SELECT id, warm_request_id FROM coordinator_conversations WHERE cleared_at IS NULL').get();
  return row ? { id: String(row.id), warmRequestId: row.warm_request_id === null ? null : String(row.warm_request_id) } : null;
}
function begin(db: DatabaseSync): Conversation {
  const conversation = { id: randomUUID(), warmRequestId: null };
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
  const row = db.prepare('SELECT conversation_id, body, delivery_state, reply_to FROM requests WHERE id = ?').get(id);
  return row ? { conversationId: row.conversation_id === null ? null : String(row.conversation_id), body: String(row.body),
    replyTo: row.reply_to as string | null, withdrawn: row.delivery_state === DELIVERY_STATE.aborted } : null;
}
/** A message the screen shows in this conversation (not its warm-up) and its Run; null once it was withdrawn. */
function shown(db: DatabaseSync, tx: RunTransaction, conversation: Conversation, id: string): CoordinatorRunRecord | null {
  const request = sent(db, id);
  if (!request || request.conversationId !== conversation.id || id === conversation.warmRequestId)
    throw new Problem(PROBLEM_CODE.notFound, 'Coordinator message is not in this conversation', undefined, { reason: { kind: 'coordinator_message_not_conversation' } });
  if (request.withdrawn) return null;
  const run = tx.coordinatorRuns(conversation.id).filter(item => item.requestId === id).at(-1);
  if (!run) throw new Error(`Coordinator message ${id} has no Run`);
  return run;
}
/**
 * What the coordinator is given for a message: its words, what a press meant, the questions
 * the words answer, the files.
 */
function launchText(id: string, message: CoordinatorMessage, body: string, files: readonly (readonly [string, string])[],
  replyLanguage: string | null) {
  const language = replyLanguage === null ? '' : languageLine(replyLanguage).trimEnd();
  return [`Request ID of this input: ${id}. Add --source-request ${id} to the records of what you do for this input.`, language, body,
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
    const observed = this.observations.get()?.value;
    const runs = store.coordinatorRuns(conversation.id);
    const history = view(db, store, conversation, runs, new Set(observed?.conversationId === conversation.id ? observed.seen : []),
      run => { this.running = run; });
    const next = settings.ok ? coordinatorNextLaunch(settings.config, runs) : null;
    return { ...history, nextLaunch: next?.row ? { agent: next.row.agent, values: next.appliedValues } : null };
  }
  /** Only this small projection is sampled for stdout changes; no conversation digest or transcript changes. */
  work(): ControlIndexDTO['coordinatorWork'] {
    const run = this.running;
    if (!run) return null;
    const folder = runFolder(this.root, run.id), label = readRecentWork(folder), activity = readRunActivity(folder);
    const steps = activity?.steps ?? [], words = activity?.note?.text ?? null;
    return label || steps.length || words ? { conversation: run.conversationId, turn: run.requestId, run: run.id, name: label?.name ?? null, count: label?.count ?? 0, steps,
      stepEvents: activity?.stepEvents ?? 0, words } : null;
  }
  /** Startup alone calls this, before recovery can turn an unfinished Run into another answer. */
  async seedSeen(): Promise<void> {
    await this.observations.change(saved => saved ?? this.control(true, (db, store) => {
      const conversation = current(db) ?? begin(db);
      return { conversationId: conversation.id, seen: view(db, store, conversation).turns.filter(readable).map(turn => turn.id).sort() };
    }));
  }
  /** The RAW lock protects the union; the conversation ID prevents an old clear/save race from reading a new answer. */
  async markSeen(conversationId: string, seen: readonly string[]): Promise<CoordinatorReadAck> {
    const input = parseInput(coordinatorReadInputSchema, { conversationId, seen: [...seen] });
    const ids = [...new Set(input.seen)].sort();
    let before: string | null | undefined;
    try {
      await this.observations.change((saved, revision) => this.control(false, (db, store) => {
        before = revision; // Sample after taking the RAW lock, so a concurrent duplicate does not notify again.
        const conversation = opened(db, input.conversationId);
        const eligible = new Set(view(db, store, conversation).turns.filter(readable).map(turn => turn.id));
        if (ids.some(id => !eligible.has(id)))
          throw new Problem(PROBLEM_CODE.invalidInput, 'Seen IDs must identify completed answers in this conversation', undefined,
            { reason: { kind: 'coordinator_seen_ids_must_be_completed_answers' } });
        const union = new Set(saved?.conversationId === conversation.id ? saved.seen : []);
        for (const id of ids) union.add(id);
        return { conversationId: conversation.id, seen: [...union].sort() };
      }));
      return { conversationId: input.conversationId, seen: ids };
    } finally {
      // A rename may have published even when directory fsync could not confirm it. Never ACK that failure, but
      // let other screens discover the actual saved facts; an unchanged retry neither writes nor publishes.
      if (before !== undefined && before !== this.seenRevision()) this.readChanged();
    }
  }
  /** `write` borrows one control transaction for both the conversation's rows and its Requests and Runs. */
  private control<T>(write: boolean, work: (db: DatabaseSync, store: RunStore) => T): T {
    const control = new ControlStore(this.root, OPTIONS, !write);
    let store: RunStore | undefined;
    try {
      const run = (db: DatabaseSync) => work(db, store = new RunStore(this.root, OPTIONS, !write, db));
      return write ? control.write(run) : control.read(run);
    } finally { store?.close(); control.close(); }
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
    const runs = this.control(false, (db, store) => store.coordinatorRuns(opened(db, conversationId).id));
    const settings = readAgentsSettings(this.root);
    if (!settings.ok) return { status: 'unavailable', profile: '', skills: [], reason: 'settings' };
    const next = coordinatorNextLaunch(settings.config, runs);
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
  private queue(tx: RunTransaction, config: AgentsSettings, conversation: Conversation, input: { id: string; body: string;
    message: CoordinatorMessage; replyTo?: string | null; text: string; warm?: boolean }) {
    const head = tx.coordinatorHead(conversation.id), runs = tx.coordinatorRuns(conversation.id);
    const next = coordinatorNextLaunch(config, runs);
    if (next.row === null) throw next.error;
    const { launch, restartArgv, continued } = next, agent = next.row.agent;
    const mode: RequestMode = continued ? 'continue' : 'new', text = input.text;
    if (Buffer.byteLength(text) > PROTOCOL_LIMITS.prompt) throw new Problem(PROBLEM_CODE.tooLarge, 'Coordinator message is too large', undefined, { reason: { kind: 'coordinator_message_too_large' } });
    if (input.message.skills?.length) {
      assertSkillInvocations(launch.adapter, input.body, input.message.skills);
      assertManagedSkillsVersion(input.message.skills);
    }
    const session = continued ? continued.session : assignedSession(launch, agent);
    assertRunReservation(this.root);
    tx.insertConversationRequest({ id: input.id, conversationId: conversation.id, headRunId: head?.id ?? null, mode,
      body: input.body, replyTo: input.replyTo, submittedAt: new Date().toISOString(),
      deliveryState: admittedDelivery(!!continued, session, runs),
      aiStack: input.warm || !next.following.length ? undefined : [next.row, ...next.following] });
    tx.createCoordinatorRun({ conversationId: conversation.id, requestId: input.id, agent, resumes: continued?.id ?? null,
      session, cwd: coordinatorCwd(this.root), launch, restartArgv, message: input.message }, text);
  }
  /**
   * Starts the background first turn of a conversation that has had no message yet; otherwise does nothing, so the card
   * may ask each time it opens. A message sent meanwhile waits behind it and goes on in its session.
   */
  warm(conversationId: string): ConversationView {
    const settings = readAgentsSettings(this.root);
    return this.control(true, (db, store) => {
      let conversation = opened(db, conversationId);
      if (conversation.warmRequestId === null && !db.prepare('SELECT 1 FROM requests WHERE conversation_id = ? AND delivery_state <> ?')
        .get(conversation.id, DELIVERY_STATE.aborted)) {
        if (!settings.ok) throw settings.error;
        const id = randomUUID(), opening = conversation;
        store.write(tx => this.queue(tx, settings.config, opening, { id, body: WARM_PROMPT, warm: true,
          message: { context: null, attachments: [], intent: null }, text: WARM_PROMPT }));
        db.prepare('UPDATE coordinator_conversations SET warm_request_id = ? WHERE id = ?').run(id, conversation.id);
        touch(db, { kind: 'conversation', id: conversation.id });
        conversation = { ...conversation, warmRequestId: id };
      }
      return this.project(db, store, conversation, settings);
    });
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
      const message: CoordinatorMessage = { context: null, attachments: input.attachments, intent: input.intent ?? null,
        ...input.answers === undefined ? {} : { answers: input.answers },
        ...(input.skills?.length ? { skills: [...new Set(input.skills)].sort() } : {}),
        tasks: [...new Set(input.tasks ?? [])].sort(), ...input.retryOf === undefined ? {} : { retryOf: input.retryOf } };
      store.write(tx => {
        const previous = sent(db, input.id);
        if (previous) {
          const ours = previous.conversationId === conversation.id;
          if (ours && previous.withdrawn && input.id !== conversation.warmRequestId) return;
          // A live accepted Request retains its fixed input for strict replay.
          const stored = ours ? db.prepare('SELECT id FROM runs WHERE request_id = ? AND attempt=0').get(input.id) : undefined;
          const run = stored ? tx.runtimeGet(`R${stored.id}`) : null;
          const same = ours && previous.body === input.text && previous.replyTo === (input.replyTo ?? null) && (run?.role === 'coordinator' &&
            isDeepStrictEqual(run.message, message));
          if (!same) throw new Problem(PROBLEM_CODE.idempotencyConflict, 'Message ID belongs to different input', undefined, { reason: { kind: 'message_id_belongs_different_input' } });
          return;
        }
        if (message.retryOf !== undefined) {
          // A failed message is sent again once: the one sent in its place answers for it, and is what is sent again next.
          const original = shown(db, tx, conversation, message.retryOf);
          if (!original || !failedRun(original))
            throw new Problem(PROBLEM_CODE.conflict, 'Only a failed message can be sent again', undefined, { reason: { kind: 'message_has_already_been_sent' } });
          if (tx.coordinatorRuns(conversation.id).some(run => run.message.retryOf === message.retryOf))
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
        this.queue(tx, settings.config, conversation, { id: input.id, body: input.text, message, replyTo: input.replyTo,
          text: [reply ? replyPrompt(reply) : '',
            launchText(input.id, message, input.text, files, savedReplyLanguage(this.root))].filter(Boolean).join('\n') });
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
        if (!sent(db, id) && id !== conversation.warmRequestId) {
          tx.insertConversationRequest({ id, conversationId: conversation.id, headRunId: null, mode: 'new', body: '',
            submittedAt: new Date().toISOString(), deliveryState: DELIVERY_STATE.aborted });
          return;
        }
        const run = shown(db, tx, conversation, id);
        if (!run) return;
        if (run.state !== 'queued' || inputUnsettled(handovers(db, conversation.id).get(run.id)?.state))
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
        const working = tx.coordinatorRuns(conversation.id).find(item => item.state === 'running');
        if (!working || working.requestId === conversation.warmRequestId)
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
        for (const run of tx.coordinatorRuns(conversation.id)) {
          if (run.state === 'queued') tx.abortRequest(run, run.requestId);
          else if (isUnfinished(run)) {
            if (!run.stop_requested) tx.update({ ...run, stop_requested: true });
            new StopDeliveryOwner(store).reserve(run.id);
            stopped = true;
          }
        }
        return stopped;
      });
      db.prepare('UPDATE coordinator_conversations SET cleared_at = ? WHERE id = ?').run(new Date().toISOString(), conversation.id);
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
      const run = store.coordinatorRuns(open.id).filter(item => item.requestId === id).at(-1);
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
      return open && (!request || request.conversationId === open.id) ? open.id : null;
    });
    if (conversation === null) throw new Problem(PROBLEM_CODE.notFound, 'Coordinator attachment is not in this conversation', undefined,
      { reason: { kind: 'coordinator_attachment_not_conversation' } });
    return operation(conversation);
  }
  /**
   * Removes cleared conversations' files (serve's periodic maintenance pass). Cancelled messages in the open
   * conversation retain files so recovery can copy them to a new request. One that fails waits for the next pass.
   */
  sweepAttachments(): void {
    const unowned = this.control(false, db => {
      const cleared = db.prepare('SELECT 1 FROM coordinator_conversations WHERE id = ? AND cleared_at IS NOT NULL');
      return coordinatorFolders(this.root).filter(name => cleared.get(name));
    });
    for (const conversation of unowned) {
      try { discardCoordinatorFiles(this.root, conversation); }
      catch (error) { console.error('Coordinator attachment cleanup failed', { conversation }, error); }
    }
  }
}
