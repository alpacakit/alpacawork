# Projection measurements and equivalence replay

Use Node 24.16 or later. Build packages, backend, CLI and web in each target checkout before measuring. Never build a
checkout while it is being measured. These commands read no production workspace. The measurement command creates
shared-format synthetic originals under its own temporary cache, serves independent copies, and removes its own copies,
originals and isolated HOME after stopping its timeout process group. JSON results, server timing logs and screenshots
remain in the required `--output` directory. Failure evidence remains there too.

```sh
COREPACK_ENABLE_NETWORK=0 pnpm install --offline --frozen-lockfile
pnpm build:packages
pnpm --filter @alpacawork/backend --filter @alpacawork/cli build
pnpm build:web

# Cheap setup check; these are not the performance numbers.
node scripts/projection-perf/run.ts --smoke --scales 1 --samples 1 --burst 2 --closed-burst 2 --output /absolute/smoke-evidence

# The specified workload and twice its size, with the same operation sequence.
node scripts/projection-perf/run.ts --output /absolute/incremental-evidence

# Run the identical script against a separately built main checkout.
node scripts/projection-perf/run.ts --repo /absolute/main-checkout --output /absolute/main-evidence
```

Options: `--scales 1,2`, `--samples 3`, `--burst 6` (writes while History is open), `--closed-burst 160` (writes while it is
closed, crossing two 80-event windows), and `--deadline-seconds 600` (per-server deadline, at most 3600). Every child CLI
also has a 120-second deadline. No command uses pnpm in the isolated HOME. Providers are disabled and fixture launches
remain inert. Metadata records the checkout SHA, dirty status, Node version, fixture key, seed and base counts.

The base fixtures contain 710 Tasks / 43,000 logs / 17,400 Runs and 1,420 / 86,000 / 34,800. The review scene finishes the
logical descendants of the dense Task, supplies closures for its ended child Requests, resolves its outstanding returns,
and submits one initial snapshot review. These deliberate, identical changes make review confirmation legal without
starting agents. Counts in metadata describe the original; the scene adds a review log, missing closures and resolutions.
This is a synthetic regression workload, not an exact production reproduction. It uses one sequential writer and no
large file tree; real provider load, 30 concurrent writers and the 165,000-file scene remain separate workloads.

For each sample the script confirms the old review, loads/caches the done view, closes it, and submits a new snapshot
review through the CLI. It measures that CLI round trip and its matching SSE row, then clicks the live Task row and waits
for the **new review body**, followed by two animation frames. The body includes a unique marker, so a retained old review
cannot count as a new rendering. Cold navigation is reported separately. History samples record response sizes (decoded
JSON bytes), response latency and write-to-render time while open, then reopen after the closed burst. Browser requests
always use `?agent=1`; browser contexts are fresh and service workers are blocked.

The preload measures Node event-loop lag with a 1ms histogram resolution, only in the backend process. Its maximum is an
approximation of the longest main-thread pause and includes OS scheduling/GC. It does not prove the duration of any one
function. Startup, legacy tree read/index time and routing timing remain in the raw log. `catchUp`, write queue/body and
per-write `requiredPv` changes are reported when the target exposes them; unavailable measurements are `null` with an
explicit `unavailable` flag, never zero. The expected timing fields are:

- `step: "catchUp"`: `catchUpMs`, `totalMs` or `ms`.
- `step: "write"`: `queueMs`/`waitMs` and `bodyMs`/`writeMs`.
- `step: "pass"`: `routeMs`/`routingMs`/`ms`.
- SSE `delta.requiredPv.<resource>.upsert`: changed resource keys.

No timing is an assertion or pass/fail performance test. Compare raw samples, median, p95 and maximum, including misses
of the 300ms/500ms budgets. Small sample counts do not establish a production percentile guarantee.

## One equivalence harness

```sh
node scripts/testing/queue.ts node -- node --test tests/projection-equivalence.test.ts
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  --allowImportingTsExtensions --skipLibCheck tests/projection-equivalence.test.ts scripts/projection-perf/check.ts scripts/projection-perf/run.ts scripts/projection-perf/event-loop.ts
```

The ordinary Node test runs a 28-step prefix, one candidate from every operation family, plus publication, bounded audit
and overflow recovery. It deliberately avoids the 200-step random tail. Use the diagnostic command below for longer
traces and several seeds; those traces are not additional default tests.

`tests/helpers/projection/harness.ts` owns the seeded operation sequence, semantic normalization, recorded-read checks,
resource membership/proof checks, routing/repair/resynchronization assertions and failure diagnostics. `replay` reports
`verified` and `pending` capabilities. Missing adapters do not become passing tests. Failure messages give the seed, step,
operation and first divergent value through the assertion's cause. Business versions and array order remain meaningful;
transport generation/pv/sourcePv/requiredPv/applied and the top-level index rev do not affect meaning comparisons.

`core-driver.ts` uses real `WorkspaceRecords.load/advance`, `deriveTask`, incremental aggregates and the published-frame
read builders. Its full side reloads the database, derives every Task, builds fresh aggregates and uses fresh readers at
every write point. The incremental side retains the records, derived rows, view cache, History parts and prepared
search/timeline caches. It compares bundles and reverse relations, rows/placements/Runs, home/order/counts, closed-page
membership/order, notification keys, full view, all four History window modes, closed pages and their next page, four
search queries and their next page, folded timeline and axis. Each changed resource is separately checked against its
`requiredPv`; a newly created empty resource has no previously cached response to invalidate.

