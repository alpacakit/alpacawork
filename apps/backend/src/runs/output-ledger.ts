import { OUTPUT_WINDOW_SECONDS, type RunOutput } from '@alpacawork/contract/run';
import type { ModelOutputEvent } from '../agents/adapters/types.js';

type Call = { from: number; to: number; tokens: number };
const oldestSecond = (second: number) => second - OUTPUT_WINDOW_SECONDS + 1;

/** One Run's display projection, updated only by observations from its stdout reader. */
export class OutputLedger {
  private readonly buckets = new Map<number, number>();
  private readonly calls = new Map<string, Call>();
  private turnStarted: number | null = null;
  private lastCallEnded = -1;
  private lastToolEnded = -1;
  private lastActivity = -1;
  private measured = false;
  private cutoff = 0;

  observe(event: ModelOutputEvent, second: number): boolean {
    if (event.kind === 'turn_started') {
      this.turnStarted ??= second;
      return false;
    }
    if (event.kind === 'turn_ended') {
      this.turnStarted = null;
      this.calls.clear();
      return false;
    }

    const previous = event.id === undefined ? undefined : this.calls.get(event.id);
    if (previous?.tokens === event.tokens) return false;
    const to = Math.max(second, previous?.to ?? second);
    const from = previous?.from ?? Math.min(to, Math.max(0, oldestSecond(to), this.turnStarted ?? -1, this.lastCallEnded, this.lastToolEnded));
    const next = { from, to, tokens: event.tokens };

    this.prune(to);
    if (previous) this.apply(previous, -1);
    this.apply(next, 1);
    if (event.id !== undefined) this.calls.set(event.id, next);
    this.lastCallEnded = Math.max(this.lastCallEnded, to);
    this.lastActivity = Math.max(this.lastActivity, to);
    this.measured = true;
    return true;
  }

  tool(second: number, ended: boolean): void {
    if (ended) this.lastToolEnded = Math.max(this.lastToolEnded, second);
    this.lastActivity = Math.max(this.lastActivity, second);
  }

  snapshot(second: number): RunOutput | undefined {
    if (!this.measured) return undefined;
    this.prune(second);
    return { buckets: [...this.buckets].sort(([a], [b]) => a - b), lastActivityAt: this.lastActivity };
  }

  discard(): boolean {
    if (!this.measured) return false;
    this.measured = false;
    this.buckets.clear();
    this.calls.clear();
    return true;
  }

  private prune(second: number): void {
    const cutoff = oldestSecond(second);
    if (cutoff <= this.cutoff) return;
    this.cutoff = cutoff;
    for (const bucket of this.buckets.keys()) if (bucket < cutoff) this.buckets.delete(bucket);
  }

  /** Integer shares sum to the source count, including when it does not divide evenly. */
  private apply(call: Call, direction: 1 | -1): void {
    const seconds = call.to - call.from + 1;
    const base = Math.floor(call.tokens / seconds), remainder = call.tokens % seconds;
    for (let second = Math.max(call.from, this.cutoff); second <= call.to; second++) {
      const offset = second - call.from;
      const extra = Math.floor((offset + 1) * remainder / seconds) - Math.floor(offset * remainder / seconds);
      if (base + extra === 0) continue;
      const next = (this.buckets.get(second) ?? 0) + direction * (base + extra);
      if (next) this.buckets.set(second, next);
      else this.buckets.delete(second);
    }
  }
}
