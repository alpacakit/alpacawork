/**
 * What is pressed while the page's own move is under way (a ×, by the Navigation API) applies once the browser is there,
 * to what is shown there, in the order it was pressed (lib/history.ts): a row, a reference, a link, a search, a
 * setting or a notice always; what acts on the reader as it was (its ×, ←, a row of its column, the move on after an
 * answer) not at all once the reader has closed. A person's own Back meanwhile stands over all of it. The cases run
 * with the browser's finished told after its popstate and before it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { startI18n } from "@alpacawork/i18n";
import { openScreenLink, useUrlBootstrap } from "../src/state/bootstrap";
import { closeImage, closeReaderStep } from "../src/state/history-step";
import { followReference, readerBack } from "../src/state/reader-position";
import { useCloseOnBack } from "../src/lib/close-on-back";
import { navigate, readerNow } from "../src/lib/history";
import { useEveryTaskIndex } from "../src/data/queries";
import { awaitedTask, useViewStore } from "../src/state/view-store";
import { useTimeView } from "../src/state/time-view";
import { queryClient } from "../src/data/query-client";
import { resources } from "../src/data/resources";
import { Workbench } from "../src/features/shell/Workbench";
import { useDialogStore } from "../src/state/dialog-store";
import { openInput } from "../src/state/open-input";
import { TestWorkspace, at, dto, historyFixture, homeFixture, logEntry, narrowScreen, screenData, searchAnswer, seedSearch, taskFixture, tree, userBall,
  viewsOf } from "./fixtures";
import { fakeNavigation, sessionHistory } from "./navigation-fake";

let transientOpen = false;
let setTransient: (open: boolean) => void;
function Bootstrap() {
  useUrlBootstrap(useEveryTaskIndex());
  const [open, setOpen] = useState(false); transientOpen = open; setTransient = setOpen;
  useCloseOnBack(open, () => setOpen(false));
  return null;
}
const file = (name: string) => ({ name, size: 10, at, revision: "r1" });
/** T1, T2 and T3 at work, each a row of the list's Working. */
const tasks = (files = true) => tree({ tasks: [dto({ id: "T1" }), dto({ id: "T2", files: files ? [file("a.md"), file("shot.png")] : [] }), dto({ id: "T3" })],
  home: homeFixture(["T1", "T2", "T3"].map((taskId) => ({ taskId, section: "doing" as const }))) });
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
const open = async (id: string) => { act(() => useViewStore.getState().openTask(id, { reader: true })); await flush(); };
const param = (key: string) => new URL(location.href).searchParams.get(key);
const back = () => act(async () => {
  const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
  history.back(); await done;
});
/** T2's address looked up already, as a URL or a notice opening it does. */
function resolvedT2(value = tasks()) {
  queryClient.setQueryData(resources.taskView("/fixture", "T2").queryKey, viewsOf(value)[1]);
}
/** The store shows the URL as it is: nothing of it ahead of the URL. */
function settled() {
  const { reader, selected } = useViewStore.getState();
  expect(param("task")).toBe(reader.open && selected ? selected : null);
}

let navigation: ReturnType<typeof fakeNavigation>;
const arrive = async (finishedFirst = false) => { await act(() => navigation.arrive(navigation.moves[0]!, { finishedFirst })); await flush(); };

beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear(); localStorage.clear(); history.replaceState(null, "", "/");
  useViewStore.setState(useViewStore.getInitialState()); useDialogStore.setState({ dialog: null });
  useTimeView.setState({ strips: false, viewMs: null, picked: null, hovered: null });
  sessionHistory(); navigation = fakeNavigation({ held: true });
});
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(value = tasks()) {
  const view = render(<TestWorkspace data={screenData(value)}><Bootstrap /></TestWorkspace>); await flush();
  await open("T1"); await open("T2");
  return view;
}

for (const finishedFirst of [false, true]) test(`× and then another task: that task stands once the browser is there, over the list${finishedFirst ? " (finished first)" : ""}`, async () => {
  await mount();
  act(() => closeReaderStep()); await open("T3");
  // Nothing of it is shown before the URL says it.
  expect(useViewStore.getState().selected).toBe("T2"); settled();
  await arrive(finishedFirst);
  expect(param("task")).toBe("T3"); settled();
  await back(); await flush();
  expect(param("task")).toBeNull(); settled();
});

test("× and then another task, with the task closed opened by its address: the address read again does not bring it back", async () => {
  resolvedT2(); await mount();
  act(() => closeReaderStep()); await open("T3");
  await arrive();
  expect(param("task")).toBe("T3"); settled();
});

