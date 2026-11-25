-- The value a Task's field had before a write replaced or removed it, kept so a Task's values can be read as of a time
-- (task values --at). One row per field a write changed: `value` is what the field held until `replaced_at`, NULL when it
-- had none (the write gave it its first value). Rows are only added; a value removed from task_values stays here.
CREATE TABLE task_value_versions (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  field_id TEXT NOT NULL CHECK(length(field_id) BETWEEN 1 AND 40),
  replaced_at TEXT NOT NULL,
  value TEXT CHECK(value IS NULL OR json_valid(value))
) STRICT;
--> statement-breakpoint
CREATE INDEX task_value_versions_task ON task_value_versions(task_id, replaced_at);
--> statement-breakpoint
CREATE TRIGGER task_value_versions_update BEFORE UPDATE ON task_value_versions
BEGIN SELECT RAISE(ABORT,'a value version is fixed as written'); END;
--> statement-breakpoint
CREATE TRIGGER task_value_versions_delete BEFORE DELETE ON task_value_versions
BEGIN SELECT RAISE(ABORT,'a value version is fixed as written'); END;
--> statement-breakpoint
-- When versions began to be kept (in the log's time form): before it, a Task's earlier values are not known.
CREATE TABLE task_value_versions_since (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  at TEXT NOT NULL
) STRICT;
--> statement-breakpoint
INSERT INTO task_value_versions_since(singleton, at) VALUES (1, strftime('%Y-%m-%dT%H:%M:%f', 'now') || '000+00:00');
