import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { Toaster } from "../src/components/ui/toaster";
import { i18n } from "@alpacawork/i18n";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { indexTasks, resolveReference } from "../src/domain/tasks";
import { useGlobalShortcuts } from "../src/features/chrome/use-shortcuts";
import { useViewStore } from "../src/state/view-store";
import { useUrlBootstrap } from "../src/state/bootstrap";
import { useEveryTaskIndex } from "../src/data/queries";
import { TestWorkspace, screenData, dto, tree, openReference, pointerCanHover } from "./fixtures";

beforeAll(() => startI18n());
afterEach(() => { cleanup(); vi.restoreAllMocks(); useViewStore.setState(useViewStore.getInitialState()); });
/** The screen's URL owner, for a text whose links move the screen. */
function Bootstrap() { useUrlBootstrap(useEveryTaskIndex()); return null; }
function show(text: string, { urlOwner = false } = {}) {
  const data = screenData(tree({ tasks: [dto(), dto({ id: "T2", parentId: "T1", title: "Child" }), dto({ id: "T3", title: "Other" })] }));
  const follow = vi.fn();
  const view = render(<TestWorkspace data={data}>{urlOwner && <Bootstrap />}<MarkdownBody task={data.tasks[0]!} text={text} onFollow={follow} /></TestWorkspace>);
  return { ...view, follow, data };
}

test("Markdown keeps the approved headings, lists, quotes, tables, bold and code blocks", () => {
  const { container } = show("# Heading\nText **bold** and `code`.\n- one\n- two\n> quote\n| a | b |\n|---|---|\n| c | d |\n```ts\nconst value = 1;\n```");
  expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
  expect(container.querySelectorAll("li")).toHaveLength(2);
  expect(container.querySelector("blockquote")?.textContent).toBe("quote");
  expect(container.querySelectorAll("td")).toHaveLength(4);
  expect(container.querySelector("strong")?.textContent).toBe("bold");
  expect(screen.getByText("const value = 1;")).toBeTruthy();
});

test("a quote's paragraphs parted by a bare \">\" are one quote, and the \">\" is not shown", () => {
  // The coordinator's answer as written: CommonMark's ">" takes an optional space, so a bare ">" is the quote's blank line.
  const { container } = show("追記案は次のとおりです。\n\n> **既存の仕組みを理解してから計画する。** 公式の説明を読む。\n>\n> 要求を分ける。\n>\n> 点検でも確認する。\n\n今回の教訓は次です。");
  const quotes = container.querySelectorAll("blockquote");
  expect(quotes).toHaveLength(1);
  expect([...quotes[0]!.querySelectorAll("p")].map(p => p.textContent)).toEqual(["既存の仕組みを理解してから計画する。 公式の説明を読む。", "要求を分ける。", "点検でも確認する。"]);
  expect(container.textContent).not.toContain(">");
  // A ">" in code stays as written.
  cleanup();
  expect(show("```\n> kept\n```\n`a > b`").container.textContent).toContain("> kept");
});

test("a table cell's width floor is its words as they read, not the marks around them", () => {
  const { container } = show("| [Design note](https://example.com/design) and **Bold** and `code` and ![Image](fig.png) |");
  expect(container.querySelector("td")?.dataset.fit).toBe("Design note and Bold and code and Image");
  cleanup();
  // A link written in code reads as written, so its whole text is the floor.
  const code = show("| `[x](https://example.com/very/long/path)` |");
  expect(code.container.querySelector("td")?.dataset.fit).toBe("[x](https://example.com/very/long/path)");
  cleanup();
  // Emphasis is found first, so a link around it is not a link and reads as written.
  const bold = show("| [**x**](https://example.com/very/long/path) |");
  expect(bold.container.querySelector("td")?.dataset.fit).toBe(bold.container.querySelector("td")?.textContent);
  expect(bold.container.querySelector("td")?.dataset.fit).toBe("[x](https://example.com/very/long/path)");
});

test("text written outside any task has no Task folder: relative paths and images stay text, absolute paths and task IDs work", () => {
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "fig.png", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" }] }), dto({ id: "T2", title: "Other" })] }));
  // No task means no folder of its own: a Task is named by its number alone.
  const text = "`fig.png` and [Image](fig.png) and /home/me/notes.txt and [Bad](javascript:void0) and T2\n\n![chart](fig.png)";
  const view = render(<TestWorkspace data={data}><MarkdownBody task={null} text={text} onFollow={() => {}} report /></TestWorkspace>);
  const area = view.container;
  expect(area.querySelector("img")).toBeNull();
  expect(area.querySelector("a")).toBeNull();
  expect([...area.querySelectorAll("code")].map(code => code.textContent)).toEqual(["fig.png", "/home/me/notes.txt"]);
  expect(screen.getByRole("button", { name: /\/home\/me\/notes\.txt/ })).toBeTruthy();
  expect(area.textContent).toContain("Bad");
  expect(area.querySelector("[data-task-reference='T2']")).not.toBeNull();
  expect(area.textContent).toContain("chart");
});

