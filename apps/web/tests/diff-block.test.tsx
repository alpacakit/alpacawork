import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import type { TaskDetail } from "../src/data/types";
import type { DiffColours, StructuredDiffDocument } from "../src/features/reader/diff/diff-types";
import { DiffBlock } from "../src/features/reader/diff/DiffBlock";
import { DIFF_LIMITS } from "@alpacawork/contract/report-diff";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";

// The runtime is the processing side's (diff-runtime.ts); here each call waits on the test, as a Worker's answer would.
const calls = vi.hoisted(() => [] as { diff: StructuredDiffDocument; signal: AbortSignal; answer: (colours: DiffColours | null) => void; fail: (error: Error) => void }[]);
import { forgetPaintedColours } from "../src/features/reader/diff/diff-colours";
vi.mock("../src/features/reader/diff/diff-runtime", () => ({
  highlightDiff: (diff: StructuredDiffDocument, signal: AbortSignal) => new Promise<DiffColours | null>((answer, fail) => calls.push({ diff, signal, answer, fail })),
}));

/** jsdom lays nothing out: a frame is seen when the test says so (`see`), at once unless `held`. */
const watched = new Set<{ target: Element; report: IntersectionObserverCallback; self: IntersectionObserver }>();
let held = false;
const see = () => { for (const watch of [...watched]) watch.report([{ isIntersecting: true, target: watch.target } as IntersectionObserverEntry], watch.self); };
class SeenInTest {
  constructor(private report: IntersectionObserverCallback) {}
  observe(target: Element) { const watch = { target, report: this.report, self: this as unknown as IntersectionObserver }; watched.add(watch); if (!held) see(); }
  disconnect() { for (const watch of [...watched]) if (watch.self === (this as unknown)) watched.delete(watch); }
}

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
beforeEach(() => { held = false; vi.stubGlobal("IntersectionObserver", SeenInTest); });
afterEach(async () => { cleanup(); forgetPaintedColours(); vi.restoreAllMocks(); vi.unstubAllGlobals(); calls.length = 0; watched.clear(); await i18n.changeLanguage("en"); });

const PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n export {};";
/** The colours the runtime would give PATCH: `const` and the numbers painted, a list per original line. */
const COLOURS: DiffColours = [null, null, null, null,
  [[1, 6, "#cf222e", "#ff7b72"], [11, 12, "#0550ae", "#79c0ff"]],
  [[1, 6, "#cf222e", "#ff7b72"], [11, 12, "#0550ae", "#79c0ff"]],
  [[1, 7, "#cf222e", "#ff7b72"]]];

function show(text: string) {
  const data = screenData(tree({ tasks: [dto()] }));
  return render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} onFollow={() => {}} /></TestWorkspace>);
}
const frame = (container: HTMLElement, at = 0) => container.querySelectorAll<HTMLElement>("[data-code-block]")[at]!;
/** A diff's rows, each a line of its code; and how each is laid out (its fold's indent), which painting must not change. */
const rows = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>("pre > span")];
const kinds = (block: HTMLElement) => rows(block).map(row => row.dataset.diffLine);
const layout = (block: HTMLElement) => rows(block).map(row => [row.className, row.getAttribute("style"), row.textContent]);
/** Each file's band as read: its pieces (a flex item each, so a selection copies them a line each), the diff's marks aside. */
const bandsOf = (block: HTMLElement) => [...block.querySelectorAll<HTMLElement>("[data-diff-file] > div:first-child")];
const bands = (block: HTMLElement) => bandsOf(block).map(band => [...band.firstElementChild!.children, ...[...band.children].slice(1)]
  .filter(piece => !piece.querySelector("button")).map(piece => piece.textContent));
/** The diff's wrap mark, found by what it is (a toggle) whatever it says next. */
const wrapMark = (block: HTMLElement) => block.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
/** Whether its lines are folded, as its frame says it to its code. */
const folded = (block: HTMLElement) => block.hasAttribute("data-diff-wrap");
const fence = (text: string) => "```diff\n" + text + "\n```";
const painted = (block: HTMLElement) => block.querySelectorAll("[style*='--code-light']");

