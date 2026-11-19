import { inertFixtureLaunch } from '../tests/helpers/agent-stub.ts';
import { projectRows } from './fixture/list-rows.ts';
import { seedReviewRun } from "./fixture-writes.ts";
import { expect, open, readOnlyTest, settleMotion, test } from "./fixtures.ts";
import { patchTask } from "./fixture/task-state.ts";
import { RunStore } from "@alpacawork/runs";
import { ControlStore } from "@alpacawork/db";

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => projectRows(root, ['T111'])); } });

const instructionText = 'Review the revised result';
function seedInstruction(root: string, note?: { title: string; description: string | null }) {
  const store = new ControlStore(root);
  const id = 'review-instruction';
  try { store.write(db => {
    const runs = new RunStore(root, { busyTimeoutMs: 1000 }, false, db);
    try { runs.write(tx => {
      const placement = tx.responsiblePlacement('T111')!;
      const prior = tx.requests().find(request => request.taskId === 'T111')!;
      tx.insertRequest({ id, taskId: 'T111', placementId: placement.id, placementRevision: placement.revision,
        taskHash: prior.taskHash, headRunId: tx.conversationHead(placement.id)?.id ?? null, waitCycleId: null,
        mode: 'new', body: `${instructionText}\nThe complete send-back`, purpose: 'review_send_back', author: { kind: 'human' },
        submittedAt: '2026-10-19T09:00:00.000Z', deliveryState: 'queued' });
      const run = tx.create({ task: 'T111', placementId: placement.id, requestId: id, agent: 'codex', role: 'owner',
        resumes: null, continues: false, session: null, caller: null, cwd: root,
        launch: inertFixtureLaunch('codex') }, 'fixture instruction');
      const running = { ...run, state: 'running' as const, started_at: run.created_at }; tx.update(running);
      const endedAt = new Date(Date.parse(run.created_at) + 1).toISOString();
      tx.finish({ ...running, state: 'succeeded', ended_at: endedAt }, { state: 'present', text: 'fixture reply' });
      db.prepare(`INSERT INTO task_log(id,task_id,ordinal,entry)
        SELECT ?,t.id,(SELECT count(*) FROM task_log WHERE task_id=t.id),? FROM tasks t WHERE external_id='T111'`)
        .run(`${id}-handoff`,JSON.stringify({ id: `${id}-handoff`, kind: 'reported', at: endedAt, title: 'Fixture handoff',
          description: null, actor: { kind: 'placement', placementId: placement.id }, fromState: 'doing', toState: 'waiting', runId: run.id }));
      db.prepare(`INSERT INTO task_log(id,task_id,ordinal,request_id,note_title,note_description)
        SELECT ?,t.id,(SELECT count(*) FROM task_log WHERE task_id=t.id),?,?,? FROM tasks t WHERE external_id='T111'`)
        .run(id,id,note?.title ?? null,note?.description ?? null);
      db.prepare("UPDATE tasks SET revision=revision+1 WHERE external_id='T111'").run();
    }); } finally { runs.close(); }
  }); } finally { store.close(); }
}
const instructionTest = readOnlyTest(root => seedInstruction(root));

