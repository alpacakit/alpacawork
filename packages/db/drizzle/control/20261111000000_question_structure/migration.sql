-- A question is fixed as what it asks (the asking record's `decide` items), not as a text beside its record: the
-- screen draws its choices from the items and an agent reads them as text. A question asked before this keeps all of
-- its words as one item: its title as what to decide and its whole fixed text as the note. Only these records change
-- and only these texts go, so the guards that keep both immutable are lifted for these statements and put back
-- exactly as they were.
DROP TRIGGER task_log_update;
--> statement-breakpoint
UPDATE task_log SET entry = json_set(entry, '$.decide', json_array(json_object(
  'decide_question', COALESCE(json_extract(entry, '$.title'), ''),
  'decide_note', COALESCE((SELECT text FROM log_texts WHERE log_id = task_log.id), ''))))
  WHERE kind = 'asked';
--> statement-breakpoint
CREATE TRIGGER task_log_update BEFORE UPDATE ON task_log BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
--> statement-breakpoint
DROP TRIGGER log_texts_delete;
--> statement-breakpoint
DELETE FROM log_texts WHERE log_id IN (SELECT id FROM task_log WHERE kind = 'asked');
--> statement-breakpoint
CREATE TRIGGER log_texts_delete BEFORE DELETE ON log_texts BEGIN SELECT RAISE(ABORT,'log text is immutable'); END;
--> statement-breakpoint
DROP TRIGGER log_texts_insert;
--> statement-breakpoint
CREATE TRIGGER log_texts_insert BEFORE INSERT ON log_texts BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM task_log WHERE id = NEW.log_id AND kind = 'answered')
    THEN RAISE(ABORT,'only an answer keeps its text') END;
END;
