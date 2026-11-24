-- Keep task IDs and their foreign references while enabling project work.
CREATE TABLE replacement_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','project')),
  number INTEGER NOT NULL UNIQUE CHECK(number > 0), external_id TEXT GENERATED ALWAYS AS (CASE kind WHEN 'task' THEN 'T' WHEN 'project' THEN 'P' END || number) STORED UNIQUE,
  parent_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED, project_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived','deleted')),
  base_state TEXT NOT NULL CHECK(base_state IN ('todo','doing','error','waiting','done','stopped')),
  hold INTEGER NOT NULL CHECK(hold IN (0,1)),
  state TEXT GENERATED ALWAYS AS (CASE WHEN hold=1 THEN 'held' ELSE base_state END) VIRTUAL,
  user_requested INTEGER NOT NULL DEFAULT 0 CHECK(user_requested IN (0,1)),
  settings TEXT CHECK(settings IS NULL OR json_valid(settings)),
  revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(parent_id IS NULL OR parent_id <> id),
  CHECK((kind = 'project') = (project_task_id IS NULL)),
  CHECK(kind = 'project' OR (parent_id IS NOT NULL AND settings IS NULL)),
  CHECK(kind = 'task' OR user_requested = 0),
  CHECK(base_state <> 'waiting' OR user_requested = 1)
) STRICT;
--> statement-breakpoint
INSERT INTO replacement_tasks(id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at) SELECT id,kind,number,parent_id,project_task_id,title,lifecycle,base_state,hold,user_requested,settings,revision,created_at,updated_at FROM tasks;
--> statement-breakpoint
DROP TRIGGER placements_task_kind;
--> statement-breakpoint
DROP TRIGGER wait_cycles_insert;
--> statement-breakpoint
-- Keep the references from other tables and triggers bound to tasks while replacing it.
PRAGMA legacy_alter_table=ON;
--> statement-breakpoint
DROP TABLE tasks;
--> statement-breakpoint
ALTER TABLE replacement_tasks RENAME TO tasks;
--> statement-breakpoint
PRAGMA legacy_alter_table=OFF;
--> statement-breakpoint
CREATE INDEX tasks_parent ON tasks(parent_id);
--> statement-breakpoint
CREATE INDEX tasks_project ON tasks(project_task_id,id,external_id,revision);
--> statement-breakpoint
CREATE INDEX tasks_work_project ON tasks(coalesce(project_task_id,id));
--> statement-breakpoint
CREATE TRIGGER tasks_parent_cycle BEFORE UPDATE OF parent_id ON tasks WHEN NEW.parent_id IS NOT NULL BEGIN
  SELECT CASE WHEN EXISTS (
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.parent_id UNION ALL SELECT t.parent_id FROM tasks t JOIN ancestors a ON t.id=a.id WHERE t.parent_id IS NOT NULL
    ) SELECT 1 FROM ancestors WHERE id=NEW.id
  ) THEN RAISE(ABORT,'task parent cycle') END;
END;
--> statement-breakpoint
CREATE TRIGGER tasks_shape_insert BEFORE INSERT ON tasks BEGIN
  SELECT CASE WHEN NEW.kind = 'project' AND NEW.parent_id IS NOT NULL
    AND (SELECT kind FROM tasks WHERE id = NEW.parent_id) IS NOT 'project'
    THEN RAISE(ABORT,'project parent must be a project') END;
  SELECT CASE WHEN NEW.kind = 'task' AND (SELECT kind FROM tasks WHERE id = NEW.project_task_id) IS NOT 'project'
    THEN RAISE(ABORT,'task project must be a project') END;
  SELECT CASE WHEN NEW.kind = 'task' AND NEW.parent_id IS NOT NEW.project_task_id AND NOT EXISTS
    (SELECT 1 FROM tasks WHERE id = NEW.parent_id AND kind = 'task' AND project_task_id = NEW.project_task_id)
    THEN RAISE(ABORT,'task parent must be its project or a task of that project') END;
END;
--> statement-breakpoint
CREATE TRIGGER tasks_shape_update BEFORE UPDATE OF kind,project_task_id,parent_id ON tasks BEGIN
  SELECT CASE WHEN NEW.kind IS NOT OLD.kind OR NEW.project_task_id IS NOT OLD.project_task_id
    THEN RAISE(ABORT,'task kind and project are immutable') END;
  SELECT CASE WHEN NEW.kind = 'project' AND NEW.parent_id IS NOT OLD.parent_id
    THEN RAISE(ABORT,'project parent is immutable') END;
  SELECT CASE WHEN NEW.kind = 'task' AND NEW.parent_id IS NOT NEW.project_task_id AND NOT EXISTS
    (SELECT 1 FROM tasks WHERE id = NEW.parent_id AND kind = 'task' AND project_task_id = NEW.project_task_id)
    THEN RAISE(ABORT,'task parent must be its project or a task of that project') END;
END;
--> statement-breakpoint
CREATE TEMP TABLE task_migration_integrity (violations INTEGER CHECK(violations = 0));
--> statement-breakpoint
INSERT INTO task_migration_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE task_migration_integrity;
