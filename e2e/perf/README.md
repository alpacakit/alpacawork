# Measuring how the screen fetches data (comparing before and after with the same procedure)

These are tools for comparing, before and after a change and with the same procedure, how heavy the screen is while it stays open and agents are working.
They are not part of `pnpm test:all` (timing values fluctuate).

## Opening and closing the detail panel and switching from the list

`reader-motion.ts` measures, on the same fixture, the Reader's docked / overlay / touch sheet, opening and closing reports, opening, closing and switching the family panel,
report arrival, and the phone's reader heading and date headings. The report heading is placed on screen and asserted to be inside the viewport.
`--extra` switches through parent, child and body links. In the normal series, overlay-open/close switches between full screen ↔ side window.
Showing/dismissing a closed overlay is measured separately with `--overlay --widths 1440` (likewise CPU 1×/4×, 3 times each).
`reader-switch.ts` switches from the list's actual row buttons, once and 8 times at 200ms intervals. It separates the cold, warm and
500ms-delayed view/history conditions, and records the time until the heading/body appear in the DOM, the maximum number of copies and those remaining after the end,
and view/history completion/abort. Presses use the DOM click(). At CPU 4×, when processing backs up the actual press intervals lag too, so
also read `observation.presses[].at`. A body not reached for a task left midway is null; if the final task's body is not reached, the run is invalid.

After a normal build, run the baseline and the candidate in turn (put the same script in both). Compare the medians of 3 runs per condition, at widths 1440×900 and 390×900,
CPU 1×/4×. 390 is desktop Chromium's touch and narrow-width emulation, not a physical device.

```sh
node --import ./e2e/guard-loader.mjs e2e/perf/reader-motion.ts /abs/motion-t1.json --rounds 3 --throttle 1
node --import ./e2e/guard-loader.mjs e2e/perf/reader-motion.ts /abs/motion-t4.json --rounds 3 --throttle 4
node --import ./e2e/guard-loader.mjs e2e/perf/reader-motion.ts /abs/extra-t1.json --rounds 3 --throttle 1 --extra
node --import ./e2e/guard-loader.mjs e2e/perf/reader-switch.ts /abs/switch-t1.json --rounds 3 --throttle 1
node --import ./e2e/guard-loader.mjs e2e/perf/reader-switch.ts /abs/switch-t4.json --rounds 3 --throttle 4
```

Both scripts measure rAF / LoAF / CDP layout/style/script / React commit / Element.animate with the shared `motion-probe.ts`.
reader-motion also captures the keyframes/timing of CSS transitions/animations when they start. There are also `--reduced`, `--widths 390`,
`--film` (composited frames of each window), `--slow 1500` and `--stall` (main thread stopped for 500ms, 40ms after the last operation).
film, stall and slow are kept separate from timing. `--counts` adds per-component render counts in a profiling build.
reader-switch's `--profile` gives per-function CPU samples. Render counts/CPU profiles are also kept separate from normal timing.
The scripts have a 20-minute limit, and finally/keeper stops serve and the browser. Timing fluctuations are not used for test pass/fail.

Opening and closing reports (`grid-template-rows` at the time, `height` now) and the date sticky's `top` trigger layout every frame.
Their cost was measured under the same conditions before and after and compared with the cost of a structural change that keeps the nesting, rules, reading position and sticky boundaries,
and the parent decided to keep these two places as explicit exceptions. They are not treated as having become composite-only.

## Phone operation measurement results

`node scripts/perf/phone-survey-summary.ts <results-directory>` creates `latency-summary.json` and `latency-table.md` from the measurement results of `phone-survey.ts`.
It keeps the valid measurement windows up to where a run got to, and the outliers, and saves preparation operations and unfinished inputs separately.

## Phone input field

`phone-input.ts` measures from keystroke to paint with 390-width touch (DPR 3) and CPU throttling. It is Chrome emulation, not a physical device, and the IME is synthesized through CDP.
`--surfaces conversation,reply` (open the conversation input or the reader and type), `--feeds still,live,return` (no updates, with updates, right after returning to the page),
`--inputs latin,ime,none` (`none` types nothing and takes only the updates), `--throttles 4,6`, `--bursts` (rest 0.7–1.9 seconds after keystrokes), `--update-ms` (the update interval; the interval seen in production is about 6 seconds).
The next keystroke does not wait for the previous keystroke to be accepted. Aggregation happens only after waiting `--settle-ms` (make it long enough for the updates to finish, so that approaches that defer work do not look better than they are).
`--renders` gives per-component render counts (names in a profiling build), and `--cpu` per-function time. Both are separate from timing. Read the counts (commits, components drawn, saves) primarily, and compare times under the same load, run simultaneously or alternately.

