import { commandPost } from './command-post.ts';
import { readSnapshot } from './read-evidence.ts';
import { captureFailure, withRuntimeEvidence } from './failure-evidence.ts';
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { test as base, expect, request as apiRequest, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readRuntime, start, type Runtime } from "./server.ts";
import { SAMPLE_NOW, SAMPLE_PROJECT } from "./fixture/sample.ts";
import { writeFixtureConfig } from "./fixture-writes.ts";
import { assertGuardLoaded } from "./guard.ts";
import { excludedAmbientPulse, motionHasSettled, type ObservedMotion } from './motion-settled.ts';
import { applyPageClock } from './page-clock.ts';
import { failureJson, fixtureDeadline, withFixtureCleanup } from './fixture-cleanup.ts';
import { recoveryStageMs } from './pwa-evidence-budget.ts';

// Evaluated before every derived runtime, including direct serve and restarted workers.
assertGuardLoaded("fixture-module");

/** Writing cases own their DB, files and port; each page owns its browser context.
 * ALPACAWORK_E2E_ONLY_ISOLATED=1 also gives ordinary cases an owned server;
 * prepared read-only layouts still share only within their worker. */
/** The reader's auto-swipe on before the app starts, as kept on the device after a press. */
export const turnAutoSwipeOn = (page: Page) => page.addInitScript(() => localStorage.setItem('alpacawork.autoSwipe', 'on'));
export const test = base.extend<{ isolated: boolean; fixedTime: boolean; runtime: Runtime; failureEvidence: void;
  runtimePrepare: ((root: string) => void) | undefined; retainRuntime: boolean; captureScreenshots: boolean;
  runtimeAfterStop: ((info: TestInfo) => Promise<void>) | undefined; writeGraceMs: number; autoSwipe: boolean }>({
  isolated: [false, { option: true }],
  // Cases that read a send leaving its card turn the reader's auto-swipe on, as a person would; off is the app's default.
  autoSwipe: [false, { option: true }],
  fixedTime: [true, { option: true }],
  writeGraceMs: [0, { option: true }],
  runtimePrepare: [undefined, { option: true }],
  retainRuntime: [false, { option: true }],
  captureScreenshots: [true, { option: true }],
  runtimeAfterStop: [undefined, { option: true }],
  locale: "en-US",
  runtime: async ({ isolated, runtimePrepare, retainRuntime, runtimeAfterStop }, use, info) => {
    // Without global setup, even ordinary read-only cases own a server.
    if (!isolated && process.env.ALPACAWORK_E2E_ONLY_ISOLATED !== "1") return use(readRuntime());
    const runtime = await start(process.env.ALPACAWORK_E2E_ISOLATED_PORT, runtimePrepare,
      retainRuntime ? info.outputPath('runtime') : undefined);
    await withRuntimeEvidence(runtime, info, () => use(runtime),
      [{ name: 'stop', timeoutMs: retainRuntime ? recoveryStageMs.stop : undefined, run: async () => { await runtime.stop(); } },
      { name: 'preserve', run: async () => { await runtimeAfterStop?.(info); } }], failures => {
      if (retainRuntime) writeFileSync(info.outputPath('runtime-teardown.json'), JSON.stringify({
        originalTestErrors: info.errors, failures: failures.map(each => ({ stage: each.stage, error: failureJson(each.error) })) }, null, 2));
    });
  },
  // Test-scoped and inherited by every derived TestType. Dependencies keep both
  // live resources alive until capture finishes, regardless of which file loaded this module.
  failureEvidence: [async ({ page, runtime, captureScreenshots, retainRuntime }, use, info) => {
    const requests: unknown[] = [];
    page.on('request', r => requests.push({ kind: 'request', at: Date.now(), url: r.url(), method: r.method(), body: r.postData() }));
    page.on('response', r => requests.push({ kind: 'response', at: Date.now(), url: r.url(), status: r.status() }));
    page.on('requestfailed', r => requests.push({ kind: 'requestfailed', at: Date.now(), url: r.url(), error: r.failure() }));
    try { await use(); } finally {
      let state: unknown;
      try { state = await readSnapshot(page); } catch (error) { state = { captureError: String(error) }; }
      writeFileSync(info.outputPath('read-query-idb-http.json'), JSON.stringify({ testId: info.testId, status: info.status, errors: info.errors, runtime: runtime.root, state, requests }));
      // Propagate capture faults alongside the original test error; runtime/page owners still clean up.
      if (info.status !== info.expectedStatus) {
        const capture = () => captureFailure(page, runtime, info, captureScreenshots);
        await (retainRuntime ? fixtureDeadline(capture, recoveryStageMs.capture) : capture());
      }
    }
  }, { auto: true }],
  page: async ({ page, runtime, fixedTime, writeGraceMs, autoSwipe }, use) => {
    // Sample layouts fix Date while timers/frames advance. Cases using host-time
    // deliveries can retain the real clock while sharing this same capture lifetime.
    if (process.env.ALPACAWORK_E2E_SUBJECT_EVIDENCE === '1') await page.addInitScript({ path: new URL('./interaction-evidence.js', import.meta.url).pathname });
    await page.addInitScript(ms => { (window as Window & { __ALPACAWORK_WRITE_GRACE_MS__?: number }).__ALPACAWORK_WRITE_GRACE_MS__ = ms; }, writeGraceMs);
    if (autoSwipe) await turnAutoSwipeOn(page);
    await applyPageClock(page, fixedTime);
    await use(page);
  },
});
export { expect };