test("report descriptions use the task body's Markdown blocks and keep image enlargement", () => {
  const task = dto({ files: [{ name: "fig.png", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" }] });
  const data = screenData(tree({ tasks: [task, dto({ id: "T2", title: "Other" })] }));
  const text = "# Heading\n| a | b |\n|---|---|\n| c | d |\n```\nexact code\n```\n> quote\n\n- **bold** and `code`\n- [other](T2)\n\n![chart](fig.png)";
  const view = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} onFollow={() => {}} report /></TestWorkspace>);
  expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
  expect(view.container.querySelector("pre")?.textContent).toContain("exact code");
  expect(screen.getByRole("button", { name: "other" })).toBeTruthy();
  expect(screen.getByRole("img", { name: "chart" }).getAttribute("src")).toContain("fig.png");
  // The image and its caption are framed as one figure, apart from the text.
  expect(view.container.querySelector("figure")!.className).toMatch(/(?=.*\bborder-line\b)(?=.*\bbg-bg\b)/);
  fireEvent.click(screen.getByRole("button", { name: "chart" }));
  expect(screen.getByRole("dialog", { name: "chart" })).toBeTruthy();
});

test("a video in report and overview Markdown plays in place and opens in the slider", () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const task = dto({ files: [{ name: "files/demo.webm", size: 24 * 1024 * 1024, revision: "rev1", at: "2026-09-24T09:00:00Z" }] });
  const data = screenData(tree({ tasks: [task] }));
  const view = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="![demo](files/demo.webm)" onFollow={() => {}} /></TestWorkspace>);
  expect(view.container.querySelector("figure video[controls]")).toBeTruthy();
  expect(view.container.querySelector("video")?.getAttribute("src")).toContain("/api/tasks/T1/file?path=files%2Fdemo.webm&v=rev1#t=0.001");
  fireEvent.click(screen.getByRole("button", { name: "Open video in viewer" }));
  expect(screen.getByRole("dialog", { name: "demo" }).querySelector("video:not([controls])")).toBeTruthy();
  expect(screen.getByRole("slider", { name: "Playback position" })).toBeTruthy();
  expect(pause).toHaveBeenCalled();
});

test("arrow keys on the video's seek stay with playback instead of moving the slider", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const files = ["one.webm", "two.mp4"].map(name => ({ name, size: 100, revision: "rev1", at: "2026-09-24T09:00:00Z" }));
  const data = screenData(tree({ tasks: [dto({ files })] }));
  const gallery = files.map((file, index) => ({ id: JSON.stringify(["report", index]), reportKey: "report", path: file.name,
    alt: file.name, src: `/api/tasks/T1/file?path=${encodeURIComponent(file.name)}` }));
  render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="![one.webm](one.webm)" report
    gallery={gallery} galleryReportKey="report" onFollow={() => {}} /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Open video in viewer" }));
  const dialog = screen.getByRole("dialog", { name: "one.webm" });
  const seek = dialog.querySelector<HTMLInputElement>("[data-video-seek]")!;
  fireEvent.keyDown(seek, { key: "ArrowRight" });
  expect(screen.getByText("1 of 2")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Next item|Next/ }));
  expect(screen.getByText("2 of 2")).toBeTruthy();
});

test("the viewer's portal owns control clicks and keys instead of toggling the report or form behind it", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const click = vi.fn(), key = vi.fn();
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "clip.webm", size: 100, revision: "r", at: "2026-09-24T09:00:00Z" }] })] }));
  render(<TestWorkspace data={data}><div onClick={click} onKeyDown={key}>
    <MarkdownBody task={data.tasks[0]!} text="![clip](clip.webm)" onFollow={() => {}} />
  </div></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Open video in viewer" }));
  click.mockClear(); key.mockClear();
  const play = screen.getByRole("button", { name: "Play" });
  await act(async () => { fireEvent.keyDown(play, { key: " " }); fireEvent.click(play); });
  fireEvent.keyDown(screen.getByRole("slider", { name: "Playback position" }), { key: "ArrowRight" });
  expect(click).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
  expect(screen.queryByRole("dialog", { name: "clip" })).toBeNull();
  expect(click).not.toHaveBeenCalled();
});

test("a heading sits near the block it heads and far from the one above; #### is a smaller h4", () => {
  const { container } = show("Intro\n### 1 Question\n#### Now\nKeep it.\nMore.\n- a\n- b\n```\ncode\n```\n#### Option");
  const [intro, question, now, keep, more, list, code, option] = [...container.firstElementChild!.children] as HTMLElement[];
  expect(intro!.tagName).toBe("P");
  expect(question!.tagName).toBe("H3");
  expect(question!.className).toContain("mt-type-section");
  expect(now!.tagName).toBe("H4");
  // A heading right under a heading is one block step down, so the two still read as two lines.
  expect(now!.className).toContain("mt-type-block");
  expect(keep!.className).toContain("mt-type-close");
  for (const block of [more, list, code]) expect(block!.className).toContain("mt-type-block");
  expect(option!.tagName).toBe("H4");
  expect(option!.className).toContain("mt-type-section");
  // Code and quotes drop their own bottom margin, so only the next block's top space is between them.
  expect(code!.className).toContain("my-0");
});

test("the time note's code frame has its padding once, not again on the code inside", () => {
  const data = screenData(tree({ tasks: [dto()] }));
  const view = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={"```\ncode\n```"} onFollow={() => {}} report variant="note" /></TestWorkspace>);
  const frame = view.container.firstElementChild!.firstElementChild as HTMLElement;
  expect(frame.className).toContain("p-2");
  expect(frame.querySelector("pre")!.className).toContain("p-0");
  expect(frame.querySelector("pre")!.className).not.toContain("p-2");
});

