import { tokenUsage, usageRecord } from './usage.js';
import { callTokens, type ContextUpdate } from '@alpacawork/contract/agent-context';
/** Grok Build's native streaming-json is one prompt per process.
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Instruction, RuntimeIO } from './run.js';
import { newTurn, OneProcessRuntime, type Turn, type TurnEnd } from './one-process.js';
import { parseFlags, withUsage } from './options.js';

type Options = { output: string | null; session: string | null; model: string | null; effort: string | null };
type Active = Turn & { directory: string; text: string; terminal: Record<string, unknown> | null; error: string | null };
const USAGE = 'Usage: alpacawork-agent grok [-o FILE] [--session UUID] [--model MODEL] [--effort EFFORT]';

/**
 * Each model response's own counters (one `usage` row per response, headless-mode docs). streaming-json names no
 * window, so the fill has none. Whether `input_tokens` there includes the cache is unconfirmed: it is taken as the
 * terminal result's is documented, without it.
 */
export function grokContext(value: unknown): ContextUpdate | null {
  const usage = usageRecord(value);
  const used = callTokens(usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.output_tokens);
  return used === null ? null : { usedTokens: used, compacted: false };
}

export class GrokRuntime extends OneProcessRuntime<Active> {
  private readonly options: Options;
  private readonly session: string;
  private established: boolean;

  constructor(args: string[], io: RuntimeIO, private readonly command: string) {
    const options = withUsage(USAGE, () => {
      const options: Options = { output: null, session: null, model: null, effort: null };
      parseFlags(args, new Map([
        ['-o', value => { options.output = value; }],
        ['--session', value => { options.session = value; }],
        ['--model', value => { options.model = value; }],
        ['--effort', value => { options.effort = value; }],
      ]));
      if (options.session && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.session))
        throw new Error('--session needs a Grok session UUID');
      return options;
    });
    super(io, { name: 'Grok Build', output: options.output, lines: 'Grok' });
    this.options = options;
    this.session = options.session ?? randomUUID();
    this.established = options.session !== null;
  }
  override close(): void {
    const directory = this.active?.directory;
    super.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
  protected spawnTurn(input: Instruction): Active {
    // A private prompt file avoids argv size limits and does not expose the instruction in ps.
    const directory = mkdtempSync(join(tmpdir(), 'alpacawork-grok-'));
    const prompt = join(directory, 'prompt');
    let child: Active['child'];
    try {
      writeFileSync(prompt, input.text, { mode: 0o600 });
      child = spawn(this.command, ['--output-format', 'streaming-json', '--always-approve',
        ...(this.options.model ? ['--model', this.options.model] : []),
        ...(this.options.effort ? ['--reasoning-effort', this.options.effort] : []),
        this.established ? '--resume' : '--session-id', this.session, '--prompt-file', prompt],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    child.once('close', () => rmSync(directory, { recursive: true, force: true }));
    return { ...newTurn(input, child), directory, text: '', terminal: null, error: null };
  }
  private begin(active: Active): void {
    // Native streams are projected from the root session. Fresh IDs are assigned before launch.
    this.established = true;
    this.announce(this.session);
    this.started(active);
  }
  protected receive(active: Active, value: unknown): void {
    const event = value as Record<string, unknown>;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('Invalid Grok event');
    if (active.terminal) throw new Error('Grok sent an event after its terminal result');
    if (event.sessionId !== undefined && event.sessionId !== this.session) throw new Error('Grok returned a different session');
    if (event.type === 'end') {
      if (event.sessionId !== this.session || typeof event.stopReason !== 'string') throw new Error('Invalid Grok terminal result');
      active.terminal = event;
    } else if (event.type === 'error') {
      active.error = typeof event.message === 'string' ? event.message : 'Grok Build error';
      this.io.emit({ type: 'error', message: active.error });
    } else if (event.type === 'text' || event.type === 'thought') {
      if (typeof event.data !== 'string') throw new Error('Invalid Grok text event');
      this.begin(active);
      if (event.type === 'text') {
        active.text += event.data;
        this.io.emit({ type: 'item.completed', item: { type: 'agent_message', text: event.data } });
      }
    } else if (event.type === 'usage') {
      const context = grokContext(event.usage);
      if (context) this.io.emit({ type: 'context.updated', context });
    } else if (event.type === 'tool_call') {
      if (typeof event.toolCallId !== 'string') throw new Error('Invalid Grok tool call');
      this.begin(active);
      this.io.emit({ type: 'item.started', item: { type: 'command_execution', id: event.toolCallId, tool: event.toolName } });
    }
  }
  protected conclude(active: Active, code: number | null, signal: NodeJS.Signals | null): TurnEnd {
    if (code !== 0 || active.terminal?.stopReason !== 'end_turn' || active.error !== null) return { failed: active.error ??
      `Grok Build stopped: ${active.terminal?.stopReason ?? 'missing terminal result'} (${signal ?? `exit ${code}`}). Run grok login or set XAI_API_KEY if authentication is missing.` };
    this.begin(active);
    return { output: active.text, events: [{ type: 'turn.completed', usage: tokenUsage(active.terminal?.usage) }] };
  }
}
