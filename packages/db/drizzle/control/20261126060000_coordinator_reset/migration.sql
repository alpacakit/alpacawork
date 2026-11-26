ALTER TABLE coordinator_conversations ADD COLUMN memo_text TEXT;
--> statement-breakpoint
ALTER TABLE coordinator_conversations ADD COLUMN memo_updated_at TEXT;
--> statement-breakpoint
ALTER TABLE coordinator_conversations ADD COLUMN memo_through_turn_no INTEGER;
--> statement-breakpoint
ALTER TABLE coordinator_conversations ADD COLUMN visible_turns INTEGER NOT NULL DEFAULT 0 CHECK(visible_turns >= 0);
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN coordinator_turn_no INTEGER CHECK(coordinator_turn_no IS NULL OR (coordinator_turn_no > 0 AND conversation_id IS NOT NULL));
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN coordinator_input TEXT CHECK(coordinator_input IS NULL OR json_valid(coordinator_input));
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN coordinator_files_expired_at TEXT;
--> statement-breakpoint
WITH turns AS (
  SELECT q.id, row_number() OVER (PARTITION BY q.conversation_id ORDER BY r.id) AS turn_no
  FROM requests q JOIN runs r ON r.request_id=q.id AND r.attempt=0
  JOIN coordinator_conversations c ON c.id=q.conversation_id
  WHERE c.warm_request_id IS NOT q.id
)
UPDATE requests SET coordinator_turn_no=turns.turn_no FROM turns WHERE requests.id=turns.id;
--> statement-breakpoint
UPDATE runs SET record=json_remove(record,'$.restartArgv')
  WHERE conversation_id IS NOT NULL AND json_type(record,'$.restartArgv') IS NOT NULL;
--> statement-breakpoint
ALTER TABLE coordinator_conversations DROP COLUMN warm_request_id;
--> statement-breakpoint
CREATE UNIQUE INDEX coordinator_request_turn_no ON requests(conversation_id,coordinator_turn_no)
  WHERE coordinator_turn_no IS NOT NULL;
--> statement-breakpoint
UPDATE coordinator_conversations SET visible_turns=(
  SELECT count(*) FROM requests q WHERE q.conversation_id=coordinator_conversations.id
    AND q.coordinator_turn_no IS NOT NULL AND q.delivery_state <> 'aborted'
);
--> statement-breakpoint
CREATE TRIGGER coordinator_turn_insert AFTER INSERT ON requests
  WHEN NEW.coordinator_turn_no IS NOT NULL AND NEW.delivery_state <> 'aborted' BEGIN
    UPDATE coordinator_conversations SET visible_turns=visible_turns+1 WHERE id=NEW.conversation_id;
END;
--> statement-breakpoint
CREATE TRIGGER coordinator_turn_delivery AFTER UPDATE OF delivery_state ON requests
  WHEN NEW.coordinator_turn_no IS NOT NULL AND (NEW.delivery_state='aborted') <> (OLD.delivery_state='aborted') BEGIN
    UPDATE coordinator_conversations SET visible_turns=visible_turns+CASE WHEN NEW.delivery_state='aborted' THEN -1 ELSE 1 END
      WHERE id=NEW.conversation_id;
END;
--> statement-breakpoint
CREATE TRIGGER coordinator_turn_delete AFTER DELETE ON requests
  WHEN OLD.coordinator_turn_no IS NOT NULL AND OLD.delivery_state <> 'aborted' BEGIN
    UPDATE coordinator_conversations SET visible_turns=visible_turns-1 WHERE id=OLD.conversation_id;
END;
--> statement-breakpoint
CREATE TABLE coordinator_resets (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES coordinator_conversations(id),
  reason TEXT NOT NULL CHECK(json_valid(reason)), requested_at TEXT NOT NULL,
  before_request_id TEXT REFERENCES requests(id), start_run_no INTEGER REFERENCES runs(id),
  memo_text TEXT, memo_updated_at TEXT,
  CHECK((start_run_no IS NULL) = (before_request_id IS NULL))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX coordinator_pending_reset ON coordinator_resets(conversation_id) WHERE start_run_no IS NULL;
--> statement-breakpoint
CREATE INDEX coordinator_started_reset ON coordinator_resets(conversation_id,start_run_no) WHERE start_run_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX coordinator_reset_before ON coordinator_resets(before_request_id) WHERE before_request_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE coordinator_reset_ops (
  id TEXT PRIMARY KEY, reset_id TEXT NOT NULL REFERENCES coordinator_resets(id)
) STRICT;
--> statement-breakpoint
CREATE INDEX coordinator_active_runs ON runs(conversation_id,id)
  WHERE conversation_id IS NOT NULL AND state IN ('queued','running','needs_review');
--> statement-breakpoint
CREATE INDEX coordinator_rate_limit_runs ON runs(conversation_id,
  coalesce(unixepoch(json_extract(record,'$.availability.resetsAt'),'subsec'),unixepoch(json_extract(record,'$.ended_at'),'subsec')+3600))
  WHERE conversation_id IS NOT NULL AND state='failed' AND json_extract(record,'$.availability') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX coordinator_successful_runs ON runs(conversation_id,unixepoch(json_extract(record,'$.started_at'),'subsec'))
  WHERE conversation_id IS NOT NULL AND state='succeeded';
--> statement-breakpoint
CREATE INDEX coordinator_retry_runs ON runs(conversation_id,json_extract(record,'$.message.retryOf'))
  WHERE conversation_id IS NOT NULL AND json_extract(record,'$.message.retryOf') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX coordinator_delivery_diagnostics ON run_attempts(run_no) WHERE diagnostic IS NOT NULL;
--> statement-breakpoint
CREATE INDEX coordinator_delivery_inputs ON run_inputs(attempt_id) WHERE state IN ('reserved','attempted','uncertain');