test("report images with spaces render, while image notation in inline code stays literal", () => {
  const task = dto({ files: [{ name: "my image.png", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" }] });
  const data = screenData(tree({ tasks: [task] }));
  render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={"![spaced](my image.png) `![missing](no.png)`"} onFollow={() => {}} report /></TestWorkspace>);
  expect(screen.getByRole("img", { name: "spaced" }).getAttribute("src")).toContain("my%20image.png");
  fireEvent.click(screen.getByRole("button", { name: "spaced" }));
  expect(screen.getByRole("dialog", { name: "spaced" })).toBeTruthy();
  expect(screen.getByText("![missing](no.png)", { selector: "code" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "missing" })).toBeNull();
});

test("a report image immediately after text opens the same image modal", () => {
  const task = dto({ files: [{ name: "my image.png", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" }] });
  const data = screenData(tree({ tasks: [task] }));
  render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!}
    text={"I checked the results.\n![Following image](my image.png)"} onFollow={() => {}} report /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Following image" }));
  expect(screen.getByRole("dialog", { name: "Following image" })).toBeTruthy();
});

test("an image reference inside a report code fence is plain text", () => {
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "shown.png", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" }] })] }));
  const view = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!}
    text={"```\n![literal](missing.png)\n```\n\n![shown](shown.png)"} onFollow={() => {}} report /></TestWorkspace>);
  expect(view.container.querySelector("pre")?.textContent).toContain("![literal](missing.png)");
  expect(screen.queryByRole("img", { name: "literal" })).toBeNull();
  expect(screen.getByRole("img", { name: "shown" })).toBeTruthy();
  expect(view.container.querySelectorAll("figure")).toHaveLength(1);
});

test("under the task's title, a first heading that repeats the title is left out; any other heading stays", () => {
  const data = screenData(tree({ tasks: [dto()] }));
  const under = (text: string) => render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} onFollow={() => {}} underTitle /></TestWorkspace>);
  const repeated = under("# Task one\nFirst line\n# Task one");
  // Only the leading one goes: the same words later in the body are the body's own.
  expect(screen.getAllByRole("heading", { name: "Task one" })).toHaveLength(1);
  expect(repeated.container.firstElementChild?.firstElementChild?.textContent).toBe("First line");
  cleanup();
  under("# Another heading\nFirst line");
  expect(screen.getByRole("heading", { name: "Another heading" })).toBeTruthy();
  cleanup();
  // Elsewhere (not under the title) the heading is kept.
  show("# Task one\nFirst line");
  expect(screen.getByRole("heading", { name: "Task one" })).toBeTruthy();
});

test("raw HTML, executable/data links and image URLs never create executable elements or requests", () => {
  const { container } = show('<script>alert(1)</script>\n<img src="https://evil.test/pixel" onerror="alert(2)">\n[x](javascript:alert(3)) [data](data:text/html,evil) [file](file:///etc/passwd)\n![tracking](https://evil.test/track)\n<iframe src="https://evil.test/frame"></iframe>');
  expect(container.querySelector("script,img,iframe,object,embed")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
  expect(container.textContent).toContain("tracking");
});

test("a report image traps focus in its modal and restores focus on Escape or the curtain", async () => {
  function Shortcuts() { useGlobalShortcuts(); return null; }
  const data = screenData(tree({ tasks: [dto({ files: [
    { name: "report.png", size: 123, revision: "a".repeat(64), at: "2026-10-10T10:00:00Z" },
  ] })] }));
  useViewStore.setState({ selected: "T1", reader: { ...useViewStore.getInitialState().reader, open: true } });
  render(<TestWorkspace data={data}><Shortcuts /><MarkdownBody task={data.tasks[0]!} text="![Check point in red](report.png)" report onFollow={() => {}} /></TestWorkspace>);
  const trigger = screen.getByRole("button", { name: "Check point in red" });
  trigger.focus();
  fireEvent.click(trigger);
  const modal = document.querySelector<HTMLElement>("[data-image-slider-modal]")!;
  expect(modal).toBeTruthy();
  expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Check point in red");
  const close = screen.getByRole("button", { name: /Close image/ });
  const file = screen.getByRole("link", { name: /new tab/ });
  expect(close).toBe(document.activeElement);
  expect(file.getAttribute("target")).toBe("_blank");
  const lastControl = screen.getByRole("dialog").querySelectorAll<HTMLElement>("button:not([disabled]), a[href]");
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(lastControl[lastControl.length - 1]).toBe(document.activeElement);
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(close).toBe(document.activeElement);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(document.querySelector("[data-image-slider-modal]")).toBeNull();
  await waitFor(() => expect(trigger).toBe(document.activeElement));
  expect(useViewStore.getState().reader.open).toBe(true);
  fireEvent.keyDown(trigger, { key: "Escape" });
  expect(useViewStore.getState().reader.open).toBe(false);
  fireEvent.click(trigger);
  fireEvent.click(document.querySelector("[data-image-slider-modal]")!);
  expect(document.querySelector("[data-image-slider-modal]")).toBeNull();
  await waitFor(() => expect(trigger).toBe(document.activeElement));
  useViewStore.setState(useViewStore.getInitialState());
});

// Swipes, two fingers and wheels need a browser's layout and touch input: e2e/video-slider and report-image check them.
test("report carousel keeps a caption below the image and moves by buttons, arrows, and neighbor", () => {
  const files = ["wide.png", "tall.png", "small.png"].map(name => ({ name, size: 123, revision: "rev1", at: "2026-10-10T10:00:00Z" }));
  const data = screenData(tree({ tasks: [dto({ files })] }));
  const gallery = files.map((file, index) => ({ id: JSON.stringify([`report-${index}`, 0]), reportKey: `report-${index}`, path: file.name,
    alt: ["Landscape", "Portrait", "Small image"][index]!, src: `/api/task/file?task=T1&path=${file.name}` }));
  render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="![Portrait](tall.png)" report
    gallery={gallery} galleryReportKey="report-1" onFollow={() => {}} /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
  const dialog = screen.getByRole("dialog", { name: "Portrait" });
  expect(dialog.querySelector("[data-image-slider-current] [data-image-slider-large]")?.nextElementSibling?.hasAttribute("data-image-slider-details")).toBe(true);
  expect(dialog.querySelector("[data-image-slider-track] [data-image-slider-pager]")).toBeNull();
  expect(dialog.querySelector("[data-image-slider-pager]")).toBeTruthy();
  expect(dialog.querySelector("[data-image-slider-thumbs]")).toBeNull();
  expect(screen.getByText("2 of 3")).toBeTruthy();
  expect(dialog.querySelector("[data-image-slider-caption] span")?.textContent).toBe("Portrait");
  expect(dialog.querySelectorAll("[data-image-slider-neighbor]")).toHaveLength(2);
  expect(dialog.querySelector("[data-image-slider-details]")?.className).toContain("text-white");
  fireEvent.click(screen.getByRole("button", { name: /Next image/ }));
  expect(screen.getByText("3 of 3")).toBeTruthy();
  expect(dialog.querySelector("[data-image-slider-caption] span")?.textContent).toBe("Small image");
  fireEvent.keyDown(dialog, { key: "ArrowLeft" });
  expect(screen.getByText("2 of 3")).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  expect(screen.getByText("3 of 3")).toBeTruthy();
  fireEvent.click(dialog.querySelector("[data-image-slider-neighbor]")!);
  expect(screen.getByText("2 of 3")).toBeTruthy();
  fireEvent.click(dialog.querySelector("[data-image-slider-neighbor]")!);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Previous image/ }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(dialog.querySelector("[data-image-slider-details]")!);
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("an open gallery keeps the image selected when a new report arrives", () => {
  const files = ["first.png", "second.png"].map(name => ({ name, size: 1, revision: "rev1", at: "2026-10-10T10:00:00Z" }));
  const data = screenData(tree({ tasks: [dto({ files })] }));
  const first = { id: '["old",0]', reportKey: "old", path: "first.png", alt: "First", src: "/first.png" };
  const second = { id: '["current",0]', reportKey: "current", path: "second.png", alt: "Shown", src: "/second.png" };
  const body = (gallery: typeof first[]) => <TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!}
    text="![Shown](second.png)" report gallery={gallery} galleryReportKey="current" onFollow={() => {}} /></TestWorkspace>;
  const view = render(body([first, second]));
  fireEvent.click(screen.getByRole("button", { name: "Shown" }));
  expect(screen.getByText("2 of 2")).toBeTruthy();
  view.rerender(body([{ id: '["new",0]', reportKey: "new", path: "new.png", alt: "New", src: "/new.png" }, first, second]));
  const dialog = screen.getByRole("dialog", { name: "Shown" });
  expect(dialog.querySelector("[data-image-slider-large]")?.getAttribute("src")).toBe("/second.png");
  expect(screen.getByText("2 of 2")).toBeTruthy();
});

test("a single report image shows its caption without gallery controls", () => {
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "one.png", size: 1, revision: "rev1", at: "2026-10-10T10:00:00Z" }] })] }));
  render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="![Only one](one.png)" report onFollow={() => {}} /></TestWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Only one" }));
  const dialog = screen.getByRole("dialog", { name: "Only one" });
  expect(dialog.querySelector("[data-image-slider-caption] span")?.textContent).toBe("Only one");
  expect(dialog.querySelector("[data-image-slider-count]")).toBeNull();
  expect(dialog.querySelector("[data-image-slider-thumbs]")).toBeNull();
  expect(dialog.querySelector("[data-image-slider-neighbor]")).toBeNull();
  expect(dialog.querySelector("[data-image-slider-pager]")).toBeNull();
  expect(screen.queryByRole("button", { name: /Next image/ })).toBeNull();
});

