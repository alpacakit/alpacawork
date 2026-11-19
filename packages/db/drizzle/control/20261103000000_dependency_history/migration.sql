-- The persisted Task log contract now includes dependencies_changed. Its history identity
-- prevents an older reader from being selected even though the SQL table shape is unchanged.
-- Only the legacy dependency command wrote exactly these eight fields with an L+UUIDv4 ID.
-- Normal comment/report commands always include operationFingerprint (even with an L-prefixed op ID).
-- History is immutable during normal operation; restore its exact guard in this same migration transaction.
DROP TRIGGER task_log_update;
--> statement-breakpoint
WITH command_records AS (
  SELECT l.id, l.entry, json_extract(l.entry,'$.title') AS title,
    json_extract(l.entry,'$.description') AS description
  FROM task_log l
  WHERE l.kind='reported' AND l.request_id IS NULL
    AND json_type(l.entry,'$.fromState')='null' AND json_type(l.entry,'$.toState')='null'
    AND json_extract(l.entry,'$.title') IN ('Dependencies set','Dependencies cleared')
    AND json_type(l.entry,'$.description')='text'
    AND json_extract(l.entry,'$.actor.kind') IN ('human','main','placement')
    AND NOT EXISTS (SELECT 1 FROM json_each(l.entry)
      WHERE key NOT IN ('id','kind','at','title','description','actor','fromState','toState'))
    AND NOT EXISTS (SELECT 1 FROM requests WHERE id=l.id)
    AND length(l.id)=37 AND substr(l.id,1,1)='L'
    AND substr(l.id,10,1)='-' AND substr(l.id,15,1)='-'
    AND substr(l.id,20,1)='-' AND substr(l.id,25,1)='-'
    AND length(replace(substr(l.id,2),'-',''))=32
    AND replace(substr(l.id,2),'-','') NOT GLOB '*[^0-9a-f]*'
    AND substr(l.id,16,1)='4' AND substr(l.id,21,1) IN ('8','9','a','b')
), lines AS (
  SELECT *, substr(description,8,instr(description,char(10))-8) AS after_text,
    substr(description,instr(description,char(10))+13) AS previous_text
  FROM command_records
), arrays AS (
  -- Quote the original text before splitting its literal comma-space separators.
  -- Quotes and backslash escapes in that text are data, never JSON syntax.
  SELECT *, CASE WHEN after_text='(none)' THEN '[]' ELSE '['||replace(json_quote(after_text),', ','","')||']' END AS after_ids,
    CASE WHEN previous_text='(none)' THEN '[]' ELSE '['||replace(json_quote(previous_text),', ','","')||']' END AS previous_ids
  FROM lines
), selected AS (
  SELECT * FROM arrays
  WHERE json_type(after_ids)='array' AND json_type(previous_ids)='array'
    AND ((title='Dependencies set' AND json_array_length(after_ids)>0)
      OR (title='Dependencies cleared' AND json_array_length(after_ids)=0 AND json_array_length(previous_ids)>0))
    AND NOT EXISTS (
      SELECT 1 FROM (SELECT value,type FROM json_each(after_ids) UNION ALL SELECT value,type FROM json_each(previous_ids))
      WHERE type<>'text' OR length(value) NOT BETWEEN 2 AND 10
        OR substr(value,1,1)<>'T' OR substr(value,2,1) NOT BETWEEN '1' AND '9'
        OR substr(value,2) GLOB '*[^0-9]*')
    AND (SELECT count(*) FROM json_each(after_ids))=(SELECT count(DISTINCT value) FROM json_each(after_ids))
    AND (SELECT count(*) FROM json_each(previous_ids))=(SELECT count(DISTINCT value) FROM json_each(previous_ids))
    -- Only the exact spelling the old command could write is certified.
    AND description='After: '||CASE WHEN json_array_length(after_ids)=0 THEN '(none)'
      ELSE (SELECT group_concat(value,', ' ORDER BY key) FROM json_each(after_ids)) END
      ||char(10)||'Previously: '||CASE WHEN json_array_length(previous_ids)=0 THEN '(none)'
      ELSE (SELECT group_concat(value,', ' ORDER BY key) FROM json_each(previous_ids)) END
)
UPDATE task_log SET entry=(
  SELECT json_set(selected.entry,'$.kind','dependencies_changed','$.title',NULL,'$.description',NULL,
    '$.dependencies',json_object('after',json(after_ids),'previous',json(previous_ids)))
  FROM selected WHERE selected.id=task_log.id
) WHERE id IN (SELECT id FROM selected);

--> statement-breakpoint
CREATE TRIGGER task_log_update BEFORE UPDATE ON task_log BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
