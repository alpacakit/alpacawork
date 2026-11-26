import { constants } from 'node:fs';
import { resolve } from 'node:path';
/** Owns the Run store's connections, transactions and writes; reads.ts owns what the tables say. Folders hold raw logs and live process exchange files only. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { hasCode, Problem, PROBLEM_CODE } from '@alpacawork/core';
import { controlDatabasePath, currentControlConnection, inTransaction, touch, type TransactionBegin, openControlDatabase,
  type DatabaseOptions } from '@alpacawork/db';
import { RUN_ENDED_STATES, RUN_RESULT_LIMIT, RUN_ROLE, coordinatorRunRecordSchema, runFolder, runNumber, runRecordSchema,
  runtimeRunRecordSchema, type CoordinatorRunRecord, type RunRecord, type RunResultState, type RuntimeRunRecord } from '@alpacawork/contract/run';
import { runIdSchema, type RunId } from '@alpacawork/contract/fields';
import { DELIVERY_STATE, actorSchema, requestPurposeSchema, type DeliveryState, type RequestMode } from '@alpacawork/contract/control';
import { isSeatContinuation, type AiRow, type AiStackPrefix } from '@alpacawork/contract';
import { requestActionReasonSchema, type TaskActor } from '@alpacawork/raw';
import { canTransition } from './rules.js';
import { storageOperation } from './record-codec.js';
import { parseRow, parseRuntimeRow, storeReads, transactionReads, type RunSnapshot, type StoredRequest,
  type StoredReturn, type StoredPlacement, type TransactionReads } from './reads.js';

export type CreateRunFields = Pick<RunRecord, 'task' | 'agent' | 'role' | 'resumes' | 'continues' | 'session' | 'caller' | 'cwd' | 'launch'> &
  Pick<RunRecord, 'placementId' | 'requestId' | 'attempt' | 'firstRunId' | 'newConversation'>;
export type NewRequest = Omit<StoredRequest, 'runId' | 'aboutRunId'> & {
  aboutRunId?: RunId | null;
  aiStack?: readonly AiRow[];
  aiExplicit?: boolean;
  aiPrefix?: AiStackPrefix;
};
/** A person's message to the coordinator conversation: a Request with no Task or placement, always the person's own. */
interface StoredConversationRequest {
  id: string; conversationId: string; headRunId: RunId | null; mode: RequestMode; body: string;
  submittedAt: string; deliveryState: DeliveryState; replyTo?: string | null; coordinatorInput?: { text: string; language: string }; aiStack?: readonly AiRow[]; aiExplicit?: boolean;
}
/** What a coordinator Run is created with; it has no Task, placement or caller and never continues work by itself. */
export type CreateCoordinatorRunFields = Pick<CoordinatorRunRecord, 'conversationId' | 'requestId' | 'agent' | 'resumes' | 'session' |
  'cwd' | 'launch' | 'message' | 'attempt' | 'firstRunId'>;
/** What a write transaction does, beyond its reads (`transactionReads`). */
interface RunWrites {
  create(fields: CreateRunFields, prompt: string): RunRecord;
  /** Queues the Run answering a Request inserted by `insertConversationRequest`. */
  createCoordinatorRun(fields: CreateCoordinatorRunFields, prompt: string): CoordinatorRunRecord;
  insertRequest(request: NewRequest): void;
  insertConversationRequest(request: StoredConversationRequest): void;
  updateRequest(id: string, deliveryState: DeliveryState): void;
  /** Caller checks eligibility; null preserves launch reconciliation when the Request is absent. */
  abortRequest(run: RuntimeRunRecord, requestId: string | null): void;
  /** End admitted queued work without erasing its requester's closing result. A seat's own continuation has no requester. */
  invalidateRequest(run: RunRecord): void;
  /** Marks a coordinator Run so its Request goes to the coordinator Run working in the conversation (send now). */
  setJoinRequested(runId: RunId): void;
  update(record: RuntimeRunRecord): void;
  rebindQueued(record: RuntimeRunRecord, choices: { aiStack?: readonly AiRow[]; prompt?: string }): void;
  finish(record: RuntimeRunRecord, result: RunResult): void;
}
export type RunTransaction = TransactionReads & RunWrites;
type RunResult = { state: 'present'; text: string } |
  { state: Exclude<RunResultState, 'present' | 'pending'>; text: null };
