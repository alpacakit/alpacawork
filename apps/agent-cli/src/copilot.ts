/** GitHub Copilot SDK protocol and options. Admission is distinct from user.message delivery. */
import { writeFileSync } from 'node:fs';
import { CopilotClient, RuntimeConnection, approveAll, type CopilotSession, type SessionEvent } from '@github/copilot-sdk';
import type { Admission, Instruction, Runtime, RuntimeIO } from './run.js';
import { requiredValue, unknownOption, withUsage } from './options.js';

type Options = { model: string | null; output: string | null; resume: string | null; serverUrl: string | null };
const USAGE = 'Usage: alpacawork-agent copilot [-m MODEL] [-o FILE] [--server-url URL] [resume SESSION]';

function parseOptions(args: string[]): Options {
  const options: Options = { model: null, output: null, resume: null, serverUrl: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => requiredValue(args, ++i, arg);
    if (arg === '-m' || arg === '--model') options.model = value();
    else if (arg === '-o' || arg === '--output-last-message') options.output = value();
    else if (arg === '--server-url') options.serverUrl = value();
    else if (arg === 'resume' && options.resume === null) options.resume = value();
    else unknownOption(arg);
  }
  return options;
}

export class CopilotRuntime implements Runtime {
  private readonly options: Options;
  private client: CopilotClient | null = null;
  private session: CopilotSession | null = null;
  private busy = false;
  private closing = false;
  private sending = false;
  private buffered: SessionEvent[] = [];
  private waiting = new Map<string, { input: Instruction; observed: boolean; interactionId?: string }>();
  private lastMessage = '';
  private turnCount = 0;
  private lastFailed = false;
  private health: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(args: string[], private readonly io: RuntimeIO) {
    this.options = withUsage(USAGE, () => parseOptions(args));
  }
  idle(): boolean { return !this.busy; }
  turns(): number { return this.turnCount; }
  failed(): boolean { return this.lastFailed; }
  close(): void {
    this.closing = true;
    this.stopHealth();
    void this.stopClient();
  }
  private async stopClient(): Promise<void> { await this.client?.stop().catch(() => {}); }
  /**
   * One step of start. The SDK spawns its runtime only after a wait of its own, so a close during a step may have found
   * nothing to stop yet: a step that finishes after close stops what it opened and goes no further.
   */
  private async opening<T>(step: Promise<T>): Promise<T> {
    const opened = await step;
    if (this.closing) {
      await this.stopClient();
      throw new Error('Copilot closed during start');
    }
    return opened;
  }

