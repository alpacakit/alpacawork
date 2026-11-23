import { projectRows } from './fixture/list-rows.ts';
import { ControlStore } from '@alpacawork/db';
import { readOnlyTest, expect, open } from "./fixtures.ts";
import { SAMPLE_NOW } from "./fixture/sample.ts";
import { patchTask } from "./fixture/task-state.ts";

// The probed working, held and todo Tasks are top rows; review children remain genuine user-turn rows.
// T111's Runs draw its work.
const test = readOnlyTest(root => {
  projectRows(root, ['T111', 'T114', 'T117']);
  patchTask(root, "T114", { userRequested: true });
  const control = new ControlStore(root, {busyTimeoutMs:1000}, true);
  let placementId: string;
  try { placementId = control.read(db => String(db.prepare("SELECT id FROM placements WHERE task_id='T112' AND responsible=1 AND ended_at IS NULL").get()!.id)); }
  finally { control.close(); }
  // Probe an own review, rather than a human wait inherited from a child in the old projection.
  patchTask(root, "T112", { state: 'waiting', userRequested: true, logs: [{ id: 'Lhover-own-review', kind: 'reported',
    at: '2026-09-25T13:10:00+09:00', fromState: 'doing', toState: 'waiting', actor: { kind: 'placement', placementId },
    title: 'Own review marker', description: 'The Task itself asks for confirmation' }] });
  for (const [id, state] of [["T115", "done"], ["T116", "stopped"], ["T118", "error"]] as const)
    patchTask(root, id, { state, userRequested: state === "error", logs: [{ id: `Lhover-${state}`, kind: "reported",
      at: "2026-09-25T12:00:00+09:00", fromState: "todo", toState: state,
      title: `State: ${state}`, description: `Detailed body: ${state}`, actor: { kind: "human" } }] });
  patchTask(root, "T117", { state: "held", userRequested: true, logs: [{ id: "Lhover-held", kind: "reported",
    at: "2026-09-25T12:00:00+09:00", fromState: "todo", toState: "held",
    title: "Review later", description: "Reconciliation is on hold.", actor: { kind: "human" } }] });
});

