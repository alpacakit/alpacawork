import { projectRows, questionRow } from './fixture/list-rows.ts';
import { readSnapshot } from './read-evidence.ts';
import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import { holdFixtureControl } from './fixture-writes.ts';
import type { Locator, Page, Request } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect, open, openDiagnostics, taskKey } from "./fixtures.ts";
import type { Runtime } from "./server.ts";
import { startFakeCoordinator } from "./coordinator-fixture.ts";
import { seedReview } from "./fixture/task-state.ts";
import { SAMPLE_PROJECT } from "./fixture/sample.ts";
import { readTaskLog } from "./task-history.ts";

// Each writing flow gets a separate generated root and never launches a Task's agent; the R8 cases' coordinator is the
// e2e one, which carries out what the screen sends it.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => { projectRows(root, ['T111']); questionRow(root, 'T112'); }); } });

async function watchFeed(page: Page) {
  const requests: string[] = [];
  const closed: string[] = [];
  const path = (request: Request) => new URL(request.url()).pathname;
  // The control tree (`/api/workspace/live`) is read again after every snapshot; only a new subscription would be a restart.
  page.on("request", (request) => {
    if (path(request) === "/api/events") requests.push(path(request));
  });
  page.on("requestfailed", (request) => { if (path(request) === "/api/events") closed.push("failed"); });
  page.on("requestfinished", (request) => { if (path(request) === "/api/events") closed.push("finished"); });
  await page.evaluate(() => {
    const seen = new Set<string>();
    // Any phase of the progress line but the fill that ends the first load says the feed was not live.
    const record = () => {
      const phase = document.querySelector("[data-progress-line]")?.getAttribute("data-progress-line");
      seen.add(phase && phase !== "done" ? phase : "connected");
    };
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["data-progress-line"] });
    record();
    (window as unknown as { feedSeen: Set<string> }).feedSeen = seen;
  });
  return async () => {
    expect(requests).toEqual([]);
    expect(closed).toEqual([]);
    expect(await page.evaluate(() => [...(window as unknown as { feedSeen: Set<string> }).feedSeen])).toEqual(["connected"]);
    await openDiagnostics(page);
    await expect(page.getByRole("dialog").getByText("Receiving updates", { exact: true })).toBeVisible();
  };
}

