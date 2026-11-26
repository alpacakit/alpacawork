ALTER TABLE task_value_versions ADD COLUMN change_log_id TEXT REFERENCES task_log(id);
--> statement-breakpoint
CREATE INDEX task_value_versions_change ON task_value_versions(change_log_id) WHERE change_log_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX task_value_versions_order ON task_value_versions(task_id, field_id, id);
--> statement-breakpoint
ALTER TABLE requests ADD COLUMN reason TEXT CHECK(reason IS NULL OR
  (task_id IS NOT NULL AND purpose <> 'return_continuation' AND json_type(reason) = 'object'));
--> statement-breakpoint
UPDATE requests AS q SET reason=json_object('taken',json_object(
  'code',json_extract(l.entry,'$.label.kind'),
  'cause',CASE WHEN json_extract(l.entry,'$.label.kind')<>'fix' THEN NULL
    WHEN EXISTS (SELECT 1 FROM json_each(l.entry,'$.label.fixes') WHERE value='intent') THEN 'misread' ELSE 'other' END,
  'aspects',json(COALESCE((SELECT json_group_array(CASE value WHEN 'review_flow' THEN 'presentation' ELSE value END)
    FROM json_each(l.entry,'$.label.fixes') WHERE value NOT IN ('intent','other')), '[]')),
  'of',(SELECT prior.id FROM requests current
        JOIN requests prior ON prior.placement_id=current.placement_id AND prior.task_id=current.task_id
        JOIN runs r ON r.request_id=prior.id
        LEFT JOIN returns result ON result.request_id=prior.id
        WHERE current.id=json_extract(l.entry,'$.label.request') AND prior.purpose IN ('instruction','review_send_back')
          AND prior.answers_question IS NULL AND prior.submitted_at<current.submitted_at
          AND (CASE WHEN json_extract(current.author,'$.kind')='placement'
            THEN json_extract(prior.author,'$.placementId')=json_extract(current.author,'$.placementId')
            ELSE json_extract(prior.author,'$.kind') IN ('main','human') END)
          AND COALESCE(result.created_at,json_extract(r.record,'$.ended_at'))<=current.submitted_at
          AND (result.outcome IN ('succeeded','needs_review') OR result.id IS NULL AND r.state IN ('succeeded','needs_review'))
        ORDER BY prior.submitted_at DESC,r.id DESC LIMIT 1)))
FROM task_log AS l
WHERE l.kind='request_labeled' AND q.id=json_extract(l.entry,'$.label.request');
--> statement-breakpoint
UPDATE requests SET reason=json_set(reason,'$.taken.note','migrated')
WHERE json_extract(reason,'$.taken.cause')='other';
--> statement-breakpoint
SELECT alpacawork_data_migration('action-reasons-v1');
--> statement-breakpoint
DROP TRIGGER task_log_delete;
--> statement-breakpoint
DELETE FROM task_log WHERE kind='request_labeled';
--> statement-breakpoint
CREATE TRIGGER task_log_delete BEFORE DELETE ON task_log
BEGIN SELECT RAISE(ABORT,'task log is immutable'); END;
--> statement-breakpoint
DROP TRIGGER requests_immutable;
--> statement-breakpoint
CREATE TRIGGER requests_immutable BEFORE UPDATE ON requests WHEN
  NEW.id IS NOT OLD.id OR NEW.task_id IS NOT OLD.task_id OR NEW.placement_id IS NOT OLD.placement_id
  OR NEW.placement_revision IS NOT OLD.placement_revision OR NEW.task_hash IS NOT OLD.task_hash
  OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.wait_cycle_id IS NOT OLD.wait_cycle_id
  OR NEW.reply_to IS NOT OLD.reply_to OR NEW.head_run_id IS NOT OLD.head_run_id OR NEW.mode IS NOT OLD.mode OR NEW.body IS NOT OLD.body
  OR NEW.answers_question IS NOT OLD.answers_question
  OR NEW.about_run_id IS NOT OLD.about_run_id OR NEW.purpose IS NOT OLD.purpose OR NEW.author IS NOT OLD.author OR NEW.submitted_at IS NOT OLD.submitted_at
  OR NEW.reason IS NOT OLD.reason
BEGIN SELECT RAISE(ABORT,'request ownership is immutable'); END;
--> statement-breakpoint
UPDATE tasks SET analysis_subject=json_set(analysis_subject,'$.key',
  CASE json_extract(analysis_subject,'$.key') WHEN 'intent' THEN 'misread' ELSE 'presentation' END)
WHERE json_extract(analysis_subject,'$.kind')='cause'
  AND json_extract(analysis_subject,'$.key') IN ('intent','review_flow');