`phone-input-guard.ts` records, with the same procedure on the before and after versions, that typed text remains (reload, save failure, updates during composition, send cancellation), that updates arrive (even after the stream drops), page errors, and PNGs of the screen with the same data. PNGs are taken one at a time.

## Switching from a list row to the detail

`detail-switch.ts` measures, on the common synthetic dummy (perf), from pressing a list row until the detail has switched and is readable. It presses an ordinary task,
the task with the longest History, a task with 40 added children and a task with 60 added files, on the first opening (cold) and the second (warm).
From the moment of the press, it records the time until the heading appears (headerMs), until History is readable (readyMs) and until motion and painting settle (quietMs),
and, during that time, the reads (start and end of each /api response), main-thread script, style and layout, Long Animation Frames, and the motions that ran.
Widths are 1440×900 and 390×900 (touch), with CPU 4× by default. `--cpu` gives per-function time for each press (separate from the runs that compare time).
serve refuses a workspace that differs from its installation record, so run it with an isolated HOME. For before/after, run the same script alternately, switching `--release`.

```sh
HOME=/tmp/iso node --import ./e2e/guard-loader.mjs e2e/perf/detail-switch.ts --release <ビルド済みの checkout> --out /abs/new-dir [--rounds 2] [--cpu]
```

## Making a copy in the current format

The copy includes files from `tasks/` and the Run directory. It backs up the control database through a read-only connection, disables agent profiles, and replaces saved Run launches with inert commands. Reuse the same copy for before and after measurements.

Work outside the worktree (`$D` in the example below). Use the production root only as the read source.

```sh
D=/path/to/alpacawork-worktrees/data-fetch                  # 計測のデータと結果を置く場所
SOURCE=/path/to/current/alpacawork-root                     # 現行形式の読み取り元
# データを作る（初回だけ。前後の比較では作り直さない）
node e2e/perf/copy-root.mjs "$SOURCE" $D/perf-data/copy
```

A copy includes Runs that were active at the time of copying. Serving the copy reconciles those Runs, which can contribute to idle measurements.

## Subscription and same-value notification measurement on fixed data

`render-subscriptions.ts` measures input labels, conversation Cards and videos in the real app at 1440×900 / 390×900.
Put Node 24 and the checkout's `node_modules/.bin` on PATH, finish a normal build, then run the following in order.
Do not overlap serve and build in the same checkout. Give a new persistent directory as the output location for each series.

```sh
node scripts/testing/queue.ts build -- vite build --config e2e/perf/render-subscriptions.vite.ts --mode profiling
node scripts/testing/queue.ts e2e -- node --import ./e2e/guard-loader.mjs e2e/perf/render-subscriptions.ts /absolute/output/raw.json
```

Only the dedicated Vite config exposes the existing stores' diagnostic handles. They are not in the normal build.
It sends 20 Workspace update notifications that concern only other Tasks, 20 unused pendingSeen update notifications to the Card plus a reset, and 20 same-value timeupdate notifications for a stopped video, 3 times each,
and counts executions of the target components with the React commit hook. The frequency of the diagnostic notifications does not represent real use. Keep this distinct from the app-wide render reduction rate and perceived speed.
Real backend updates of another Task and title/state changes of the referenced Task are also recorded, in separate series.

After fixing the real editor's initial document, it checks keyboard/CDP IME, keeping the selection position, read state, scroll and focus, round trips to the PC's real Document PiP,
and real WebM play, stop, speed, mute and seek. The coordinator GET/warm/read ACK use a fixed fixture; Task updates and media fetches use an isolated backend.
Results are saved per operation, and traces, recordings, images and server stop records are also left near the output location.
Use the same script and settings before and after.

## Open/close and re-render measurement on fixed data