/** Prepared, read-only layouts share a server within one worker; writing cases use `isolated`. */
export function readOnlyTest(prepare: (root: string) => void) {
  return test.extend<{}, { preparedRuntime: Runtime }>({
    preparedRuntime: [async ({}, use) => {
      const runtime = await start(undefined, prepare);
      try { await use(runtime); } finally { await runtime.stop(); }
    }, { scope: "worker" }],
    runtime: async ({ preparedRuntime }, use) => { await use(preparedRuntime); },
  });
}

/** Let React's frame work commit, then wait for the actual CSS/Web Animations to finish. */
export async function settleMotion(page: Page, area?: Locator, finiteOnly = false) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  let motion: ObservedMotion[] = [];
  const excluded: ObservedMotion[] = [];
  // The sampler runs in the browser realm; only the classification lives in the pure Owner.
  const sample = (element: Element | null) => (element ? element.getAnimations({ subtree: true }) : document.getAnimations()).map(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return { state: animation.playState, endTime: animation.effect?.getComputedTiming().endTime ?? null,
      name: 'animationName' in animation ? String(animation.animationName) : null,
      placeholder: target instanceof Element && target.matches('.animate-placeholder') && !!target.closest('[data-skeleton]'),
      liveMark: target instanceof Element && target.parentElement?.matches('svg[data-live-mark]') === true,
      runningStep: target instanceof Element && target.matches('[data-run-step-mark]') && target.closest('[data-run-step="running"]') !== null,
      startingCoordinator: target instanceof Element && target.closest('[data-coordinator-warm="preparing"]') !== null,
      deliveryStatus: target instanceof Element && target.matches('[role="status"]') && target.closest('[data-coordinator-row-control]') !== null,
      target: target instanceof Element ? target.outerHTML : null,
      targetIndex: target instanceof Element ? Array.from(document.querySelectorAll('.animate-placeholder')).indexOf(target) : -1,
      timing: animation.effect?.getTiming() };
  });
  await withFixtureCleanup(async () => {
    await expect.poll(async () => {
      motion = area ? await area.evaluate(sample) : await page.evaluate(sample, null);
      for (const each of motion.filter(excludedAmbientPulse)) if (!excluded.some(held => held.target === each.target && held.targetIndex === each.targetIndex && held.name === each.name)) excluded.push(each);
      return motionHasSettled(motion, finiteOnly);
    }).toBe(true);
  }, [{ name: 'motion-observation', run: async () => {
    if (finiteOnly) await test.info().attach('placeholder-motion-observation', { contentType: 'application/json',
      body: JSON.stringify({ excluded, lastObserved: motion, provesOriginalPMCause: false }, (_key, value) =>
        typeof value === 'number' && !Number.isFinite(value) ? String(value) : value) });
  } }], () => {});
}

const taskScenes = ["detail", "reader"];

/** Open the screen on the served copy through ordinary navigation and controls. */
export async function open(page: Page, runtime: Runtime, search = "") {
  const params = new URLSearchParams(search);
  const scene = params.get("scene");
  params.delete("scene");
  if (scene && taskScenes.includes(scene)) {
    params.set("task", "T111");
  }
  search = params.size ? `?${params}` : "";
  const feed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/events");
  await page.goto(`${runtime.origin}/${search}`);
  expect((await feed).status()).toBe(200);
  // The sample's only project names the list.
  await expect(page.getByRole('heading', { name: SAMPLE_PROJECT.title, level: 1 })).toBeVisible();
  await expect(page.locator(params.get('q')?.trim() ? '[data-result-list]' : '[data-time-tree]')).toBeAttached();
  await expect(page.locator("[data-workspace-notice]")).toHaveCount(0);
  await expect(page.locator('[data-progress-line="offline"]')).toHaveCount(0);
  if (scene) await openScene(page, scene);
}