/** A read-only placement lookup in the same SQLite snapshot. */
type PlacementReader = Pick<RunTransaction, 'get' | 'getRequest' | 'responsiblePlacement'>;
/** A transaction handle's life: its reads and writes refuse once its callback has returned. */
function handleLife() {
  let live = true;
  return {
    check() { if (!live) throw new Problem(PROBLEM_CODE.conflict, 'Run transaction has ended', undefined, { reason: { kind: 'run_transaction_has_ended' } }); },
    end() { live = false; },
  };
}
/** The same reads, each refusing once its transaction has ended. */
function whileLive(reads: TransactionReads, check: () => void): TransactionReads {
  return Object.fromEntries(Object.entries(reads).map(([name, read]) =>
    [name, (...args: never[]) => { check(); return (read as (...args: never[]) => unknown)(...args); }])) as TransactionReads;
}
const immutable = ['id', 'task', 'agent', 'role', 'placementId', 'requestId', 'resumes', 'continues', 'caller', 'cwd', 'launch', 'created_at', 'attempt', 'firstRunId'] as const;
/** A coordinator Run's creation fields beyond a Task Run's. */
const coordinatorOf = (record: RuntimeRunRecord) =>
  record.role === RUN_ROLE.coordinator ? { conversationId: record.conversationId, message: record.message } : null;
