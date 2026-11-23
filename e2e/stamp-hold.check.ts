import { commandPost } from "./command-post.ts";
import type { Page } from "@playwright/test";
import { test, expect, settleMotion } from "./fixtures.ts";
import { startFakeCoordinator } from "./coordinator-fixture.ts";
import { placeResponsible } from "./fixture/responsible.ts";
import { patchTask, seedQuestion, seedReview } from "./fixture/task-state.ts";
import type { Runtime } from "./server.ts";
import { decideValues } from '../tests/helpers/task-values.ts';

// An answered card's stamp is held still long enough to be read before its copy leaves, the same for every way
// of answering at rest; what follows does not wait more than that. Sampled every frame, never timed by the test.
const reader = (page: Page) => page.locator("aside[data-reader-mode]");
const shown = (page: Page) => reader(page).locator("header [data-reader-task-id]");
test.use({ locale: "ja-JP", isolated: true, fixedTime: false, viewport: { width: 1440, height: 900 } });
/** One frame of the sampler: a hold measured from the frame after it began or to the frame before it ended. */
const FRAME = 17;
/**
 * How long the sampler watches a press's copies, from their first frame: well past the longest bound a departure is
 * allowed, so a copy shown again after leaving is seen. It observes; it allows no departure to take longer.
 */
const OBSERVED = 3000;
/** How long the coordinator may take to carry a press out: its Run starts, and runs the alpacawork CLI. */
const CARRIED_OUT = { timeout: 30_000 };
test.describe.configure({ timeout: 90_000 });

const post = async (page: Page, runtime: Runtime, path: string, data: object) => {
  const response = await commandPost(page.request, runtime.origin + "/api/" + path, { data });
  expect(response.ok(), await response.text()).toBe(true); return response.json();
};
/**
 * A project of `count` cards, each a top Task with its responsible placed, and the coordinator that carries out the
 * screen's presses (fixture/fake-coordinator.mjs); the reader opens on the first. A review's responsible Run reported
 * done on the user's request; a decide card's responsible asks the user while it works, its body's question.
 */
async function prepare(page: Page, runtime: Runtime, kind: "review" | "decide" = "review", count = 3) {
  startFakeCoordinator(runtime.root);
  const { task: project } = await post(page, runtime, "commands/task/new", { kind: "project", color: '#39659b', parent: "none", title: "Stamp" });
  const ids: string[] = [];
  for (let n = 0; n < count; n++) {
    const { task } = await post(page, runtime, "commands/task/new", { parent: project.id, title: `確認カード ${n + 1}`,
      ...kind === "decide" ? { values: decideValues(['案を選ぶ', ['案1 進める', '選択します'], ['案2 あとで', '保留します']]) } : {} });
    await placeResponsible(page.request, runtime.origin, task);
    if (kind === "review") seedReview(runtime.root, task.id, { title: "確認してください", description: "回答を確認してください。" });
    else {
      patchTask(runtime.root, task.id, { state: "doing" });
      seedQuestion(runtime.root, task.id, { to: "user", title: "確認してください", description: "回答を確認してください。" });
    }
    ids.push(task.id);
  }
  const index = await (await page.request.get(runtime.origin + '/api/workspace/live')).json();
  const order = index.home.filter((row: { taskId: string; section: string }) => row.section === 'review' && ids.includes(row.taskId))
    .map((row: { taskId: string }) => row.taskId);
  expect(order).toHaveLength(count);
  await page.goto(runtime.origin + `/?agent=1&project=${project.id}&task=${order[0]}`);
  await expect(shown(page)).toHaveText(order[0]!);
  // A press goes to the coordinator once its conversation can take one: the card offers holding from then on.
  await expect(page.locator('[data-swipe-mark="hold"]')).toHaveCount(1);
  await settleMotion(page);
  return order;
}