test("the second use of the same image opens at its own gallery position", () => {
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "same.png", size: 1, revision: "rev1", at: "2026-10-10T10:00:00Z" }] })] }));
  const gallery = [0, 1].map(index => ({ id: JSON.stringify(["R1", index]), reportKey: "R1", path: "same.png", alt: "Same image", src: "/same.png" }));
  render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!}
    text="![Same image](same.png) ![Same image](same.png)" report gallery={gallery} galleryReportKey="R1" onFollow={() => {}} /></TestWorkspace>);
  fireEvent.click(screen.getAllByRole("button", { name: "Same image" })[1]!);
  expect(screen.getByText("2 of 2")).toBeTruthy();
});

test("prose and explicit task references open the task with that ID while inline and fenced code stay literal", () => {
  const { container, follow } = show("T2 and [child](T2) and T3.\n`T3`\n```\nT3\n```\n[external](https://example.test/a) [missing](../T2) XT3 T3tail T9");
  openReference(screen.getByRole("button", { name: "T2" }));
  openReference(screen.getByRole("button", { name: "child" }));
  openReference(screen.getByRole("button", { name: "T3" }));
  expect(follow.mock.calls).toEqual([["T2"], ["T2"], ["T3"]]);
  expect(container.querySelector("code button,pre button")).toBeNull();
  expect(screen.getAllByRole("button", { name: "T3" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "T9" })).toBeTruthy();
  const external = screen.getByRole("link", { name: "external" });
  expect(external.getAttribute("target")).toBe("_blank");
  expect(external.getAttribute("rel")).toBe("noreferrer noopener");
  expect(screen.queryByRole("button", { name: "missing" })).toBeNull();
});