/** The person who writes every Request to the coordinator conversation. */
const CONVERSATION_AUTHOR = JSON.stringify({ kind: 'human' } satisfies TaskActor);
export class RunStore {
  /** Readers never create control storage. */
  static exists(root: string): boolean {
    return storageOperation(() => {
      try { lstatSync(controlDatabasePath(root)); return true; }
      catch (error) { if (hasCode(error, 'ENOENT')) return false; throw error; }
    });
  }
  static openExisting(root: string, options: DatabaseOptions): RunStore | null {
    return RunStore.exists(root) ? new RunStore(root, options) : null;
  }
  static openReadable(root: string, options: DatabaseOptions): RunStore | null {
    return RunStore.exists(root) ? new RunStore(root, options, true) : null;
  }
  readonly root: string;
  private db!: DatabaseSync;
  private active = false;
  private closed = false;
  private readonly readOnly: boolean;
  private readonly borrowed: boolean;
  private readonly reads: TransactionReads;
  private readonly storeReads: ReturnType<typeof storeReads>;
  /** Borrow for another view of the same operation; the RunStore owns closing it. */
  get connection(): DatabaseSync { return this.db; }
  constructor(root: string, options: DatabaseOptions, readOnly = false, connection?: DatabaseSync) {
    this.root = root;
    this.readOnly = readOnly;
    const shared = connection ?? currentControlConnection(root);
    this.borrowed = shared !== undefined;
    this.db = shared ?? storageOperation(() => openControlDatabase(root, options, readOnly));
    this.reads = transactionReads(this.db, root);
    this.storeReads = storeReads(this.db, root);
  }
  close(): void {
    if (this.active) throw new Problem(PROBLEM_CODE.conflict, 'Cannot close an active run transaction', undefined, { reason: { kind: 'cannot_close_active_run_transaction' } });
    if (this.closed) return;
    if (!this.borrowed) storageOperation(() => this.db?.close());
    this.closed = true;
  }
  folder(id: RunId): string { return runFolder(this.root, runIdSchema.parse(id)); }
  /** Call only after the queued Run commits, before asking the scheduler to lock it. */
  prepareFolder(id: RunId): string {
    if (this.readOnly || this.db.isTransaction)
      throw new Problem(PROBLEM_CODE.conflict, 'Run folder is prepared only after commit', undefined, { reason: { kind: 'run_folder_prepared_only_after_commit' } });
    const path = runFolder(this.root, runIdSchema.parse(id));
    storageOperation(() => {
      if (!this.reads.runtimeGet(id)) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', undefined, { reason: { kind: 'run_does_not_exist' } });
      const parent = resolve(`${this.root}/.alpacawork/runs`);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      statSync(path);
      const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    });
    return path;
  }
  get(id: RunId): RunRecord | null { return this.at(() => this.reads.get(id)); }
  getMany(ids: readonly RunId[]): Map<RunId, RunRecord> { return this.at(() => this.reads.getMany(ids)); }
  /** Any Run, the coordinator's too: for the execution layer only. */
  runtimeGet(id: RunId): RuntimeRunRecord | null { return this.at(() => this.reads.runtimeGet(id)); }
  runtimeDecidingGet(id: RunId): RuntimeRunRecord | null { return this.at(() => this.reads.runtimeDecidingGet(id)); }
  getText(id: RunId) { return this.at(() => this.storeReads.text(id)); }
  getFileText(id: RunId, kind: 'prompt' | 'result') { return this.at(() => this.storeReads.fileText(id, kind)); }
  resultHeads(ids: readonly RunId[], length: number) { return this.at(() => this.storeReads.resultHeads(ids, length)); }
  getPlacement(id: string): StoredPlacement | null { return this.at(() => this.reads.getPlacement(id)); }
  snapshot(project?: string, taskIds?: readonly string[]): RunSnapshot {
    return this.at(() => this.storeReads.snapshot(project, taskIds, rows => rows.map(parseRow)));
  }
  read(): RuntimeRunRecord[] { return this.at(() => this.storeReads.everyRun()); }
  /** Unfinished Runs: every one, or one project's or these Tasks' Task Runs (reads `unfinished`). */
  readUnfinished(project?: string, taskIds?: readonly string[]): RuntimeRunRecord[] {
    return this.at(() => this.storeReads.unfinished(project, taskIds));
  }
  getRequest(id: string): StoredRequest | null { return this.at(() => this.reads.getRequest(id)); }
  readRequests(project?: string): StoredRequest[] { return this.at(() => this.reads.requests(project)); }
  conversationRuns(placementId: string): RunRecord[] { return this.at(() => this.reads.conversationRuns(placementId)); }
  conversationHead(placementId: string, exceptRequestId?: string): RunRecord | null {
    return this.at(() => this.reads.conversationHead(placementId, exceptRequestId));
  }
  coordinatorHead(conversationId: string): CoordinatorRunRecord | null {
    return this.at(() => this.reads.coordinatorHead(conversationId));
  }
  /** A Task's Run and its placement: the server reads a Run credential with it. A coordinator Run has no credential. */
  credentialOf(id: RunId): { run: RunRecord; placement: StoredPlacement | null } | null {
    return this.at(() => {
      const run = this.reads.get(id);
      if (!run) return null;
      return { run, placement: run.placementId ? this.reads.getPlacement(run.placementId) : null };
    });
  }
  sessionOwner(sessionIds: readonly string[]) { return this.at(() => this.storeReads.sessionOwner(sessionIds)); }
  getReturn(id: string) { return this.at(() => this.reads.getReturn(id)); }
  readReturns(project?: string): StoredReturn[] { return this.at(() => this.reads.returns(project)); }
  readReturnsForTask(taskId: string, project?: string): StoredReturn[] { return this.at(() => this.storeReads.returnsForTask(taskId, project)); }
  readReturnPage(input: { task: string; after?: string; limit: number }, project?: string): { returns: StoredReturn[]; nextAfter: string | null } {
    return this.at(() => this.storeReads.returnPage(input, project));
  }
  /** One consistent SQLite read snapshot; callers cannot write through this handle. */
  readPlacements<T>(callback: (reader: PlacementReader) => T): T {
    return this.at(() => {
      const life = handleLife();
      const { get, getRequest, responsiblePlacement } = whileLive(this.reads, life.check);
      try { return callback({ get, getRequest, responsiblePlacement }); }
      finally { life.end(); }
    });
  }
  /** Current decision facts on a read-only handle; preparation cannot write or retain a transaction capability. */
  readDecisions<T>(callback: (reader: TransactionReads) => T): T {
    return this.at(() => {
      const life = handleLife();
      try { return callback(whileLive(this.reads, life.check)); }
      finally { life.end(); }
    });
  }
  readForSettle(): RuntimeRunRecord[] { return this.at(() => this.storeReads.forSettle()); }
  /** A read at a read point of its own. */
  private at<T>(read: () => T): T { return this.transaction('BEGIN', read); }
  /** Callbacks are synchronous and transaction handles expire when they return. */
  write<T>(callback: (transaction: RunTransaction) => T): T {
    if (this.readOnly) throw new Problem(PROBLEM_CODE.forbidden, 'Run database is read-only', undefined, { reason: { kind: 'run_database_read_only' } });
    return this.transaction('BEGIN IMMEDIATE', () => {
      const life = handleLife(), check = life.check;
      let largest: number | undefined;
      /** Numbers and queues a new Run: a Task's, or the coordinator's with no Task. */
      const insert = <T extends RuntimeRunRecord>(schema: { parse(value: unknown): T }, fields: object, prompt: string): T =>
        storageOperation(() => {
          check();
          if (largest === undefined)
            largest = Number(this.db.prepare('SELECT next_number FROM run_sequence WHERE singleton = 1').get()!.next_number);
          const n = largest;
          if (!Number.isSafeInteger(n + 1)) throw new Problem(PROBLEM_CODE.idExhausted, 'Run numbers are exhausted', undefined, { reason: { kind: 'run_numbers_exhausted' } });
          largest += 1;
          this.db.prepare('UPDATE run_sequence SET next_number = ? WHERE singleton = 1').run(largest);
          const record = schema.parse({
            ...fields, id: `R${n}`, state: 'queued', reason: null, into: null, stop_requested: false,
            exit: null, created_at: new Date().toISOString(), started_at: null, ended_at: null,
            usage: null,
            pids: { manager: null, agent: null },
          });
          // A dangling reference would make every later relationship read fail.
          for (const ref of [record.resumes, record.caller?.run])
            if (ref && !this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runNumber(ref)))
              throw new Problem(PROBLEM_CODE.notFound, 'Referenced run does not exist', { run: ref }, { reason: { kind: 'referenced_run_does_not_exist' } });
          // The runs triggers check that a coordinator Run's Request and resumed Run are of its conversation.
          const task = record.task === null ? null
            : this.db.prepare(`SELECT id FROM tasks WHERE external_id = ? AND kind = 'task'`).get(record.task);
          if (task === undefined) throw new Problem(PROBLEM_CODE.notFound, 'Task does not exist', undefined, { reason: { kind: 'task_does_not_exist' } });
          this.db.prepare('INSERT INTO runs(id,record,prompt) VALUES (?,?,?)').run(n, JSON.stringify(record), prompt);
          touch(this.db, { kind: 'run', id: record.id });
          return record;
        });
      const transaction: RunTransaction = {
        ...whileLive(this.reads, check),
        insertRequest: request => {
          check();
          // Invalid input is the caller's error; CHECK constraints also refuse the enumerated columns.
          const author = JSON.stringify(actorSchema.parse(request.author));
          const reason = request.reason === undefined ? null : JSON.stringify(requestActionReasonSchema.parse(request.reason));
          const changes = storageOperation(() => this.db.prepare(`INSERT INTO requests
            (id, task_id, placement_id, placement_revision, task_hash, wait_cycle_id, head_run_id, about_run_id, mode, body, purpose, author,
              submitted_at, delivery_state, answers_question, ai_stack, ai_explicit, ai_prefix, reason)
            SELECT ?, external_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM tasks
              WHERE external_id = ? AND kind = 'task'`).run(request.id, request.placementId,
            request.placementRevision, request.taskHash, request.waitCycleId, request.headRunId, request.aboutRunId ?? null, request.mode, request.body,
            request.purpose, author, request.submittedAt, request.deliveryState, request.answersQuestion ?? null, request.aiStack ? JSON.stringify(request.aiStack) : null, Number(request.aiExplicit ?? false), request.aiPrefix ? JSON.stringify(request.aiPrefix) : null, reason, request.taskId).changes);
          if (Number(changes) !== 1) throw new Problem(PROBLEM_CODE.notFound, 'Request Task does not exist', undefined, { reason: { kind: 'request_task_does_not_exist' } });
          touch(this.db, { kind: 'request', id: request.id });
        },
        insertConversationRequest: request => {
          check();
          // CHECK constraints refuse the enumerated columns; triggers refuse a head outside the conversation.
          const changes = storageOperation(() => this.db.prepare(`INSERT INTO requests
            (id, conversation_id, head_run_id, mode, body, purpose, author, submitted_at, delivery_state, reply_to, ai_stack, ai_explicit,
             coordinator_input, coordinator_turn_no)
            SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              CASE WHEN ? <> 'aborted' THEN coalesce((SELECT max(coordinator_turn_no)
                FROM requests WHERE conversation_id=c.id AND coordinator_turn_no IS NOT NULL),0)+1 END
            FROM coordinator_conversations c WHERE id = ?`).run(request.id,
            request.headRunId, request.mode, request.body, requestPurposeSchema.enum.instruction, CONVERSATION_AUTHOR,
            request.submittedAt, request.deliveryState, request.replyTo ?? null, request.aiStack ? JSON.stringify(request.aiStack) : null, Number(request.aiExplicit ?? false),
            request.coordinatorInput ? JSON.stringify(request.coordinatorInput) : null, request.deliveryState, request.conversationId).changes);
          if (Number(changes) !== 1) throw new Problem(PROBLEM_CODE.notFound, 'Coordinator conversation does not exist', undefined, { reason: { kind: 'coordinator_conversation_does_not_exist' } });
          touch(this.db, { kind: 'request', id: request.id });
        },
        updateRequest: (id, deliveryState) => {
          check();
          const changes = storageOperation(() => this.db.prepare('UPDATE requests SET delivery_state = ? WHERE id = ?')
            .run(deliveryState, id).changes);
          if (Number(changes) !== 1) throw new Problem(PROBLEM_CODE.notFound, 'Request does not exist', undefined, { reason: { kind: 'request_does_not_exist' } });
          touch(this.db, { kind: 'request', id });
        },
        abortRequest: (run, requestId) => {
          transaction.update({ ...run, state: 'cancelled', reason: 'stopped', ended_at: new Date().toISOString() });
          if (requestId !== null) transaction.updateRequest(requestId, DELIVERY_STATE.aborted);
        },
        invalidateRequest: run => {
          const request = transaction.getRequest(run.requestId);
          if (!request || run.state !== 'queued') throw new Error('Only admitted queued work can be invalidated');
          transaction.update({ ...run, state: 'cancelled', reason: 'scope_invalidated', ended_at: new Date().toISOString() });
          // Its carried input never went out. Existing delivery reconciliation releases it for a fresh wake.
          // An ordinary accepted Request, in contrast, still owes its caller a closing result.
          if (isSeatContinuation(request.purpose)) transaction.updateRequest(request.id, DELIVERY_STATE.aborted);
        },
        setJoinRequested: runId => {
          check();
          const run = this.reads.runtimeGet(runId);
          if (run?.role !== RUN_ROLE.coordinator) throw new Problem(PROBLEM_CODE.notFound, 'Coordinator Run does not exist', undefined, { reason: { kind: 'coordinator_run_does_not_exist' } });
          transaction.update({ ...run, joinRequested: true });
        },
        create: (fields, prompt) => insert(runRecordSchema, fields, prompt),
        createCoordinatorRun: (fields, prompt) => insert(coordinatorRunRecordSchema,
          { ...fields, task: null, placementId: null, role: RUN_ROLE.coordinator, continues: false, caller: null }, prompt),
        update: input => {
          check();
          // Invalid input is the caller's error, not a storage fault.
          const record = runtimeRunRecordSchema.parse(input), n = runNumber(record.id);
          storageOperation(() => {
            const { before } = this.checkUpdate(record, n);
            if (record.state === 'succeeded' && before.state !== 'succeeded')
              throw new Problem(PROBLEM_CODE.conflict, 'Run success must commit its final reply with finish', undefined,
                { reason: { kind: 'run_success_must_commit_final_reply_with_finish' } });
            // A Run waiting for review has not ended; a lost manager's Run may still be finished with its reply.
            this.db.prepare(`UPDATE runs SET record = ?, result_state =
              CASE WHEN result_state = 'pending' AND ? IN ('failed','cancelled') THEN 'missing'
              ELSE result_state END WHERE id = ?`).run(JSON.stringify(record), record.state, n);
            touch(this.db, { kind: 'run', id: record.id });
          });
        },
        rebindQueued: (input, { aiStack, prompt }) => {
          check();
          const record = runtimeRunRecordSchema.parse(input), n = runNumber(record.id);
          storageOperation(() => {
            const { before } = this.checkUpdate(record, n, true);
            if (before.state !== 'queued' || record.state !== 'queued' || this.db.prepare(
              "SELECT 1 FROM run_inputs WHERE instruction_run_no=? AND state<>'not_sent'").get(n))
              throw new Error('Only an unsent queued Run can change its binding');
            this.db.prepare('UPDATE runs SET record=?,prompt=coalesce(?,prompt) WHERE id=?').run(JSON.stringify(record), prompt ?? null, n);
            touch(this.db, { kind: 'run', id: record.id });
            if (aiStack) {
              this.db.prepare('UPDATE requests SET ai_stack=? WHERE id=?').run(JSON.stringify(aiStack), record.requestId);
              touch(this.db, { kind: 'request', id: record.requestId });
            }
          });
        },
        finish: (input, result) => {
          check();
          const record = runtimeRunRecordSchema.parse(input), n = runNumber(record.id);
          if (!(RUN_ENDED_STATES as readonly string[]).includes(record.state))
            throw new Problem(PROBLEM_CODE.invalidInput, 'Finished Run must have an ended state', undefined, { reason: { kind: 'finished_run_must_have_ended_state' } });
          if ((result.state === 'present') !== (result.text !== null) ||
            (record.state === 'succeeded' && result.state !== 'present'))
            throw new Problem(PROBLEM_CODE.conflict, 'Run success requires one valid final reply', undefined, { reason: { kind: 'run_success_requires_one_valid_final_reply' } });
          if (result.text !== null && Buffer.byteLength(result.text, 'utf8') > RUN_RESULT_LIMIT)
            throw new Problem(PROBLEM_CODE.invalidInput, 'Final reply is too large', undefined, { reason: { kind: 'final_reply_too_large' } });
          storageOperation(() => {
            const { resultState } = this.checkUpdate(record, n);
            if (resultState !== 'pending')
              throw new Problem(PROBLEM_CODE.conflict, 'Run cannot be finished twice or changed', undefined, { reason: { kind: 'run_cannot_finished_twice_or_changed' } });
            this.db.prepare('UPDATE runs SET record = ?, result = ?, result_state = ? WHERE id = ?')
              .run(JSON.stringify(record), result.text, result.state, n);
            touch(this.db, { kind: 'run', id: record.id });
          });
        },
      };
      try { return callback(transaction); } finally { life.end(); }
    });
  }
  /** Both state-only updates and final reply commits enforce the same Run invariants. */
  private checkUpdate(record: RuntimeRunRecord, n: number, rebind = false) {
    const row = this.db.prepare('SELECT id, record, result_state FROM runs WHERE id = ?').get(n);
    if (!row) throw new Problem(PROBLEM_CODE.notFound, 'Run does not exist', undefined, { reason: { kind: 'run_does_not_exist' } });
    const before = parseRuntimeRow(row);
    const fixed = (key: (typeof immutable)[number]) => !rebind || (key !== 'agent' && key !== 'launch' && key !== 'resumes');
    if (immutable.some(key => fixed(key) && !isDeepStrictEqual(before[key], record[key])) ||
      !isDeepStrictEqual(coordinatorOf(before), coordinatorOf(record)))
      throw new Problem(PROBLEM_CODE.conflict, 'Run creation fields are immutable', undefined, { reason: { kind: 'run_creation_fields_immutable' } });
    // A queued Run may take a fresh session (its predecessor's first launch failed); a launched Run keeps its own.
    if (before.session !== null && before.state !== 'queued' && !isDeepStrictEqual(before.session, record.session))
      throw new Problem(PROBLEM_CODE.conflict, 'A launched Run keeps its session', undefined, { reason: { kind: 'launched_run_keeps_session' } });
    if (!canTransition(before, record)) throw new Problem(PROBLEM_CODE.conflict, 'Illegal run state transition', undefined, { reason: { kind: 'illegal_run_state_transition' } });
    return { before, resultState: row.result_state };
  }
  private transaction<T>(begin: TransactionBegin, callback: () => T): T {
    if (this.closed || this.active) throw new Problem(PROBLEM_CODE.conflict, 'Run store is closed or already in a transaction', undefined,
      { reason: { kind: 'run_store_closed_or_already_transaction' } });
    this.active = true;
    try {
      return inTransaction({ root: this.root, db: this.db, borrowed: this.borrowed, savepoint: 'run',
        exec: sql => storageOperation(() => this.db.exec(sql)),
        notSynchronous: () => new Problem(PROBLEM_CODE.invalidInput, 'Run transaction callback must be synchronous', undefined,
          { reason: { kind: 'run_transaction_callback_must_synchronous' } }),
      }, begin, callback);
    } finally { this.active = false; }
  }
}