instructionTest('a send-back is one full instruction on first read, reload and delta at 1440px', async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, '?task=T111&agent=1');
  const events = (await (await page.request.get(`${runtime.origin}/api/task/history?task=T111&limit=80`)).json()).events;
  const instruction = events.find((event: { title: string }) => event.title === instructionText);
  const rows = page.locator(`[data-report-key="request:${instruction.id}"], [data-report-key="log:T111:${instruction.id}"]`);
  await expect(rows).toHaveCount(1);
  const toggle = rows.locator('button[aria-expanded]');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(rows).toContainText('The complete send-back');
  await page.reload();
  await expect(rows).toHaveCount(1);
  const changed = 'review-delta';
  patchTask(runtime.root, 'T111', { logs: [{ id: changed, kind: 'reported', at: '2026-10-19T09:01:00.000Z',
    actor: { kind: 'human' }, fromState: null, toState: null, title: 'Supplement arrives', description: 'Keep this comment' }] });
  await expect(page.locator(`[data-report-key="log:T111:${changed}"]`)).toBeAttached();
  await expect(rows).toHaveCount(1);
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await expect(rows).toContainText('The complete send-back');
});

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`report column starts with the newest report at ${width}px`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height });
    await open(page, runtime, "?task=T111");
    const reader = page.getByRole("complementary");
    const reports = reader.locator("[data-report-key]");
    // The newest report stands open when it says more than its title (this one does not); every other row opens and
    // closes where it is, itself alone.
    await expect(reports.first()).toContainText("Please review");
    const closed = await reports.filter({ has: page.locator('article > div > button[aria-expanded="false"]') }).first().getAttribute("data-report-key");
    const toggle = reader.locator(`[data-report-key="${closed}"] article > div > button[aria-expanded]`);
    await expect(reports.first()).toBeInViewport();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The head keeps no tab: Context is an entry under the title.
    await expect(reader.locator("header").getByRole("button", { name: /Context/ })).toHaveCount(0);
    // Every reader goes on to the screen's foot, under the coordinator's input there: a window keeps the same
    // margin all round (the app bar is as tall as puts its controls on the window's head line), over the screen
    // it is the whole screen, and on a phone it is a sheet over two thirds of the screen at first.
    const box = (await reader.boundingBox())!;
    const input = (await page.locator("[data-coordinator-folded]").boundingBox())!;
    expect(box.y + box.height).toBeGreaterThanOrEqual(input.y + input.height);
    if (width === 390) {
      expect(box.y).toBeCloseTo(height / 3, -1);
      expect(box.y + box.height).toBeGreaterThanOrEqual(height - 1);
    } else if (await reader.getAttribute("data-reader-mode") === "overlay") {
      expect(box).toEqual({ x: 0, y: 0, width, height });
    } else {
      expect(box.y).toBe(12);
      expect(box.y + box.height).toBe(height - 12);
    }
  });
}