test("× and then another task while the closed one's files change: the URL read again does not bring it back", async () => {
  const view = render(<TestWorkspace data={screenData(tasks())}><Bootstrap /></TestWorkspace>); await flush();
  await open("T1"); act(() => useViewStore.getState().openTaskFile("T2", "a.md")); await flush();
  act(() => closeReaderStep()); await open("T3");
  view.rerender(<TestWorkspace data={screenData(tasks(false))}><Bootstrap /></TestWorkspace>); await flush();
  await arrive();
  expect(param("task")).toBe("T3"); settled();
});

for (const outcome of ["there", "given up"] as const) test(`× and then a link to a search: the search stands, the move ${outcome}`, async () => {
  await mount();
  act(() => closeReaderStep()); act(() => openScreenLink("/?q=needle")); await flush();
  if (outcome === "there") await arrive();
  else { act(() => navigation.abortPending()); await flush(); }
  expect(param("q")).toBe("needle");
  expect(useViewStore.getState().query).toBe("needle");
  expect(useViewStore.getState().reader.open).toBe(false); settled();
});

test("× and then the search typed on: the list with the search, the reader not opened again", async () => {
  history.replaceState(null, "", "/?q=f"); await mount();
  act(() => closeReaderStep()); act(() => useViewStore.getState().setQuery("find")); await flush();
  await arrive();
  expect(param("q")).toBe("find");
  expect(useViewStore.getState().reader.open).toBe(false); settled();
});

test("× and then another task and the time strips: the URL, the screen and the saved setting say the same", async () => {
  history.replaceState(null, "", "/?strip=off"); await mount();
  act(() => closeReaderStep()); await open("T3");
  act(() => useTimeView.getState().setStrips(true)); await flush();
  await arrive();
  expect(param("task")).toBe("T3");
  expect(param("strip")).toBe("on");
  expect(useTimeView.getState().strips).toBe(true);
  expect(localStorage.getItem("alpacawork.screen.strip")).toBe("on");
});

test("× and then what acts on the reader as it was (×, Back, its row, a tab, the move on after an answer): nothing, the list stands", async () => {
  await mount();
  const length = history.length;
  act(() => closeReaderStep());
  act(() => {
    closeReaderStep();
    readerBack();
    useViewStore.getState().setEvent("log:T2:L1");
    useViewStore.getState().setReaderPane("about");
    useViewStore.getState().openTask("T3", { reader: true, turnSequence: true });
  });
  await arrive(); await flush();
  expect(param("task")).toBeNull();
  expect(param("event")).toBeNull();
  expect(history.length).toBe(length);
  settled();
});

test("× and then a reference pressed in the reader being closed: the place it was read at is not written onto the list", async () => {
  await mount();
  const content = document.createElement("div"); content.dataset.readerContent = "";
  const row = document.createElement("div"); row.dataset.reportKey = "log:T2:L1";
  const button = document.createElement("button"); button.dataset.taskReference = "T3";
  row.append(button); content.append(row); document.body.append(content);
  act(() => closeReaderStep());
  act(() => followReference(button, "T3", () => useViewStore.getState().openTask("T3", { reader: true })));
  await arrive();
  expect(param("task")).toBe("T3");
  await back(); await flush();
  expect(param("task")).toBeNull();
  expect(param("event")).toBeNull();
  expect((history.state as { readerPosition?: unknown }).readerPosition).toBeUndefined();
  content.remove();
});

for (const form of ["responsible", "move"] as const) test(`× and then the ${form} input of another task: it waits with that task's reader, and opens in it`, async () => {
  await mount();
  act(() => closeReaderStep());
  act(() => openInput({ form, taskId: "T3" }));
  expect(useDialogStore.getState().dialog).toBeNull();
  await arrive();
  expect(param("task")).toBe("T3");
  expect(useDialogStore.getState().dialog).toMatchObject({ form, taskId: "T3" });
});

for (const address of ["task"] as const) for (const operation of ["move", "next"] as const) test(`× back to a URL whose ${address} is still being looked up, and then the closed reader's ${operation === "move" ? "move input" : "move on after an answer"}: nothing, the screen shows the URL`, async () => {
  history.replaceState(null, "", `/?${address}=T999`);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  render(<TestWorkspace data={screenData(tasks())}><Bootstrap /></TestWorkspace>); await flush();
  // The URL's task or scope is shown waited for, from the first draw.
  expect(awaitedTask(useViewStore.getState())).toBe("T999");
  await open("T2");
  act(() => {
    closeReaderStep();
    if (operation === "move") openInput({ form: "move", taskId: "T2" });
    else useViewStore.getState().openTask("T3", { reader: true, turnSequence: true });
  });
  await arrive();
  // A URL opened straight on the task: × goes to its first step and writes it without the reader, as for a known task.
  expect(param("task")).toBeNull();
  expect(useViewStore.getState().selected).toBeNull();
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(useDialogStore.getState().dialog).toBeNull();
});

