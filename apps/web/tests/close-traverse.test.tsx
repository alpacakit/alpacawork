/**
 * Closing the reader goes to the step before the one that opened it, by the Navigation API: the browser goes
 * there by its key and says when it is there, so nothing is counted, guessed or waited for. Without the API, or with
 * that step gone from the browser, the current step is written over: the reader closes, and Back may show what it
 * showed before.
 */
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { startI18n } from "@alpacawork/i18n";
import { useUrlBootstrap } from "../src/state/bootstrap";
import { closeAnalysisLayer, closeReaderStep, surfacesOf } from "../src/state/history-step";
import { openAutomation } from "../src/features/automations/open";
import { openAnalysis } from "../src/features/analysis/open";
import { analysisHome } from "../src/features/analysis/place";
import { useCloseOnBack } from "../src/lib/close-on-back";
import { useEveryTaskIndex } from "../src/data/queries";
import { useViewStore } from "../src/state/view-store";
import { useOpenFromNotification } from "../src/data/push";
import { queryClient } from "../src/data/query-client";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";
import { fakeNavigation, sessionHistory } from "./navigation-fake";

let transientOpen = false;
let setTransient: (open: boolean) => void;
function Bootstrap() {
  useUrlBootstrap(useEveryTaskIndex());
  useOpenFromNotification(useEveryTaskIndex());
  const [open, setOpen] = useState(false); transientOpen = open; setTransient = setOpen;
  useCloseOnBack(open, () => setOpen(false));
  return null;
}
const mount = () => render(<TestWorkspace data={screenData(tree({ tasks: [dto({ id: "T1" }), dto({ id: "T2" }), dto({ id: "T3" })] }))}><Bootstrap /></TestWorkspace>);
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const open = async (id: string) => { act(() => useViewStore.getState().openTask(id, { reader: true })); await wait(5); };
const closed = () => !useViewStore.getState().reader.open && !new URL(location.href).searchParams.has("task");
const back = () => act(async () => {
  const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
  history.back(); await done;
});

beforeAll(() => startI18n());
beforeEach(() => { queryClient.clear(); history.replaceState(null, "", "/"); useViewStore.setState(useViewStore.getInitialState()); });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("the list, A, then B, then ×: the browser goes to the list's step, so Back has nothing of A or B to open", async () => {
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
  expect(session._currentIndex).toBe(0);
});

test("an automation opened over the home stands in the reader's window: × goes back to the step before, the home as it was", async () => {
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  act(() => openAutomation("A16")); await wait(5);
  expect([useViewStore.getState().automation?.id, useViewStore.getState().automations, new URL(location.href).searchParams.get("automation")]).toEqual(["A16", null, "A16"]);
  expect(surfacesOf(location.search)).toEqual(["automation:A16"]);
  act(() => closeReaderStep()); await wait(20);
  expect([useViewStore.getState().automation, new URL(location.href).searchParams.has("automation"), session._currentIndex]).toEqual([null, false, 0]);
});

test("a task opened from an automation's window takes its place, and Back shows the automation again", async () => {
  sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  act(() => openAutomation("A16", "log")); await wait(5);
  await open("T2");
  expect([useViewStore.getState().automation, useViewStore.getState().selected, useViewStore.getState().reader.open]).toEqual([null, "T2", true]);
  await back();
  expect([useViewStore.getState().automation, useViewStore.getState().reader.open]).toEqual([{ id: "A16", pane: "log" }, false]);
});

test("the three faces are one move: each shows only itself, a task over one closes as another is chosen, and Back steps through them", async () => {
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  act(() => openAnalysis()); await wait(5);
  expect([useViewStore.getState().analysis?.look, useViewStore.getState().automations]).toEqual(["tasks", null]);
  await open("T2");
  act(() => useViewStore.getState().showAutomations({ tab: "list" })); await wait(5);
  expect([useViewStore.getState().analysis, useViewStore.getState().automations, useViewStore.getState().reader.open])
    .toEqual([null, { tab: "list" }, false]);
  expect(new URL(location.href).searchParams.get("face")).toBe("automations");
  act(() => openAnalysis()); await wait(5);
  expect([useViewStore.getState().automations, new URL(location.href).searchParams.get("face")]).toEqual([null, "analysis"]);
  await back();
  expect(useViewStore.getState().automations).not.toBeNull();
  await back();
  expect([useViewStore.getState().analysis?.look, useViewStore.getState().selected, useViewStore.getState().reader.open]).toEqual(["tasks", "T2", true]);
  expect(session._currentIndex).toBe(2);
});