type Frame = { t: number; ghosts: number; x: number; y: number; opacity: number; stamp: number; scale: number };
/**
 * From the first frame a copy is drawn: where it stands, how opaque it and its stamp are, and the stamp's size.
 * The sampler alone ends its observation, OBSERVED ms after that first frame: only then is the last disappearance
 * final, a copy shown again later in the window counting too. It then stops its frames and observer and says whether a
 * copy of the press was still there. (A press may be admitted late, so the sampler waits for its first copy unbounded;
 * settled() bounds that wait.)
 */
async function sample(page: Page) {
  await page.evaluate((OBSERVED) => {
    const w = window as unknown as { stampFrames: Frame[]; stampSampler: number; stampStop?: () => void;
      stampTimes: { landed?: number; flight?: number; removed?: number; cleared?: number;
        timing?: { landing: EffectTiming; flight: EffectTiming }; observed?: { left: boolean } } };
    // One owner ends the previous sampler, including its native hook, observer and pending frame.
    w.stampStop?.();
    w.stampFrames = [];
    w.stampTimes = {};
    const sampler = w.stampSampler = (w.stampSampler ?? 0) + 1;
    let active = true, raf = 0, since: number | null = null;
    let target: HTMLElement | null = null, mark: HTMLElement | null = null;
    let landing: Animation | undefined, flight: Animation | undefined;
    const current = () => active && w.stampSampler === sampler;
    const bind = () => {
      if (target) return;
      target = document.querySelector<HTMLElement>("[data-flying-card]");
      mark = target?.querySelector<HTMLElement>("[data-stamp]") ?? null;
    };
    // Ready/finished can happen between frames. Keep the same native Animation and subject throughout,
    // before removal cancels them; another copy/mark must never replace these times.
    const timing = () => {
      if (!current()) return;
      if (landing?.startTime != null && w.stampTimes.landed === undefined)
        w.stampTimes.landed = Number(landing.startTime) + Number(landing.effect!.getComputedTiming().duration);
      if (flight?.startTime != null && w.stampTimes.flight === undefined) w.stampTimes.flight = Number(flight.startTime);
      if (landing && flight) w.stampTimes.timing = { landing: landing.effect!.getTiming(), flight: flight.effect!.getTiming() };
    };
    const animate = Element.prototype.animate;
    const observe: typeof animate = function (this: Element, ...args) {
      const animation = animate.apply(this, args);
      if (!current()) return animation;
      bind();
      // The stamp can be pressed on before its copy is in the page, where `bind` finds it: it is known by what it is.
      if (!landing && this instanceof HTMLElement && this.matches('[data-stamp]') && this.closest('[data-flying-card]')) landing = animation;
      else if (this === target && !flight && (animation.effect as KeyframeEffect).getKeyframes().at(-1)?.opacity === "0") flight = animation;
      else return animation;
      void animation.ready.then(timing, () => {});
      // A native departure can finish between RAF samples. Observe its actual final drawn box
      // before the product's finished callback removes this same copy; keyframes alone prove no motion.
      void animation.finished.then(() => {
        timing();
        if (current() && animation === flight && target?.isConnected && since !== null) capture(performance.now());
      }, () => {});
      return animation;
    };
    Element.prototype.animate = observe;
    // The sampled individual's removal and the last disappearance of the whole copy set are different facts.
    let copies = true;
    const observer = new MutationObserver(() => {
      if (!current()) { stop(); return; }
      if (since === null || !target) return;
      const now = performance.now() - since;
      if (!target.isConnected && w.stampTimes.removed === undefined) w.stampTimes.removed = now;
      const left = target.isConnected || document.querySelector("[data-flying-card]") !== null;
      if (copies && !left) w.stampTimes.cleared = now;
      copies = left;
    });
    const stop = () => {
      active = false;
      cancelAnimationFrame(raf);
      observer.disconnect();
      if (Element.prototype.animate === observe) Element.prototype.animate = animate;
      if (w.stampStop === stop) w.stampStop = undefined;
    };
    w.stampStop = stop;
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-flying-card"] });
    const capture = (now: number) => {
      if (since === null) return;
      const ghost = target?.isConnected ? target : null;
      const stamp = ghost && mark && ghost.contains(mark) ? mark : null;
      const s = stamp && getComputedStyle(stamp), m = s && s.transform !== "none" ? new DOMMatrix(s.transform) : null;
      const r = ghost?.getBoundingClientRect();
      w.stampFrames.push({ t: now - since, ghosts: ghost ? 1 : 0, x: r?.x ?? 0, y: r?.y ?? 0,
        opacity: ghost ? Number(getComputedStyle(ghost).opacity) : 0, stamp: s ? Number(s.opacity) : 0, scale: m ? Math.hypot(m.a, m.b) : 1 });
    };
    const frame = () => {
      if (!current()) { stop(); return; }
      // RAF's supplied timestamp can predate this observation in a busy frame. Use the actual monotonic clock.
      const now = performance.now();
      bind();
      if (target?.isConnected) since ??= now;
      timing();
      capture(now);
      if (since === null || now - since < OBSERVED) { raf = requestAnimationFrame(frame); return; }
      w.stampTimes.observed = { left: target!.isConnected || document.querySelector("[data-flying-card]") !== null };
      stop();
    };
    raf = requestAnimationFrame(frame);
  }, OBSERVED);
}
const frames = (page: Page) => page.evaluate(() => (window as unknown as { stampFrames: Frame[] }).stampFrames);
/**
 * The stamp has landed (from this frame on it stays at its own size and fully drawn until the copy moves), and the copy
 * first moves or fades.
 */