test("a link to a task still being looked up: the reader waits for it at once, nothing of the one it was pressed in stays, and × closes it", async () => {
  await mount();
  act(() => useViewStore.getState().setReaderPane("about"));
  act(() => openInput({ form: "move", taskId: "T2" }));
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  act(() => openScreenLink("/?task=T999&tab=files")); await flush();
  expect(param("task")).toBe("T999");
  expect(useViewStore.getState().selected).toBeNull();
  expect(awaitedTask(useViewStore.getState())).toBe("T999");
  expect(useViewStore.getState().reader.pane).toBe("files");
  expect(useDialogStore.getState().dialog).toBeNull();
  // What is written meanwhile keeps the task waited for, and what goes with it, in the URL.
  act(() => useViewStore.getState().setQuery("needle"));
  expect(param("task")).toBe("T999");
  expect(param("tab")).toBe("files");
  act(() => closeReaderStep());
  await arrive();
  expect(param("task")).toBeNull();
  expect(useViewStore.getState().reader.open).toBe(false);
});

for (const form of ["responsible", "move"] as const) test(`the browser there but its popstate yet to come, and then the closed reader's own ${form} input: nothing, the list stands`, async () => {
  await mount();
  act(() => closeReaderStep());
  // The browser stands on the list's entry and says finished; the reader is still the one it closes.
  void navigation.moves[0]!.finished.then(() => openInput({ form, taskId: "T2" }));
  await arrive(true); await flush();
  expect(param("task")).toBeNull();
  expect(useDialogStore.getState().dialog).toBeNull();
});

test("an action on the reader that ends later (a page of results still to come) opens nothing once the reader has moved on", async () => {
  await mount();
  const from = readerNow();
  await open("T3");
  act(() => navigate(() => useViewStore.getState().openTask("T1", { reader: true }), from));
  expect(param("task")).toBe("T3");
  // On the reader it began on, it goes on.
  const still = readerNow();
  act(() => navigate(() => useViewStore.getState().openTask("T1", { reader: true }), still));
  expect(param("task")).toBe("T1");
});

test("a picture's × and then the reader's: the picture closes, then the reader", async () => {
  await mount();
  act(() => useViewStore.getState().openTaskFile("T2", "shot.png")); await flush();
  act(() => { closeImage(); closeReaderStep(); });
  await arrive();
  expect(param("image")).toBeNull();
  expect(navigation.moves).toHaveLength(2);
  await act(() => navigation.arrive(navigation.moves[1]!)); await flush();
  expect(param("task")).toBeNull(); settled();
});

test("× and then a person's own Back: where Back went stands; what was pressed meanwhile and what is open for a moment go", async () => {
  await mount();
  act(() => setTransient(true));
  act(() => closeReaderStep()); await open("T3");
  await back(); await flush();
  expect(param("task")).toBe("T1");
  expect(useViewStore.getState().selected).toBe("T1");
  expect(transientOpen).toBe(false);
  // The move the person's Back gave up says nothing more.
  await flush();
  expect(param("task")).toBe("T1"); settled();
});

test("the page's own move keeps what is open for a moment, whichever the browser says first", async () => {
  await mount();
  act(() => setTransient(true));
  act(() => closeReaderStep());
  await arrive(true);
  expect(param("task")).toBeNull();
  expect(transientOpen).toBe(true);
});

test("only the history's owner writes the browser's history", () => {
  const src = join(__dirname, "../src");
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });
  const writers = files(src).filter((path) => /\b(pushState|replaceState|traverseTo|history\.(back|forward|go)|new PopStateEvent)\b/.test(readFileSync(path, "utf8")));
  expect(writers.map((path) => path.slice(src.length + 1))).toEqual(["lib/history.ts"]);
});

/** The real controls: the reader's ×, a link in its text, a row of the list, the search box, a notice. */
const head = () => fireEvent.click(document.querySelector("[data-reader-frame-buttons] > button:last-child")!);
async function workbench(value: ReturnType<typeof tasks>) {
  Element.prototype.getAnimations = () => [];
  const view = render(<TestWorkspace data={screenData(value)}><Workbench /></TestWorkspace>); await flush();
  await open("T1"); await open("T2");
  head();
  expect(navigation.moves).toHaveLength(1);
  return view;
}

