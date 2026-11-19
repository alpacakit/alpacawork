CREATE TABLE task_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), next_number INTEGER NOT NULL CHECK(next_number > 0)) STRICT;
--> statement-breakpoint
CREATE TABLE run_sequence (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), next_number INTEGER NOT NULL CHECK(next_number > 0)) STRICT;
--> statement-breakpoint
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('task','project')),
  number INTEGER NOT NULL UNIQUE CHECK(number > 0), external_id TEXT GENERATED ALWAYS AS (CASE kind WHEN 'task' THEN 'T' WHEN 'project' THEN 'P' END || number) STORED UNIQUE,
  parent_id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED, project_task_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
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
  CHECK(kind = 'task' OR (user_requested = 0 AND base_state = 'todo' AND hold=0)),
  CHECK(base_state <> 'waiting' OR user_requested = 1)
) STRICT;
--> statement-breakpoint
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(external_id),
  after_task_id TEXT NOT NULL REFERENCES tasks(external_id),
  PRIMARY KEY(task_id, after_task_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE task_log (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), ordinal INTEGER NOT NULL,
  entry TEXT CHECK(entry IS NULL OR (json_valid(entry) AND json_extract(entry,'$.id') IS id
    AND json_extract(entry,'$.kind') IS NOT NULL
    AND json_extract(entry,'$.kind') NOT IN ('request_accepted','review_sent_back')
    AND json_type(entry,'$.startsEstimateRound') IS NULL)),
  request_id TEXT UNIQUE REFERENCES requests(id),
  note_title TEXT CHECK(note_title IS NULL OR length(trim(note_title)) > 0),
  note_description TEXT CHECK(note_description IS NULL OR (length(trim(note_description)) > 0 AND note_title IS NOT NULL)),
  kind TEXT GENERATED ALWAYS AS (json_extract(entry,'$.kind')) VIRTUAL,
  at TEXT GENERATED ALWAYS AS (json_extract(entry,'$.at')) VIRTUAL,
  CHECK((entry IS NOT NULL AND request_id IS NULL AND note_title IS NULL AND note_description IS NULL)
    OR (entry IS NULL AND request_id IS NOT NULL AND request_id = id)),
  UNIQUE(task_id,ordinal), UNIQUE(task_id,id)
) STRICT;
--> statement-breakpoint
CREATE TABLE task_log_question (
  log_id TEXT PRIMARY KEY REFERENCES task_log(id),
  question_log_id TEXT NOT NULL UNIQUE REFERENCES task_log(id)
) STRICT;
--> statement-breakpoint
CREATE TABLE log_texts (
  log_id TEXT PRIMARY KEY REFERENCES task_log(id),
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 1048576)
) STRICT;
--> statement-breakpoint
CREATE TABLE agents (id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
--> statement-breakpoint
CREATE TABLE placements (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(external_id),
  agent_id TEXT NOT NULL REFERENCES agents(id), profile_key TEXT NOT NULL,
  responsible INTEGER NOT NULL CHECK(responsible IN (0,1)), revision INTEGER NOT NULL CHECK(revision > 0),
  started_at TEXT NOT NULL, ended_at TEXT,
  UNIQUE(task_id,id)
) STRICT;
--> statement-breakpoint
CREATE TABLE wait_cycles (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(external_id),
  opened_at TEXT NOT NULL, closed_at TEXT,
  CHECK(closed_at IS NULL OR closed_at >= opened_at)
) STRICT;
--> statement-breakpoint
CREATE TABLE coordinator_conversations (
  id TEXT PRIMARY KEY, started_at TEXT NOT NULL, cleared_at TEXT,
  warm_request_id TEXT REFERENCES requests(id)
) STRICT;
--> statement-breakpoint
CREATE TABLE requests (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(external_id), placement_id TEXT,
  placement_revision INTEGER, task_hash TEXT,
  conversation_id TEXT REFERENCES coordinator_conversations(id), wait_cycle_id TEXT REFERENCES wait_cycles(id),
  head_run_id TEXT, about_run_id TEXT,
  answers_question TEXT REFERENCES task_log(id),
  mode TEXT NOT NULL CHECK(mode IN ('continue','new')), body TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('instruction','review_send_back','return_continuation')),
  author TEXT NOT NULL CHECK(json_valid(author)),
  submitted_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK(delivery_state IN ('queued','waiting_for_run','waiting_for_session','recorded_unconfirmed','aborted')),
  reply_to TEXT REFERENCES requests(id) CHECK(reply_to IS NULL OR conversation_id IS NOT NULL),
  FOREIGN KEY(task_id,placement_id) REFERENCES placements(task_id,id),
  CHECK((conversation_id IS NULL) = (task_id IS NOT NULL)),
  CHECK(task_id IS NULL OR (placement_id IS NOT NULL AND placement_revision IS NOT NULL AND task_hash IS NOT NULL)),
  CHECK(conversation_id IS NULL OR
    (placement_id IS NULL AND placement_revision IS NULL AND task_hash IS NULL AND purpose = 'instruction' AND json_extract(author,'$.kind') IS 'human')),
  CHECK((purpose <> 'return_continuation' AND json_extract(author,'$.kind') IS 'placement') = (wait_cycle_id IS NOT NULL)),
  CHECK(purpose <> 'return_continuation' OR json_extract(author,'$.kind') IS 'placement'),
  CHECK(about_run_id IS NULL OR (purpose = 'review_send_back' AND about_run_id IS head_run_id))
) STRICT;
--> statement-breakpoint
CREATE TABLE task_stop_epochs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(external_id), stop_id TEXT NOT NULL REFERENCES task_log(id)
) STRICT;
--> statement-breakpoint
CREATE TABLE task_start_grants (
  request_id TEXT PRIMARY KEY REFERENCES requests(id),
  path TEXT NOT NULL CHECK(json_valid(path)), intent TEXT CHECK(intent IS NULL OR json_valid(intent))
) STRICT;
--> statement-breakpoint
CREATE TABLE runs (
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
  UNIQUE(request_id),
  CHECK(json_extract(record,'$.id') = 'R' || id),
  CHECK((json_extract(record,'$.role') = 'coordinator') = (task_id IS NULL)),
  CHECK((task_id IS NULL) = (conversation_id IS NOT NULL)),
  CHECK(task_id IS NOT NULL OR (placement_id IS NULL AND caller_run IS NULL AND request_id IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE returns (
  id TEXT PRIMARY KEY, request_id TEXT REFERENCES requests(id),
  to_task_id TEXT NOT NULL REFERENCES tasks(external_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','stopped','needs_review','closed','moved','question','urgent','answer','handover','child_added','work_changed')),
  boundary_run_id TEXT, cause_log_id TEXT REFERENCES task_log(id), hold_reason TEXT, created_at TEXT NOT NULL,
  CHECK((request_id IS NULL) = (outcome IN ('question','urgent','answer','handover','child_added','work_changed'))),
  CHECK(outcome IN ('succeeded','failed','stopped','needs_review','closed','moved') OR cause_log_id IS NOT NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE return_deliveries (
  return_id TEXT NOT NULL REFERENCES returns(id), wake_request_id TEXT NOT NULL REFERENCES requests(id),
  reserved_at TEXT NOT NULL, received_at TEXT, consumed_at TEXT, released_at TEXT, release_reason TEXT,
  PRIMARY KEY(return_id,wake_request_id),
  CHECK((released_at IS NULL) = (release_reason IS NULL)),
  CHECK(consumed_at IS NULL OR received_at IS NOT NULL), CHECK(consumed_at IS NULL OR released_at IS NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE return_resolutions (
  return_id TEXT PRIMARY KEY REFERENCES returns(id),
  reason TEXT NOT NULL CHECK(reason IN ('question_closed','seat_finished','origin_stopped','migrated_handled')), at TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE cli_operations (
  op_id TEXT PRIMARY KEY, operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL, status INTEGER NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  committed_at TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE task_dialogues (
  task_uuid TEXT NOT NULL REFERENCES tasks(id), request_id TEXT NOT NULL REFERENCES requests(id),
  PRIMARY KEY(task_uuid,request_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE coordinator_refusals (
  request_id TEXT NOT NULL REFERENCES requests(id), task_uuid TEXT NOT NULL REFERENCES tasks(id),
  refused_at TEXT NOT NULL, problem_json TEXT CHECK(problem_json IS NULL OR json_valid(problem_json)),
  code_only TEXT,
  CHECK((problem_json IS NULL AND code_only IS NOT NULL) OR (problem_json IS NOT NULL AND code_only IS NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE file_operations (
  id TEXT PRIMARY KEY, op_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('put','delete','move')),
  task_uuid TEXT REFERENCES tasks(id), source_path TEXT, destination_path TEXT,
  old_digest TEXT, new_digest TEXT, stage_path TEXT, tombstone_path TEXT,
  fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','published','needs_review')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
) STRICT;
--> statement-breakpoint
CREATE TABLE file_path_reservations (
  path TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES file_operations(id)
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE) STRICT;
--> statement-breakpoint
CREATE TABLE run_attempts (
 run_no INTEGER PRIMARY KEY REFERENCES runs(id), attempt_id TEXT NOT NULL UNIQUE,
 launch_json TEXT NOT NULL CHECK(json_valid(launch_json)), next_seq INTEGER NOT NULL DEFAULT 1, last_digest TEXT,
 claimed INTEGER NOT NULL DEFAULT 0, spawn_intent INTEGER NOT NULL DEFAULT 0, started_json TEXT CHECK(started_json IS NULL OR json_valid(started_json)),
 completed_digest TEXT, diagnostic TEXT CHECK(diagnostic IS NULL OR json_valid(diagnostic)), dirty INTEGER NOT NULL DEFAULT 0,
 acked_seq INTEGER NOT NULL DEFAULT 0 CHECK(acked_seq>=0 AND acked_seq<next_seq)
) STRICT;
--> statement-breakpoint
CREATE TABLE run_commands (
 attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id), seq INTEGER NOT NULL CHECK(seq>0), command_id TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('input','cancel-input','stop')), input_id TEXT, instruction_run_no INTEGER REFERENCES runs(id),
 operation_id TEXT, json TEXT NOT NULL CHECK(json_valid(json)), published INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(attempt_id,seq)
) STRICT;
--> statement-breakpoint
CREATE TABLE run_inputs (
 input_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id), instruction_run_no INTEGER NOT NULL REFERENCES runs(id),
 content_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','attempted','taken','not_sent','uncertain','resolved')),
 initial INTEGER NOT NULL CHECK(initial IN (0,1)), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json))
) STRICT;
--> statement-breakpoint
CREATE TABLE control_migration_sources (
  id TEXT PRIMARY KEY, metadata TEXT NOT NULL CHECK(json_valid(metadata)), evidence_digest TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE control_migration_evidence (
  source_id TEXT NOT NULL REFERENCES control_migration_sources(id) DEFERRABLE INITIALLY DEFERRED,
  table_name TEXT NOT NULL, source_rowid TEXT NOT NULL, cells TEXT NOT NULL CHECK(json_valid(cells)),
  PRIMARY KEY(source_id,table_name,source_rowid)
) STRICT;
--> statement-breakpoint
CREATE TABLE control_schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('automatic','planned'))) STRICT;
--> statement-breakpoint
CREATE INDEX tasks_parent ON tasks(parent_id);
--> statement-breakpoint
CREATE INDEX tasks_project ON tasks(project_task_id,id,external_id,revision);
--> statement-breakpoint
CREATE INDEX task_log_message ON task_log(json_extract(entry,'$.actor.message'))
  WHERE json_extract(entry,'$.actor.message') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX task_log_handoffs ON task_log(julianday(at) DESC,task_id) WHERE json_extract(entry,'$.toState') IN ('done','waiting');
--> statement-breakpoint
CREATE UNIQUE INDEX placements_one_responsible ON placements(task_id) WHERE ended_at IS NULL AND responsible = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX placements_one_active_person ON placements(task_id,agent_id) WHERE ended_at IS NULL;
--> statement-breakpoint
CREATE INDEX wait_cycles_task ON wait_cycles(task_id);
--> statement-breakpoint
CREATE UNIQUE INDEX wait_cycles_one_open ON wait_cycles(task_id) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX coordinator_conversations_one_open ON coordinator_conversations((cleared_at IS NULL)) WHERE cleared_at IS NULL;
--> statement-breakpoint
CREATE INDEX requests_task ON requests(task_id,delivery_state);
--> statement-breakpoint
CREATE INDEX requests_cycle ON requests(wait_cycle_id);
--> statement-breakpoint
CREATE INDEX requests_conversation ON requests(conversation_id,submitted_at);
--> statement-breakpoint
CREATE INDEX requests_message ON requests(json_extract(author,'$.message'))
  WHERE json_extract(author,'$.message') IS NOT NULL;
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
CREATE UNIQUE INDEX returns_close ON returns(request_id) WHERE request_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX returns_notice ON returns(cause_log_id,outcome) WHERE request_id IS NULL;
--> statement-breakpoint
CREATE INDEX returns_destination ON returns(to_task_id,id,hold_reason);
--> statement-breakpoint
CREATE INDEX return_deliveries_marks ON return_deliveries(return_id,received_at,consumed_at,released_at);
--> statement-breakpoint
CREATE UNIQUE INDEX return_delivery_active ON return_deliveries(return_id) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX task_dialogues_request ON task_dialogues(request_id);
--> statement-breakpoint
CREATE INDEX coordinator_refusals_request ON coordinator_refusals(request_id);
--> statement-breakpoint
CREATE INDEX file_operations_moved ON file_operations(source_path) WHERE kind='move' AND state='published';
--> statement-breakpoint
CREATE INDEX run_attempts_dirty ON run_attempts(run_no) WHERE dirty=1;
--> statement-breakpoint
CREATE INDEX run_attempts_open ON run_attempts(run_no) WHERE completed_digest IS NULL OR diagnostic IS NOT NULL OR acked_seq<next_seq-1;
--> statement-breakpoint
CREATE INDEX run_commands_unpublished ON run_commands(type) WHERE published=0;
--> statement-breakpoint
CREATE UNIQUE INDEX run_inputs_reservation ON run_inputs(instruction_run_no) WHERE state<>'not_sent';
--> statement-breakpoint
CREATE INDEX run_inputs_attempt ON run_inputs(attempt_id,state);
--> statement-breakpoint
CREATE INDEX run_inputs_instruction ON run_inputs(instruction_run_no);
--> statement-breakpoint
CREATE INDEX run_inputs_uncertain ON run_inputs(instruction_run_no,attempt_id) WHERE state='uncertain';
--> statement-breakpoint
CREATE TRIGGER control_migration_sources_update BEFORE UPDATE ON control_migration_sources BEGIN
  SELECT RAISE(ABORT,'migration snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER control_migration_sources_delete BEFORE DELETE ON control_migration_sources BEGIN
  SELECT RAISE(ABORT,'migration snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER control_migration_evidence_insert BEFORE INSERT ON control_migration_evidence
WHEN EXISTS (SELECT 1 FROM control_migration_sources WHERE id=NEW.source_id) BEGIN
  SELECT RAISE(ABORT,'migration snapshot is sealed'); END;
--> statement-breakpoint
CREATE TRIGGER control_migration_evidence_update BEFORE UPDATE ON control_migration_evidence BEGIN
  SELECT RAISE(ABORT,'migration snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER control_migration_evidence_delete BEFORE DELETE ON control_migration_evidence BEGIN
  SELECT RAISE(ABORT,'migration snapshot is immutable'); END;
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
CREATE TRIGGER task_request_reference BEFORE INSERT ON task_log
WHEN NEW.request_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests q JOIN tasks t ON t.external_id=q.task_id
    WHERE q.id=NEW.request_id AND t.id=NEW.task_id AND q.purpose <> 'return_continuation')
    THEN RAISE(ABORT,'request reference must belong to the same Task and an explicit instruction') END;
END;
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
CREATE TRIGGER task_log_update BEFORE UPDATE ON task_log BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER task_log_delete BEFORE DELETE ON task_log BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER task_log_question_insert BEFORE INSERT ON task_log_question BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM task_log closing JOIN task_log question ON question.task_id = closing.task_id
    WHERE closing.id = NEW.log_id AND closing.kind IN ('answered','question_withdrawn','question_expired')
    AND json_extract(closing.entry,'$.questionId') = NEW.question_log_id
    AND question.id = NEW.question_log_id AND question.kind = 'asked')
    THEN RAISE(ABORT,'question closing mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER log_texts_insert BEFORE INSERT ON log_texts BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM task_log WHERE id = NEW.log_id AND kind IN ('asked','answered'))
    THEN RAISE(ABORT,'only a question or an answer keeps its text') END;
END;
--> statement-breakpoint
CREATE TRIGGER log_texts_update BEFORE UPDATE ON log_texts BEGIN SELECT RAISE(ABORT,'log text is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER log_texts_delete BEFORE DELETE ON log_texts BEGIN SELECT RAISE(ABORT,'log text is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER placements_task_kind BEFORE INSERT ON placements BEGIN
  SELECT CASE WHEN (SELECT kind FROM tasks WHERE external_id = NEW.task_id) = 'project'
    THEN RAISE(ABORT,'a project has no placements') END;
END;
--> statement-breakpoint
CREATE TRIGGER wait_cycles_insert BEFORE INSERT ON wait_cycles BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE external_id = NEW.task_id AND kind = 'task')
    THEN RAISE(ABORT,'a wait cycle belongs to a task') END;
END;
--> statement-breakpoint
CREATE TRIGGER wait_cycles_update BEFORE UPDATE ON wait_cycles BEGIN
  SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.opened_at IS NOT OLD.opened_at
    OR OLD.closed_at IS NOT NULL OR NEW.closed_at IS NULL
    THEN RAISE(ABORT,'a wait cycle only closes, and only once') END;
END;
--> statement-breakpoint
CREATE TRIGGER requests_immutable BEFORE UPDATE ON requests WHEN
  NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.placement_id IS NOT OLD.placement_id
  OR NEW.placement_revision IS NOT OLD.placement_revision OR NEW.task_hash IS NOT OLD.task_hash
  OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.wait_cycle_id IS NOT OLD.wait_cycle_id
  OR NEW.reply_to IS NOT OLD.reply_to OR NEW.head_run_id IS NOT OLD.head_run_id OR NEW.mode IS NOT OLD.mode OR NEW.body IS NOT OLD.body
  OR NEW.answers_question IS NOT OLD.answers_question
  OR NEW.about_run_id IS NOT OLD.about_run_id OR NEW.purpose IS NOT OLD.purpose OR NEW.author IS NOT OLD.author OR NEW.submitted_at IS NOT OLD.submitted_at
BEGIN SELECT RAISE(ABORT,'request ownership is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER requests_answer_insert BEFORE INSERT ON requests WHEN NEW.answers_question IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.purpose <> 'instruction' OR NOT EXISTS (
    SELECT 1 FROM task_log l JOIN tasks t ON t.id=l.task_id
    WHERE l.id=NEW.answers_question AND l.kind='asked' AND t.external_id=NEW.task_id)
    THEN RAISE(ABORT,'instruction answer must name its own Task question') END;
END;
--> statement-breakpoint
CREATE TRIGGER requests_head_insert BEFORE INSERT ON requests WHEN NEW.head_run_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM runs WHERE id = CAST(substr(NEW.head_run_id,2) AS INTEGER) AND 'R' || id = NEW.head_run_id
    AND (task_id = NEW.task_id AND placement_id IS NEW.placement_id OR conversation_id = NEW.conversation_id))
    THEN RAISE(ABORT,'request head mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER requests_open_cycle BEFORE INSERT ON requests WHEN NEW.wait_cycle_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM wait_cycles c JOIN placements sender
    ON sender.id=json_extract(NEW.author,'$.placementId')
    WHERE c.id=NEW.wait_cycle_id AND c.closed_at IS NULL AND c.task_id=sender.task_id)
    THEN RAISE(ABORT,'request wait cycle mismatch') END;
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
    OR NEW.resumes_id IS NOT OLD.resumes_id OR NEW.caller_run IS NOT OLD.caller_run
    OR NEW.conversation_id IS NOT OLD.conversation_id
    THEN RAISE(ABORT,'run ownership is immutable') END;
  SELECT CASE WHEN NEW.placement_id IS NOT NULL AND
    (SELECT task_id FROM placements WHERE id = NEW.placement_id) IS NOT NEW.task_id
    THEN RAISE(ABORT,'run placement witness mismatch') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND
    (SELECT task_id FROM requests WHERE id = NEW.request_id) IS NOT NEW.task_id
    THEN RAISE(ABORT,'run request witness mismatch') END;
  SELECT CASE WHEN NEW.into_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM runs WHERE id = CAST(substr(NEW.into_id,2) AS INTEGER) AND 'R' || id = NEW.into_id)
    THEN RAISE(ABORT,'run joined target missing') END;
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
CREATE TRIGGER return_delivery_insert BEFORE INSERT ON return_deliveries BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM returns r JOIN requests q ON q.id = NEW.wake_request_id
    WHERE r.id = NEW.return_id AND q.task_id = r.to_task_id)
    THEN RAISE(ABORT,'return delivery destination mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER return_resolution_insert BEFORE INSERT ON return_resolutions BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM return_deliveries WHERE return_id = NEW.return_id AND consumed_at IS NOT NULL)
    THEN RAISE(ABORT,'a consumed return cannot be resolved') END;
END;
--> statement-breakpoint
CREATE TRIGGER task_dialogues_insert BEFORE INSERT ON task_dialogues BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests WHERE id = NEW.request_id AND conversation_id IS NOT NULL)
    THEN RAISE(ABORT,'dialogue requires a screen Request') END;
END;
--> statement-breakpoint
CREATE TRIGGER task_dialogues_update BEFORE UPDATE ON task_dialogues BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests WHERE id = NEW.request_id AND conversation_id IS NOT NULL)
    THEN RAISE(ABORT,'dialogue requires a screen Request') END;
END;
--> statement-breakpoint
CREATE TRIGGER coordinator_refusals_insert BEFORE INSERT ON coordinator_refusals BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests WHERE id = NEW.request_id AND conversation_id IS NOT NULL)
    THEN RAISE(ABORT,'refusal requires a screen Request') END;
END;
--> statement-breakpoint
CREATE TRIGGER coordinator_refusals_update BEFORE UPDATE ON coordinator_refusals BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests WHERE id = NEW.request_id AND conversation_id IS NOT NULL)
    THEN RAISE(ABORT,'refusal requires a screen Request') END;
END;
--> statement-breakpoint
INSERT INTO task_sequence VALUES (1,1);
--> statement-breakpoint
INSERT INTO run_sequence VALUES (1,1);
--> statement-breakpoint
INSERT INTO workspace_identity VALUES (1, lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))));
--> statement-breakpoint
PRAGMA user_version=16;
