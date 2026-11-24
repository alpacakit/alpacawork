-- A grant belongs to the parent's Request. An instruction using it retains its caller and sender's original wait cycle.
ALTER TABLE requests ADD COLUMN lent_task_id TEXT REFERENCES tasks(external_id);
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN loan_request_id TEXT REFERENCES requests(id);
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN loan_ended_at TEXT CHECK(loan_ended_at IS NULL OR lent_task_id IS NOT NULL);
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN return_task_id TEXT REFERENCES tasks(external_id) CHECK(return_task_id IS NULL OR loan_request_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX requests_open_loans ON requests(task_id,lent_task_id) WHERE lent_task_id IS NOT NULL AND loan_ended_at IS NULL;
--> statement-breakpoint
CREATE INDEX requests_loan_uses ON requests(loan_request_id) WHERE loan_request_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX requests_borrowed_targets ON requests(task_id) WHERE loan_request_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX requests_loan_returns ON requests(return_task_id) WHERE return_task_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX returns_notice;
--> statement-breakpoint
CREATE UNIQUE INDEX returns_notice ON returns(cause_log_id,outcome,to_task_id) WHERE request_id IS NULL;
--> statement-breakpoint
CREATE TRIGGER request_loan_insert BEFORE INSERT ON requests
WHEN NEW.lent_task_id IS NOT NULL OR NEW.loan_request_id IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.wait_cycle_id IS NULL OR NEW.purpose <> 'instruction'
    OR NEW.lent_task_id IS NOT NULL AND NEW.loan_request_id IS NOT NULL
    THEN RAISE(ABORT,'a loan grants an owner instruction without sublending') END;
  SELECT CASE WHEN NEW.loan_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM requests loan JOIN wait_cycles sender ON sender.id=NEW.wait_cycle_id
    WHERE loan.id=NEW.loan_request_id AND loan.task_id=sender.task_id
      AND loan.lent_task_id=NEW.task_id AND loan.loan_ended_at IS NULL)
    THEN RAISE(ABORT,'instruction does not match its active loan') END;
END;
--> statement-breakpoint
CREATE TRIGGER request_loan_update BEFORE UPDATE OF lent_task_id,loan_request_id,loan_ended_at,return_task_id ON requests BEGIN
  SELECT CASE WHEN NEW.lent_task_id IS NOT OLD.lent_task_id OR NEW.loan_request_id IS NOT OLD.loan_request_id
    OR OLD.loan_ended_at IS NOT NULL AND NEW.loan_ended_at IS NOT OLD.loan_ended_at
    OR OLD.return_task_id IS NOT NULL AND NEW.return_task_id IS NOT OLD.return_task_id
    THEN RAISE(ABORT,'request loan origin and handback are immutable') END;
  SELECT CASE WHEN NEW.return_task_id IS NOT NULL AND NEW.return_task_id IS NOT (
    SELECT parent.task_id FROM requests loan JOIN wait_cycles parent ON parent.id=loan.wait_cycle_id
    WHERE loan.id=NEW.loan_request_id AND loan.loan_ended_at IS NOT NULL)
    THEN RAISE(ABORT,'loan handback must go to its lender') END;
END;
--> statement-breakpoint
DROP TRIGGER returns_insert;
--> statement-breakpoint
CREATE TRIGGER returns_insert BEFORE INSERT ON returns BEGIN
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM requests WHERE id = NEW.request_id AND task_id IS NOT NULL AND wait_cycle_id IS NOT NULL)
    THEN RAISE(ABORT,'return closes no placement request') END;
  SELECT CASE WHEN NEW.request_id IS NOT NULL AND NEW.to_task_id IS NOT
    (SELECT coalesce(q.return_task_id,c.task_id) FROM requests q JOIN wait_cycles c ON c.id=q.wait_cycle_id WHERE q.id=NEW.request_id)
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
CREATE TRIGGER return_loan_update BEFORE UPDATE OF to_task_id ON returns WHEN NEW.to_task_id IS NOT OLD.to_task_id BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests WHERE id=OLD.request_id AND return_task_id=NEW.to_task_id)
    OR EXISTS (SELECT 1 FROM return_deliveries WHERE return_id=OLD.id AND released_at IS NULL)
    OR EXISTS (SELECT 1 FROM return_resolutions WHERE return_id=OLD.id)
    THEN RAISE(ABORT,'only an unprocessed loan result may move to the lender') END;
END;