for (const [width, height, full] of [[1440, 900, false], [390, 844, false]] as const) {
  test(`the title scrolls while the close band and input stay put at ${width}px${full ? " full width" : ""}`, async ({ page, runtime }) => {
    await page.setViewportSize({ width, height });
    await open(page, runtime, `?task=T111${full ? "&width=full" : ""}`);
    const reader = page.getByRole("complementary");
    const band = reader.locator(".reader-header");
    const content = reader.locator("[data-reader-content]");
    const title = content.locator("[data-head-title]");
    // The coordinator's input stands at the screen's foot, outside the reader: it stays put too.
    const input = page.locator("[data-coordinator-folded]");
    await expect(title).toBeVisible();
    await expect(band.locator("[data-reader-frame-buttons]")).toBeVisible();
    const before = (await content.boundingBox())!;
    const inputBefore = (await input.boundingBox())!;
    // On a phone the reader is a sheet over two thirds of the screen.
    expect(before.height).toBeGreaterThan(width === 390 ? 300 : 690);
    // The sample's short report may fit at desktop height. Add reading length without changing the reader's own layout.
    await content.evaluate(element => { const longRead = document.createElement("div"); longRead.style.height = "1600px"; element.append(longRead); });
    // Let the added reading length lay out before the reading gesture, just as loaded report content does.
    await settleMotion(page, reader);
    await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
    if (width === 390) {
      // On a phone the header slides over the reading area: only the layer moves, never the text.
      const header = reader.locator("[data-reader-header]");
      await expect(header).toHaveAttribute("data-reader-header", "hidden");
      expect(await content.boundingBox()).toEqual(before);
      await settleMotion(page, reader);
      await page.clock.runFor(400);
      await content.evaluate(element => { element.scrollTop -= 200; });
      await expect(header).toHaveAttribute("data-reader-header", "shown");
      await expect.poll(async () => (await content.boundingBox())!.y).toBe(before.y);
    } else {
      const after = (await content.boundingBox())!;
      const bandBox = (await band.boundingBox())!;
      expect(after.y).toBe(before.y);
      expect(after.y).toBeGreaterThanOrEqual(bandBox.y + bandBox.height - 1);
      expect(await input.boundingBox()).toEqual(inputBefore);
      expect((await title.boundingBox())!.y).toBeLessThan(after.y);
    }
    await band.getByRole("button", { name: "Close details" }).focus();
    await page.keyboard.press("Tab");
    // The title is read, not a stop: Tab goes on into the reading.
    expect(await content.evaluate(element => element.contains(document.activeElement) && !document.activeElement!.closest("h2"))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
  });
}

test.describe(() => {
  test.use({ isolated: true });
});

// Real Reader, resources, HTTP decoder and SSE. Only response delivery is held, never the displayed data.
const reportLoadingTest = test.extend({ isolated: true });
const seedReportRange = (root: string) => patchTask(root, "T111", { logs: Array.from({ length: 120 }, (_, n) => ({
  id: `L-history-${n}`, at: new Date(Date.UTC(2026, 9, 1, 12, n)).toISOString(), kind: "reported", actor: { kind: "human" }, fromState: null, toState: null,
  title: `Report range ${n}`, description: `Body ${n}: ${"readable text ".repeat(12)}`,
})) });

reportLoadingTest('Reader history starts beside its view, reopens from cache, and waits only for a missing past page at 1280px', async ({ page, runtime }) => {
  seedReportRange(runtime.root);
  await page.setViewportSize({ width: 1280, height: 844 });
  const calls: string[] = [];
  let releaseView!: () => void, releaseHistory!: () => void, releasePast!: () => void;
  const viewGate = new Promise<void>(resolve => { releaseView = resolve; });
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const pastGate = new Promise<void>(resolve => { releasePast = resolve; });
  let failingPast = false;
  await page.route("**/api/task/view?**", async route => {
    if (new URL(route.request().url()).searchParams.get("task") !== "T111") return route.continue();
    const response = await route.fetch(); await viewGate; await route.fulfill({ response });
  });
  await page.route("**/api/task/history?**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("task") !== "T111") return route.continue();
    calls.push(url.search);
    const response = await route.fetch();
    if (url.searchParams.has("before")) {
      await pastGate;
      if (failingPast) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Past page unavailable", retry: "reread" } }) });
    } else await historyGate;
    await route.fulfill({ response });
  });
  try {
    await open(page, runtime, "?task=T111");
    // View is held: waiting for it before starting History would fail here.
    await expect.poll(() => calls.length).toBe(1);
    releaseView();
    const reader = page.locator("aside[data-reader-mode]");
    await expect(reader.locator('[data-skeleton="reportLines"]')).toBeAttached();
    await expect(reader.locator('[data-skeleton="reports"]')).toHaveCount(0);
    releaseHistory();
    await expect(reader.locator('[data-skeleton="reportLines"]')).toHaveCount(0);
    await expect(reader.locator('[data-report-key="log:T111:L-history-119"]')).toBeAttached();
    const heldCalls = calls.length;
    await reader.getByRole("button", { name: "Close details" }).click();
    await page.locator('[data-read="T111"]').click();
    await expect(reader.locator('[data-report-key="log:T111:L-history-119"]')).toBeAttached();
    expect(calls).toHaveLength(heldCalls);
    // Keep a DOM identity from the already read page while the past page is pending and fails.
    await reader.locator('[data-report-key="log:T111:L-history-100"]').evaluate(el => {
      (window as unknown as { retainedReport: Element }).retainedReport = el;
    });
    failingPast = true;
    const area = reader.locator("[data-reader-content]");
    await area.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => calls.some(call => call.includes("before="))).toBe(true);
    await expect(reader.locator('[data-skeleton="reportLines"]')).toBeAttached();
    expect(await page.evaluate(() => (window as unknown as { retainedReport: Element }).retainedReport.isConnected)).toBe(true);
    releasePast();
    await expect(reader.getByText("Could not read earlier History", { exact: false }).first()).toBeAttached();
    expect(calls.filter(call => call.includes('before='))).toHaveLength(1);
    expect(await page.evaluate(() => (window as unknown as { retainedReport: Element }).retainedReport.isConnected)).toBe(true);
    await expect(reader.locator('[data-skeleton="reports"], [data-skeleton="reportLines"]')).toHaveCount(0);
    failingPast = false;
    await reader.getByRole("button", { name: "Retry", exact: true }).last().click();
    await expect(reader.locator('[data-report-key="log:T111:L-history-0"]')).toBeAttached();
  } finally { releaseView(); releaseHistory(); releasePast(); }
});

