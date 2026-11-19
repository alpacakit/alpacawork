/** Immutable DB facts shared by one operation, guarded at each read or business transaction on one connection. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { deepFreeze } from '@alpacawork/core';
import { ControlStore, controlChanges, currentChangeScope, type ChangeLog, type ChangeScope, type ChangeSeq } from '@alpacawork/db';
import type { DatabaseSync } from 'node:sqlite';

type Stamp = { readonly journal?: ChangeLog; readonly seq?: ChangeSeq; readonly scope?: ChangeScope; readonly revision: number };
type Point = { readonly stamp: Stamp; disabled: boolean };
const current = new AsyncLocalStorage<ControlReadContext>();
export function controlReadContext(db: DatabaseSync): ControlReadContext | undefined {
  const value = current.getStore();
  return value?.connection === db ? value : undefined;
}
export class ControlReadContext {
  private readonly facts = new Map<string, unknown>();
  private version?: Stamp;
  private point?: Point;
  constructor(readonly store: ControlStore) {}
  get connection(): DatabaseSync { return this.store.connection; }
  private stamp(): Stamp {
    const journal = controlChanges(this.store.root), scope = currentChangeScope(this.connection);
    return { journal, seq: journal?.latest, scope, revision: scope?.revision ?? 0 };
  }
  private same(before: Stamp | undefined, after: Stamp): boolean {
    return !!before?.journal && before.journal === after.journal && before.seq === after.seq &&
      (before.scope?.revision ?? 0) === before.revision && before.revision === after.revision &&
      (before.revision === 0 || before.scope === after.scope);
  }
  private align(version: Stamp): void {
    if (!this.same(this.version, version)) this.facts.clear();
    this.version = version;
  }
  private usable(): boolean {
    const point = this.point;
    if (!point) throw new Error('DB facts require an active read point');
    // Any touch or rollback invalidates all dependencies for the rest of this point.
    // Without a journal there is no proof that facts can be shared between transactions.
    if (point.disabled || !this.same(point.stamp, this.stamp())) {
      point.disabled = true; this.facts.clear(); return false;
    }
    return true;
  }
  peek<T>(key: string): T | undefined { return this.usable() ? this.facts.get(key) as T | undefined : undefined; }
  remember<T>(key: string, value: T): void { if (this.usable()) this.facts.set(key, deepFreeze(value)); }
  get<T>(key: string, load: () => T): T {
    if (this.usable() && this.facts.has(key)) return this.facts.get(key) as T;
    const value = load(); this.remember(key, value); return value;
  }
  many<T>(kind: string, ids: readonly string[], loadMissing: (missing: readonly string[]) => Map<string, T>): Map<string, T> {
    const key = (id: string) => JSON.stringify([kind, id]);
    const cached = this.usable();
    const missing = [...new Set(ids)].filter(id => !cached || !this.facts.has(key(id)));
    const loaded = missing.length ? loadMissing(missing) : new Map<string, T>();
    const stillUsable = this.usable();
    if (stillUsable) for (const [id, value] of loaded) this.facts.set(key(id), deepFreeze(value));
    return new Map(ids.flatMap(id => {
      const value = (stillUsable ? this.facts.get(key(id)) as T | undefined : undefined) ?? loaded.get(id);
      return value === undefined ? [] : [[id, value] as const];
    }));
  }

  /** Read snapshots may yield; a concurrent commit discards their facts before the next write can reuse them. */
  async prepare<T>(execute: () => Promise<T>): Promise<T> {
    if (this.point) throw new Error('A read context already has an active point');
    const before = this.stamp(); this.align(before);
    // An enclosing unmanaged read may have established its snapshot before this journal position.
    const point: Point = { stamp: before, disabled: this.connection.isTransaction && !before.scope };
    if (point.disabled) this.facts.clear();
    try {
      const read = () => current.run(this, async () => {
        this.point = point;
        return execute();
      });
      // Administrative commands may already own this connection's enclosing business transaction.
      return await (this.connection.isTransaction ? read() : this.store.readAsync(read));
    } catch (error) { this.facts.clear(); throw error; }
    finally {
      const disabled = point.disabled;
      this.point = undefined;
      const after = this.stamp();
      if (disabled || !this.same(before, after)) this.facts.clear();
      this.version = after;
    }
  }
  private atWrite<T>(execute: (db: DatabaseSync) => T): T {
    if (this.point) throw new Error('A read context already has an active point');
    const before = this.stamp(); this.align(before);
    const point: Point = { stamp: before, disabled: false }; this.point = point;
    try { return current.run(this, () => execute(this.connection)); }
    catch (error) { this.facts.clear(); throw error; }
    finally {
      if (point.disabled || !this.same(before, this.stamp())) this.facts.clear();
      this.point = undefined; this.version = this.stamp();
    }
  }
  write<T>(execute: (db: DatabaseSync) => T): T {
    try { return this.store.write(() => this.atWrite(execute)); }
    catch (error) { this.facts.clear(); throw error; }
  }
  close(): void { this.facts.clear(); this.store.close(); }
}
