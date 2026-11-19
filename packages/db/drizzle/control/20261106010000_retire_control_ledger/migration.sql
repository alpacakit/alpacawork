-- Only this one-time transition reads the retired ledger. Never discard unknown facts.
CREATE TEMP TABLE retired_control_ledger_check (empty INTEGER NOT NULL CHECK(empty=1));
--> statement-breakpoint
INSERT INTO retired_control_ledger_check SELECT NOT EXISTS (SELECT 1 FROM control_schema_migrations);
--> statement-breakpoint
DROP TABLE control_schema_migrations;
--> statement-breakpoint
DROP TABLE retired_control_ledger_check;
