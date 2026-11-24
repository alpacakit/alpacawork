-- Compacting a conversation before a Run's instruction (task request --compact, task report --next-conversation compact).
CREATE TABLE compactions (
  id TEXT PRIMARY KEY, run_no INTEGER NOT NULL UNIQUE REFERENCES runs(id),
  placement_id TEXT NOT NULL REFERENCES placements(id), focus TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','sent','compacted','failed','unknown','dropped')),
  attempt_id TEXT REFERENCES run_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED, message TEXT, requested_at TEXT NOT NULL, ended_at TEXT,
  CHECK(CASE state WHEN 'pending' THEN attempt_id IS NULL AND ended_at IS NULL
    WHEN 'sent' THEN attempt_id IS NOT NULL AND ended_at IS NULL WHEN 'dropped' THEN ended_at IS NOT NULL
    ELSE attempt_id IS NOT NULL AND ended_at IS NOT NULL END)
) STRICT;
--> statement-breakpoint
CREATE INDEX compactions_placement ON compactions(placement_id);
--> statement-breakpoint
CREATE INDEX compactions_attempt ON compactions(attempt_id) WHERE attempt_id IS NOT NULL;
