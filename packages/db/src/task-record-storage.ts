/** Coordinator receipts find instruction authors at their canonical Request, without scanning all Task history. */
export const REQUEST_MESSAGE_INDEX = `CREATE INDEX requests_message ON requests(json_extract(author,'$.message'))
  WHERE json_extract(author,'$.message') IS NOT NULL;`;
export const TASK_LOG_TABLE = `CREATE TABLE task_log (
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
) STRICT;`;
export const TASK_REQUEST_REFERENCE_TRIGGER = `CREATE TRIGGER task_request_reference BEFORE INSERT ON task_log
WHEN NEW.request_id IS NOT NULL BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM requests q JOIN tasks t ON t.external_id=q.task_id
    WHERE q.id=NEW.request_id AND t.id=NEW.task_id AND q.purpose <> 'return_continuation')
    THEN RAISE(ABORT,'request reference must belong to the same Task and an explicit instruction') END;
END;`;
