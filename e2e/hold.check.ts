import { commandPost } from "./command-post.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Ball } from "@alpacawork/contract";
import type { CoordinatorMessageInput } from "@alpacawork/contract/coordinator";
import { test, expect, open, settleMotion, holdReader, taskMoves, taskKey } from "./fixtures.ts";
import { startFakeCoordinator } from "./coordinator-fixture.ts";
import { placeResponsible } from "./fixture/responsible.ts";
import { SAMPLE_PROJECT } from "./fixture/sample.ts";
import { patchTask, seedQuestion, seedReview } from "./fixture/task-state.ts";
import { readTaskLog } from "./task-history.ts";
import type { Runtime } from "./server.ts";
import { decideValues } from '../tests/helpers/task-values.ts';
import type { TaskValues } from '@alpacawork/contract';

test.use({ isolated: true });
/** How long the coordinator may take to carry a press out: its Run starts, and runs the alpacawork CLI. */
const CARRIED_OUT = { timeout: 30_000 };
const QUESTION = decideValues(['Publication scope', ['Internal', 'Publish internally only'], ['Everyone', 'Publish to everyone']]);

const post = async (page: Page, runtime: Runtime, path: string, data: object) => {
  const response = await commandPost(page.request, `${runtime.origin}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
};
const view = async (page: Page, runtime: Runtime, id: string): Promise<{ state: string; hash: string }> =>
  (await (await page.request.get(`${runtime.origin}/api/task/view?task=${id}`)).json()).task;
type Live = { tasks: Array<{ id: string; state: string; hash: string; ball: Ball | null }>;
  placements: Array<{ taskId: string; responsible: boolean; revision: number }> };
const live = async (page: Page, runtime: Runtime) => await (await page.request.get(`${runtime.origin}/api/workspace/live`)).json() as Live;
/** A top Task of the sample's project, with its responsible placed. */
async function placed(page: Page, runtime: Runtime, title: string, values?: TaskValues): Promise<string> {
  const { task } = await post(page, runtime, "task/new", { parent: SAMPLE_PROJECT.id, title, ...values === undefined ? {} : { values } });
  return (await placeResponsible(page.request, runtime.origin, task)).id;
}
/** A top Task whose responsible's Run reported done on the user's request: a review waiting on the user. Returns its Run. */
async function review(page: Page, runtime: Runtime, title: string, report: { title: string; description: string }) {
  const id = await placed(page, runtime, title);
  return { id, run: seedReview(runtime.root, id, report) };
}
/**
 * A top Task whose responsible asks the user, while it works, its body's question. The sample's extracts read no
 * question, so the default rule is added first. Returns its question.
 */
async function question(page: Page, runtime: Runtime, title: string, asked: { title: string; description: string }) {
  const id = await placed(page, runtime, title, QUESTION);
  patchTask(runtime.root, id, { state: "doing" });
  return { id, question: seedQuestion(runtime.root, id, { to: "user", ...asked }) };
}
/** A person holds the Task themselves (task report --state held is the user's to ask for). */
const hold = async (page: Page, runtime: Runtime, id: string, words: { title: string; description: string }) =>
  post(page, runtime, "task/report", { task: id, state: "held", opId: crypto.randomUUID(), ...words, expectedTaskHash: (await view(page, runtime, id)).hash });

test("holding a confirmation advances the reader and restores the original turn from the list", async ({ page, runtime }) => {
  test.setTimeout(90_000);
  startFakeCoordinator(runtime.root);
  const report = `## 状況と判断

架空の図鑑に 12 件の見本を追加しました。葉の図と花の説明を読み比べています。

- 日本語: 架空の植物の説明を確認してください。
- Русский: Вымышленные растения в учебном каталоге.
- العربية: نباتات خيالية في كتالوج تجريبي 📁

確認した結果をこの報告に戻してください。`;
  const { id: second } = await review(page, runtime, "Учебный каталог растений · مرحبا", { title: "Please review", description: "Please review the next item." });
  const { id: first } = await review(page, runtime, "架空の図鑑 · 葉と花の見本を読む 🌿", { title: "Please review", description: report });
  const turn = (await live(page, runtime)).tasks.find(task => task.id === first)?.ball;
  expect(turn).toMatchObject({ holder: "user", reason: "review" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, `?task=${first}&theme=light`);
  const reader = page.locator("aside[data-reader-mode]");
  await expect(reader.locator("[data-reader-task-id]")).toHaveText(first);
  // H goes to the coordinator once its conversation can take a press.
  await expect(taskMoves(page).locator("[data-task-done]")).toBeEnabled();
  await holdReader(page);
  await expect(reader.locator("[data-reader-task-id]")).toHaveText(second);
  await expect(page.locator('[data-section="held"]')).toContainText(/On hold\s*1/, CARRIED_OUT);
  await page.clock.setFixedTime(new Date(Date.now() + 2 * 60 * 60_000));
  // A hold sets the turn aside: the held task keeps its ball, in On hold.
  expect((await live(page, runtime)).tasks.find(task => task.id === first)).toMatchObject({ state: "held", ball: turn });

  const shots = process.env.ALPACAWORK_HOLD_SHOTS;
  for (const choice of [
    { width: 1440, height: 900, theme: "light" }, { width: 1440, height: 900, theme: "dark" },
    { width: 390, height: 844, theme: "light" }, { width: 390, height: 844, theme: "dark" },
  ] as const) {
    await page.setViewportSize({ width: choice.width, height: choice.height });
    await open(page, runtime, `?task=${first}&theme=${choice.theme}`);
    // Held tasks keep the waiting report in every layout.
    await expect(reader).toHaveAttribute("data-held");
    await expect(reader.locator("[data-report-feed]")).toContainText("Set to On hold");
    // A held review opens as the review it set aside does while waiting: the report it is about stands open.
    await expect(reader.locator("[data-report-feed]")).toContainText("架空の図鑑に 12 件");
    await settleMotion(page, reader); // Let the report disclosure finish before capturing the visual reference.
    if (shots) {
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: join(shots, `actual-held-${choice.width}-${choice.theme}.png`) });
      await reader.getByRole("button", { name: /Close/ }).first().click();
      await expect(page.locator('[data-section="held"]')).toContainText(/On hold\s*1/);
      // The hold is the line's dashes and the row's own mark: what you set yourself is no mark of its own on the line.
      if (choice.width === 1440) await expect(page.locator(`[data-row="${first}"] [data-mark]`)).toHaveCount(0);
      await page.screenshot({ path: join(shots, `actual-list-${choice.width}-${choice.theme}.png`) });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime, `?theme=light`);
  // On hold starts closed: open it from its heading.
  await page.locator('[data-section="held"] button[aria-expanded="false"]').click();
  const row = page.locator(`[data-row="${first}"]`);
  await expect(row).toBeVisible();
  // The title's R key opens the state form; Take off hold goes to the coordinator, which returns the hold.
  await row.locator(":scope > [data-row-head] [data-read]").click();
  await taskKey(page, "r");
  await page.locator('[data-state-choice="unhold"]').click();
  await page.locator("[data-inline-form]").getByRole("button", { name: "Update", exact: true }).click();
  await expect(page.locator('[data-section="held"]')).toHaveCount(0, CARRIED_OUT);
  // The restored turn is the review that was paused, waiting since the report that asked for it.
  expect((await live(page, runtime)).tasks.find(task => task.id === first)).toMatchObject({ state: "waiting", ball: turn });
  await open(page, runtime, `?task=${first}&theme=light`);
  await expect(reader.locator("[data-report-feed]")).toContainText("Set to Awaiting review");
});

for (const origin of ["review"] as ("review" | "question")[]) test(`the state form returns a held ${origin} directly, and an unknown send is resent as it was`, async ({ page, runtime }) => {
  startFakeCoordinator(runtime.root);
  const words = { title: "Original review points", description: "Please review." };
  const made = origin === "review" ? await review(page, runtime, "Check restoring from hold", words) : await question(page, runtime, "Check restoring from hold", words);
  const id = made.id;
  await hold(page, runtime, id, { title: "Review later", description: "Put on hold for now." });
  const now = await live(page, runtime);
  // The versions the screen shows when the form is sent: the Task's, and its responsible's.
  const shown = { expectedTaskHash: now.tasks.find(task => task.id === id)!.hash,
    expectedPlacementRevision: now.placements.find(placement => placement.taskId === id && placement.responsible)!.revision };
  await page.setViewportSize({ width: origin === "review" ? 390 : 1440, height: 900 });
  await open(page, runtime, `?agent=1&task=${id}`);
  const sent: Record<string, any>[] = [];
  await page.route(url => url.pathname === "/api/task/report", async route => {
    sent.push(route.request().postDataJSON());
    if (sent.length === 1) await route.fulfill({ status: 503, contentType: "application/json",
      body: JSON.stringify({ error: { code: "save_unconfirmed", message: "Unknown restoration result", retry: "check" } }) });
    else await route.continue();
  });
  await taskKey(page, "r");
  await page.locator('[data-state-choice="unhold"]').click();
  const title = page.getByRole("textbox", { name: "Title in History", exact: true });
  await title.fill("Restore from hold");
  await page.locator("[data-inline-form]").getByRole("button", { name: "Update", exact: true }).click();
  // The form closes at once: what became of the send is the reader's notice to say.
  await expect(title).toHaveCount(0);
  const check = page.locator("[data-toast]").getByRole("button", { name: "Check", exact: true });
  await expect(check).toBeVisible();
  // Take off hold of the turn shown, with the versions shown; the words written go with its line.
  expect(sent).toEqual([expect.objectContaining({ task: id, state: origin === 'review' ? 'waiting' : 'doing', ...shown })]);
  expect(sent[0]!.title).toBe('Restore from hold');
  expect(sent[0]).not.toHaveProperty('aboutRun');
  expect((await view(page, runtime, id)).state).toBe("held");
  await check.click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]).toEqual(sent[0]);
  // A held review returns to its wait, a held question to the work it was asked in.
  await expect.poll(async () => (await view(page, runtime, id)).state, CARRIED_OUT).toBe(origin === "review" ? "waiting" : "doing");
  const restoration = (await readTaskLog(runtime.origin, id)).filter(entry => entry.fromState === "held");
  expect(restoration).toHaveLength(1);
  expect(restoration[0]).toMatchObject({ toState: origin === "review" ? "waiting" : "doing",
    actor: { kind: "human" } });
});