test("bare web addresses of another origin open in a new tab, this screen's in this tab, and code and links stay as they are", () => {
  history.replaceState(null, "", "/?agent=1");
  const origin = location.origin;
  const { container, follow } = show([
    "Prototype screen: https://pc.example-tail.ts.net:10000/?agent=1 （Open on a phone）",
    `- Internal: ${origin}/api/tasks/T1/file?path=files%2Fnotes.md and ${origin}/?task=T2 and ${origin}/?task=T3&tab=about and ${origin}/?task=T1&tab=files&path=files%2F&image=files%2Fbare-url.png and ${origin}/?agent=1 and ${origin}/?task=T9 and ${origin}/api/workspace/live`,
    "`https://code.test/a` and [Name](https://named.test/b) and [Child](" + origin + "/?task=T2)",
    "```",
    "https://fenced.test/c",
    "```",
  ].join("\n"), { urlOwner: true });
  const links = [...container.querySelectorAll("a")].map(link => [link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]);
  expect(links).toEqual([
    ["https://pc.example-tail.ts.net:10000/?agent=1", "https://pc.example-tail.ts.net:10000/?agent=1", "_blank", "noreferrer noopener"],
    ["notes.md", "/?task=T1&tab=files&path=files%2F&view=T1%2Ffiles%2Fnotes.md", null, null],
    ["bare-url.png", "/?task=T1&tab=files&path=files%2F&image=files%2Fbare-url.png", null, null],
    [`${origin}/?agent=1`, `${origin}/?agent=1`, null, null],
    [`${origin}/?task=T9`, `${origin}/?task=T9`, null, null],
    [`${origin}/api/workspace/live`, `${origin}/api/workspace/live`, null, null],
    ["Name", "https://named.test/b", "_blank", "noreferrer noopener"],
  ]);
  openReference(screen.getByRole("button", { name: "T2" }));
  openReference(screen.getByRole("button", { name: "Child" }));
  openReference(screen.getByRole("button", { name: "T3" }));
  expect(follow.mock.calls).toEqual([["T2"], ["T2"], ["T3"]]);
  fireEvent.click(screen.getByRole("link", { name: "bare-url.png" }));
  expect(useViewStore.getState()).toMatchObject({ selected: "T1" });
  expect(new URL(location.href).searchParams.get("agent")).toBe("1");
  expect([...container.querySelectorAll("code")].map(code => code.textContent)).toEqual(["https://code.test/a"]);
  expect(container.querySelector("pre")?.textContent).toContain("https://fenced.test/c");
  history.replaceState(null, "", "/");
});

test("a link to a state of this screen opens in it as a history step; a modified press is left to the browser", () => {
  history.replaceState(null, "", "/?task=T1");
  const steps = history.length;
  // What the link left to the browser, which then stops it (the test's document goes nowhere).
  const leftToBrowser: boolean[] = [];
  const browser = (event: MouseEvent) => { leftToBrowser.push(!event.defaultPrevented); event.preventDefault(); };
  window.addEventListener("click", browser);
  try {
    show(`${location.origin}/?q=invoice and ${location.origin}/?project=P100 and [Invoice search](${location.origin}/?q=bill)`, { urlOwner: true });
    const search = screen.getByRole("link", { name: `${location.origin}/?q=invoice` });
    fireEvent.click(search);
    expect(location.search).toBe("?q=invoice");
    // The list's search is no place in the reader: nothing is behind it for the reader's Back.
    expect(history.state).toMatchObject({ alpacaworkNavigation: 1 });
    expect(history.state.behind ?? null).toBeNull();
    expect(history.length).toBe(steps + 1);
    fireEvent.click(screen.getByRole("link", { name: `${location.origin}/?project=P100` }), { metaKey: true });
    expect(leftToBrowser).toEqual([false, true]);
    expect(location.search).toBe("?q=invoice");
    expect(history.length).toBe(steps + 1);
    // A named link to the screen keeps its name and goes the same way.
    fireEvent.click(screen.getByRole("link", { name: "Invoice search" }));
    expect(location.search).toBe("?q=bill");
    expect(history.length).toBe(steps + 2);
  } finally {
    window.removeEventListener("click", browser);
    history.replaceState(null, "", "/");
  }
});

test("resolveReference finds the task with that exact ID anywhere in the tree, never paths or malformed IDs", () => {
  const data = screenData(tree({ tasks: [dto(), dto({ id: "T2", parentId: "T1" }), dto({ id: "T3" }), dto({ id: "T4", parentId: "T3" })] }));
  const index = indexTasks(data.tasks);
  for (const id of ["T1", "T2", "T3", "T4", "T9", "P99"]) expect(resolveReference(id, index)?.id).toBe(id);
  for (const written of ["T1/T2", "T2/index.md", "./T2", "T2.md", "../T2", "/etc/passwd", "T0", "T9999999999", "javascript:alert(1)"]) expect(resolveReference(written, index)).toBeUndefined();
});

test("a slash between two flat Task IDs links each one, while file paths stay text", () => {
  const { follow } = show("T2/T3 and T2/index.md and T2.md and ./T2 and T2/T3.md");
  openReference(screen.getByRole("button", { name: "T2" }));
  openReference(screen.getByRole("button", { name: "T3" }));
  expect(follow.mock.calls).toEqual([["T2"], ["T3"]]);
  expect(screen.getAllByRole("button", { name: "T2" })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "T3" })).toHaveLength(1);
});

test("a three-segment folder route is not partly treated as a Task ID", () => {
  const { follow } = show("T1/T2/T3");
  expect(screen.queryByRole("button", { name: "T1" })).toBeNull();
  expect(screen.queryByRole("button", { name: "T2" })).toBeNull();
  expect(screen.queryByRole("button", { name: "T3" })).toBeNull();
  expect(follow).not.toHaveBeenCalled();
});

test.each([
  ["・", "全試験を通して commit し、/tmp/queue-wt-b・/tmp/queue-wt-c は撤去してから返す。"],
  ["、", "/tmp/a/one.md、/Users/me/two.md を見る"],
  [",", "see /tmp/a/one.md,/Users/me/two.md now"],
  ["，", "查看/tmp/a/one.md，/Users/me/two.md"],
  ["،", "راجع /tmp/a/one.md،/Users/me/two.md"],
])("bare paths joined by %s each keep their whole path and their own copy", (_, text) => {
  const { container } = show(text);
  const written = text.match(/\/(?:tmp|Users)\/[\w./-]+/g)!;
  expect(written).toHaveLength(2);
  expect([...container.querySelectorAll("code")].map(code => code.textContent)).toEqual(written);
  expect(screen.getAllByRole("button", { name: /^Copy path: / }).map(button => button.getAttribute("aria-label"))).toEqual(written.map(path => `Copy path: ${path}`));
  expect(container.textContent).not.toContain("…");
});

test("a bare path keeps the dashes, quotes and brackets of its file name and ends at prose brackets", () => {
  const { container } = show("「/Users/me/【確定】資料.pdf」と（/Users/me/a〜b—c.md）と /Users/me/Bob’s.md");
  expect([...container.querySelectorAll("code")].map(code => code.textContent)).toEqual(["/Users/me/【確定】資料.pdf", "/Users/me/a〜b—c.md", "/Users/me/Bob’s.md"]);
});

