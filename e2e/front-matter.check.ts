import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, openFile } from "./fixtures.ts";
import { taskFolder } from "./fixture/task-state.ts";

const skill = readFileSync(new URL("../skills/alpacawork-betterquality/SKILL.md", import.meta.url), "utf8");
const special = '---\nname: "<img src=x onerror=alert(1)>"\nnumber: 007\ndescription: |\n  first line\n  last line\n---\n# Body after YAML\n[Next](other.md)\n![Pixel](pixel.png)\n\n```diff\n+kept diff\n```\n';
function prepare(root: string) {
  const folder = taskFolder(root, "T111");
  mkdirSync(join(folder, "notes"), { recursive: true });
  for (const [name, text] of Object.entries({ "skill.md": skill, "notes/safe.md": special, "broken.md": "---\nname: [\n---\n# Body remains\n", "plain.md": "# Plain markdown\n\n---\nname: ordinary body\n", "notes/other.md": "# Linked file\n", "empty.md": "---\n---\n# Empty metadata body\n", "unclosed.md": "---\nname: skill\n# Unclosed source remains\n" })) writeFileSync(join(folder, name), text);
  writeFileSync(join(folder, "notes", "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9vRhcAAAAASUVORK5CYII=", "base64"));
}
test.use({ isolated: true, runtimePrepare: async ({}, use) => { await use(prepare); } });

test("file integration preserves literal metadata, relative links, images, diff and fallback source", async ({ page, runtime }) => {
  await openFile(page, runtime, "T111", "notes/safe.md", "&agent=1");
  const table = page.getByRole("table", {name:"YAML metadata"});
  await expect(table).toContainText("<img src=x onerror=alert(1)>");
  await expect(table).toContainText("007");
  await expect(table.locator("img")).toHaveCount(0);
  await expect(page.getByRole("heading",{name:"Body after YAML"})).toBeVisible();
  await expect(page.getByRole("img",{name:"Pixel"})).toBeVisible();
  await expect(page.locator("[data-diff-code]")).toBeVisible();
  await page.getByRole("link",{name:"Next",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Linked file"})).toBeVisible();
  for (const [file, expected] of [["broken.md", "Body remains"], ["plain.md", "Plain markdown"], ["empty.md", "Empty metadata body"]] as const) {
    await openFile(page, runtime, "T111", file, "&agent=1");
    await expect(page.getByRole("heading",{name:expected})).toBeVisible();
    await expect(page.getByRole("table",{name:"YAML metadata"})).toHaveCount(0);
    if(file === "broken.md") await expect(page.locator("[data-front-matter-fallback] pre")).toHaveText("---\nname: [\n---\n");
  }
  await openFile(page, runtime, "T111", "unclosed.md", "&agent=1");
  await expect(page.locator("[data-front-matter-fallback] pre")).toContainText("# Unclosed source remains");
});