`recordReads` wraps derivation, aggregate assembly, view/History (including event and crew assembly), page/search/time
builders and seat evaluation. Reads of derived rows are recorded too. One publication can combine several suppliers:
the dependency verifier substitutes each supplier's old reads to distinguish used facts from unused fields in a broad
bundle. It checks the owner-specific affected result, not just the union of every changed owner. This substitution is a
test probe, not a second product reader. Real frame results are always compared independently against a fresh DB load.

`routing-driver.ts` keeps two additional independent small-fixture workspaces. Both receive the same mutation sequence;
one settles only the seats from before/after `affected`, including follow-up writes, and the other settles all seats.
Their business snapshots compare task transitions, Requests, Runs, returns, holds/resolutions, receipt/consumption,
continuations and wait closure. Generated identifiers and wall-clock timestamps are normalized by their business roles.
The targeted snapshot is captured before a residual full sweep; any business write or newly touched key in that sweep
is a failure. The receipt journal is real; catch-up itself is not substituted by this adapter. Synthetic profiles admit
queued Requests, but no scheduler, server, manager or provider process is started. Coverage reports actual observed
continuations, queued Runs, deliveries, receipts, resolutions and closed waits, including the initial fixture work.

The prefix covers every operation family before seeded random operations. Explicit scenarios guarantee all four Run
states, both join/resume branches, a joined receipt and two error causes. Families include creation, title, values,
state, question/withdrawal, Request, placement profile/release, dependency, move, lifecycle, Run state, usage/session,
join/resume, delivery, uncertain inputs, files, config, person, read failure, errorCause, field/schema, notice returns,
joined-Run delivery and uncertain receipt settlement, coordinator-message join and later completion, and child completion that closes a wait cycle. Writes use
ControlStore transactions; these are test inputs, not public-command authorization or writer touch-completeness evidence.
Inputs, fields/schemas, config and coordinator messages are materialized. Files and errorCause enter through the workspace records' external
observation callbacks; the actual filesystem watcher is not involved. A failed candidate at the workspace records' file-read boundary must
leave the old publication intact. Aggregate repair corrupts cached values only and compares the repaired result with a
fresh full calculation. The seed controls the operation trace, not generated routing UUIDs or clock values.

Mutation candidates respect current transition prerequisites. A delivery is received once and consumed only while received,
unconsumed and unreleased; its state is checked inside the write transaction even when the supplied records are stale.
New executions and placements receive new identities instead of reopening terminal records. Taken inputs remain taken,
questions cannot overlap another reply wait, and dependency changes cannot create cycles. Ineligible candidates are
no-ops; `written` counts processed replay steps, including those no-ops, rather than committed database transactions.

`auditReplay` runs the complete trace despite independent product discrepancies and returns each operation, failed check
and first semantic difference; it never repairs a discrepant product value to make the next comparison pass. A mutation
or observation exception stops that trace, since later keys would no longer describe its publication. A routing exception
stops further routing comparisons while the independent projection trace continues. The test requires
zero discrepancies. For a reusable JSON report of the same replay:

```sh
node scripts/testing/queue.ts node -- timeout 180 node scripts/projection-perf/check.ts \
  --seed 901 --steps 200 --output /absolute/evidence/replay.json
```

The report entry point exits nonzero on discrepancies and still writes the JSON. `enabled` lists connected checks, not
successful guarantees. `routingSteps` must match `written`. It removes every synthetic original/copy on success and
failure. It never starts a server or browser. The performance script above remains a separate workload and can still
measure a built main checkout that predates the projection interfaces.

## Publication, bounded audit and recovery

`publication-driver.ts` attaches a real `ProjectionOwner` to the same synthetic workspace and an actual `ChangeLog`.
Every replay write appends its authored keys. Reads capture an arrival floor and call the owner's real catch-up path;
held records, derivations, aggregates and resource results must remain unchanged while a candidate assembles and after
it publishes. The index must carry the same version and resource proofs as its published frame. Published rows, live
placements/Runs, home, totals, pages, notification keys and read resources are independently compared with a fresh
full database load. Resource freshness is checked separately at the owner's own publication version, including cached
History, search, timeline and page readers.

At the end of the trace, only cached aggregate values are deliberately corrupted. The owner's `audit(2)` runs its real
bounded auditor and requests repairs through subsequent catch-ups. Each audit tick must respect that Task budget, must
not publish its candidate, and must leave the held damaged frame unchanged. The repaired publication must equal a full
calculation. The original direct aggregate-repair comparison also remains in the same harness.

Recovery uses a journal capacity of two. A synchronous burst exceeds it before the owner can consume the batches. A
reader waits at its captured floor while a controlled asynchronous observation blocks assembly; another write arrives
before observations are released. Real overflow catch-up must publish a full recovery, invalidate previously cached
resources, and serve the latest floor with the same contents as a fresh full load. No test substitutes a rebuild for the
owner's recovery path. Every owner is closed before its synthetic workspace is deleted.

For the longer trace on several seeds:

```sh
for seed in 901 902 903 904 905; do
  node scripts/testing/queue.ts node -- timeout 180 node scripts/projection-perf/check.ts \
    --seed "$seed" --steps 200 --output "/absolute/evidence/replay-$seed.json"
done
```

`publicationSteps`, `routingSteps` and `written` must match. The connected publication, audit and recovery checks leave
`pending` empty. Retry intervals, serving an explicitly stale publication after persistent failure, isolation of one
Task's derivation failure, and routing yield policy are under revision and have no fixed behavioral assertions here.
The controlled observation pause tests atomicity without fixing a failure or retry policy.

This replay still uses authored mutation keys and calls the publication owner directly. Database write touch coverage
is independent; HTTP authorization, the filesystem watcher, actual notification delivery and provider execution are
separate checks. These adapters do not establish full server end-to-end equivalence.
