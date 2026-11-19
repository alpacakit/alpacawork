import { viewsOf, searchAnswer } from './fixtures';
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { readerWidth } from "../src/state/screen-settings";
import { Workbench } from "../src/features/shell/Workbench";
import { useViewStore } from "../src/state/view-store";
import { useDialogStore } from "../src/state/dialog-store";
import { draftKey, useDraftStore } from "../src/features/forms/draft-store";
import { TestWorkspace, at, dto, screenData, tree } from "./fixtures";
import { seedDraft } from "./draft-fixture";
import { indexTasks } from "../src/domain/tasks";
import { queryClient } from "../src/data/query-client";
import { resources } from "../src/data/resources";

const workspace = () => screenData(tree({ tasks: [
  dto({ id: "T1", title: "Parent" }),
  dto({ id: "T11", parentId: "T1", path: "tasks/T11", title: "Child" }),
  dto({ id: "T111", parentId: "T11", path: "tasks/T111", title: "Grandchild" }),
] }));
const mount = () => render(<TestWorkspace data={workspace()}><Workbench /></TestWorkspace>);
const flush = async () => act(async () => { await Promise.resolve(); });

beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear();
  history.replaceState(null, "", "/");
  useViewStore.setState(useViewStore.getInitialState());
  useDialogStore.setState({ dialog: null });
  useDraftStore.setState({ entries: {}, unavailable: false });
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("one open action writes one entry, while tab and search edits replace", async () => {
  mount();
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  await flush();
  expect(new URL(location.href).searchParams.get("task")).toBe("T1");
  expect(push).toHaveBeenCalledTimes(1);
  act(() => useViewStore.getState().setReaderPane("task"));
  await flush();
  expect(new URL(location.href).searchParams.get("tab")).toBeNull();
  expect(push).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
  act(() => useViewStore.getState().openTask("T1", { pane: "task", reader: true }));
  await flush();
  expect(push).toHaveBeenCalledTimes(1);
  act(() => useViewStore.getState().setQuery("one"));
  await flush();
  act(() => useViewStore.getState().setQuery("two"));
  await flush();
  expect(push).toHaveBeenCalledTimes(2);
  expect(new URL(location.href).searchParams.get("q")).toBe("two");
});

test("shared URL and popstate apply a validated snapshot without writing it back as a step", async () => {
  history.replaceState(null, "", "/?task=T11&tab=task&q=Child");
  mount();
  expect(useViewStore.getState()).toMatchObject({ selected: "T11", query: "Child",
    reader: { open: true, pane: "task" } });
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T998&tab=rule:missing&q=kept");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: {
    code: "not_found", message: "No task", retry: "fix",
  } }), { status: 404, headers: { "Content-Type": "application/json" } }));
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await waitFor(() => expect(useViewStore.getState()).toMatchObject({ selected: null, query: "kept",
    reader: { open: false } }));
  expect([...new URL(location.href).searchParams]).toEqual([["q", "kept"]]);
  expect(push).not.toHaveBeenCalled();
  // The step is written over as the URL is read: its addresses kept while looked up, then left out once missing.
  expect(replace.mock.calls.length).toBeLessThanOrEqual(2);
});

test("a direct link survives a temporary address lookup failure", async () => {
  history.replaceState(null, "", "/?task=T999");
  const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  mount();
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  await flush();
  expect(new URL(location.href).searchParams.get("task")).toBe("T999");
});

test("URL mode never overwrites the saved partial width", async () => {
  vi.stubGlobal("innerWidth", 1440);
  history.replaceState(null, "", "/?task=T1&width=full");
  mount();
  expect(document.querySelector("[data-reader-mode='overlay']")).toBeTruthy();
  expect(useViewStore.getState().readerFull).toBe(true);
  expect(localStorage.getItem("alpacawork.screen.width")).toBeNull();
  const push = vi.spyOn(history, "pushState");
  act(() => useViewStore.getState().setReaderFull(false));
  await flush();
  expect(document.querySelector("[data-reader-mode='docked']")).toBeTruthy();
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
  act(() => useViewStore.getState().setReaderWidth("full"));
  await flush();
  expect(new URL(location.href).searchParams.get("width")).toBe("full");
  expect(localStorage.getItem("alpacawork.screen.width")).toBeNull();
  expect(push).not.toHaveBeenCalled();
  act(() => useViewStore.getState().setReaderWidth(500));
  await flush();
  expect(document.querySelector("[data-reader-mode='docked']")).toBeTruthy();
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
  expect(localStorage.getItem("alpacawork.screen.width")).toBe("500");
});