test("a diff reads at once as its file's band and its rows, their grounds and +/-, then paints its letters in place", async () => {
  const { container } = show("Before.\n\n" + fence(PATCH) + "\n\nAfter.");
  const block = frame(container);
  // Its file is a band: the name, how many lines it adds and removes, the folder under it. No git line is drawn, nor a
  // hunk's line at the file's start; the wrap and copy marks stand in the first band.
  expect(bands(block)).toEqual([["a.ts", "+1 −1", "src/"]]);
  expect([...bandsOf(block)[0]!.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).toEqual(["Wrap lines", "Copy code"]);
  expect(block.textContent).not.toMatch(/diff --git|@@|\+\+\+|---/);
  // Its rows are the lines as written, each with its kind, ground and +/- before any colour comes.
  expect(rows(block).map(row => row.textContent)).toEqual(["-const a = 1;\n", "+const a = 2;\n", " export {};"]);
  expect(kinds(block)).toEqual(["del", "add", "ctx"]);
  expect(painted(block)).toHaveLength(0);
  const [del, add, ctx] = rows(block);
  expect([del!.className, add!.className, ctx!.className]).toEqual([expect.stringContaining("bg-diff-del"), expect.stringContaining("bg-diff-add"), expect.not.stringContaining("bg-diff")]);
  expect([del!.firstElementChild!.textContent, del!.firstElementChild!.className]).toEqual(["-", "text-error"]);
  expect(add!.firstElementChild!.className).toBe("text-done");
  const drawn = layout(block);
  await waitFor(() => expect(calls).toHaveLength(1));
  // The runtime is given the diff as read, the same one drawn.
  expect(calls[0]!.diff.text).toBe(PATCH);
  await act(async () => calls[0]!.answer(COLOURS));
  // Painting adds colour to the letters only: the same rows, the same text, the same layout.
  expect(rows(block).map(row => [row.className, row.getAttribute("style"), row.textContent])).toEqual(drawn);
  const words = painted(block);
  expect([...words].map(span => span.textContent)).toEqual(["const", "1", "const", "2", "export"]);
  expect((words[0] as HTMLElement).style.getPropertyValue("--code-light")).toBe("#cf222e");
  expect((words[0] as HTMLElement).style.getPropertyValue("--code-dark")).toBe("#ff7b72");
  // The copy mark copies the patch as written, its git lines too.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(PATCH));
});

test("a diff keeps its lines whole until its wrap mark folds them, every file of it at once; a press asks nothing and draws no row again", async () => {
  const two = PATCH + "\n" + PATCH.replaceAll("a.ts", "b.ts");
  const data = screenData(tree({ tasks: [dto()] }));
  const body = (text: string) => <TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} onFollow={() => {}} /></TestWorkspace>;
  // (One diff seen after the other: vitest gives a second import of the mocked runtime in the same tick the real module.)
  const { container, rerender } = render(body(fence(two)));
  await waitFor(() => expect(calls).toHaveLength(1));
  rerender(body(fence(two) + "\n\n" + fence(PATCH)));
  const block = frame(container), other = frame(container, 1);
  await waitFor(() => expect(calls).toHaveLength(2));
  await act(async () => calls[0]!.answer([...COLOURS, ...COLOURS]));
  // Kept whole at first: the mark is not pressed, and says what a press does.
  const mark = wrapMark(block);
  expect([folded(block), mark.getAttribute("aria-pressed"), mark.getAttribute("aria-label"), mark.title]).toEqual([false, "false", "Wrap lines", "Wrap lines"]);
  expect(block.querySelectorAll("[data-diff-code]")).toHaveLength(2);
  const drawn = rows(block), shapes = layout(block);
  fireEvent.click(mark);
  // Pressed: the frame says so to every file's code; the mark is pressed and says the way back. The other diff stays as it was.
  expect([folded(block), mark.getAttribute("aria-pressed"), mark.getAttribute("aria-label"), mark.title]).toEqual([true, "true", "Show lines unwrapped", "Show lines unwrapped"]);
  expect([folded(other), wrapMark(other).getAttribute("aria-pressed")]).toEqual([false, "false"]);
  // The same rows, the same nodes, painted as they were; nothing asked of the runtime again, its answer still in use.
  expect(rows(block)).toEqual(drawn);
  expect(rows(block).every((row, i) => row === drawn[i])).toBe(true);
  expect(layout(block)).toEqual(shapes);
  expect(painted(block).length).toBeGreaterThan(0);
  expect([calls.length, calls[0]!.signal.aborted]).toEqual([2, false]);
  fireEvent.click(mark);
  expect([folded(block), mark.getAttribute("aria-pressed"), mark.getAttribute("aria-label")]).toEqual([false, "false", "Wrap lines"]);
  await act(async () => { await i18n.changeLanguage("ja"); });
  expect([mark.getAttribute("aria-label"), mark.title]).toEqual(["行を折り返す", "行を折り返す"]);
  fireEvent.click(mark);
  expect([mark.getAttribute("aria-label"), mark.title]).toEqual(["折り返さずに表示", "折り返さずに表示"]);
});