test("broken Markdown remains inert and a partial fence does not create links", () => {
  const { container } = show("**unfinished `quote\n[unfinished](javascript:\n```\nT2\n<img src=x>");
  expect(container.querySelector("a,img,script")).toBeNull();
  expect(screen.queryByRole("button", { name: "T2" })).toBeNull();
  expect(container.querySelector("[data-code-block] pre")?.textContent).toBe("T2\n<img src=x>");
  expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
});

// A copy that worked turns the mark itself to ✓; one that failed says what to do instead.
test.each([false, true])("code copy reports success or denied clipboard once (denied: %s)", async (denied) => {
  const writeText = denied ? vi.fn().mockRejectedValue(new Error("Denied")) : vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<Toaster />);
  show("```\nexact code\n```");
  const copy = screen.getByRole("button", { name: "Copy code" });
  expect(copy.textContent).toBe("");
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("exact code"));
  if (denied) expect(await screen.findByText(i18n.t("ui:copyFailed"))).toBeTruthy();
  else {
    expect((await screen.findByRole("button", { name: i18n.t("ui:copied") })).getAttribute("data-copy")).toBe("done");
    expect(screen.queryByText(i18n.t("ui:copied"))).toBeNull();
  }
});

test("resting the pointer on a task named in the text shows its actionable card, whose Open follows it", () => {
  vi.useFakeTimers();
  pointerCanHover();
  try {
    const { follow } = show("See T3.");
    function Shortcuts() { useGlobalShortcuts(); return null; }
    render(<Shortcuts />);
    const reference = screen.getByRole("button", { name: "T3" });
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => { vi.advanceTimersByTime(600); });
    const peek = screen.getByRole("dialog", { name: "T3" });
    expect(document.querySelector("[data-task-peek]")).toBeNull();
    expect(peek.textContent).toContain("Other");
    fireEvent.click(peek.querySelector<HTMLElement>("[data-task-card-open]")!);
    expect(follow).toHaveBeenCalledWith("T3");
  } finally { vi.useRealTimers(); }
});

test("a task named in the text shows the input's task card on its press: nothing moves until its Open, and Esc, a press outside or resting again brings back nothing else", () => {
  vi.useFakeTimers();
  try {
    const { follow } = show("See T3.");
    function Shortcuts() { useGlobalShortcuts(); return null; }
    render(<Shortcuts />);
    const reference = screen.getByRole("button", { name: "T3" });
    reference.focus();
    fireEvent.click(reference);
    const card = screen.getByRole("dialog", { name: "T3" });
    expect(card.textContent).toContain("Other");
    expect(follow).not.toHaveBeenCalled();
    // Opened from the focus, the focus is on its Open; resting on the name meanwhile brings up no second card.
    expect(document.activeElement).toBe(card.querySelector("[data-task-card-open]"));
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Esc closes it and gives the focus back, and no resting card takes its place.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(reference);
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("tooltip")).toBeNull();
    // A press outside closes it too.
    fireEvent.click(reference);
    expect(screen.getByRole("dialog", { name: "T3" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(follow).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

test("Escape on a task's hover card closes only the card; the reader under it stays open", () => {
  vi.useFakeTimers();
  pointerCanHover();
  function Shortcuts() { useGlobalShortcuts(); return null; }
  try {
    const data = screenData(tree({ tasks: [dto(), dto({ id: "T3", title: "Other" })] }));
    useViewStore.setState({ selected: "T1", reader: { ...useViewStore.getInitialState().reader, open: true } });
    render(<TestWorkspace data={data}><Shortcuts /><MarkdownBody task={data.tasks[0]!} text="See T3." onFollow={() => {}} /></TestWorkspace>);
    fireEvent.pointerEnter(screen.getByRole("button", { name: "T3" }), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByRole("dialog", { name: "T3" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "T3" })).toBeNull();
    expect(useViewStore.getState().reader.open).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useViewStore.getState().reader.open).toBe(false);
  } finally { vi.useRealTimers(); useViewStore.setState(useViewStore.getInitialState()); }
});

test("leaving a reference cancels its pending hover; where the pointer can hover, pressing the reference opens its task", () => {
  vi.useFakeTimers();
  pointerCanHover();
  try {
    const { follow } = show("See T3.");
    const reference = screen.getByRole("button", { name: "T3" });
    expect(reference.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    fireEvent.pointerLeave(reference);
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByRole("dialog", { name: "T3" })).toBeTruthy();
    fireEvent.click(reference);
    expect(follow).toHaveBeenCalledWith("T3");
    expect(screen.queryByRole("dialog")).toBeNull();
  } finally { vi.useRealTimers(); }
});

test("a task's card in the reader closes when the reader moves to another task, and so does one waiting to open", () => {
  vi.useFakeTimers();
  pointerCanHover();
  try {
    const data = screenData(tree({ tasks: [dto(), dto({ id: "T2", parentId: "T1", title: "Child" }), dto({ id: "T3", title: "Other" })] }));
    useViewStore.setState({ selected: "T1", reader: { ...useViewStore.getInitialState().reader, open: true } });
    render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="See T3." onFollow={() => {}} /></TestWorkspace>);
    const reference = screen.getByRole("button", { name: "T3" });
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByRole("dialog", { name: "T3" })).toBeTruthy();
    act(() => useViewStore.getState().openTask("T2", { reader: true }));
    expect(screen.queryByRole("dialog", { name: "T3" })).toBeNull();
    // Resting on it again, the reader moves before the card opens: it does not open.
    fireEvent.pointerLeave(reference);
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerEnter(reference, { pointerType: "mouse" });
    act(() => useViewStore.getState().openTask("T1", { reader: true }));
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole("dialog", { name: "T3" })).toBeNull();
  } finally { vi.useRealTimers(); }
});

test('published answer files use the reports media renderer while ordinary links open the managed snapshot', () => {
  const files = [
    { path: '/tmp/preview.png', name: 'preview.png', src: '/api/coordinator/file?requestId=owned&name=preview.png&area=answers', href: '/api/coordinator/file?requestId=owned&name=preview.png&area=answers', size: 20 },
    { path: '/tmp/note.txt', name: 'note.txt', src: '/api/coordinator/file?requestId=owned&name=note.txt&area=answers', href: '/api/coordinator/file?requestId=owned&name=note.txt&area=answers', size: 20 },
    { path: '/tmp/broken.png', name: 'broken.png', src: null, href: null, size: 0 },
  ];
  const { container } = render(<TestWorkspace><MarkdownBody task={null} onFollow={() => {}} variant="note" files={files}
    text={'![Preview](/tmp/preview.png)\n[Description](/tmp/note.txt)\n![Broken image](/tmp/broken.png)'} /></TestWorkspace>);
  expect(screen.getByRole('img', { name: 'Preview' }).getAttribute('src')).toBe(files[0]!.src);
  expect(screen.getByRole('link', { name: 'Description' }).getAttribute('href')).toBe(files[1]!.href);
  expect(screen.getByText(i18n.t('reader:image.unavailable', { name: 'Broken image' }))).toBeTruthy();
  expect(container.querySelector('figure [data-report-image-trigger]')).toBeTruthy();
  expect(container.querySelectorAll('[title="/tmp/preview.png"]')).toHaveLength(0);
});

test('a replaced Task file gets a fresh media lifetime after its prior revision failed', () => {
  const make = (revision: string) => screenData(tree({ tasks: [dto({ files: [{ name: 'fig.png', size: 8, revision, at: '2026-09-24T09:00:00Z' }] })] }));
  const first = make('rev1');
  const show = (data: ReturnType<typeof make>) => <TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="![chart](fig.png)" onFollow={() => {}} /></TestWorkspace>;
  const view = render(show(first));
  fireEvent.error(screen.getByRole('img', { name: 'chart' }));
  expect(screen.queryByRole('img', { name: 'chart' })).toBeNull();
  expect(screen.getByText(i18n.t('reader:image.unavailable', { name: 'chart' }), { exact: false })).toBeTruthy();
  view.rerender(show(make('rev2')));
  expect(screen.getByRole('img', { name: 'chart' }).getAttribute('src')).toContain('v=rev2');
});

test('a sound in a body plays in the browser\'s player, and one it cannot play leads to its original bytes', () => {
  const data = screenData(tree({ tasks: [dto({ files: [{ name: 'take.mp3', size: 8, revision: 'r1', at: '2026-09-24T09:00:00Z' }] })] }));
  const { container } = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text="![take](take.mp3)" onFollow={() => {}} /></TestWorkspace>);
  const audio = container.querySelector('audio[controls]')!;
  expect(audio.getAttribute('aria-label')).toBe('take');
  fireEvent.error(audio);
  expect(screen.getByRole('link', { name: i18n.t('reader:image.saveFile') }).getAttribute('href')).toMatch(/path=take\.mp3&v=r1&download=1$/);
});

