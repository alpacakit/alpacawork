import { projectRows } from './fixture/list-rows.ts';
import type { Page } from "@playwright/test";
import { expect, open, settleMotion, test } from "./fixtures.ts";
import { patchTask } from "./fixture/task-state.ts";
import { runningRunsTest } from "./fixture/running-runs.ts";

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => projectRows(root, ['T111'])); } });

/** Every motion the page shows, once each as it starts: what it moves, how, and when it waits to. */
/** `at` is when it is first seen; `started` is its own start on the page's timeline, once it has one. */
type Motion = { at: number; started?: number; what: string; kind: string; delay: number; duration: number; frames: string; end?: number };
declare global { interface Window { motions: Motion[] } }
async function recordMotion(page: Page) {
  await page.addInitScript(() => {
    window.motions = [];
    const seen = new WeakSet<Animation>();
    const describe = (target: Element | null) => !target ? "?" : target.getAttribute("data-motion-key") ? `row:${target.getAttribute("data-motion-key")}`
      : target.matches("aside[data-reader-mode]") ? "reader" : target.matches("[data-reader-content]") ? "content"
      : target.closest("[data-skeleton]") ? `skeleton${target.closest("aside") ? ":reader" : ":list"}` : target.matches("[data-disclosure-body]") ? "disclosure"
      : target.matches("[data-sheet]") ? "sheet" : target.tagName.toLowerCase();
    const unstarted = new Map<Animation, Motion>();
    const note = (animation: Animation) => {
      if (seen.has(animation)) return;
      seen.add(animation);
      const effect = animation.effect as KeyframeEffect | null;
      const timing = effect?.getTiming();
      const motion: Motion = { at: Math.round(performance.now()), what: describe(effect?.target ?? null),
        kind: "animationName" in animation ? `css:${String(animation.animationName)}` : "transitionProperty" in animation ? `transition:${String(animation.transitionProperty)}` : "waapi",
        delay: Number(timing?.delay ?? 0), duration: Number(timing?.duration ?? 0),
        frames: JSON.stringify((effect?.getKeyframes?.() ?? []).map(({ transform, opacity, translate }) => ({ transform, opacity, translate }))) };
      window.motions.push(motion);
      if (animation.startTime !== null) motion.started = Number(animation.startTime); else unstarted.set(animation, motion);
      const ended = () => { motion.end ??= Math.round(performance.now()); };
      animation.addEventListener("finish", ended);
      animation.addEventListener("cancel", ended);
    };
    // Scripted motions are noted as they start: on a busy machine a short fade can begin and end between two frames.
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      note(animation);
      return animation;
    };
    const sample = () => {
      for (const [animation, motion] of unstarted) if (animation.startTime !== null) { motion.started = Number(animation.startTime); unstarted.delete(animation); }
      for (const animation of document.getAnimations()) note(animation);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

/** Two reports written while the reader was away: a line, and a report changing the state, which opens as the newest. */
const fresh = (tag: string) => [
  { id: `report-arrival-line-${tag}`, kind: "reported" as const, at: "2026-09-25T14:15:00+09:00", actor: { kind: "human" }, fromState: null, toState: null,
    title: `A note written while the reader was away: ${tag}`, description: "Older of the two." },
  { id: `report-arrival-story-${tag}`, kind: "reported" as const, at: "2026-09-25T14:18:00+09:00", actor: { kind: "human" }, fromState: "waiting" as const, toState: "doing" as const,
    title: `Picked up again with the corrected invoice: ${tag}`, description: "The newest report, opened in place of the one read before." },
];
const keys = (page: Page) => page.locator("aside[data-reader-mode] [data-report-feed] li[data-motion-key]")
  .evaluateAll(each => each.map(row => row.getAttribute("data-motion-key")));
async function beforeHistoryAnswer(page: Page, wait: () => Promise<void>) {
  await page.route(url => url.pathname === "/api/task/history", async route => {
    await wait();
    await route.continue();
  });
}
/** Leaves the page, writes what comes meanwhile and comes back with History held until the saved rows are drawn: a fixed
 * network delay races restoration, and rows read before they are drawn are no news. */
async function comeBackTo(page: Page, origin: string, write: () => void) {
  const saved = await keys(page);
  // The page saves what it read a moment after it reads it; leaving sooner comes back to nothing saved.
  await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
    const open = indexedDB.open("alpacawork-read-checkpoint");
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("slots")) { db.close(); resolve(false); return; }
      const all = db.transaction("slots").objectStore("slots").getAll();
      all.onerror = () => { db.close(); resolve(false); };
      all.onsuccess = () => { db.close(); resolve(all.result.some(slot => { const text = JSON.stringify(slot); return text.includes("task-history") && text.includes("T111"); })); };
    };
  }))).toBe(true);
  await page.goto("about:blank");
  write();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await beforeHistoryAnswer(page, async () => { entered(); await gate; });
  try {
    await page.goto(`${origin}/?task=T111&agent=1`);
    await waiting;
    await expect.poll(() => keys(page)).toEqual(saved);
  } finally { release(); }
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) test.describe(`${width}px`, () => {
  test.use({ isolated: true, viewport: { width, height } });

  // Nothing in a row's arrival reads the width; the phone's differences are the reader coming in and its head, below.
  if (width === 1440) test(`a reload draws the saved History, and the newer reports then slide in at the top`, async ({ page, runtime }) => {
    await recordMotion(page);
    await open(page, runtime, "?task=T111&agent=1");
    const reader = page.locator("aside[data-reader-mode]");
    await expect(reader.locator("[data-report-feed] li[data-motion-key]").first()).toBeVisible();
    await settleMotion(page, reader);
    // What fills the feed as it is first read is not news: no row moves.
    expect(await page.evaluate(() => window.motions.filter(each => each.what.startsWith("row:")))).toEqual([]);
    await comeBackTo(page, runtime.origin, () => patchTask(runtime.root, "T111", { logs: fresh(`reload-${width}`) }));
    const newest = reader.locator(`[data-report-key="log:T111:report-arrival-story-reload-${width}"]`);
    await expect(newest).toBeVisible();
    await settleMotion(page, reader);
    await page.waitForTimeout(600);
    const motions = await page.evaluate(() => window.motions);
    console.log(width, "reload", JSON.stringify(motions));
    const after = await keys(page);
    expect(after.slice(0, 2)).toEqual([`log:T111:report-arrival-story-reload-${width}`, `log:T111:report-arrival-line-reload-${width}`]);
    // The two new rows fade in as they land; every row that was there glides down to its place.
    const rows = motions.filter(each => each.what.startsWith("row:"));
    // Counted by row: an arriving row both fades in and settles into its place.
    expect([...new Set(rows.filter(each => each.what.includes("report-arrival-")).map(each => each.what))].sort())
      .toEqual([`row:log:T111:report-arrival-line-reload-${width}`, `row:log:T111:report-arrival-story-reload-${width}`]);
    const glided = rows.filter(each => !each.what.includes("report-arrival-") && each.frames.includes("translateY("));
    expect(glided.length).toBeGreaterThan(0);
    // One change, one motion: the report read before folds at once instead of running its own disclosure alongside.
    expect(motions.filter(each => each.what === "disclosure")).toEqual([]);
    // The reader's placeholder, if any, is gone before the newer reports come.
    const firstRow = Math.min(...rows.map(each => each.at));
    for (const each of motions.filter(each => each.what === "skeleton:reader")) expect(each.end ?? Infinity).toBeLessThanOrEqual(firstRow);
  });
});

