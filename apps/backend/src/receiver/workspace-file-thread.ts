/** Folder enumeration and filesystem notifications belong to the file worker, never the serving thread. */
import { Worker } from 'node:worker_threads';
import type { RunId } from '@alpacawork/contract';
import type { ChangeKey } from '@alpacawork/db';
import { backendEntry } from '../app-paths.js';
import type { TaskBundle } from './projection-contract.js';

export type WatchedRun = { readonly id: RunId; readonly task: string | null; readonly state?: string };
export type WatchedRunUpdate = { readonly upsert: readonly WatchedRun[]; readonly remove: readonly RunId[] };
export type FileObservationFault = { readonly task?: string; readonly path?: string; readonly message: string; readonly code?: string };
export type WorkspaceFileObservation = {
  readonly fileLists: readonly { readonly task: string; readonly files: TaskBundle['files'] }[];
  readonly keys: readonly ChangeKey[];
  /** Workspace-relative notification hints. Execution import and stop delivery still belong to the main thread. */
  readonly paths: readonly string[];
  readonly repair: boolean;
  readonly healthy: boolean;
  /** A failed folder is omitted from fileLists, preserving the last successful observation. */
  readonly faults: readonly FileObservationFault[];
};
export type FileWorkerRequest =
  | { readonly id: number; readonly kind: 'opened'; readonly task: string }
  | { readonly id: number; readonly kind: 'repair' | 'close' }
  | { readonly kind: 'runs'; readonly runs: readonly WatchedRun[] }
  | { readonly kind: 'update-runs'; readonly update: WatchedRunUpdate }
  | { readonly kind: 'execution'; readonly paths: readonly string[] };
export type FileWorkerMessage =
  | { readonly kind: 'observation'; readonly observation: WorkspaceFileObservation }
  | { readonly kind: 'ready' }
  | { readonly kind: 'reply'; readonly id: number; readonly fault?: FileObservationFault }
  | { readonly kind: 'failed'; readonly fault: FileObservationFault };

