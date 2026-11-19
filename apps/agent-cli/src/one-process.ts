/** An agent that takes one instruction per process: later instructions wait, then resume its conversation in a new one. */
import type { BridgeEvent } from '@alpacawork/contract/agent-bridge';
import type { ChildProcessByStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { Admission, Instruction, Runtime, RuntimeIO } from './run.js';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type Turn = { input: Instruction; child: ChildProcessByStdio<Writable | null, Readable, null>; buffer: string; started: boolean };
export const newTurn = (input: Instruction, child: Turn['child']): Turn => ({ input, child, buffer: '', started: false });
/** What one process's exit means, once its agent has read it. */
export type TurnEnd = { failed: string } | { output: string; events: BridgeEvent[] };
export type Shape = {
  /** How messages name the agent. */
  name: string;
  /** How an oversize or unfinished output line names the agent. Null: no limit, and an unfinished last line is ignored. */
  lines: string | null;
  /** The file that receives each successful turn's reply. */
  output: string | null;
};

export abstract class OneProcessRuntime<T extends Turn> implements Runtime {
  protected active: T | null = null;
  private closing = false;
  private queued: Instruction[] = [];
  private turnCount = 0;
  private lastFailed = false;
  private announced = false;

  protected constructor(protected readonly io: RuntimeIO, private readonly shape: Shape) {}
  /** Spawn the agent for one instruction. */
  protected abstract spawnTurn(input: Instruction): T;
  /** The line a stdin-fed agent reads its instruction from; null when `spawnTurn` already gave it the instruction. */
  protected stdinLine(_input: Instruction): string | null { return null; }
  /** One parsed line of the agent's stdout. */
  protected abstract receive(turn: T, value: unknown): void;
  /** What the process's exit means; throws when the exit breaks the agent's protocol. */
  protected abstract conclude(turn: T, code: number | null, signal: NodeJS.Signals | null): TurnEnd;

  async start(): Promise<void> {}
  idle(): boolean { return this.active === null && this.queued.length === 0; }
  turns(): number { return this.turnCount; }
  failed(): boolean { return this.lastFailed; }
  close(): void {
    this.closing = true;
    this.active?.child.kill('SIGTERM');
    this.queued = [];
  }
  async deliver(input: Instruction): Promise<Admission> {
    if (this.closing) return { state: 'uncertain', message: `${this.shape.name} is closed` };
    if (this.active) this.queued.push(input);
    else this.launch(input);
    return { state: 'transferred' };
  }
  /** Tell the conversation's identity, the first time it is known. */
  protected announce(thread: string): void {
    if (this.announced) return;
    this.announced = true;
    this.io.emit({ type: 'thread.started', thread_id: thread });
  }
  protected started(turn: T): void {
    if (turn.started) return;
    turn.started = true;
    this.io.started(turn.input.id);
  }
  /** Whether stdout still counts: a closing runtime stops reading, and a finished turn's process has no more to say. */
  protected reads(turn: T): boolean { return !this.closing && this.active === turn; }

  private launch(input: Instruction): void {
    const turn = this.spawnTurn(input), { child } = turn, { name } = this.shape;
    this.active = turn;
    this.io.emit({ type: 'turn.started' });
    child.once('error', error => {
      if (!this.closing) this.io.fatal(new Error(`cannot start ${name}: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      if (this.closing || this.active !== turn) return;
      try { this.finish(turn, code, signal); }
      catch (error) { this.io.fatal(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (!this.reads(turn)) return;
      try { this.read(turn, chunk); }
      catch (error) { this.io.fatal(error instanceof Error ? error : new Error(String(error))); }
    });
    const line = this.stdinLine(input);
    if (line !== null) {
      child.stdin!.on('error', error => {
        if (!this.closing) this.io.fatal(new Error(`${name} stdin: ${error.message}`));
      });
      // End stdin after exactly one instruction so the agent's result can be paired with its exit.
      child.stdin!.end(line);
    }
  }
  private read(turn: T, chunk: string): void {
    turn.buffer += chunk;
    if (this.shape.lines && Buffer.byteLength(turn.buffer) > MAX_BUFFER_BYTES) throw new Error(`${this.shape.lines} output line exceeds 16 MiB`);
    for (let end = turn.buffer.indexOf('\n'); end !== -1; end = turn.buffer.indexOf('\n')) {
      const line = turn.buffer.slice(0, end);
      turn.buffer = turn.buffer.slice(end + 1);
      if (line.trim()) this.receive(turn, JSON.parse(line));
    }
  }
  private finish(turn: T, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.shape.lines && turn.buffer.trim()) throw new Error(`${this.shape.lines} ended with an incomplete JSON line`);
    const end = this.conclude(turn, code, signal);
    if (turn.started) this.turnCount++;
    this.lastFailed = 'failed' in end;
    if ('failed' in end) this.io.emit({ type: 'turn.failed', error: { message: end.failed } });
    else {
      if (this.shape.output) writeFileSync(this.shape.output, end.output);
      for (const event of end.events) this.io.emit(event);
    }
    this.active = null;
    const next = this.queued.shift();
    if (next) this.launch(next);
    else this.io.idle();
  }
}
