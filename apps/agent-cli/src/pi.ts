/** Pi RPC 1.5.0 boundary, verified against upstream 136a7b2d7d46a65d047c22c5af92ca214763466b.
 * No prompt markers, extension installation, or admission-as-receipt.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { platform } from '@alpacawork/core';
import { diagnosticFailure } from '@alpacawork/contract/agent-diagnostics';
import { toolResultText } from '@alpacawork/contract/run';
import type { Admission, Instruction, Runtime, RuntimeIO } from './run.js';
import { requiredValue, unknownOption, withUsage } from './options.js';
import { callTokens, type ContextUpdate } from '@alpacawork/contract/agent-context';
import { measuredUsage, usageRecord as object } from './usage.js';
import { emitToolEnd, emitToolStart } from './tool-activity.js';

type Options = { output: string | null; session: string | null; model: string | null; thinking: string | null; trust: string | null };
type Input = { input: Instruction; disposition: string | null; observed: boolean; taken: boolean; ambiguous: boolean; failure: string | null };
// A bridge turn can contain multiple RPC executions when a steer crosses a settled boundary.
// Pending preflight belongs to neither execution until its authoritative disposition arrives.
type Execution = { inputs: Input[]; observations: string[]; assistant: Record<string, unknown> | null;
  settled: Record<string, unknown> | null };
type Turn = { inputs: Input[]; executions: Execution[]; active: Execution | null };
type Waiter = { command: string; resolve(value: Record<string, unknown>): void; reject(error: Error): void; accept?: (data: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> };
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const USAGE = 'Usage: alpacawork-agent pi [-o FILE] [--session ID] [--model PROVIDER/ID] [--thinking LEVEL] [--approve | --no-approve]';
const sessionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
function options(args: string[]): Options {
  return withUsage(USAGE, () => {
    const result: Options = { output: null, session: null, model: null, thinking: null, trust: null };
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === '--approve' || flag === '--no-approve') {
        if (result.trust) throw new Error('Only one project trust override is allowed');
        result.trust = flag; continue;
      }
      if (!['-o', '--session', '--model', '--thinking'].includes(flag)) unknownOption(flag);
      const value = requiredValue(args, ++i, flag);
      if (flag === '-o') result.output = value;
      if (flag === '--session') { if (!sessionId(value)) throw new Error('--session needs a complete ID, not a path'); result.session = value; }
      if (flag === '--model') {
        const slash = value.indexOf('/');
        if (slash <= 0 || slash === value.length - 1) throw new Error('--model needs PROVIDER/ID');
        result.model = value; // Keep everything after the first slash, including further slashes.
      }
      if (flag === '--thinking') { if (!THINKING.has(value)) throw new Error('Unsupported thinking level'); result.thinking = value; }
    }
    return result;
  });
}
/** Reads only the bounded header. New sessions are not persisted until the first conversation. */
function verifyHeader(file: string, id: string, allowMissing: boolean): void {
  if (!existsSync(file) && allowMissing) return;
  const fd = openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(64 * 1024), size = readSync(fd, bytes, 0, bytes.length, 0), end = bytes.subarray(0, size).indexOf(10);
    if (end < 0) throw new Error('Pi session header is missing or too large');
    const header = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end))));
    if (header.type !== 'session' || header.id !== id || typeof header.cwd !== 'string' ||
      realpathSync(header.cwd) !== realpathSync(process.cwd())) throw new Error('Pi session ID or cwd does not match');
  } finally { closeSync(fd); }
}
/** Each model call's own total; a compaction leaves the fill unknown until the next call (pi says null too). */
export function piContext(value: unknown): ContextUpdate | null {
  const row = object(value), message = object(row.message);
  if (row.type === 'message_end' && message.role === 'assistant') {
    const usage = object(message.usage);
    const used = callTokens(usage.totalTokens) ?? callTokens(usage.input, usage.output, usage.cacheRead, usage.cacheWrite);
    return used === null ? null : { usedTokens: used, compacted: false };
  }
  return row.type === 'compaction_end' ? { usedTokens: null, compacted: true } : null;
}
/** pi's own reckoning of the fill and its window, read when a turn ends. */
export function piStatsContext(value: unknown): ContextUpdate | null {
  const context = object(object(value).contextUsage), window = callTokens(context.contextWindow);
  if (!window) return null;
  return { windowTokens: window, ...context.tokens === null ? {} : { usedTokens: callTokens(context.tokens) } };
}
export function piUsage(value: unknown) {
  const tokens = object(object(value).tokens);
  return measuredUsage('conversation', { input: tokens.input, cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite, output: tokens.output });
}
export class PiRuntime implements Runtime {
  private readonly options: Options;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ended: Promise<void> = Promise.resolve();
  private closing: Promise<void> | null = null;
  private closed = false;
  private turn: Turn | null = null;
  private transportFailure: Error | null = null;
  private finishing: Promise<void> | null = null;
  private turnCount = 0;
  private lastFailed = false;
  private id = '';
  private file = '';
  private nextId = 0;
  private waiters = new Map<string, Waiter>();
  private writes: Promise<void> = Promise.resolve();
  constructor(args: string[], private readonly io: RuntimeIO, private readonly command: string) { this.options = options(args); }
  idle(): boolean { return this.turn === null && this.finishing === null; }
  turns(): number { return this.turnCount; }
  failed(): boolean { return this.lastFailed; }
  async start(): Promise<void> {
    if (this.closed) throw new Error('Pi bridge is closed');
    const o = this.options;
    const child = spawn(this.command, ['--mode', 'rpc', ...(o.model ? ['--model', o.model] : []),
      ...(o.thinking !== null ? ['--thinking', o.thinking] : []), ...(o.session ? ['--session', o.session] : []),
      ...(o.trust ? [o.trust] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }); let buffered = '';
    this.ended = new Promise(resolve => child.once('close', () => resolve()));
    child.stderr.pipe(process.stderr, { end: false });
    const fault = (error: Error) => this.rpcFault(error);
    child.once('error', fault);
    child.stdin.on('error', fault); child.stdout.on('error', fault);
    child.once('exit', (code, signal) => {
      if (!this.closed) fault(new Error(`Pi RPC ended before bridge shutdown (${signal ?? code})`));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        buffered += decoder.decode(chunk, { stream: true });
        for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error('Pi RPC line exceeds 16 MiB');
          if (line.trim()) {
            let row: unknown;
            try { row = JSON.parse(line); } catch { throw new Error('Pi RPC contains invalid JSON'); }
            this.receive(object(row));
          }
        }
        if (Buffer.byteLength(buffered) > 16 * 1024 * 1024) throw new Error('Pi RPC line exceeds 16 MiB');
      } catch (error) { fault(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdout.once('end', () => {
      try {
        buffered += decoder.decode();
        if (buffered.length) throw new Error('Pi RPC ended with an incomplete LF-framed line');
      } catch (error) { fault(new Error('Pi RPC invalid EOF: ' + (error instanceof Error ? error.message : String(error)))); }
    });
    try {
      this.checkState(await this.request('get_state'), true);
      this.io.emit({ type: 'thread.started', thread_id: this.id });
    } catch (error) {
      // No thread.started until identity/model/cwd verification succeeds. Readers retain their session guard.
      this.io.emit({ type: 'error', message: diagnosticFailure(error instanceof Error ? error.message : String(error))!.message });
      throw error;
    }
  }
  private rpcFault(error: Error): void {
    this.transportFailure ??= error;
    this.reject(error);
    this.io.emit({ type: 'error', message: diagnosticFailure(error.message)!.message });
    if (!this.closed) this.io.fatal(error);
  }
  private checkState(state: Record<string, unknown>, initial: boolean): void {
    if (!sessionId(state.sessionId) || typeof state.sessionFile !== 'string' || !isAbsolute(state.sessionFile))
      throw new Error('Pi returned no complete session ID or session file');
    if (this.options.session && state.sessionId !== this.options.session || this.id && state.sessionId !== this.id)
      throw new Error('Pi resumed a different session');
    const model = object(state.model);
    if (typeof model.provider !== 'string' || !model.provider || typeof model.id !== 'string' || !model.id)
      throw new Error('Pi returned no effective model');
    const actual = `${model.provider}/${model.id}`;
    if (this.options.model !== null && actual !== this.options.model) throw new Error('Pi resolved a different model');
    if (typeof state.thinkingLevel !== 'string' || !THINKING.has(state.thinkingLevel)) throw new Error('Pi returned no effective thinking level');
    if (state.isStreaming !== false || state.isCompacting !== false || state.pendingMessageCount !== 0)
      throw new Error('Pi session is already busy');
    verifyHeader(state.sessionFile, state.sessionId, initial && this.options.session === null);
    if (this.file && realpathSync(state.sessionFile) !== realpathSync(this.file)) throw new Error('Pi changed its session file');
    this.id = state.sessionId; this.file = state.sessionFile;
    this.io.emit({ type: 'item.completed', item: { type: 'agent_configuration', model: actual,
      requested_effort: this.options.thinking, effective_effort: state.thinkingLevel } });
    if (this.options.thinking !== null && this.options.thinking !== state.thinkingLevel)
      process.stderr.write(`alpacawork-agent: Pi thinking requested=${this.options.thinking}, effective=${state.thinkingLevel}\n`);
  }
  private write(value: object): Promise<void> {
    const line = JSON.stringify(value) + '\n';
    const write = this.writes.then(() => new Promise<void>((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) { reject(new Error('Pi RPC stdin is closed')); return; }
      // The callback waits for the write even under backpressure; JSON framing is always LF-only.
      stdin.write(line, error => error ? reject(error) : resolve());
    }));
    this.writes = write.catch(() => {});
    return write;
  }
  private request(command: string, fields: object = {}, accept?: (data: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const id = `pi-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`Pi ${command} response timed out`)); }, 10000);
      this.waiters.set(id, { command, resolve, reject, timer, accept });
      void this.write({ id, type: command, ...fields }).catch(error => {
        this.waiters.delete(id); clearTimeout(timer); reject(error);
      });
    });
  }
  private reject(error: Error): void {
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }
  private execution(): Execution {
    const turn = this.turn;
    if (!turn) throw new Error('Pi RPC started an execution without an instruction');
    if (!turn.active) {
      turn.active = { inputs: [], observations: [], assistant: null, settled: null };
      turn.executions.push(turn.active);
    }
    return turn.active;
  }
  private correlate(execution: Execution): void {
    while (execution.observations.length) {
      const input = execution.inputs.find(input => !input.observed);
      if (!input) return;
      const text = execution.observations.shift()!; input.observed = true;
      if (input.ambiguous || input.input.text !== text || execution.inputs.filter(row => row.input.text === text).length !== 1) continue;
      input.taken = true; this.io.started(input.input.id);
    }
  }
  private receive(row: Record<string, unknown>): void {
    if (row.type === 'response' && typeof row.id === 'string') {
      const waiter = this.waiters.get(row.id);
      if (!waiter) return;
      this.waiters.delete(row.id); clearTimeout(waiter.timer);
      if (row.command !== waiter.command || row.success !== true) waiter.reject(new Error(`Pi ${waiter.command} failed: ${diagnosticFailure(String(row.error ?? 'invalid response'))!.message}`));
      else {
        const data = object(row.data);
        try { waiter.accept?.(data); waiter.resolve(data); }
        catch (error) { waiter.reject(error instanceof Error ? error : new Error(String(error))); }
      }
      return;
    }
    if (this.closed) return;
    if (row.type === 'extension_ui_request' && !['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(String(row.method))) {
      void this.write({ type: 'extension_ui_response', id: row.id, cancelled: true })
        .finally(() => this.io.fatal(new Error('Pi extension requested unsupported interaction'))).catch(() => {});
    }
    if (row.type === 'agent_start') this.execution().assistant = null;
    const message = object(row.message);
    if (row.type === 'message_start' && message.role === 'user') {
      const content = message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) && content.every(part => object(part).type === 'text' && typeof object(part).text === 'string')
        ? content.map(part => object(part).text).join('') : null;
      if (text !== null) { const execution = this.execution(); execution.observations.push(text); this.correlate(execution); }
    }
    if (row.type === 'message_start' && message.role === 'assistant') this.execution().assistant = null;
    if (row.type === 'message_end' && message.role === 'assistant') this.execution().assistant = message;
    const context = piContext(row);
    if (context) this.io.emit({ type: 'context.updated', context });
    if (row.type === 'tool_execution_start') {
      emitToolStart(this.io, 'mcp_tool_call', row.toolCallId, row.toolName, row.args);
    } else if (row.type === 'tool_execution_end') {
      emitToolEnd(this.io, 'mcp_tool_call', row.toolCallId, row.toolName,
        toolResultText(object(row.result).content), row.isError === true);
    }
    if (row.type === 'agent_settled' && this.turn?.active) {
      this.turn.active.settled = row;
      this.turn.active = null;
      this.maybeFinish();
    }
  }
  async deliver(input: Instruction): Promise<Admission> {
    if (this.finishing) await this.finishing;
    if (this.closed) return { state: 'uncertain', message: 'Pi bridge is closed' };
    const wasBusy = this.turn !== null;
    if (!this.turn) {
      this.turn = { inputs: [], executions: [], active: null };
      this.io.emit({ type: 'turn.started' });
    }
    const turn = this.turn, submitted = turn.active;
    const record: Input = { input, disposition: null, observed: false, taken: false, ambiguous: false, failure: null };
    turn.inputs.push(record);
    try {
      await this.request('prompt', { message: input.text, ...(wasBusy ? { streamingBehavior: 'steer' } : {}) }, result => {
        if (!['started', 'queued', 'handled'].includes(String(result.disposition))) throw new Error('Pi prompt returned no disposition');
        record.disposition = String(result.disposition);
        if (record.disposition === 'handled') throw new Error('Pi extension handled input without a processing receipt');
        const execution = record.disposition === 'started' ? this.execution() : submitted;
        if (!execution) throw new Error('Pi queued input without an active execution');
        execution.inputs.push(record);
        const same = execution.inputs.filter(prior => prior.input.text === input.text);
        if (same.length > 1) for (const prior of same) prior.ambiguous = true;
        this.correlate(execution);
      });
      return { state: 'transferred' };
    } catch (error) {
      record.disposition = 'failed'; record.ambiguous = true;
      record.failure = diagnosticFailure('Pi input processing is unconfirmed: ' + (error instanceof Error ? error.message : String(error)))!.message;
      // Failed preflight has no promised settled event (handled extensions may return immediately).
      // End this bridge through the common failure/receipt/cleanup owner instead of waiting indefinitely.
      this.io.emit({ type: 'turn.failed', error: { message: record.failure } });
      this.io.fatal(new Error(record.failure));
      return { state: 'uncertain', message: record.failure };
    } finally { this.maybeFinish(); }
  }
  private maybeFinish(): void {
    const turn = this.turn;
    // Admission response order is interpreted in receive(), before later RPC events in the same LF batch.
    if (this.closed || !turn || turn.active || turn.inputs.some(input => input.disposition === null) || this.finishing) return;
    this.finishing = Promise.resolve().then(() => this.finish(turn))
      .catch(error => this.io.fatal(error instanceof Error ? error : new Error(String(error))))
      .finally(() => { this.finishing = null; this.io.idle(); });
  }
  private async finish(turn: Turn): Promise<void> {
    const replies: string[] = [];
    let failure: string | null = null;
    for (const execution of turn.executions) {
      const final = execution.assistant, content = final?.content;
      const texts = Array.isArray(content) ? content.filter(part => object(part).type === 'text').map(part => object(part).text) : [];
      if (execution.settled?.aborted !== false || final?.stopReason === 'aborted') failure ??= 'Pi execution was aborted';
      else if (final?.stopReason === 'error') failure ??= diagnosticFailure(final.errorMessage)?.message ?? 'Pi assistant stopped with an error';
      else if (final?.stopReason === 'length') failure ??= 'Pi assistant reached its output length limit';
      else if (final?.stopReason !== 'stop') failure ??= 'Pi execution has no normally stopped final assistant message';
      else if (!texts.length || !texts.every(text => typeof text === 'string') || !texts.some(text => String(text).length))
        failure ??= 'Pi execution has no normal final text';
      else replies.push(texts.join(''));
    }
    failure ??= turn.inputs.find(input => input.failure)?.failure ?? null;
    if (!failure && (!turn.executions.length || turn.inputs.some(input => !input.taken || input.ambiguous)))
      failure = 'Pi input processing is unconfirmed';
    let usage = null;
    if (!failure) {
      this.checkState(await this.request('get_state'), false);
      const stats = await this.request('get_session_stats');
      if (stats.sessionId !== this.id || stats.sessionFile !== this.file) throw new Error('Pi stats belong to another session');
      usage = piUsage(stats);
      const context = piStatsContext(stats);
      if (context) this.io.emit({ type: 'context.updated', context });
    }
    this.turnCount++; this.lastFailed = failure !== null;
    if (failure) this.io.emit({ type: 'turn.failed', error: { message: diagnosticFailure(failure)!.message } });
    else {
      const text = replies.join('\n\n');
      if (this.options.output) writeFileSync(this.options.output, text);
      this.io.emit({ type: 'item.completed', item: { type: 'agent_message', text } });
      this.io.emit({ type: 'turn.completed', usage });
    }
    this.turn = null;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.reject(new Error('Pi bridge closed'));
    const child = this.child;
    this.closing = (async () => {
      if (!child?.pid) { if (this.transportFailure) throw this.transportFailure; return; }
      // Keep the existing process/identity owner. Pi stays in its bridge's process tree and manager unit.
      const owned = new Map(platform.run.commandProcesses(child.pid, null).map(row => [row.pid, row]));
      const signal = (sig: NodeJS.Signals) => {
        for (const row of platform.run.commandProcesses(child.pid!, null)) owned.set(row.pid, row);
        for (const process of owned.values()) if (platform.run.started(process.pid) === process.started) {
          try { globalThis.process.kill(process.pid, sig); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        }
      };
      const waitForExit = () => new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 300);
        void this.ended.then(() => { clearTimeout(timer); resolve(); });
      });
      if (!child.stdin.destroyed) child.stdin.end();
      await waitForExit();
      signal('SIGTERM');
      await waitForExit();
      signal('SIGKILL');
      await this.ended;
      const deadline = Date.now() + 3000;
      while ([...owned.values()].some(row => platform.run.started(row.pid) === row.started &&
        platform.run.commandProcesses(row.pid, null).length > 0)) {
        if (Date.now() >= deadline) throw new Error('Pi descendants did not stop');
        await delay(20);
      }
      if (this.transportFailure) throw this.transportFailure;
    })();
    return this.closing;
  }
}
