import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeKey } from './change-key.js';
import { ChangeLog } from './change-log.js';

const journals = new Map<string, ChangeLog>();
const connections = new WeakMap<DatabaseSync, string>();
const current = new AsyncLocalStorage<ChangeScope>();
const active = new WeakMap<DatabaseSync, ChangeScope>();

/** Registration outlives individual ordered callbacks and includes every connection of this workspace. */
export function keepControlChanges(root: string, log = new ChangeLog()): { log: ChangeLog; close: () => void } {
  const key = resolve(root);
  if (journals.has(key)) throw new Error('Control change journal already active');
  journals.set(key, log);
  return { log, close: () => { if (journals.get(key) === log) journals.delete(key); } };
}
export const controlChanges = (root: string): ChangeLog | undefined => journals.get(resolve(root));

/** Each managed write/savepoint owns its own set, even when its caller catches a rollback. */
export class ChangeScope {
  private readonly keys = new Map<string, ChangeKey>();
  private live = true;
  private readonly mutations: { revision: number };
  constructor(readonly root: string, readonly db: DatabaseSync, readonly parent?: ChangeScope) {
    if (active.has(db) && active.get(db) !== parent) throw new Error('Connection has another active change scope');
    this.mutations = parent?.mutations ?? { revision: 0 };
    active.set(db, this);
  }
  /** A transaction family shares a monotonic clock, including repeated touches and rolled-back savepoints. */
  get revision(): number { return this.mutations.revision; }
  run<T>(work: () => T): T { return current.run(this, work); }
  touch(key: ChangeKey): void {
    if (!this.live) throw new Error('Change scope has ended');
    this.mutations.revision++;
    this.keys.set(JSON.stringify([key.kind, key.id]), Object.freeze({ ...key }));
  }
  finish(committed: boolean): void {
    if (!this.live) throw new Error('Change scope has ended');
    this.live = false;
    if (this.parent) active.set(this.db, this.parent); else active.delete(this.db);
    if (!committed) { this.mutations.revision++; return; }
    if (this.parent) for (const key of this.keys.values()) this.parent.touch(key);
    else controlChanges(this.root)?.append(this.keys.values());
  }
}
export function currentChangeScope(db: DatabaseSync): ChangeScope | undefined {
  const scope = current.getStore();
  return scope?.db === db && active.get(db) === scope ? scope : undefined;
}
/** Writers name records; the projection alone maps those records to affected Tasks. */
export function touch(db: DatabaseSync, key: ChangeKey): void {
  const scope = currentChangeScope(db);
  if (scope) scope.touch(key);
  else if (connections.has(db) && controlChanges(connections.get(db)!))
    throw new Error('Business write requires a managed ChangeScope');
}

// Recognize write verbs outside literals/comments, including WITH ... UPDATE and RETURNING statements.
const writes = (sql: string) => /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql.replace(
  /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|--[^\n]*|\/\*[\s\S]*?\*\//g, ' '));
/** Business connections only: initialization/maintenance keep their own separate opening path. */
export function guardControlWrites(root: string, db: DatabaseSync): void {
  if (connections.has(db)) return;
  connections.set(db, root);
  const check = () => {
    if (controlChanges(root) && !currentChangeScope(db))
      throw new Error('Business write requires a managed ChangeScope');
  };
  const prototype = Object.getPrototypeOf(db) as DatabaseSync;
  const prepare = db.prepare.bind(db), classifications = new Map<string, boolean>();
  db.prepare = sql => {
    const statement = prepare(sql);
    let writable = classifications.get(sql);
    if (writable === undefined) {
      writable = writes(sql);
      if (classifications.size >= 512) classifications.delete(classifications.keys().next().value!);
      classifications.set(sql, writable);
    }
    if (writable) {
      for (const method of ['run', 'get', 'all', 'iterate'] as const) {
        const execute = statement[method].bind(statement);
        // Keep the native statement receiver, including statements prepared before a scope starts/ends.
        Object.defineProperty(statement, method, { value: (...args: Parameters<typeof execute>) => {
          check();
          const result = (execute as (...values: unknown[]) => unknown)(...args);
          if (method !== 'iterate') return result;
          const iterator = result as IterableIterator<unknown>;
          return (function* () {
            try { for (;;) { check(); const item = iterator.next(); if (item.done) return; yield item.value; } }
            finally { iterator.return?.(); }
          })();
        }, configurable: true, writable: true });
      }
    }
    return statement;
  };
  db.exec = sql => { if (writes(sql)) check(); return prototype.exec.call(db, sql); };
}
