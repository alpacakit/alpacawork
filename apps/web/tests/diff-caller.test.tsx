import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { ReadableStream, TransformStream, WritableStream } from "node:stream/web";
import { startI18n, i18n } from "@alpacawork/i18n";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { markdownDocument } from "../src/domain/markdown";
import type { DiffWorkerRequest, DiffWorkerResponse } from "../src/features/reader/diff/diff-types";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";

// The real runtime and worker module execute; only the thread's message transport is in-process.
// Node's native streams supply the API jsdom lacks when importing the actual public renderer.
const inputs: string[] = [];
class InlineWorker {
  onmessage: ((event: MessageEvent<DiffWorkerResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  stopped = false;
  scope = { onmessage: null as ((event: MessageEvent<DiffWorkerRequest>) => void) | null,
    postMessage: (data: DiffWorkerResponse) => { if (!this.stopped) this.onmessage?.({ data } as MessageEvent<DiffWorkerResponse>); } };
  ready = this.load();
  async load() {
    const previous = globalThis.self;
    vi.stubGlobal("self", this.scope);
    try { await import("../src/features/reader/diff/diff.worker"); }
    finally { vi.stubGlobal("self", previous); }
  }
  postMessage(data: DiffWorkerRequest) {
    if (data.kind === "highlight") inputs.push(data.document.text);
    void this.ready.then(() => { if (!this.stopped) this.scope.onmessage?.({ data } as MessageEvent<DiffWorkerRequest>); });
  }
  terminate() { this.stopped = true; }
}

const patch = (name: string, old: string, next: string) => [
  `diff --git a/${name} b/${name}`, `--- a/${name}`, `+++ b/${name}`, "@@ -1 +1 @@", `-${old}`, `+${next}`,
].join("\n");
// Same TS+TSX body as the actual closed-fence e2e fixture: final TSX has no trailing LF.
const multi = [
  "diff --git a/src/greeting.ts b/src/greeting.ts", "--- a/src/greeting.ts", "+++ b/src/greeting.ts", "@@ -1,4 +1,4 @@",
  " export function greet(name: string): string {", "-  const label = \"こんにちは\";", "-  return label + name;",
  "+  const label = \"こんばんは\";", "+  return `${label}、${name}さん`;", " }",
  "diff --git a/src/Card.tsx b/src/Card.tsx", "--- a/src/Card.tsx", "+++ b/src/Card.tsx", "@@ -1,6 +1,6 @@",
  " type Props = { title: string };", " export const Card = ({ title }: Props) => (", "-  <section className=\"card\">",
  "-    <h2>{title}</h2>", "+  <section className=\"card active\">", "+    <h2 aria-label=\"見出し\">{title.toUpperCase()}</h2>",
  "   </section>", " );"].join("\n");
const ts = patch("one.ts", "const before = 1;", "const after = 2;");
const markdown = ["diff --git a/a.md b/a.md", "new file mode 100644", "--- /dev/null", "+++ b/a.md", "@@ -0,0 +1,4 @@",
  "+# 見出し", "+", "+- 日本語の本文", "+**重要**"].join("\n");
/**
 * What each closed fence is drawn as at once (its files' bands, hunks' places, body and kept rows) and, once its colours
 * come, how many of its rows are painted: every row of a file whose name has a language, a hunk from a file's middle and
 * one after a gap too. A fence describeDiff does not read (a count missing, a line missing) is its text alone and asks
 * for no colours.
 */
const cases = [
  { name: "TS", text: ts, bands: 1, places: 0, body: 2, kept: 0, painted: 2 },
  { name: "TSX", text: patch("one.tsx", "const card = <span>before</span>;", "const card = <span>after</span>;"), bands: 1, places: 0, body: 2, kept: 0, painted: 2 },
  { name: "MD with an empty line", text: markdown, bands: 1, places: 0, body: 4, kept: 1, painted: 3 },
  { name: "TS then final TSX", text: multi, bands: 2, places: 0, body: 14, kept: 0, painted: 14 },
  { name: "explicit source EOF", text: ts.replace("-const before = 1;\n", "-const before = 1;\n\\ No newline at end of file\n") + "\n\\ No newline at end of file", bands: 1, places: 0, body: 2, kept: 2, painted: 2 },
  { name: "CRLF", text: ts.replaceAll("\n", "\r\n"), bands: 1, places: 0, body: 2, kept: 0, painted: 2 },
  { name: "middle hunk", text: ts.replace("@@ -1 +1 @@", "@@ -5 +5 @@"), bands: 1, places: 1, body: 2, kept: 0, painted: 2 },
  { name: "hunk after a gap", text: ["diff --git a/gap.ts b/gap.ts", "--- a/gap.ts", "+++ b/gap.ts", "@@ -1 +1 @@", " const safe = 1;", "@@ -3 +3 @@", "-const before=1;", "+const after=1;"].join("\n"), bands: 1, places: 1, body: 3, kept: 0, painted: 3 },
];
const unread = [ts.replace("@@ -1 +1 @@", "@@ -1,2 +1,2 @@"), ts.slice(0, ts.lastIndexOf("\n"))];

beforeAll(async () => {
  await startI18n(); await i18n.changeLanguage("en");
  vi.stubGlobal("ReadableStream", ReadableStream); vi.stubGlobal("WritableStream", WritableStream); vi.stubGlobal("TransformStream", TransformStream);
  vi.stubGlobal("Worker", InlineWorker);
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private seen: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.seen([{ isIntersecting: true }]); } disconnect() {} unobserve() {}
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
afterAll(async () => {
  await (await import("@pierre/diffs")).disposeHighlighter();
  vi.unstubAllGlobals();
});

test("MarkdownBody's closed-fence inputs draw their files at once, colour every eligible file, and copy as written", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const fences = [...cases.map(item => item.text), ...unread];
  const body = fences.map(text => "```diff\n" + text + "\n```").join("\n\n") + "\n\n```diff\n" + ts;
  const blocks = markdownDocument(body).blocks.filter(block => block.type === "code");
  const data = screenData(tree({ tasks: [dto()] }));
  const view = render(<TestWorkspace data={data}><MarkdownBody task={data.tasks[0]!} text={body} onFollow={() => {}} /></TestWorkspace>);
  const frames = view.container.querySelectorAll("[data-code-block]");
  expect(frames).toHaveLength(fences.length + 1);
  const count = (frame: Element, selector: string) => frame.querySelectorAll(selector).length;
  // Drawn at once, before any colour: each file's band, its rows and the hunks' places.
  for (const [index, item] of cases.entries()) {
    const frame = frames[index]!;
    expect([count(frame, "[data-diff-file]"), count(frame, "[data-diff-line=hunk]"), count(frame, "[data-diff-line=add], [data-diff-line=del], [data-diff-line=ctx]"), count(frame, "[data-diff-line=raw]")], item.name)
      .toEqual([item.bands, item.places, item.body, item.kept]);
  }
  await waitFor(() => expect(inputs).toHaveLength(cases.length));
  await waitFor(() => cases.forEach((item, index) =>
    expect(count(frames[index]!, "[data-diff-line]:has([style*='--code-light'])"), item.name).toBe(item.painted)));
  for (const index of fences.keys()) {
    const block = blocks[index]!;
    if (block.type !== "code") throw Error("Expected code block");
    expect(block.closed).toBe(true);
    expect(block.text.endsWith("\n")).toBe(false);
    if (index < cases.length) expect(inputs[index], cases[index]!.name).toBe(block.text);
    else expect(frames[index]!.querySelector("pre")!.textContent).toBe(block.text);
    fireEvent.click(frames[index]!.querySelector("button[data-copy]")!);
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(block.text));
  }
  // Unread and unclosed fences never reach the runtime and stay their text alone.
  for (const frame of [...frames].slice(cases.length)) expect(count(frame, "[data-diff-line], [data-diff-file]")).toBe(0);
  expect(inputs).toHaveLength(cases.length);
  view.unmount();
});
