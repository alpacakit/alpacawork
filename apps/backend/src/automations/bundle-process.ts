import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { platform, processIdentity, redactSecrets } from '@alpacawork/core';
import { automationOperations, type AutomationOperation } from '@alpacawork/contract/automation-program';
import { backendEntry } from '../app-paths.js';
import { terminateRecordedGroup } from '../runs/termination.js';
import {
  AlpacaworkError, BUNDLE_STOP_GRACE_MS, BUNDLE_TRIGGER_MS, bundleReply,
  type BundleControl, type BundleLaunch, type BundleMessage, type BundleOutcome, type BundleOutput,
  type BundlePhase, type OperationFailure, type RunPermission, type TriggerResult,
} from './bundle-ipc.js';

export { AlpacaworkError } from './bundle-ipc.js';
export type {
  BundleError, BundleLaunch, BundleOperationErrorCode, BundleOutcome, BundleOutput, BundlePhase, RunResult, TriggerResult,
} from './bundle-ipc.js';

const outputLimit = 16_384;
const environmentKeys = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'HOME', 'USER',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'] as const;

export type BundleIdentity = ReturnType<typeof processIdentity>;
type Awaitable<T> = Promise<T> | T;
export type BundleCallbacks = {
  recordIdentity(identity: BundleIdentity): Awaitable<void>;
  beforeImport(): Awaitable<boolean>;
  beforeRun(trigger: TriggerResult | null): Awaitable<RunPermission>;
  operate(phase: BundlePhase, name: AutomationOperation, input: unknown, signal: AbortSignal, number: number): Awaitable<unknown>;
};
export type BundleCompletion = {
  stopped: boolean;
  timedOut: boolean;
  phase: BundlePhase;
  exitCode: number | null;
  signal: string | null;
  outputTail: BundleOutput[];
  outcome: BundleOutcome | null;
};

class OutputTail {
  private readonly chunks: Array<{ stream: BundleOutput['stream']; bytes: Buffer }> = [];
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  private size = 0;

  append(stream: BundleOutput['stream'], data: Buffer): void {
    this.appendText(stream, this.decoders[stream].write(data));
  }

  private appendText(stream: BundleOutput['stream'], text: string): void {
    if (!text) return;
    const bytes = Buffer.from(text);
    this.chunks.push({ stream, bytes });
    this.size += bytes.length;
    while (this.size > outputLimit) {
      const first = this.chunks[0]!;
      let trim = Math.min(this.size - outputLimit, first.bytes.length);
      while (trim < first.bytes.length && (first.bytes[trim]! & 0xc0) === 0x80) trim++;
      if (trim === first.bytes.length) this.chunks.shift();
      else first.bytes = first.bytes.subarray(trim);
      this.size -= trim;
    }
  }

  result(): BundleOutput[] {
    for (const stream of ['stdout', 'stderr'] as const) this.appendText(stream, this.decoders[stream].end());
    const parts: BundleOutput[] = [];
    let bytes: Buffer[] = [];
    let stream: BundleOutput['stream'] | undefined;
    const flush = () => {
      if (stream !== undefined && bytes.length) parts.push({ stream, text: Buffer.concat(bytes).toString('utf8') });
      bytes = [];
    };
    for (const part of this.chunks) {
      if (part.stream !== stream) { flush(); stream = part.stream; }
      bytes.push(part.bytes);
    }
    flush();
    return parts;
  }
}

function send(child: ChildProcess, message: BundleControl): void {
  if (child.connected) child.send(message, () => {});
}

function failure(name: AutomationOperation, error: unknown): OperationFailure {
  return error instanceof AlpacaworkError
    ? { code: error.code, operation: name, message: redactSecrets(error.message) }
    : { code: 'temporary', operation: name, message: 'The operation could not finish' };
}

const refusal = (state: 'skipped' | 'failed', reason: string): BundleOutcome =>
  ({ state, trigger: null, result: null, reason, error: state === 'failed' ? { message: reason, file: null, line: null } : null });

/** A missing leader is never permission to signal a process found later with the same numeric group. */
export async function recoverAutomationBundle(identity: BundleIdentity): Promise<boolean> {
  try { return await terminateRecordedGroup(identity, BUNDLE_STOP_GRACE_MS); }
  catch { return false; }
}

