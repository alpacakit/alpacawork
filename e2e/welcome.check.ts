import { commandPost } from "./command-post.ts";
import type { Page } from "@playwright/test";
import { test, expect, open, openCoordinator } from "./fixtures.ts";
import { configureCoordinator } from "./coordinator-fixture.ts";
import type { Runtime } from "./server.ts";

/**
 * A section is drawn while it holds something, its heading included; a list holding nothing has no section and no
 * clock, and its place says how work goes. The conversation, which opens over it, offers examples; an example only goes
 * into the input, and the person sends it.
 */
test.use({ isolated: true });

async function post(page: Page, runtime: Runtime, path: string, data: object): Promise<{ task: { id: string } }> {
  const response = await commandPost(page.request, `${runtime.origin}/api/${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
const field = (page: Page) => page.locator("[data-one-input]");

const sections = (page: Page) => page.locator("[data-section]").evaluateAll(heads => heads.map(head => head.getAttribute("data-section")));

for (const [width, height] of [[1440, 900]] as const) {
  test(`an empty project shows the welcome alone; the conversation's examples go into the input; any first task takes it away at ${width}px`, async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await page.setViewportSize({ width, height });
    await open(page, runtime);
    // No section is drawn empty: each heading counts something (Done, its finished or shelved Tasks).
    await expect(page.locator("[data-section]").first()).toBeVisible();
    const counts = await page.locator("[data-section]").evaluateAll(heads => heads.map(head =>
      [head.getAttribute("data-section"), head.querySelector(".tabular-nums")?.textContent] as const));
    for (const [section, count] of counts) if (section !== "done") expect(count, String(section)).not.toBe("0");
    await expect(page.locator("[data-welcome]")).toHaveCount(0);

    const { task: project } = await post(page, runtime, "commands/task/new", { kind: "project", color: "#39659b", parent: "none", title: "Empty one" });
    await page.goto(`${runtime.origin}/?project=${project.id}`);
    const welcome = page.locator("[data-welcome]");
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole("heading", { name: "Welcome to alpacawork" })).toBeVisible();
    await expect(welcome.locator("[data-welcome-picture-part]")).toHaveCount(4);
    await expect(page.locator("[data-section]")).toHaveCount(0);
    await expect(page.locator("[data-time-corner]")).toHaveCount(0);

    // The conversation opens over the list and offers its examples there. An example only goes into the input.
    await openCoordinator(page);
    const warm = page.locator("[data-coordinator-warm]");
    await expect(warm.locator("[data-warm-example]")).toHaveCount(4);
    const example = (name: string) => warm.locator(`[data-warm-example="${name}"]`);
    const names = await warm.locator("[data-warm-example]").evaluateAll(rows => rows.map(row => row.getAttribute("data-warm-example")!));
    const [first, second] = names as [string, string];
    await example(first).click();
    const firstWords = (await field(page).innerText()).trim();
    // Trying another example takes the untouched one's place, so reading them mixes nothing.
    await example(second).click();
    await expect(field(page)).not.toContainText(firstWords);
    const secondWords = (await field(page).innerText()).trim();
    // Once the person has written in it, what is there is theirs: an example goes after it, discarding nothing.
    await field(page).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(" mine");
    await example(first).click();
    await expect(field(page)).toContainText(secondWords);
    await expect(field(page)).toContainText(" mine");
    await expect(field(page)).toContainText(firstWords);
    // Nothing is sent: the project stays empty until the person sends it.
    await page.keyboard.press("Escape");
    await expect(welcome).toBeVisible();

    // A Task an agent made is a Task too: no welcome, and as a top Task it is a row like the user's.
    await post(page, runtime, "commands/task/new", { parent: project.id, title: "Agent's own", fromUser: false });
    await expect(welcome).toHaveCount(0);
    await expect.poll(() => sections(page)).toEqual(["todo"]);
    await expect(page.locator("[data-time-corner]")).toHaveCount(1);
    await post(page, runtime, "commands/task/new", { parent: project.id, title: "First one" });
    await expect(page.locator('[data-section="todo"] + ol [data-row]')).toHaveCount(2);
    expect(await sections(page)).toEqual(["todo"]);
  });
}
