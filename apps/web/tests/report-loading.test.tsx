import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { historyCursor } from "@alpacawork/contract";
import { Reader } from "../src/features/reader/Reader";
import { ReportFeed } from "../src/features/reader/ReportFeed";
import { queryClient } from "../src/data/query-client";
import { assessRead, indexKey, resources } from "../src/data/resources";
import { refuseRead, recordReadProof, getReadProof } from "../src/data/read-model";
import { useViewStore } from "../src/state/view-store";
import { READING_SHOWN_AFTER_MS } from "../src/features/chrome/ProgressLine";
import { dto, historyFixture, indexOf, screenData, TestWorkspace, tree, viewsOf } from "./fixtures";

beforeAll(() => startI18n());
afterEach(() => { cleanup(); queryClient.clear(); useViewStore.setState(useViewStore.getInitialState()); vi.restoreAllMocks(); });

function prepare() {
  queryClient.clear();
  const value = tree({ tasks: [dto()] });
  const data = screenData(value);
  const index = indexOf(value);
  queryClient.setQueryData(indexKey, index);
  queryClient.removeQueries({ queryKey: resources.history(index.root, "T1").queryKey, exact: true });
  return { value, data: { ...data, seed: () => {} }, index };
}
function transport() {
  const calls: { url: string; answer: (value: unknown, status?: number) => void }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(url => new Promise<Response>(resolve => {
    calls.push({ url: String(url), answer: (value, status = 200) => resolve(new Response(JSON.stringify(value), { status })) });
  }));
  return calls;
}
/** The server's History of T1: one report already readable. */
const known = historyFixture([{ id: "known", kind: "report", title: "Already readable", summary: "Retained body" }]);
const page = { generation: "a", sourcePv: 0, events: known, hasOlder: false, oldestKey: historyCursor(known[0]!) };

test("the real Reader starts history while view is outstanding, reuses it and reopens without GET", async () => {
  const { value, data, index } = prepare();
  queryClient.removeQueries({ queryKey: resources.taskView(index.root, "T1").queryKey, exact: true });
  const calls = transport();
  act(() => useViewStore.getState().openTask("T1", { reader: true, pane: "task" }));
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  // Neither answer has arrived: a serial Reader would have made only the view call here.
  await waitFor(() => expect(calls.filter(c => /task\/(view|history)\?/.test(c.url))).toHaveLength(2));
  await act(async () => calls.find(c => c.url.includes("task/history?"))!.answer(page));
  await act(async () => calls.find(c => c.url.includes("task/view?"))!.answer(viewsOf(value)[0]));
  await waitFor(() => expect(document.querySelector('[data-report-key="log:T1:known"]')).not.toBeNull());
  expect(calls).toHaveLength(2);
  act(() => useViewStore.getState().closeReader());
  act(() => useViewStore.getState().openTask("T1", { reader: true, pane: "task" }));
  await waitFor(() => expect(document.querySelector('[data-report-key="log:T1:known"]')).not.toBeNull());
  expect(calls).toHaveLength(2);
});

test("a History still on its way shows only its placeholder, however long the view's read again takes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { value, data, index } = prepare();
    queryClient.removeQueries({ queryKey: resources.taskView(index.root, "T1").queryKey, exact: true });
    const calls = transport();
    const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    act(() => useViewStore.getState().openTask("T1", { reader: true, pane: "task" }));
    render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
    await flush(0);
    await act(async () => calls.find(c => c.url.includes("task/view?"))!.answer(viewsOf(value)[0]));
    // The view is read again while History has not come: the placeholder says the wait, not the line over it.
    act(() => { void queryClient.invalidateQueries({ queryKey: resources.taskView(index.root, "T1").queryKey, exact: true }); });
    await flush(READING_SHOWN_AFTER_MS * 2);
    expect(document.querySelector('[data-skeleton="reportLines"]')).not.toBeNull();
    expect(document.querySelector("[data-reading-line]")).toBeNull();
  } finally { vi.useRealTimers(); }
});

test("the about pane does not start a report history read", async () => {
  const { data } = prepare(), calls = transport();
  act(() => useViewStore.getState().openTask("T1", { reader: true, pane: "about" }));
  render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(calls.filter(c => c.url.includes("task/history?"))).toHaveLength(0);
});

test("only the missing history range waits, and a failed revalidation preserves the known report DOM", async () => {
  const { data, index } = prepare(), calls = transport();
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  // Nothing of History is held yet: its lines wait where the reports go.
  await waitFor(() => expect(document.querySelector('[data-skeleton="reportLines"]')).not.toBeNull());
  await act(async () => calls[0]!.answer(page));
  await waitFor(() => expect(document.querySelector('[data-skeleton="reportLines"]')).toBeNull());
  const row = document.querySelector('[data-report-key="log:T1:known"]');
  expect(row).not.toBeNull();
  act(() => { void queryClient.invalidateQueries({ queryKey: resources.history(index.root, "T1").queryKey, exact: true }); });
  await waitFor(() => expect(calls).toHaveLength(2));
  await act(async () => calls[1]!.answer({ error: { code: "not_found", message: "Read failed" } }, 404));
  await waitFor(() => expect(queryClient.getQueryState(resources.history(index.root, "T1").queryKey)?.status).toBe("error"));
  expect(row!.isConnected).toBe(true);
  const history = queryClient.getQueryCache().find({ queryKey: resources.history(index.root, 'T1').queryKey, exact: true })!;
  expect(assessRead(queryClient, history)).toMatchObject({ state: 'unverified', display: true, project: false });
  expect(document.querySelector('[data-report-key="log:T1:known"]')).toBe(row);
  expect(document.querySelector('[data-skeleton="reportLines"]')).toBeNull();
  expect(document.querySelector('[data-skeleton="reports"]')).toBeNull();
});

for (const gate of ['refused', 'foreign-generation'] as const) test(`retained obsolete reader does not expose ${gate} History through ReportFeed`, async () => {
  const { data, index } = prepare(), calls = transport();
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => calls[0]!.answer(page));
  await waitFor(() => expect(document.querySelector('[data-report-key="log:T1:known"]')).not.toBeNull());
  const history = queryClient.getQueryCache().find({ queryKey: resources.history(index.root, 'T1').queryKey, exact: true })!;
  act(() => {
    if (gate === 'refused') refuseRead(history, queryClient.getQueryData(indexKey));
    else recordReadProof(history, { ...getReadProof(history)!, generation: 'other-generation' });
    history.setState({ isInvalidated: true });
  });
  await waitFor(() => expect(document.querySelector('[data-report-key="log:T1:known"]')).toBeNull());
  expect(history.state.data).toBeDefined(); // It was denied by the Owner, not made absent to make the check pass.
  expect(assessRead(queryClient, history)).toMatchObject({ display: false, project: false, persist: false });
});
