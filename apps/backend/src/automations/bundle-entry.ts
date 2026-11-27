import { dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { isLiveProcess, platform, processRows, redactSecrets } from '@alpacawork/core';
import {
  automationOperations, automationRunResultSchema, automationTriggerResultSchema,
  type AutomationOperation,
} from '@alpacawork/contract/automation-program';
import {
  AlpacaworkError, BUNDLE_STOP_GRACE_MS, BUNDLE_TRIGGER_MS, bundleError, bundleReply,
  type BundleControl, type BundleError, type BundleLaunch, type BundleMessage, type BundleOutcome, type BundlePhase, type RunPermission,
} from './bundle-ipc.js';

function describe(error: unknown, entry: string): BundleError {
  const code = error instanceof AlpacaworkError ? error.recordCode : null;
  const message = code === null
    ? Buffer.from(redactSecrets(error instanceof Error ? error.message : String(error))).subarray(0, 1024).toString('utf8')
    : null;
  let file: string | null = null, line: number | null = null;
  if (error instanceof Error && error.stack) {
    for (const frame of error.stack.split('\n').slice(1)) {
      const location = /(?:\(|\s)((?:file:\/\/|\/)[^)]+):(\d+):(\d+)\)?$/.exec(frame);
      if (!location) continue;
      const path = location[1]!.startsWith('file://') ? fileURLToPath(location[1]!) : location[1]!;
      const candidate = relative(dirname(entry), path);
      if (candidate === '..' || candidate.startsWith('..' + sep) || isAbsolute(candidate)) continue;
      file = candidate.split(sep).join('/');
      line = Number(location[2]);
      break;
    }
  }
  return { code, message, file, line };
}

function programResult<Schema extends z.ZodType>(phase: BundlePhase, schema: Schema, value: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AlpacaworkError('invalid', phase, 'The automation result did not match its schema');
  return parsed.data;
}

function sdk(phase: BundlePhase, operate: (phase: BundlePhase, name: AutomationOperation, input: unknown) => Promise<unknown>) {
  const groups: Record<string, Record<string, (input?: unknown) => Promise<unknown>>> = {};
  const methods: Record<string, unknown> = { z };
  for (const operation of Object.keys(automationOperations) as AutomationOperation[]) {
    const call = async (input: unknown = {}) => {
      if (operation === 'ai.ask' && input && typeof input === 'object' && 'schema' in input && input.schema !== undefined) {
        const { schema, ...rest } = input;
        if (!(schema instanceof z.ZodType)) throw new AlpacaworkError('invalid', operation, 'Use a schema created with alp.z');
        let encoded;
        try { encoded = z.toJSONSchema(schema); }
        catch { throw new AlpacaworkError('invalid', operation, 'Use a schema that can be represented as JSON'); }
        const result = schema.safeParse(await operate(phase, operation, { ...rest, schema: encoded }));
        if (!result.success) throw new AlpacaworkError('invalid', operation, 'The AI answer did not match the supplied schema');
        return result.data;
      }
      return operate(phase, operation, input);
    };
    const [group, method] = operation.split('.');
    if (method) (groups[group!] ??= {})[method] = call;
    else methods[operation] = call;
  }
  for (const [group, members] of Object.entries(groups)) methods[group] = Object.freeze(members);
  return Object.freeze(methods);
}

type BundleWorkerInput = { launch: BundleLaunch; programStarted: Int32Array };

async function evaluate({ launch, programStarted }: BundleWorkerInput): Promise<void> {
  const channel = parentPort!;
  const controller = new AbortController();
  const allowed = bundleReply<RunPermission>();
  const pending = new Map<number, ReturnType<typeof bundleReply<unknown>>>();
  let id = 0;
  let phase: BundlePhase = 'trigger';
  const send = (message: BundleMessage) => channel.postMessage(message);
  const operate = async (phase: BundlePhase, name: AutomationOperation, input: unknown): Promise<unknown> => {
    controller.signal.throwIfAborted();
    const number = ++id;
    const reply = bundleReply<unknown>();
    pending.set(number, reply);
    send({ type: 'operate', id: number, phase, name, input });
    const data = await reply.promise;
    return automationOperations[name].output.parse(data);
  };
  channel.on('message', (message: BundleControl) => {
    if (message.type === 'abort') controller.abort();
    if (message.type === 'run-permission') allowed.resolve(message.permission);
    if (message.type === 'operate-error' || message.type === 'operate-result') {
      const reply = pending.get(message.id);
      if (!reply) return;
      pending.delete(message.id);
      if (message.type === 'operate-result') reply.resolve(message.value);
      else reply.reject(new AlpacaworkError(message.error.code, message.error.operation, message.error.message, message.error.recordCode));
    }
  });
  controller.signal.addEventListener('abort', () => {
    allowed.resolve({ allowed: false, reason: 'The automation was stopped' });
    for (const waiter of pending.values()) waiter.reject(controller.signal.reason);
    pending.clear();
  }, { once: true });

  let trigger: BundleOutcome['trigger'] = null;
  let outcome: BundleOutcome;
  const base = { event: launch.event, preview: launch.preview, signal: controller.signal };
  try {
    // An uncaught program error may have no stack. Mark the boundary before entering user code.
    Atomics.store(programStarted, 0, 1);
    const entry = await import(/* @vite-ignore */ pathToFileURL(launch.entry).href);
    controller.signal.throwIfAborted();
    if (typeof entry.trigger === 'function') {
      const output: unknown = await entry.trigger({ ...base, alp: sdk('trigger', operate) });
      trigger = programResult('trigger', automationTriggerResultSchema, output);
    }
    if (trigger?.run === false) outcome = { state: 'skipped', trigger, reason: trigger.reason, result: null, error: null };
    else if (launch.preview && !launch.previewRun) outcome = { state: 'done', trigger, result: null, error: null };
    else {
      send({ type: 'before-run', trigger });
      const permit = await allowed.promise;
      if (!permit.allowed) outcome = { state: 'skipped', trigger, result: null, reason: permit.reason, error: null };
      else {
        phase = 'run';
        controller.signal.throwIfAborted();
        if (typeof entry.run !== 'function') throw new AlpacaworkError('invalid', 'run', 'Export run as a function');
        const output: unknown = await entry.run({ ...base, context: trigger?.context ?? null, alp: sdk('run', operate) });
        const result = programResult('run', automationRunResultSchema, output);
        outcome = { state: 'done', trigger, result, error: null };
      }
    }
  } catch (error) {
    if (error instanceof AlpacaworkError && error.code === 'limit') {
      outcome = { state: phase === 'trigger' ? 'skipped' : 'stopped', limit: error.operation,
        reason: error.message, trigger, result: null, error: null };
    } else {
      outcome = { state: 'failed', trigger, result: null, error: describe(error, launch.entry) };
    }
  }
  send({ type: 'outcome', outcome });
}

