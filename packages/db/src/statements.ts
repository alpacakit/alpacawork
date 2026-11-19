/** A connection shares ordinary executions; each caller owns its configuration and active cursors. */
import type { DatabaseSync, StatementSync } from 'node:sqlite';

export function reuseStatements(db: DatabaseSync): void {
  const prepare = db.prepare.bind(db), close = db.close.bind(db);
  const statements = new Map<string, StatementSync>();
  db.prepare = sql => {
    let shared = statements.get(sql);
    if (!shared) {
      shared = prepare(sql);
      if (statements.size >= 512) statements.delete(statements.keys().next().value!);
      statements.set(sql, shared);
    }
    let dedicated: StatementSync | undefined;
    const methods = new Map<PropertyKey, unknown>();
    const target = Object.create(Object.getPrototypeOf(shared)) as StatementSync;
    return new Proxy(target, {
      get(target, key, receiver) {
        // The write guard and test spies can wrap this caller's methods independently.
        if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
        const statement = dedicated ?? shared!;
        const value = Reflect.get(statement, key, statement);
        if (typeof value !== 'function') return value;
        if (!methods.has(key)) methods.set(key, (...args: unknown[]) => {
          // Isolate before configuring or opening a cursor, including from holders prepared earlier.
          if (key === 'iterate' || typeof key === 'string' && key.startsWith('set')) dedicated ??= prepare(sql);
          const own = dedicated ?? shared!;
          return Reflect.apply(Reflect.get(own, key, own), own, args);
        });
        return methods.get(key);
      },
    });
  };
  db.close = () => { statements.clear(); close(); };
}
