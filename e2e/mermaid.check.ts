import { copyFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { patchTask, taskFolder } from "./fixture/task-state.ts";
import { readOnlyTest, expect, openFile } from "./fixtures.ts";

const SOURCE = "flowchart LR\n A[日本語の受付] --> B{確認しましたか？}\n B -->|はい| C[作業が完了しました]";
const DIAGRAM = `\n\`\`\`mermaid\n${SOURCE}\n\`\`\`\n`;
const BODY = `![Picture](shot.png)${DIAGRAM}![Picture](shot.png)${DIAGRAM}\n\`\`\`mermaid\nflowchart LR\n A[broken\n\`\`\`\nStill readable.`;
const INCOMPLETE_SOURCE = "flowchart LR\n A[まだ入力中\n![literal](shot.png)\n# Still source";
const RESOURCE_SOURCES = [
  'block-beta\n A\n style A fill:url(/mermaid-probe.png)',
  String.raw`block-beta
 A
 style A fill:u\72l(/mermaid-probe.png)`,
  'flowchart LR\n A@{ img: "data:image/png;base64,AA==" }',
  'flowchart LR\n A@{ shape: image }',
  String.raw`flowchart LR
 A:::probe
 classDef probe fill:u\72l(/mermaid-probe.png)`,
  'flowchart LR\n A:::probe\n classDef probe fill:u/**/rl(/mermaid-probe.png)',

  ...['https://example.invalid/mermaid-probe.png', '/mermaid-probe.png'].flatMap(img => [
    `flowchart LR\n A@{ img: "${img}", label: "External image" }`,
    `flowchart LR\n A@{ "img": "${img}" }`,
    `flowchart LR\n A@{ "\\u0069mg": "${img}" }`,
    ...['}', String.raw`\u007d`, '&#125;'].map(label => `flowchart LR\n A@{ label: "${label}", img: "${img}" }`),
    `flowchart LR\n A@{ label: "/*", img: "${img}", descr: "*/" }`,
  ]),
  ...['/mermaid-probe.png', 'https://example.invalid/mermaid-probe.png'].flatMap(img => [
    `architecture-beta\n service a "<img src='${img}'>" [Name]`,
    `flowchart LR\n A:::probe\n classDef probe fill:url(${img})`,
    `flowchart LR\n A:::probe\n classDef probe background:image-set("${img}" 1x)`,
  ]),
];
const CONFIG_SOURCES = [
  '%%{init: {"themeVariables":{"fontSize":"url(mermaidprobe)"}}}%%\nflowchart LR\n A --> B',
  '%%{init: {"sequence":{"actorFontFamily":"url(/mermaid-probe.png)"}}}%%\nflowchart LR\n A --> B',
  '---\nconfig:\n  themeVariables:\n    fontSize: "url(mermaidprobe)"\n---\nblock-beta\n A\n style A fill:url(/mermaid-probe.png)',
  '---\nconfig:\n  themeCSS: "@import url(/mermaid-probe.css);"\n---\nflowchart LR\n A --> B',
];
const LABEL_SOURCES = [
  // Mermaid 12's block style parser truncates these values at the URI scheme colon.
  // Keep the same inputs under the successful, resource-free output checks; relative
  // block URLs above still exercise CSP (including the CSS-escaped spelling).
  'block-beta\n A\n style A fill:url(https://example.invalid/mermaid-probe.png)',
  String.raw`block-beta
 A
 style A fill:u\72l(https://example.invalid/mermaid-probe.png)`,
  'flowchart LR\n A@{ icon: "logos:mermaid-probe" }',
  'mindmap\n root\n  ::icon(fa fa-book)',
  'architecture-beta\n service a(logos:mermaid-probe)[Name]',
  'architecture-beta\n service db(database)[Database]',
  'flowchart LR\n A:::good\n classDef good fill:#fff,stroke:#333',

  'flowchart LR\n A@{ label: "src: apps/web" } --> B@{ label: "image: 画面" }',
  'flowchart LR\n A@{ label: "href=リンク" } --> B@{ label: "icon: 印" }',
  'flowchart LR\n A["url(example) を返す関数"]',
  'flowchart LR\n A["<img src=x>"]',
  'flowchart LR\n A["<foreignObject><img src=\'/mermaid-probe.png\'></foreignObject>"]',
  'flowchart LR\n A["&lt;image href=\'/mermaid-probe.png\'&gt;"]',
  'flowchart LR\n A["#60;img src=\'/mermaid-probe.png\'#62;"]',
  'flowchart LR\n A["`![picture](/mermaid-probe.png)`"]',
  '%%{init: {"themeCSS":"@import \'https://example.invalid/mermaid-probe.css\'"}}%%\nflowchart LR\n A --> B',
];
const test = readOnlyTest(root => {
  const folder = taskFolder(root, "T112");
  copyFileSync(fileURLToPath(new URL("./fixture/wide-report.png", import.meta.url)), join(folder, "shot.png"));
  writeFileSync(join(folder, "diagrams.md"), BODY);
  writeFileSync(join(folder, "incomplete.md"), `BEFORE\n\`\`\`mermaid\n${INCOMPLETE_SOURCE}`);
  writeFileSync(join(folder, "resources.md"), RESOURCE_SOURCES.map(source => `\`\`\`mermaid\n${source}\n\`\`\``).join("\n\n"));
  writeFileSync(join(folder, "control.md"), "```mermaid\nflowchart LR\n A@{ img: \"/mermaid-probe.png\" }\n```");
  writeFileSync(join(folder, "config.md"), CONFIG_SOURCES.map(source => "```mermaid\n" + source + "\n```").join("\n\n"));
  writeFileSync(join(folder, "labels.md"), LABEL_SOURCES.map(source => "```mermaid\n" + source + "\n```").join("\n\n"));
  patchTask(root, "T112", { values: { notes: BODY }, logs: [{ id: "Lmermaid", kind: "reported", at: "2026-10-20T10:00:00Z", title: "Diagram review",
    description: BODY, actor: { kind: "human" }, fromState: null, toState: null }] });
});

test("the frame CSP blocks every resource path before the network, independent of diagram type", async ({ page, runtime }) => {
  const { requests, reachedNetwork, faults, violations } = await monitorResources(page);
  const viewer = await openFile(page, runtime, "T112", "resources.md");
  const reader = viewer;
  await expect(reader.locator("[data-diagram-failed]")).toHaveCount(RESOURCE_SOURCES.length);
  const blocks = reader.locator("[data-code-block]");
  await expect(blocks).toHaveCount(RESOURCE_SOURCES.length);
  for (const [index, source] of RESOURCE_SOURCES.entries()) {
    await expect(blocks.nth(index).locator("pre")).toHaveText(source);
    await expect(blocks.nth(index).getByRole("button", { name: "Copy code" })).toBeEnabled();
  }
  // These load attempts reach Chromium's request observer but are all rejected by the frame's CSP,
  // before Playwright's network route (and therefore the server). Never mistake an event for a sent request.
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.frame().url()).toContain("/mermaid-frame.html");
    expect(request.failure()?.errorText).toMatch(/csp|ERR_BLOCKED_BY_CSP/i);
  }
  expect(reachedNetwork).toEqual([]);
  expect(violations.length).toBeGreaterThan(0);
  expect(faults).toEqual([]);
  await test.info().attach("blocked-resources", { body: JSON.stringify({ requests: requests.map(request => ({ url: request.url(), failure: request.failure(), frame: request.frame().url() })), reachedNetwork, violations }, null, 2), contentType: "application/json" });
  await expect(page.frameLocator("[data-mermaid-frame]").locator("[data-mermaid-render]")).toHaveCount(0);
});



