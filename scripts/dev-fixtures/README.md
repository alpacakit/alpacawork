# Shared synthetic development workspaces

These helpers create workspaces from fictional text, fixed timestamps, and ended, inert Runs without reading production data. They are separate from product code and existing test entry points. They require Node 24.16 or later, this checkout's dependencies, and built packages. Before first use, build the required packages and backend from the repository root in this checkout. Do not build while generating or serving fixtures in the same checkout.

Do not invoke `pnpm` in an isolated HOME. Even `pnpm install --offline` first fetches pnpm from the public registry if Corepack's cache lacks it. Build with the existing cache in the original HOME and pass `COREPACK_ENABLE_NETWORK=0` to child processes. On 2026-11-04, running `COREPACK_ENABLE_NETWORK=0 corepack install -g --cache-only pnpm@11.6.0` with an isolated HOME and empty `COREPACK_HOME` confirmed that the registry tarball fetch is refused when networking is disabled (pnpm itself never started).

## Create, use, and remove

Run from the repository root. Each command prints JSON.

```sh
# Create cached originals. Matching source, counts, and seed validate and reuse an existing original.
node scripts/dev-fixtures/fixture.ts create --profile small
node scripts/dev-fixtures/fixture.ts create --profile perf

# Customize counts: tasks includes project rows; logs is the total number of task_log rows.
node scripts/dev-fixtures/fixture.ts create --profile perf --tasks 1000 --logs 50000 --runs 20000 --seed trial-1

# Use the root printed above as source. The destination must not exist; its parent must exist.
node scripts/dev-fixtures/fixture.ts copy --source /absolute/cache/key --dest /tmp/my-fixture-run

# Serve a copy with the development backend. Use another terminal; stop with Ctrl-C.
node apps/backend/dist/backend.js --workspace /tmp/my-fixture-run workspace serve --port 0

# Home list time strips. This process holds the active Runs and ends after --hold-seconds.
# Serve the same root from another terminal.
node scripts/dev-fixtures/list-scene.ts --dest /tmp/my-list-scene --hold-seconds 1800

# A parent working row with activity below: child only; parent, children, and grandchild;
# no active Runs; parent only. Use it like list-scene.
node scripts/dev-fixtures/child-working-scene.ts --dest /tmp/my-child-scene --hold-seconds 1800

# Reports with diffs: this repository's previous commit vs HEAD (override with --base/--head);
# two document-only branches; no changed files; absolute code paths; and added/removed code and documents.
# The code-path sample registers git and worktree directories in config.yaml beside the fixture at <dest>-code,
# since application data is not read as code. Remove <dest>-code when removing the fixture.
# Diffs use the CLI's own processing. Serve the root after generation, as above.
node scripts/dev-fixtures/diff-scene.ts --dest /tmp/my-diff-scene

# The analysis at scale: user-requested Tasks finished over a long record, many ended Runs with usage, and Run
# outputs for the tally (a few of several MB). Defaults: 30000 Tasks, about 300000 Runs, 450 days up to now,
# outputs for 3% of the Runs and 12 of 4 MB. It writes the root directly (no cached original); remove it with rm -r
# after stopping its server. Serve it with a larger heap (--max-old-space-size) at the default sizes.
node scripts/dev-fixtures/analysis-scene.ts --dest /tmp/my-analysis-scene [--tasks N --runs N --days N --outputs FRACTION --large N --large-mb MB]

# Stop the server before removing its copy.
node scripts/dev-fixtures/fixture.ts remove --root /tmp/my-fixture-run

# Remove an unneeded cached original by its exact root.
node scripts/dev-fixtures/fixture.ts remove --root /absolute/cache/key
```

Originals default to `~/.cache/alpacawork-fixtures/<key>/`; override with `create --cache /absolute/path`. The key depends on generator and schema/contract sources, counts, and seed. Generation uses a private temporary directory and publishes the completed original, so concurrent creation yields one original per key. Old keys are not overwritten. Explicitly remove only versions no longer needed.

Originals record per-file SHA-256 hashes and counts in `.dev-fixture.json` and are stored read-only. Do not pass an original directly to the backend. Only offline reads without side effects can share one. Ordinary serving writes the database, read markers, connection details, and other state, so use a copy. Copies are independent ordinary files; they do not rely on hardlinks, symlinks, or CoW. Run working directories and workspace identifiers are adjusted to the destination. Stop serving before removal. When investigating a failure, preserve the copy and required logs first.

`copy` refuses even existing empty directories. `remove` accepts only an exact root marked by this script; a writer lease blocks removal of an active copy. There is no command to delete the whole shared cache or another developer's roots in bulk. Originals with modified files are not reused.

## Analysis overview and task timeline

```sh
node scripts/dev-fixtures/analysis-trace-scene.ts --dest /tmp/my-analysis-trace-scene
node apps/backend/dist/backend.js --workspace /tmp/my-analysis-trace-scene workspace serve --port 0
```

