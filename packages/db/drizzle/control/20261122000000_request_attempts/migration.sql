-- Preserve Run IDs and their execution records while allowing several attempts for one Request.
ALTER TABLE requests ADD COLUMN ai_stack TEXT CHECK(ai_stack IS NULL OR json_valid(ai_stack));
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN ai_explicit INTEGER NOT NULL DEFAULT 0 CHECK(ai_explicit IN (0,1));
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN ai_prefix TEXT CHECK(ai_prefix IS NULL OR json_valid(ai_prefix));
--> statement-breakpoint
ALTER TABLE placements ADD COLUMN ai_prefix TEXT CHECK(ai_prefix IS NULL OR json_valid(ai_prefix));
--> statement-breakpoint
CREATE TABLE replacement_runs (
  id INTEGER PRIMARY KEY CHECK(id > 0),
  record TEXT NOT NULL CHECK(json_valid(record)), prompt TEXT NOT NULL DEFAULT '',
  result TEXT, result_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(result_state IN ('present','pending','missing','too_large','unreadable')),
  state TEXT GENERATED ALWAYS AS (json_extract(record,'$.state')) STORED,
  session_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.session.id')) STORED,
  caller_run TEXT GENERATED ALWAYS AS (json_extract(record,'$.caller.run')) STORED,
  task_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.task')) VIRTUAL REFERENCES tasks(external_id),
  placement_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.placementId')) VIRTUAL REFERENCES placements(id),
  request_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.requestId')) VIRTUAL REFERENCES requests(id),
  resumes_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.resumes')) VIRTUAL,
  into_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.into')) VIRTUAL,
  conversation_id TEXT GENERATED ALWAYS AS (json_extract(record,'$.conversationId')) VIRTUAL,
  attempt INTEGER GENERATED ALWAYS AS (coalesce(json_extract(record,'$.attempt'),0)) VIRTUAL,
  UNIQUE(request_id,attempt),
  CHECK(attempt >= 0),
  CHECK(json_extract(record,'$.id') = 'R' || id),
  CHECK((json_extract(record,'$.role') = 'coordinator') = (task_id IS NULL)),
  CHECK((task_id IS NULL) = (conversation_id IS NOT NULL)),
  CHECK(task_id IS NOT NULL OR (placement_id IS NULL AND caller_run IS NULL AND request_id IS NOT NULL))
) STRICT;
--> statement-breakpoint
INSERT INTO replacement_runs(id,record,prompt,result,result_state) SELECT id,record,prompt,result,result_state FROM runs;
--> statement-breakpoint
DROP TRIGGER task_log_references;
--> statement-breakpoint
DROP TRIGGER requests_head_insert;
--> statement-breakpoint
DROP TRIGGER returns_insert;
--> statement-breakpoint
DROP TABLE runs;
--> statement-breakpoint
ALTER TABLE replacement_runs RENAME TO runs;
--> statement-breakpoint
CREATE INDEX runs_state ON runs(state);
--> statement-breakpoint
CREATE INDEX runs_session ON runs(session_id);
--> statement-breakpoint
CREATE INDEX runs_caller ON runs(caller_run);
--> statement-breakpoint
CREATE INDEX runs_task ON runs(task_id,state,result_state,id);
--> statement-breakpoint
CREATE INDEX runs_placement ON runs(placement_id);
--> statement-breakpoint
CREATE INDEX runs_conversation ON runs(conversation_id);
--> statement-breakpoint
CREATE TRIGGER task_log_references BEFORE INSERT ON task_log BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.entry,'$.runIds') ref
    WHERE NOT EXISTS (SELECT 1 FROM runs WHERE id=CAST(substr(ref.value,2) AS INTEGER) AND 'R' || id=ref.value AND task_id IS NOT NULL))
    THEN RAISE(ABORT,'log run must be a Task Run') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.entry,'$.formerAncestors') ref
    WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE external_id=ref.value))
    THEN RAISE(ABORT,'log former ancestor missing') END;