test("resource-like labels stay diagrams without creating HTML elements or image requests", async ({ page, runtime }) => {
  const attempts: string[] = [], faults: string[] = [];
  await page.route(/mermaid-?probe|\/x$/, route => route.abort());
  page.on("request", request => { if (/mermaid-?probe|\/x$/.test(request.url())) attempts.push(request.url()); });
  page.on("pageerror", error => faults.push(error.message));
  page.on("console", message => { if (message.type() === "error") faults.push(message.text()); });
  const viewer = await openFile(page, runtime, "T112", "labels.md");
  const reader = viewer;
  const images = reader.locator("[data-mermaid-figure] img");
  await expect(images).toHaveCount(LABEL_SOURCES.length);
  for (const [index, image] of (await images.all()).entries()) {
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const svg = await image.evaluate(img => decodeURIComponent(img.getAttribute("src")!.split(",").slice(1).join(",")));
    expect(svg).not.toMatch(/<(?:img|image|foreignObject)\b/i);
    // Wider wrapping can keep a URL-shaped *text label* in one tspan. Check actual
    // attribute/CSS references, without depending on where Mermaid splits the label.
    const references = await image.evaluate(img => {
      const svg = decodeURIComponent(img.getAttribute("src")!.split(",").slice(1).join(","));
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      return [...parsed.querySelectorAll("*")].flatMap(element => [...element.attributes].map(attr => attr.value))
        .concat([...parsed.querySelectorAll("style")].map(style => style.textContent ?? "")).join("\n");
    });
    expect(references).not.toContain("mermaid-probe.png");
    // The two absolute block-style inputs are truncated at the scheme colon by Mermaid 12.
    if (index < 2) expect(svg).not.toContain("mermaid-probe.png");
  }
  await expect(reader.locator("[data-diagram-failed]")).toHaveCount(0);
  await expect(page.locator("[data-mermaid-render]")).toHaveCount(0);
  expect(attempts).toEqual([]);
  expect(faults).toEqual([]);
});


async function monitorResources(page: import("@playwright/test").Page) {
  const requests: import("@playwright/test").Request[] = [], reachedNetwork: string[] = [], faults: string[] = [], violations: string[] = [];
  await page.route(/mermaid-?probe|\/x$/, route => { reachedNetwork.push(route.request().url()); return route.abort(); });
  page.on("request", request => { if (/mermaid-?probe|\/x$/.test(request.url())) requests.push(request); });
  page.on("pageerror", error => faults.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (/Content Security Policy|content security policy/.test(message.text()) && /(?:img|media|font|connect|frame|object)-src 'none'|style-src 'unsafe-inline'/.test(message.text())) violations.push(message.text());
    else faults.push(message.text());
  });
  return { requests, reachedNetwork, faults, violations };
}


test("removing the frame image policy makes the network observer detect the formerly blocked load", async ({ page, runtime }) => {
  const reachedNetwork: string[] = [];
  // Negative control: change this test's HTTP response only, and abort before any probe can reach a server.
  await page.route("**/mermaid-frame.html", async route => {
    const response = await route.fetch();
    const headers = response.headers();
    headers["content-security-policy"] = headers["content-security-policy"]!.replace("img-src 'none'", "img-src 'self'");
    await route.fulfill({ response, headers });
  });
  await page.route("**/mermaid-probe.png", route => { reachedNetwork.push(route.request().url()); return route.abort(); });
  const viewer = await openFile(page, runtime, "T112", "control.md");
  await expect.poll(() => reachedNetwork.length).toBeGreaterThan(0);
  await expect(viewer.locator("[data-diagram-failed]")).toHaveCount(1);
});