reportLoadingTest('a real appended report keeps reading position and header visibility at 390px', async ({ page, runtime }) => {
  seedReportRange(runtime.root);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, "?task=T111");
  const area = page.locator("[data-reader-content]");
  await expect(area.locator('[data-report-key="log:T111:L-history-100"]')).toBeAttached();
  await area.evaluate(el => { el.scrollTop = 600; });
  await settleMotion(page);
  const header = page.locator("[data-reader-header]");
  await expect(header).toHaveAttribute("data-reader-header", "hidden");
  const before = await area.evaluate(el => {
    const row = [...el.querySelectorAll<HTMLElement>("[data-report-key]")].find(row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top)!;
    row.dataset.retainedAnchor = "";
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  });
  patchTask(runtime.root, "T111", { logs: [{ id: "L-history-arrival", at: "2026-10-19T09:00:00.000Z", kind: "reported", actor: { kind: "human" }, fromState: null, toState: null, title: "New report", description: "Arrived while reading" }] });
  await expect(area.locator('[data-report-key="log:T111:L-history-arrival"]')).toBeAttached();
  await settleMotion(page);
  const after = await area.evaluate(el => el.querySelector("[data-retained-anchor]")!.getBoundingClientRect().top - el.getBoundingClientRect().top);
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  await expect(header).toHaveAttribute("data-reader-header", "hidden");
  // Republishing an unchanged body is not a newly missing report range.
  patchTask(runtime.root, "T111", {});
  await settleMotion(page);
  await expect(area.locator('[data-skeleton="reports"], [data-skeleton="reportLines"]')).toHaveCount(0);
});

reportLoadingTest('an own Run finishing keeps the report being read through title growth and revalidation failure at 390px', async ({ page, runtime }) => {
  seedReportRange(runtime.root);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, runtime, "?task=T111");
  const area = page.locator("[data-reader-content]");
  await expect(area.locator('[data-report-key="log:T111:L-history-100"]')).toBeAttached();
  await area.evaluate(el => { el.scrollTop = 600; });
  await settleMotion(page);
  const before = await area.evaluate(el => {
    const row = [...el.querySelectorAll<HTMLElement>("[data-report-key]")].find(row => row.getBoundingClientRect().top >= el.getBoundingClientRect().top)!;
    row.dataset.retainedAnchor = "";
    return { top: row.getBoundingClientRect().top - el.getBoundingClientRect().top, title: el.querySelector<HTMLElement>("[data-head-title]")!.offsetHeight };
  });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let rereading = false;
  await page.route("**/api/task/history?**", async route => {
    if (new URL(route.request().url()).searchParams.get("task") !== "T111") return route.continue();
    rereading = true; await gate;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "unavailable", message: "Revalidation unavailable", retry: "reread" } }) });
  });
  const live = await (await page.request.get(`${runtime.origin}/api/workspace/live`)).json();
  const placement = live.placements.find((p: { taskId: string; responsible: boolean }) => p.taskId === "T111" && p.responsible);
  const task = live.tasks.find((t: { id: string }) => t.id === "T111");
  await area.evaluate(el => {
    const state = window as unknown as { reportReflowed: boolean; observeReport: boolean };
    state.reportReflowed = false; state.observeReport = true;
    const row = el.querySelector("[data-retained-anchor]")!;
    const sample = () => {
      if (!state.observeReport) return;
      // Existing rows must not also glide while scroll anchoring holds them in place.
      if (row.getAnimations().some(animation => animation.playState === "running" &&
        (animation.effect as KeyframeEffect).getKeyframes().some(frame => "transform" in frame))) state.reportReflowed = true;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  seedReviewRun(runtime.root, "T111", placement.id, task.hash);
  await expect.poll(() => rereading).toBe(true);
  await expect.poll(() => area.locator("[data-head-title]").evaluate(el => (el as HTMLElement).offsetHeight)).toBeGreaterThan(before.title);
  release();
  await settleMotion(page);
  await expect(area.getByText("Could not reload the latest information", { exact: false }).first()).toBeAttached();
  await settleMotion(page);
  const after = await area.evaluate(el => ({ top: el.querySelector("[data-retained-anchor]")!.getBoundingClientRect().top - el.getBoundingClientRect().top,
    title: el.querySelector<HTMLElement>("[data-head-title]")!.offsetHeight }));
  expect(await page.evaluate(() => {
    const state = window as unknown as { reportReflowed: boolean; observeReport: boolean };
    state.observeReport = false; return state.reportReflowed;
  })).toBe(false);
  expect(after.title).toBeGreaterThan(before.title);
  expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1);
  await expect(area.locator('[data-skeleton="reports"], [data-skeleton="reportLines"]')).toHaveCount(0);
});

