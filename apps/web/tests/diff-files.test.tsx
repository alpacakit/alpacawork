import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { formatReportDiff, reportDiffHead, type ReportDiff } from "@alpacawork/contract/report-diff";
import type { TaskDetail } from "../src/data/types";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { codeRows, groupFiles, proseChanges, proseRows, readFilePatch, readDiff, sideBySide, summarizeFiles } from "../src/features/reader/diff/diff-files";
import { describeDiff } from "../src/features/reader/diff/diff-source";
import type { StructuredDiffDocument } from "../src/features/reader/diff/diff-types";
import { excerpt, wordChanges } from "../src/features/reader/diff/word-changes";
import { belowSurface, surfacesOf } from "../src/state/history-step";
import { viewerTarget } from "../src/domain/viewer-target";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";


beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); useViewStore.setState({ view: null }); });

// Fictional seed text keeps Japanese word-diff boundaries and long-paragraph elision.
const BEFORE = "図鑑の見本は架空の植物を描いた。" + "葉の色は青と緑を交互に並べ、花の形は丸と星で区別する。見本番号を説明の先頭に添え、初めて読む人が図と本文を読み比べられるようにする。図の並びは catalog.md に載せる。";
const ADDED = "最初のページは、架空の見本を guide.md の順番に読み比べる。";
const AFTER = BEFORE.slice(0, 14) + ADDED + BEFORE.slice(14);

test("a sentence added to a long Japanese paragraph is the only colour, the rest of the paragraph cut to … around it", () => {
  const pieces = excerpt(wordChanges(BEFORE, AFTER), 20);
  expect(pieces.filter(piece => piece.kind === "add" || piece.kind === "del")).toEqual([{ kind: "add", text: ADDED }]);
  // Before it, the paragraph's start is short enough to stay; after it, only 20 letters and then …
  expect(pieces.at(-1)).toEqual({ kind: "gap" });
  expect(pieces.map(piece => piece.kind === "gap" ? "…" : piece.text).join("")).toBe(AFTER.slice(0, 14 + ADDED.length + 20) + "…");
  // A changed word in the middle is the removed word and the added word, the shared words around them untouched.
  expect(wordChanges("方針は AGENTS.md より優先する。", "方針は CLAUDE.md より優先する。").filter(piece => piece.kind !== "same"))
    .toEqual([{ kind: "del", text: "AGENTS" }, { kind: "add", text: "CLAUDE" }]);
});

test("lines that only stand where others were removed are not coloured as one changed paragraph", () => {
  // A heading and a sentence removed, an unrelated paragraph and a new heading added.
  const rows = [{ kind: "del", text: "## 図鑑" }, { kind: "del", text: "載せる植物は、架空の見本の一覧で種類ごとに指定する。" },
    { kind: "add", text: "読み始めは、図の番号の確認から葉の色を比べるところまでを guide.md に従って進める。" },
    { kind: "add", text: "載せる植物は、架空の見本の一覧で種類ごとに指定し、無ければ番号を使う。" },
    { kind: "add", text: "## 種類ごとに植物を指定する" }] as const;
  const changes = proseChanges(rows).map(change => change.pieces.filter(piece => piece.kind !== "same" && piece.kind !== "gap").map(piece => piece.kind));
  // The heading is removed alone; the new paragraph is added alone; the sentence that changed is the one coloured by its words.
  expect(changes).toEqual([["del"], ["add"], ["del", "add"], ["add"]]);
  expect(proseChanges(rows)[0]!.pieces).toEqual([{ kind: "del", text: "## 図鑑" }]);
});

test("a paragraph too large to compare by words is one change, quickly", () => {
  const a = Array.from({ length: 4000 }, (_, i) => `語${i}、`).join(""), b = Array.from({ length: 4000 }, (_, i) => `字${i}。`).join("");
  const started = performance.now();
  const pieces = wordChanges(a, b);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(pieces.map(piece => piece.kind)).toEqual(["del", "add"]);
  expect(pieces.map(piece => piece.text)).toEqual([a, b]);
});

