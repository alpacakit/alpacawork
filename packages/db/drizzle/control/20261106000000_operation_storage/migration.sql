-- Refuse conflicting historical envelopes rather than choosing one of two writable facts.
-- A temporary assertion belongs to this transaction only; it is not a persistent ledger.
CREATE TEMP TABLE command_storage_check (valid INTEGER NOT NULL CHECK(valid=1));
--> statement-breakpoint
INSERT INTO command_storage_check
SELECT NOT EXISTS (
 SELECT 1 FROM run_commands c LEFT JOIN run_attempts a USING(attempt_id)
 WHERE a.attempt_id IS NULL
   OR json_type(c.json) IS NOT 'object'
   OR (SELECT count(*) FROM json_each(c.json))<>12
   OR (SELECT count(DISTINCT key) FROM json_each(c.json))<>12
   OR EXISTS (SELECT 1 FROM json_each(c.json) WHERE key NOT IN
     ('protocol','workspaceId','runId','attemptId','seq','commandId','type','inputId','instructionRunId','operationId','text','contentDigest'))
   -- json_extract(true) is SQL integer 1. Validate JSON types before comparing values.
   OR EXISTS (SELECT 1 FROM json_each(c.json)
     WHERE (key IN ('protocol','seq') AND type NOT IN ('integer','real'))
       OR (key IN ('workspaceId','runId','attemptId','commandId','type') AND type<>'text')
       OR (key IN ('inputId','instructionRunId','operationId','text','contentDigest') AND type NOT IN ('text','null')))
   -- Only projected identity fields are constrained: unrelated launch fields may evolve.
   -- SQL selects the first duplicate key but JSON.parse selects the last; require one of each.
   OR json_type(a.launch_json) IS NOT 'object'
   OR EXISTS (SELECT 1 FROM json_each('["protocol","workspaceId","runId","attemptId"]') required
     WHERE (SELECT count(*) FROM json_each(a.launch_json) member WHERE member.key=required.value)<>1)
   OR EXISTS (SELECT 1 FROM json_each(a.launch_json)
     WHERE (key='protocol' AND type NOT IN ('integer','real'))
       OR (key IN ('workspaceId','runId','attemptId') AND type<>'text'))
   OR json_extract(c.json,'$.protocol') IS NOT 1
   OR json_extract(c.json,'$.attemptId') IS NOT c.attempt_id
   OR json_extract(a.launch_json,'$.attemptId') IS NOT c.attempt_id
   OR json_extract(c.json,'$.runId') IS NOT 'R'||a.run_no
   OR json_extract(a.launch_json,'$.runId') IS NOT 'R'||a.run_no
   OR json_extract(c.json,'$.protocol') IS NOT json_extract(a.launch_json,'$.protocol')
   OR json_extract(c.json,'$.workspaceId') IS NOT json_extract(a.launch_json,'$.workspaceId')
   OR json_extract(c.json,'$.seq') IS NOT c.seq
   OR json_extract(c.json,'$.commandId') IS NOT c.command_id
   OR json_extract(c.json,'$.type') IS NOT c.type
   OR json_extract(c.json,'$.inputId') IS NOT c.input_id
   OR json_extract(c.json,'$.instructionRunId') IS NOT CASE WHEN c.instruction_run_no IS NULL THEN NULL ELSE 'R'||c.instruction_run_no END
   OR json_extract(c.json,'$.operationId') IS NOT c.operation_id
);
--> statement-breakpoint
CREATE TABLE run_commands_new (
 attempt_id TEXT NOT NULL REFERENCES run_attempts(attempt_id), seq INTEGER NOT NULL CHECK(seq>0), command_id TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('input','cancel-input','stop')), input_id TEXT, instruction_run_no INTEGER REFERENCES runs(id),
 operation_id TEXT, text TEXT, content_digest TEXT, published INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(attempt_id,seq)
) STRICT;
--> statement-breakpoint
-- Keep the saved digest exactly. Computing a replacement would silently repair bad evidence.
INSERT INTO run_commands_new(attempt_id,seq,command_id,type,input_id,instruction_run_no,operation_id,text,content_digest,published)
 SELECT attempt_id,seq,command_id,type,input_id,instruction_run_no,operation_id,
   json_extract(json,'$.text'),json_extract(json,'$.contentDigest'),published FROM run_commands;
--> statement-breakpoint
DROP TABLE run_commands;
--> statement-breakpoint
ALTER TABLE run_commands_new RENAME TO run_commands;
--> statement-breakpoint
CREATE INDEX run_commands_unpublished ON run_commands(type) WHERE published=0;
--> statement-breakpoint
DROP TABLE command_storage_check;
--> statement-breakpoint
-- Only the known Task write envelope paths change; all other snapshot fields survive.
UPDATE cli_operations SET response_json=json_remove(response_json,'$.task.log')
 WHERE (operation GLOB 'task/*' OR operation GLOB 'agent/*' OR operation GLOB 'dependency/*')
   AND json_type(response_json,'$.task')='object' AND json_type(response_json,'$.task.log') IS NOT NULL;
--> statement-breakpoint
-- Early task/comment receipts included the whole tree, outside the current write contract.
UPDATE cli_operations SET response_json=json_remove(response_json,'$.tree')
 WHERE operation='task/comment' AND json_type(response_json,'$.tree')='object';
--> statement-breakpoint
UPDATE cli_operations SET response_json=json_set(response_json,'$.tasks',json((
 SELECT json_group_array(json_remove(value,'$.log') ORDER BY key) FROM json_each(response_json,'$.tasks')
))) WHERE operation GLOB 'task/*' AND json_type(response_json,'$.tasks')='array'
 AND EXISTS (SELECT 1 FROM json_each(response_json,'$.tasks')
   WHERE json_type(CASE WHEN type='object' THEN value ELSE '{}' END,'$.log') IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM json_each(response_json,'$.tasks') WHERE type<>'object');
--> statement-breakpoint
CREATE INDEX task_log_questions ON task_log(task_id,json_extract(entry,'$.askedTo')) WHERE json_extract(entry,'$.kind')='asked';
