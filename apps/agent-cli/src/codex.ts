import { measuredUsage, usageRecord } from './usage.js';
import type { AgentUsage } from '@alpacawork/contract/agent-bridge';
import { limitWindow, type LimitWindow, type LimitsReport } from '@alpacawork/contract/agent-limits';
import { callTokens, type ContextUpdate } from '@alpacawork/contract/agent-context';
import type { RunFailure } from '@alpacawork/contract/run-failure';
/** Codex-specific exec options and app-server protocol. */
import { type ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { Admission, CompactionResult, Instruction, Runtime, RuntimeIO } from './run.js';
import { unknownOption, withUsage } from './options.js';
import { defaultCodexHome, originalCodexThread, prepareCodexHome } from './codex-home.js';

/** Codex's own error kinds that mean its plan or the model ran out. */
const CODEX_CAUSES: Record<string, NonNullable<RunFailure['cause']>> = { usageLimitExceeded: 'session_limit', serverOverloaded: 'model_capacity' };
const INITIALIZE = { clientInfo: { name: 'alpacawork-agent', title: null, version: '0.1.6' },
  capabilities: { experimentalApi: false, requestAttestation: false } };

type Options = { model: string | null; config: string[]; features: string[]; sandbox: string | null;
  output: string | null; resume: string | null };
const USAGE = 'Usage: alpacawork-agent codex [-m MODEL] [-c KEY=VALUE]... [-s SANDBOX] [--skip-git-repo-check] [--json] ' +
  '[-o FILE] [resume [options] [--] SESSION]';

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { model: null, config: [], features: [], sandbox: null, output: null, resume: null };
  let resuming = false, positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (positional || !arg.startsWith('-') && resuming) {
      if (!resuming || options.resume !== null) throw new Error(`Unexpected argument: ${arg}`);
      options.resume = arg;
    } else if (arg === 'resume' && !resuming) resuming = true;
    else if (arg === '--') positional = true;
    else if (arg === '-m' || arg === '--model') options.model = value();
    else if (arg === '-c' || arg === '--config') options.config.push('-c', value());
    else if (arg === '--enable' || arg === '--disable') options.features.push(arg, value());
    else if (arg === '-s' || arg === '--sandbox') options.sandbox = value();
    else if (arg === '-o' || arg === '--output-last-message') options.output = value();
    else if (arg === '--skip-git-repo-check' || arg === '--json') continue;
    else unknownOption(arg);
  }
  if (resuming && options.resume === null) throw new Error('resume needs a SESSION');
  return options;
}

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };
/** A compaction Codex runs as a turn of its own (thread/compact/start), which is no turn of the Run. */
type Compaction = { settle(result: CompactionResult): void; error: string | null };
const snake = (name: string) => name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
const imageInput = (value: string) => {
  const images = [...value.matchAll(/^!\[[^\]\n]*\]\((\/[^)\n]+\.(?:png|jpe?g|webp))\)$/gim)]
    .map(match => match[1]!).filter(path => isAbsolute(path) && existsSync(path));
  return [...text(value), ...[...new Set(images)].map(path => ({ type: 'localImage', path }))];
};

export class CodexRuntime implements Runtime {
  private readonly options: Options;
  private server: ChildProcessByStdio<Writable, Readable, null> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffered = '';
  private threadId = '';
  private turnId: string | null = null;
  private compaction: Compaction | null = null;
  private endedTurns = new Set<string>();
  private lastMessage = '';
  private usage: AgentUsage | null = null;
  private turnCount = 0;
  private lastFailed = false;
  private closing = false;
  private closed = false;

  constructor(args: string[], private readonly io: RuntimeIO, private readonly command: string) {
    this.options = withUsage(USAGE, () => parseOptions(args));
  }

