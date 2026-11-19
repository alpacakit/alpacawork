import { commandPost } from "./command-post.ts";
import type { Page } from "@playwright/test";
import { test, expect, open, openCoordinator } from "./fixtures.ts";
import { configureCoordinator } from "./coordinator-fixture.ts";
import { labelLayer } from "./editor-surface.ts";
import type { Runtime } from "./server.ts";

/**
 * A section is drawn while it holds something, its heading included; a list holding nothing has no section and no
 * clock, and its place says how work starts. An example only goes into the input, after the project in view's label;
 * the person sends it. While it shows, the conversation points to it instead of offering its own examples. The first Task
 * takes the welcome away and brings the conversation's examples back.
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
  test(`an empty project shows the welcome alone; examples go into the input; any first task takes it away at ${width}px`, async ({ page, runtime }) => {
    configureCoordinator(runtime.root);
    await page.setViewportSize({ width, height });
    await open(page, runtime);
    // No section is drawn empty: each heading counts something (Done, its finished or shelved Tasks).
    await expect(page.locator("[data-section]").first()).toBeVisible();
    const counts = await page.locator("[data-section]").evaluateAll(heads => heads.map(head =>
      [head.getAttribute("data-section"), head.querySelector(".tabular-nums")?.textContent] as const));
    for (const [section, count] of counts) if (section !== "done") expect(count, String(section)).not.toBe("0");
    await expect(page.locator("[data-welcome]")).toHaveCount(0);

    const { task: project } = await post(page, runtime, "task/new", { kind: "project", color: "#39659b", parent: "none", title: "Empty one" });
    await page.goto(`${runtime.origin}/?project=${project.id}`);
    const welcome = page.locator("[data-welcome]");
    await expect(welcome).toBeVisible();
    await expect(welcome.getByRole("heading", { name: "Welcome to alpacawork" })).toBeVisible();
    await expect(welcome.locator("[data-welcome-example]")).toHaveCount(3);
    await expect(page.locator("[data-section]")).toHaveCount(0);
    await expect(page.locator("[data-time-corner]")).toHaveCount(0);

    // An example's row is at least 40px tall. The examples stand on a surface of their own and the heading and its
    // words on the page, so the words above never read as one more row to press.
    const example = welcome.locator('[data-welcome-example="models"]');
    expect((await example.boundingBox())!.height).toBeGreaterThanOrEqual(39.5);
    // An opaque, edged, rounded surface: transparent rows between rules would read like the words above them.
    const surface = await welcome.locator("ul").evaluate(node => {
      const style = getComputedStyle(node);
      return { ground: style.backgroundColor, edge: parseFloat(style.borderTopWidth), round: parseFloat(style.borderTopLeftRadius) };
    });
    expect(surface.ground).not.toBe("rgba(0, 0, 0, 0)");
    expect(surface.edge).toBeGreaterThan(0);
    expect(surface.round).toBeGreaterThan(0);

    // A row names the example and what the person will see; the input gets the words to send, not the row's title again.
    await expect(example).toHaveText(/^Have 3 models build a snake game, then compare\s*Different models build in parallel/);
    await example.click();
    await expect(labelLayer(field(page)).locator("[data-label=task][data-label-project]")).toHaveText("Empty one");
    await expect(field(page)).toContainText("3 times in parallel, each with a different model");
    await expect(field(page)).not.toContainText("Have 3 models build a snake game, then compare");
    // Trying another example takes the untouched one's place, so reading them mixes nothing.
    await welcome.locator('[data-welcome-example="decide"]').click();
    await expect(field(page)).toContainText("one mini game I can play in the browser");
    await expect(field(page)).not.toContainText("3 times in parallel, each with a different model");
    // Emptied by hand it holds nothing of theirs either: no blank line stays before the next one.
    await field(page).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await welcome.locator('[data-welcome-example="settings"]').click();
    await expect(field(page).locator("p, div").first()).toContainText("add this rule to this project's policy");
    await welcome.locator('[data-welcome-example="decide"]').click();
    await expect(field(page)).not.toContainText("add this rule to this project's policy");
    // Once the person has written in it, what is there is theirs: an example goes after it, discarding nothing.
    await field(page).click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" mine");
    await welcome.locator('[data-welcome-example="models"]').click();
    await expect(field(page)).toContainText("one mini game I can play in the browser");
    await expect(field(page)).toContainText(" mine");
    await expect(field(page)).toContainText("3 times in parallel, each with a different model");
    // Nothing is sent: the project stays empty until the person sends it.
    await expect(welcome).toBeVisible();
    // The conversation leaves the examples to the list and points there.
    await openCoordinator(page);
    const warm = page.locator("[data-coordinator-warm]");
    await expect(warm.locator("[data-warm-start]")).toBeVisible();
    await expect(warm.locator("[data-warm-example]")).toHaveCount(0);
    // Only while the examples are on screen: searching the empty project takes the list's place, and the conversation
    // offers its own examples again.
    await page.getByRole("searchbox").fill("café");
    await expect(welcome).toHaveCount(0);
    await expect(warm.locator("[data-warm-example]")).toHaveCount(4);
    await expect(warm.locator("[data-warm-start]")).toHaveCount(0);
    await page.getByRole("searchbox").fill("");
    await expect(welcome).toBeVisible();
    await expect(warm.locator("[data-warm-start]")).toBeVisible();

    // A Task an agent made is a Task too: no welcome, and as a top Task it is a row like the user's.
    await post(page, runtime, "task/new", { parent: project.id, title: "Agent's own", userRequested: false });
    await expect(welcome).toHaveCount(0);
    await expect(warm.locator("[data-warm-example]")).toHaveCount(4);
    await expect(warm.locator("[data-warm-start]")).toHaveCount(0);
    await expect.poll(() => sections(page)).toEqual(["todo"]);
    await expect(page.locator("[data-time-corner]")).toHaveCount(1);
    await post(page, runtime, "task/new", { parent: project.id, title: "First one" });
    await expect(page.locator('[data-section="todo"] + ol [data-row]')).toHaveCount(2);
    expect(await sections(page)).toEqual(["todo"]);
  });
}