// A recursive check covers every row and nested mark, not just one known fixture's report.
function detailFields(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, at) => detailFields(item, `${path}[${at}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) =>
    (["body", "description", "text", "extracts", "requestHeads", "questions"].includes(key) || key === "summary" && typeof item === "string")
      ? [`${path}.${key}`] : detailFields(item, `${path}.${key}`));
}

test("list responses carry no hover details and hovering or focusing titles and marks fetches no detail", async ({ page, runtime }) => {
  const details: string[] = [];
  const completed: string[] = [];
  const payloads: Promise<{ path: string; body: unknown }>[] = [];
  const detailKey = (url: string) => {
    const { pathname, searchParams } = new URL(url);
    return ["/api/task/view", "/api/task/history", "/api/task/request-body"].includes(pathname)
      ? `${pathname}:${searchParams.get("task")}` : null;
  };
  page.on("request", request => {
    const key = detailKey(request.url());
    if (key) details.push(key);
  });
  const collect = (response: import("@playwright/test").Response) => {
    const path = new URL(response.url()).pathname;
    const key = detailKey(response.url());
    if (key && response.ok()) completed.push(key);
    if (["/api/workspace/live", "/api/task/timeline", "/api/task/finished", "/api/task/shelved"].includes(path))
      payloads.push(response.json().then(body => ({ path, body })));
  };
  page.on("response", collect);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(page, runtime, "?agent=1&zoom=21600000");
  // Your turn rows warm their detail and history on startup, independently of hover or focus.
  const reviewTitles = page.locator('[data-row-section="review"] [data-read]');
  await expect(reviewTitles.first()).toBeVisible();
  const startupReads = await reviewTitles.evaluateAll(titles => titles.flatMap(title => {
    const id = title.getAttribute("data-read");
    return [`/api/task/view:${id}`, `/api/task/history:${id}`];
  }).sort());
  await expect.poll(() => [...completed].sort()).toEqual(startupReads);
  // Bootstrap may arrive through SSE without a workspace/live browser request. Check the same public list response directly.
  const live = await page.request.get(`${runtime.origin}/api/workspace/live`);
  expect(live.ok()).toBe(true);
  payloads.push(live.json().then(body => ({ path: "/api/workspace/live", body })));
  const folded = page.locator('[data-section] button[aria-expanded="false"]');
  for (let left = await folded.count(); left > 0; left--) await folded.first().click();
  for (const id of ["T11", "T111", "T112", "T113", "T114", "T117", "T118"])
    await expect(page.locator(`[data-row="${id}"] [data-read="${id}"]`)).toBeVisible();
  const marks = page.locator('[data-row="T112"] [data-mark]');
  await expect(marks.first()).toBeVisible();
  const titles = page.locator("[data-row] [data-read]");
  for (const title of await titles.all()) {
    await title.hover();
    await title.focus();
    await page.clock.runFor(700);
    await expect(page.locator("[data-reading-note], [data-task-peek]")).toHaveCount(0);
  }
  for (const mark of await marks.all()) {
    // Causally unrelated marks can overlap at this zoom. Exercise the real pointer destination and each
    // keyboard target; an occluded mark cannot be a pointer destination, but remains focusable.
    const box = (await mark.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await mark.focus();
    await page.clock.runFor(700);
    await expect(page.locator("[data-reading-note], [data-task-peek]")).toHaveCount(0);
  }
  expect([...details].sort()).toEqual(startupReads);
  page.off("response", collect);
  const replies = await Promise.all(payloads);
  expect(replies.some(reply => reply.path === "/api/workspace/live")).toBe(true);
  expect(replies.some(reply => reply.path === "/api/task/timeline")).toBe(true);
  for (const reply of replies) {
    expect(detailFields(reply.body), reply.path).toEqual([]);
    if (reply.path === "/api/task/timeline") for (const item of (reply.body as { lanes: { events: { kind: string; event?: object }[] }[] }).lanes.flatMap(lane => lane.events))
      if (item.kind === "note") expect(Object.keys(item.event!).filter(key =>
        !["id", "kind", "taskId", "at", "state", "mark", "displayed"].includes(key)), "list notes contain no detail links").toEqual([]);
  }
  const ids = await titles.evaluateAll(rows => rows.map(row => row.getAttribute("data-read")!));
  const coldId = ids.find(id => !details.includes(`/api/task/view:${id}`));
  expect(coldId, "a listed task has no prefetched detail").toBeDefined();
  const fetched = page.waitForResponse(response => detailKey(response.url()) === `/api/task/view:${coldId}`);
  await page.locator(`[data-row] [data-read="${coldId}"]`).click();
  expect((await fetched).ok()).toBe(true);
  await expect(page.getByRole("complementary").locator(`[data-reader-title="${coldId}"]`)).toBeVisible();
});

for (const input of ["keyboard", "touch"] as const) test(`a report mark opens its matching reader report with ${input}`, async ({ page, browser, runtime }) => {
  const context = input === "touch" ? await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }) : null;
  const targetPage = context ? await context.newPage() : page;
  try {
    if (context) await targetPage.clock.setFixedTime(new Date(SAMPLE_NOW));
    if (!context) await targetPage.setViewportSize({ width: 1440, height: 1000 });
    await open(targetPage, runtime, "?agent=1&zoom=21600000&strip=on");
    const mark = targetPage.locator('[data-row="T112"] [data-pin]').last();
    await expect(mark).toBeVisible();
    const key = await mark.getAttribute("data-mark");
    expect(key).toBeTruthy();
    if (input === "touch") await mark.tap();
    else if (input === "keyboard") { await mark.focus(); await mark.press("Enter"); }
    else await mark.click();
    await expect(targetPage.locator('[data-reader-task-id]')).toHaveText("T112");
    await expect.poll(() => new URL(targetPage.url()).searchParams.get("event")).toBe(key);
    const report = targetPage.locator(`[data-report-key="${key}"]`);
    await expect(report).toBeVisible();
    await expect(report.locator("[data-report-card-open]")).toBeVisible();
    await expect(targetPage.locator("[data-reading-note]")).toHaveCount(0);
  } finally { await context?.close(); }
});