const patchOf = (path: string, rows: string[], head = "") => `diff --git a/${path} b/${path}\n${head}--- ${head ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n` +
  `@@ -${head ? "0,0" : `1,${rows.filter(row => !row.startsWith("+")).length}`} +1,${rows.filter(row => !row.startsWith("-")).length} @@\n${rows.join("\n")}\n`;
const REPORT: ReportDiff = {
  source: { command: "git -C /r diff 333333333..sample/catalog-guide", repo: "/r", base: { sha: "a".repeat(40), written: "333333333" },
    head: { sha: "b".repeat(40), written: "sample/catalog-guide" }, paths: [] },
  commits: null,
  files: [
    { path: "catalog/plants/catalog.md", oldPath: null, change: "modified", added: 1, deleted: 1, kept: true },
    { path: "catalog/plants/guide.md", oldPath: null, change: "added", added: 2, deleted: 0, kept: true },
    { path: "catalog/plants/big data.md", oldPath: null, change: "added", added: 9000, deleted: 0, kept: false },
  ],
  patch: patchOf("catalog/plants/catalog.md", ["-" + BEFORE, "+" + AFTER]) +
    patchOf("catalog/plants/guide.md", ["+# Setup", "+Read the fictional sample first."], "new file mode 100644\n"),
};
const PLAIN = patchOf("src/a.ts", ["-const a = 1;", "+const a = 2;"]);

const rowsOf = (file: { patch: string | null; binary: boolean }) => {
  if (!file.patch || file.binary) return null;
  const doc = readFilePatch(file.patch);
  return doc.kind === "structured" ? proseRows(doc) : null;
};
const unreadFile = (file: { patch: string | null; binary: boolean }) => !!file.patch && !file.binary && readFilePatch(file.patch).kind !== "structured";

test("a report diff lists every file with what its header says was done to it, also one whose lines it did not keep; a binary file in a plain patch keeps the others' rows", () => {
  const diff = readDiff(formatReportDiff(REPORT));
  if (diff.kind !== "files") throw new Error("not listed");
  expect(diff.files.map(file => [file.path, file.change, file.kept, rowsOf(file) !== null])).toEqual([
    ["catalog/plants/catalog.md", "change", true, true], ["catalog/plants/guide.md", "new", true, true], ["catalog/plants/big data.md", "new", false, false]]);
  // The file without lines says how to see them: the header's repo, both versions and the file, as a shell reads it.
  expect(diff.files[2]!.command).toBe(`git -C /r diff ${"a".repeat(12)}..${"b".repeat(12)} -- 'catalog/plants/big data.md'`);
  expect(proseChanges(rowsOf(diff.files[0]!)!).flatMap(change => change.pieces.filter(piece => piece.kind === "add"))).toEqual([{ kind: "add", text: ADDED }]);
  const binary = "diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n";
  const plain = readDiff(binary + PLAIN);
  if (plain.kind !== "files") throw new Error("not listed");
  expect(plain.files.map(file => [file.path, rowsOf(file)?.length ?? null])).toEqual([["logo.png", null], ["src/a.ts", 3]]);
  // Words that are no patch stay as written.
  expect(readDiff("no patch here")).toEqual({ kind: "raw", text: "no patch here", tooLarge: false });
});

function show(text: string, names: string[], served: Record<string, string>, report = true, roots: string[] = []) {
  const data = screenData(tree({ tasks: [dto()] }));
  const task = { ...data.tasks[0]!, body: "", logs: [], requestHeads: [], extractRows: {}, reply: undefined,
    files: names.map(name => ({ name, size: (served[name] ?? "").length, revision: "r", at: "2001-02-04T00:00:00.000Z" })) } as TaskDetail;
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input), "http://localhost"), name = url.searchParams.get("path")!;
    if (!url.pathname.endsWith("/file")) return new Response(JSON.stringify({ roots }));
    const head = url.searchParams.get("part") === "head";
    asked.push(`${name}${head ? "#head" : ""}`);
    if (!(name in served)) return new Response("", { status: 404 });
    return new Response(head ? reportDiffHead(served[name]!) : served[name]);
  });
  return { ...render(<TestWorkspace data={data}><MarkdownBody task={task} text={text} report={report} onFollow={() => {}} /></TestWorkspace>), asked, task };
}