test("a task opened over the analysis stands on its layers: its × comes back to them, and closing them closes it too", async () => {
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  const home = analysisHome("tasks", { period: "today" });
  act(() => useViewStore.getState().showAnalysis(home)); await wait(5);
  act(() => useViewStore.getState().showAnalysis({ ...home, list: { set: "passed", value: "lead", group: null, member: null } })); await wait(5);
  const at = session._currentIndex;
  await open("T2");
  expect(surfacesOf(location.search)).toHaveLength(2);
  expect([useViewStore.getState().analysis?.list?.set, new URL(location.href).searchParams.get("task")]).toEqual(["passed", "T2"]);
  act(() => closeReaderStep()); await wait(20);
  expect([useViewStore.getState().analysis?.list?.set, useViewStore.getState().reader.open, session._currentIndex]).toEqual(["passed", false, at]);
  // A layer closed with a task over it closes the task too.
  await open("T3");
  act(() => closeAnalysisLayer(0)); await wait(20);
  expect([useViewStore.getState().analysis, useViewStore.getState().reader.open]).toEqual([home, false]);
});

test("without the Navigation API, a task over the analysis closes where it is and the analysis stays; Back shows the analysis before it opened", async () => {
  sessionHistory();
  mount(); await wait(5);
  act(() => openAnalysis()); await wait(5);
  await open("T2");
  act(() => closeReaderStep()); await wait(20);
  expect([useViewStore.getState().analysis?.look, closed()]).toEqual(["tasks", true]);
  await back();
  expect([useViewStore.getState().analysis?.look, useViewStore.getState().selected]).toEqual(["tasks", null]);
});

test("an automation a notice opens stands over the face shown: the browser's Back closes it", async () => {
  sessionHistory(); fakeNavigation();
  const worker = new EventTarget();
  const was = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  try {
    mount(); await wait(5);
    act(() => worker.dispatchEvent(new MessageEvent("message", { data: { type: "open-task", search: "?face=automations&automation=A16" } }))); await wait(5);
    expect(useViewStore.getState().automation).toEqual({ id: "A16", pane: "about" });
    await back();
    expect(useViewStore.getState().automation).toBeNull();
  } finally {
    cleanup();
    if (was) Object.defineProperty(navigator, "serviceWorker", was); else delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  }
});

test("without the Navigation API, closing an automation writes over its step: Back does not open it again", async () => {
  const session = sessionHistory();
  mount(); await wait(5);
  act(() => openAutomation("A16")); await wait(5);
  const at = session._currentIndex;
  act(() => closeReaderStep()); await wait(20);
  expect(useViewStore.getState().automation).toBeNull();
  expect(session._currentIndex).toBeLessThanOrEqual(at);
  await back();
  expect(useViewStore.getState().automation).toBeNull();
});

test("a URL opened straight on A, then B, then ×: the browser goes to A's step, written over without the reader", async () => {
  history.replaceState(null, "", "/?task=T1");
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  await open("T2");
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
  expect(session._currentIndex).toBe(0);
});

test("past the 50 steps a browser keeps, the step before the reader is gone: × closes it where it is", async () => {
  sessionHistory(50); fakeNavigation();
  mount(); await wait(5);
  for (let at = 0; at < 52; at++) await open(at % 2 ? "T2" : "T1");
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
});

