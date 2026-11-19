import { projectRows } from './fixture/list-rows.ts';
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "@playwright/test";
import { taskViewSchema } from "@alpacawork/contract/control";
import { test, expect, open } from "./fixtures.ts";
import { seedReview, taskFolder } from "./fixture/task-state.ts";

// These interaction scenarios need independent rows, rather than hidden ordinary children.
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(root => projectRows(root, ['T111'])); } });

test.use({ isolated: true });

for (const viewport of [{ width: 1440, height: 900, name: "desktop" }]) {
  test(`task-folder files and a concise report on ${viewport.name}`, async ({ page, runtime }) => {
    test.setTimeout(60_000);
    const id = "T111";
    const isTaskView = (response: Response) => {
      const url = new URL(response.url());
      return response.ok() && url.pathname === "/api/task/view" && url.searchParams.get("task") === id;
    };
    await page.setViewportSize(viewport);
    const initial = page.waitForResponse(isTaskView);
    await open(page, runtime, `?task=${id}`);
    expect(taskViewSchema.parse(await (await initial).json()).task.files).toEqual([]);
    // Keep the real screen subscribed before the external write. Observe its
    // refetch after the filesystem watch makes SSE publish the files.
    const observed = page.waitForResponse(async response => isTaskView(response) &&
      taskViewSchema.parse(await response.json()).task.files?.length === 7, { timeout: 10_000 });
    void observed.catch(() => {});
    const folder = taskFolder(runtime.root, id);
    mkdirSync(join(folder, "images"));
    mkdirSync(join(folder, "notes"));
    mkdirSync(join(folder, "files"));
    writeFileSync(join(folder, "report.md"), "# Review results\n![Screen](images/chart.png)\n");
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9vRhcAAAAASUVORK5CYII=", "base64");
    writeFileSync(join(folder, "images", "chart.png"), image);
    writeFileSync(join(folder, "notes", "plan.md"), "# Steps\n![Screen](../images/chart.png)\n");
    writeFileSync(join(folder, "files", "old.txt"), "Earlier copy");
    writeFileSync(join(folder, "images", "screen-desktop-light.png"), image);
    writeFileSync(join(folder, "images", "screen-desktop-dark.png"), image);
    mkdirSync(join(folder, "work"));
    writeFileSync(join(folder, "work", "log.txt"), "Work log");
    const before = taskViewSchema.parse(await (await observed).json());
    expect(before.task.files?.map(file => file.name)).toEqual(
      ["files/old.txt", "images/chart.png", "images/screen-desktop-dark.png", "images/screen-desktop-light.png",
        "notes/plan.md", "report.md", "work/log.txt"]);
    const reader = page.getByRole("complementary", { name: "Full text of the task" });
    // Only what the user looks at is counted: the plain text and the log are work files, 5 of the 7 files remain.
    await expect(reader.getByRole("button", { name: "Files 5" })).toBeVisible();
    await reader.getByRole("button", { name: /Files/ }).click();
    const panel = reader.locator("[data-reader-content]");
    await expect(panel).toContainText("notes/plan.md");
    await expect(panel).toContainText("report.md");
    await expect(panel.getByRole("button", { name: "chart.png" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "screen-desktop-dark.png" })).toBeVisible();
    await expect(panel).not.toContainText("index.md");
    await expect(panel).not.toContainText("log.txt");
    await expect(panel).not.toContainText("old.txt");
    await panel.getByRole("button", { name: /Work files\s*2/ }).click();
    await expect(panel).toContainText("log.txt");
    await expect(panel).toContainText("files/old.txt");
    expect(new URL(page.url()).searchParams.get("path")).toBe("work/");
    await panel.getByRole("button", { name: /^Deliverables/ }).click();
    await expect(panel).not.toContainText("log.txt");
    const preview = panel.locator('img[src*="chart.png"]');
    await preview.scrollIntoViewIfNeeded();
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await panel.evaluate(element => element.scrollTo(0, 0));
    const shots = process.env.ALPACAWORK_TASK_FILES_SHOTS;
    if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${viewport.name}-files.png`), fullPage: true }); }
    // A document is read in the viewer, its pictures by its own folder.
    await panel.getByRole("button", { name: /notes\/plan.md/ }).click();
    const viewer = page.locator("[data-viewer]");
    await expect(viewer.getByRole("img", { name: "Screen" })).toBeVisible();
    expect(await viewer.getByRole("img", { name: "Screen" }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    // What is open is the URL: Back closes the viewer over the list, Forward reopens the file.
    expect(new URL(page.url()).searchParams.get("view")).toBe(`${id}/notes/plan.md`);
    await page.goBack();
    await expect(viewer).toHaveCount(0);
    await expect(panel.getByRole("button", { name: /notes\/plan.md/ })).toBeVisible();
    await page.goForward();
    await expect(viewer.getByRole("img", { name: "Screen" })).toBeVisible();
    // Images use the shared slider while the sheet remains behind it.
    await open(page, runtime, `?task=${encodeURIComponent(id)}&tab=files&path=${encodeURIComponent("images/")}`);
    await reader.getByRole("button", { name: "screen-desktop-dark.png" }).click();
    const slider = page.locator("[data-image-slider-modal]");
    await expect(slider.locator("[data-image-slider-count]")).toHaveText("3 of 3");
    const entries = await page.evaluate(() => history.length);
    await page.keyboard.press("ArrowLeft");
    await expect(slider.locator("[data-image-slider-count]")).toHaveText("2 of 3");
    expect(new URL(page.url()).searchParams.get("path")).toBe("images/");
    expect(new URL(page.url()).searchParams.get("image")).toBe("images/screen-desktop-light.png");
    // Stepping replaces the entry, so one Back leaves the slider.
    expect(await page.evaluate(() => history.length)).toBe(entries);
    seedReview(runtime.root, id, { title: "File review complete", description: "Please review the task folder" });
    // A change made elsewhere leaves the reader, and the slider over it, where they are (only an answer given in the
    // reader moves it). Close the slider, then open the task's reports from its row on the same connection and
    // inspect the newly received report.
    await expect(reader).toHaveCount(1);
    await expect(slider).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(slider).toHaveCount(0);
    await page.locator(`[data-read="${id}"]`).click();
    await panel.getByText(/File review complete/).click();
    await expect(panel).toContainText("Please review the task folder");
    if (shots) await page.screenshot({ path: join(shots, `${viewport.name}-history.png`), fullPage: true });
  });
}

test("untrusted source and markup stay inert when their file URLs are opened directly", async ({ page, runtime }) => {
  const folder = taskFolder(runtime.root, "T111");
  const payload = '<h1 id="rendered-markup">Untrusted markup</h1><script>globalThis.fileScriptRan = true</script>';
  for (const extension of ["html", "svg", "js", "ts", "log", "json"]) {
    const name = `untrusted.${extension}`;
    const text = extension === "json" ? JSON.stringify({ source: payload }) : payload;
    writeFileSync(join(folder, name), text);
    const response = await page.goto(`${runtime.origin}/api/tasks/T111/file?path=${encodeURIComponent(name)}`);
    expect(response!.status()).toBe(200);
    expect(await page.locator("body").textContent()).toContain("<script>");
    await expect(page.locator("#rendered-markup, svg, script")).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { fileScriptRan?: boolean }).fileScriptRan)).toBeUndefined();
  }
});