test("a diff keeps its folding while it is on the page, through a new text and into its text alone, and starts whole when drawn again", async () => {
  const data = screenData(tree({ tasks: [dto()] }));
  const body = (text: string) => <TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} onFollow={() => {}} /></TestWorkspace>;
  const view = render(body(fence(PATCH)));
  const block = frame(view.container);
  fireEvent.click(wrapMark(block));
  // A new text (a report written again): the same frame, still folded, its new rows drawn.
  view.rerender(body(fence(PATCH.replace("2;", "3;"))));
  expect([frame(view.container) === block, folded(block), rows(block)[1]!.textContent]).toEqual([true, true, "+const a = 3;\n"]);
  // A text it no longer reads as a diff: its text alone, still folded, in the same frame.
  view.rerender(body(fence("@@ -1 +1 @@\n-a\n+b")));
  expect([frame(view.container) === block, folded(block), wrapMark(block).getAttribute("aria-pressed"), block.querySelector("[data-diff-file]")]).toEqual([true, true, "true", null]);
  view.unmount();
  // Drawn again, it starts whole.
  const again = show(fence(PATCH));
  expect([folded(frame(again.container)), wrapMark(frame(again.container)).getAttribute("aria-pressed")]).toEqual([false, "false"]);
});

const git = (path: string, head: string[], body: string[]) => [`diff --git a/${path} b/${path}`, ...head, ...body];
const MANY = [
  ...git("docs/利用者向けの手順.md", ["new file mode 100644", "index 0000000..1a2b3c4", "--- /dev/null", "+++ b/docs/利用者向けの手順.md"], ["@@ -0,0 +1,2 @@", "+# 手順", "+"]),
  ...git("scripts/old.sh", ["deleted file mode 100755", "index 1a2b3c4..0000000", "--- a/scripts/old.sh", "+++ /dev/null"], ["@@ -1,2 +0,0 @@", "-#!/bin/sh", "-echo old"]),
  "diff --git a/docs/old-steps.md b/docs/steps.md", "similarity index 90%", "rename from docs/old-steps.md", "rename to docs/steps.md",
  "--- a/docs/old-steps.md", "+++ b/docs/steps.md", "@@ -1 +1 @@", "-古い題", "+新しい題",
  "diff --git a/docs/a.md b/guide/a.md", "similarity index 100%", "rename from docs/a.md", "rename to guide/a.md",
  ...git("bin/deploy", ["old mode 100644", "new mode 100755"], []),
  "diff --git a/README.md b/README-ja.md", "similarity index 100%", "copy from README.md", "copy to README-ja.md",
].join("\n");

test("each file is a band of its own: new, deleted, renamed and copied say so, a rename keeps its old name, a mode stays as written", async () => {
  const { container } = show(fence(MANY));
  const block = frame(container);
  expect(bands(block)).toEqual([
    ["New 利用者向けの手順.md", "+2", "docs/"],
    ["Deleted old.sh", "−2", "scripts/"],
    ["Renamed old-steps.md → steps.md", "+1 −1", "docs/"],
    // From another folder: the folder line reads the old path to the new one, each whole.
    ["Renamed a.md", "docs/a.md → guide/a.md"],
    ["deploy", "bin/"],
    ["Copied README.md → README-ja.md"],
  ]);
  // Only the first band holds the marks: one wrap and one copy for the whole patch.
  expect(block.querySelectorAll("button")).toHaveLength(2);
  expect(bandsOf(block)[0]!.querySelectorAll("button")).toHaveLength(2);
  // Lines the bands do not say (a mode) stay as written, quiet; no hunk's line at a file's start is drawn.
  expect(rows(block).filter(row => row.dataset.diffLine === "raw").map(row => row.textContent!.trim()))
    .toEqual(["new file mode 100644", "deleted file mode 100755", "old mode 100644", "new mode 100755"]);
  expect(kinds(block).filter(kind => kind === "hunk")).toEqual([]);
  // The last band, with nothing under it, meets the frame's foot; the first meets its top. Each file's rows are a code of its own.
  expect(block.querySelectorAll("[data-diff-code]")).toHaveLength(4);
  const all = bandsOf(block);
  expect(all[0]!.className).toContain("-mt-(--diff-top)");
  expect(all.at(-1)!.className).toContain("-mb-(--diff-foot)");
  await waitFor(() => expect(calls).toHaveLength(1));
});

