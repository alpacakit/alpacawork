import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import type { Locator, Page } from "@playwright/test";
import { test as base, expect as baseExpect, settleMotion } from "./fixtures.ts";
import { start, type Runtime } from "./server.ts";
import { startFakeCoordinator } from "./coordinator-fixture.ts";
import { patchTask, seedQuestion } from "./fixture/task-state.ts";
import { readTaskLog } from "./task-history.ts";
import { decideValues } from '../tests/helpers/task-values.ts';
import type { TaskValues } from '@alpacawork/contract';

// Auto-swipe. While a card waiting on the person is shown, an auto-swipe switch stands first in its task actions. Off
// (the default, nothing kept), a send from the input stays on the card: no stamp, no next card, and the input stays
// open. On, the send leaves: the card is stamped and the next one shown. Where the coordinator goes down by itself (a
// phone) the input goes down too; on a computer it stays up, emptied of what was sent. Done finishes the card and
// leaves either way. Once pressed it holds until it is pressed again: on the next card, on another task, after a
// reload and in another tab. On, it is opaque.
const expect = baseExpect.configure({ timeout: 20_000 });

const test = base.extend<{ runtime: Runtime; project: string }>({
  runtime: async ({}, use) => {
    const runtime = await start(undefined, startFakeCoordinator);
    try { await use(runtime); } finally { await runtime.stop(); }
  },
  project: async ({ runtime }, use) => {
    await use((await post<Written>(runtime, "commands/task/new", { kind: "project", color: '#39659b', parent: "none", title: "Auto-swipe check" })).task.id);
  },
});
test.describe.configure({ timeout: 90_000 });

type Written = { task: { id: string; hash: string } };
async function post<Result>(runtime: Runtime, path: string, body: object): Promise<Result> {
  const response = await fetch(`${runtime.origin}/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  baseExpect(response.status, text).toBe(200);
  return JSON.parse(text) as Result;
}
const DECIDE = decideValues(['Which option', ['Option1 Send current input', 'Send'], ['Option2 Decide later', 'Hold it']]);
async function requested(runtime: Runtime, project: string, title: string, values?: TaskValues) {
  const { task } = await post<Written>(runtime, "commands/task/new", { parent: project, title, ...values === undefined ? {} : { values } });
  await post(runtime, "commands/agent/assign", { task: task.id, role: "responsible", profile: "codex", expectedTaskHash: task.hash });
  return task.id;
}
/** A question to the user, asked at work. */
async function asked(runtime: Runtime, project: string, title: string) {
  const id = await requested(runtime, project, title, DECIDE);
  patchTask(runtime.root, id, { state: "doing" });
  seedQuestion(runtime.root, id, { to: "user" });
  return id;
}
/** The coordinator answered `task`'s question quoting the user's words. */
async function answered(runtime: Runtime, task: string) {
  await expect.poll(async () => (await readTaskLog(runtime.origin, task)).some(entry => entry.kind === "answered")).toBe(true);
}

const reader = (page: Page) => page.locator("aside[data-reader-mode]");
const shown = (page: Page) => reader(page).locator("header [data-reader-task-id]");
const autoSwipe = (page: Page) => page.locator("[data-auto-swipe]:visible");
/** Counts every stamped copy the page ever shows, so a case can say none was made. */
async function countFlights(page: Page) {
  await page.addInitScript(() => {
    const seen = { flights: 0 };
    (window as unknown as { seen: typeof seen }).seen = seen;
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes)
      if (node instanceof Element && node.hasAttribute("data-flying-card")) seen.flights++; }).observe(document, { childList: true, subtree: true });
  });
}
const flights = (page: Page) => page.evaluate(() => (window as unknown as { seen: { flights: number } }).seen.flights);

async function begin(page: Page, runtime: Runtime, project: string, task: string) {
  await page.goto(`${runtime.origin}/?project=${project}&task=${task}`);
  await expect(shown(page)).toHaveText(task);
  await settleMotion(page);
}
/** Opens the folded input from its capsule, writes `words` for the card and sends them with the send button or Enter. */
async function write(page: Page, words: string, by: "button" | "enter" = "button") {
  await page.locator("[data-coordinator-write]").click();
  const input = page.locator("[data-one-input]");
  await input.click();
  await input.press("End");
  await page.keyboard.insertText(words);
  await expect(page.locator("[data-ask-send]")).toBeEnabled();
  if (by === "enter") await page.keyboard.press("Enter");
  else await page.locator("[data-ask-send]").click();
}
/** Presses auto-swipe and closes the toast that says what it does, so what follows settles without its clock running. */
async function press(page: Page, button: Locator) {
  await button.click();
  await page.locator('[data-toast-id="reader-auto-swipe"] [data-toast-pin="close"]').click();
}

test("nothing kept, a send from the input stays on its card with the input open", async ({ page, runtime, project }) => {
  const first = await asked(runtime, project, "First question");
  await asked(runtime, project, "Next question");
  await countFlights(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await begin(page, runtime, project, first);
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "false");
  await write(page, `${first} go with the first option`);
  // Sent: the words leave the input; the card, the reader and the open input stay.
  await expect(page.locator("[data-one-input]")).not.toContainText("go with the first option");
  await settleMotion(page, reader(page));
  await expect(shown(page)).toHaveText(first);
  await expect(page.locator("[data-one-input]")).toBeVisible();
  expect(await flights(page)).toBe(0);
  await answered(runtime, first);
});

test("auto-swipe on, a send from the input leaves: the card is stamped, the reader goes on and the computer's input stays up, emptied", async ({ page, runtime, project }) => {
  const first = await asked(runtime, project, "First question");
  await asked(runtime, project, "Next question");
  await countFlights(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await begin(page, runtime, project, first);
  await press(page, autoSwipe(page));
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "true");
  await write(page, `${first} go with the first option`);
  await expect.poll(() => flights(page)).toBe(1);
  await expect(shown(page)).not.toHaveText(first);
  // Read once the leaving's motion is over: a fold that starts a frame later would pass a first read. The motion read is
  // the reader's leaving and the input's own card; the conversation's working dot and the row's sent arc turn until the
  // coordinator's work is done, which is not what this case reads.
  await settleMotion(page, reader(page));
  await settleMotion(page, page.locator("[data-coordinator-card]"));
  await expect(page.locator("[data-one-input]")).toBeVisible();
  await expect(page.locator("[data-coordinator-capsule]")).toHaveCount(0);
  await expect(page.locator("[data-one-input]")).not.toContainText("go with the first option");
  await answered(runtime, first);
});

test("auto-swipe holds until it is pressed again: another task, a reload and another tab keep it", async ({ page, runtime, project }) => {
  const first = await asked(runtime, project, "First question");
  const second = await asked(runtime, project, "Second question");
  await page.setViewportSize({ width: 1440, height: 900 });
  await begin(page, runtime, project, first);
  await press(page, autoSwipe(page));
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`[data-read="${second}"]`).click();
  await expect(shown(page)).toHaveText(second);
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "true");
  await page.locator(`[data-read="${first}"]`).click();
  await expect(shown(page)).toHaveText(first);
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(shown(page)).toHaveText(first);
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "true");
  // Another tab shows it as it is, and its press reaches this one.
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await begin(other, runtime, project, second);
  await expect(autoSwipe(other)).toHaveAttribute("aria-pressed", "true");
  await press(other, autoSwipe(other));
  await expect(autoSwipe(other)).toHaveAttribute("aria-pressed", "false");
  await expect(autoSwipe(page)).toHaveAttribute("aria-pressed", "false");
  await other.close();
});