function times(all: Frame[]) {
  const first = all[0]!;
  // Removal is also an observed departure: a short fade can finish between two samples.
  const leavingAt = all.findIndex(f => !f.ghosts || Math.hypot(f.x - first.x, f.y - first.y) > 2 || f.opacity < 0.97);
  const before = all.slice(0, leavingAt < 0 ? all.length : leavingAt);
  let still = before.length;
  while (still > 0 && before[still - 1]!.ghosts && before[still - 1]!.stamp >= 0.995 && Math.abs(before[still - 1]!.scale - 1) < 0.003) still--;
  const readable = still < before.length ? before[still]!.t : Infinity;
  const leaving = leavingAt < 0 ? Infinity : all[leavingAt]!.t;
  return { readable, leaving, rightmost: Math.max(...all.filter(f => f.ghosts).map(f => f.x - first.x)) };
}
const read = (page: Page) => page.evaluate(() => {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--motion-read").trim();
  return Number.parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
});

/** ✔ (Done) on the open card: one press sends it to the coordinator. */
const approve = (page: Page, click: "click" | "dblclick" = "click") => page.locator("[data-task-done]")[click]();
/** What the sampler saw once it has ended its observation; a copy that never came fails here, in the poll's time. */
async function settled(page: Page) {
  const observed = () => page.evaluate(() => (window as unknown as { stampTimes: { observed?: object } }).stampTimes.observed !== undefined);
  try { await expect.poll(observed, { message: "the sampled copy appeared and its observation ended" }).toBe(true); }
  finally { await page.evaluate(() => { (window as unknown as { stampStop?: () => void }).stampStop?.(); }); }
  const all = await frames(page);
  expect(all.length, "the sampled copy appeared").toBeGreaterThan(0);
  const sampled = times(all);
  const { removed, cleared, observed: end } = await page.evaluate(() => (window as unknown as
    { stampTimes: { removed?: number; cleared?: number; observed: { left: boolean } } }).stampTimes);
  expect(end.left, "no copy of the press is left when the observation ends").toBe(false);
  expect(removed, "the sampled copy's removal was observed").toBeDefined();
  expect(cleared, "the press left no copy, observed").toBeGreaterThanOrEqual(removed!);
  // Gone: no copy of the press is left, the sampled one or any other standing in for it.
  return { ...sampled, gone: cleared! };
}

