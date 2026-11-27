DROP TRIGGER task_log_update;
--> statement-breakpoint
ALTER TABLE task_log ADD COLUMN event_sequence INTEGER CHECK(event_sequence > 0);
--> statement-breakpoint
WITH ordered AS MATERIALIZED (
  SELECT l.id, row_number() OVER (ORDER BY julianday(coalesce(l.at,q.submitted_at)),l.id) AS sequence
  FROM task_log l LEFT JOIN requests q ON q.id=l.request_id
)
UPDATE task_log SET event_sequence=(SELECT sequence FROM ordered WHERE ordered.id=task_log.id);
--> statement-breakpoint
CREATE UNIQUE INDEX task_log_event_sequence ON task_log(event_sequence);
--> statement-breakpoint
CREATE INDEX automation_task_origin ON task_log(json_extract(entry,'$.origin.automationId'),json_extract(entry,'$.origin.runNumber'))
  WHERE ordinal=0 AND json_extract(entry,'$.actor.kind')='automation';
--> statement-breakpoint
CREATE TRIGGER task_log_update BEFORE UPDATE ON task_log WHEN OLD.event_sequence IS NOT NULL
BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER task_log_event_sequence_insert BEFORE INSERT ON task_log WHEN NEW.event_sequence IS NOT NULL
BEGIN SELECT RAISE(ABORT,'task log event sequence is assigned on insert'); END;
--> statement-breakpoint
CREATE TRIGGER task_log_event_sequence_assign AFTER INSERT ON task_log BEGIN
  UPDATE task_log SET event_sequence=(SELECT coalesce(max(event_sequence),0)+1 FROM task_log) WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TABLE automation_cursor (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  event_sequence INTEGER NOT NULL CHECK(event_sequence >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO automation_cursor SELECT 1,coalesce(max(event_sequence),0) FROM task_log;
--> statement-breakpoint
CREATE TABLE analysis_run_skills (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  parser_version INTEGER NOT NULL CHECK(parser_version > 0),
  state TEXT NOT NULL CHECK(state IN ('complete','partial','unsupported')),
  names TEXT NOT NULL CHECK(json_valid(names) AND json_type(names)='array'),
  observed_at INTEGER NOT NULL CHECK(observed_at>=0)
) STRICT;
--> statement-breakpoint
CREATE TABLE automations (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE CHECK(number BETWEEN 1 AND 999999999),
  external_id TEXT GENERATED ALWAYS AS ('A' || number) VIRTUAL UNIQUE,
  project_task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL CHECK(length(trim(name))>0),
  latest_digest TEXT NOT NULL,
  live_digest TEXT,
  enabled INTEGER GENERATED ALWAYS AS (live_digest IS NOT NULL) VIRTUAL,
  revision INTEGER NOT NULL CHECK(revision>0),
  activation_revision INTEGER,
  activation_epoch INTEGER,
  disabled_reason TEXT CHECK(disabled_reason IN ('consecutive_failures','program_contract_changed')),
  next_at TEXT,
  event_after INTEGER CHECK(event_after>=0),
  host_pressure_after TEXT,
  host_pressure_cursor TEXT CHECK(host_pressure_cursor IS NULL OR json_valid(host_pressure_cursor)),
  next_run_number INTEGER NOT NULL DEFAULT 1 CHECK(next_run_number>0),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
  FOREIGN KEY(id,latest_digest) REFERENCES automation_versions(automation_id,digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,live_digest) REFERENCES automation_versions(automation_id,digest) DEFERRABLE INITIALLY DEFERRED,
  CHECK((live_digest IS NULL)=(activation_revision IS NULL) AND (live_digest IS NULL)=(activation_epoch IS NULL)),
  CHECK(enabled=0 OR (deleted=0 AND disabled_reason IS NULL)),
  CHECK(enabled=1 OR (next_at IS NULL AND event_after IS NULL AND host_pressure_after IS NULL AND host_pressure_cursor IS NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX automation_project ON automations(project_task_id,number) WHERE deleted=0;
--> statement-breakpoint
CREATE INDEX automation_due ON automations(next_at) WHERE enabled=1 AND next_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX automation_events ON automations(project_task_id,event_after) WHERE enabled=1 AND event_after IS NOT NULL;
--> statement-breakpoint
CREATE TABLE automation_versions (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),
  contract_version INTEGER NOT NULL CHECK(contract_version>0),
  saved_at TEXT NOT NULL,
  saved_by TEXT NOT NULL CHECK(json_valid(saved_by)),
  files TEXT NOT NULL CHECK(json_valid(files) AND json_type(files)='array'),
  config TEXT NOT NULL CHECK(json_valid(config) AND json_type(config)='object'),
  docs TEXT NOT NULL CHECK(json_valid(docs) AND json_type(docs)='object'),
  parts TEXT NOT NULL CHECK(json_valid(parts) AND json_type(parts)='array'),
  ai_uses TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(ai_uses) AND json_type(ai_uses)='object'),
  review TEXT NOT NULL CHECK(json_valid(review) AND json_type(review)='object'),
  PRIMARY KEY(automation_id,digest)
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_pending_skill_events (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  event_sequence INTEGER NOT NULL REFERENCES task_log(event_sequence),
  PRIMARY KEY(automation_id,event_sequence)
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_secrets (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id),
  hook_token TEXT NOT NULL CHECK(length(hook_token)=43 AND hook_token NOT GLOB '*[^A-Za-z0-9_-]*')
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_destinations (
  project_task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  PRIMARY KEY(project_task_id,name)
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_destination_secrets (
  project_task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  restore_id TEXT NOT NULL,
  url TEXT NOT NULL,
  header TEXT CHECK(header IS NULL OR json_valid(header)),
  signing_key TEXT NOT NULL,
  PRIMARY KEY(project_task_id,name),
  FOREIGN KEY(project_task_id,name) REFERENCES automation_destinations(project_task_id,name)
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_changes (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  revision INTEGER NOT NULL CHECK(revision>0),
  previous_revision INTEGER CHECK(previous_revision=revision-1),
  kind TEXT NOT NULL CHECK(kind IN ('created','saved','enabled','disabled','restored','deleted','renamed','hook_created','hook_rotated','hook_deleted')),
  actor TEXT NOT NULL CHECK(actor IN ('human','coordinator','system','automation')),
  digest TEXT NOT NULL,
  acknowledgement TEXT CHECK(acknowledgement IS NULL OR json_valid(acknowledgement)),
  message_id TEXT REFERENCES requests(id),
  badge_match TEXT CHECK(badge_match IN ('match','mismatch','no_badge')),
  at TEXT NOT NULL,
  CHECK((kind='created' AND revision=1 AND previous_revision IS NULL) OR (kind<>'created' AND revision>1 AND previous_revision IS NOT NULL)),
  CHECK((message_id IS NULL)=(badge_match IS NULL)),
  FOREIGN KEY(automation_id,digest) REFERENCES automation_versions(automation_id,digest),
  PRIMARY KEY(automation_id,revision)
) STRICT;
--> statement-breakpoint
CREATE INDEX automation_change_version ON automation_changes(automation_id,digest,revision) WHERE kind IN ('created','saved');
--> statement-breakpoint
CREATE INDEX automation_change_message ON automation_changes(message_id) WHERE message_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE automation_runs (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  number INTEGER NOT NULL CHECK(number>0),
  digest TEXT NOT NULL,
  activation_revision INTEGER,
  activation_epoch INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL CHECK(mode IN ('live','trial')),
  trigger_kind TEXT NOT NULL,
  trigger_ref TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('waiting','running','skipped','done','failed','stopped')),
  phase TEXT CHECK(phase IN ('trigger','run','stopping')),
  at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1 CHECK(count>0),
  folded_matches TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(folded_matches)),
  expires_at TEXT,
  started_at TEXT,
  phase_started_at TEXT,
  run_started_at TEXT,
  finished_at TEXT,
  reason_kind TEXT,
  reason TEXT,
  trigger_result TEXT CHECK(trigger_result IS NULL OR json_valid(trigger_result)),
  summary TEXT,
  notify INTEGER NOT NULL DEFAULT 0 CHECK(notify IN (0,1)),
  error TEXT CHECK(error IS NULL OR json_valid(error)),
  failed_phase TEXT CHECK(failed_phase IN ('trigger','run')),
  resolved_at TEXT,
  skip_day TEXT,
  attempt TEXT CHECK(attempt IS NULL OR json_valid(attempt)),
  PRIMARY KEY(automation_id,number),
  FOREIGN KEY(automation_id,digest) REFERENCES automation_versions(automation_id,digest),
  CHECK(state='running' OR phase IS NULL),
  CHECK((state IN ('waiting','running'))=(finished_at IS NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX automation_run_timeline ON automation_runs(at DESC,automation_id,number DESC);
--> statement-breakpoint
CREATE INDEX automation_run_owner_timeline ON automation_runs(automation_id,at DESC,number DESC);
--> statement-breakpoint
CREATE INDEX automation_run_recent ON automation_runs(automation_id,last_at) WHERE mode='live';
--> statement-breakpoint
CREATE UNIQUE INDEX automation_waiting_signal ON automation_runs(automation_id) WHERE state='waiting';
--> statement-breakpoint
CREATE INDEX automation_live_start ON automation_runs(automation_id,run_started_at) WHERE mode='live' AND run_started_at IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX automation_daily_skip ON automation_runs(automation_id,skip_day,reason_kind) WHERE skip_day IS NOT NULL;
--> statement-breakpoint
CREATE TABLE automation_run_data (
  automation_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  event TEXT CHECK(event IS NULL OR json_valid(event)),
  report TEXT,
  output TEXT CHECK(output IS NULL OR json_valid(output)),
  saved_at TEXT NOT NULL,
  PRIMARY KEY(automation_id,run_number),
  FOREIGN KEY(automation_id,run_number) REFERENCES automation_runs(automation_id,number) ON DELETE CASCADE
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_signal_items (
  automation_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  item TEXT NOT NULL CHECK(json_valid(item)),
  PRIMARY KEY(automation_id,run_number,sequence),
  FOREIGN KEY(automation_id,run_number) REFERENCES automation_runs(automation_id,number) ON DELETE CASCADE
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_signal_receipts (
  automation_id TEXT NOT NULL REFERENCES automations(id),
  key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','coalesced','skipped')),
  reason_kind TEXT,
  settled_at TEXT,
  PRIMARY KEY(automation_id,key)
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_previews (
  id TEXT PRIMARY KEY,
  project_task_id TEXT NOT NULL REFERENCES tasks(id),
  automation_id TEXT REFERENCES automations(id),
  digest TEXT NOT NULL,
  event TEXT NOT NULL CHECK(json_valid(event)),
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  attempt TEXT CHECK(attempt IS NULL OR json_valid(attempt)),
  at TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX automation_recent_preview ON automation_previews(automation_id,digest,at DESC);
--> statement-breakpoint
CREATE TABLE automation_operations (
  id TEXT PRIMARY KEY,
  project_task_id TEXT NOT NULL REFERENCES tasks(id),
  automation_id TEXT REFERENCES automations(id),
  run_number INTEGER,
  preview_id TEXT,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  at TEXT NOT NULL,
  local_day TEXT NOT NULL,
  workspace_day TEXT NOT NULL,
  target TEXT CHECK(target IS NULL OR json_valid(target)),
  outcome TEXT NOT NULL CHECK(outcome IN ('running','done','failed')),
  code TEXT,
  requested_task_id TEXT,
  request_id TEXT,
  urgent INTEGER NOT NULL DEFAULT 0 CHECK(urgent IN (0,1)),
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  call_id TEXT,
  trial INTEGER NOT NULL DEFAULT 0 CHECK(trial IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_operation_data (
  operation_id TEXT PRIMARY KEY REFERENCES automation_operations(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
--> statement-breakpoint
CREATE INDEX automation_operations_run ON automation_operations(automation_id,run_number,ordinal);
--> statement-breakpoint
CREATE INDEX automation_operations_preview ON automation_operations(preview_id,ordinal);
--> statement-breakpoint
CREATE INDEX automation_ai_day ON automation_operations(workspace_day,project_task_id) WHERE name='ai.ask';
--> statement-breakpoint
CREATE INDEX automation_urgent_requests ON automation_operations(request_id) WHERE urgent=1;
--> statement-breakpoint
CREATE TABLE automation_task_inputs (
  task_id TEXT PRIMARY KEY REFERENCES tasks(external_id),
  data TEXT NOT NULL CHECK(json_valid(data)),
  saved_at TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE automation_save_requests (
  op_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  automation_id TEXT NOT NULL REFERENCES automations(id),
  digest TEXT NOT NULL,
  FOREIGN KEY(automation_id,digest) REFERENCES automation_versions(automation_id,digest)
) STRICT;