test("numbered lines are an ordered list, its items as close as a bullet list's, and inline code one step under its words", () => {
  const { container } = show("1. Choose wording\n2. Apply\n- Bullet\n\n`pnpm build` Run");
  const [ordered, bullets, para] = [...container.firstElementChild!.children] as HTMLElement[];
  expect(ordered!.tagName).toBe("OL");
  expect(ordered!.getAttribute("start")).toBe("1");
  expect([...ordered!.children].map(item => item.textContent)).toEqual(["Choose wording", "Apply"]);
  expect(ordered!.className).toContain("list-decimal");
  expect(bullets!.tagName).toBe("UL");
  expect(ordered!.className).toContain("[&>li+li]:mt-type-close");
  expect(para!.querySelector("code")!.className).toContain("text-sm");
});

test("lists read the same with Windows line ends", () => {
  const { container } = show("- First item\r\n- Second item\r\n1. Number\r\n2. Next\r\n");
  const [bullets, ordered] = [...container.firstElementChild!.children] as HTMLElement[];
  expect(bullets!.tagName).toBe("UL");
  expect([...bullets!.children].map(item => item.textContent)).toEqual(["First item", "Second item"]);
  expect(ordered!.tagName).toBe("OL");
  expect(ordered!.children).toHaveLength(2);
});

