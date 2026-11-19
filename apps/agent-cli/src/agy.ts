import { tokenUsage } from './usage.js';
/** Antigravity stream-json: one input per process; queued instructions resume the conversation.
 * https://www.antigravity.google/docs/cli/headless/
 */
import { spawn } from 'node:child_process';
import type { Instruction, RuntimeIO } from './run.js';
import { newTurn, OneProcessRuntime, type Turn, type TurnEnd } from './one-process.js';
import { parseFlags, withUsage } from './options.js';

type Options = { output: string | null; conversation: string | null; model: string | null; effort: string | null };
type Result = { status: string; response: string; error: string | null; usage: unknown };
type Active = Turn & { initialized: boolean; result: Result | null };
const USAGE = 'Usage: alpacawork-agent agy [-o FILE] [--conversation CONVERSATION] [--model MODEL] [--effort EFFORT]';

function parseOptions(args: string[]): Options {
  const options: Options = { output: null, conversation: null, model: null, effort: null };
  const output = (value: string) => { options.output = value; };
  parseFlags(args, new Map([
    ['-o', output], ['--output-last-message', output],
    ['--conversation', value => { options.conversation = value; }],
    ['--model', value => { options.model = value; }],
    ['--effort', value => { options.effort = value; }],
  ]));
  return options;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Antigravity CLI returned an invalid ${context}`);
  return value as Record<string, unknown>;
}

export class AgyRuntime extends OneProcessRuntime<Active> {
  private readonly options: Options;
  private conversation: string | null;

  constructor(args: string[], io: RuntimeIO, private readonly command: string) {
    const options = withUsage(USAGE, () => parseOptions(args));
    super(io, { name: 'Antigravity CLI', output: options.output, lines: 'Antigravity CLI' });
    this.options = options;
    this.conversation = options.conversation;
  }
  protected spawnTurn(input: Instruction): Active {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      ...(this.options.model ? ['--model', this.options.model] : []),
      ...(this.options.effort ? ['--effort', this.options.effort] : []),
      ...(this.conversation ? ['--conversation', this.conversation] : [])];
    return { ...newTurn(input, spawn(this.command, args, { stdio: ['pipe', 'pipe', 'inherit'] })), initialized: false, result: null };
  }
  protected override stdinLine(input: Instruction): string {
    return `${JSON.stringify({ event: 'user', message: { content: input.text } })}\n`;
  }
  protected receive(active: Active, value: unknown): void {
    const event = record(value, 'event');
    if (active.result) throw new Error('Antigravity CLI sent an event after its result');
    if (event.conversation_id !== undefined && this.conversation && event.conversation_id !== this.conversation)
      throw new Error('Antigravity CLI returned a different conversation');
    if (event.event === 'init') {
      if (active.initialized || typeof event.conversation_id !== 'string' || !event.conversation_id)
        throw new Error('Antigravity CLI returned an invalid conversation');
      record(event.init, 'init');
      this.conversation = event.conversation_id;
      active.initialized = true;
      this.announce(this.conversation);
    } else if (event.event === 'step_update') {
      const step = record(event.step_update, 'step update');
      if (!active.initialized) throw new Error('Antigravity CLI sent a step before its init');
      this.sameConversation(step.conversation_id);
      if (typeof step.step_type !== 'string' || !step.step_type ||
        step.state !== 'ACTIVE' && step.state !== 'DONE' ||
        step.text_delta !== undefined && typeof step.text_delta !== 'string')
        throw new Error('Antigravity CLI returned an invalid step update');
      if (step.step_type === 'user_input' || step.step_type === 'agent_response' || step.step_type === 'tool')
        this.started(active);
    } else if (event.event === 'result') {
      const result = record(event.result, 'result');
      if (typeof result.status !== 'string' || !result.status ||
        result.response !== undefined && typeof result.response !== 'string' ||
        result.error !== undefined && typeof result.error !== 'string')
        throw new Error('Antigravity CLI returned an invalid result');
      if (active.initialized || this.conversation) this.sameConversation(result.conversation_id);
      if (result.status === 'SUCCESS' && (!active.initialized || typeof result.response !== 'string'))
        throw new Error('Antigravity CLI completed without its conversation or response');
      active.result = { status: result.status, response: typeof result.response === 'string' ? result.response : '',
        error: typeof result.error === 'string' ? result.error : null, usage: result.usage ?? null };
      if (result.status === 'SUCCESS' && !active.result.error) this.started(active);
    } else throw new Error(`Antigravity CLI returned an unknown event: ${String(event.event)}`);
  }
  private sameConversation(id: unknown): void {
    if (typeof id !== 'string' || !id || id !== this.conversation)
      throw new Error('Antigravity CLI returned a different conversation');
  }
  protected conclude(active: Active, code: number | null, signal: NodeJS.Signals | null): TurnEnd {
    const result = active.result;
    if (code === 0 && !result) throw new Error('Antigravity CLI exited successfully without a result');
    if (code !== 0 || result?.status !== 'SUCCESS' || result.error) return { failed: result?.error ??
      `Antigravity CLI ${result?.status ?? 'stopped'} (${signal ?? `exit ${code}`})` };
    return { output: result.response, events: [
      ...(result.response ? [{ type: 'item.completed' as const, item: { type: 'agent_message', text: result.response } }] : []),
      { type: 'turn.completed', usage: tokenUsage(result.usage) }] };
  }
}
