import { projectRows } from './fixture/list-rows.ts';
import { commandPost } from "./command-post.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { Page } from "@playwright/test";
import { projectedIndexSchema } from "@alpacawork/contract/control";
import { test, expect, open } from "./fixtures.ts";
import { SAMPLE_PROJECT } from "./fixture/sample.ts";
import { placeResponsible } from "./fixture/responsible.ts";
import { patchTask, seedQuestion, seedReview } from "./fixture/task-state.ts";
import type { Runtime } from "./server.ts";
import { decideValues } from '../tests/helpers/task-values.ts';

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => projectRows(root, ['T111'])); } });

/**
 * The screen of every project on a real server. A project is a Task of kind project, at the top or in
 * another project; its tasks join the one list under their own IDs (one numbering). The header's name narrows the list
 * to a project and what is nested in it, its menu lists the projects nested under theirs with each one's numbers (its
 * whole subtree's, counted by the server), and the URL keeps the choice, a phone's too, where a dot on the name tells a
 * project outside the view waits; the groups' counts are those of what is in view.
 */
test.use({ isolated: true });

type Written = { task: { id: string; hash: string } };
async function post(page: Page, runtime: Runtime, path: string, data: object): Promise<Written> {
  const response = await commandPost(page.request, `${runtime.origin}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
/** The header's dot is drawn whole: each edge of it is hit where it is, nothing around it clipping it off. */
const dotDrawnWhole = (page: Page) => page.locator("h1 [data-turn-elsewhere]").evaluate((dot) => {
  const { left, right, top, bottom } = dot.getBoundingClientRect(), x = (left + right) / 2, y = (top + bottom) / 2;
  return [[x, top + 0.5], [x, bottom - 0.5], [left + 0.5, y], [right - 0.5, y]]
    .every(([px, py]) => document.elementFromPoint(px!, py!) === dot);
});
/**
 * A project (at the top, or in `parent`) with two tasks that wait for the person: a review, and a question its
 * responsible asks at work (its text is the body's decide section, which the sample's extracts, inherited by a project
 * made in it, read once they have the decide item).
 */
async function addProject(page: Page, runtime: Runtime, parent = "none") {
  const { task: project } = await post(page, runtime, "task/new", { kind: "project", color: '#39659b', parent, title: "Mobile rewrite" });
  const tasks: string[] = [];
  for (const title of ["Mob waits", "Mob asks"]) {
    const { task } = await post(page, runtime, "task/new", { parent: project.id, title });
    await placeResponsible(page.request, runtime.origin, task);
    tasks.push(task.id);
  }
  const [waits, asks] = tasks as [string, string];
  seedReview(runtime.root, waits, { title: "Look", description: "Please look." });
  patchTask(runtime.root, asks, { state: "doing", values: decideValues(['Which one?', ['A first', 'This'], ['B second', 'That']]) });
  seedQuestion(runtime.root, asks, { to: "user", title: "Look", description: "Please look." });
  return { project: project.id, tasks };
}
/** The projects as the server lists them for the menu. */
const listed = async (page: Page, runtime: Runtime) =>
  projectedIndexSchema.parse(await (await page.request.get(`${runtime.origin}/api/workspace/live`)).json()).projects;
/** Where this PC keeps a project's code, as config.yaml holds it. */
const location = (runtime: Runtime, project: string): unknown =>
  parse(readFileSync(join(runtime.root, "config.yaml"), "utf8"))?.projects?.[project]?.cwd;
const row = (page: Page, id: string) => page.locator(`li[data-row="${id}"]`);
const turnCount = (page: Page) => page.locator('[data-section="review"] h2').innerText();

test("a second project's tasks join the list under their own IDs; the header's menu narrows it and the URL keeps it", async ({ page, runtime }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, runtime);
  const before = await turnCount(page);
  const mob = await addProject(page, runtime);
  await expect(row(page, mob.tasks[0]!)).toBeVisible();
  await expect(page.locator("h1")).toHaveText("All projects");
  // One numbering: a row shows its task's own ID, whichever project holds it.
  await expect(row(page, mob.tasks[0]!)).toContainText(mob.tasks[0]!);
  await expect(row(page, "T111")).toContainText("T111");
  await expect.poll(() => turnCount(page)).not.toBe(before);

  await page.locator("[data-project-trigger]").click();
  const menu = page.getByRole("menu", { name: "Projects" });
  await expect(menu.locator('[data-project-item="all"]')).toHaveAttribute("aria-checked", "true");
  await expect(menu.locator(`[data-project-item="${mob.project}"] [data-count="turn"]`)).toHaveText("2");
  await expect(menu.locator(`[data-project-item="${SAMPLE_PROJECT.id}"]`)).toContainText(SAMPLE_PROJECT.title);
  await expect(menu.getByRole("menuitem", { name: "New project" })).toBeVisible();
  await menu.locator(`[data-project-item="${mob.project}"]`).click();

  await expect(page.locator("h1")).toHaveText("Mobile rewrite");
  await expect(page.locator("li[data-row]")).toHaveCount(2);
  for (const id of mob.tasks) await expect(row(page, id)).toBeVisible();
  // The sample project's waits are a dot on the name, standing above its line and drawn whole.
  await expect(page.locator("h1 [data-turn-elsewhere]")).toBeVisible();
  expect(await dotDrawnWhole(page)).toBe(true);
  await expect(page.locator('[data-section="review"] h2')).toContainText("2");
  await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe(mob.project);
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Mobile rewrite");
  await expect(page.locator("li[data-row]")).toHaveCount(2);
  // Back returns to every project.
  await page.goBack();
  await expect(page.locator("h1")).toHaveText("All projects");
});

test("New project makes it in the project in view, names each wrong field, and keeps the folder", async ({ page, runtime }) => {
  const code = mkdtempSync(join(tmpdir(), "alpacawork-e2e-code-"));
  const folder = join(code, "shop-app");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, runtime, `?project=${SAMPLE_PROJECT.id}`);
    await page.locator("[data-project-trigger]").click();
    await page.locator("[data-project-new]").click();
    const dialog = page.getByRole("dialog", { name: "New project", exact: true });
    const name = dialog.getByLabel("Name", { exact: true });
    const cwd = dialog.locator("#project-cwd");
    await expect(name).toBeFocused();
    // Its parent is the project in view until another is chosen.
    await expect(dialog.getByLabel("Parent project", { exact: true })).toHaveValue(SAMPLE_PROJECT.id);
    await name.fill("Shop redesign");
    // The screen finds a relative folder.
    await cwd.fill("shop-app");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toContainText("Enter a path starting with / or ~.");
    await expect(cwd).toHaveAttribute("aria-invalid", "true");
    // The server finds a folder that is not on this PC, at its field.
    await cwd.fill(folder);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-toast][data-kind="error"]')).toContainText('This folder does not exist on this PC.');
    await page.locator('[data-project-trigger]').click();
    await page.locator('[data-project-new]').click();
    await expect(name).toHaveValue('Shop redesign');
    await expect(cwd).toHaveValue(folder);
    // A refused folder made nothing: the project and its folder are one write.
    expect((await listed(page, runtime)).map(({ title }) => title)).not.toContain("Shop redesign");
    // Made with its folder: the list opens the project, inside the one in view, and the project keeps where its
    // agents start.
    mkdirSync(folder);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("h1")).toHaveText("Shop redesign");
    const made = (await listed(page, runtime)).find(({ title }) => title === "Shop redesign")!;
    expect(made.parentId).toBe(SAMPLE_PROJECT.id);
    await expect.poll(() => new URL(page.url()).searchParams.get("project")).toBe(made.id);
    expect(location(runtime, made.id)).toBe(realpathSync(folder));
  } finally {
    rmSync(code, { recursive: true, force: true });
  }
});