  idle(): boolean { return this.turnId === null; }
  turns(): number { return this.turnCount; }
  failed(): boolean { return this.lastFailed; }
  close(): void {
    this.closed = true;
    this.closing = true;
    this.server?.kill('SIGTERM');
    this.rejectPending(new Error('codex app-server closed'));
  }
  /** Resolves when Codex's compaction turn ends. Only called between turns, so every turn notification meanwhile is its. */
  compact(): Promise<CompactionResult> {
    return new Promise(settle => {
      this.compaction = { settle, error: null };
      this.request('thread/compact/start', { threadId: this.threadId })
        .catch(error => this.settleCompaction({ compacted: false, message: error instanceof Error ? error.message : String(error) }));
    });
  }
  private settleCompaction(result: CompactionResult): void {
    const compaction = this.compaction;
    this.compaction = null;
    compaction?.settle(result);
  }

  async start(): Promise<void> {
    const home = defaultCodexHome();
    const original = home && this.options.resume ? originalCodexThread(home, this.options.resume) : null;
    if (home && !original) {
      // Let Codex resolve its own configuration paths. No thread is opened in the source home.
      await this.launch({ ...process.env, CODEX_HOME: home.source });
      const { config } = await this.request('config/read', { includeLayers: false });
      prepareCodexHome(home, config);
      await this.stopServer();
    }
    const isolated = home && !original;
    await this.launch(isolated ? { ...process.env, CODEX_HOME: home.target, CODEX_SQLITE_HOME: home.target }
      : original ? { ...process.env, CODEX_HOME: home!.source } : process.env,
      isolated ? ['-c', `sqlite_home=${JSON.stringify(home.target)}`, '-c', `log_dir=${JSON.stringify(`${home.target}/log`)}`] : []);
    if (isolated) {
      const account = await this.request('account/read', { refreshToken: false });
      if (!account.account) throw new Error('Shared Codex file authentication did not load; configure a dedicated CODEX_HOME explicitly');
    }
    if (original) process.stderr.write('alpacawork-agent: resuming the existing conversation in its original Codex home\n');
    const thread = { model: this.options.model, sandbox: this.options.sandbox, approvalPolicy: 'never', cwd: process.cwd() };
    const opened = this.options.resume === null ? await this.request('thread/start', thread)
      : await this.request('thread/resume', { ...thread, threadId: this.options.resume });
    if (this.options.resume && opened.thread.id !== this.options.resume) throw new Error('Codex resumed a different thread than requested');
    this.threadId = opened.thread.id;
    this.io.emit({ type: 'thread.started', thread_id: this.threadId });
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.closing = true;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => server.kill('SIGKILL'), 5000);
      server.once('close', () => { clearTimeout(timeout); resolve(); });
      server.kill('SIGTERM');
    });
    this.server = null;
    this.buffered = '';
    this.closing = false;
  }

  private async launch(env: NodeJS.ProcessEnv, storageConfig: string[] = []): Promise<void> {
    // Input is read during start, so close can land between the two servers.
    if (this.closed) throw new Error('codex app-server closed');
    const server = spawn(this.command, ['app-server', ...this.options.config, ...this.options.features, ...storageConfig],
      { env, stdio: ['pipe', 'pipe', 'inherit'] }) as ChildProcessByStdio<Writable, Readable, null>;
    this.server = server;
    server.once('error', error => this.io.fatal(new Error(`cannot start codex app-server: ${error.message}`)));
    server.once('exit', (code, signal) => {
      if (!this.closing) this.io.fatal(new Error(`codex app-server ended (${signal ?? code})`));
      this.rejectPending(new Error(`codex app-server ended (${signal ?? code})`));
    });
    server.stdin.on('error', error => this.io.fatal(new Error(`codex app-server stdin: ${error.message}`)));
    server.stdout.setEncoding('utf8');
    server.stdout.on('data', (chunk: string) => {
      try { this.receive(chunk); }
      catch (error) { this.io.fatal(error instanceof Error ? error : new Error(String(error))); }
    });
    await this.request('initialize', INITIALIZE);
    this.write({ method: 'initialized', params: {} });
  }

  private write(message: object): void {
    if (!this.server?.stdin.writable) throw new Error('codex app-server stdin is closed');
    this.server.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private request(method: string, params: object): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  private rejectPending(error: Error): void {
    this.settleCompaction({ compacted: false, message: error.message });
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
  private receive(chunk: string): void {
    this.buffered += chunk;
    for (let end = this.buffered.indexOf('\n'); end !== -1; end = this.buffered.indexOf('\n')) {
      const line = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 1);
      if (!line.trim()) continue;
      let message: Message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === undefined && typeof message.id === 'number' && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'app-server error'));
        else waiter.resolve(message.result);
      } else if (message.method !== undefined && message.id !== undefined) {
        // Approval policy is never. Refuse unexpected requests from app-server.
        this.write({ id: message.id, error: { code: -32601, message: 'not supported' } });
      } else this.notify(message);
    }
  }
  private notify(message: Message): void {
    const params = message.params ?? {};
    // app-server also reports the threads of sub-agents this thread spawns; only this thread's turn is the Run's.
    if (params.threadId !== this.threadId) return;
    if (this.compaction && this.compacting(message.method, params)) return;
    if (message.method === 'turn/started') {
      if (this.endedTurns.has(params.turn?.id)) return;
      this.turnId = params.turn?.id ?? this.turnId;
      this.lastMessage = '';
      this.usage = null; // No fresh observation means unknown, never the previous turn's counters.
      this.io.emit({ type: 'turn.started' });
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = params.item ?? {};
      if (item.type === 'userMessage') {
        if (message.method === 'item/started' && typeof item.clientId === 'string') this.io.started(item.clientId);
        return;
      }
      if (message.method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') this.lastMessage = item.text;
      // A compaction leaves the fill unknown until the next model call says it.
      if (message.method === 'item/completed' && item.type === 'contextCompaction')
        this.io.emit({ type: 'context.updated', context: { usedTokens: null, compacted: true } });
      this.io.emit({ type: message.method === 'item/started' ? 'item.started' : 'item.completed',
        item: { ...item, type: snake(String(item.type)) } });
    } else if (message.method === 'thread/tokenUsage/updated') {
      this.usage = codexUsage(params.tokenUsage?.total);
      const context = codexContext(params.tokenUsage);
      if (context) this.io.emit({ type: 'context.updated', context });
    } else if (message.method === 'turn/completed') {
      const turn = params.turn ?? {};
      this.endedTurns.add(turn.id);
      this.turnId = null;
      this.turnCount++;
      if (turn.status === 'completed') {
        this.lastFailed = false;
        if (this.options.output) writeFileSync(this.options.output, this.lastMessage);
        this.io.emit({ type: 'turn.completed', usage: this.usage });
      } else {
        this.lastFailed = true;
        const cause = CODEX_CAUSES[turn.error?.codexErrorInfo];
        this.io.emit({ type: 'turn.failed', error: { message: turn.error?.message ?? `turn ${turn.status}`, ...cause ? { cause } : {} } });
      }
      this.io.idle();
    } else if (message.method === 'error') {
      this.io.emit({ type: 'error', message: params.error?.message ?? params.message ?? 'error' });
    }
  }

  /** Whether a notification belongs to the compaction turn: it starts no Run turn, shows no items and ends in the compaction's result. */
  private compacting(method: string | undefined, params: any): boolean {
    const compaction = this.compaction!;
    if (method === 'error') compaction.error = params.error?.message ?? params.message ?? compaction.error;
    else if (method === 'turn/completed') {
      const turn = params.turn ?? {};
      this.endedTurns.add(turn.id);
      this.settleCompaction(turn.status === 'completed' ? { compacted: true }
        : { compacted: false, message: turn.error?.message ?? compaction.error ?? `Codex compaction ${turn.status}` });
    } else if (method !== 'turn/started' && method !== 'item/started' && method !== 'item/completed') return false;
    return true;
  }

  async deliver(input: Instruction): Promise<Admission> {
    try {
      if (this.turnId !== null) await this.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId,
        clientUserMessageId: input.id, input: imageInput(input.text) });
      else {
        const started = await this.request('turn/start', { threadId: this.threadId, clientUserMessageId: input.id,
          input: imageInput(input.text) });
        // The response and turn notifications may arrive in either order.
        if (!this.endedTurns.has(started?.turn?.id)) this.turnId ??= started?.turn?.id ?? null;
      }
      return { state: 'transferred' };
    } catch (error) {
      return { state: 'uncertain', message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/** The fill is the last model call's tokens (`total` is the whole conversation's bill), against the window Codex uses. */
export function codexContext(value: unknown): ContextUpdate | null {
  const usage = usageRecord(value), last = usageRecord(usage.last).totalTokens, window = usage.modelContextWindow;
  const used = callTokens(last);
  if (used === null) return null;
  return { usedTokens: used, compacted: false,
    ...typeof window === 'number' && Number.isSafeInteger(window) && window > 0 ? { windowTokens: window } : {} };
}

/** App-server total includes cache reads/writes; output already includes reasoning. */
export function codexUsage(value: unknown): AgentUsage | null {
  const total = usageRecord(value);
  const input = total.inputTokens, read = total.cachedInputTokens, write = total.cacheWriteInputTokens;
  const known = [input, read, write].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0);
  return measuredUsage('conversation', { input: known ? (input as number) - (read as number) - (write as number) : null,
    cacheRead: read, cacheWrite: write, output: total.outputTokens });
}

/** The account's own limit windows (`account/rateLimits/read`) and who it is (`account/read`); no thread is opened and
 * no model is called. */
export async function codexLimits(command: string): Promise<LimitsReport> {
  const server = spawn(command, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const [limits, account] = await new Promise<[unknown, unknown]>((resolve, reject) => {
      // The two answers may come in either order.
      const answers = new Map<number, unknown>();
      let buffered = '';
      const write = (message: object) => server.stdin.write(`${JSON.stringify(message)}\n`);
      server.once('error', reject);
      server.once('exit', code => reject(new Error(`codex app-server ended (${code})`)));
      server.stdout.setEncoding('utf8');
      server.stdout.on('data', (chunk: string) => {
        buffered += chunk;
        for (let end = buffered.indexOf('\n'); end !== -1; end = buffered.indexOf('\n')) {
          let message: Message;
          try { message = JSON.parse(buffered.slice(0, end)); } catch { message = {}; }
          buffered = buffered.slice(end + 1);
          if (message.error && (message.id === 1 || message.id === 2)) reject(new Error(message.error.message ?? 'app-server error'));
          else if (message.id === 1) {
            write({ method: 'initialized', params: {} });
            write({ id: 2, method: 'account/rateLimits/read', params: {} });
            write({ id: 3, method: 'account/read', params: { refreshToken: false } });
          } else if (message.id === 2 || message.id === 3) {
            // Who is signed in is beside the limits: its failure leaves the account unnamed, not the limits unread.
            answers.set(message.id, message.error ? null : message.result);
            if (answers.size === 2) resolve([answers.get(2), answers.get(3)]);
          }
        }
      });
      write({ id: 1, method: 'initialize', params: INITIALIZE });
    });
    const email = usageRecord(usageRecord(account).account).email;
    return { windows: codexLimitWindows(limits), account: typeof email === 'string' && email ? email : null };
  } finally { server.kill('SIGTERM'); }
}

/** Primary and secondary are positions, not lengths: each window says its own length. */
export function codexLimitWindows(value: unknown): LimitWindow[] {
  const limits = usageRecord(usageRecord(value).rateLimits);
  return [limits.primary, limits.secondary].flatMap(entry => {
    if (entry == null) return [];
    const window = usageRecord(entry);
    const read = limitWindow({ minutes: window.windowDurationMins as number, usedPercent: window.usedPercent, resetsAt: window.resetsAt });
    return read ? [read] : [];
  });
}