`render-motion.ts` does not connect to production; it starts the current e2e fixture with a time limit and cleans up afterwards.
It replaces only the conversation GET and warm with a fixed response of 12 turns (Markdown with 25 sections each).
The list, the detail and list updates go through a real isolated server. At each width, 1440×900 / 390×900,
it measures input open/close, typing 7 characters, conversation open/close, list scroll/update and detail open/close, 3 times each.
Because it opens and closes the conversation once before measuring, the first connection and the catalog loading are not mixed into open/close.

With Node 24.16 or later, after the normal `pnpm build`, run the following in order.
Put the same `render-motion.ts` in the pre-change checkout too, and use the same commands on both versions.
Do not build while measuring in the same checkout.

```sh
pnpm exec vite build --config apps/web/vite.config.ts --mode profiling
node e2e/perf/render-motion.ts /tmp/before-counts.json counts
node e2e/perf/render-motion.ts /tmp/before-timing.json
```

After the fix, repeat with the output names `after-counts.json` / `after-timing.json`.
`counts` counts the components executed, using React's commit hook (mounts included).
The timing run leaves out the fiber traversal and records CDP TaskDuration / layout / style, trace paint,
rAF frame intervals and longtasks of 50ms or more. Both use the profiling build.
After each operation, the measurement includes 450ms, so the completion of animations is also inside the window.
The raw Element.animate keyframes/options are also recorded, so motion durations and curves can be compared.
Timing values fluctuate with environment load, so they are not part of the `test:all` pass/fail conditions.

390px is a narrow desktop Chromium viewport. It does not measure a physical device, touch-specific handling, or the performance of
other browsers. For guarantees about motion and focus, also use the corresponding e2e and checks by real operation.

## Motion of opening and closing the input field and chat pane

`open-close-motion.ts`, for each width, starts an isolated serve with a fake coordinator and a time limit, creates a project of question cards,
opens the reader on the first card, and measures in each round: input open/close, conversation open/close, send and fold, send while pinned (no folding), and swipe to the next card
(1440×900, touch 390×900). In each operation's window it records rAF intervals (dropped frames), Long Animation Frames,
CDP layout/style/script, React commit counts, and the property names animated by Element.animate.
Rounds where the card did not fly off (the send was not accepted) are marked `valid: false` and excluded from aggregation.

```sh
pnpm build
node --import ./e2e/guard-loader.mjs e2e/perf/open-close-motion.ts /abs/after-t4.json --throttle 4 --rounds 3
node --import ./e2e/guard-loader.mjs e2e/perf/open-close-motion.ts /abs/after-t1.json --throttle 1 --rounds 3
```

`--film` saves every composited screen in each window (`<out>.film/<幅>-<操作>/<ms>.jpg`), and `--slow 1500` stretches motions of the base duration
to inspect their shape. There are also `--profile` (function names remain in a `--mode profiling` build), `--video` and `--reduced`.
Saving and measuring themselves use CPU, so run them separately from the runs that compare time. Put the same script in the version before the change too, and
run before and after in sequence (not in parallel).

