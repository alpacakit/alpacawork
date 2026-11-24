/** Provider receipts retain identity after uncertainty; refusal names never prove non-delivery. */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import type { RunId } from '@alpacawork/contract/fields';
import { JsonlReader } from './readers/jsonl.js';
import type { InputProtocol } from '../agents/adapters/types.js';
import type { CompactionLaunch } from '@alpacawork/contract/run-protocol';

export type InputReceipt<Id extends string> = { id: string; owner: Id; outcome: 'taken' | 'not_sent' | 'uncertain'; raw: unknown };
export class AgentInputReceipts<Id extends string> {
  private readonly lines = new JsonlReader();
  private readonly pending = new Map<string, { owner: Id; outcome: InputReceipt<Id>['outcome'] | null }>();
  working = false;
  private readonly protocol: InputProtocol;
  constructor(spec: InputProtocol) { this.protocol = spec; }
  watch(input: string, owner: Id): void {
    const prior = this.pending.get(input);
    if (prior && prior.owner !== owner) throw new Error('Input identity conflict');
    if (!prior) this.pending.set(input, { owner, outcome: null });
  }
  stateOf(input: string) { return this.pending.get(input)?.outcome; }
  ownerOf(input: string): Id | undefined { return this.pending.get(input)?.owner; }
  get unanswered(): boolean { return [...this.pending.values()].some(input => input.outcome === null); }
  poll(folder: string, session: string | null): { taken: Id[]; refused: Id[]; receipts: InputReceipt<Id>[] } {
    const taken: Id[] = [], refused: Id[] = [], receipts: InputReceipt<Id>[] = [];
    this.lines.read(folder, value => {
      const receipt = this.protocol.receipt(value, session), id = receipt?.id;
      const input = id ? this.pending.get(id) : undefined;
      if (id && input) {
        const outcome = receipt!.outcome;
        if (input.outcome === 'not_sent' && outcome === 'taken' || input.outcome === 'taken' && outcome === 'not_sent')
          throw new Error(`Contradictory input receipts: ${id}`);
        if (input.outcome !== 'taken' && input.outcome !== outcome) {
          input.outcome = outcome; receipts.push({ id, owner: input.owner, outcome, raw: value });
          if (outcome === 'taken') { taken.push(input.owner); this.working = true; }
          // Only certified pre-transfer rejection is eligible for the old caller's requeue path.
          if (outcome === 'not_sent') refused.push(input.owner);
        }
      }
      if (this.protocol.turnEnded(value, session)) this.working = false;
    });
    return { taken, refused, receipts };
  }
}
export class AgentInputChannel<Id extends string = RunId> {
  private readonly receipts: AgentInputReceipts<Id>;
  private readonly runs = new Set<Id>();
  private readonly refusedRuns = new Set<Id>();
  private readonly failedWrites = new Set<string>();
  private closed = false;
  private readonly protocol: InputProtocol;
  constructor(private readonly stdin: Writable, spec: InputProtocol) {
    this.protocol = spec;
    this.receipts = new AgentInputReceipts(this.protocol);
    stdin.on('error', () => { this.closed = true; });
    stdin.on('close', () => { this.closed = true; });
  }
  get open(): boolean { return !this.closed && !this.stdin.destroyed && !this.stdin.writableEnded; }
  wrote(run: Id): boolean { return this.runs.has(run); }
  refused(run: Id): boolean { return this.refusedRuns.has(run); }
  write(run: Id, prompt: string, input: string = randomUUID(), compaction: CompactionLaunch | null = null): boolean {
    if (this.runs.has(run)) throw new Error(`Input was already attempted: ${run}`);
    if (!this.open) return false; // No write call: the caller may durably record not_sent.
    this.runs.add(run); this.receipts.watch(input, run);
    try {
      this.stdin.write(this.protocol.encode(input, prompt, compaction).map(line => `${JSON.stringify(line)}\n`).join(''), error => {
        if (error) { this.closed = true; this.failedWrites.add(input); }
      });
    } catch { this.closed = true; this.failedWrites.add(input); }
    return true; // A failed callback/throw is still a transfer attempt, never proof of non-delivery.
  }
  poll(folder: string, session: string | null): { taken: Id[]; refused: Id[]; receipts: InputReceipt<Id>[] } {
    const result = this.receipts.poll(folder, session);
    for (const id of result.refused) this.refusedRuns.add(id);
    for (const input of this.failedWrites) {
      const owner = this.receipts.ownerOf(input);
      if (owner && this.receipts.stateOf(input) !== 'taken')
        result.receipts.push({ id: input, owner, outcome: 'uncertain', raw: { evidence: 'write_callback_error' } });
    }
    this.failedWrites.clear();
    if (!this.receipts.working && !this.receipts.unanswered) this.close();
    return result;
  }
  close(): void { if (!this.closed) { this.closed = true; this.stdin.end(); } }
}
