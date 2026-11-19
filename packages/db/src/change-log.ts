import type { ChangeKey, ChangeSeq } from './change-key.js';
export type { ChangeSeq } from './change-key.js';
export type ChangeBatch = Readonly<{ seq: ChangeSeq; keys: readonly ChangeKey[] }>;
export type ChangeRead = { kind: 'changes'; through: ChangeSeq; batches: readonly ChangeBatch[] }
  | { kind: 'overflow'; through: ChangeSeq };

/** A bounded process-lifetime journal. Reading never acknowledges unfinished work. */
export class ChangeLog {
  private sequence = 0 as ChangeSeq;
  private discarded = 0 as ChangeSeq;
  /** The latest commit no key names: a reader whose range reaches it cannot know what changed. */
  private unknown = 0 as ChangeSeq;
  private batches: ChangeBatch[] = [];
  private readonly readers = new Map<string, ChangeSeq>();
  private readonly listeners = new Set<(seq: ChangeSeq) => void>();
  constructor(readonly capacity = 4096) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('ChangeLog capacity must be positive');
  }
  get latest(): ChangeSeq { return this.sequence; }
  append(keys: Iterable<ChangeKey>): ChangeSeq {
    const unique = new Map<string, ChangeKey>();
    for (const key of keys) unique.set(JSON.stringify([key.kind, key.id]), Object.freeze({ ...key }));
    if (!unique.size) return this.sequence;
    if (!Number.isSafeInteger(this.sequence + 1)) throw new RangeError('ChangeLog sequence exhausted');
    this.sequence = (this.sequence + 1) as ChangeSeq;
    this.batches.push(Object.freeze({ seq: this.sequence, keys: Object.freeze([...unique.values()]) }));
    this.prune();
    this.notify();
    return this.sequence;
  }
  private notify(): void {
    for (const listener of this.listeners) {
      // A listener cannot turn an already committed write into an apparent rollback.
      try { listener(this.sequence); } catch (error) { console.error('Committed change listener failed', error); }
    }
  }
  /**
   * Records a commit that names no key (a trusted in-process writer outside the managed writes, such as a test
   * fixture): every reader whose range reaches it reads `overflow`, as when the journal lost its range, and so reads
   * everything again. The managed writes always name their keys.
   */
  appendUnknown(): ChangeSeq {
    if (!Number.isSafeInteger(this.sequence + 1)) throw new RangeError('ChangeLog sequence exhausted');
    this.sequence = (this.sequence + 1) as ChangeSeq;
    this.unknown = this.sequence;
    this.notify();
    return this.sequence;
  }
  subscribe(listener: (seq: ChangeSeq) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  register(name: string, from: ChangeSeq = this.latest): () => void {
    if (this.readers.has(name)) throw new Error(`ChangeLog reader already registered: ${name}`);
    this.checkPosition(from);
    this.readers.set(name, from);
    return () => { this.readers.delete(name); this.prune(); };
  }
  read(name: string): ChangeRead {
    const position = this.position(name);
    if (position < this.discarded || position < this.unknown) return { kind: 'overflow', through: this.latest };
    let low = 0, high = this.batches.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.batches[middle]!.seq <= position) low = middle + 1; else high = middle;
    }
    return { kind: 'changes', through: this.latest, batches: this.batches.slice(low) };
  }
  acknowledge(name: string, through: ChangeSeq): void {
    this.checkPosition(through);
    if (through < this.position(name)) throw new RangeError('ChangeLog reader cannot move backwards');
    this.readers.set(name, through);
    this.prune();
  }
  private position(name: string): ChangeSeq {
    const position = this.readers.get(name);
    if (position === undefined) throw new Error(`Unknown ChangeLog reader: ${name}`);
    return position;
  }
  private checkPosition(position: ChangeSeq): void {
    if (!Number.isSafeInteger(position) || position < 0 || position > this.latest)
      throw new RangeError('Invalid ChangeLog position');
  }
  private prune(): void {
    const completed = this.readers.size ? Math.min(...this.readers.values()) : this.discarded;
    let count = 0;
    while (count < this.batches.length && this.batches[count]!.seq <= completed) count++;
    count = Math.max(count, this.batches.length - this.capacity);
    if (count > 0) {
      this.discarded = this.batches[count - 1]!.seq;
      this.batches.splice(0, count);
    }
  }
}
