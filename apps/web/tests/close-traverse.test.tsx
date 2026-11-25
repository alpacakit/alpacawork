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
import { closeReaderStep, showList } from "../src/state/history-step";
import { analysisHome } from "../src/features/analysis/place";
import { useCloseOnBack } from "../src/lib/close-on-back";
import { useEveryTaskIndex } from "../src/data/queries";
import { useViewStore } from "../src/state/view-store";
import { queryClient } from "../src/data/query-client";
import { TestWorkspace, dto, screenData, tree } from "./fixtures";
import { fakeNavigation, sessionHistory } from "./navigation-fake";

let transientOpen = false;
let setTransient: (open: boolean) => void;
function Bootstrap() {
  useUrlBootstrap(useEveryTaskIndex());
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

test("the list with A open, the analysis, then Use: the browser goes back to the list's step with A open, and × closes A to the list", async () => {
  const session = sessionHistory(); fakeNavigation();
  mount(); await wait(5);
  await open("T1");
  act(() => useViewStore.getState().showAnalysis(analysisHome())); await wait(5);
  expect(useViewStore.getState().reader.open).toBe(false);
  act(() => showList()); await wait(20);
  expect(useViewStore.getState()).toMatchObject({ analysis: null, selected: "T1", reader: { open: true } });
  expect(session._currentIndex).toBe(1);
  act(() => closeReaderStep()); await wait(20);
  expect(closed()).toBe(true);
  expect(useViewStore.getState().analysis).toBeNull();
  expect(session._currentIndex).toBe(0);
});
