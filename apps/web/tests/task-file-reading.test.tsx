import { expect, test } from "vitest";
import { fileOpening } from "../src/domain/task-files";
import { viewerCopy, viewerTarget } from "../src/domain/viewer-target";
import { decodeText } from "../src/domain/text-bytes";
import { fileReading } from "../src/features/reader/viewer/FilePages";
import { isStep } from "../src/state/history-step";
import type { Navigation } from "../src/state/view-store";

test("a Task's folder opens as the Files tab's sheet, a picture as its slide, any other file in the viewer over its folder", () => {
  expect(fileOpening("T1", "")).toEqual({ path: "", image: null, view: null });
  expect(fileOpening("T1", "docs/")).toEqual({ path: "docs/", image: null, view: null });
  expect(fileOpening("T1", "shots/a.png")).toEqual({ path: "shots/", image: "shots/a.png", view: null });
  for (const name of ["docs/a.md", "a.yml", "src/x.ts", "diffs/fix.diff", "Makefile", "report.pdf"])
    expect(fileOpening("T1", name)).toEqual({ path: name.slice(0, name.lastIndexOf("/") + 1), image: null, view: `T1/${name}` });
});

test("a document reads as it reads, a page as drawn, a table as cells, any other text by its lines", () => {
  expect(["a.md", "B.MD", "page.html", "t.csv", "t.tsv", "c.yml", "d.json", "e.ts", "f.txt", "g.log", "Makefile"].map(fileReading))
    .toEqual(["document", "document", "page", "table", "table", "lines", "lines", "lines", "lines", "lines", "lines"]);
});

test("bytes are text in UTF-8 or Shift_JIS; a NUL byte or bytes neither reads are not text, never garbled words", () => {
  const sjis = new Uint8Array([0x82, 0xa0, 0x82, 0xa2]);
  expect([decodeText(new TextEncoder().encode("名前: ok\n")), decodeText(sjis), decodeText(new Uint8Array())]).toEqual(["名前: ok\n", "あい", ""]);
  expect(decodeText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toBeNull();
  expect(decodeText(new Uint8Array([0xff, 0xfe, 0xfd, 0x80]))).toBeNull();
});

test("the viewer moving to another document is a step of its own, as opening and closing it are not alike", () => {
  const at = (view: string | null): Navigation => ({ project: null, task: "T1", taskAddress: null, full: false, pane: "files", path: "", query: "", image: null, view, event: null });
  const url = (view: string | null) => new URL(`http://x/?task=T1&tab=files${view ? `&view=${encodeURIComponent(view)}` : ""}`);
  const step = (from: string | null, to: string | null) => isStep(at(from), at(to), url(from), url(to));
  expect([step(null, "T1/a.md"), step("T1/a.md", "T1/b.yml"), step("T1/a.md", null), step("T1/a.md", "T1/a.md")]).toEqual([true, true, false, false]);
});

test("a Task's file read in the viewer copies with its Task; a code file by its absolute path; a diff's pages their own", () => {
  expect(["T151/samples/a.yml", "T150//repo/src/a.ts", "T151/diffs/x.diff"].map(address => viewerCopy(viewerTarget(address)!)))
    .toEqual(["T151/samples/a.yml", "/repo/src/a.ts", null]);
});