test("a definite refusal restores the answer while its submitted copy finishes the same departure", async ({ page, runtime }) => {
  const ids = await prepare(page, runtime);
  await page.route(url => url.pathname === '/api/commands/task/report', async route => {
    const { hash } = (await (await page.request.get(runtime.origin + '/api/task/view?task=' + ids[0])).json()).task;
    await post(page, runtime, 'commands/task/update', { task: ids[0], expectedTaskHash: hash, title: '変わった確認カード' });
    await route.continue();
  });
  await sample(page);
  await approve(page);
  await expect(page.locator("[data-toast]").getByRole("button", { name: "開く" })).toBeVisible(CARRIED_OUT);
  const { rightmost, gone } = await settled(page);
  // The optimistic departure is independent of its result; a refusal restores the answer, never rewinds its copy.
  expect(rightmost).toBeGreaterThan(100);
  expect(gone).toBeLessThan(1600);
  await expect(page.locator('[data-toast]')).toHaveCount(1);
  await expect(page.locator('[data-empty-deck]')).toHaveCount(0);
  expect((await (await page.request.get(runtime.origin + "/api/task/view?task=" + ids[0])).json()).task.state).toBe("waiting");
});

test("presses and keys during the hold do not reach the next card hidden under the stamp; one after it lands sends the copy off", async ({ page, runtime }) => {
  const ids = await prepare(page, runtime, "review", 4);
  const sent: {task:string;state:string}[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/commands/task/report") sent.push(request.postDataJSON());
  });
  /** What each message sent meant: the card it was about, and the press. */
  const pressed = () => sent.map(message => [message.task, message.state]);
  await shown(page).click();
  await sample(page);
  await page.keyboard.press("h");
  await expect(shown(page)).toHaveText(ids[1]!);
  // A second H while the stamp holds does not hold the card it hides; moving the focus and the browser's menu key go
  // on as they are.
  await page.evaluate(() => {
    const w = window as unknown as { keysKept: string[] };
    w.keysKept = [];
    document.addEventListener("keydown", event => { if (!event.defaultPrevented && event.key !== "Shift") w.keysKept.push(`${event.shiftKey ? "Shift+" : ""}${event.key}`); });
  });
  await page.keyboard.press("h");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+F10");
  expect(await page.evaluate(() => (window as unknown as { keysKept: string[] }).keysKept)).toEqual(["Shift+Tab", "Shift+F10"]);
  await settled(page);
  await expect(shown(page)).toHaveText(ids[1]!);
  await expect.poll(async () => (await (await page.request.get(runtime.origin + "/api/task/view?task=" + ids[0])).json()).task.state, CARRIED_OUT).toBe("held");
  expect((await (await page.request.get(runtime.origin + "/api/task/view?task=" + ids[1])).json()).task.state).toBe("waiting");
  expect(pressed()).toEqual([[ids[0], "held"]]);

  // A double click of ✔ admits once.
  await sample(page);
  await approve(page, "dblclick");
  await expect(shown(page)).toHaveText(ids[2]!);
  const { leaving, readable } = await settled(page);
  expect(leaving - readable).toBeGreaterThanOrEqual(await read(page) - FRAME);
  expect(pressed()).toEqual([[ids[0], "held"], [ids[1], "done"]]);

  // A press on the stamped card once it has landed: the copy goes now, and the press reaches nothing under it.
  const middle = (await reader(page).boundingBox())!;
  await shown(page).click();
  await sample(page);
  await page.keyboard.press("h");
  await expect(shown(page)).toHaveText(ids[3]!);
  await page.waitForTimeout(250);
  await page.mouse.click(middle.x + middle.width / 2, middle.y + middle.height / 2);
  const after = await settled(page);
  expect(after.leaving).toBeLessThan(200 + await read(page));
  await expect(shown(page)).toHaveText(ids[3]!);
  expect(pressed()).toEqual([[ids[0], "held"], [ids[1], "done"], [ids[2], "held"]]);
});
