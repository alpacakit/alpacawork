// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachResolvedLanguages, attachResolvedThemes, DiffHunksRenderer, disposeHighlighter, getSharedHighlighter, parsePatchFiles } from "@pierre/diffs";
import { normalizeTheme } from "shiki/core";
import { coloursFromAST, planDiff } from "../src/features/reader/diff/diff-policy";
import { acceptsDiffInput, DIFF_LIMITS } from "@alpacawork/contract/report-diff";
import { codeLanguage } from "../src/features/reader/diff/diff-languages";
import { describeDiff } from "../src/features/reader/diff/diff-source";
import type { CodeFile, StructuredDiffDocument, DiffColours, DiffWorkerRequest, DiffWorkerResponse } from "../src/features/reader/diff/diff-types";

// Like the existing Node HTTP tests, provide the blank page read by the formal shared store setup.
const page = globalThis as { location?: { href: string }; matchMedia?: (query: string) => unknown;
  document?: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> };
page.location ??= { href: "http://localhost/" };
// Reset modules under the worker window stub still reaches the shared storage visibility listener.
page.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" as const });
page.matchMedia ??= (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} });

const header = (name = "sample.ts", mode: "change" | "new" | "deleted" = "change") =>
  `diff --git a/${name} b/${name}\n${mode === "new" ? "new file mode 100644\n" : mode === "deleted" ? "deleted file mode 100644\n" : ""}--- ${mode === "new" ? "/dev/null" : `a/${name}`}\n+++ ${mode === "deleted" ? "/dev/null" : `b/${name}`}\n`;
const hunk = (old: string[], next: string[], oldStart = 1, nextStart = 1) =>
  `@@ -${oldStart},${old.length} +${nextStart},${next.length} @@\n${old.map(line => `-${line}\n`).join("")}${next.map(line => `+${line}\n`).join("")}`;
const document = (text: string): StructuredDiffDocument => {
  const result = describeDiff(text);
  if (result.kind !== "structured") throw new Error(`Expected structured diff: ${result.kind}`);
  return result;
};
const parse = (text: string) => {
  const source = describeDiff(text);
  return source.kind === "structured" ? planDiff(source, parsePatchFiles(text, undefined, true).flatMap(patch => patch.files)) : [];
};
const simple = header() + hunk(["const before=1;"], ["const after=1;"]);
const emptyPatch = (kind: "add" | "del" | "ctx") => kind === "ctx"
  ? header("empty.tsx") + "@@ -1,3 +1,3 @@\n-const before = <p>日本語😀</p>;\n-\n+const after = <p>日本語😀</p>;\n+\n \n"
  : header("empty.tsx", kind === "add" ? "new" : "deleted") + (kind === "add"
    ? hunk([], ["const after = <p>日本語😀</p>;", ""], 0, 1)
    : hunk(["const before = <p>日本語😀</p>;", ""], [], 1, 0));
const renamedHeader = (operation: "rename" | "copy") => [
  'diff --git "a/old name.tsx" "b/new name.tsx"', "old mode 100644", "new mode 100755",
  "similarity index 80%", `${operation} from old name.tsx`, `${operation} to new name.tsx`,
  "index abc1234..def5678 100755", '--- "a/old name.tsx"', '+++ "b/new name.tsx"', "",
].join("\n");

