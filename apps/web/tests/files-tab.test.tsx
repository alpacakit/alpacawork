import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import type { TaskDetail } from "../src/data/types";
import { ImageSlider, type SliderImage } from "../src/features/reader/ImageSlider";
import { FilesTab } from "../src/features/reader/files/FilesTab";
import { ReaderEntries } from "../src/features/reader/ReaderEntries";
import { MarkdownBody } from "../src/features/reader/MarkdownBody";
import { fileShelves } from "../src/domain/task-files";
import { fieldCatalog, renderContext } from "@alpacawork/contract";
import { TestWorkspace, dto, screenData, tree, valuesView } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const file = (name: string) => ({ name, size: 8, revision: "r", at: "2026-10-03T00:00:00.000Z" });
const sheet = (names: string[], artifact?: string[], path = "") => {
  const data = screenData(tree({ tasks: [dto()] }));
  const files = names.map(file);
  const task = { ...data.tasks[0]!, values: valuesView(artifact ? { artifact } : {}), body: "", logs: [], files, requestHeads: [], extractRows: {}, reply: undefined } as TaskDetail;
  return render(<TestWorkspace data={data}><ReaderEntries task={data.tasks[0]!} detail={task} pane="task" /><FilesTab task={task} path={path} /></TestWorkspace>);
};
const tab = () => document.querySelector<HTMLElement>('[data-reader-entry="files"]');

test("the tab, the first chip and the first list count the same deliverables; work files are listed apart", () => {
  sheet(["work/demo.webm", "work/log.txt", "report.md", "run.log"], ["[Moving sample](work/demo.webm) — the fix"]);
  expect(tab()!.getAttribute("aria-label")).toBe("Files 2");
  expect(screen.getByRole("button", { name: /^Deliverables\s*2$/ })).toBeTruthy();
  // The listed file leads under its written name; the work files are not on this list.
  const rows = [...document.querySelectorAll("[data-file-row]")].map(row => row.getAttribute("data-file-row"));
  expect(rows).toEqual(["work/demo.webm", "report.md"]);
  expect(screen.getByRole("button", { name: "Moving sample" }).textContent).toContain("work/demo.webm");
  expect(screen.getByRole("button", { name: /^Work files\s*2$/ })).toBeTruthy();
  cleanup();
  sheet(["work/demo.webm", "work/log.txt", "report.md", "run.log"], ["[Moving sample](work/demo.webm)"], "work/");
  expect([...document.querySelectorAll("[data-file-row]")].map(row => row.getAttribute("data-file-row"))).toEqual(["work/log.txt", "run.log"]);
});

test("the Deliverables field lists the files its Context drawing links, named as drawn", () => {
  const data = screenData(tree({ tasks: [dto()] }));
  const files = [file("work/result.json"), file("work/shot.png"), file("public.png")];
  const here = `${location.origin}/?task=T1&tab=files&view=T1%2Fwork%2Fresult.json`;
  // Each item alone, one per kind of node: whether the Context draws a link to the work file, and its Files row's name.
  const rows: [string, string, string | null][] = [
    ["[A &amp; B](work/result.json)", "work/result.json", "A & B"],
    ['<a href="work/result.json">Result</a>', "work/result.json", "Result"],
    ["`work/result.json` — the data", "work/result.json", "result.json"],
    [`${here} — on this screen`, "work/result.json", "result.json"],
    ["**[Bold](work/result.json)**", "work/result.json", "Bold"],
    ['<img src="work/shot.png" alt="Shot">', "work/shot.png", "Shot"],
    ['<a href="https://example.com/pr/1"><img src="work/shot.png" alt="Pic"></a>', "work/shot.png", "Pic"],
    ["<!-- [Internal](work/result.json) -->", "work/result.json", null],
    ["[**Not a link**](work/result.json)", "work/result.json", null],
    ["<code>work/result.json</code> as written", "work/result.json", null],
    ["[see work/result.json](https://example.com/pr/1)", "work/result.json", null],
    // An image's words are its label: the tree under them is not drawn.
    ['![<img src="work/shot.png">](public.png)', "work/shot.png", null],
  ];
  for (const [item, target, name] of rows) {
    const task = { ...data.tasks[0]!, values: valuesView({ artifact: [item] }), body: "", logs: [], files, requestHeads: [], extractRows: {}, reply: undefined } as TaskDetail;
    render(<TestWorkspace data={data}><MarkdownBody task={task} text={renderContext(["artifact"], { artifact: [item] }, fieldCatalog([]))} onFollow={() => {}} /></TestWorkspace>);
    const drawn = document.querySelectorAll(`a[title="${target}"], img[src*="path=${encodeURIComponent(target)}&"]`).length > 0;
    const listed = fileShelves(task, "/fixture", location.origin).listed.filter(each => each.file.name === target).map(each => each.label);
    expect([item, drawn, listed], item).toEqual([item, name !== null, name === null ? [] : [name]]);
    cleanup();
  }
});

