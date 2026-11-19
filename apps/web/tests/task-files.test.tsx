import { expect, test } from "vitest";
import { fileShelves, folderSheet, folderOf, sheetOfFile, mediaSets, listFolder, pathExists, visibleFileMedia } from "../src/domain/task-files";
import { taskFileLink } from "../src/data/task-file-url";

const file = (name: string) => ({ name, size: 8, revision: "r", at: "2026-10-03T00:00:00.000Z" });

const shelve = (names: string[], artifact?: string[]) => fileShelves(
  { id: "T1", files: names.map(file), values: { values: artifact === undefined ? {} : { artifact }, fields: [], from: null, context: "" } },
  "/ws", "http://screen.test");
const names = (files: readonly { name: string }[]) => files.map(f => f.name);

test("the deliverables are the files the Deliverables field links, wherever they are, and the documents and media outside work/", () => {
  const shelves = shelve([
    "work/demo/phone.mp4", "work/demo/compare.png", "work/demo/README.md", "work/demo/log.txt", "work/notes.md",
    "report.md", "result.json", "run.log", "shots/a.png", "homework/a.md", "notes/work/b.md",
  ], [
    "[Moving sample](work/demo/phone.mp4) — the fix",
    "**[Before and after](work/demo/compare.png)**",
    "[Check](/ws/tasks/T1/work/demo/README.md) and again [Same check](work/demo/README.md)",
    "[Result](result.json)",
    "[PR](https://example.com/pr/1), [code](/home/me/repo/src/a.ts), [folder](work/demo/), [gone](work/missing.md), [other task](/ws/tasks/T2/x.md)",
  ]);
  expect(shelves.listed.map(item => [item.label, item.file.name])).toEqual([
    ["Moving sample", "work/demo/phone.mp4"], ["Before and after", "work/demo/compare.png"],
    ["Check", "work/demo/README.md"], ["Result", "result.json"],
  ]);
  expect(names(shelves.deliverables)).toEqual([
    "work/demo/phone.mp4", "work/demo/compare.png", "work/demo/README.md", "report.md", "result.json", "shots/a.png", "homework/a.md", "notes/work/b.md",
  ]);
  // The rest are the work files: work/ unlisted, and data and logs anywhere. Every file is on exactly one shelf.
  expect(names(shelves.work)).toEqual(["work/demo/log.txt", "work/notes.md", "run.log"]);
});

test("without a listed file, work files alone leave no deliverable; a folder link changes nothing", () => {
  const shelves = shelve(["work/log.txt", "work/plan.md", "step1.txt"], ["[Work](work/)"]);
  expect([shelves.listed, shelves.deliverables]).toEqual([[], []]);
  expect(names(shelves.work)).toEqual(["work/log.txt", "work/plan.md", "step1.txt"]);
  expect(shelve([], ["[Report](report.md)"])).toEqual({ listed: [], deliverables: [], work: [] });
});

test("a folder lists its deliverables, or its work files where it has none; a file opens over a list holding it", () => {
  const shelves = shelve(["work/sub/x.md", "work/y.log", "work/keep.md", "work/demo/a.png", "work/demo/b.log", "logs/r.log", "data/a.json", "data/b.md", "c.md"],
    ["[Keep](work/keep.md)", "[A](work/demo/a.png)"]);
  const sheet = (folder: string) => { const { work, files } = folderSheet(shelves, folder); return [work, names(files)]; };
  expect(sheet("")).toEqual([false, ["work/keep.md", "work/demo/a.png", "data/b.md", "c.md"]]);
  expect(sheet("work/")).toEqual([true, ["work/sub/x.md", "work/y.log", "work/demo/b.log", "logs/r.log", "data/a.json"]]);
  expect(sheet("work/demo/")).toEqual([false, ["work/demo/a.png"]]);
  expect(sheet("work/sub/")).toEqual([true, ["work/sub/x.md"]]);
  expect(sheet("data/")).toEqual([false, ["data/b.md"]]);
  expect(sheet("logs/")).toEqual([true, ["logs/r.log"]]);
  expect(["work/demo/a.png", "work/keep.md", "work/demo/b.log", "data/a.json", "logs/r.log"].map(name => sheetOfFile(shelves, name)))
    .toEqual(["work/demo/", "", "work/", "work/", "logs/"]);
});

test("a path names the Task folder, a folder, or a file", () => {
  const names = ["spec.md", "shots/a.png"];
  expect(pathExists("", names)).toBe(true);
  expect(pathExists("shots/", names)).toBe(true);
  expect(pathExists("shot/", names)).toBe(false);
  expect(pathExists("shots/a.png", names)).toBe(true);
  expect(folderOf("shots/a.png")).toBe("shots/");
  expect(folderOf("shots/")).toBe("shots/");
});

