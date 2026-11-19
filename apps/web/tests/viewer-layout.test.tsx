import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { queryClient } from "../src/data/query-client";
import { resources } from "../src/data/resources";
import { UrlViewer } from "../src/features/reader/viewer/Viewer";
import { VIEWER_BOUNDS, viewerLayout } from "../src/features/reader/viewer/viewer-layout";
import { viewerAddress } from "../src/domain/viewer-target";
import { DELIMITED_MAX_BYTES } from "../src/domain/delimited-file";
import { chooseLook } from "../src/features/reader/viewer/viewer-look";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, screenData } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); queryClient.clear(); useViewStore.setState({ view: null }); });

test("every page starts open up to both bounds, and closed past either", () => {
  const { openPages, openLines } = VIEWER_BOUNDS;
  expect([[openPages, openLines], [openPages + 1, 10], [2, openLines + 1]].map(([pages, lines]) => viewerLayout(pages!, lines!).open))
    .toEqual([true, false, false]);
});

test("a single page has no heading of its own and starts open, however long it is", () => {
  expect(viewerLayout(1, 100_000)).toEqual({ open: true, heads: false });
  expect(viewerLayout(2, 10).heads).toBe(true);
});

const patchOf = (path: string, rows: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n${rows.join("\n")}\n`;

/** The viewer as every way into it leaves it: the URL's `view` naming a Task's file (a report's summary, the Files tab and a reload all write only that). */
function openViewer(files: Record<string, string>, path: string, unreadable: string[] = []) {
  const data = screenData();
  // The Task's file list, as its view reads it, put in place once the workspace has seeded its own.
  const Seed = () => { useState(() => queryClient.setQueryData(resources.taskView(data.info.root, "T1").queryKey, { task: { id: "T1",
    files: Object.entries(files).map(([name, text]) => ({ name, size: text.length, revision: "r", at: "2026-11-08T00:00:00.000Z",
      ...unreadable.includes(name) ? { readable: false } : {} })) } } as never)); return null; };
  vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = new URL(String(input), "http://localhost"), name = url.searchParams.get("path")!;
    return new Response(name in files ? files[name] : "", { status: name in files ? 200 : 404 });
  });
  useViewStore.setState({ view: viewerAddress("T1", path) });
  return render(<TestWorkspace data={data}><Seed /><UrlViewer renderProse={text => text} onFollow={() => {}} place="reader" /></TestWorkspace>);
}
const expanded = () =>
  [...document.querySelectorAll("[data-page-toggle]")].map(head => head.getAttribute("aria-expanded"));

test("a diff starts as its size says whenever the viewer opens on it: a heading closed before does not stay closed", async () => {
  const small = patchOf("docs/a.md", ["-one", "+two"]) + patchOf("docs/b.md", ["-three", "+four"]);
  for (const time of [1, 2]) {
    const view = openViewer({ "diffs/x.diff": small }, "diffs/x.diff");
    await waitFor(() => expect(expanded()).toEqual(["true", "true"]));
    if (time === 1) {
      fireEvent.click(document.querySelector<HTMLElement>("[data-page-toggle]")!);
      expect(expanded()).toEqual(["false", "true"]);
    }
    cleanup();
  }
});

test("a diff of one file is named by its title, with no heading of its own", async () => {
  openViewer({ "diffs/one.diff": patchOf("src/control/settings.ts", ["-a", "+b"]) }, "diffs/one.diff");
  await waitFor(() => expect(document.querySelector("[data-line-rows]")).toBeTruthy());
  expect(document.querySelector("[data-page-head]")).toBeNull();
  expect(document.querySelector("[data-viewer-head] h2, [data-viewer-head] [id]")?.textContent).toContain("settings.ts");
  // Under its name, the changed file's path to copy, not the diff file's.
  expect(document.querySelector("[data-viewer-head] [data-viewer-path]")?.textContent).toBe("src/control/settings.ts");
});

test("a diff still being read names no file in its head: its counts come with it, never its diff file's name first", async () => {
  openViewer({ "diffs/x.diff": patchOf("src/a.ts", ["-a", "+b"]) }, "diffs/x.diff");
  // The text of the diff never comes: what the head shows is what it shows while it is read.
  vi.mocked(globalThis.fetch).mockImplementation(() => new Promise<Response>(() => {}));
  await waitFor(() => expect(document.querySelector("[data-viewer-head]")).toBeTruthy());
  expect(document.querySelector("[data-viewer-head]")!.textContent).not.toContain("x.diff");
});

test("a Task file that is not text, or cannot be read, says why in the viewer's body, never as garbled lines", async () => {
  const view = openViewer({ "report.pdf": "%PDF-1.7\u0000\u0001" }, "report.pdf");
  await waitFor(() => expect(view.container.textContent).toContain(i18n.t("reader:viewer.binary")));
  expect(view.container.querySelector("[data-line-rows]")).toBeNull();
  expect(view.getByRole("link", { name: i18n.t("reader:image.saveFile") }).getAttribute("href")).toMatch(/report\.pdf.*&download=1$/);
  cleanup();
  const locked = openViewer({ "notes.txt": "x" }, "notes.txt", ["notes.txt"]);
  expect(locked.container.textContent).toContain(i18n.t("reader:ruleTab.readFailedHelp"));
});

test("an empty table or page read by its lines is read, not still being read", async () => {
  chooseLook({ source: true });
  try {
    for (const name of ["empty.csv", "empty.html"]) {
      const view = openViewer({ [name]: "" }, name);
      await waitFor(() => expect(view.container.querySelector("[data-line-rows]")).not.toBeNull());
      expect(view.container.querySelector("[aria-busy=true]")).toBeNull();
      cleanup(); queryClient.clear();
    }
  } finally { chooseLook({ source: false }); }
});

test("a file's head copies its letters as written, even drawn as a document, and saves its original under its own name", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const text = "# Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
  const view = openViewer({ "work/plan.md": text }, "work/plan.md");
  const copy = await view.findByRole("button", { name: i18n.t("reader:viewer.copyText") });
  fireEvent.click(copy);
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
  const save = view.getByRole("link", { name: i18n.t("reader:viewer.downloadFile") });
  expect(save.getAttribute("href")).toMatch(/work%2Fplan\.md.*&download=1$/);
  expect(save.getAttribute("download")).toBe("plan.md");
  cleanup();
  // Not text: nothing to copy, the original still saved.
  const binary = openViewer({ "report.pdf": "%PDF-1.7\u0000\u0001" }, "report.pdf");
  await waitFor(() => expect(binary.container.textContent).toContain(i18n.t("reader:viewer.binary")));
  expect(binary.queryByRole("button", { name: i18n.t("reader:viewer.copyText") })).toBeNull();
  expect(binary.getByRole("link", { name: i18n.t("reader:viewer.downloadFile") }).getAttribute("href")).toMatch(/report\.pdf.*&download=1$/);
});

test("a code location's file is saved from where it is read; its diff, as any diff, is only saved, never copied", async () => {
  const code = openViewer({ "/repo/src/a.ts": "export const a = 1;\n" }, "/repo/src/a.ts");
  await code.findByRole("button", { name: i18n.t("reader:viewer.copyText") });
  const save = code.getByRole("link", { name: i18n.t("reader:viewer.downloadFile") });
  expect([save.getAttribute("href"), save.getAttribute("download")]).toEqual([`/api/tasks/T1/code?path=${encodeURIComponent("/repo/src/a.ts")}&download=1`, "a.ts"]);
  cleanup(); queryClient.clear();
  const diff = openViewer({ "/repo/change.diff": patchOf("src/a.ts", ["-a", "+b"]) }, "/repo/change.diff");
  await waitFor(() => expect(diff.container.querySelector("[data-line-rows]")).toBeTruthy());
  expect(diff.queryByRole("button", { name: i18n.t("reader:viewer.copyText") })).toBeNull();
  expect(diff.getByRole("link", { name: i18n.t("reader:viewer.downloadFile") }).getAttribute("href")).toMatch(/change\.diff&download=1$/);
});

test("a table or a page copies its letters as read when it opens, a table in its one read; a table too large to draw is only saved", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const reads = (name: string) => vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => String(input).includes(name)).length;
  const table = "name,count\r\nalpha,1\r\n";
  const view = openViewer({ "work/data.csv": table }, "work/data.csv");
  await waitFor(() => expect(view.container.querySelector("table")).toBeTruthy());
  fireEvent.click(await view.findByRole("button", { name: i18n.t("reader:viewer.copyText") }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(table));
  expect(reads("data.csv")).toBe(1);
  cleanup(); queryClient.clear();
  const page = "<p>Hello</p>\n";
  const html = openViewer({ "page.html": page }, "page.html");
  fireEvent.click(await html.findByRole("button", { name: i18n.t("reader:viewer.copyText") }));
  await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(page));
  cleanup(); queryClient.clear();
  const big = openViewer({ "big.csv": "a,b\n".repeat(DELIMITED_MAX_BYTES / 4 + 1) }, "big.csv");
  await big.findByRole("link", { name: i18n.t("reader:viewer.downloadFile") });
  expect(big.queryByRole("button", { name: i18n.t("reader:viewer.copyText") })).toBeNull();
  expect(reads("big.csv")).toBe(0);
});