test("a hunk not at its file's start reads as the line it starts at; a long Japanese path and a control character are shown whole", async () => {
  const path = "packages/workbench-shared/src/features/coordinator/conversation/timeline/会話の時系列の項目を長く説明するファイル名.test.tsx";
  const text = [
    ...git(path, ["--- a/" + path, "+++ b/" + path], ["@@ -40,2 +42,2 @@ describe(\"entry\", () => {", " it(\"a\");", "-  a;", "+  b;", "@@ -120 +122,0 @@", "-  c;"]),
    ...git("src/only-removed.ts", ["--- a/src/only-removed.ts", "+++ b/src/only-removed.ts"], ["@@ -7,1 +6,0 @@", "-gone"]),
    "diff --git \"a/src/tab\\there.ts\" \"b/src/tab\\there.ts\"", "--- \"a/src/tab\\there.ts\"", "+++ \"b/src/tab\\there.ts\"", "@@ -1 +1 @@", "-x", "+y",
  ].join("\n");
  const { container } = show(fence(text));
  const block = frame(container);
  expect(bands(block)).toEqual([
    ["会話の時系列の項目を長く説明するファイル名.test.tsx", "+1 −2", "packages/workbench-shared/src/features/coordinator/conversation/timeline/"],
    ["only-removed.ts", "−1", "src/"],
    ["tab\\there.ts", "+1 −1", "src/"],
  ]);
  // A long path folds after each / first.
  expect(block.querySelectorAll("[data-diff-file] wbr").length).toBeGreaterThan(6);
  // The first hunk does not start the file: it reads as its new line, a later one too; one that only removes, its old line.
  const places = rows(block).filter(row => row.dataset.diffLine === "hunk");
  expect(places.map(row => row.textContent)).toEqual(["⋯ Line 42\n", "⋯ Line 120\n", "⋯ Line 7\n"]);
  expect(places[0]!.className).toEqual(expect.stringContaining("text-aside"));
  await act(async () => { await i18n.changeLanguage("ja"); });
  expect(rows(frame(container)).filter(row => row.dataset.diffLine === "hunk").map(row => row.textContent)).toEqual(["⋯ 42行目\n", "⋯ 120行目\n", "⋯ 7行目\n"]);
  expect(bands(frame(container))[0]).toEqual(["会話の時系列の項目を長く説明するファイル名.test.tsx", "+1 −2", "packages/workbench-shared/src/features/coordinator/conversation/timeline/"]);
});

test("an empty added or removed row keeps its ground and its +/-, with no colour made up", async () => {
  const text = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-\n+\n ";
  const { container } = show(fence(text));
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => calls[0]!.answer([null, null, null, null, [], [], []]));
  const [del, add, ctx] = rows(frame(container));
  expect([del!.className, del!.textContent]).toEqual([expect.stringContaining("bg-diff-del"), "-\n"]);
  expect([add!.className, add!.textContent]).toEqual([expect.stringContaining("bg-diff-add"), "+\n"]);
  expect(ctx!.textContent).toBe(" ");
  expect(painted(frame(container))).toHaveLength(0);
});

test("a folded row's next lines stand in from its +/- column, past the line's own indent up to eight columns", async () => {
  const text = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -0,0 +1,3 @@", "+a", "+    deep", "+" + " ".repeat(12) + "deeper"].join("\n");
  const { container } = show(fence(text));
  expect(rows(frame(container)).map(row => row.style.textIndent)).toEqual(["-3ch", "-7ch", "-11ch"]);
  expect(rows(frame(container))[1]!.style.paddingInlineStart).toContain("7ch");
  await waitFor(() => expect(calls).toHaveLength(1));
});