test("a folder lists its own files and its subfolders with counts", () => {
  const listing = listFolder("", [file("a.md"), file("shots/x.png"), file("shots/deep/y.png"), file("work/z.txt")].map(f => f));
  expect(listing.files.map(f => f.name)).toEqual(["a.md"]);
  expect(listing.folders).toEqual([{ path: "shots/", count: 2 }, { path: "work/", count: 1 }]);
});

test("images that differ only in light/dark and desktop/mobile (or a width) form one ordered set", () => {
  const sets = mediaSets(["login-mobile-dark.png", "login-desktop-light.png", "login-desktop-dark.png", "login-mobile-light.png",
    "tree-1100-light.png", "tree-390-light.png", "logo.png", "notes.md"].map(file));
  expect(sets.map(set => [set.label, set.items.map(item => item.file.name), set.varies])).toEqual([
    ["login", ["login-desktop-light.png", "login-desktop-dark.png", "login-mobile-light.png", "login-mobile-dark.png"], ["device", "theme"]],
    ["logo", ["logo.png"], []],
    ["tree", ["tree-1100-light.png", "tree-390-light.png"], ["device"]],
  ]);
});

test("the file sheet exposes every visible version in reading order", () => {
  const files = ["images/chart.png", "images/home-desktop-dark.png", "images/home-desktop-light.png", "work/draft.png"].map(file);
  expect(visibleFileMedia(folderSheet(shelve(files.map(f => f.name)), "").files).flatMap(set => set.items.map(item => item.file.name))).toEqual([
    "images/chart.png", "images/home-desktop-light.png", "images/home-desktop-dark.png",
  ]);
});

test("videos share the image sheet and comparison set, while documents stay out", () => {
  const files = ["files/demo.mp4", "files/demo.webm", "files/still.png", "files/notes.md"].map(file);
  expect(visibleFileMedia(files).flatMap(set => set.items.map(item => item.file.name))).toEqual([
    "files/demo.mp4", "files/demo.webm", "files/still.png",
  ]);
  expect(mediaSets(files).find(set => set.label === "demo")?.items).toHaveLength(2);
});

test("the same name in two folders is two sets", () => {
  const sets = mediaSets(["a/x-light.png", "a/x-dark.png", "b/x-light.png", "b/x-dark.png"].map(file));
  expect(sets.map(set => set.key)).toEqual(["a/x", "b/x"]);
});

test("only the names the skill gives make versions: -desktop/-mobile or a width, not pc/sp/phone", () => {
  const sets = mediaSets(["home-pc-light.png", "home-sp-light.png", "home-phone-dark.png", "card-desktop-light.png", "card-mobile-light.png"].map(file));
  expect(sets.find(set => set.label === "card")!.varies).toEqual(["device"]);
  // pc, sp and phone stay part of the name, so these are three sets of one.
  expect(sets.filter(set => set.label.startsWith("home")).map(set => set.items.length)).toEqual([1, 1, 1]);
});

test("the reading order gathers each folder's images that form no set where the first of them comes", () => {
  const files = ["button-before.png", "button-after.png", "huge-desktop-light.png", "login-desktop-light.png",
    "login-desktop-dark.png", "ref-one.png", "ref-two.png", "settings-light.png", "settings-dark.png",
    "shots/z.png", "shots/card-light.png", "shots/card-dark.png"].map(file);
  expect(visibleFileMedia(files).flatMap(set => set.single ? set.items.map(item => item.file.name) : [set.key])).toEqual(
    ["button", "huge-desktop-light.png", "ref-one.png", "ref-two.png", "login", "settings", "shots/card", "shots/z.png"]);
});

test("a link to a file opens it in a tab where a tab shows it, and saves the original where a tab cannot", () => {
  const link = (name: string, size: number) => taskFileLink("T1", { name, size, revision: "r" }, 1024);
  for (const [name, size] of [["notes.md", 1024], ["huge.gif", 4096]] as const)
    expect(link(name, size), name).toEqual({ href: expect.stringMatching(/&v=r$/), saves: false });
  for (const [name, size] of [["notes.md", 1025], ["voice.m4a", 8], ["clip.mp4", 8], ["large.pdf", 8], ["build", 8]] as const)
    expect(link(name, size), name).toEqual({ href: expect.stringMatching(/&v=r&download=1$/), saves: true });
});
