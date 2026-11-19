import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { packagedMigrations, type DatabaseKind } from '@alpacawork/db';

/** A copied SQL asset set extends this checkout's history, never precedes an ordinary SQL. */
export function appendTestMigration(assets: string, kind: DatabaseKind, sql: string) {
  const last = packagedMigrations(kind).at(-1)!.name;
  const next = new Date(`${last.slice(0,4)}-${last.slice(4,6)}-${last.slice(6,8)}T${last.slice(8,10)}:${last.slice(10,12)}:${last.slice(12,14)}Z`);
  next.setUTCSeconds(next.getUTCSeconds() + 1);
  const name = `${next.toISOString().slice(0,19).replace(/\D/g, '')}_test`;
  const folder = join(assets, 'drizzle', kind, name);
  mkdirSync(folder); writeFileSync(join(folder, 'migration.sql'), sql);
}