test("work files alone show the tab without a number and lead to them; no file shows no tab", () => {
  sheet(["work/log.txt"]);
  expect(tab()!.getAttribute("aria-label")).toBeNull();
  expect(screen.getByText(i18n.t("reader:files.onlyWork"))).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Work files\s*1$/ })).toBeTruthy();
  cleanup();
  sheet([]);
  expect(tab()).toBeNull();
});

test("images in no set are named Other only beside a set; alone they are just the images", () => {
  sheet(["shots/a.png", "shots/b.png"]);
  expect(screen.getByText(i18n.t("reader:files.images"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("reader:files.otherMedia"))).toBeNull();
  cleanup();
  sheet(["shots/a.png", "shots/card-light.png", "shots/card-dark.png"]);
  expect(screen.getByText(i18n.t("reader:files.otherMedia"))).toBeTruthy();
});

test("a set of versions shows one time, its newest; a picture in no set shows its own", () => {
  const data = screenData(tree({ tasks: [dto()] }));
  const at = (name: string, minute: number) => ({ ...file(name), at: `2026-10-03T00:${String(minute).padStart(2, "0")}:00.000Z` });
  const files = [at("shots/card-light.png", 1), at("shots/card-dark.png", 2), at("shots/a.png", 3)];
  const task = { ...data.tasks[0]!, values: valuesView({}), body: "", logs: [], files, requestHeads: [], extractRows: {}, reply: undefined } as TaskDetail;
  render(<TestWorkspace data={data}><FilesTab task={task} path="" /></TestWorkspace>);
  expect([...document.querySelectorAll("section time")].map(time => time.getAttribute("datetime")))
    .toEqual(["2026-10-03T00:03:00.000Z", "2026-10-03T00:02:00.000Z"]);
});

test("the file sheet gives every visible image one slide with set and version captions", () => {
  sheet(["shots/chart.png", "shots/home-desktop-light.png", "shots/home-desktop-dark.png", "shots/home-mobile-light.png"]);
  fireEvent.click(screen.getByRole("button", { name: "home-desktop-light.png" }));
  expect(screen.getByRole("dialog", { name: /home desktop light/i })).toBeTruthy();
  expect(screen.getByText("2 of 4")).toBeTruthy();
  expect(screen.getByText(/home desktop light/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(screen.getByText(/home desktop dark/i)).toBeTruthy();
});

test("an image over the attachment limit opens like any other, and a sound plays in the browser's player or leads to its original", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const data = screenData(tree({ tasks: [dto()], attachmentBytes: 1024 * 1024 }));
  const files = [{ ...file("swipe.gif"), size: 5 * 1024 * 1024 }, { ...file("voice.m4a"), size: 5 * 1024 * 1024 }];
  const task = { ...data.tasks[0]!, body: "", logs: [], files, requestHeads: [], extractRows: {}, reply: undefined } as TaskDetail;
  render(<TestWorkspace data={data}><FilesTab task={task} path="" /></TestWorkspace>);
  expect(screen.getByText(i18n.t("reader:files.media"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "swipe.gif" }));
  expect(screen.getByRole("img", { name: "swipe.gif" }).getAttribute("src")).toMatch(/path=swipe\.gif&v=r$/);
  expect(screen.getByRole("link", { name: "Open original image swipe.gif in a new tab" }).getAttribute("target")).toBe("_blank");
  fireEvent.click(screen.getByRole("button", { name: "Next item" }));
  const audio = screen.getByRole("dialog", { name: "voice.m4a" }).querySelector("audio[controls]")!;
  expect(audio.getAttribute("src")).toMatch(/path=voice\.m4a&v=r$/);
  expect(screen.getByRole("link", { name: "Save original file voice.m4a" }).getAttribute("href")).toMatch(/&download=1$/);
  fireEvent.error(audio);
  expect(screen.getByText("Audio unavailable: voice.m4a")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Save original file voice.m4a" }).getAttribute("href")).toMatch(/path=voice\.m4a&v=r&download=1$/);
});

test("two broken images stay unavailable when moving back and forth", () => {
  sheet(["shots/a.png", "shots/b.png"]);
  fireEvent.click(screen.getByRole("button", { name: "a.png" }));
  fireEvent.error(document.querySelector("[data-image-slider-large]")!);
  expect(screen.getByText(/Image unavailable: a.png/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  fireEvent.error(document.querySelector("[data-image-slider-large]")!);
  expect(screen.getByText(/Image unavailable: b.png/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
  expect(document.querySelector("[data-image-slider-large]")).toBeNull();
  expect(screen.getByText(/Image unavailable: a.png/)).toBeTruthy();
});

test("video opens in the same slider and stops when the next image is selected", () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  sheet(["shots/clip.webm", "shots/still.png"]);
  expect(screen.getByText(i18n.t("reader:files.media"))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "clip.webm" }));
  const viewer = screen.getByRole("dialog", { name: "clip.webm" });
  expect(viewer.querySelector("video:not([controls])")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Next item" }));
  expect(screen.getByText("2 of 2")).toBeTruthy();
  expect(pause).toHaveBeenCalled();
});

test("a slider decode failure returns focus from the removed seek to the viewer", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  sheet(["clip.webm", "still.png"]);
  fireEvent.click(screen.getByRole("button", { name: "clip.webm" }));
  const dialog = screen.getByRole("dialog", { name: "clip.webm" });
  const video = dialog.querySelector("video")!;
  Object.defineProperty(video, "duration", { value: 10, configurable: true });
  fireEvent.loadedMetadata(video);
  screen.getByRole("slider", { name: "Playback position" }).focus();
  fireEvent.error(video);
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  expect(screen.getByText("Video unavailable: clip.webm")).toBeTruthy();
  expect(screen.queryByRole("slider")).toBeNull();
});

test("an undecodable video poster shows an error instead of a play badge", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  sheet(["clip.webm"]);
  const button = screen.getByRole("button", { name: "clip.webm" });
  fireEvent.error(button.querySelector("video")!);
  expect(button.querySelector("[data-video-error]")).toBeTruthy();
  expect(button.textContent).not.toContain("▶");
});


test("the viewer hands focus back when a source or disabled input removes its owner, without stealing another control", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const item: SliderImage = { id: "clip", path: "clip.webm", alt: "clip", src: "clip.webm?v=1" };
  const select = vi.fn(), close = vi.fn();
  const view = render(<ImageSlider images={[item]} active={0} select={select} close={close} />);
  const dialog = screen.getByRole("dialog", { name: "clip" });
  const load = () => { const video = dialog.querySelector("video")!; Object.defineProperty(video, "duration", { configurable: true, value: 10 }); fireEvent.loadedMetadata(video); return video; };
  load(); screen.getByRole("slider", { name: "Playback position" }).focus();
  view.rerender(<ImageSlider images={[{ ...item, src: "clip.webm?v=2" }]} active={0} select={select} close={close} />);
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  const video = load(); screen.getByRole("slider", { name: "Playback position" }).focus();
  Object.defineProperty(video, "duration", { configurable: true, value: Infinity }); fireEvent.durationChange(video);
  await waitFor(() => expect(document.activeElement).toBe(dialog));
  const other = dialog.querySelector<HTMLButtonElement>("[data-image-slider-close]")!; other.focus();
  view.rerender(<ImageSlider images={[{ ...item, src: "clip.webm?v=3", showable: false }]} active={0} select={select} close={close} />);
  await waitFor(() => expect(screen.queryByRole("slider")).toBeNull());
  expect(document.activeElement).toBe(other);
});
