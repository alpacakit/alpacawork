# Database schema ownership

## Migrations

- Ordinary control DDL lives only in `drizzle/control/*/migration.sql`; host DDL lives in `drizzle/host`.
- Append custom control migrations in dated directory order, separating statements with Drizzle statement breakpoints.
- SCHEMA name/hash histories are derived from these exact packaged bytes. Do not regenerate or maintain a parallel current raw baseline.
- `user_version=16` is the reader boundary that refuses the deployed raw c9 reader. It is not the migration counter. Compare complete ordered history even when both markers are 16.

## Existing databases

- Existing normal read/write openers require the exact packaged history; they never advance an existing DB. Empty or corrupt existing files are not fresh.
- Stopped maintenance accepts a nonempty authenticated prefix of the packaged history, verifies integrity, foreign keys and sealed historical evidence, and applies pending SQL under the existing workspace writer. Both control and host must be authenticated before either is changed. Pending SQL waits for all Runs to end naturally; a same-history no-op preserves running Runs.
- There is no legacy database/config conversion, bootstrap descriptor or immediate upgrade restoration.
- Existing sealed evidence tables and triggers remain immutable; they are never an alternate live domain source.
- Code restoration requires unchanged control and host histories. Explicit DB group recovery belongs to the existing release switch journal (`apps/backend/src/release/switch.ts`).