/**
 * A Task's file read in the viewer, as a person opens it: the Files tab on its folder, then its row, found among the
 * work files when it is not a deliverable (a data file). `search` adds to the screen's URL (a theme, `agent=1`).
 * Returns the viewer.
 */
export async function openFile(page: Page, runtime: Runtime, task: string, path: string, search = "") {
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  await open(page, runtime, `?task=${task}&tab=files${folder ? `&path=${encodeURIComponent(folder)}` : ""}${search}`);
  const row = page.locator(`[data-file-row="${path}"]`), work = page.locator('[data-files-chip="work/"]');
  await row.or(work).first().waitFor();
  if (!await row.count()) await work.click();
  await row.click();
  const viewer = page.locator("[data-viewer]");
  await expect(viewer).toHaveCount(1);
  return viewer;
}

/** Diagnostics remain reachable without a permanent status footer. */
/**
 * Context, as a person opens it: its tab under the title, after History, opens the reader's Context page
 * (the task's facts and body, at every width), which the head's Back comes back from.
 */
export async function openAbout(reader: Locator) {
  const page = reader.locator("[data-task-about]").first();
  if (!await page.count()) await reader.locator('[data-reader-entry="about"]').click();
  await expect(page).toBeVisible();
  await settleMotion(reader.page(), reader);
}

/** Read up a little to bring a phone's folded reading header back before pressing its controls. */
export async function revealReaderHeader(reader: Locator) {
  await reader.locator('[data-reader-content]').evaluate(element => element.scrollBy(0, -80));
  await expect(reader.locator('[data-reader-header]')).toHaveAttribute('data-reader-header', 'shown');
  await settleMotion(reader.page());
}

/**
 * A task named in a text, followed as a person does: where the pointer can hover, its press goes to the
 * task; where it cannot, its press shows the task's card and only the card's Open goes to the task. `tap` presses with a finger.
 */
export async function openReference(reference: Locator, { tap = false }: { tap?: boolean } = {}) {
  if (tap) await reference.tap(); else await reference.click();
  if (await reference.page().evaluate(() => matchMedia("(hover: hover)").matches)) return;
  const open = reference.page().locator("[data-badge-card] [data-task-card-open]");
  await expect(open).toBeVisible();
  if (tap) await open.tap(); else await open.click();
}

export async function openDiagnostics(page: Page) {
  if (await page.getByRole("dialog").count()) await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("button", { name: "Loading and connection status…", exact: true }).click();
}