/** The IPC and deadline watchdog remains live while the worker executes the bundle, even in a synchronous loop. */
function supervise(): void {
  if (!process.connected || !process.send) { process.exitCode = 1; return; }
  let worker: Worker | undefined;
  let phase: BundlePhase = 'trigger';
  let timeoutMinutes = 10;
  let finished = false;
  let stopping = false;
  let deadline: NodeJS.Timeout | undefined;
  const send = (message: BundleMessage) => {
    if (process.connected) process.send!(message, undefined, {}, (error: Error | null) => { if (error) stop(true); });
  };
  function stop(signalGroup: boolean): void {
    if (stopping) return;
    stopping = true;
    clearTimeout(deadline);
    worker?.postMessage({ type: 'abort' } satisfies BundleControl);
    if (finished) void worker?.terminate();
    const kill = setTimeout(() => platform.run.signalGroup(process.pid, 'SIGKILL'), BUNDLE_STOP_GRACE_MS);
    if (signalGroup) platform.run.signalGroup(process.pid, 'SIGTERM');
    const poll = () => {
      try {
        // The snapshot's ps process shares this group but has exited by the time we inspect its rows.
        if (processRows().some(row => row.pgid === process.pid && row.pid !== process.pid &&
          isLiveProcess(row) && platform.run.started(row.pid) !== null)) return;
      } catch { return; }
      if (worker && !finished) return;
      clearInterval(polling);
      clearTimeout(kill);
      void Promise.all([process.stdout, process.stderr].map(stream =>
        new Promise<void>(resolve => stream.write('', () => resolve())))).then(() => process.exit(0));
    };
    const polling = setInterval(poll, 100);
    poll();
  }
  const expire = () => { send({ type: 'timeout', phase }); stop(true); };
  process.on('SIGTERM', () => stop(false));
  process.on('SIGINT', () => stop(true));
  process.on('disconnect', () => stop(true));

  process.on('message', (message: BundleControl) => {
    if (stopping) return;
    if (message.type === 'abort') { worker?.postMessage(message); return; }
    if (message.type === 'launch') {
      if (worker) return;
      timeoutMinutes = message.launch.timeoutMinutes;
      deadline = setTimeout(expire, BUNDLE_TRIGGER_MS);
      const programStarted = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const input: BundleWorkerInput = { launch: message.launch, programStarted };
      worker = new Worker(fileURLToPath(import.meta.url), { workerData: input });
      worker.on('message', (reply: BundleMessage) => {
        if (reply.type === 'outcome') { finished = true; clearTimeout(deadline); }
        if (!stopping) send(reply);
      });
      worker.once('error', error => {
        if (finished || stopping) return;
        finished = true;
        clearTimeout(deadline);
        send({ type: 'outcome', outcome: { state: 'failed', trigger: null, result: null,
          error: Atomics.load(programStarted, 0) === 1 ? describe(error, message.launch.entry) : bundleError('program_start_failed') } });
      });
      worker.once('exit', () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        if (!stopping)
          send({ type: 'outcome', outcome: { state: 'failed', trigger: null, result: null,
            error: bundleError('program_no_result') } });
      });
      return;
    }
    if (message.type === 'run-permission' && message.permission.allowed) {
      phase = 'run';
      clearTimeout(deadline);
      deadline = setTimeout(expire, timeoutMinutes * 60_000);
    }
    worker?.postMessage(message);
  });
  send({ type: 'ready' });
}

if (isMainThread) supervise();
else await evaluate(workerData as BundleWorkerInput);