const requestNote = { title: 'History title distinct from the instruction', description: 'Independent summary for readers. '.repeat(6).trim() };
const notedInstructionTest = readOnlyTest(root => seedInstruction(root, requestNote));
notedInstructionTest('one Request retains its note and nested delivered body at 390px',async({page,runtime},info)=>{
 await page.setViewportSize({width:390,height:900});
 await open(page,runtime,'?task=T111&agent=1');
 const row=page.locator('[data-report-key="request:review-instruction"]');await expect(row).toHaveCount(1);
 const toggle=row.locator('button[aria-expanded]').first();if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 await expect(row.locator('[data-row-words]')).toContainText(requestNote.title);
 await expect(row.getByText(requestNote.description,{exact:true})).toBeVisible();
 await settleMotion(page,row);
 const body=row.getByRole('button',{name:'Body sent to the agent'});await expect(body).toHaveAttribute('aria-expanded','false');
 await page.screenshot({path:info.outputPath(`note-open.png`)});
 await body.click();await settleMotion(page,row);
 await expect(row.getByText('The complete send-back',{exact:false})).toBeInViewport();
 await page.screenshot({path:info.outputPath(`note-body.png`)});
 await page.reload();await expect(row).toHaveCount(1);await expect(row.locator('[data-row-words]')).toContainText(requestNote.title);
 await expect(body).toHaveAttribute('aria-expanded','false');
 const events=(await(await page.request.get(`${runtime.origin}/api/task/history?task=T111&limit=80`)).json()).events.filter((e:{id:string})=>e.id==='review-instruction');
 expect(events).toHaveLength(1);expect(events[0].note).toEqual(requestNote);expect(events[0].summary).toBe(`${instructionText}\nThe complete send-back`);
});


// N6: the Task's own body and History are independently qualified reads. A cursor refusal must be visible,
// without withdrawing the permitted body or silently retrying a full History GET.
test.describe('qualified History refusal', () => {
  test.use({ isolated: true, fixedTime: false });
  for (const status of [403, 404] as const) test(`after ${status} keeps the permitted Task body and shows History failure`, async ({ page, runtime }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = 'T114', body = `N6 permitted body for ${status}`;
    // Cursor-only refusal needs a closed history; an open review correctly requires a whole refresh.
    patchTask(runtime.root, id, { values: { notes: body }, state: "doing", userRequested: true });
    await open(page, runtime, `?agent=1&task=${id}`);
    // The task's own text is its Context page, a step Back comes back from to the reports.
    const reader = page.locator('aside[data-reader-mode]'), own = reader.locator('[data-task-about]');
    await reader.locator('[data-reader-entry="about"]').click();
    await expect(own).toContainText(body);
    await reader.locator('header [data-reader-back]').click();
    await expect(reader.locator("[data-report-feed]")).toHaveAttribute("data-history-ready", "true");
    const initialHistory = await (await page.request.get(runtime.origin + `/api/task/history?task=${id}&children=1&limit=80`)).json();
    expect(initialHistory.events.some((event: { open?: boolean }) => event.open)).toBe(false);
    const requests: { url: string; status: number }[] = [];
    await page.route('**/api/task/history?**', async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('task') !== id) return route.continue();
      requests.push({ url: url.href, status });
      if (url.searchParams.has('after')) return route.fulfill({ status, json: { error: { code: status === 403 ? 'forbidden' : 'not_found', message: 'History refused', retry: 'fix' } } });
      return route.continue();
    });
    patchTask(runtime.root, id, { logs: [{ id: crypto.randomUUID(), kind: 'reported', at: new Date().toISOString(),
      actor: { kind: 'human' }, fromState: null, toState: null, title: 'N6 append', description: 'Actual append reaches the cursor transport' }] });
    await expect.poll(() => requests.filter(r => new URL(r.url).searchParams.has('after')).length).toBe(1);
    await expect(reader.locator('[data-report-feed] [data-read-failure]')).toBeVisible();
    await reader.locator('[data-reader-entry="about"]').click();
    await expect(own).toContainText(body);
    await expect(own).toBeVisible();
    await page.waitForTimeout(500);
    expect(requests.filter(r => !new URL(r.url).searchParams.has('after'))).toHaveLength(0);
    await info.attach('N6-actual-after-refusal-body-and-HTTP', { body: JSON.stringify({ requests, body, DOM: await reader.innerText() }), contentType: 'application/json' });
  });
});

