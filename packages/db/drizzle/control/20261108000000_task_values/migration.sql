-- Task values by field. The default fields live in code (contract DEFAULT_FIELDS); a stored definition of the same ID
-- replaces one, and fields the workspace adds are stored only here. Field IDs are not foreign keys: a default has no row.
CREATE TABLE field_defs (
  id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 40),
  definition TEXT NOT NULL CHECK(json_valid(definition) AND json_extract(definition,'$.id') IS id),
  updated_at TEXT NOT NULL
) STRICT;
--> statement-breakpoint
-- A project's own schema: the fields its Tasks use, in order. A project without rows takes the nearest project above's.
CREATE TABLE project_fields (
  project_task_id TEXT NOT NULL REFERENCES tasks(id),
  position INTEGER NOT NULL CHECK(position >= 0),
  field_id TEXT NOT NULL CHECK(length(field_id) BETWEEN 1 AND 40),
  PRIMARY KEY(project_task_id, position), UNIQUE(project_task_id, field_id)
) STRICT;
--> statement-breakpoint
CREATE TRIGGER project_fields_project BEFORE INSERT ON project_fields
WHEN (SELECT kind FROM tasks WHERE id=NEW.project_task_id) IS NOT 'project'
BEGIN SELECT RAISE(ABORT,'only a project has a schema'); END;
--> statement-breakpoint
-- One row per Task and field with a value; a field without a value has no row.
CREATE TABLE task_values (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  field_id TEXT NOT NULL CHECK(length(field_id) BETWEEN 1 AND 40),
  value TEXT NOT NULL CHECK(json_valid(value)),
  PRIMARY KEY(task_id, field_id)
) STRICT;
--> statement-breakpoint
-- Existing bodies move to task_values once, in stopped maintenance (apps/backend task-values-migration); a fresh
-- database has none. The bodies and project settings it read stay as migration evidence.
SELECT alpacawork_data_migration('task-values-v1');
--> statement-breakpoint
-- Bodies now live in task_values; nothing reads the column any more.
ALTER TABLE tasks DROP COLUMN body;