async function confirmLive(page: Page) {
  await openDiagnostics(page);
  await expect(page.getByRole("dialog").getByText("Receiving updates", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

/** T112 keeps its parent; the fixture's explicit user question makes its own row available for title keys. */
const ROW_T112 = "?task=T112";
const actionRefused = "Another change conflicts with this one.";



/**
 * A save made on the screen, followed as the person sees it. The served copy's own work can hold the
 * root past a write's wait; the write is then refused (409 busy) and nothing is written. Each refusal
 * shown is checked to have written nothing and is recorded on the test; the person then does what the
 * screen offers, a bounded number of times.
 */
async function saveAsShown(what: string, { saved, refused, unchanged, again }: {
  saved: () => Promise<boolean>; refused: Locator; unchanged: () => Promise<boolean>; again: () => Promise<void>;
}) {
  for (let attempt = 1; ; attempt++) {
    let outcome: "saved" | "refused" | null = null;
    await expect.poll(async () => (outcome = await saved() ? "saved" : await refused.isVisible() ? "refused" : null), { timeout: 20_000 }).not.toBeNull();
    if (outcome === "saved") return;
    test.info().annotations.push({ type: "refused", description: `${what}: attempt ${attempt}` });
    expect(await unchanged()).toBe(true);
    expect(attempt, `${what} refused ${attempt} times`).toBeLessThan(3);
    await again();
  }
}

/** Another operation holds the DB write transaction without changing data. */
async function holdControl(root: string) {
  return holdFixtureControl(root);
}
  test("G: decide and change the responsible person and see it on the same SSE connection", async ({ page, runtime }) => {
    // Three writes that each hold the control DB lock for about 3 s on the served copy.
    test.setTimeout(60_000);
    // A person places the responsible of a top Task only (its parent is the project), and one not yet at work, so
    // placing it starts no Run: a new request of the person's.
    const made = await fetch(`${runtime.origin}/api/task/new`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parent: SAMPLE_PROJECT.id, title: "Choose an agent" }) });
    expect(made.ok, await made.clone().text()).toBe(true);
    const task = ((await made.json()) as { task: { id: string } }).task.id;
    const subscriptions: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/events") subscriptions.push(request.url()); });
    const served = async () => await (await fetch(`${runtime.origin}/api/workspace/live`)).json() as { runs: { id: string }[]; tasks: { id: string; path: string }[] };
    const before = await served();
    await open(page, runtime, `?task=${task}`);
    const reader = page.getByRole("complementary");
    await expect(reader).toBeVisible();
    const decide = async (profile: string) => {
      // Deciding or changing the responsible person uses the row's A key; usable again once the feed is live.
      await expect.poll(async () => { await taskKey(page, "a"); return reader.locator("[data-responsible-section]").count(); }).toBe(1);
      const section = reader.locator("[data-responsible-section]");
      await section.getByRole("radio", { name: "New agent" }).check();
      await section.getByRole("combobox", { name: "Launch profile" }).selectOption(profile);
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/agent/assign' && response.request().method() === 'POST');
      await section.getByRole("button", { name: /^(Assign|Change)$/ }).click();
      await expect(section).toHaveCount(0, { timeout: 15_000 });
      expect((await saved).ok()).toBe(true);
      await expect.poll(async () => {
        const index = (await readSnapshot(page)).queries?.find((query: any) => query.key[0] === 'index')?.state.data;
        return index?.placements.find((placement: any) => placement.taskId === task && placement.active && placement.responsible)?.profileKey;
      }).toBe(profile);
      // Receipt and admission have separate lifetimes; Task remains selected.
      await expect(reader.locator("[data-report-feed]")).toBeVisible();
      };
    await decide("claude");
    await decide("codex");
    expect(subscriptions).toHaveLength(1);
    expect((await served()).runs.map((run) => run.id)).toEqual(before.runs.map((run) => run.id));
  });

  test("R5 a task moves under another parent from the reader, keeping its ID, on the same feed", async ({ page, runtime }) => {
    test.setTimeout(60_000);
    const subscriptions: string[] = [];
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/events") subscriptions.push(request.url()); });
    await open(page, runtime, ROW_T112);
    const reader = page.getByRole("complementary");
    await expect(reader).toBeVisible();
    await taskKey(page, "m");
    const section = reader.locator("[data-move-section]");
    // A task moves only within its project: here, from under September monthly close to right under the project itself.
    await section.getByRole("combobox", { name: "New parent" }).selectOption({ label: SAMPLE_PROJECT.title });
    await section.getByRole("button", { name: "Move", exact: true }).click();
    await expect(section).toHaveCount(0, { timeout: 15_000 });
    // The same ID now sits right under the project; the task that was above it in the reader's path is gone.
    await expect.poll(async () => {
      const response = await fetch(`${runtime.origin}/api/workspace/live`);
      if (!response.ok) return `HTTP ${response.status}`;
      const tree = await response.json() as { tasks: { id: string; parentId: string | null }[] };
      return tree.tasks.find((task) => task.id === "T112")?.parentId;
    }, { timeout: 15_000 }).toBe(SAMPLE_PROJECT.id);
    await expect(reader.getByRole("navigation")).not.toContainText("September monthly close", { timeout: 15_000 });
    expect(subscriptions).toHaveLength(1);
  });

  /**
   * T11, which the user asked for, with nothing unfinished below it, waiting for the user's review: its responsible's
   * Run reported it done (seedReview). Its parent is the project, so the approval wakes no one and nothing is queued to
   * run: no agent is launched (RG03). The screen's ✔ goes to the coordinator, which confirms the review quoting the
   * user's words (fixture/fake-coordinator.mjs).
   */
  async function awaitingReview(page: Page, runtime: Runtime) {
    startFakeCoordinator(runtime.root);
    const task = "T11";
    // The served tree read also waits for the root and may answer 409 busy (nothing read); it is asked again.
    const served = async () => {
      for (const deadline = Date.now() + 15_000; ;) {
        const response = await fetch(`${runtime.origin}/api/workspace/live`);
        if (response.ok) return await response.json() as { tasks: { id: string; parentId: string | null; hash: string; state: string; title: string }[];
          placements: { id: string; taskId: string; responsible: boolean }[]; runs: { id: string; state: string }[] };
        const { error } = await response.json() as { error: { code: string } };
        expect(error.code).toBe("busy");
        expect(Date.now()).toBeLessThan(deadline);
        await delay(250);
      }
    };
    // The opened view supplies current fields; the stored log is read whole.
    const current = async () => {
      await served();
      const response = await fetch(`${runtime.origin}/api/task/view?task=${encodeURIComponent(task)}`);
      expect(response.status).toBe(200);
      return (await response.json() as { task: { id: string; state: string; title: string } }).task;
    };
    const logged = async (kind: string) => (await readTaskLog(runtime.origin, task)).filter((log) => log.kind === kind).length;
    // Nothing unfinished may stay below a task that is approved (the finished-branch rule): the case moves T11's
    // unfinished children, with what is under them, right under the project first.
    const initial = (await served()).tasks, byId = new Map(initial.map(each => [each.id, each]));
    const depthBelow = (id: string) => {
      let depth = 0, at = byId.get(id);
      while (at?.parentId && at.parentId !== task) { depth++; at = byId.get(at.parentId); }
      return at?.parentId === task ? depth : -1;
    };
    // Move unfinished descendants first: changing the unfinished child invalidates the sample's older review
    // before that parent itself moves. Each real operation uses the revision after the preceding linked change.
    for (const kid of initial.filter(each => depthBelow(each.id) >= 0 && each.state !== "done" && each.state !== "stopped")
      .sort((a, b) => depthBelow(b.id) - depthBelow(a.id))) {
      const current = (await served()).tasks.find(each => each.id === kid.id)!;
      const moved = await fetch(`${runtime.origin}/api/task/move`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: kid.id, parent: SAMPLE_PROJECT.id, expectedTaskHash: current.hash }) });
      expect(moved.status, await moved.text()).toBe(200);
    }
    seedReview(runtime.root, task, { title: "Please review", description: "Please review the results." });
    await expect.poll(async () => (await current()).state, { timeout: 15_000 }).toBe("waiting");
    await open(page, runtime, `?task=${task}`);
    const reader = page.getByRole("complementary");
    await expect(reader).toBeVisible();
    /** An agent's retitle (`task update --title`); the screen only reads titles. */
    const retitle = async (title: string) => {
      const row = (await served()).tasks.find(each => each.id === task)!;
      const response = await fetch(`${runtime.origin}/api/task/update`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, title, expectedTaskHash: row.hash }) });
      expect(response.status, await response.text()).toBe(200);
    };
    /** Nothing the case wrote is left for the scheduler to start: the coordinator's own work over, no Run waits or runs. */
    const nothingQueued = () => expect.poll(async () => (await served()).runs.filter((run) => run.state === "queued" || run.state === "running"),
      { timeout: 15_000 }).toEqual([]);
    /** ✔ sends Approve to the coordinator at once, once the input can send it. */
    const approve = async () => {
      const action = page.locator("[data-task-done]");
      await expect(action).toBeEnabled({ timeout: 15_000 });
      await action.click();
    };
    return { task, current, logged, nothingQueued, reader, retitle, card: reader, approve };
  }

  test("R8 a review stays approvable after an agent's retitle, and approving from the screen finishes the task", async ({ page, runtime }) => {
    test.setTimeout(120_000);
    const { task, current, logged, nothingQueued, retitle, card, approve } = await awaitingReview(page, runtime);
    // A retitle after the wait does not change what the wait is for: the decision stays offered.
    await retitle("September monthly close (retitled)");
    await expect(card).toContainText("September monthly close (retitled)", { timeout: 15_000 });
    await approve();
    const toast = page.locator('[data-toast]').filter({ hasText: 'Could not mark' });
    await saveAsShown("approve", {
      saved: async () => (await current()).state === "done",
      refused: toast,
      unchanged: async () => (await current()).state === "waiting" && (await logged("review_approved")) === 0,
      again: async () => {
        await toast.getByRole("button", { name: "Open", exact: true }).click();
        await approve();
      },
    });
    await expect.poll(() => logged("retitled")).toBe(1);
    await expect.poll(() => logged("review_approved")).toBe(1);
    // The coordinator confirmed the review, quoting the words the press said for the user.
    expect((await readTaskLog(runtime.origin, task)).find((log) => log.kind === "review_approved")?.actor)
      .toMatchObject({ kind: "human" });
    await nothingQueued();
  });
  test("R8 while another operation holds the control DB, the approval is refused as shown, nothing is written, and the person's next try saves once", async ({ page, runtime }) => {
    test.setTimeout(120_000);
    const { current, logged, nothingQueued, approve } = await awaitingReview(page, runtime);
    const release = await holdControl(runtime.root);
    try {
      await approve();
      // Refused as shown: the control DB held, the press was not taken in or the coordinator could not write it.
      const toast = page.locator('[data-toast]').filter({ hasText: 'Could not mark' });
      await expect(toast.getByRole("button", { name: "Open", exact: true })).toBeVisible({ timeout: 15_000 });
    } finally { await release(); }
    expect((await current()).state).toBe("waiting");
    expect(await logged("review_approved")).toBe(0);
    await page.locator('[data-toast]').getByRole("button", { name: "Open", exact: true }).click();
    await approve();
    await expect.poll(async () => (await current()).state, { timeout: 15_000 }).toBe("done");
    await expect.poll(() => logged("review_approved")).toBe(1);
    await nothingQueued();
  });