END;
--> statement-breakpoint
CREATE TRIGGER requests_head_insert BEFORE INSERT ON requests WHEN NEW.head_run_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = CAST(substr(NEW.head_run_id,2) AS INTEGER) AND 'R' || id = NEW.head_run_id
    AND (task_id = NEW.task_id AND placement_id IS NEW.placement_id OR conversation_id = NEW.conversation_id))
    THEN RAISE(ABORT,'request head mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER returns_insert BEFORE INSERT ON returns BEGIN
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM requests WHERE id = NEW.request_id AND task_id IS NOT NULL AND wait_cycle_id IS NOT NULL)
    THEN RAISE(ABORT,'return closes no placement request') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND NEW.to_task_id IS NOT
    (SELECT c.task_id FROM requests q JOIN wait_cycles c ON c.id=q.wait_cycle_id WHERE q.id=NEW.request_id)
    THEN RAISE(ABORT,'return requester seat mismatch') END;
  SELECT CASE WHEN NEW.boundary_run_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM runs r JOIN requests q ON q.task_id = r.task_id WHERE q.id = NEW.request_id AND r.id = CAST(substr(NEW.boundary_run_id,2) AS INTEGER) AND 'R' || r.id = NEW.boundary_run_id)
    THEN RAISE(ABORT,'return run is not of its request task') END;
  SELECT CASE WHEN NEW.outcome = 'question' AND NOT EXISTS (SELECT 1 FROM task_log
    WHERE id = NEW.cause_log_id AND kind = 'asked' AND json_extract(entry,'$.askedTo') = NEW.to_task_id)
    THEN RAISE(ABORT,'question return destination mismatch') END;
  SELECT CASE WHEN NEW.outcome = 'answer' AND NOT EXISTS (SELECT 1 FROM task_log l JOIN tasks t ON t.id = l.task_id
    WHERE l.id = NEW.cause_log_id AND l.kind IN ('answered','question_expired') AND t.external_id = NEW.to_task_id)
    THEN RAISE(ABORT,'answer return destination mismatch') END;
  SELECT CASE WHEN NEW.outcome = 'urgent' AND NOT EXISTS (SELECT 1 FROM task_log
    WHERE id = NEW.cause_log_id AND json_extract(entry,'$.urgentReason') IS NOT NULL)
    THEN RAISE(ABORT,'urgent return has no urgent reason') END;
  SELECT CASE WHEN NEW.outcome = 'handover' AND NOT EXISTS (SELECT 1 FROM task_log l JOIN tasks t ON t.id = l.task_id
    WHERE l.id = NEW.cause_log_id AND l.kind = 'responsible_changed' AND t.external_id = NEW.to_task_id)
    THEN RAISE(ABORT,'handover return destination mismatch') END;
  SELECT CASE WHEN NEW.outcome = 'child_added' AND NOT EXISTS (SELECT 1 FROM task_log l JOIN tasks child ON child.id = l.task_id
    JOIN tasks parent ON parent.id = child.parent_id
    WHERE l.id = NEW.cause_log_id AND l.kind = 'created' AND parent.external_id = NEW.to_task_id)
    THEN RAISE(ABORT,'child return destination mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER runs_witness_insert BEFORE INSERT ON runs BEGIN
  SELECT CASE WHEN NEW.placement_id IS NOT NULL AND
    (SELECT task_id FROM placements WHERE id = NEW.placement_id) IS NOT NEW.task_id
    THEN RAISE(ABORT,'run placement witness mismatch') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND
    (SELECT task_id FROM requests WHERE id = NEW.request_id) IS NOT NEW.task_id
    THEN RAISE(ABORT,'run request witness mismatch') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND
    (SELECT placement_id FROM requests WHERE id = NEW.request_id) IS NOT NEW.placement_id
    THEN RAISE(ABORT,'run request placement mismatch') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND
    (SELECT conversation_id FROM requests WHERE id = NEW.request_id) IS NOT NEW.conversation_id
    THEN RAISE(ABORT,'run conversation witness mismatch') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM requests WHERE id=NEW.request_id AND wait_cycle_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM requests q JOIN wait_cycles c ON c.id=q.wait_cycle_id
      JOIN runs caller ON caller.id=CAST(substr(NEW.caller_run,2) AS INTEGER)
      WHERE q.id=NEW.request_id AND 'R' || caller.id=NEW.caller_run AND caller.task_id=c.task_id
      AND caller.placement_id IS json_extract(q.author,'$.placementId'))
    THEN RAISE(ABORT,'run requester seat mismatch') END;
  SELECT CASE WHEN NEW.resumes_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM runs WHERE id = CAST(substr(NEW.resumes_id,2) AS INTEGER) AND 'R' || id = NEW.resumes_id AND conversation_id IS NEW.conversation_id)
    THEN RAISE(ABORT,'run resume witness mismatch') END;
  SELECT CASE WHEN NEW.caller_run IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM runs WHERE id = CAST(substr(NEW.caller_run,2) AS INTEGER) AND 'R' || id = NEW.caller_run)
    THEN RAISE(ABORT,'run caller missing') END;
END;
--> statement-breakpoint
CREATE TRIGGER runs_witness_update BEFORE UPDATE OF id,record ON runs BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id
    OR NEW.placement_id IS NOT OLD.placement_id OR NEW.request_id IS NOT OLD.request_id
    OR NEW.attempt IS NOT OLD.attempt
    OR (NEW.resumes_id IS NOT OLD.resumes_id AND NOT (OLD.state='queued' AND NEW.state='queued'))
    OR NEW.caller_run IS NOT OLD.caller_run
    OR NEW.conversation_id IS NOT OLD.conversation_id
    THEN RAISE(ABORT,'run ownership is immutable') END;
  SELECT CASE WHEN NEW.placement_id IS NOT NULL AND
    (SELECT task_id FROM placements WHERE id = NEW.placement_id) IS NOT NEW.task_id
    THEN RAISE(ABORT,'run placement witness mismatch') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND
    (SELECT task_id FROM requests WHERE id = NEW.request_id) IS NOT NEW.task_id
    THEN RAISE(ABORT,'run request witness mismatch') END;
  SELECT CASE WHEN json_extract(NEW.record,'$.supersededBy') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runs successor WHERE 'R'||successor.id=json_extract(NEW.record,'$.supersededBy')
      AND successor.request_id=NEW.request_id AND successor.attempt>NEW.attempt)
    THEN RAISE(ABORT,'run successor must share its request') END;
  SELECT CASE WHEN NEW.into_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM runs WHERE id = CAST(substr(NEW.into_id,2) AS INTEGER) AND 'R' || id = NEW.into_id)
    THEN RAISE(ABORT,'run joined target missing') END;
END;
--> statement-breakpoint
CREATE TEMP TABLE run_migration_integrity (violations INTEGER CHECK(violations = 0));
--> statement-breakpoint
INSERT INTO run_migration_integrity SELECT count(*) FROM pragma_foreign_key_check;
--> statement-breakpoint
DROP TABLE run_migration_integrity;