The measurement itself (rAF intervals, Long Animation Frames, CDP, React commits, animated property names, --film/--profile) is
gathered in `motion-probe.ts`; with `MOTION_TRACE=1` it also keeps a Chrome trace for each window (`<出力>.<幅>-<操作>.trace.json`).
Layout entries in the trace that carry a script stack are forced layouts, and the same function lined up many times within one task is a read/write round trip.
Function names remain with `vite build --minify false` (keep these runs separate from timing runs). `diff-motion.ts` (open a report's diff, open a file inside it, close) and `surface-motion.ts` (open and fold the conversation queue, maximize and restore the conversation) use the same thing.
The conversation in `surface-motion.ts` is a fixed 12 turns with 3 queued items (only the contents of a real snapshot are replaced).

## From a done/hold/answer swipe to the next detail

`swipe-next.ts`, for each width, starts an isolated serve with a fake coordinator and a time limit, and builds stacks of cards of the same shape for each kind (`done` completion of a confirmation, `hold` hold,
`answer` answer to a question) and content (`light` 4 short reports, `heavy` a long body and 120 reports; both have images in the latest report and the body).
390 is touch (DPR 3): the finger moves sideways for about 260ms with a timestamp every 16ms and lifts while still moving;
1440 presses the same answers with buttons (Done, H, select and send). Each round is divided at the moment of the press, the moment of release and the moment the next card is readable
(the heading shows the next ID, the history is drawn without placeholders, and the images are decoded), and for the period the card follows the finger (follow),
the 900ms after release (leave) and the whole (whole) it records dropped frames, the maximum interval, Long Animation Frames, React commits and
CDP style/layout/script. `--cold` holds the loading of the next card until the answer, to see the case where it could not be prefetched.

```sh
pnpm build
node --import ./e2e/guard-loader.mjs e2e/perf/swipe-next.ts /abs/phone-t4.json --widths 390 --rounds 3 --throttle 4
node --import ./e2e/guard-loader.mjs e2e/perf/swipe-next.ts /abs/pc-t4.json --widths 1440 --rounds 3 --throttle 4
```

`--trace` (Chrome trace; choose the categories with `PERF_TRACE_CATEGORIES`; adding `disabled-by-default-devtools.timeline.invalidationTracking` shows
what caused restyles), `--profile` (CPU profile; function names remain with `vite build --minify false`), `--film`,
`--video`, `--headed` (a window of the installed Chrome; because it is recorded with `ffmpeg -f x11grab` on Xvfb, each answer prints
`mark <幅> <場面> <epoch ms>`) and `--reduced` are available. Keep them separate from the runs that compare time, and run before and after alternately (not in parallel).

Findings: the single task at the moment of release contained, in addition to painting the next card, repeated restyles of the reader's whole body (1,500–2,300 elements on real data).
The causes were: (1) the swipe's `touch-action` was removed and set again for each card; (2) the heading height
(`--reader-header-h`) was measured and written at its visual height while the next card was still scaling in, then immediately rewritten with the correct value;
(3) the copy of the flying stamp duplicated the whole history and restyled and re-laid out all of it, even though only one screen of it was visible.
`still-copy-pixels.ts <出力> <前の motion.ts> <後の motion.ts>` checks, on a real heavy reader (phone and PC, at the top and scrolled partway), that a copy that copies only the visible part
produces a picture identical, pixel for pixel, to a copy of the whole.

## Detail and timeline resizing

`panel-timeline.ts` adds fixed-data detail open/close, continuous reversing width/sheet drags,
six viewport widths, phone Time open/close and six time-axis zoom steps. Desktop Time is always
shown; there is no separate timeline drawer or resize handle in this version. Its width changes
with the detail and viewport. The normal fixture has 6 additional reports and 3 body sections;
the heavy fixture opens the 35-section Context page with tables (Context replaces the reports on screen, so the 120 reports are no longer drawn beside it; compare figures across that change with care). Both use
real task image/video files. The heavy fixture keeps a 12-turn conversation and an input draft open.
Previous conversation/typing measurements in `render-motion.ts` are not repeated here.

After a normal build, build profiling once, then run these in sequence for each fixed revision:

```sh
pnpm exec vite build --config apps/web/vite.config.ts --mode profiling
node e2e/perf/panel-timeline.ts /tmp/before-normal-counts.json counts normal
node e2e/perf/panel-timeline.ts /tmp/before-heavy-counts.json counts heavy
node e2e/perf/panel-timeline.ts /tmp/before-normal-timing.json timing normal
node e2e/perf/panel-timeline.ts /tmp/before-heavy-timing.json timing heavy
```

Use `after-...` output names on the candidate. Each run covers 1440×900 and 390×900, 3 repetitions.
Counts and timing are separate runs. CDP task/style/layout, trace layout/paint, rAF/long tasks,
ResizeObserver callback/entry and pointer counts are recorded along with WAAPI frames/options.
Counts runs additionally record geometry at each drag waypoint. The phone uses actual CDP touch
and checks that the visible grip is the hit target and that the sheet really moves. After reading
media the phone returns to the top to use its auto-hiding header. Images are loaded and the video
plays during resizing (the phone's media can be below its visible reading area).
History bodies remain folded as the product normally draws them; this is not 120 simultaneously
expanded reports. A narrow desktop Chromium viewport/touch emulation is not a physical phone.

For matching review recordings, use the same fixture and build, separately from performance runs:

```sh
node e2e/perf/panel-timeline-video.ts /tmp/before-video /path/to/askmeclearly/scripts/video-marks.mjs
```

With a fixed browser clock, the helper should timestamp exposed pointer callbacks on the
Node side with `performance.timeOrigin + performance.now()`: page time origins may also be
shifted by clock emulation. The task's evidence includes that helper copy. Run askmeclearly's `annotate-video.mjs` separately on the generated marks JSON.
Servers and browsers have a bounded lifetime and are closed by the harness. Do not build or run
other browser measurements concurrently in the same checkout. Results are evidence, not timing
assertions in `test:all`.

## List updates and motion

`list-motion.ts` measures, on a small isolated list, title updates, row additions, moving to hold with a new timeline mark,
zooming the time range, edge notes returning, the 390-width bar retreating/returning and pull-refresh, and tree open/close (observation only).
The defaults are 1440×900 and touch-configured 390×900, 3 times each. 390 is desktop Chromium, not a physical device.

Put the same `list-motion.ts` and `list-motion-probe.ts` in the pre-change version too, build each, then run before → after in series.
Measure `--throttle 1` and `--throttle 4` each, and compare the medians of the same operation.

```sh
node --import ./e2e/guard-loader.mjs e2e/perf/list-motion.ts /abs/before-t1.json --throttle 1
node --import ./e2e/guard-loader.mjs e2e/perf/list-motion.ts /abs/before-t4.json --throttle 4
# 変更後のworktreeへ移ってから同じコマンド（出力をafterへ）
```

It records rAF/LoAF/CDP layout, style, script, React commits and WAAPI property names. For CSS transitions,
it picks up the properties with `transitionrun`. It does not call `getAnimations()` or measure the DOM every frame.
`--trace` is a separate measurement that saves the raw records of layout/style/paint and animation/invalidation, and `--film` saves the composited screens.
Recordings and traces add load to the measurement, so run them with `--rounds 1`, separately from time comparisons.
`--slow 1500` is only for checking shape by stretching the base motions, and `--reduced` is the reduced-motion setting.
Servers and browsers are ended by finally and keeper, which leave their PIDs and stop results in `.local/list-motion-runtime/` (no fixture is created inside the production workspace).

In this Chromium, moving/scaling the SVG itself involves layout on the main thread, so only the HTML layer that keeps the coordinates and buttons is moved.
`compositor-block.ts <dir>` is an auxiliary experiment that captures a simple background color/transform/height during a 500ms main-thread block, to check whether compositing moves forward.
Property names alone are not taken as proof that something can be composited. Moving an ancestor that contains a native select leaves a separate cause of layout.

`list-native-select.ts <out.json> <1|4>` is an isolation check that compares with and without the select, 3 times each, on the same dedicated fixture.
390 uses the real bar/pull path; 1440 has no auto-hide/pull, so its values are for reference, with the heading moved artificially through a CSS variable.
The removed select is replaced with an empty element of the same dimensions, and this is not adopted in the product.

`list-mark-motion.ts <out.json> <1|4>` is a supplementary measurement of the new-arrival mark alone. To avoid the case where the normal list's hold group folds the second and later items,
it opens a new Task's scope each time before adding a report. A run is valid only if the scale was actually observed once.
The move in the normal list measures the whole row move, and is distinct from a guarantee that the new-arrival mark appears in every repetition.

### The full span of pull to refresh

`pull-loading.ts` uses the existing isolated synthetic `seedTimelineScroll` (64 rows) and measures, with touch at 390×900,
pull → threshold → release → spin → row name update by the real backend → done mark → return.
At 1440, `narrow` is false and the same operation is disabled. 390 is a desktop Chromium simulation, not a physical device.

```sh
node --import ./e2e/guard-loader.mjs e2e/perf/pull-loading.ts /abs/before-1.json --throttle 1 --rounds 3
node --import ./e2e/guard-loader.mjs e2e/perf/pull-loading.ts /abs/before-4.json --throttle 4 --rounds 3
# 候補の同じbase/台本/buildでafterも逐次実行する（計測と試験を重ねない）
node --import ./e2e/guard-loader.mjs e2e/perf/pull-loading.ts /abs/after-film.json --rounds 1 --film
node --import ./e2e/guard-loader.mjs e2e/perf/pull-loading-block.ts /abs/after-block
node e2e/perf/pull-loading-film.ts /abs/before-film.json /abs/after-film.json /abs/paired-film
```

`drag` is 20 inputs, `release` waits 600ms from touchEnd, `loading` covers the 400ms feed gate wait and
from the release of the real update until done, and `return` includes the remaining hold of done (up to 300ms) and the return spring.
Input event timestamps advance in 16ms steps to make the release velocity the same, but the actual interval of CDP dispatch is about 50ms.
Script/React root commits are page-wide, not render counts of individual components.
Estimated rAF drops are estimated from intervals against a 60Hz basis; they do not directly measure dropped composited frames.
The style/phase MutationObserver load is included too, so the results do not guarantee absolute production times or improvement rates.
`getAnimations()` and the computed glyph are taken only once, after the CDP measurement of each span, to distinguish CSS rotation/transitions from
manual transform/opacity/rotate/stroke-dashoffset.

`--withoutSelect` is diagnostic-only: it removes the real select and is not adopted in the product. Its absence is checked in each span.
`--diagnostic` is a separate series that records the existing IntersectionObserver notifications and requests.
`--reduced` is the reduced-motion setting, and `--film` is a separate series that saves images; neither is mixed into the normal timing table.
`pull-loading-block.ts` stops the main thread for 500ms in each of release/loading/return and saves the screen of the real target.
Do not judge compositing from whole-screen frame counts alone; look at the spin and the list position separately.
It ends by its time limit/finally/keeper, and leaves the PIDs and stop results in `.local/pull-loading-runtime/`.
Disposing of the synthetic fixture after the evidence is saved follows `scripts/dev-fixtures/README.md`.


`pull-spring-cases.ts <output-dir>` checks in a real browser the operations that the fixed-60Hz-sample version must preserve.
It goes through normal/reduced fast completion, delay, 503 failure, touchcancel, two fingers and disabling by offline,
and records re-touching while holding/returning, the release of the final transform/animation/will-change, and selection in the real NativeSelect.
It keeps the existing contract that a re-touch outside rest is not turned into a new pull. It checks that a re-touch does not stop the spring or make the position jump.
The spring values are owned by `PULL` and `springStep` in `pull-feel.ts`, and `springValues` generates 60Hz samples of the same formula.
transform/opacity/rotate for release/return use WAAPI, and the arc for a pull that has not gone far enough keeps the existing stroke-dashoffset drawing.
Do not run this operation test at the same time as timing. Video and blocking tests are also separate passes.
## Re-fetching in the detail panel

`detail-refresh.ts` measures opening T111 from the list when reports were added while it was closed (open-diff), when there is no difference (open-same),
and when a report arrives while it is open (open-live). The History response is delayed by `--hold` (default 500ms) every time, so that loading is visible in every case.
The defaults are 1440×900 and touch-configured 390×844, 3 times each. The measurement is the same as `list-motion-probe.ts`. Put the same script in the previous version too, build it, and run them in series.

```sh
node --import ./e2e/guard-loader.mjs e2e/perf/detail-refresh.ts /abs/after-t1.json --throttle 1
node --import ./e2e/guard-loader.mjs e2e/perf/detail-refresh.ts /abs/after-film.json --rounds 1 --film   # 撮影は計時と分ける
node e2e/perf/detail-refresh-film.ts /abs/before-film.json.film /abs/after-film.json.film /abs/video     # 前後を横に並べる（1440は詳細パネルを切り出す）
```

`detail-refresh-still.ts <out dir>` takes stills of the line position (with a red mark on the line) while rereading, while scrolling down, and on a task without Task tree rows.

`historyReads` is the number of History rereads during that operation. When there is no difference it does not reread (0 times), so the line does not appear either.

## Phone sheet handle

`sheet-handle.ts`, on the synthetic perf workspace, sends real CDP touches to the handle of the detail sheet at phone width (412×915, DPR 2.625) and, for each press, counts
"where it landed (the pointerdown target), whether it moved, whether it closed". You can choose a layout with the conversation sheet open below, full screen, a very small pinch zoom,
CPU slowdown (`--throttle`) and continuous arrival of updates (`--live`). `--flick` attaches real-device finger timestamps (CDP's sending interval is not the finger's speed).
`--scan --radius 12 --offset -14` varies the sheet height from 0.30 to 0.85 and counts whether a finger that lands slightly above the handle is adjusted to the row behind it.

```sh
node --import ./e2e/perf/guard.mjs e2e/perf/sheet-handle.ts --release $PWD --out /abs/handle --throttle 4 --repeat 3 --layouts rest,whole,zoom-1.02 --presses grip,above,above12
node --import ./e2e/perf/guard.mjs e2e/perf/sheet-handle.ts --release $PWD --out /abs/scan --throttle 1 --scan --radius 12 --offset=-14
```

`interaction-latency.ts --release <built checkout> --out <new dir> --rounds 4`
measures native Event.timeStamp to finished finite WAAPI/CSS motion plus three quiet frames
(minimum 80ms), on the common synthetic perf workspace at 390px/CPU4. It covers
input and conversation opening/folding, the earlier-history row, touch scrolling,
and next/previous task navigation. `--height 600` repeats with less room; this is
not a real IME. `--profile` saves CPU samples in a separate run; do not compare its
times with normal timing runs. Alternate frozen normal builds for comparisons.
`warm-*` values record the first openings separately from the repeat windows.
Input dispatch delay is included and saved as `inputDelayMs`.
RAF gaps include the frame spanning the initial press. LoAFs overlapping that
press are retained in `leadingLoaf`; their full blocking time can include work
before the press. Each invocation stops its browser/server and removes its
synthetic workspace, with a 15-minute backstop. The original fixture is cached.

For comparisons with less host-load drift, alternate each operation between two
independently warmed releases (both browser/server contexts remain alive):

```sh
node --import ./e2e/perf/guard.mjs e2e/perf/paired-interactions.ts --before /abs/before-build --after /abs/after-build --out /abs/new-paired --rounds 4 --height 900
```

Both trials finish preparation before either operation starts; round 0/2 runs
before first and round 1/3 after first. The other trial waits until both finish,
then both advance. Background RAF/server work is not suspended. Results, images,
logs and `pairs.json` retain the matching scene names and order. The parent has a
six-minute disconnect backstop; children retain their own finally/expiry cleanup.
CPU affinity, if used, must be configured and recorded by the invoking process;
Chromium may reset some GPU thread masks, so process inheritance does not prove
all threads have the same affinity. Do not mix this series with single-context
or profiling runs. Native scroll includes the gesture and inertia; a shorter
elapsed duration alone is not evidence of smoother scrolling.

The first frame that observes the target DOM inventories finite document animations
once, including CSS delays before animationstart. Completion checks both pending
and running motions. `endProbe` records their states/currentTime/timeline together
with the exact completion RAF and observation time; later screenshots/states are
not evidence of what was finished at the completion boundary.

For detail sheets use `interaction-latency.ts --detail` or `paired-interactions.ts --detail` with the same release/out flags.
The common perf fixture is shown at 390×900 and CPU 4 by default. The first visible task row is opened (its ID is recorded).
Each round opens and closes with the button, navigates Back, resizes then closes from the handle, and resizes then closes from the body.
The kept sheet share is reset to 2/3 before each opening, outside measurement. `--expanded-list` opens More and Done before timing.
Native pointerdown starts touch cases; native touchend timestamps also separate gesture time from the remaining motion.
Back uses `page.goBack()` with a timestamp immediately before that browser command: it is a history-command proxy, not a physical Back-button latency.
Completion requires the expected DOM, every collected finite animation ended, and 3 quiet RAF callbacks; elapsed time uses the callback's observed clock.
Resize additionally requires a final height change of at least 40px; start/end geometry and scroll are saved.
`rowReads` counts `li[data-row]` rect reads between the first input and completion, including only the list visibility scan (the motion hook also measures other elements).
Profiles (`--profile`) are separate from timing trials. Raw results include animation keyframes/timing, RAF gaps, LoAF, and browser errors.

## Manual measurement of the five main operations

After a normal `pnpm build`, run it with an output location that does not exist yet.

```sh
node --import ./e2e/perf/guard.mjs e2e/perf/major-operations.ts --out /tmp/任意の未作成出力先
```

Measures 3 times each on PC and phone equivalents. `--profiles perf` covers everything except sending.
Run `--profile` separately from timing. The phone equivalent is not a physical device, and there are no performance asserts or test registration.
For more options, see the script.

`--profile --trace` saves a timeline for investigating causes, and `--invalidation` additionally records the sources of style recalculation (requires `--trace`).
Both add measurement load, and `--invalidation` in particular is heavy, so do not mix them with normal timing.
