import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { isMarkdownMediumId, markdownDocument, markdownMedia, markdownMediumId, parseMarkdown } from "../src/domain/markdown";
import { findDiffCommands, reportMediaReferences } from "@alpacawork/contract";
import { decideOf } from "../src/domain/questions";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { renderMermaid, type DiagramResult } from "../src/lib/mermaid";
import { dto, tree, screenData, TestWorkspace, historyFixture } from "./fixtures";
import { ReportFeed } from "../src/features/reader/ReportFeed";
import { useViewStore } from "../src/state/view-store";

vi.mock("../src/lib/mermaid", () => ({ renderMermaid: vi.fn() }));
vi.mock("../src/lib/mermaid-theme", async () => {
  const { palette } = await import("./mermaid-palette");
  return { diagramPalette: (at: Document) => palette(at.documentElement.dataset.theme === "dark" ? "dark" : "light") };
});
const source = "flowchart LR\n  A[受付] --> B[完了]";
const diagram = `\n\`\`\`mermaid\n${source}\n\`\`\`\n`;
const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60"><text y="30">受付 → 完了</text></svg>');
beforeAll(() => startI18n());
afterEach(() => { cleanup(); vi.mocked(renderMermaid).mockReset(); useViewStore.setState(useViewStore.getInitialState()); delete document.documentElement.dataset.theme; });

function body(text: string, published = false) {
  const files = ["same.png", "clip.mp4"].map(name => ({ name, size: 8, revision: "r", at: "2026-10-20T10:00:00Z" }));
  const data = screenData(tree({ tasks: [dto({ files })] }));
  return render(<TestWorkspace data={data}><MarkdownBody task={published ? null : data.tasks[0]!} text={text} onFollow={() => {}}
    files={published ? files.map(file => ({ ...file, path: file.name, src: `/${file.name}`, href: `/${file.name}` })) : undefined} /></TestWorkspace>);
}

test("language fences retain their source and leave an unfinished fence as ordinary code", () => {
  expect(parseMarkdown("```ts\r\nconst a = 1;\r\n```\r\n```mermaid extra\nflowchart LR\n```\n```mermaid\nunclosed")).toEqual([
    { type: "code", language: "ts", text: "const a = 1;", closed: true }, { type: "code", language: "mermaid", text: "flowchart LR", closed: true },
    { type: "code", language: "mermaid", text: "unclosed", closed: false },
  ]);
});

test("a fence written under a list item, bullet or numbered, is a code block under that item, its indent left out", () => {
  expect(parseMarkdown("- 質問:\n  ```\n  Reply language: ja-JP\n    indented\n  ```\n1. 次:\n\n   ```ts\n   const a = 1;\n   ```\n2. 後")).toEqual([
    { type: "list", ordered: false, start: 1, items: [{ text: "質問:", children: [] }] },
    { type: "code", language: "", text: "Reply language: ja-JP\n  indented", closed: true, nested: true },
    { type: "list", ordered: true, start: 1, items: [{ text: "次:", children: [] }] },
    { type: "code", language: "ts", text: "const a = 1;", closed: true, nested: true },
    { type: "list", ordered: true, start: 2, items: [{ text: "後", children: [] }] },
  ]);
  // Every reader finds the same fence: an image in it is code, a git diff in it is a command.
  const fenced = "- 例:\n  ```\n  ![x](shot.png)\n  git diff HEAD~1\n  ```";
  expect(markdownMedia(fenced)).toEqual([]);
  expect(reportMediaReferences(fenced)).toEqual([]);
  expect(findDiffCommands(fenced).map(found => found.command)).toEqual(["git diff HEAD~1"]);
});

test.each(["", "ts", "mermaid"])("an unfinished %s fence keeps literal source and copy without adding media", language => {
  const source = "A[まだ入力中\n![literal](same.png)\n# Not a heading\n- Not a list";
  const text = `Before\n\`\`\`${language}\n${source}`;
  const { container } = body(text);
  expect(container.querySelector("[data-code-block] pre")?.textContent).toBe(source);
  expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  expect(container.querySelector("img,a,h3,li")).toBeNull();
  expect(markdownMedia(text)).toEqual([]);
  expect(renderMermaid).not.toHaveBeenCalled();
});

