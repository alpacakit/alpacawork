ALTER TABLE tasks ADD COLUMN analysis_subject TEXT
  CHECK(analysis_subject IS NULL OR (kind = 'task' AND json_type(analysis_subject) = 'object'));
