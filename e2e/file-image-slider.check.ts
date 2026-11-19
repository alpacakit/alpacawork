import { commandFetch as fetch } from "../tests/helpers/command-fetch.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { seedReview, taskFolder } from "./fixture/task-state.ts";
import { join } from "node:path";
import { test, expect, open } from "./fixtures.ts";
import { publishFixtureFiles } from "./fixture-writes.ts";

test.use({ isolated: true });

test("a report text link opens a Task image on its folder sheet and Close returns to the report", async ({ page, runtime }) => {
  test.setTimeout(90_000);
  const folder = join(taskFolder(runtime.root, "T112"), "images");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "linked.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9vRhcAAAAASUVORK5CYII=", "base64"));
  publishFixtureFiles(runtime.root);
  await expect.poll(async () => {
    const view = await (await fetch(`${runtime.origin}/api/task/view?task=T112`)).json() as { task: { files: { name: string }[] } };
    return view.task.files.some(file => file.name === "images/linked.png");
  }).toBe(true);
  seedReview(runtime.root, "T112", { title: "Image link", description: "[Image file](images/linked.png)" });
  await open(page, runtime, "?task=T112");
  const reader = page.getByRole("complementary");
  // The newest report stands open.
  await expect(reader.getByRole("button", { name: /Image link/ })).toHaveAttribute("aria-expanded", "true");
  await reader.getByRole("link", { name: "Image file" }).click();
  const modal = page.locator("[data-image-slider-modal]");
  await expect(modal).toBeVisible();
  expect(new URL(page.url()).searchParams.get("tab")).toBe("files");
  expect(new URL(page.url()).searchParams.get("path")).toBe("images/");
  expect(new URL(page.url()).searchParams.get("image")).toBe("images/linked.png");
  await modal.getByRole("button", { name: "Close image" }).click();
  await expect(modal).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("tab")).toBeNull();
  expect(new URL(page.url()).searchParams.get("image")).toBeNull();
  await expect(reader.getByRole("button", { name: /Image link/ })).toBeVisible();
  await page.goForward();
  await expect(modal).toBeVisible();
  await page.goBack();
  await expect(modal).toHaveCount(0);
});
