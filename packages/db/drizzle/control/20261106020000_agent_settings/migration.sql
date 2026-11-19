-- Application data and its schema-history receipt commit in one standard Drizzle transaction.
-- Fresh databases have no legacy application data; existing databases require stopped maintenance.
DROP TRIGGER task_log_update;
--> statement-breakpoint
SELECT alpacawork_data_migration('agent-settings-v1');
--> statement-breakpoint
CREATE TRIGGER task_log_update BEFORE UPDATE ON task_log BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
