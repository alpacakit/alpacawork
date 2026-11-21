import { commandPost } from "./command-post.ts";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { initialFirstRun } from "@alpacawork/contract";
import { archiveFixtureProject } from "./fixture-writes.ts";
import { test, expect } from "./fixtures.ts";
import type { Runtime } from "./server.ts";

/**
 * A new person's way in, against the real server: the setup's four steps (language and theme, agents, skills, project), then the page
 * opening on that project with its welcome, in the same document.
 */
test.use({ isolated: true });

/** The workspace setup makes: one empty Sample Project, its setup not done, and nothing else listed. */
async function enroll(page: Page, runtime: Runtime): Promise<string> {
  const response = await commandPost(page.request, `${runtime.origin}/api/task/new`, { data: { kind: "project", color: "#39659b", parent: "none", title: "Sample Project" } });
  expect(response.ok(), await response.text()).toBe(true);
  const sample = (await response.json()).task.id as string;
  archiveFixtureProject(runtime.root, "P1");
  writeFileSync(join(runtime.root, ".alpacawork/first-run.json"),
    JSON.stringify({ version: 1, revision: randomUUID(), value: initialFirstRun(sample) }));
  return sample;
}

for (const [width, height] of [[1440, 900], [390, 844]] as const) {
  test(`a new person goes through the setup steps and lands on the welcome of their project at ${width}px`, async ({ page, runtime }) => {
    const sample = await enroll(page, runtime);
    await page.setViewportSize({ width, height });
    // On a computer the page's feed answers late, as through a tunnel from another PC: nothing may be written before
    // it is connected, and nothing is said meanwhile.
    if (width === 1440) await page.route("**/api/events*", async route => { await new Promise(done => setTimeout(done, 1500)); await route.continue().catch(() => {}); });
    await page.goto(runtime.origin);
    expect(new URL(page.url()).pathname).toBe("/welcome");
    const setup = page.locator("[data-setup-screen]");
    await expect(setup.locator('[data-setup-step="display"]')).toHaveAttribute("aria-current", "step");

    // 1 Language and theme: each applies at once, and the theme stays after setup.
    await setup.locator('[data-setup-language="es"]').click();
    await expect(setup.locator("h1")).toHaveText("Idioma y tema");
    await setup.locator('[data-setup-language="en"]').click();
    await expect(setup.locator("h1")).toHaveText("Language and theme");
    await setup.locator('[data-setup-theme="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await setup.locator("[data-setup-next]").click();
    await expect(setup.locator('[data-setup-step="agents"]')).toHaveAttribute("aria-current", "step");

    // 2 Agents: none is enabled here (Claude Code and Codex signed out; Grok Build found, its sign-in not checkable), so
    // Next waits until one is. Usage data, where it is asked, starts ticked.
    await expect(setup.locator("[data-setup-no-agent]")).toBeVisible();
    await expect(setup.locator("[data-setup-next]")).toBeDisabled();
    await expect(setup.locator('[data-setup-agent="grok"]')).toHaveAttribute("data-setup-agent-status", "found");
    await setup.locator('[data-setup-agent="grok"] [role=switch]').click();
    await expect(setup.locator("[data-setup-next]")).toBeEnabled();
    const consent = setup.locator("[data-setup-consent] input");
    if (await consent.count()) await expect(consent).toBeChecked();
    const documents: string[] = [];
    page.on("request", request => { if (request.resourceType() === "document") documents.push(request.url()); });
    await setup.locator("[data-setup-next]").click();

    // 3 Skills: three are recommended and ticked; with only the bundled one left ticked, the button names one skill.
    const skills = setup.locator('[data-setup-panel="skills"]');
    await expect(skills.locator("[data-setup-install]")).toHaveText("Install 3 skills");
    for (const name of ["askmeclearly", "doyourjob"]) await skills.locator(`[data-setup-skill="${name}"] input`).uncheck();
    await skills.locator('[data-setup-skill="alpacawork-betterquality"] input').check();
    await expect(skills.locator("[data-setup-install]")).toHaveText("Install 1 skill");
    await skills.locator("[data-setup-install]").click();
    // Moving on, the setup says what went in.
    await expect(page.locator("[data-toast]").filter({ hasText: "Installed 1 skill" })).toBeVisible();

    // 4 Project: settings' own rows, the policy naming the installed skill.
    const project = setup.locator('[data-setup-panel="project"]');
    await expect(project.locator("#project-policy")).toHaveValue(/alpacawork-betterquality/);
    await expect(project.locator("#project-policy")).not.toHaveValue(/askmeclearly/);
    await project.locator("#project-name").fill("My project");
    await project.locator("[data-setup-finish]").click();

    // The page opens on the project, drawn in place: no second document, and nothing said.
    await expect(setup).toHaveCount(0);
    await expect(page.locator("[data-welcome]")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    expect(new URL(page.url()).searchParams.get("project")).toBe(sample);
    expect(documents).toEqual([]);
    await expect(page.locator("[data-toast]").filter({ hasNotText: "Installed 1 skill" })).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    // The kind enabled in setup is now in the agent settings, enabled.
    const config = await (await page.request.get(`${runtime.origin}/api/config/get`)).json();
    expect(config.agentsText).toMatch(/^\s*grok:/m);
    const saved = await (await page.request.get(`${runtime.origin}/api/first-run`)).json();
    expect(saved.state.finishedAt).not.toBeNull();
    await page.screenshot({ path: test.info().outputPath(`welcome-${width}.png`) });
  });
}