test("full width without a task is ignored; back and forward restore each detail width", async () => {
  history.replaceState(null, "", "/?width=full");
  mount();
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
  expect(useViewStore.getState().readerFull).toBe(false);
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1&width=full");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().readerFull).toBe(true);
  expect(document.querySelector("[data-reader-mode='overlay']")).toBeTruthy();
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().readerFull).toBe(false);
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1&width=full");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  await flush();
  expect(useViewStore.getState().readerFull).toBe(true);
});

test("the URL alone chooses mode while device storage supplies the partial width", async () => {
  localStorage.setItem("alpacawork.screen.width", "976");
  history.replaceState(null, "", "/?task=T1&width=1234&agent=1&event=log:test");
  mount();
  expect(document.querySelector("[data-reader-mode='docked']")).toBeTruthy();
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
  expect(new URL(location.href).searchParams.get("agent")).toBe("1");
  expect(new URL(location.href).searchParams.get("event")).toBe("log:test");
  expect(readerWidth.get()).toBe(976);
  act(() => useViewStore.getState().setReaderFull(true));
  act(() => useViewStore.getState().setReaderFull(false));
  expect(readerWidth.get()).toBe(976);
});

test("an unknown rule tab is repaired in place", () => {
  const value = tree({ tasks: [dto({ files: [
    { name: "report.md", size: 8, revision: "a".repeat(64), at },
  ] })] });
  const shared = screenData(value);
  history.replaceState(null, "", "/?task=T1&tab=rule%3Agoal");
  render(<TestWorkspace data={shared}><Workbench /></TestWorkspace>);
  expect(useViewStore.getState().reader.pane).toBe("task");
  expect(new URL(location.href).searchParams.get("tab")).toBeNull();
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1&tab=rule%3Agone");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().reader.pane).toBe("task");
  expect(new URL(location.href).searchParams.get("tab")).toBeNull();
});

test("navigation away and back keeps a stored draft", () => {
  const key = draftKey("/fixture", "project", null);
  seedDraft(key, { values: { name: "Unsent", cwd: "", parent: "" } });
  history.replaceState(null, "", "/?task=T1");
  mount();
  act(() => useViewStore.getState().openTask("T11", { reader: true }));
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useDraftStore.getState().entries[key]?.values.name).toBe("Unsent");
});

test("a task followed from the open reader stays open: the URL is read once the store's navigation is written", async () => {
  // The page was opened on T1's address, looked up from the server (as a task not in the list first is).
  history.replaceState(null, "", "/?task=T1");
  queryClient.setQueryData(resources.taskView("/fixture", "T1").queryKey, () => ({ ...viewsOf(tree({ tasks: [dto({ id: 'T1' })] })).find(view => view.task.id === 'T1')!, resolved: { row: searchAnswer(['T1']).rows[0]!, ancestors: [] } }));
  mount();
  await flush();
  expect(useViewStore.getState().selected).toBe("T1");
  // A reference pressed in T1's report: the press's own render runs the URL's repair before the URL is written.
  act(() => useViewStore.getState().openTask("T11", { reader: true }));
  await flush();
  await flush();
  expect(useViewStore.getState().selected).toBe("T11");
  expect(new URL(location.href).searchParams.get("task")).toBe("T11");
});