for (const finishedFirst of [false, true]) test(`the reader's × and then a link to a search in its text: the search stands${finishedFirst ? " (finished first)" : ""}`, async () => {
  history.replaceState(null, "", "/?agent=1");
  Element.prototype.getAnimations = () => [];
  // The link is in T2's own text, read on its Context page.
  const view = render(<TestWorkspace data={screenData(tree({ tasks: [dto({ id: "T1" }), dto({ id: "T2", body: `[Search](${location.origin}/?q=needle)` }), dto({ id: "T3" })] }))}><Workbench /></TestWorkspace>); await flush();
  await open("T1"); await open("T2");
  act(() => useViewStore.getState().setReaderPane("about")); await flush();
  head();
  fireEvent.click(view.getByRole("link", { name: "Search" })); await flush();
  await arrive(finishedFirst);
  expect(param("q")).toBe("needle");
  expect(useViewStore.getState().query).toBe("needle");
});

test("the reader's × and then another task's row, the closed one opened by its address: that task is read", async () => {
  history.replaceState(null, "", "/?agent=1");
  const value = tasks(); resolvedT2(value);
  await workbench(value);
  fireEvent.click(document.querySelector('[data-read="T3"]')!); await flush();
  await arrive();
  expect(param("task")).toBe("T3");
  expect(document.querySelector("[data-reader-task-id]")?.textContent).toContain("T3");
});

test("the reader's × and then the search typed on: the reader closed, the search kept", async () => {
  history.replaceState(null, "", "/?agent=1&q=f");
  seedSearch("/fixture", "f", ["T1", "T2"]); seedSearch("/fixture", "find", ["T1", "T2"]);
  await workbench(tree({ tasks: [dto({ id: "T1" }), dto({ id: "T2" })] }));
  fireEvent.change(document.querySelector("[data-search-input]")!, { target: { value: "find" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  await arrive();
  expect(useViewStore.getState().query).toBe("find");
  expect(document.querySelector("[data-reader-mode]")).toBeNull();
});

for (const resolved of [false, true]) test(`the reader's × and then a notice of another task: that task is read${resolved ? " (the closed one opened by its address)" : ""}`, async () => {
  history.replaceState(null, "", "/?agent=1");
  const worker = new EventTarget();
  const was = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  try {
    const value = tasks(); if (resolved) resolvedT2(value);
    await workbench(value);
    act(() => worker.dispatchEvent(new MessageEvent("message", { data: { type: "open-task", task: "T3" } }))); await flush();
    await arrive();
    expect(param("task")).toBe("T3");
    expect(document.querySelector("[data-reader-task-id]")?.textContent).toContain("T3");
  } finally {
    cleanup();
    if (was) Object.defineProperty(navigator, "serviceWorker", was); else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  }
});

test("the reader's × and then its approve control: nothing, the list stands", async () => {
  history.replaceState(null, "", "/?agent=1");
  // T2 waits for the reader's review: its ✔ stands at the reader's foot.
  await workbench(tree({ tasks: [dto({ id: "T1" }), taskFixture({ id: "T2", state: "waiting", log: [logEntry({ kind: "reported", toState: "waiting" })],
    ball: userBall("review", "L1", at, { aboutRunId: "R1" }) }), dto({ id: "T3" })] }));
  fireEvent.click(document.querySelector("[data-task-done]")!); await flush();
  await arrive();
  expect(param("task")).toBeNull();
  expect(useDialogStore.getState().dialog).toBeNull();
});

test("a phone's sheet held by its header and gone by Back: the press ends with it", async () => {
  const narrow = narrowScreen(true);
  history.replaceState(null, "", "/?agent=1");
  try {
    Element.prototype.getAnimations = () => [];
    render(<TestWorkspace data={screenData(tasks())}><Workbench /></TestWorkspace>); await flush();
    await open("T1");
    const down = new Event("pointerdown", { bubbles: true }); Object.assign(down, { isPrimary: true, button: 0, pointerId: 1, clientY: 300 });
    fireEvent(document.querySelector("aside[data-reader-mode] header")!, down);
    await back(); await flush();
    expect(param("task")).toBeNull();
    const errors: string[] = [];
    const collect = (event: ErrorEvent) => { errors.push(event.message); event.preventDefault(); };
    addEventListener("error", collect);
    try {
      for (const [type, y] of [["pointermove", 200], ["pointerup", 200]] as const) {
        const event = new Event(type, { bubbles: true }); Object.assign(event, { pointerId: 1, clientY: y }); window.dispatchEvent(event);
      }
    } finally { removeEventListener("error", collect); }
    expect(errors).toEqual([]);
  } finally { narrow.restore(); }
});