// N5: the regular Retry button must obtain the complete anchor before the cut History.
test.describe('N5 Retry anchor order', () => {
  test.use({ isolated: true, fixedTime: false });
  test('Retry obtains the live anchor before recovering History after protection loss', async ({ page, runtime }, info) => {
    await open(page, runtime, '?task=T111&agent=1');
    const feed = page.locator('[data-report-feed]');
    await expect(feed).toHaveAttribute('data-history-ready', 'true');
    await page.evaluate(() => {
      const root = document.getElementById('root')!;
      const key = Object.keys(root).find(key => key.startsWith('__reactContainer'))!;
      let client: any; const seen = new Set();
      const visit = (fiber: any) => { if (!fiber || seen.has(fiber) || client) return; seen.add(fiber);
        if (fiber.memoizedProps?.client?.getQueryCache) client = fiber.memoizedProps.client;
        visit(fiber.child); visit(fiber.sibling); visit(fiber.stateNode?.current); };
      visit((root as any)[key]);
      if (!client) throw Error('Mounted QueryClient missing');
      (window as any).n5Client = client;
    });
    let failing = true, anchorHeld: (() => Promise<void>) | undefined;
    const http: { path: string; method: string }[] = [];
    await page.route('**/api/task/history?**', async route => {
      http.push({ path: new URL(route.request().url()).pathname, method: route.request().method() });
      if (failing) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'N5 History unavailable', retry: 'later' } } });
      return route.continue();
    });
    await page.evaluate(async () => {
      const c = (window as any).n5Client, root = c.getQueryData(['index']).root;
      const q = c.getQueryCache().find({ queryKey: ['task-history', root, 'T111'], exact: true });
      try { await c.fetchQuery({ ...q.options, staleTime: 0 }); } catch {}
    });
    await expect(feed.locator('[data-read-failure]')).toBeVisible();
    // The refusal must commit before this deliberate Query retirement can lose its protection.
    // Natural retention and pre-commit removal faults are covered separately in native IDB.
    await page.evaluate(() => { (window as any).n5BeforeToken = null; });
    const oldToken = await page.evaluate(() => new Promise(resolve => { const r = indexedDB.open('alpacawork-read-checkpoint', 3); r.onsuccess = () => { const db = r.result, tx = db.transaction('control'), read = tx.objectStore('control').get('current'); read.onsuccess = () => resolve(read.result?.epoch); tx.oncomplete = () => db.close(); }; }));
    await page.evaluate(token => { (window as any).n5BeforeToken = token; }, oldToken);
    await page.route('**/api/task/view?task=T112', route => route.fulfill({ status: 403,
      json: { error: { code: 'forbidden', message: 'N5 C refused', retry: 'fix' } } }));
    await page.evaluate(async () => {
      const c = (window as any).n5Client, root = c.getQueryData(['index']).root;
      const template = c.getQueryCache().find({ queryKey: ['task', root, 'T111'], exact: true });
      const q = c.getQueryCache().build(c, { ...template.options, queryHash: undefined, queryKey: ['task', root, 'T112'],
        queryFn: async () => { const response = await fetch('/api/task/view?task=T112'); const body = await response.json();
          throw Object.assign(new Error(body.error.message), body.error); } });
      try { await q.fetch(); } catch {}
    });
    // Wait for the production persistence writer's refusal transaction (not just request success).
    await page.waitForFunction(() => new Promise<boolean>(resolve => {
      const r = indexedDB.open('alpacawork-read-checkpoint', 3);
      r.onsuccess = () => { const db = r.result, tx = db.transaction('control'), request = tx.objectStore('control').get('current');
        request.onsuccess = () => resolve(!!request.result?.epoch && request.result.epoch !== (window as any).n5BeforeToken); tx.oncomplete = () => db.close(); };
      r.onerror = () => resolve(false);
    }));
    http.length = 0;
    await page.route('**/api/workspace/live', async route => {
      http.push({ path: '/api/workspace/live', method: route.request().method() });
      anchorHeld = () => route.continue();
    });
    await page.evaluate(() => { const c = (window as any).n5Client, root = c.getQueryData(['index']).root;
      c.removeQueries({ queryKey: ['task', root, 'T112'], exact: true }); });
    failing = false;
    await feed.locator('[data-read-failure]').getByRole('button').click();
    await expect.poll(() => http.map(row => row.path)).toEqual(['/api/workspace/live']);
    await anchorHeld!();
    await expect(feed).toHaveAttribute('data-history-ready', 'true');
    await expect.poll(() => http.map(row => row.path)).toEqual(['/api/workspace/live', '/api/task/history']);
    expect(http.every(row => row.method === 'GET')).toBe(true);
    await info.attach('N5-HTTP-order', { body: JSON.stringify(http), contentType: 'application/json' });
  });
});