test("words before a patch and a line kept as written stay rows of their own; the marks stand on a line of their own above them", async () => {
  const text = ["From 1234 Mon Sep 17 00:00:00 2001", "Subject: a change", "", ...git("a.ts", ["--- a/a.ts", "+++ b/a.ts"], ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"])].join("\n");
  const { container } = show(fence(text));
  const block = frame(container);
  // No band starts it: the marks stand on their own line, the words under it, not around it.
  expect([...block.firstElementChild!.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))).toEqual(["Wrap lines", "Copy code"]);
  expect(block.firstElementChild!.querySelector("pre")).toBeNull();
  expect(rows(block).map(row => [row.dataset.diffLine, row.textContent])).toEqual([
    ["raw", "From 1234 Mon Sep 17 00:00:00 2001\n"], ["raw", "Subject: a change\n"], ["raw", "\n"],
    ["del", "-a\n"], ["raw", "\\ No newline at end of file\n"], ["add", "+b\n"], ["raw", "\\ No newline at end of file"]]);
  // The last row reaches the frame's foot: its code reaches out, the row pads in.
  expect(rows(block).at(-1)!.className).toContain("pb-(--diff-foot)");
  expect(block.querySelectorAll("[data-diff-code]")[1]!.className).toContain("-mb-(--diff-foot)");
  expect(bands(block)).toEqual([["a.ts", "+1 −1"]]);
  await waitFor(() => expect(calls).toHaveLength(1));
});

test("a diff it does not read (beyond its bounds, no +/- line, binary, broken) is its text alone, with the diff's marks, and asks for nothing", async () => {
  const added = (count: number) => "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1," + (count - 4) + " @@\n" + Array(count - 4).fill("+line").join("\n");
  const unread = [added(DIFF_LIMITS.lines + 1), "only words\n and a kept line",
    "diff --git a/a.png b/a.png\nindex 1a2b3c4..5d6e7f8 100644\nBinary files a/a.png and b/a.png differ",
    PATCH.replace("@@ -1,2 +1,2 @@", "@@ -1,3 +1,3 @@")];
  const { container } = show([added(DIFF_LIMITS.lines), ...unread].map(fence).join("\n\n"));
  // At the bound, a band and a row a line; the others, their text alone.
  expect(rows(frame(container, 0))).toHaveLength(DIFF_LIMITS.lines - 4);
  for (const [i, text] of unread.entries()) {
    const block = frame(container, i + 1), pre = block.querySelector("pre")!;
    // Its marks on a line of their own, then its code: one text, no row.
    expect([block.children.length, pre.children.length, pre.textContent]).toEqual([2, 0, text]);
    expect(block.firstElementChild!.querySelectorAll("button")).toHaveLength(2);
    expect(pre.closest("[data-diff-code]")).toBeTruthy();
    expect(block.querySelector("[data-diff-file]")).toBeNull();
  }
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.diff.text).toBe(added(DIFF_LIMITS.lines));
  // Its copy mark copies the text as written.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[1]!);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(unread[0]));
  // Its wrap mark folds its text alone, the same text node.
  const block = frame(container, 1), text = block.querySelector("pre")!.firstChild;
  fireEvent.click(wrapMark(block));
  expect([folded(block), folded(frame(container, 0)), block.querySelector("pre")!.firstChild === text]).toEqual([true, false, true]);
  expect(calls).toHaveLength(1);
});

const LINES = ["-Design for maintainability around stable data structures.", "- 症状の捉え方を変える。", "", "+Design around stable data structures.", "plain words", " a kept line"].join("\n");
test("a diff that names no file is its rows, each added or removed one on its ground, without a band or a word, and asks for nothing", async () => {
  // Beside it a whole patch, so the runtime asked for one and not the other is seen, and a plain fence and an unclosed one.
  const { container } = show([fence(LINES), fence(PATCH), "```\n" + LINES + "\n```", "```diff\n" + LINES].join("\n\n"));
  const block = frame(container);
  // The place's code look reaches its rows' code, as it does a whole patch's.
  const place = render(<DiffBlock text={LINES} codeClassName="place-code" />);
  expect(place.container.querySelector("pre")!.className).toContain("place-code");
  place.unmount();
  expect(rows(block).map(row => [row.dataset.diffLine, row.textContent])).toEqual([
    ["del", LINES.split("\n")[0] + "\n"], ["del", "- 症状の捉え方を変える。\n"], ["ctx", "\n"], ["add", "+Design around stable data structures.\n"], ["ctx", "plain words\n"], ["ctx", " a kept line"]]);
  expect(rows(block).filter(row => row.className.includes("bg-diff-del")).length).toBe(2);
  expect(rows(block).filter(row => row.className.includes("bg-diff-add")).length).toBe(1);
  expect(rows(block).filter(row => row.dataset.diffLine === "ctx").every(row => !/bg-diff|text-aside/.test(row.className))).toBe(true);
  // Its +/- in its row's hue, its first letter alone.
  expect(rows(block)[0]!.firstElementChild!.textContent).toBe("-");
  expect(rows(block)[0]!.firstElementChild!.className).toBe("text-error");
  expect(rows(block)[3]!.firstElementChild!.className).toBe("text-done");
  // No file's band: its marks stand on a line of their own, its last row reaches the frame's foot.
  expect(block.querySelector("[data-diff-file]")).toBeNull();
  expect(block.firstElementChild!.querySelectorAll("button")).toHaveLength(2);
  expect(rows(block).at(-1)!.className).toContain("pb-(--diff-foot)");
  // A fence not named a diff, and one still being written, stay their text alone.
  for (const at of [2, 3]) expect([rows(frame(container, at)).length, frame(container, at).querySelector("pre")!.textContent]).toEqual([0, LINES]);
  // Copied as written; folded, the rows are the same rows; the runtime is asked for the whole patch alone.
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  fireEvent.click(block.querySelector("button[data-copy]")!);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINES));
  const drawn = rows(block);
  fireEvent.click(wrapMark(block));
  expect([folded(block), rows(block).every((row, i) => row === drawn[i])]).toEqual([true, true]);
  await waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]!.diff.text).toBe(PATCH);
});