test("a report's diffs are a summary in place of their command block, reading no row; opening one names it in the URL's surfaces", async () => {
  const text = "Made guide.md.\n\n```sh\ngit -C /r diff 333333333...sample/catalog-guide\ngit -C /r diff main..sample/other\n```\n\n![diff](diffs/one.diff)\n![diff](diffs/two.diff)\n\nAfter.";
  const one = formatReportDiff({ ...REPORT, source: { ...REPORT.source, command: "git -C /r diff 333333333...sample/catalog-guide" },
    commits: { title: "T9001: catalog guide in its own file (T9001)", total: 3, list: [] } });
  const view = show(text, ["diffs/one.diff", "diffs/two.diff"], { "diffs/one.diff": one, "diffs/two.diff": PLAIN });
  await waitFor(() => expect(view.container.querySelectorAll("[data-diff-open]")).toHaveLength(2));
  const card = view.container.querySelector<HTMLElement>("[data-diff-summary]")!;
  // Each diff under its own heading, named by its commits' title without its task IDs, never by its versions; the
  // command no diff names stays to copy. The block it stands for is not drawn again.
  expect([...card.querySelectorAll("[data-diff-range]")].map(code => code.textContent)).toEqual(["git -C /r diff main..sample/other"]);
  expect([...card.querySelectorAll("[data-diff-title]")].map(title => title.textContent)).toEqual(["catalog guide in its own file"]);
  expect(card.querySelector("[data-diff-commit-count]")?.textContent).toBe("3 commits");
  expect(card.textContent).not.toMatch(/333333333|sample\/catalog-guide|aaaaaaaa/);
  expect(view.container.querySelectorAll("[data-code-block]")).toHaveLength(0);
  expect(screen.getByText("After.")).toBeTruthy();
  expect(view.asked.sort()).toEqual(["diffs/one.diff#head", "diffs/two.diff#head"]);
  fireEvent.click(view.container.querySelectorAll<HTMLElement>("[data-diff-open]")[1]!);
  expect(useViewStore.getState().view).toBe(`${view.task.id}/diffs/two.diff`);
  expect(view.asked).toHaveLength(2);
});

test("a path in the task's code places opens in the viewer; any other is its path to copy, as before", async () => {
  const view = show("Read /home/me/repo/src/a.ts and /home/me/other/b.ts.", [], {}, true, ["/home/me/repo"]);
  const inside = await waitFor(() => { const button = view.container.querySelector<HTMLElement>('[data-code-path="/home/me/repo/src/a.ts"]'); expect(button).toBeTruthy(); return button!; });
  expect(view.container.querySelector('[data-code-path="/home/me/other/b.ts"]')).toBeNull();
  // A path folds only after a "/": its file's name stays whole, kept with its copy mark.
  expect([inside.textContent, inside.parentElement!.classList.contains("whitespace-nowrap"), inside.closest("code")!.querySelectorAll("wbr").length]).toEqual(["a.ts", true, 5]);
  expect(within(view.container).getAllByRole("button", { name: /Copy path/ })).toHaveLength(2);
  fireEvent.click(inside);
  expect(useViewStore.getState().view).toBe(`${view.task.id}//home/me/repo/src/a.ts`);
});

test("a diff that changes no file says so and has nothing to open", async () => {
  const none = formatReportDiff({ ...REPORT, files: [], patch: "" });
  const view = show("![diff](diffs/none.diff)", ["diffs/none.diff"], { "diffs/none.diff": none });
  await waitFor(() => expect(view.container.querySelector("[data-diff-unchanged]")).toBeTruthy());
  expect(view.container.querySelector("[data-diff-open]")).toBeNull();
  expect(view.container.querySelector("[data-diff-counts]")).toBeNull();
});

test("a diff file the Task does not hold says so where the summary would be, in a body as in a report", async () => {
  for (const report of [true, false]) {
    const view = show("![diff](diffs/gone.diff)", [], {}, report);
    expect(await within(view.container).findByText(/The diff file is missing: gone\.diff/)).toBeTruthy();
    expect(within(view.container).getByRole("link", { name: "Open the file list" })).toBeTruthy();
    cleanup();
  }
});