/** Scene recipes use the same URL and keyboard actions as a reader. */
async function openScene(page: Page, scene: string) {
  const reader = page.getByRole("complementary");
  if (taskScenes.includes(scene)) {
    // The URL opens and acknowledges T111. Settle its read count before
    // closing the reader or opening an input.
    await expect.poll(async () => {
      const response = await page.request.get(new URL("/api/person/notices", page.url()).toString());
      return (await response.json()).state?.reads?.["T111"] !== undefined;
    }).toBe(true);
  }
  if (scene === "detail") {
    await reader.getByRole("button", { name: "Close details" }).click();
    await expect(reader).toHaveCount(0);
    // Closing returns focus on the next frame, before a new input takes it.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
    if (scene === "settings") await page.getByRole("button", { name: "Settings", exact: true }).click();
  if (scene === "diagnostics") await openDiagnostics(page);
}

/** Selection is published before the moving slide arrives; independent gestures start after physical arrival. */
export async function waitForSliderArrival(modal: Locator) {
  await expect.poll(() => modal.locator('[data-image-slider-current]').evaluate(element => {
    const slide = element.getBoundingClientRect(), track = element.closest('[role=dialog]')!.getBoundingClientRect();
    return Math.abs(slide.x + slide.width / 2 - track.x - track.width / 2);
  })).toBeLessThan(1);
}

type Point = { x: number; y: number };
/** Real touch input through the browser: each step lists the fingers down at that moment, and the last step lifts them. */
export async function touch(page: Page, steps: Point[][]) {
  const session = await page.context().newCDPSession(page);
  let down = 0;
  for (const points of [...steps, []]) {
    const type = points.length === 0 ? "touchEnd" : points.length > down ? "touchStart" : "touchMove";
    await session.send("Input.dispatchTouchEvent", { type, touchPoints: points });
    down = points.length;
  }
  await session.detach();
}
/** Where `ALPACAWORK_SHOTS` names a folder, the screen as it is now is kept there as `<name>.png`, to show in a report. */
export async function keepShot(page: Page, name: string) {
  const shots = process.env.ALPACAWORK_SHOTS;
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}
/** One finger moving from `from` to `to` in a quick stroke. */
export const swipe = (page: Page, from: Point, to: Point) => touch(page, [[from],
  [{ x: (from.x * 2 + to.x) / 3, y: (from.y * 2 + to.y) / 3 }], [{ x: (from.x + to.x * 2) / 3, y: (from.y + to.y * 2) / 3 }], [to]]);

/**
 * Opens the coordinator's conversation from its input, which stands folded at the screen's foot.
 */
export async function openCoordinator(page: Page) {
  await page.locator("[data-coordinator-expand]").first().click();
  await expect(page.locator("[data-coordinator-panel]")).toBeVisible();
}
/** The conversation, open over the input (a surface of its own). */
export const coordinatorPanel = (page: Page) => page.locator("[data-coordinator-panel]");
/** Brings the coordinator's input up from its one line at the screen's foot, as a press on the line does. */
export async function writeCoordinator(page: Page) {
  await page.locator("[data-coordinator-write]").click();
  // The line brings up writing. If the conversation was already open, focus its input below it.
  if (await page.locator("[data-coordinator-panel]").isVisible()) await page.locator("[data-one-input]").click();
  await expect(page.locator("[data-one-input]")).toBeFocused();
}
/** Where the open task's Change state and Done stand: the conversation's row over its input. */
export const taskMoves = (page: Page) => page.locator("[data-task-action-slot]");
/** Holds the open task with its H key. */
export async function holdReader(page: Page) {
  await page.locator("aside[data-reader-mode] header [data-reader-task-id]").click();
  await page.keyboard.press("h");
}

/** Invoke the selected tree row's title key while the reader occupies the screen. */
export async function taskKey(page: Page, key: string) {
  const id = new URL(page.url()).searchParams.get("task")!;
  await page.locator(`[data-read="${id}"]`).dispatchEvent("keydown", { key });
}

/** Configure the shared local voice provider for coordinator input tests. */
export async function configureVoice(runtime: Runtime, endpoint = "http://127.0.0.1:9/v1/audio/transcriptions") {
  const path = join(runtime.root, "config.yaml");
  const config = parse(readFileSync(path, "utf8")) ?? {};
  config.voice = { provider: "local", endpoint, model: "test-local" };
  writeFixtureConfig(runtime.root, stringify(config));
  // Synchronous fixture commands can outlive an idle keep-alive socket. This preparation owns
  // its transport, so it cannot inherit a closed global fetch connection from an earlier command.
  const request = await apiRequest.newContext();
  try {
    const current = await request.get(`${runtime.origin}/api/commands/settings/get`);
    expect(current.ok()).toBe(true);
    const now = await current.json() as { revision: string };
    const saved = await commandPost(request, `${runtime.origin}/api/commands/settings/set`, {
      data: { key: "language", value: "en", expectedRevision: now.revision, timeZone: "Asia/Tokyo" } });
    expect(saved.ok()).toBe(true);
  } finally { await request.dispose(); }
}
/** A microphone that records at once and gives a few bytes when stopped. */
export const fakeMicrophone = () => {
  const stream = () => ({ getTracks: () => [{ stop() {} }] });
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => Promise.resolve(stream()) } });
  class Recorder {
    state = "inactive"; ondataavailable: ((event: { data: Blob }) => void) | null = null; onstop: (() => void) | null = null; onerror = null;
    static isTypeSupported(type: string) { return type === "audio/mp4"; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; this.ondataavailable?.({ data: new Blob(["voice"]) }); this.onstop?.(); }
  }
  Object.defineProperty(window, "MediaRecorder", { value: Recorder });
};

/** The text starts below an overlaid reader header; hidden headers leave the whole scrollport available. */
export async function visibleReaderContentTop(reader: Locator): Promise<number> {
  return reader.locator("[data-reader-content]").evaluate(area => {
    const top = area.getBoundingClientRect().top;
    const header = area.closest("aside")?.querySelector("[data-reader-header]");
    return Math.max(top, header?.getBoundingClientRect().bottom ?? top);
  });
}