/** The transport boundary is injectable so process failure and recovery can be exercised with real or fixture workers. */
export interface WorkspaceFileWorker {
  on(event: 'message', listener: (message: FileWorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: FileWorkerRequest): void;
  terminate(): Promise<number>;
}
export type OpenedTaskObservation =
  | { readonly state: 'observed'; readonly files: TaskBundle['files'] }
  | { readonly state: 'retained'; readonly files: TaskBundle['files']; readonly fault: FileObservationFault };
type Operation = { kind: 'opened'; task: string } | { kind: 'repair' | 'close' };
type Session = { worker: WorkspaceFileWorker; ready: Promise<void>; resolve(): void; reject(error: Error): void;
  started: number; initialized: boolean; listed: Set<string>; failed?: Error };
type Recovery = { promise: Promise<void>; resolve(): void; reject(error: Error): void };
class WorkerUnavailable extends Error {
  constructor(cause: Error) { super(cause.message, { cause }); }
}
function deferred(): Recovery {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  // A restart is also driven in the background when no HTTP caller is waiting.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

export class WorkspaceFileThread {
  readonly initialized: Promise<void>;
  private session: Session | undefined;
  private readonly pending = new Map<number, { session: Session; resolve(): void; reject(error: Error): void }>();
  private readonly runs = new Map<RunId, WatchedRun>();
  private execution: readonly string[] = [];
  private readonly files = new Map<string, TaskBundle['files']>();
  private readonly opened = new Set<string>();
  private nextId = 0;
  private complete = false;
  private everReady = false;
  private restarts = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private recovery?: Recovery;
  private stopping = false;
  private closing: Promise<void> | undefined;

  static start(root: string, observed: (observation: WorkspaceFileObservation) => void,
    createWorker: () => WorkspaceFileWorker = () => new Worker(backendEntry('receiver/workspace-file-worker'), { workerData: { root } })): WorkspaceFileThread {
    return new WorkspaceFileThread(observed, createWorker);
  }
  private constructor(private readonly observed: (observation: WorkspaceFileObservation) => void,
    private readonly createWorker: () => WorkspaceFileWorker) {
    this.initialized = this.spawn().ready;
  }
  private spawn(): Session {
    const ready = deferred();
    const session: Session = { worker: this.createWorker(), ready: ready.promise, resolve: ready.resolve, reject: ready.reject,
      started: Date.now(), initialized: false, listed: new Set() };
    this.session = session;
    session.worker.on('message', message => {
      if (this.session !== session || session.failed) return;
      if (message.kind === 'reply') {
        const request = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.fault) request?.reject(Object.assign(new Error(message.fault.message), message.fault));
        else request?.resolve();
      } else if (!this.stopping && message.kind === 'observation') {
        this.complete = message.observation.healthy;
        for (const result of message.observation.fileLists) { this.files.set(result.task, result.files); session.listed.add(result.task); }
        this.observed({ ...message.observation, healthy: message.observation.healthy && (!this.everReady || session.initialized) });
      } else if (!this.stopping && message.kind === 'ready') {
        void this.restore(session).catch(error => this.fail(session, error));
      } else if (message.kind === 'failed') {
        this.fail(session, Object.assign(new Error(message.fault.message), message.fault));
      }
    });
    session.worker.on('error', error => this.fail(session, error));
    session.worker.on('exit', code => {
      if (this.session !== session) return;
      if (this.stopping) {
        this.complete = false;
        const error = new Error('Workspace file worker closed before the operation completed');
        session.reject(error); this.rejectPending(session, error);
      } else this.fail(session, new Error(`Workspace file worker ended (${code})`));
    });
    return session;
  }
  private async restore(session: Session): Promise<void> {
    this.post(session, { kind: 'runs', runs: [...this.runs.values()] });
    this.post(session, { kind: 'execution', paths: this.execution });
    if (this.everReady) {
      // The replacement has no memory of folders removed during its absence.
      // Reopen previously known Tasks before the full repair to publish removals too.
      for (const task of new Set([...this.files.keys(), ...this.opened])) {
        try { await this.send(session, { kind: 'opened', task }); this.rememberOpened(session, task); }
        catch (error) { if (error instanceof WorkerUnavailable) throw error; }
      }
      await this.send(session, { kind: 'repair' });
    }
    if (this.stopping || session.failed || this.session !== session) return;
    session.initialized = true;
    this.everReady = true;
    session.resolve();
    this.observed({ fileLists: [], keys: [], paths: [], repair: true, healthy: this.complete, faults: [] });
  }
  private rejectPending(session: Session, error: Error): void {
    for (const [id, request] of this.pending) if (request.session === session) { this.pending.delete(id); request.reject(error); }
  }
  private fail(session: Session, cause: Error): void {
    if (this.stopping || this.session !== session || session.failed) return;
    const error = cause instanceof WorkerUnavailable ? cause : new WorkerUnavailable(cause);
    session.failed = error;
    this.complete = false;
    session.reject(error); this.rejectPending(session, error);
    void session.worker.terminate().catch(() => {});
    if (!this.everReady) return;
    this.observed({ fileLists: [], keys: [], paths: [], repair: false, healthy: false, faults: [{ message: cause.message,
      ...typeof (cause as NodeJS.ErrnoException).code === 'string' ? { code: (cause as NodeJS.ErrnoException).code } : {} }] });
    if (Date.now() - session.started >= 30_000) this.restarts = 0;
    this.scheduleRestart();
  }
  private scheduleRestart(): void {
    if (this.stopping || this.retry) return;
    const recovery = this.recovery = deferred();
    const wait = Math.min(30_000, 250 * 2 ** Math.min(this.restarts++, 7));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.stopping) return;
      try {
        const session = this.spawn();
        void session.ready.then(recovery.resolve, recovery.reject);
      } catch (cause) {
        recovery.reject(new WorkerUnavailable(cause instanceof Error ? cause : new Error(String(cause))));
        this.scheduleRestart();
      }
    }, wait);
  }
  get healthy(): boolean { return this.complete && !!this.session?.initialized && !this.session.failed && !this.stopping; }

  private rememberOpened(session: Session, task: string): void {
    if (this.stopping || this.session !== session || session.failed || session.listed.has(task)) return;
    session.listed.add(task);
    const previous = this.files.get(task);
    this.files.set(task, []);
    // A new worker treats an empty folder as its default. The owner must still
    // publish the disappearance of an older list, or clear its old folder fault.
    if (previous?.length || this.everReady && !session.initialized) this.observed({
      fileLists: [{ task, files: [] }], keys: [{ kind: 'files', id: task }], paths: [], repair: true,
      healthy: this.complete && session.initialized, faults: [],
    });
  }

  /** Wait for recovery once; if that attempt also fails, explicitly retain a known older observation. */
  async openedTask(task: string): Promise<OpenedTaskObservation> {
    const id = task.split('/').at(-1)!;
    this.opened.add(id);
    try {
      const session = await this.request({ kind: 'opened', task });
      this.rememberOpened(session, id);
      return { state: 'observed', files: this.files.get(id)! };
    } catch (error) {
      if (!(error instanceof WorkerUnavailable) || !this.files.has(id) || this.stopping) throw error;
      return { state: 'retained', files: this.files.get(id)!, fault: { task: id, message: error.message } };
    }
  }
  repair(): Promise<void> { return this.request({ kind: 'repair' }).then(() => {}); }
  observeRuns(runs: readonly WatchedRun[]): void {
    if (this.stopping) return;
    this.runs.clear(); for (const run of runs) this.runs.set(run.id, run);
    if (this.session && !this.session.failed) this.post(this.session, { kind: 'runs', runs });
  }
  updateRuns(update: WatchedRunUpdate): void {
    if (this.stopping) return;
    for (const id of update.remove) this.runs.delete(id);
    for (const run of update.upsert) this.runs.set(run.id, run);
    if (this.session && !this.session.failed) this.post(this.session, { kind: 'update-runs', update });
  }
  observeExecution(paths: readonly string[]): void {
    if (this.stopping) return;
    this.execution = [...paths];
    if (this.session && !this.session.failed) this.post(this.session, { kind: 'execution', paths });
  }
  private post(session: Session, message: FileWorkerRequest): void {
    try { session.worker.postMessage(message); } catch (cause) { this.fail(session, cause instanceof Error ? cause : new Error(String(cause))); }
  }
  private async available(): Promise<Session> {
    if (this.stopping) throw new Error('Workspace file worker is closing');
    const session = this.session;
    await (session && !session.failed ? session.ready : this.recovery?.promise ?? Promise.reject(session?.failed ?? new Error('Workspace file worker is unavailable')));
    if (this.stopping) throw new Error('Workspace file worker is closing');
    if (!this.session || this.session.failed) throw this.session?.failed ?? new WorkerUnavailable(new Error('Workspace file worker is unavailable'));
    return this.session;
  }
  private async request(message: Operation): Promise<Session> {
    for (let attempt = 0; ; attempt++) {
      try { const session = await this.available(); await this.send(session, message); return session; }
      catch (error) { if (!(error instanceof WorkerUnavailable) || attempt > 0 || this.stopping) throw error; }
    }
  }
  private send(session: Session, message: Operation): Promise<void> {
    if (session.failed) return Promise.reject(session.failed);
    if (this.session !== session || this.stopping && message.kind !== 'close')
      return Promise.reject(new WorkerUnavailable(new Error('Workspace file worker is closing')));
    const id = ++this.nextId;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { session, resolve, reject });
      this.post(session, { ...message, id });
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    clearTimeout(this.retry); this.retry = undefined;
    this.recovery?.reject(new Error('Workspace file worker is closing'));
    const session = this.session;
    this.closing = (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        if (session && !session.failed) await Promise.race([this.send(session, { kind: 'close' }).catch(() => {}),
          new Promise<void>(resolve => { deadline = setTimeout(resolve, 2_000); })]);
      } finally {
        clearTimeout(deadline);
        if (session) {
          const error = new Error('Workspace file worker is closing');
          session.reject(error); this.rejectPending(session, error);
          await session.worker.terminate();
        }
      }
    })();
    return this.closing;
  }
}