test("the viewer is a surface over the reader; what it reads is a Task's file or one of its code locations, a diff read as one", () => {
  expect(surfacesOf("?task=T1&view=T1%2Fdiffs%2Fa.diff")).toEqual(["T1", "view:T1/diffs/a.diff"]);
  const shown = { project: null, task: "T1", taskAddress: null, full: false, pane: "task" as const, path: null, query: "", image: null,
    view: "T1/diffs/a.diff", event: null };
  expect([1, 0].map(depth => { const below = belowSurface(shown, depth); return [below.task, below.view]; })).toEqual([["T1", null], [null, null]]);
  expect(["T1/diffs/a.diff", "T1/notes.md", "T1//home/me/repo/src/a.patch", "T1/../x", "nothing"].map(viewerTarget)).toEqual([
    { owner: "T1", path: "diffs/a.diff", where: "task", reads: "diff" }, { owner: "T1", path: "notes.md", where: "task", reads: "file" },
    { owner: "T1", path: "/home/me/repo/src/a.patch", where: "code", reads: "diff" }, null, null]);
});

// A patch a member put in the Task folder by hand: git format-patch's mail head, its diffstat and signature around git's diff.
const FORMAT_PATCH = "From 3f2a9c1b7d4e0000000000000000000000000000 Mon Sep 17 00:00:00 2001\nFrom: Member <member@example.invalid>\n" +
  "Date: Sun, 8 Nov 2026 00:00:00 +0900\nSubject: [PATCH] docs: add the setup step\n\n---\n docs/guide.md | 2 +-\n src/a.ts      | 2 +-\n" +
  " 2 files changed, 2 insertions(+), 2 deletions(-)\n\n" +
  patchOf("docs/guide.md", ["-" + BEFORE, "+" + AFTER]) + PLAIN + "-- \n2.43.0\n";

test("a patch put in the Task folder by hand lists its files as the patch says, git format-patch's alike", () => {
  for (const [text, files] of [[PLAIN, ["src/a.ts"]], [FORMAT_PATCH, ["docs/guide.md", "src/a.ts"]]] as const) {
    const diff = readDiff(text);
    if (diff.kind !== "files") throw new Error("not listed");
    expect(diff.files.map(file => [file.path, file.added, file.deleted])).toEqual(files.map(path => [path, 1, 1]));
    // The document's added sentence alone is coloured, though the mail head and signature stand around the diff.
    if (text === FORMAT_PATCH) expect(proseChanges(rowsOf(diff.files[0]!)!).flatMap(change => change.pieces.filter(piece => piece.kind === "add"))).toEqual([{ kind: "add", text: ADDED }]);
  }
});

test("a summary counts files and lines", () => {
  expect(summarizeFiles([{ added: 2, deleted: 1 }, { added: null, deleted: null }, { added: 3, deleted: 0 }])).toEqual({ files: 3, added: 5, deleted: 1 });
});

test("the list is by folder, in name order; a name in two folders stands under each; a filter keeps matching paths", () => {
  const files = ["src/b/index.ts", "tests/b.test.ts", "README.md", "src/a/index.ts", "docs/guide.md", "src/a/util.test.ts"].map(path => ({ path }));
  const list = (query?: string) => groupFiles(files, query).map(group => [group.folder, group.files.map(file => file.path)]);
  expect(list()).toEqual([["", ["README.md"]], ["docs/", ["docs/guide.md"]], ["src/a/", ["src/a/index.ts", "src/a/util.test.ts"]],
    ["src/b/", ["src/b/index.ts"]], ["tests/", ["tests/b.test.ts"]]]);
  expect(list("INDEX")).toEqual([["src/a/", ["src/a/index.ts"]], ["src/b/", ["src/b/index.ts"]]]);
  expect(list("nothing")).toEqual([]);
});

