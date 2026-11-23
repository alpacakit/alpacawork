# Synthetic control contract fixtures

These JSON files use fictional test values for the current control tree, Run, placement, request, and review shapes. Their small sequential IDs, repeated hashes, generic task names, fixed timestamps, and example paths are synthetic seeds. They do not describe a live workspace.

The current public commands are `task get|list|new|update|returns|request|report|comment|move|archive|delete|restore`, `task file get|put`, `task attachment put|remove|move`, `agent assign|handover|release`, `run get|stop|stop-local`, `field get|set`, `field list|set|delete`, `config get|set`, `workspace returns|url`, and `operation get`; the server's own executable adds `workspace init|serve|maintenance`. `GET /api/workspace/folders` lists folders for the screen only and is no CLI command. The corresponding grouped HTTP paths are defined in `packages/contract/src/commands.ts`. Older entry names embedded in fixture filenames or JSON examples describe their original provenance and do not register CLI or HTTP aliases.

`read-preflight.json` records refusal to treat an incompatible control DB as writable. `tree.json` and `review.json` supply the stable display and review examples used by the Web tests. Current behavior is defined by the schemas in `@alpacawork/contract/control`, the grouped entry tree, and the tests that consume each fixture.

The current Request example uses purpose `instruction` and a fictional human author. Historical schema fixtures keep their legacy origin column to exercise the stored format.