test("HTML in Markdown draws only its permitted tags and attributes; scripts, handlers and unsafe addresses go", () => {
  const { container } = show([
    '<p align="center" onclick="alert(1)" style="color:red">',
    '  <b>Bold</b><br>',
    '  <a href="javascript:alert(2)">bad</a> <a href="https://example.com/x" onmouseover="alert(3)">web</a>',
    '</p>',
    '<script>alert(4)</script>',
    '<details><summary>More</summary><iframe src="https://evil.test"></iframe>',
    '',
    '- inside **the fold**',
    '</details>',
    '',
    'Run `task get --task <ID>` with <ID> as the <sub>2</sub>nd `<b>code</b>`.',
  ].join("\n"));
  const p = container.querySelector("[data-markdown-html] p")!;
  expect(p.getAttribute("align")).toBe("center");
  expect(p.getAttribute("onclick")).toBeNull();
  expect(p.getAttribute("style")).toBeNull();
  expect(p.querySelector("b")?.textContent).toBe("Bold");
  expect(p.querySelector("br")).not.toBeNull();
  expect([...container.querySelectorAll("a")].map(a => a.getAttribute("href"))).toEqual(["https://example.com/x"]);
  expect(container.querySelector("a")?.getAttribute("onmouseover")).toBeNull();
  expect(container.querySelector("script,iframe")).toBeNull();
  expect(container.textContent).not.toContain("alert");
  expect(container.querySelector("details summary")?.textContent).toBe("More");
  // Markdown after a blank line goes in the fold the HTML left open, up to its closing tag.
  expect(container.querySelector("details li strong")?.textContent).toBe("the fold");
  // A tag outside the permitted ones stays its letters, and code is never HTML.
  expect(container.textContent).toContain("with <ID> as the 2nd");
  expect(container.querySelector("sub")?.textContent).toBe("2");
  expect([...container.querySelectorAll("code")].map(code => code.textContent)).toContain("<b>code</b>");
  cleanup();
  // An HTML block's words are not Markdown; Markdown around a tag in a line still reads; a lone unknown tag is words.
  const more = show([
    '<pre><code>**kept** [as](https://example.com/written)</code></pre>',
    '',
    '<a href="https://example.com/a">https://example.com/a</a>',
    '',
    '**before <sub>2</sub> after** and [hello <b>world</b>](https://example.com/b)',
    '<constructor>',
    '<ID>',
    '- item',
    '<script>secret',
  ].join("\n")).container;
  expect(more.querySelector("pre code")?.textContent).toBe("**kept** [as](https://example.com/written)");
  expect(more.querySelectorAll("a a")).toHaveLength(0);
  expect(more.querySelector("strong sub")?.textContent).toBe("2");
  expect(more.querySelector("a[href='https://example.com/b'] b")?.textContent).toBe("world");
  expect(more.textContent).toContain("<constructor>");
  expect(more.querySelector("li")?.textContent).toBe("item");
  expect(more.textContent).not.toContain("secret");
  cleanup();
  // Tags and Markdown's marks nest but never cut each other: a script's words go, a tag's attribute stays out of the
  // words, a link in a link is its words, and an HTML block's backticks are letters.
  const mixed = show([
    'Text <script>**secret**</script> <a href="https://example.com/c">**bold**</a> <span title="**important**">label</span>',
    '[<a href="https://inner.test/">inner</a>](https://outer.test/)',
    '',
    '<p>A ` <b>bold</b> ` Z</p>',
    '',
    '<h2>Setup</h2>',
  ].join("\n")).container;
  expect(mixed.textContent).not.toMatch(/secret|important|\*\*/);
  expect(mixed.querySelector("a[href='https://example.com/c'] strong")?.textContent).toBe("bold");
  expect(mixed.querySelectorAll("a a")).toHaveLength(0);
  expect(mixed.querySelector("[data-markdown-html] p b")?.textContent).toBe("bold");
  expect(mixed.querySelector("h2[data-anchor='setup']")).not.toBeNull();
  cleanup();
  // Code and tags are read in the order written; a label's "]" in code ends nothing; an omitted end is implied.
  const order = show([
    'Text <span title="`important`">label</span> <script title="`x`">secret</script> [x `]` y](https://example.com/d)',
    '',
    '<ul><li>one<li>two</ul>',
    '<table><col width="100"><tr><td>x</td></tr></table>',
    '<table><tr><td>one<tr><td>two</table>',
    '<table><thead><tr><th>h<tbody><tr><td>b</table>',
  ].join("\n")).container;
  expect(order.textContent).not.toMatch(/important|secret/);
  expect(order.querySelector("span[title='`important`']")?.textContent).toBe("label");
  expect(order.querySelectorAll("li li")).toHaveLength(0);
  expect(order.querySelectorAll("li")).toHaveLength(2);
  expect(order.querySelector("table > colgroup > col")).not.toBeNull();
  expect(order.querySelectorAll("tr tr, tr tbody")).toHaveLength(0);
  cleanup();
  // A closing tag steps out of the innermost open one only.
  const nested = show('<div><details><summary>More</summary>\n\ninside\n\n<p>last</p></details><p>outside</p>\n\n<script>"</div>"</script>\n\n</div>\n\nafter').container;
  expect(nested.querySelector("div details")?.textContent).toContain("last");
  expect(nested.querySelector("div details")?.textContent).toContain("inside");
  expect(nested.querySelector("div details")?.textContent).not.toContain("outside");
  expect(nested.querySelector("[data-markdown-html] > div")?.textContent).toContain("outside");
  expect(nested.querySelector("[data-markdown-html] > div")?.textContent).not.toContain("after");
});

test("an HTML image and link in a file are found from that file's folder, and a #heading link scrolls to the heading", () => {
  const data = screenData(tree({ tasks: [dto({ files: [{ name: "docs/images/hero.png", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" },
    { name: "docs/LICENSE", size: 8, revision: "rev1", at: "2026-09-24T09:00:00Z" }] })] }));
  const text = '<p align="center"><a href="LICENSE">License</a> <a href="#インストール">インストール</a><br>\n<img src="images/hero.png" alt="Hero" width="880"> <img alt="npm" src="https://img.shields.io/npm/v/x"></p>\n\n## インストール\nText\n# Hello <b>world</b>';
  const view = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} sourceFile="docs/opening.md" onFollow={() => {}} /></TestWorkspace>);
  const images = view.container.querySelectorAll("img");
  expect(images).toHaveLength(1);
  expect(images[0]!.getAttribute("src")).toContain("docs%2Fimages%2Fhero.png");
  expect(images[0]!.getAttribute("width")).toBe("880");
  // A web image is not fetched: its words show.
  expect(view.container.textContent).toContain("npm");
  expect(screen.getByRole("link", { name: "License" }).getAttribute("title")).toBe("docs/LICENSE");
  const heading = view.container.querySelector<HTMLElement>("[data-anchor='インストール']")!;
  heading.scrollIntoView = vi.fn();
  fireEvent.click(screen.getByRole("link", { name: "インストール" }));
  expect(heading.scrollIntoView).toHaveBeenCalled();
  expect(view.container.querySelector("[data-anchor='hello-world'] b")?.textContent).toBe("world");
});