test("code rows carry their line numbers, each hunk the function git names after @@, and a changed line only its changed words", () => {
  const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,3 +10,3 @@ export function resolve(settings) {\n" +
    "   const rules = settings.rules;\n-  return extract({ rules }, settings.body);\n+  return extract({ rules }, project.body);\n-  unrelated();\n+  // a comment\n";
  const doc = describeDiff(patch) as StructuredDiffDocument;
  const rows = codeRows(doc);
  const line = (at: number) => { const { start, contentEnd } = doc.lines[at]!; return doc.text.slice(start, contentEnd); };
  expect(rows.map(row => row.kind === "hunk" ? ["hunk", row.next, row.context] : [row.kind, row.old, row.next])).toEqual([
    ["hunk", 10, "export function resolve(settings) {"], ["ctx", 10, 10], ["del", 11, null], ["add", null, 11], ["del", 12, null], ["add", null, 12]]);
  const words = rows.map(row => row.kind === "del" || row.kind === "add"
    ? row.words?.map(([start, end]) => line(row.line).slice(start, end)) ?? null : undefined);
  // The changed line marks its changed word; a line that shares nothing with the one in its place is changed whole, unmarked.
  expect(words).toEqual([undefined, undefined, ["settings"], ["project"], null, null]);
});

test("a removed line and its new one stay a pair across git's no-newline mark between them", () => {
  const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-const a = 1;\n\\ No newline at end of file\n+const a = 2;\n";
  const doc = describeDiff(patch) as StructuredDiffDocument;
  const line = (at: number) => { const { start, contentEnd } = doc.lines[at]!; return doc.text.slice(start, contentEnd); };
  expect(codeRows(doc).flatMap(row => row.kind === "add" || row.kind === "del" ? [row.words?.map(([from, to]) => line(row.line).slice(from, to))] : []))
    .toEqual([["1"], ["2"]]);
});

test("a file git names in quotes and escapes (a Japanese name) stays in the list, read as git wrote it; one it cannot read stays as written", () => {
  const quoted = '"a/\\347\\224\\273\\345\\203\\217.png" "b/\\347\\224\\273\\345\\203\\217.png"';
  const binary = `diff --git ${quoted}\nindex 1111111..2222222 100644\nBinary files ${quoted.replace('" "', '" and "')} differ\n`;
  const broken = 'diff --git "a/odd name\nindex 1111111..2222222 100644\nBinary files differ\n';
  const diff = readDiff(patchOf("docs/note.md", ["-a", "+b"]) + binary + broken);
  if (diff.kind !== "files") throw new Error("not listed");
  expect(diff.files.map(file => [file.path, file.binary])).toEqual([["docs/note.md", false], ["画像.png", true], ['"a/odd name', true]]);
});

test("a patch with its own mail signature counts only its lines; a part still unread is kept as written, not as no change", () => {
  const signed = FORMAT_PATCH.replace(/-- \n2\.43\.0\n$/, "-- \nReviewed fixture\nby the team\n");
  const diff = readDiff(signed);
  if (diff.kind !== "files") throw new Error("not listed");
  expect(diff.files.map(file => [file.path, file.added, file.deleted, unreadFile(file)])).toEqual([["docs/guide.md", 1, 1, false], ["src/a.ts", 1, 1, false]]);
  // A hunk whose counts do not hold is not read: no count, its part kept to be shown as written.
  const unread = readDiff(patchOf("src/b.ts", ["-const b = 1;", "+const b = 2;"]).replace("@@ -1,1 +1,1 @@", "@@ -1,5 +1,5 @@"));
  if (unread.kind !== "files") throw new Error("not listed");
  expect(unread.files.map(file => [file.path, unreadFile(file), file.added, file.patch?.includes("+const b = 2;")])).toEqual([["src/b.ts", true, null, true]]);
});

test("side by side, a changed line stands beside the line in its place, and lines only removed beside lines only added", () => {
  const row = (kind: string, text = "") => ({ kind, text });
  const rows = [row("hunk"), row("ctx", "a"), row("del", "const total = 1;"), row("del", "removed()"), row("add", "const total = 2;"),
    row("add", "added()"), row("add", "more()"), row("ctx", "b")];
  expect(sideBySide(rows)).toEqual([
    { kind: "band", row: 0 },
    { kind: "pair", left: 1, right: 1 },
    { kind: "pair", left: 2, right: 4 },
    { kind: "pair", left: 3, right: 5 },
    { kind: "pair", left: null, right: 6 },
    { kind: "pair", left: 7, right: 7 },
  ]);
});