test("the Files tab keeps its folder path while image slides replace one history entry", async () => {
  const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
  const data = screenData(tree({ tasks: [dto({ files: [file("spec.md"), file("shots/a-light.png"), file("shots/a-dark.png"), file("work/log.txt")] })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&path=shots%2F");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  expect(useViewStore.getState().filePath).toEqual({ taskId: "T1", path: "shots/" });
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  act(() => useViewStore.getState().setImage("shots/a-light.png"));
  await flush();
  expect(new URL(location.href).searchParams.get("path")).toBe("shots/");
  expect(new URL(location.href).searchParams.get("image")).toBe("shots/a-light.png");
  expect(push).toHaveBeenCalledTimes(1);
  act(() => useViewStore.getState().setImage("shots/a-dark.png"));
  await flush();
  expect(push).toHaveBeenCalledTimes(1);
  expect(replace).toHaveBeenCalledTimes(1);
  act(() => useViewStore.getState().setImage(null));
  await flush();
  expect(new URL(location.href).searchParams.get("image")).toBeNull();
  // A path that names nothing in the task is dropped from the entry.
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1&tab=files&path=gone.png");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect([useViewStore.getState().filePath?.path, useViewStore.getState().image]).toEqual(["", null]);
  expect([...new URL(location.href).searchParams.keys()]).toEqual(["task", "tab"]);
});

test("the work files' sheet opens from the URL when every work file lies outside work/", () => {
  const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
  const data = screenData(tree({ tasks: [dto({ files: [file("report.md"), file("run.log")] })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&path=work%2F");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  expect(useViewStore.getState().filePath).toEqual({ taskId: "T1", path: "work/" });
});

test("a listed picture in work/ opens in the slider from its folder's URL, and from the shared one over the deliverables", async () => {
  const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
  const data = screenData(tree({ tasks: [dto({ files: [file("work/demo/shot.png"), file("work/sample.png"), file("work/log.txt")],
    values: { artifact: ["[Shot](work/demo/shot.png)", "[Sample](work/sample.png)"] } })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&path=work%2Fdemo%2F&image=work%2Fdemo%2Fshot.png");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  expect([useViewStore.getState().filePath?.path, useViewStore.getState().image]).toEqual(["work/demo/", "work/demo/shot.png"]);
  await waitFor(() => expect(document.querySelector("[data-image-slider-modal]")).toBeTruthy());
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1&tab=files&path=work%2F&image=work%2Fsample.png");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect([useViewStore.getState().filePath?.path ?? "", useViewStore.getState().image]).toEqual(["", "work/sample.png"]);
});

test("with a document open beside the Files tab, its chips still move to their lists", async () => {
  const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
  const data = screenData(tree({ tasks: [dto({ files: [file("notes.md"), file("data/report.md"), file("data/a.json"), file("work/demo/log.txt")] })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&view=T1%2Fnotes.md");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  const chip = (path: string) => document.querySelector<HTMLElement>(`[data-files-chip="${path}"]`)!;
  await waitFor(() => expect(chip("work/")).toBeTruthy());
  for (const path of ["work/", "data/"]) {
    act(() => chip(path).click());
    await flush();
    expect([useViewStore.getState().filePath?.path, useViewStore.getState().view]).toEqual([path, "T1/notes.md"]);
  }
});

test("a direct file image URL keeps only a picture the task holds", () => {
  const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
  const data = screenData(tree({ tasks: [dto({ files: [file("shots/a.png"), file("other/b.png")] })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&path=shots%2F&image=shots%2Fa.png");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  expect(useViewStore.getState().image).toBe("shots/a.png");
  expect(useViewStore.getState().filePath).toEqual({ taskId: "T1", path: "shots/" });
  history.replaceState(null, "", "/?task=T1&tab=files&path=shots%2F&image=other%2Fgone.png");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().image).toBeNull();
  expect(new URL(location.href).searchParams.get("image")).toBeNull();
});

test("a link naming a file as the Files tab's path, as links were written before, opens the file as it opens now", () => {
  const file = (name: string) => ({ name, size: 8, revision: "a".repeat(64), at });
  const data = screenData(tree({ tasks: [dto({ files: [file("docs/a.md"), file("shots/a.png")] })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&path=docs%2Fa.md");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  expect([useViewStore.getState().filePath?.path, useViewStore.getState().view]).toEqual(["docs/", "T1/docs/a.md"]);
  expect(location.search).toBe("?task=T1&tab=files&path=docs%2F&view=T1%2Fdocs%2Fa.md");
  history.replaceState(null, "", "/?task=T1&tab=files&path=shots%2Fa.png");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect([useViewStore.getState().filePath?.path, useViewStore.getState().image, useViewStore.getState().view]).toEqual(["shots/", "shots/a.png", null]);
});

test("a diff opened over the Task's own body (About) stays open when the URL is read again", () => {
  history.replaceState(null, "", "/?task=T1&tab=about&view=T1%2Fdiffs%2Fa.diff");
  render(<TestWorkspace data={workspace()}><Workbench /></TestWorkspace>);
  expect([useViewStore.getState().reader.pane, useViewStore.getState().view]).toEqual(["about", "T1/diffs/a.diff"]);
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().view).toBe("T1/diffs/a.diff");
  expect(new URL(location.href).searchParams.get("view")).toBe("T1/diffs/a.diff");
});

test("an image inside the Task files/ folder keeps its actual relative name", () => {
  const file = { name: "files/pic.png", size: 8, revision: "a".repeat(64), at };
  const data = screenData(tree({ tasks: [dto({ files: [file] })] }));
  history.replaceState(null, "", "/?task=T1&tab=files&path=files%2F&image=files%2Fpic.png");
  render(<TestWorkspace data={data}><Workbench /></TestWorkspace>);
  expect(useViewStore.getState().image).toBe("files/pic.png");
  expect(useViewStore.getState().filePath).toEqual({ taskId: "T1", path: "files/" });
});

test("reader width saves its displayed limits and reset clears the preference", () => {
  mount();
  for (const [viewport, requested, expected] of [[1440, -100, 420], [1440, 5000, 1284], [2560, 5000, 2292], [1024, 5000, 868], [900, 5000, 744], [701, 5000, 545]] as const) {
    vi.stubGlobal("innerWidth", viewport);
    act(() => useViewStore.getState().setReaderWidth(requested));
    expect(readerWidth.get()).toBe(expected);
    expect(new URL(location.href).searchParams.get("width")).toBeNull();
    expect(localStorage.getItem("alpacawork.screen.width")).toBe(String(expected));
  }
  act(() => useViewStore.getState().setReaderWidth(null));
  expect(readerWidth.get()).toBeNull();
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
  expect(localStorage.getItem("alpacawork.screen.width")).toBeNull();
});

test("partial resize never writes history and navigation always uses the latest device width", async () => {
  vi.stubGlobal("innerWidth", 1440);
  history.replaceState(null, "", "/?task=T1&agent=1&event=log:kept");
  mount();
  const push = vi.spyOn(history, "pushState"), replace = vi.spyOn(history, "replaceState");
  act(() => useViewStore.getState().setReaderWidth(852));
  await flush();
  expect(push).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
  expect(new URL(location.href).searchParams.get("event")).toBe("log:kept");
  act(() => useViewStore.getState().openTask("T11", { reader: true }));
  act(() => useViewStore.getState().setReaderWidth(976));
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T1&width=full&agent=1");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().readerFull).toBe(true);
  expect(readerWidth.get()).toBe(976);
  history.replaceState({ alpacaworkNavigation: 1 }, "", "/?task=T11&agent=1");
  act(() => window.dispatchEvent(new PopStateEvent("popstate")));
  expect(useViewStore.getState().readerFull).toBe(false);
  expect(document.querySelector<HTMLElement>("[data-page]")!.style.getPropertyValue("--window-fit")).toBe("976px");
  localStorage.setItem("alpacawork.screen.width", "1200");
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "alpacawork.screen.width" })));
  expect(document.querySelector<HTMLElement>("[data-page]")!.style.getPropertyValue("--window-fit")).toBe("1200px");
  act(() => { vi.stubGlobal("innerWidth", 900); window.dispatchEvent(new Event("resize")); });
  expect(document.querySelector<HTMLElement>("[data-page]")!.style.getPropertyValue("--window-fit")).toBe("744px");
  expect(readerWidth.get()).toBe(1200);
});

test("a refused width write remains usable in this visit without leaking into the URL", () => {
  vi.stubGlobal("innerWidth", 1440);
  readerWidth.remove();
  history.replaceState(null, "", "/?task=T1");
  mount();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  act(() => useViewStore.getState().setReaderWidth(852));
  act(() => useViewStore.getState().setReaderFull(true));
  act(() => useViewStore.getState().setReaderFull(false));
  expect(readerWidth.get()).toBe(852);
  expect(document.querySelector<HTMLElement>("[data-page]")!.style.getPropertyValue("--window-fit")).toBe("852px");
  expect(new URL(location.href).searchParams.get("width")).toBeNull();
});
