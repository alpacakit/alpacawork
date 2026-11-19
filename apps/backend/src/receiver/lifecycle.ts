/** Admission starts after the request body is read. Quiesce waits accepted mutations, never stalled uploads. */
import { randomUUID } from 'node:crypto';
import { Problem, PROBLEM_CODE } from '@alpacawork/core';
export type Mutate = <T>(work: () => T | Promise<T>) => Promise<T>;
export class ServeLifecycle {
  state: 'accepting' | 'quiescing' | 'drained' = 'accepting';
  private readonly active = new Set<Promise<unknown>>();
  private draining: Promise<{ workspace: string; generation: string; nonce: string; state: 'drained' }> | undefined;
  constructor(readonly workspace: string, readonly generation: string,
    private readonly inFlight: () => Promise<void>, private readonly publishStops: () => void,
    private readonly pauseLaunches: () => void | Promise<void> = () => {}) {}
  admit(): void {
    if (this.state !== 'accepting') throw new Problem(PROBLEM_CODE.unavailable, 'Serve is quiescing; mutation was not admitted', { state: 'not_admitted' },
      { reason: { kind: 'serve_quiescing_mutation_was_not_admitted' } });
  }
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    this.admit();
    let finish!: () => void;
    const active = new Promise<void>(resolve => { finish = resolve; }); this.active.add(active);
    try { return await work(); } finally { this.active.delete(active); finish(); }
  }
  quiesce() {
    if (this.draining) return this.draining;
    this.state = 'quiescing';
    this.draining = (async () => {
      await this.pauseLaunches();
      await Promise.all([...this.active]);
      await this.inFlight();
      this.publishStops();
      this.state = 'drained';
      return { workspace: this.workspace, generation: this.generation, nonce: randomUUID(), state: 'drained' as const };
    })().catch(error => { this.draining = undefined; throw error; });
    return this.draining;
  }
}
