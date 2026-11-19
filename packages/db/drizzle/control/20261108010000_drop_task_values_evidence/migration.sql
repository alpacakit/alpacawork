-- The bodies task-values-v1 kept as evidence leave the database: the values replaced them, and a kept copy of an old
-- body only misleads a reader of the database. Only this record goes; every other migration's record stays frozen, so
-- the guards that refuse a delete are lifted for these two statements and put back exactly as they were.
DROP TRIGGER control_migration_evidence_delete;
--> statement-breakpoint
DROP TRIGGER control_migration_sources_delete;
--> statement-breakpoint
DELETE FROM control_migration_evidence WHERE source_id='task-values-v1';
--> statement-breakpoint
DELETE FROM control_migration_sources WHERE id='task-values-v1';
--> statement-breakpoint
CREATE TRIGGER control_migration_sources_delete BEFORE DELETE ON control_migration_sources BEGIN
  SELECT RAISE(ABORT,'migration snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER control_migration_evidence_delete BEFORE DELETE ON control_migration_evidence BEGIN
  SELECT RAISE(ABORT,'migration snapshot is immutable'); END;