for (const outside of [1, 2]) test(`after ${outside} page(s) outside the app and Back to it, × goes to the list's step all the same`, async () => {
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  for (let at = 0; at < 52; at++) await open(at % 2 ? "T2" : "T1");
  // A page outside the app: an entry the page writes nothing in, the app gone while it stands.
  cleanup();
  for (let page = 0; page < outside; page++) history.pushState(null, "", `/outside-${page}`);
  await act(async () => {
    const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
    history.go(-outside); await done;
  });
  useViewStore.setState(useViewStore.getInitialState()); mount(); await wait(5);
  expect(useViewStore.getState().reader.open).toBe(true);
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
  expect(session._currentIndex).toBe(0);
});

test("a slow browser: the reader closes once the move comes, and only then; nothing opens it again", async () => {
  const session = sessionHistory(); fakeNavigation({ delay: 800 });
  mount(); await wait(5);
  await open("T1"); await open("T2"); await open("T3");
  act(() => closeReaderStep());
  await wait(600);
  // Not there yet: the page waits for the browser rather than closing where it is.
  expect(useViewStore.getState().selected).toBe("T3");
  await wait(400);
  expect(closed()).toBe(true);
  expect(session._currentIndex).toBe(0);
  await wait(500);
  expect(closed()).toBe(true);
});

test("a move the browser gives up: × closes the reader where it is", async () => {
  sessionHistory(); fakeNavigation({ refuse: true });
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
});

test("without the Navigation API, × writes over the current step and closes; Back shows the task before it", async () => {
  const session = sessionHistory();
  mount(); await wait(5);
  await open("T1"); await open("T2");
  const at = session._currentIndex;
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
  expect(session._currentIndex).toBe(at);
  await back(); await wait(5);
  expect(useViewStore.getState().selected).toBe("T1");
});

test("what is open for a moment stays on the page's own move, and closes on a person's Back", async () => {
  sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => setTransient(true));
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
  expect(transientOpen).toBe(true);
  await act(async () => {
    const done = new Promise<void>((resolve) => addEventListener("popstate", () => resolve(), { once: true }));
    history.forward(); await done;
  });
  expect(transientOpen).toBe(false);
});

test("× and then another task opened while the browser is still on its way: the task opened last is what stands", async () => {
  sessionHistory(); fakeNavigation({ delay: 300 });
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => closeReaderStep());
  await open("T3");
  await wait(500);
  expect(useViewStore.getState().selected).toBe("T3");
  expect(new URL(location.href).searchParams.get("task")).toBe("T3");
  // It stands over the list the reader was closed to: Back shows the list.
  await back(); await wait(5);
  expect(closed()).toBe(true);
});

test("× given up by the browser after another task was opened: the task opened last stands", async () => {
  sessionHistory(); const navigation = fakeNavigation({ delay: 10_000 });
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => closeReaderStep());
  await open("T3");
  act(() => navigation.abortPending()); await wait(20);
  expect(useViewStore.getState().selected).toBe("T3");
  expect(new URL(location.href).searchParams.get("task")).toBe("T3");
});

test("× given up because the person went Back meanwhile: where Back went stands", async () => {
  sessionHistory(); const navigation = fakeNavigation({ delay: 10_000 });
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => closeReaderStep());
  act(() => navigation.abortPending());
  await back(); await wait(20);
  expect(useViewStore.getState().selected).toBe("T1");
});

test("× pressed twice while the browser is on its way is one move", async () => {
  const session = sessionHistory(); fakeNavigation({ delay: 100 });
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => { closeReaderStep(); closeReaderStep(); });
  await wait(300);
  expect(closed()).toBe(true);
  expect(session._currentIndex).toBe(0);
});

test("a browser that says the move finished before its popstate: the reader closes and what is open for a moment stays", async () => {
  sessionHistory(); const navigation = fakeNavigation({ held: true });
  mount(); await wait(5);
  await open("T1"); await open("T2");
  act(() => setTransient(true));
  act(() => closeReaderStep());
  await act(() => navigation.arrive(navigation.moves[0]!, { finishedFirst: true })); await wait(20);
  expect(closed()).toBe(true);
  expect(transientOpen).toBe(true);
});