Open Analysis and choose 28 days or 7 days. The scene includes 30 accepted tasks over 28 days, change marks,
labelled fixes, and three tasks waiting for the user. The generator prints `showcaseTask` for the task to open
in the timeline, and `overnightAt` and `runAt` for inspecting a 9-hour review wait and concurrent Runs.
All saved Runs have ended and use inert launches. Stop the server before running
`node scripts/dev-fixtures/fixture.ts remove --root /tmp/my-analysis-trace-scene`.

## Counts and uses

| Profile | Task rows (including projects) | History | Runs | Use |
|---|---:|---:|---:|---|
| small | 14 | 19 | 7 | Small inputs for development screens and APIs |
| perf | 290 | 14798 | 5792 | Performance comparisons with new synthetic inputs |

The small profile is fictional data specific to these helpers, separate from existing E2E samples. It covers tree depth, states, holds, archives, long bodies and prompts/results, dense history, simultaneous timestamps, and requests/returns. All Runs have ended; saved launches target `/usr/bin/false`. Agent settings use the current format generated from the product's `defaultAgentSetting`, with `enabled: false` to prevent launches. It does not start real providers, measure active agent performance, or exactly reproduce historical production measurements. Each Run has one request, so perf has 5792 requests. Questions/answers, images, videos, active Runs, database fragmentation, and large journals are outside these profiles; use the corresponding specialized fixtures. Matching counts alone does not establish production-equivalent load.

New samples use the current settings and Run contracts. Do not reuse old cache entries as samples of a new schema; copy from an original with a new key. Rehearse migrations from older releases in a fixed checkout of that release, rather than restoring its old DSL in this generator.

The seed affects IDs. Identical source, counts, and seed produce identical logical data. Workspace identifiers differ per generation/copy, so database files need not be byte-identical.

## Control database for a production-data rehearsal

Stop the source before preparing a rehearsal with approved production data. In a separate private directory, copy only the non-database files needed for the rehearsal. Leave out the source control database and its sidecars, release/recovery backups, and connection files. From a checkout that matches the source schema, build the packages and backend, then run:

```sh
node scripts/dev-fixtures/rehearsal-control-copy.ts /absolute/stopped-source /absolute/private-rehearsal
```

The command publishes an independent control database with its own workspace identity, all automations off, pending signals cancelled, and an empty secrets table. It refuses a destination that already contains a control database. Use a separate rehearsal configuration and keep it off the production VPN address.

## Measurements on this PC (2026-10-28)

Measured three times per operation using Node v24.16.0, local storage, built packages, and a warm OS cache. Times cover the full script operation, including original validation and post-copy consistency checks; they exclude Node startup/imports, builds, and server startup. MB is decimal.

| Profile | Original contents | Original generation, three runs | Copy contents | Copy preparation, three runs |
|---|---:|---|---:|---|
| small | 491748 B (0.492 MB) | 12.2 / 14.2 / 16.4 ms | 491748 B | 5.3 / 5.9 / 6.1 ms |
| perf | 39731428 B (39.731 MB) | 0.783 / 0.823 / 1.924 s | 39739620 B (39.740 MB) | 0.360 / 0.367 / 0.692 s |

Sizes in the table include the database and config, excluding the small manifest and filesystem allocation differences. Including the manifest and other files, allocated space was about 0.500 MB for small, 39.74 MB for the perf original, and 39.75 MB for its copy. Copies grow slightly because of working directory/identifier rewrites. One full CLI run reusing an original, including Node startup/imports, took 253 ms for small and 300 ms for perf. Under these measurement conditions, the previous targets were met: originals below 80 MB, generation below 10 seconds, and copy preparation below 1 second. These values do not guarantee results on other PCs, with cold caches, or with production-equivalent I/O.

## Validation

Run helper tests explicitly; they are not added to existing test commands.

```sh
node scripts/testing/queue.ts node -- node --import ./e2e/perf/guard.mjs --test scripts/dev-fixtures/fixture.test.ts scripts/dev-fixtures/server.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck scripts/dev-fixtures/fixture.ts scripts/dev-fixtures/fixture.test.ts scripts/dev-fixtures/server.test.ts
```

The server test uses the built development backend and Playwright Chromium to check the API, history pagination, and rendered screens, and stops the server in `finally`. When invoking the queue directly, include the Node 24 bin directory and `node_modules/.bin` in PATH.

Run conversation unread-link checks explicitly through the E2E queue with `node --import ./e2e/perf/guard.mjs --test scripts/dev-fixtures/coordinator-read.test.ts`. They synthesize 133 exchanges in an independent small-profile copy and check marking all read, excluding new arrivals, save failures, reloads, and body position at desktop and 390px widths. Set `COORDINATOR_READ_EVIDENCE` to choose the evidence directory.