  async start(): Promise<void> {
    const connection = this.options.serverUrl ? RuntimeConnection.forUri(this.options.serverUrl) : undefined;
    const client = new CopilotClient({ connection, workingDirectory: process.cwd() });
    this.client = client;
    await this.opening(client.start());
    const config = { ...(this.options.model ? { model: this.options.model } : {}), onPermissionRequest: approveAll };
    const session = await this.opening(this.options.resume
      ? client.resumeSession(this.options.resume, config)
      : client.createSession(config));
    this.session = session;
    session.on(event => {
      if (this.sending) this.buffered.push(event);
      else {
        try { this.receive(event); }
        catch (error) { this.io.fatal(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    this.io.emit({ type: 'thread.started', thread_id: session.sessionId });
  }

  async deliver(input: Instruction): Promise<Admission> {
    if (!this.session) throw new Error('Copilot session is not ready');
    const first = !this.busy;
    if (first) {
      this.busy = true;
      this.lastMessage = '';
      this.io.emit({ type: 'turn.started' });
      this.startHealth();
    }
    this.sending = true;
    try {
      const messageId = await this.session.send({ prompt: input.text, mode: first ? 'enqueue' : 'immediate' });
      this.waiting.set(messageId, { input, observed: false });
      return { state: 'transferred' };
    } catch (error) {
      if (first) {
        this.busy = false;
        this.stopHealth();
        this.io.idle();
      }
      return { state: 'uncertain', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.sending = false;
      for (const event of this.buffered.splice(0)) this.receive(event);
    }
  }

  private receive(event: SessionEvent): void {
    if (this.closing || event.agentId) return;
    if (event.type === 'user.message' && event.data.messageId) {
      const pending = this.waiting.get(event.data.messageId);
      if (!pending) return;
      pending.observed = true;
      pending.interactionId = event.data.interactionId;
      // Queued is admission to a later SDK turn, not evidence that it has begun.
      if (event.data.delivery === 'idle' || event.data.delivery === 'steering' || event.data.turnId)
        this.take(event.data.messageId);
    } else if (event.type === 'assistant.turn_start') {
      for (const [messageId, pending] of this.waiting)
        if (pending.interactionId && pending.interactionId === event.data.interactionId) this.take(messageId);
    } else if (event.type === 'assistant.message') {
      if (event.data.originatingMessageId) this.take(event.data.originatingMessageId);
      if (this.busy && typeof event.data.content === 'string') {
        this.lastMessage = event.data.content;
        this.io.emit({ type: 'item.completed', item: { type: 'agent_message', text: event.data.content } });
      }
    } else if (event.type === 'tool.execution_start') {
      this.io.emit({ type: 'item.started', item: { type: 'mcp_tool_call', id: event.data.toolCallId, name: event.data.toolName } });
    } else if (event.type === 'tool.execution_complete') {
      this.io.emit({ type: 'item.completed', item: { type: 'mcp_tool_call', id: event.data.toolCallId } });
    } else if (event.type === 'session.error') {
      if (event.data.eligibleForAutoSwitch !== true) this.finish(event.data.message);
    } else if (event.type === 'session.idle') {
      this.finish(event.data.aborted ? 'Copilot turn aborted' : null);
    }
  }

  private take(messageId: string): void {
    const pending = this.waiting.get(messageId);
    if (!pending) return;
    this.waiting.delete(messageId);
    this.io.started(pending.input.id);
  }

  private finish(error: string | null): void {
    if (!this.busy) return;
    if (error === null) {
      // A prior turn's idle can race with an unacknowledged send. Only a seen user.message belongs to
      // the queue that this idle guarantees has drained; wait for a later idle for unseen messages.
      for (const [messageId, pending] of this.waiting)
        if (pending.observed) this.take(messageId);
      if (this.waiting.size) return;
    } else this.waiting.clear();
    this.busy = false;
    this.stopHealth();
    this.turnCount++;
    this.lastFailed = error !== null;
    if (error) this.io.emit({ type: 'turn.failed', error: { message: error } });
    else {
      if (this.options.output) writeFileSync(this.options.output, this.lastMessage);
      this.io.emit({ type: 'turn.completed', usage: null });
    }
    this.io.idle();
  }

  private startHealth(): void {
    this.stopHealth();
    this.health = setInterval(() => {
      if (!this.busy || this.checking || !this.client) return;
      this.checking = true;
      void this.client.ping().catch(error => {
        if (!this.closing) {
          this.io.fatal(new Error(`Copilot SDK connection lost: ${error instanceof Error ? error.message : String(error)}`));
        }
      }).finally(() => { this.checking = false; });
    }, 500);
  }
  private stopHealth(): void {
    if (this.health) clearInterval(this.health);
    this.health = null;
  }
}

/** No conversation/session is created by these model-free checks. Exit 2 means uncheckable. */
export async function inspectCopilot(version = false): Promise<void> {
  const client = new CopilotClient({ workingDirectory: process.cwd() });
  try {
    await client.start();
    if (version) process.stdout.write(`${(await client.getStatus()).version}\n`);
    else process.exitCode = (await client.getAuthStatus()).isAuthenticated ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Copilot status unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  } finally {
    try { await client.stop(); }
    catch { process.exitCode = 2; }
  }
}

/** Optional module inspection: the entry point dispatches without knowing agent-specific flags. */
export async function inspectCopilotArgs(args: string[]): Promise<boolean> {
  if (args.length !== 1 || !['--auth-status', '--version'].includes(args[0]!)) return false;
  await inspectCopilot(args[0] === '--version');
  return true;
}