describe("diff source and plan ownership", () => {
  it("plans every hunk, after a gap too, with isPartial and packed indices unchanged", () => {
    const text = header() + hunk(["/*", "old"], ["/*", "new"]) + hunk(["gap text"], ["gap text"], 4, 4);
    const plan = parse(text)[0]!;
    expect(plan.file.isPartial).toBe(true);
    expect(plan.file.hunks).toHaveLength(2);
    expect(plan.file.deletionLines).toEqual(["/*\n", "old\n", "gap text\n"]);
    expect(plan.file.additionLines).toEqual(["/*\n", "new\n", "gap text\n"]);
    expect(plan.source.rows.get("new:4")?.content).toBe("gap text");
  });
  it("retains every actual source index of unequal-sided hunks", () => {
    const text = header() + hunk(["/*", "old"], ["/*", "new", "inserted"]) + hunk(["*/"], ["*/"], 3, 4);
    const plan = parse(text)[0]!;
    expect(plan.file.hunks[1]).toMatchObject({ deletionStart: 3, deletionCount: 1, additionStart: 4, additionCount: 1 });
    expect(plan.source.rows.get("new:4")?.content).toBe("*/");
  });
  it.each(["new", "deleted"] as const)("accepts zero-count side of a %s file", mode => {
    const text = header("zero.ts", mode) + (mode === "new" ? hunk([], ["const x=1;"], 0, 1) : hunk(["const x=1;"], [], 1, 0));
    expect(parse(text)).toHaveLength(1);
  });
  it("plans a hunk from a file's middle at its own line numbers", () => {
    expect(parse(header() + hunk([], ["new"], 1, 2))[0]!.source.rows.get("new:2")?.content).toBe("new");
    expect(parse(header() + hunk(["old"], ["new"], 2, 2))[0]!.source.rows.get("old:2")?.content).toBe("old");
  });
  it("rejects unknown, prototype-like extensions, mismatched rename and malformed counts", () => {
    expect(codeLanguage("file.constructor")).toBeNull();
    expect(parse(simple.replaceAll("sample.ts", "unknown.zzz"))).toEqual([]);
    expect(parse(simple.replace("--- a/sample.ts", "--- a/sample.md").replace("diff --git a/sample.ts b/sample.ts", "diff --git a/sample.md b/sample.ts").replace("--- a/sample.md", "similarity index 50%\n--- a/sample.md"))).toEqual([]);
    expect(parse(simple.replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,1 @@"))).toEqual([]);
    expect(parse(simple.replace("--- a/sample.ts", "--- a/sample.md"))).toEqual([]);
  });
  it("accepts a strictly counted EOS payload without inventing a source EOF or a final newline", () => {
    const text = simple.slice(0, -1);
    const original = parsePatchFiles(text, undefined, true)[0]!.files[0]!;
    const plan = parse(text)[0]!;
    expect(plan.file.isPartial).toBe(true);
    expect(plan.file.additionLines).toEqual(original.additionLines);
    expect(plan.file.deletionLines).toEqual(original.deletionLines);
    expect(plan.file.additionLines.at(-1)!.endsWith("\n")).toBe(false);
    expect(plan.file.hunks[0]).toMatchObject({ noEOFCRAdditions: false, noEOFCRDeletions: false });
    expect(parse(text.replaceAll("\n", "\r\n"))).toHaveLength(1);
    expect(parse(text.replace("@@ -1,1 +1,1 @@", "@@ -1,2 +1,2 @@"))).toEqual([]);
  });
  it("handles unified patches, multi-file input and repeated identical lines without guessing by content", () => {
    expect(parse(simple.replace(/^diff --git[^\n]*\n/, ""))).toHaveLength(1);
    const text = header("one.ts") + hunk(["same", "same"], ["same", "same"]) + header("two.md") + hunk(["**old**"], ["**new**"]);
    const plans = parse(text);
    expect(plans).toHaveLength(2);
    expect(plans[0]!.source.rows.get("new:1")?.index).not.toBe(plans[0]!.source.rows.get("new:2")?.index);
    expect(plans[1]!.language.id).toBe("markdown");
  });
  it("refuses overlap and verifies AST row identity, exact text, UTF16 offsets and CRLF", () => {
    expect(parse(header() + hunk(["x"], ["x"]) + hunk(["x"], ["x"], 1, 1))).toEqual([]);
    const text = header() + hunk(["old"], ["日本語😀"]);
    const plan = parse(text.replaceAll("\n", "\r\n"))[0]!;
    const target: DiffColours = Array.from({ length: text.split("\n").length }, () => null);
    const ast = { type: "element", tagName: "div", properties: { "data-line": 1, "data-line-type": "change-addition" }, children: [{ type: "element", tagName: "span", properties: { style: "--diffs-token-light:#123456;--diffs-token-dark:#abcdef" }, children: [{ type: "text", value: "日本語😀" }] }] };
    const result = { unifiedContentAST: [ast] } as unknown as Parameters<typeof coloursFromAST>[1];
    coloursFromAST(plan, result, target);
    expect(target[5]).toEqual([[1, 6, "#123456", "#abcdef"]]);
    ast.children[0]!.children[0]!.value = "different";
    expect(() => coloursFromAST(plan, result, target)).toThrow("original source line");
  });
  it("applies bounded input and side totals before grammar work", () => {
    expect(acceptsDiffInput("\n".repeat(DIFF_LIMITS.lines - 1))).toBe(true);
    expect(acceptsDiffInput("x".repeat(DIFF_LIMITS.inputBytes + 1))).toBe(false);
    expect(acceptsDiffInput("\n".repeat(DIFF_LIMITS.lines))).toBe(false);
    expect(acceptsDiffInput("short\n".repeat(100_000))).toBe(false);
    expect(acceptsDiffInput("x".repeat(DIFF_LIMITS.lineUnits) + "\r\n")).toBe(true);
    expect(acceptsDiffInput("x".repeat(DIFF_LIMITS.lineUnits + 2))).toBe(false);
    const chunk = "日".repeat(6_000) + "\n";
    const chunkBytes = new TextEncoder().encode(chunk).length;
    const exactBytes = chunk.repeat(Math.floor(DIFF_LIMITS.inputBytes / chunkBytes)) + "x".repeat(DIFF_LIMITS.inputBytes % chunkBytes);
    expect(new TextEncoder().encode(exactBytes).length).toBe(DIFF_LIMITS.inputBytes);
    expect(acceptsDiffInput(exactBytes)).toBe(true);
    expect(acceptsDiffInput(exactBytes + "x")).toBe(false);
    const lines = Array.from({ length: 12 }, () => "x".repeat(10_000));
    expect(parse(header() + hunk(lines, lines))).toEqual([]);
  });
  it("normalizes only the verified empty AST placeholder, without inventing spans or weakening identity checks", () => {
    const text = header() + hunk([""], [""]);
    const plan = parse(text)[0]!;
    const target: DiffColours = text.split("\n").map(() => null);
    const ast = { type: "element", tagName: "div", properties: {
      "data-line": 1, "data-line-type": "change-addition", style: "--diffs-token-light:#123456;--diffs-token-dark:#abcdef",
    }, children: [{ type: "text", value: "\n" }] };
    const result = { unifiedContentAST: [ast] } as unknown as Parameters<typeof coloursFromAST>[1];
    coloursFromAST(plan, result, target);
    expect(target[5]).toEqual([]);
    ast.children[0]!.value = "";
    coloursFromAST(plan, result, target);
    expect(target[5]).toEqual([]);
    ast.children[0]!.value = "\n\n";
    expect(() => coloursFromAST(plan, result, target)).toThrow("original source line");
    ast.children[0]!.value = "\n";
    ast.properties["data-line"] = 2;
    expect(() => coloursFromAST(plan, result, target)).toThrow("unique source line");
    ast.properties["data-line"] = 1;
    ast.properties["data-line-type"] = "context";
    expect(() => coloursFromAST(plan, result, target)).toThrow("unique source line");
    ast.properties["data-line-type"] = "change-addition";
    result.unifiedContentAST!.push(result.unifiedContentAST![0]!);
    expect(() => coloursFromAST(plan, result, target)).toThrow("unique source line");
  });
  it("publishes no colours without a verified public AST body or after an AST mismatch", () => {
    const plan = parse(simple)[0]!;
    const target: DiffColours = simple.split("\n").map(() => null);
    coloursFromAST(plan, { unifiedContentAST: [] } as unknown as Parameters<typeof coloursFromAST>[1], target);
    expect(target.every(row => row === null)).toBe(true);
    const result = { unifiedContentAST: [{ type: "element", tagName: "div", properties: {
      "data-line": 1, "data-line-type": "change-addition",
    }, children: [{ type: "text", value: "wrong source" }] }] } as unknown as Parameters<typeof coloursFromAST>[1];
    expect(() => coloursFromAST(plan, result, target)).toThrow("original source line");
    expect(target.every(row => row === null)).toBe(true);
  });
});

describe("public @pierre render AST and the actual Shiki themes", () => {
  afterAll(() => disposeHighlighter());
  it.each([
    { language: "typescript", suffix: "ts", old: ["/*", " * old", " * visible"], next: ["/*", " * new", " * visible"], tail: [" */", "const outside=1;"] },
    { language: "typescript", suffix: "ts", old: ["const t = `", "old", "visible"], next: ["const t = `", "new", "visible"], tail: ["`;", "const outside=1;"] },
    { language: "markdown", suffix: "md", old: ["```typescript", "const old=1;", "const visible=1;"], next: ["```typescript", "const next=1;", "const visible=1;"], tail: ["```", "outside **bold**"] },
    { language: "tsx", suffix: "tsx", old: ["const c = <section>", "old", "<span />"], next: ["const c = <section>", "new", "<span />"], tail: ["</section>;", "const outside=1;"] },
  ] as const)("a hunk from line 1 matches the full file; raw colours come out: $suffix $language", async fixture => {
    const theme = { light: "github-light-high-contrast", dark: "github-dark-default" };
    const highlighter = await getSharedHighlighter({ themes: [], langs: [], preferredHighlighter: "shiki-js" });
    const themes = await Promise.all([import("shiki/themes/github-light-high-contrast.mjs"), import("shiki/themes/github-dark-default.mjs")]);
    attachResolvedThemes(themes.map(module => { const t = normalizeTheme(module.default); return { name: t.name, type: t.type, fg: t.fg, bg: t.bg, colors: t.colors, textmate: t }; }), highlighter);
    const grammar = await codeLanguage(`sample.${fixture.suffix}`)!.import();
    attachResolvedLanguages([{ name: fixture.language, data: grammar.default }], highlighter);
    for (const source of [fixture.old, fixture.next]) {
      const short = highlighter.codeToTokens(source.join("\n"), { lang: fixture.language, themes: theme }).tokens;
      const full = highlighter.codeToTokens([...source, ...fixture.tail].join("\n"), { lang: fixture.language, themes: theme }).tokens.slice(0, source.length);
      expect(short).toEqual(full);
    }
    const text = header(`sample.${fixture.suffix}`) + hunk([...fixture.old], [...fixture.next]);
    const plan = parse(text)[0]!;
    const renderer = new DiffHunksRenderer({ theme, diffStyle: "unified", preferredHighlighter: "shiki-js", tokenizeMaxLineLength: DIFF_LIMITS.lineUnits + 1 });
    try {
      const ast = await renderer.asyncRender(plan.file);
      const target: DiffColours = Array.from({ length: text.split("\n").length }, () => null);
      coloursFromAST(plan, ast, target);
      expect(target.filter(row => row !== null).length).toBe(fixture.old.length + fixture.next.length);
      for (const [index, row] of target.entries()) for (const [start, end] of row ?? []) {
        expect(start).toBeGreaterThanOrEqual(1);
        expect(end).toBeLessThanOrEqual(text.split("\n")[index]!.length);
        expect(start).toBeLessThan(end);
      }
    } finally { renderer.cleanUp(); }
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<DiffWorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  messages: DiffWorkerRequest[] = [];
  terminated = false;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: DiffWorkerRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(data: DiffWorkerResponse) { this.onmessage?.({ data } as MessageEvent<DiffWorkerResponse>); }
}
describe("one worker lifecycle through highlightDiff", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal("Worker", FakeWorker); vi.stubGlobal("window", new EventTarget()); FakeWorker.instances = []; vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("does not create a worker for an aborted signal or oversized input", async () => {
    const { highlightDiff } = await import("../src/features/reader/diff/diff-runtime");
    const abort = new AbortController(); abort.abort();
    expect(await highlightDiff(document(simple), abort.signal)).toBeNull();
    expect(await highlightDiff({ ...document(simple), text: "x".repeat(DIFF_LIMITS.inputBytes + 1) }, new AbortController().signal)).toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it("keeps requests independent and ignores cancelled/late replies", async () => {
    const { highlightDiff } = await import("../src/features/reader/diff/diff-runtime");
    const first = new AbortController(), next = new AbortController();
    const a = highlightDiff(document(simple), first.signal), b = highlightDiff(document(simple), next.signal);
    const worker = FakeWorker.instances[0]!;
    const [oldMessage, newMessage] = worker.messages;
    expect(oldMessage).toMatchObject({ kind: "highlight", document: { kind: "structured", text: simple } });
    expect(oldMessage).not.toHaveProperty("text");
    first.abort(); expect(await a).toBeNull();
    worker.reply({ id: oldMessage!.id, colours: [] });
    worker.reply({ id: newMessage!.id, colours: [] });
    expect(await b).toEqual([]); expect(worker.terminated).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it("records a grammar fault once in main while retaining other language colours; plain results are ordinary", async () => {
    const { highlightDiff } = await import("../src/features/reader/diff/diff-runtime");
    const colours: DiffColours = [null, [[1, 2, "#111111", "#eeeeee"]]];
    const partial = highlightDiff(document(simple), new AbortController().signal);
    const worker = FakeWorker.instances[0]!;
    const id = worker.messages[0]!.id;
    worker.reply({ id, colours, reason: "grammar-load", cause: "typescript: import failed" });
    worker.reply({ id, colours, reason: "grammar-load", cause: "duplicate late response" });
    expect(await partial).toEqual(colours);
    expect(console.error).toHaveBeenCalledExactlyOnceWith("[diff colours]", expect.objectContaining({
      message: "Diff grammar-load", cause: "typescript: import failed",
    }));
    const plain = highlightDiff(document(simple), new AbortController().signal);
    worker.reply({ id: worker.messages[1]!.id, colours: null });
    expect(await plain).toBeNull();
    expect(console.error).toHaveBeenCalledOnce(); expect(worker.terminated).toBe(false);
  });
  it.each(["error", "messageerror", "timeout"] as const)("settles every subscriber and terminates on %s", async failure => {
    const { highlightDiff } = await import("../src/features/reader/diff/diff-runtime");
    const a = highlightDiff(document(simple), new AbortController().signal), b = highlightDiff(document(simple), new AbortController().signal);
    const worker = FakeWorker.instances[0]!;
    if (failure === "error") worker.onerror?.(new Event("error"));
    else if (failure === "messageerror") worker.onmessageerror?.(new MessageEvent("messageerror"));
    else vi.advanceTimersByTime(10_000);
    expect(await a).toBeNull(); expect(await b).toBeNull(); expect(worker.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0);
    expect(await highlightDiff(document(simple), new AbortController().signal)).toBeNull(); expect(FakeWorker.instances).toHaveLength(1);
    expect(console.error).toHaveBeenCalledOnce();
  });
  it("cleans up the final cancellation and page lifecycle without applying a stale generation", async () => {
    const { highlightDiff } = await import("../src/features/reader/diff/diff-runtime");
    const signal = new AbortController(), a = highlightDiff(document(simple), signal.signal); const old = FakeWorker.instances[0]!;
    signal.abort(); expect(await a).toBeNull(); expect(old.terminated).toBe(true);
    const b = highlightDiff(document(simple), new AbortController().signal); old.reply({ id: 2, colours: [] });
    window.dispatchEvent(new Event("pagehide")); expect(await b).toBeNull(); expect(FakeWorker.instances[1]!.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("worker transport faults", () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget()); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it("returns plain when constructing or posting to a Worker throws", async () => {
    vi.stubGlobal("Worker", class { constructor() { throw new Error("worker unavailable"); } });
    let runtime = await import("../src/features/reader/diff/diff-runtime");
    expect(await runtime.highlightDiff(document(simple), new AbortController().signal)).toBeNull();
    vi.resetModules();
    const terminate = vi.fn();
    vi.stubGlobal("Worker", class { postMessage() { throw new Error("clone failed"); } terminate = terminate; });
    runtime = await import("../src/features/reader/diff/diff-runtime");
    expect(await runtime.highlightDiff(document(simple), new AbortController().signal)).toBeNull();
    expect(terminate).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});


describe("worker fault envelope without a UI dependency", () => {
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    await (await import("@pierre/diffs")).disposeHighlighter();
    vi.unstubAllGlobals(); vi.restoreAllMocks();
  });
  async function runWorker(text: string, source: StructuredDiffDocument | CodeFile = document(text)): Promise<DiffWorkerResponse> {
    let reply!: (response: DiffWorkerResponse) => void;
    const result = new Promise<DiffWorkerResponse>(resolve => { reply = resolve; });
    const scope = { onmessage: null as ((event: MessageEvent<DiffWorkerRequest>) => void) | null, postMessage: reply };
    vi.stubGlobal("self", scope);
    await import("../src/features/reader/diff/diff.worker");
    scope.onmessage!({ data: { kind: "highlight", id: 1, document: source } } as MessageEvent<DiffWorkerRequest>);
    return result;
  }
  it.each(["rename", "copy"] as const)("keeps %s metadata outside colours with quoted paths, CRLF/EOS and later file boundaries", async operation => {
    const firstHeader = renamedHeader(operation);
    const first = firstHeader + hunk(["const before = <p>日本語😀</p>;", ""], ["const after = <p>日本語😀</p>;", ""]);
    const secondHeader = header("next.md", "new");
    const text = (first + secondHeader + hunk([], ["# 次のファイル", ""], 0, 1)).slice(0, -1).replaceAll("\n", "\r\n");
    const response = await runWorker(text);
    expect(response.reason).toBeUndefined();
    const colours = response.colours!;
    const lines = text.split("\n");
    const secondStart = first.split("\n").length - 1;
    const secondHunk = secondStart + secondHeader.split("\n").length - 1;
    expect(colours.slice(0, firstHeader.split("\n").length - 1)).toEqual(Array(9).fill(null));
    expect(colours.slice(secondStart, secondHunk)).toEqual(Array(4).fill(null));
    expect(colours[firstHeader.split("\n").length - 1]).toBeNull();
    expect(colours[secondHunk]).toBeNull();
    expect(colours.at(-1)).toEqual([]);
    expect(colours.filter(row => row !== null)).toHaveLength(6);
    for (const [index, row] of colours.entries()) for (const [start, end] of row ?? []) {
      expect(start).toBeGreaterThanOrEqual(1);
      expect(end).toBeLessThanOrEqual(lines[index]!.replace(/\r$/, "").length);
    }
  });
  it("marks every hunk, after a gap too, and does not claim source EOF markers or later unsupported files", async () => {
    const prefix = header() + hunk(["const before=1;"], ["const after=1;"])
      + hunk([""], [""], 2, 2);
    // (@pierre/diffs 1.6.1 cannot render an empty last line without its newline; that file's rows stay plain.)
    const afterGap = "@@ -4,1 +4,1 @@\n-const x=1;\n+const y=2;\n\\ No newline at end of file\n";
    const unknown = header("other.zzz") + hunk([""], [""]);
    const text = prefix + afterGap + unknown;
    const response = await runWorker(text);
    expect(response.reason).toBeUndefined();
    expect(response.colours!.slice(0, 3)).toEqual(Array(3).fill(null));
    expect(response.colours![3]).toBeNull();
    expect(response.colours![6]).toBeNull();
    expect(response.colours![7]).toEqual([]);
    expect(response.colours![8]).toEqual([]);
    const gap = prefix.split("\n").length - 1;
    expect(response.colours![gap]).toBeNull();
    expect(response.colours!.slice(gap + 1, gap + 3).every(row => !!row?.length)).toBe(true);
    expect(response.colours![gap + 3]).toBeNull();
    expect(response.colours!.slice(gap + 4).every(row => row === null)).toBe(true);
  });
  it("retains unified header boundaries without a git header and leaves source EOF markers plain", async () => {
    const text = simple.replace(/^diff --git[^\n]*\n/, "").trimEnd() + "\n\\ No newline at end of file";
    const response = await runWorker(text);
    expect(response.reason).toBeUndefined();
    expect(response.colours!.slice(0, 2)).toEqual(Array(2).fill(null));
    expect(response.colours![2]).toBeNull();
    expect(response.colours!.at(-1)).toBeNull();
  });
  it.each(["render", "source-check"] as const)("keeps a failed file wholly null and continues to later successful files on %s failure", async failure => {
    const library = await import("@pierre/diffs");
    const render = library.DiffHunksRenderer.prototype.asyncRender;
    vi.spyOn(library.DiffHunksRenderer.prototype, "asyncRender").mockImplementation(async function (this: DiffHunksRenderer, ...args) {
      const result = await render.apply(this, args);
      if (args[0].name === "bad.ts") {
        if (failure === "render") throw new Error("renderer fault");
        // Fail after a real successful AST, including after its first body row was accepted.
        const corrupt = (node: NonNullable<typeof result.unifiedContentAST>[number]): void => {
          if (node.type !== "element") return;
          if (node.properties["data-line-type"] === "change-addition") node.children = [{ type: "text", value: "wrong source" }];
          else node.children.forEach(corrupt);
        };
        result.unifiedContentAST?.forEach(corrupt);
      }
      return result;
    });
    const bad = simple.replaceAll("sample.ts", "bad.ts");
    const good = emptyPatch("ctx");
    const response = await runWorker(bad + good);
    expect(response.reason).toBe("highlight-failed");
    expect(response.cause).toContain(failure === "render" ? "renderer fault" : "original source line");
    expect(response.colours!.slice(0, bad.split("\n").length - 1).every(row => row === null)).toBe(true);
    const start = bad.split("\n").length - 1;
    expect(response.colours!.slice(start, start + 3)).toEqual(Array(3).fill(null));
    expect(response.colours![start + 3]).toBeNull();
    expect(response.colours!.filter(row => row !== null && row.length === 0)).toEqual([[], [], []]);
    expect(response.colours![start + 4]!.length).toBeGreaterThan(0);
  });
  it.each((["add", "del", "ctx"] as const).flatMap(kind => [{ kind, ending: "\n", eos: false }, { kind, ending: "\r\n", eos: true }]))("returns verified empty $kind rows (ending=$ending EOS=$eos), retaining neighbouring spans", async ({ kind, ending, eos }) => {
    const original = emptyPatch(kind);
    const text = (eos ? original.slice(0, -1) : original).replaceAll("\n", ending);
    const response = await runWorker(text);
    expect(response.reason).toBeUndefined();
    const lines = text.split("\n").map(line => line.replace(/\r$/, ""));
    expect(response.colours).toHaveLength(lines.length);
    for (const [index, line] of lines.entries()) {
      const row = response.colours![index];
      if (line === "+" || line === "-" || line === " ") {
        expect(row, `${kind} ${JSON.stringify(ending)} EOS=${eos} line=${index}`).toEqual([]);
      } else if (line.slice(1).startsWith("const ")) {
        expect(row?.length).toBeGreaterThan(0);
        for (const [start, end] of row!) {
          expect(start).toBeGreaterThanOrEqual(1);
          expect(end).toBeLessThanOrEqual(line.length);
          expect(start).toBeLessThan(end);
        }
      } else expect(row).toBeNull();
    }
    expect(response.colours!.at(eos ? -1 : -2)).toEqual([]);
  });
  it("keeps empty rows null in a file whose name has no language", async () => {
    expect(await runWorker(emptyPatch("ctx").replaceAll("empty.tsx", "empty.zzz"))).toEqual({ id: 1, colours: null });
  });
  it("returns verified empty rows after a gap as before it", async () => {
    const text = emptyPatch("ctx");
    const gap = text + "@@ -5,1 +5,1 @@\n-\n+\n";
    const response = await runWorker(gap);
    expect(response.colours![5]).toEqual([]);
    expect(response.colours!.slice(text.split("\n").length)).toEqual([[], [], null]);
  });
  it("sends one bounded grammar cause per language and keeps successful language rows", async () => {
    const { codeLanguage: language } = await import("../src/features/reader/diff/diff-languages");
    const broken = vi.spyOn(language("one.ts")!, "import").mockRejectedValue(new Error("grammar missing " + "x".repeat(10_000)));
    const ts = header("one.ts") + hunk(["const old=1;", ""], ["const next=1;", ""]);
    const tsAgain = header("two.ts") + hunk(["const old=2;"], ["const next=2;"]);
    const md = header("three.md") + hunk(["**before**"], ["**after**"]);
    const response = await runWorker(ts + tsAgain + md);
    expect(broken).toHaveBeenCalledOnce();
    expect(response.reason).toBe("grammar-load");
    expect(response.cause).toContain("typescript: Error: grammar missing");
    expect(response.cause!.length).toBeLessThanOrEqual(1024);
    expect(response.colours?.filter(row => row !== null)).toHaveLength(2);
    expect(response.colours?.slice((ts + tsAgain).split("\n").length - 1, (ts + tsAgain).split("\n").length + 3).every(row => row === null)).toBe(true);
    expect(response.colours?.slice(0, (ts + tsAgain).split("\n").length - 1).every(row => row === null)).toBe(true);
  });
  it("uses the same canonical octal-path document through the real Worker handler", async () => {
    const escaped = String.raw`src/\346\227\245.ts`;
    const text = `diff --git "a/${escaped}" "b/${escaped}"\n--- "a/${escaped}"\n+++ "b/${escaped}"\n` + hunk(["const before=1;"], ["const next=1;"]);
    const source = document(text), before = structuredClone(source);
    const response = await runWorker(text, source);
    expect(response.reason).toBeUndefined();
    expect(response.colours?.filter(row => row !== null)).toHaveLength(2);
    expect(source).toEqual(before);
    expect(source.files[0]!.newPath).toBe("src/日.ts");
  });
  it.each(["source", "vendor-parse"])("returns ordinary plain for a %s inconsistency without changing structure", async failure => {
    const source = structuredClone(document(simple));
    if (failure === "source") source.lines[4]!.start++;
    else source.text = source.text.replace("@@ -1,1 +1,1 @@", "@@ -1,9 +1,9 @@");
    const before = structuredClone(source);
    expect(await runWorker(source.text, source)).toEqual({ id: 1, colours: null });
    expect(source).toEqual(before);
  });
  it("paints a whole file's lines from their first letter, an empty line with no spans", async () => {
    const text = "const a = 1;\r\n// note\n\nexport {};\n";
    const response = await runWorker(text, { kind: "file", path: "src/a.ts", text });
    expect(response.reason).toBeUndefined();
    const lines = text.split("\n").map(line => line.replace(/\r$/, ""));
    expect(response.colours![0]![0]!.slice(0, 2)).toEqual([0, 5]);
    expect(response.colours![1]!.length).toBeGreaterThan(0);
    expect(response.colours![2]).toEqual([]);
    for (const [index, row] of response.colours!.entries()) for (const [start, end] of row ?? []) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(lines[index]!.length);
    }
  });
  it("leaves a whole file over 2000 lines plain", async () => {
    const text = "const a = 1;\n".repeat(2001);
    expect(await runWorker(text, { kind: "file", path: "long.ts", text })).toEqual({ id: 1, colours: null });
  });
  it("leaves a whole file whose name has no language plain", async () => {
    const text = "const a = 1;\n";
    expect(await runWorker(text, { kind: "file", path: "notes.txt", text })).toEqual({ id: 1, colours: null });
  });
  it("paints a hunk from a file's middle", async () => {
    const response = await runWorker(header() + hunk(["const old = 1;"], ["const next = 2;"], 8, 8));
    expect(response.reason).toBeUndefined();
    expect(response.colours!.slice(4, 6).every(row => !!row?.length)).toBe(true);
  });
});

describe("canonical lightweight diff document", () => {
  function partition(source: StructuredDiffDocument) {
    let offset = 0, index = 0;
    for (const row of source.lines) {
      expect(row.start).toBe(offset);
      expect(row.contentEnd).toBeGreaterThanOrEqual(row.start);
      expect(row.end).toBeGreaterThanOrEqual(row.contentEnd);
      expect(source.text.slice(row.contentEnd, row.end)).toMatch(/^(?:\r?\n)?$/);
      offset = row.end;
    }
    expect(offset).toBe(source.text.length);
    for (const part of source.parts) {
      const range = part.kind === "body" ? [part.line, part.line + 1] : part.source;
      expect(range[0]).toBe(index);
      expect(range[1]).toBeGreaterThan(index);
      index = range[1]!;
      if (part.kind === "body") {
        const row = source.lines[part.line]!;
        expect(source.text.slice(row.start, row.contentEnd)[0]).toBe(part.change === "add" ? "+" : part.change === "del" ? "-" : " ");
      }
    }
    expect(index).toBe(source.lines.length);
    expect(source.lines.map(row => source.text.slice(row.start, row.end)).join("")).toBe(source.text);
  }
  it.each(["\n", "\r\n"])("partitions every source byte including preamble, EOF, blank tail and EOS (%j)", ending => {
    const input = "A preamble\n" + header() + "@@ -1,2 +1,2 @@\n context😀\n--- old body\n+++ new body\n\\ No newline at end of file\n\nA tail";
    for (const eos of [true, false]) {
      const text = (eos ? input : input + "\n").replaceAll("\n", ending);
      const source = document(text);
      partition(source);
      expect(source.files[0]!.stats).toEqual({ added: 1, deleted: 1 });
      expect(source.parts.filter(part => part.kind === "body")).toHaveLength(3);
      expect(source.parts.filter(part => part.kind === "file")).toHaveLength(1);
      expect(source.parts.filter(part => part.kind === "hunk")).toHaveLength(1);
      expect(source.lines).toHaveLength(text.split("\n").length);
    }
  });
  it("preserves a lone CR at EOS as payload", () => {
    const source = document(simple.slice(0, -1) + "\r");
    const last = source.lines.at(-1)!;
    expect(source.text.slice(last.start, last.contentEnd)).toBe("+const after=1;\r");
    partition(source);
  });
  it("counts actual changes across context and later gaps; partial hunks are complete structure without syntax", () => {
    const text = header("other.zzz") + "@@ -40,2 +40,3 @@ heading\n unchanged\n-old\n+new\n+added\n@@ -50 +51 @@\n-previous\n+next\n";
    const source = document(text);
    expect(source.files[0]).toMatchObject({ stats: { added: 3, deleted: 2 }, hunks: [{ id: 3, oldStart: 40, oldCount: 2, newStart: 40, newCount: 3 }, { oldStart: 50, newStart: 51 }] });
    expect(parse(text)).toEqual([]);
    partition(source);
  });
  it.each(["new", "deleted"] as const)("understands %s null sides in both Git and standalone unified input", mode => {
    const text = header("zero.ts", mode) + (mode === "new" ? hunk([], ["const x=1;"], 0, 1) : hunk(["const x=1;"], [], 1, 0));
    for (const input of [text, text.slice(text.indexOf("--- "))]) {
      const source = document(input);
      expect(source.files[0]).toMatchObject({ change: mode, oldPath: mode === "new" ? null : input === text ? "zero.ts" : "a/zero.ts", newPath: mode === "deleted" ? null : input === text ? "zero.ts" : "b/zero.ts" });
      partition(source);
    }
  });
  it.each(["rename", "copy"] as const)("preserves explicit %s, mode, complete paths and source ranges", operation => {
    const source = document(renamedHeader(operation) + hunk(["old"], ["new"]));
    expect(source.files[0]).toMatchObject({ oldPath: "old name.tsx", newPath: "new name.tsx", change: operation, mode: { old: "100644", next: "100755" }, stats: { added: 1, deleted: 1 } });
    expect(source.parts.filter(part => part.kind === "raw").flatMap(part => part.kind === "raw" ? Array.from({ length: part.source[1] - part.source[0] }, (_, i) => source.text.slice(source.lines[part.source[0] + i]!.start, source.lines[part.source[0] + i]!.contentEnd)) : [])).toContain("old mode 100644");
    partition(source);
  });
  it.each(["rename", "copy"] as const)("accepts pure %s without similarity or body; never strips real a/ and b/ directory names", operation => {
    const source = document(`diff --git a/a/old.ts b/b/new.ts\n${operation} from a/old.ts\n${operation} to b/new.ts\n`);
    expect(source.files[0]).toMatchObject({ oldPath: "a/old.ts", newPath: "b/new.ts", change: operation, stats: { added: 0, deleted: 0 }, hunks: [] });
    partition(source);
  });
  it("keeps standalone unified names verbatim without inferring rename", () => {
    const text = "--- a/old.ts\t2026-01-01\n+++ b/new.ts\t2026-01-02\n" + hunk(["old"], ["new"]);
    expect(document(text).files[0]).toMatchObject({ oldPath: "a/old.ts", newPath: "b/new.ts", change: "change" });
    expect(parse(text)).toHaveLength(1);
  });
  it("supports mode-only and empty new/deleted files, keeping mode rows raw", () => {
    for (const [metadata, change] of [["old mode 100644\nnew mode 100755\n", "change"], ["new file mode 100644\n", "new"], ["deleted file mode 100644\n", "deleted"]] as const) {
      const text = "diff --git a/sample.ts b/sample.ts\n" + metadata;
      const source = document(text);
      expect(source.files[0]).toMatchObject({ change, hunks: [], stats: { added: 0, deleted: 0 } });
      expect(source.parts.some(part => part.kind === "raw" && part.source[0] === 1)).toBe(true);
      partition(source);
    }
  });
  it("decodes octal UTF8 paths and C escapes once, without changing raw source", () => {
    const escaped = String.raw`src/\346\227\245\346\234\254\350\252\236\t\n\\\".ts`;
    const text = `diff --git "a/${escaped}" "b/${escaped}"\n--- "a/${escaped}"\n+++ "b/${escaped}"\n` + hunk(["const old=1;"], ["const next=1;"]);
    const source = document(text);
    expect(source.files[0]).toMatchObject({ oldPath: 'src/日本語\t\n\\".ts', newPath: 'src/日本語\t\n\\".ts' });
    expect(source.text).toBe(text);
    expect(parse(text)).toHaveLength(1);
    partition(source);
  });
  it("rejects an escaped quote falsely posing as the closing quote of a rename path", () => {
    const text = String.raw`diff --git "a/old\"" "b/new.ts"
rename from "old\"
rename to new.ts
`;
    expect(describeDiff(text)).toMatchObject({ kind: "raw", text });
  });
  it.each([
    simple.replace("@@ -1,1 +1,1 @@", "@@ -1,9 +1,9 @@"),
    simple.replace("@@ -1,1 +1,1 @@", "@@ -0,1 +1,1 @@"),
    simple.replace("@@ -1,1 +1,1 @@", "@@ -9007199254740992,1 +1,1 @@"),
    simple.replace("@@ -1,1 +1,1 @@", "@@ -1,-1 +1,1 @@"),
    simple + "+surplus\n", simple + " extra context\n", simple + "-surplus\n",
    header() + hunk(["old"], ["new"]) + hunk(["old"], ["new"], 1, 1),
    header() + hunk(["old"], ["new"], 40, 40) + hunk(["old"], ["new"], 2, 2),
    simple.replace("--- a/sample.ts", "--- a/wrong.ts"),
    simple.replace("--- a/sample.ts", "new file mode 100644\n--- a/sample.ts"),
    simple.replace("+++ b/sample.ts", "+++ /dev/null"),
    simple.replace("--- a/sample.ts", "old mode 100644\n--- a/sample.ts"),
    simple.replace("--- a/sample.ts", "rename from sample.ts\n--- a/sample.ts"),
    simple.replace("--- a/sample.ts", "rename from sample.ts\ncopy to sample.ts\n--- a/sample.ts"),
    simple.replace("--- a/sample.ts", "rename from wrong.ts\nrename to sample.ts\n--- a/sample.ts"),
    simple.replace("--- a/sample.ts", "index abc..def\nindex aaa..bbb\n--- a/sample.ts"),
    simple.replace("--- a/sample.ts", "old mode 100644\nnew mode 100755\nindex abc..def 100644\n--- a/sample.ts"),
    simple.replaceAll("sample.ts", String.raw`bad\q.ts`).replace(/(a\/[^\n ]+|b\/[^\n ]+)/g, '"$1"'),
    'diff --git "a/\\377.ts" "b/\\377.ts"\nold mode 100644\nnew mode 100755\n',
    'diff --git "a/unclosed.ts b/unclosed.ts\n',
    simple.replace("-const before=1;", "\\ No newline at end of file\n-const before=1;"),
    simple.trimEnd() + "\n\\ No newline at end of file\n\\ No newline at end of file\n",
    simple.trimEnd() + "\n\\ No newline at end of file\n@@ -2 +2 @@\n-old\n+new\n",
    simple + header("next.md") + "@@ -1,2 +1 @@\n-old\n+new\n",
  ])("returns the entire malformed document raw: %j", text => {
    const result = describeDiff(text);
    expect(result.kind).toBe("raw");
    expect(result.text).toBe(text);
    expect(result).not.toHaveProperty("lines");
  });
  it.each([
    "diff --cc sample.ts\n@@@ -1 -1 +1 @@@\n",
    "commit 1\n\n    A merge\n\ndiff --cc sample.ts\nindex a,b..c\n--- a/sample.ts\n+++ b/sample.ts\n@@@ -1,1 -1,1 +1,2 @@@\n- old\n -old\n++new\n",
    "From 1 Mon Sep 17 00:00:00 2001\nSubject: A change\n\n- a point of the message\n---\n sample.ts | 2 +-\n\n" + simple + "-- \n2.43.0\n",
    "diff -u a.ts b.ts\n--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new\n",
    "--- a/sample.ts\n+++ b/sample.ts\n-old\n+new\n",
    "Binary files a/p and b/p differ\n-x\n", "GIT binary patch\n-x\n",
    "plain words\n context line\n", "",
    "diff --git a/pic.png b/pic.png\nBinary files a/pic.png and b/pic.png differ\n",
    "diff --git a/pic.png b/pic.png\nGIT binary patch\nliteral 10\n",
    simple.replace("--- a/sample.ts", "unknown header extension\n--- a/sample.ts"),
    simple.replace("@@ -1,1 +1,1 @@", "X-Extension: unknown\n@@ -1,1 +1,1 @@"),
  ])("leaves unsupported/binary input, a text naming a file, and one with no +/- line fully raw: %j", text => {
    expect(describeDiff(text)).toMatchObject({ kind: "raw", text });
  });
  /** A `lines` document's rows as read: its change and its letters, the source's line ends kept out. */
  const lineRows = (text: string) => {
    const result = describeDiff(text);
    if (result.kind !== "lines") throw new Error(`Expected lines: ${result.kind}`);
    expect(result.changes).toHaveLength(result.lines.length);
    // Its lines partition the text, so nothing is lost or made up.
    expect(result.lines.map(line => text.slice(line.start, line.end)).join("")).toBe(text);
    return result.changes.map((change, i) => [change, text.slice(result.lines[i]!.start, result.lines[i]!.contentEnd)]);
  };
  it("reads +/- lines that name no file as added and removed, by their first letter alone", () => {
    expect(lineRows("-Design for maintainability.\n+Design around data.")).toEqual([["del", "-Design for maintainability."], ["add", "+Design around data."]]);
    expect(lineRows("words\n kept\n -indented\n +indented\n\n-gone\r\n+come\n\\ No newline at end of file\n")).toEqual([
      ["ctx", "words"], ["ctx", " kept"], ["ctx", " -indented"], ["ctx", " +indented"], ["ctx", ""], ["del", "-gone"], ["add", "+come"], ["ctx", "\\ No newline at end of file"], ["ctx", ""]]);
  });
  it("reads a hunk's line without a file as a plain line, makes up no number, and takes a lone --- or +++ as a change", () => {
    expect(lineRows("@@ -1 +1 @@\n-old\n+new\n").slice(0, 3)).toEqual([["ctx", "@@ -1 +1 @@"], ["del", "-old"], ["add", "+new"]]);
    expect(lineRows("--- a comment\n+new")).toEqual([["del", "--- a comment"], ["add", "+new"]]);
    expect(lineRows("-old\n+++ more")).toEqual([["del", "-old"], ["add", "+++ more"]]);
  });
  it("keeps a whole patch's reading: the lines' rule never takes one over", () => {
    expect(describeDiff(simple).kind).toBe("structured");
    expect(describeDiff("- a point of the message\n" + simple).kind).toBe("structured");
  });
  it("enforces physical input limits before building a document's row array", () => {
    const atLimit = simple + "\n".repeat(DIFF_LIMITS.lines - simple.split("\n").length);
    expect(document(atLimit).lines).toHaveLength(DIFF_LIMITS.lines);
    for (const text of [atLimit + "\n", "short\n".repeat(100_000), "x".repeat(DIFF_LIMITS.inputBytes + 1), "x".repeat(DIFF_LIMITS.lineUnits + 2)]) {
      expect(describeDiff(text)).toEqual({ kind: "raw", text, reason: "limit" });
    }
  });
  it.each(["index", "range", "count", "body-kind", "path", "vendor-text", "vendor-count", "vendor-hunk", "vendor-eof", "file-id"])("stops syntax on corrupted %s without rebuilding or altering the display model", mutation => {
    const source = structuredClone(document(simple));
    const files = parsePatchFiles(simple, undefined, true).flatMap(patch => patch.files);
    if (mutation === "index") { const part = source.parts.find(part => part.kind === "body")!; if (part.kind === "body") part.line++; }
    if (mutation === "range") source.lines[0]!.contentEnd++;
    if (mutation === "count") (source.files[0]!.hunks[0]!).oldCount++;
    if (mutation === "body-kind") { const part = source.parts.find(part => part.kind === "body")!; if (part.kind === "body") part.change = "ctx"; }
    if (mutation === "path") source.files[0]!.newPath = "wrong.ts";
    if (mutation === "vendor-text") files[0]!.additionLines[0] = "corrupted source\n";
    if (mutation === "vendor-count") files[0]!.hunks[0]!.additionCount++;
    if (mutation === "vendor-eof") files[0]!.hunks[0]!.noEOFCRAdditions = true;
    if (mutation === "file-id") source.files[0]!.id++;
    if (mutation === "vendor-hunk") files[0]!.hunks[0]!.hunkSpecs = "@@ -2 +2 @@\n";
    const before = structuredClone(source);
    expect(planDiff(source, files)).toEqual([]);
    expect(source).toEqual(before);
  });
});
