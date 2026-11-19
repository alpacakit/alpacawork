/**
 * The URL is what the screen shows, and reading another task is the one reader's next step: A → B is a step,
 * Back shows A, Forward B, whatever B was pressed in; × goes back past the reader's steps; what is open for a moment
 * closes on a person's Back, not on the page's own.
 */
import { beforeAll, beforeEach, afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { startI18n } from "@alpacawork/i18n";
import { useUrlBootstrap, openScreenLink } from "../src/state/bootstrap";
import { closeReaderStep } from "../src/state/history-step";
import { useCloseOnBack } from "../src/lib/close-on-back";
import { useEveryTaskIndex } from "../src/data/queries";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, at, dto, screenData, tree } from "./fixtures";
import { fakeNavigation, sessionHistory } from "./navigation-fake";

const file = (name: string) => ({ name, size: 10, at, revision: "r1" });
const data = () => screenData(tree({ tasks: [dto({ id: "T1", files: [file("shot.png")] }), dto({ id: "T2", files: [file("shot.png")] }), dto({ id: "T3" })] }));
let setTransient: (open: boolean) => void;
let transientOpen = false;
function Bootstrap() {
  useUrlBootstrap(useEveryTaskIndex());
  const [open, setOpen] = useState(false); setTransient = setOpen; transientOpen = open;
  useCloseOnBack(open, () => setOpen(false));
  return null;
}
const mount = () => render(<TestWorkspace data={data()}><Bootstrap /></TestWorkspace>);
const flush = async () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const move = (step: () => void) => act(async () => {
  const done = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
  step(); await done;
});
const back = () => move(() => history.back());
const forward = () => move(() => history.forward());
const task = () => new URL(location.href).searchParams.get("task");
const open = (id: string) => act(() => useViewStore.getState().openTask(id, { reader: true }));

beforeAll(() => startI18n());
beforeEach(() => { localStorage.removeItem("alpacawork.navigation.v2"); history.replaceState(null, "", "/"); useViewStore.setState(useViewStore.getInitialState()); sessionHistory(); fakeNavigation(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("A, then B pressed in it: the reader and the URL are B; Back shows A, Forward B", async () => {
  mount(); await flush();
  open("T1"); await flush();
  const length = history.length;
  open("T2"); await flush();
  expect(useViewStore.getState().selected).toBe("T2");
  expect(task()).toBe("T2");
  expect(history.length).toBe(length + 1);
  await back(); await flush();
  expect(useViewStore.getState().selected).toBe("T1");
  expect(task()).toBe("T1");
  await forward(); await flush();
  expect(useViewStore.getState().selected).toBe("T2");
});

test("while a search is open, A → B is a step too: Back shows A", async () => {
  mount(); await flush();
  act(() => useViewStore.getState().setQuery("T")); await flush();
  open("T1"); await flush();
  open("T2"); await flush();
  await back(); await flush();
  expect(useViewStore.getState().selected).toBe("T1");
  expect(useViewStore.getState().query).toBe("T");
});

test("A → B → ×: the list, and Back opens neither again", async () => {
  mount(); await flush();
  open("T1"); await flush();
  open("T2"); await flush();
  await move(() => closeReaderStep()); await flush();
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(task()).toBeNull();
  // The list's own step: nothing of the reader before it for Back to open.
  expect((window as unknown as { _sessionHistory: { _currentIndex: number } })._sessionHistory._currentIndex).toBe(0);
});

test("a picture of B opened and closed by ×: Back shows A, not B's picture", async () => {
  mount(); await flush();
  open("T1"); await flush();
  act(() => useViewStore.getState().openTaskFile("T2", "shot.png")); await flush();
  expect(new URL(location.href).searchParams.get("image")).toBe("shot.png");
  expect(task()).toBe("T2");
  await back(); await flush();
  expect(task()).toBe("T1");
  expect(new URL(location.href).searchParams.get("image")).toBeNull();
});

test("a link to another state of the screen is a step: Back shows the task it was pressed in", async () => {
  mount(); await flush();
  open("T1"); await flush();
  const before = location.search;
  act(() => openScreenLink("/?q=example")); await flush();
  expect(useViewStore.getState().query).toBe("example");
  expect(useViewStore.getState().reader.open).toBe(false);
  await back(); await flush();
  expect(location.search).toBe(before);
  expect(useViewStore.getState().selected).toBe("T1");
});

test("a reload on B shows B, and Back from it A", async () => {
  mount(); await flush();
  open("T1"); await flush();
  open("T2"); await flush();
  cleanup(); useViewStore.setState(useViewStore.getInitialState());
  mount(); await flush();
  expect(useViewStore.getState().selected).toBe("T2");
  await back(); await flush();
  expect(useViewStore.getState().selected).toBe("T1");
});

test("what is open for a moment closes on a person's Back with the page's step, and stays on the page's own ×", async () => {
  mount(); await flush();
  open("T1"); await flush();
  act(() => setTransient(true));
  await move(() => closeReaderStep()); await flush();
  expect(useViewStore.getState().reader.open).toBe(false);
  expect(transientOpen).toBe(true);
  // The browser says the page's move is done (the Navigation API's finished) before a person can press Forward.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  await forward(); await flush();
  expect(transientOpen).toBe(false);
  expect(useViewStore.getState().selected).toBe("T1");
});
