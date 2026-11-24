import { tokenUsage } from './usage.js';
/** Grok Build's native streaming-json is one prompt per process.
 * https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeIO } from './run.js';
import { newTurn, OneProcessRuntime, type Purpose, type Turn, type TurnEnd } from './one-process.js';
import { parseFlags, withUsage } from './options.js';

type Options = { output: string | null; session: string | null; model: string | null; effort: string | null };
type Active = Turn & { directory: string; text: string; terminal: Record<string, unknown> | null; error: string | null };
const USAGE = 'Usage: alpacawork-agent grok [-o FILE] [--session UUID] [--model MODEL] [--effort EFFORT]';

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
  protected spawnTurn(purpose: Purpose): Active {
    // A private prompt file avoids argv size limits and does not expose the instruction in ps.
    const directory = mkdtempSync(join(tmpdir(), 'alpacawork-grok-'));
    const prompt = join(directory, 'prompt');
    let child: Active['child'];
    try {
      // Grok's built-in /compact takes no words on what to keep. Unverified against a signed-in Grok: that a headless
      // prompt runs it like the interactive slash command, and how its streaming-json reports the result.
      writeFileSync(prompt, purpose.kind === 'instruction' ? purpose.input.text : '/compact', { mode: 0o600 });
      child = spawn(this.command, ['--output-format', 'streaming-json', '--always-approve',
        ...(this.options.model ? ['--model', this.options.model] : []),
        ...(this.options.effort ? ['--reasoning-effort', this.options.effort] : []),
        this.established ? '--resume' : '--session-id', this.session, '--prompt-file', prompt],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    child.once('close', () => rmSync(directory, { recursive: true, force: true }));
    return { ...newTurn(purpose, child), directory, text: '', terminal: null, error: null };
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
      this.emit(active, { type: 'error', message: active.error });
    } else if (event.type === 'text' || event.type === 'thought') {
      if (typeof event.data !== 'string') throw new Error('Invalid Grok text event');
      this.begin(active);
      if (event.type === 'text') {
        active.text += event.data;
        this.emit(active, { type: 'item.completed', item: { type: 'agent_message', text: event.data } });
      }
    } else if (event.type === 'tool_call') {
      if (typeof event.toolCallId !== 'string') throw new Error('Invalid Grok tool call');
      this.begin(active);
      this.emit(active, { type: 'item.started', item: { type: 'command_execution', id: event.toolCallId, tool: event.toolName } });
    }
  }
  protected conclude(active: Active, code: number | null, signal: NodeJS.Signals | null): TurnEnd {
    // A compaction asks for no reply: a clean exit without an error is its success.
    if (active.purpose.kind === 'compaction') return code === 0 && active.error === null ? { output: '', events: [] }
      : { failed: active.error ?? `Grok Build compaction stopped (${signal ?? `exit ${code}`})` };
    if (code !== 0 || active.terminal?.stopReason !== 'end_turn' || active.error !== null) return { failed: active.error ??
      `Grok Build stopped: ${active.terminal?.stopReason ?? 'missing terminal result'} (${signal ?? `exit ${code}`}). Run grok login or set XAI_API_KEY if authentication is missing.` };
    this.begin(active);
    return { output: active.text, events: [{ type: 'turn.completed', usage: tokenUsage(active.terminal?.usage) }] };
  }
}