test("a diff it cannot paint stays as drawn, without a word; a fault is recorded once", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const { container } = show("```patch\n" + PATCH + "\n```");
  await waitFor(() => expect(calls).toHaveLength(1));
  const before = container.innerHTML;
  await act(async () => calls[0]!.answer(null));
  expect(container.innerHTML).toBe(before);
  cleanup();
  const failed = show(fence(PATCH));
  await waitFor(() => expect(calls).toHaveLength(2));
  const drawn = failed.container.innerHTML;
  await act(async () => calls[1]!.fail(new Error("chunk failed")));
  expect(failed.container.innerHTML).toBe(drawn);
  expect(error).toHaveBeenCalledTimes(1);
});

test("colours that come after the diff left or changed are not applied", async () => {
  const data = screenData(tree({ tasks: [dto()] }));
  const body = (text: string) => <TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={text} onFollow={() => {}} /></TestWorkspace>;
  const view = render(body(fence(PATCH)));
  await waitFor(() => expect(calls).toHaveLength(1));
  const next = PATCH.replace("2;", "3;");
  view.rerender(body(fence(next)));
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(calls[0]!.signal.aborted).toBe(true);
  expect(calls[1]!.signal.aborted).toBe(false);
  // The old text's colours arrive late: nothing is painted on the new text.
  await act(async () => calls[0]!.answer(COLOURS));
  expect(painted(frame(view.container))).toHaveLength(0);
  expect(rows(frame(view.container))[1]!.textContent).toBe("+const a = 3;\n");
  view.unmount();
  expect(calls[1]!.signal.aborted).toBe(true);
  await act(async () => calls[1]!.answer(COLOURS));
});

test("a diff drawn but not yet on the screen asks for nothing until it is seen", async () => {
  held = true;
  const { container } = show(fence(PATCH));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toHaveLength(0);
  expect(bands(frame(container))).toEqual([["a.ts", "+1 −1", "src/"]]);
  await act(async () => see());
  await waitFor(() => expect(calls).toHaveLength(1));
  // Seen once is enough: it is not asked again.
  await act(async () => see());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toHaveLength(1);
});

test("only a closed diff or patch fence is a diff; other code, an open fence and Mermaid stay as they were, the code's frame unchanged", async () => {
  const { container } = show("```ts\nconst a = 1;\n```\n\n```\n" + PATCH + "\n```\n\n```diff\n-still being written");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toHaveLength(0);
  expect(container.querySelectorAll("[data-code-block]")).toHaveLength(3);
  // Other code is its frame, its copy mark and its text alone, as before: no wrap mark, no code of a diff's.
  for (const block of container.querySelectorAll<HTMLElement>("[data-code-block]")) {
    expect([...block.children].map(child => child.tagName)).toEqual(["BUTTON", "PRE"]);
    expect(block.querySelector("pre")!.children).toHaveLength(0);
    expect(block.className).toContain("flow-root");
    expect([block.querySelector("[aria-pressed], [data-diff-code]"), block.hasAttribute("data-diff-wrap")]).toEqual([null, false]);
  }
  expect(frame(container).querySelector("pre")!.textContent).toBe("const a = 1;");
});

