/** An agent that takes one instruction per process: later instructions wait, then resume its conversation in a new one. */
import type { BridgeEvent } from '@alpacawork/contract/agent-bridge';
import type { ChildProcessByStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { Admission, CompactionResult, Instruction, Runtime, RuntimeIO } from './run.js';

const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** What one process is for: an instruction's turn, or compacting the conversation before one, which is no turn. */
export type Purpose = { kind: 'instruction'; input: Instruction }
  | { kind: 'compaction'; instructions: string | null; settle(result: CompactionResult): void };
export type Turn = { purpose: Purpose; child: ChildProcessByStdio<Writable | null, Readable, null>; buffer: string; started: boolean };
export const newTurn = (purpose: Purpose, child: Turn['child']): Turn => ({ purpose, child, buffer: '', started: false });
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
  private queued: Purpose[] = [];
  private turnCount = 0;
  private lastFailed = false;
  private announced = false;

  protected constructor(protected readonly io: RuntimeIO, private readonly shape: Shape) {}
  /** Spawn the agent for one instruction or compaction. */
  protected abstract spawnTurn(purpose: Purpose): T;
  /** The line a stdin-fed agent reads its instruction from; null when `spawnTurn` already gave it the instruction. */
  protected stdinLine(_purpose: Purpose): string | null { return null; }
  /** One parsed line of the agent's stdout. */
  protected abstract receive(turn: T, value: unknown): void;
  /** What the process's exit means; throws when the exit breaks the agent's protocol. A compaction's events are dropped. */
  protected abstract conclude(turn: T, code: number | null, signal: NodeJS.Signals | null): TurnEnd;

  async start(): Promise<void> {}
  idle(): boolean { return this.active === null && this.queued.length === 0; }
  turns(): number { return this.turnCount; }
  failed(): boolean { return this.lastFailed; }
  close(): void {
    this.closing = true;
    this.active?.child.kill('SIGTERM');
    for (const purpose of [this.active?.purpose, ...this.queued])
      if (purpose?.kind === 'compaction') purpose.settle({ compacted: false, message: `${this.shape.name} is closed` });
    this.queued = [];
  }
  async deliver(input: Instruction): Promise<Admission> {
    if (this.closing) return { state: 'uncertain', message: `${this.shape.name} is closed` };
    this.enqueue({ kind: 'instruction', input });
    return { state: 'transferred' };
  }
  compact(instructions: string | null): Promise<CompactionResult> {
    if (this.closing) return Promise.resolve({ compacted: false, message: `${this.shape.name} is closed` });
    return new Promise(settle => this.enqueue({ kind: 'compaction', instructions, settle }));
  }
  private enqueue(purpose: Purpose): void {
    if (this.active) this.queued.push(purpose);
    else this.launch(purpose);
  }
  /** What the Run sees of a process: a compaction's own events are not the Run's. */
  protected emit(turn: T, event: BridgeEvent): void {
    if (turn.purpose.kind === 'instruction') this.io.emit(event);
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
    if (turn.purpose.kind === 'instruction') this.io.started(turn.purpose.input.id);
  }
  /** Whether stdout still counts: a closing runtime stops reading, and a finished turn's process has no more to say. */
  protected reads(turn: T): boolean { return !this.closing && this.active === turn; }

  private launch(purpose: Purpose): void {
    const turn = this.spawnTurn(purpose), { child } = turn, { name } = this.shape;
    this.active = turn;
    this.emit(turn, { type: 'turn.started' });
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
    const line = this.stdinLine(purpose);
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
    const end = this.conclude(turn, code, signal), { purpose } = turn;
    if (purpose.kind === 'compaction') {
      // Its own events are not the Run's (emit); that it compacted is, once.
      if (!('failed' in end)) this.io.emit({ type: 'context.updated', context: { usedTokens: null, compacted: true } });
      purpose.settle('failed' in end ? { compacted: false, message: end.failed } : { compacted: true });
    }
    else {
      if (turn.started) this.turnCount++;
      this.lastFailed = 'failed' in end;
      if ('failed' in end) this.io.emit({ type: 'turn.failed', error: { message: end.failed } });
      else {
        if (this.shape.output) writeFileSync(this.shape.output, end.output);
        for (const event of end.events) this.io.emit(event);
      }
    }
    this.active = null;
    const next = this.queued.shift();
    if (next) this.launch(next);
    else if (purpose.kind === 'instruction') this.io.idle();
  }
}