/** The callback records the child's identity before any user module can be imported. */
export async function runAutomationBundle(launch: BundleLaunch, callbacks: BundleCallbacks, signal?: AbortSignal,
  runner = backendEntry('automation-bundle')): Promise<BundleCompletion> {
  const empty: BundleCompletion = { stopped: true, timedOut: false, phase: 'trigger', exitCode: null, signal: null, outputTail: [], outcome: null };
  if (signal?.aborted) return empty;

  const child = platform.run.spawnDetached(process.execPath, [runner], {
    cwd: launch.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])),
      ALPACAWORK_PROGRAM_TOKEN: launch.token,
      ALPACAWORK_SERVER: launch.server,
      ALPACAWORK_PROGRAM_RESTORE_ID: launch.restoreId,
    },
  });
  const output = new OutputTail();
  child.stdout?.on('data', (chunk: Buffer) => output.append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => output.append('stderr', chunk));

  let identity: BundleIdentity | undefined;
  let phase: BundlePhase = 'trigger';
  let timedOut = false;
  let ready = false;
  let admitted = false;
  let advancing = false;
  let closing = false;
  let sequence = 0;
  let outcome: BundleOutcome | null = null;
  const operations = new AbortController();
  const finished = bundleReply<void>();
  const closed = bundleReply<void>();
  const recorded = bundleReply<boolean>();
  const done = () => {
    closing = true;
    operations.abort();
    finished.resolve();
  };
  const abort = () => { send(child, { type: 'abort' }); done(); };
  const expire = () => { timedOut = true; abort(); };
  let deadline = setTimeout(expire, BUNDLE_TRIGGER_MS);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  child.once('spawn', () => {
    void Promise.resolve().then(async () => {
      identity = processIdentity(child.pid!);
      if (identity.started === null) throw new Error('Could not identify the automation runner');
      await callbacks.recordIdentity(identity);
      recorded.resolve(true);
    }).catch(() => {
      recorded.resolve(false);
      if (!closing) { outcome = refusal('failed', 'Could not record the identity of the automation runner'); done(); }
    });
  });
  child.once('error', () => {
    recorded.resolve(false);
    if (!closing) { outcome = refusal('failed', 'Could not start the automation runner'); done(); }
  });
  child.once('exit', done);
  child.once('close', () => closed.resolve());

  async function onMessage(message: BundleMessage): Promise<void> {
    if (closing) return;
    switch (message.type) {
      case 'ready': {
        if (ready) return;
        ready = true;
        if (!await recorded.promise || closing) return;
        const allowed = await callbacks.beforeImport();
        if (closing) return;
        if (!allowed) { outcome = refusal('skipped', 'The automation stopped before it could start'); done(); }
        else {
          admitted = true;
          send(child, { type: 'launch', launch });
        }
        return;
      }
      case 'before-run': {
        if (!admitted || advancing || phase !== 'trigger') return;
        advancing = true;
        const permission = await callbacks.beforeRun(message.trigger);
        if (closing) return;
        if (permission.allowed) {
          phase = 'run';
          clearTimeout(deadline);
          deadline = setTimeout(expire, launch.timeoutMinutes * 60_000);
        }
        send(child, { type: 'run-permission', permission });
        return;
      }
      case 'operate': {
        const { name, id } = message;
        if (!admitted || !Object.hasOwn(automationOperations, name) || !Number.isSafeInteger(id) || id <= sequence) return;
        sequence = id;
        try {
          if (phase !== message.phase)
            throw new AlpacaworkError('forbidden', name, 'This operation is unavailable in the current phase');
          const value = await callbacks.operate(phase, name, message.input, operations.signal, id);
          if (!closing) send(child, { type: 'operate-result', id, value });
        } catch (error) {
          if (!closing) send(child, { type: 'operate-error', id, error: failure(name, error) });
        }
        return;
      }
      case 'outcome':
        if (admitted) { outcome = message.outcome; done(); }
        return;
      case 'timeout':
        if (admitted && message.phase === phase) expire();
    }
  }

  const handling = new Set<Promise<void>>();
  child.on('message', message => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const work = onMessage(message as BundleMessage).catch(() => {
      if (!closing) { outcome = refusal('failed', 'The automation runner could not be admitted'); done(); }
    }).finally(() => handling.delete(work));
    handling.add(work);
  });

  await finished.promise;
  clearTimeout(deadline);
  signal?.removeEventListener('abort', abort);
  let stopped = true;
  if (identity?.started) stopped = await recoverAutomationBundle(identity);
  else if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    // A child without a recorded identity has not been permitted to load the bundle.
    child.kill('SIGKILL');
    await Promise.race([closed.promise, delay(1_000)]);
    stopped = child.exitCode !== null || child.signalCode !== null;
  }

  if (stopped) await Promise.race([closed.promise, delay(100, undefined, { ref: false })]);
  await Promise.allSettled([...handling, recorded.promise]);
  if (child.connected) child.disconnect();
  child.stdout?.destroy();
  child.stderr?.destroy();
  return { stopped, timedOut, phase, exitCode: child.exitCode, signal: child.signalCode, outcome, outputTail: output.result() };
}
