# Synthetic error-cause fixtures

These JSON and JSONL inputs are fictional protocol examples. All session, thread, input and request identities, paths, timestamps, reset dates, usage and costs are fixed synthetic values. No saved Run output is included.

- `codex-stdout.jsonl`: a thread and input followed by a model-capacity error and failed turn.
- `codex-events.json`: a compact-task error and failed turn without a thread witness. Tests add a synthetic thread/turn prefix to test attribution; without that witness the cause must remain unclassified.
- `claude-stdout.jsonl`: an API-error assistant and an `is_error: true` result. Its `subtype: success` deliberately conflicts with the error flag.

The capacity wording and weekly-limit prefix are provider protocol signatures required by the classifier. The negative and lifecycle variants in `run-error-cause.test.ts` exercise control projections and HTTP task views without launching agents.