// A change above the reports that leaves them as they were (the Working row appearing as a Run starts) moves the rows
// under it as a report arriving does: they glide to their new places rather than jump there.
runningRunsTest("a row appearing above the reports glides the rows that were there", async ({ page, runtime, scene }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await recordMotion(page);
  await page.goto(`${runtime.origin}/?task=${scene.queuedOnly}&agent=1`);
  const reader = page.locator("aside[data-reader-mode]");
  await expect(reader.locator("[data-report-feed] li[data-report-key]").first()).toBeVisible();
  await settleMotion(page, reader);
  // Past the list's first filling in, which moves nothing.
  await page.waitForTimeout(1200);
  const before = await keys(page);
  await page.evaluate(() => { window.motions = []; });
  await scene.start(scene.queuedOnlyRun);
  const working = reader.locator("[data-report-feed] [data-working-row]");
  await expect(working).toBeVisible({ timeout: 15_000 });
  // The Working row's mark pulses as long as the Run goes: only motions that end are waited for.
  await settleMotion(page, reader, true);
  const after = await keys(page);
  expect(after.filter(key => !before.includes(key!))).toHaveLength(1);
  expect(after.filter(key => before.includes(key!))).toEqual(before);
  const glided = new Set((await page.evaluate(() => window.motions))
    .filter(each => each.what.startsWith("row:") && each.frames.includes("translateY(")).map(each => each.what.slice(4)));
  expect(before.filter(key => !glided.has(key!))).toEqual([]);
});
