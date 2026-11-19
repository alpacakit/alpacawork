/** A frozen migration event, never a second writable source for live domain decisions. */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

const hash = () => createHash('sha256');
function frame(digest: ReturnType<typeof hash>, fields: readonly string[]) {
  for (const field of fields) { const value=Buffer.from(field), size=Buffer.alloc(8); size.writeBigUInt64BE(BigInt(value.length)); digest.update(size).update(value); }
}
/** Bind provenance/schema/counts as well as the original cells. Neither half may drift independently. */
export function sealMigrationEvidence(metadata: string, cellsDigest: string) {
  return createHash('sha256').update(metadata).update('\0').update(cellsDigest).digest('hex');
}
/** Append a frozen data-migration event to the existing evidence Owner, in the SQL transaction. */
export function writeMigrationEvidence(db: DatabaseSync, id: string, metadata: Record<string, unknown> & { sourceSchema: unknown[] },
  rows: { table: string; rowid: number; cells: unknown[] }[]) {
  const digest = hash(), counts: Record<string, number> = {};
  const ordered = [...rows].sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : a.rowid - b.rowid);
  for (const row of ordered) counts[row.table] = (counts[row.table] ?? 0) + 1;
  const sourceSchema = metadata.sourceSchema;
  const value = JSON.stringify({ ...metadata, sourceSchema,
    sourceSchemaDigest: createHash('sha256').update(JSON.stringify(sourceSchema)).digest('hex'), evidenceCounts: counts });
  const insert = db.prepare('INSERT INTO control_migration_evidence(source_id,table_name,source_rowid,cells) VALUES (?,?,?,?)');
  // FK is deferred; the receipt below binds all cells before the transaction can commit.
  for (const row of ordered) {
    const cells = JSON.stringify(row.cells); frame(digest, [row.table, String(row.rowid), cells]);
    insert.run(id, row.table, String(row.rowid), cells);
  }
  db.prepare('INSERT INTO control_migration_sources(id,metadata,evidence_digest) VALUES (?,?,?)')
    .run(id, value, sealMigrationEvidence(value, digest.digest('hex')));
}
/** Expensive verification belongs to stopped maintenance; live readers never execute historical records. */
export function validateMigrationEvidence(db: DatabaseSync) {
  for(const source of db.prepare('SELECT * FROM control_migration_sources').iterate()) {
    const metadata=JSON.parse(String(source.metadata)), digest=hash(), counts: Record<string,number>={};
    if(!Array.isArray(metadata.sourceSchema)||createHash('sha256').update(JSON.stringify(metadata.sourceSchema)).digest('hex')!==metadata.sourceSchemaDigest)throw new Error('Migration raw schema evidence is missing or changed');
    const dependencyMigration = metadata.sourceVersion === 14 && metadata.transformation?.to === 15;
    const agentMigration = metadata.sourceVersion === 16 && metadata.transformation?.to === 16 && metadata.transformation?.kind === 'agent-settings-v1';
    const taskValuesMigration = metadata.sourceVersion === 16 && metadata.transformation?.to === 16 && metadata.transformation?.kind === 'task-values-v1';
    if (agentMigration) {
      const config = metadata.config;
      if (!config || !/^[a-f0-9]{64}$/.test(config.beforeDigest ?? '') || !/^[a-f0-9]{64}$/.test(config.afterDigest ?? '') ||
          typeof config.afterBytes !== 'string' || Buffer.from(config.afterBytes, 'base64').toString('base64') !== config.afterBytes ||
          createHash('sha256').update(Buffer.from(config.afterBytes, 'base64')).digest('hex') !== config.afterDigest)
        throw new Error('Agent migration config receipt is missing or changed');
    }
    if((!dependencyMigration && !agentMigration && !taskValuesMigration && (![8,9,11,12].includes(metadata.sourceVersion)||![11,12,13].includes(metadata.transformation?.to)))||metadata.transformation?.from!==metadata.sourceVersion||
      !/^[a-f0-9]{64}$/.test(metadata.transformation?.checksum??'')||!metadata.operationalAfter?.tables)throw new Error('Migration source metadata is missing or changed');
    for(const table of Object.keys(metadata.evidenceCounts as Record<string,number>).sort()) {
      counts[table]=0;
      for(const row of db.prepare(`SELECT source_rowid,cells FROM control_migration_evidence WHERE source_id=? AND table_name=?
        ORDER BY CAST(source_rowid AS INTEGER)`).iterate(String(source.id),table)) {
        const cells=JSON.parse(String(row.cells));
        if(!Array.isArray(cells)||!cells.length||cells[0][0]!=='rowid') throw new Error('Invalid migration evidence cells');
        frame(digest,[table,String(row.source_rowid),String(row.cells)]); counts[table]++;
      }
    }
    const actual=db.prepare('SELECT count(*) n FROM control_migration_evidence WHERE source_id=?').get(String(source.id))!;
    if(sealMigrationEvidence(String(source.metadata),digest.digest('hex'))!==source.evidence_digest||JSON.stringify(counts)!==JSON.stringify(metadata.evidenceCounts)||
      BigInt(String(actual.n))!==Object.values(counts).reduce((sum,n)=>sum+BigInt(n),0n)) throw new Error('Migration snapshot evidence is missing or changed');
  }
  if(db.prepare(`SELECT 1 FROM control_migration_evidence e LEFT JOIN control_migration_sources s ON s.id=e.source_id WHERE s.id IS NULL`).get())
    throw new Error('Migration snapshot source is missing');
}