test("closing a streaming Mermaid fence replaces copyable code with a diagram at its media position", async () => {
  vi.mocked(renderMermaid).mockResolvedValue({ ok: true, src: svg });
  const data = screenData(tree({ tasks: [dto()] }));
  const text = `Before\n\`\`\`mermaid\n${source}`;
  const viewOf = (text: string) => <TestWorkspace data={data}><MarkdownBody text={text} task={data.tasks[0]!} onFollow={() => {}} /></TestWorkspace>;
  const view = render(viewOf(text));
  expect(view.container.querySelector("[data-code-block] pre")?.textContent).toBe(source);
  expect(renderMermaid).not.toHaveBeenCalled();
  view.rerender(viewOf(text + "\n```"));
  await screen.findByRole("button", { name: "Diagram 1" });
  expect(view.container.querySelector("[data-code-block]")).toBeNull();
  expect(markdownMedia(text + "\n```")).toEqual([{ kind: "diagram", occurrence: 0, source }]);
});

test("the inventory preserves mixed order and independent duplicate identities, including invalid references/syntax", () => {
  const text = `![same](same.png)${diagram}![invalid](../bad.png) ![same](same.png)${diagram}![clip](clip.mp4)\n\`![literal](no.png)\`\n\`\`\`mermaid\nbad diagram\n\`\`\`\n\`\`\`mermaid\nunfinished`;
  const media = markdownMedia(text);
  expect(media.map(item => markdownMediumId("R1", item))).toEqual([
    '["R1",0]', '["R1","diagram",0]', '["R1",1]', '["R1",2]', '["R1","diagram",1]', '["R1",3]', '["R1","diagram",2]',
  ]);
  expect(media.filter(item => item.kind === "file").map(item => ({ alt: item.alt, path: item.path }))).toEqual(reportMediaReferences(text));
  expect(markdownDocument(`**![same](same.png)** and ![same](same.png)`).blocks[0]).toMatchObject({ text: { media: [{ at: 2 }, { at: 26 }] } });
});

test("image-only URL numbers follow original lines even when table marks or invalid references do not display", () => {
  const text = `| ![not shown](hidden.png)\n# ![heading](same.png)\n- ![invalid](../bad.png)\n| a | ![cell](same.png) |${diagram}![last](same.png)`;
  const doc = markdownDocument(text);
  expect(doc.media.filter(item => item.kind === "file").map(item => ({ alt: item.alt, path: item.path }))).toEqual(reportMediaReferences(text));
  expect(doc.media.map(item => markdownMediumId("R", item))).toEqual(['["R",0]', '["R",1]', '["R",2]', '["R",3]', '["R","diagram",0]', '["R",4]']);
  expect(doc.blocks[1]).toMatchObject({ type: "heading", text: { media: [{ at: 0, medium: { occurrence: 1 } }] } });
});

test("table media offsets survive empty cells, whitespace, unicode and repeated images", () => {
  const doc = markdownDocument("|  first || \t🙂 **![same](same.png)**  |  ![same](same.png) \t|\r\n|---|---|---|---|");
  expect(doc.blocks).toEqual([{ type: "table", rows: [[
    { text: "first", media: [] },
    { text: "", media: [] },
    { text: "🙂 **![same](same.png)**", media: [{ at: 5, medium: doc.media[0] }] },
    { text: "![same](same.png)", media: [{ at: 0, medium: doc.media[1] }] },
  ]] }]);
  expect(doc.media.map(item => markdownMediumId("R", item))).toEqual(['["R",0]', '["R",1]']);
});

test("URL identity validation accepts diagrams and unchanged file ids, rejecting malformed identities", () => {
  for (const id of ['["R",0]', '["R","diagram",0]']) expect(isMarkdownMediumId(id)).toBe(true);
  for (const id of ['no', '[]', '["",0]', '["R","diagram",-1]', '["R","diagram",1.5]', '["R","video",0]', '["R","diagram",0,0]']) expect(isMarkdownMediumId(id)).toBe(false);
});

test("a question choice's description reaches the common renderer as written, language fence and all", () => {
  const choiceOf = (detail: string) => decideOf([{ decide_question: "Which plan?", decide_choices: [{ decide_choice: "Plan", decide_choice_detail: detail }] }])[0]!.choices[0]!;
  expect(markdownMedia(choiceOf(diagram.trim()).text)).toEqual([{ kind: "diagram", occurrence: 0, source }]);
  expect(choiceOf("```\nA -> B\n```").text).toBe("```\nA -> B\n```");
});

