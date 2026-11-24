-- A request to compact a placement's conversation, carried by that conversation's next start (see agent compact).
CREATE TABLE compactions (
  id TEXT PRIMARY KEY, placement_id TEXT NOT NULL REFERENCES placements(id), instructions TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','sent','compacted','failed','unknown','dropped')),
  attempt_id TEXT REFERENCES run_attempts(attempt_id) DEFERRABLE INITIALLY DEFERRED, message TEXT, requested_at TEXT NOT NULL, ended_at TEXT,
  CHECK(CASE state WHEN 'pending' THEN attempt_id IS NULL AND ended_at IS NULL
    WHEN 'sent' THEN attempt_id IS NOT NULL AND ended_at IS NULL WHEN 'dropped' THEN ended_at IS NOT NULL
    ELSE attempt_id IS NOT NULL AND ended_at IS NOT NULL END)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX compactions_pending ON compactions(placement_id) WHERE state = 'pending';
--> statement-breakpoint
CREATE INDEX compactions_attempt ON compactions(attempt_id) WHERE attempt_id IS NOT NULL;
