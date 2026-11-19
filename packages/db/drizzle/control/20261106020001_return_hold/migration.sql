-- Preserve every old short code exactly. A past code did not record detailed facts.
UPDATE returns SET hold_reason=json_object('code',hold_reason,'reason',NULL) WHERE hold_reason IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER returns_hold_insert BEFORE INSERT ON returns
WHEN NEW.hold_reason IS NOT NULL AND CASE WHEN json_valid(NEW.hold_reason) THEN
  json_type(NEW.hold_reason)<>'object' OR (SELECT count(*) FROM json_each(NEW.hold_reason))<>2 OR
  json_type(NEW.hold_reason,'$.code') IS NOT 'text' OR length(trim(json_extract(NEW.hold_reason,'$.code')))=0 OR
  json_type(NEW.hold_reason,'$.reason') IS NULL OR json_type(NEW.hold_reason,'$.reason') NOT IN ('object','null')
  ELSE 1 END
BEGIN SELECT RAISE(ABORT,'invalid return hold'); END;
--> statement-breakpoint
CREATE TRIGGER returns_hold_update BEFORE UPDATE OF hold_reason ON returns
WHEN NEW.hold_reason IS NOT NULL AND CASE WHEN json_valid(NEW.hold_reason) THEN
  json_type(NEW.hold_reason)<>'object' OR (SELECT count(*) FROM json_each(NEW.hold_reason))<>2 OR
  json_type(NEW.hold_reason,'$.code') IS NOT 'text' OR length(trim(json_extract(NEW.hold_reason,'$.code')))=0 OR
  json_type(NEW.hold_reason,'$.reason') IS NULL OR json_type(NEW.hold_reason,'$.reason') NOT IN ('object','null')
  ELSE 1 END
BEGIN SELECT RAISE(ABORT,'invalid return hold'); END;
