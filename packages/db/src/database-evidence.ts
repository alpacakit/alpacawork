/** Stable SQLite facts, used by maintenance snapshot certification. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { controlSchemaFingerprint } from './control-maintenance-schema.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** The stored schema text itself, unnormalized: which writer produced it, not only what it means. */
export function rawSchemaShape(db: DatabaseSync): string {
  return digest(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(row => [row.type, row.name, row.tbl_name, row.sql]));
}
/** All values are SQLite-typed raw bytes. No JS decoding, numeric rounding, or whole-history JSON aggregate. */
export function rowsDigest(db: DatabaseSync, table: string, columns?: string[], where = ''): string {
  const fields = columns ?? db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().map(r => String(r.name));
  const select = ['rowid', ...fields].flatMap(f => [`typeof(${quote(f)})`, `CAST(${quote(f)} AS BLOB)`]).join(',');
  const statement = db.prepare(`SELECT ${select} FROM ${quote(table)} ${where} ORDER BY rowid`);
  statement.setReturnArrays(true);
  const hash = createHash('sha256'), length = Buffer.alloc(8);
  for (const row of statement.iterate()) {
    hash.update('row:');
    for (const value of row as unknown as (string | Uint8Array | null)[]) {
      const bytes = value === null ? Buffer.alloc(0) : typeof value === 'string' ? Buffer.from(value) : value;
      hash.update(value === null ? 'null:' : typeof value === 'string' ? 'type:' : 'value:');
      length.writeBigUInt64BE(BigInt(bytes.byteLength)); hash.update(length); hash.update(bytes);
    }
    hash.update('end-row:');
  }
  return hash.update('end-table:').digest('hex');
}
export function databaseState(db: DatabaseSync) {
  return { version: Number(db.prepare('PRAGMA user_version').get()!.user_version), shape: controlSchemaFingerprint(db), raw: rawSchemaShape(db),
    tables: db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name").all()
      .map(row => [String(row.name), rowsDigest(db, String(row.name))]) };
}