test("loading preserves a quiet placeholder; failure preserves the source and its copy button", async () => {
  let resolve!: (result: DiagramResult) => void;
  vi.mocked(renderMermaid).mockImplementation(() => new Promise(done => { resolve = done; }));
  body(`Before${diagram}After`);
  expect(screen.getByRole("status").textContent).toBe("Preparing diagram…");
  expect(screen.getByText("After")).toBeTruthy();
  await act(async () => resolve({ ok: false, reason: "Module could not be loaded" }));
  expect(screen.getByText("Could not render diagram").title).toBe("Module could not be loaded");
  expect(document.querySelector("[data-code-block] pre")?.textContent).toBe(source);
  expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
});

test.each([false, true])("one body gallery mixes repeated diagrams, repeated images and video (published=%s)", async published => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.mocked(renderMermaid).mockResolvedValue({ ok: true, src: svg });
  body(`**![same](same.png)**${diagram}![same](same.png)${diagram}![clip](clip.mp4)`, published);
  fireEvent.click(await screen.findByRole("button", { name: "Diagram 2" }));
  const dialog = screen.getByRole("dialog", { name: "Diagram 2" });
  expect(screen.getByText("4 of 5")).toBeTruthy();
  expect(dialog.querySelector("[data-image-slider-caption]")?.tagName).toBe("SPAN");
  await waitFor(() => expect(dialog.querySelector("[data-image-slider-current] img")?.getAttribute("src")).toBe(svg));
  fireEvent.click(screen.getByRole("button", { name: "Previous item" }));
  expect(screen.getByText("3 of 5")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(screen.getByRole("dialog", { name: "Diagram 1" })).toBeTruthy();
  expect(screen.getByText("2 of 5")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(screen.getByText("5 of 5")).toBeTruthy();
  expect(screen.getByRole("dialog", { name: "clip" }).querySelector("video")).toBeTruthy();
});

test("the applied theme redraws the diagram and failures in the image itself keep source", async () => {
  vi.mocked(renderMermaid).mockResolvedValue({ ok: true, src: svg });
  body(diagram);
  await screen.findByRole("button", { name: "Diagram 1" });
  act(() => { document.documentElement.dataset.theme = "dark"; });
  await waitFor(() => expect(renderMermaid).toHaveBeenLastCalledWith(source, expect.objectContaining({ theme: "dark" })));
  const image = await screen.findByRole("img", { name: "Diagram 1" });
  fireEvent.error(image);
  expect(screen.getByText("Could not render diagram")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
});

test.each(["comment", "request"] as const)("feed %s diagrams use URL identities while existing image ids stay image-only", async kind => {
  vi.mocked(renderMermaid).mockResolvedValue({ ok: true, src: svg });
  const description = `![same](same.png)${diagram}![same](same.png)${diagram}`;
  const reportKey = kind === "request" ? "request:L1" : "log:T1:L1";
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "same.png", size: 8, revision: "r", at: "2026-10-20T10:00:00Z" }] })],
    history: { T1: historyFixture([{ id: "L1", kind, title: "Mixed report", summary: description }]) } }));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const toggle = document.querySelector<HTMLElement>(`[data-report-key="${reportKey}"] button[aria-expanded]`)!;
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  fireEvent.click(await screen.findByRole("button", { name: "Diagram 2" }));
  expect(useViewStore.getState().image).toBe(JSON.stringify([reportKey, "diagram", 1]));
  expect(screen.getByText("4 of 4")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(useViewStore.getState().image).toBe(JSON.stringify([reportKey, 1]));
  act(() => useViewStore.getState().setImage(JSON.stringify([reportKey, "diagram", 0])));
  expect(screen.getByRole("dialog", { name: "Diagram 1" })).toBeTruthy();
  expect(screen.getByText("2 of 4")).toBeTruthy();
});

test("the copy stands under the drawing, and the slider grows a drawing up to twice its own size", async () => {
  vi.mocked(renderMermaid).mockResolvedValue({ ok: true, src: svg, width: 300, height: 100 });
  body(diagram);
  const open = await screen.findByRole("button", { name: "Diagram 1" });
  expect(open.closest("figure")?.querySelector("figcaption")?.querySelector("button")?.getAttribute("aria-label")).toBe("Copy code");
  expect(open.querySelector("button")).toBeNull();
  fireEvent.click(open);
  const dialog = screen.getByRole("dialog", { name: "Diagram 1" });
  // 600px: twice its 300px; the height it may take, at its 3:1 shape.
  await waitFor(() => expect(dialog.querySelector<HTMLImageElement>("[data-image-slider-current] img")?.style.width)
    .toMatch(/^min\(100%, 600px, .*3.*\(100dvh - 200px\).*\)$/));
});
