import { Workbench } from "../src/features/shell/Workbench";
import { snapshotJson } from './conversation-fixture';
import { startRequiredReadSession, resources } from '../src/data/resources';
import { basisForRead } from '../src/data/connection';
import { beforeAll, beforeEach, afterEach, afterAll, test, expect, vi } from "vitest";
// Load Workspace after this file's stream mock, even when another file loaded it first.
vi.hoisted(() => vi.resetModules());
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { startI18n, i18n } from "@alpacawork/i18n";
import { defaultSettings, DEFAULT_LIMITS } from "@alpacawork/contract";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";
import { isFinished } from "@alpacawork/contract/branch";
import { Workspace } from "../src/data/Workspace";
import { Toaster } from "../src/components/ui/toaster";
import { queryClient } from "../src/data/query-client";
import { useConnection, canSendWrites } from "../src/data/connection";
import { OFFLINE_SHOWN_AFTER_MS } from "../src/data/reach";
import { useToasts } from "../src/lib/notify";
import { serverReadFacts, displayReadFacts, taskReadState, readQuery } from '../src/data/read-model';
import { useReadPersistence } from "../src/data/read-persistence";
import { useReadStore } from "../src/state/read-store";
import { useViewStore } from "../src/state/view-store";
import { useDialogStore } from "../src/state/dialog-store";
import { usePersonalSettings } from "../src/data/personal-settings";
import { useWriteIntentStore } from "../src/data/write-intent";
import { taskBaseline } from "../src/data/notice-model";
import { dto, logEntry, recordHistory, historyFixture, homeFixture, indexOf, rowOf, timelineAxisAnswer, timelineAnswer, tree, viewsOf, PROJECT_TASK } from "./fixtures";
import { historyWindowAnswer, serverPatch } from "./receipt-fixture";
import { problemResponse } from "./problem";

/**
 * Cases S1–S4 through the screen's own callers: the Workspace, its feed (an SSE mock) and its reads (a fetch mock that
 * answers as serve does, and fails where a case says). The read core decides what is current; these check what the
 * screen then says and that a list or reader kept as of an earlier time never joins the current facts.
 */
const { fetchEventSource } = vi.hoisted(() => ({ fetchEventSource: vi.fn() }));
vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource }));
type Stream = { onmessage: (event: { id: string; event: string; data: string }) => void };
let stream: Stream;
let stopRequired: (() => void) | undefined;
let served = tree();
let rev = 1;
/** The projection version the top level's finished page was last changed at. */
let finishedPv = 0;
/** Which reads serve fails (503, a passing failure), and whether the network is gone (fetch rejects). */
const failing = new Set<"settings" | "finished" | "view" | "history">();
let unreachable = false;
let personalLanguage: 'en' | 'ja' = 'en';
const calls: string[] = [];

beforeAll(() => startI18n());
beforeEach(async () => {
  await i18n.changeLanguage("en");
  localStorage.removeItem("alpacawork.navigation.v2");
  queryClient.clear();
  stopRequired?.(); stopRequired = startRequiredReadSession(queryClient);
  served = tree(); rev = 1; finishedPv = 0; failing.clear(); unreachable = false; personalLanguage = 'en'; calls.length = 0;
  useReadStore.setState(useReadStore.getInitialState(), true);
  usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  useConnection.setState({ offline: false, lastReceivedAt: undefined, failures: 0 });
  // The moment out of reach is a toast of its own; one case's must not stand in the next.
  useToasts.setState({ toasts: [] });
  useReadPersistence.setState({ restoredAt: null, savedAt: null, unsavedTasks: 0, status: "idle", error: undefined });
  useViewStore.setState(useViewStore.getInitialState());
  useDialogStore.setState({ dialog: null });
  history.replaceState(null, "", "/?agent=1");
  fetchEventSource.mockImplementation((_url, options) => { stream = options; return new Promise(() => {}); });
  serve();
});
afterEach(() => { cleanup(); stopRequired?.(); vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => { vi.doUnmock("@microsoft/fetch-event-source"); vi.resetModules(); });

/** The finished page serve lists for the top level: the home list's Done rows, from version `sourcePv`. */
function finishedPage(value: ReturnType<typeof tree>, sourcePv: number) {
  const rows = (value.home ?? []).filter(item => item.section === "done").flatMap(item => value.tasks.filter(task => task.id === item.taskId)).map(task => {
    const { stateLog, ball, question, ...fields } = rowOf(task, value);
    return { ...fields, ...(ball ? { ball } : {}), ...(question ? { question } : {}), movedAt: Date.parse(task.log.at(-1)?.at ?? "2026-09-24T09:00:00Z"),
      stateMark: [...stateLog].reverse().find(entry => entry.toState === task.state) ?? null, latestReport: null, childCounts: { live: 0, finished: 0 } };
  });
  return { rows, total: rows.length, nextAfter: null, generation: "a", sourcePv };
}
function serve() {
  const values = defaultSettings();
  let personRevision = "person-1";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url), target = new URL(path, "http://screen");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (unreachable) throw new TypeError("Failed to fetch");
    if (path === "/api/commands/config/get") return new Response(snapshotJson({ hash: "c".repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: "agents: {}\n" }));
    if (path === "/api/coordinator") return new Response(snapshotJson({ id: "conversation-1", nextLaunch: { agent: 'claude', values: {} }, warm: 'none' as const, cancelled: [], turns: [] }));
    if (path === "/api/commands/settings/get") {
      if (failing.has("settings")) return problemResponse("unavailable");
      personRevision = (indexNow()?.person.settings ?? personRevision) || personRevision;
      return new Response(snapshotJson({ values: { ...values, language: personalLanguage }, revision: personRevision }));
    }
    if (path === "/api/person/notices") return new Response(snapshotJson({ state: null, revision: null,
      initialBaselines: Object.fromEntries(indexOf(served).tasks.map(row => [row.id, taskBaseline(row)])) }));
    if (target.pathname === "/api/task/finished") {
      if (failing.has("finished")) return problemResponse("unavailable");
      return new Response(snapshotJson(finishedPage(served, finishedPv)));
    }
    if (target.pathname === "/api/task/view") {
      if (failing.has("view")) return problemResponse("unavailable");
      const view = viewsOf(served, indexNow()?.sourcePv ?? 0).find(each => each.task.id === (target.searchParams.get("task") ?? target.searchParams.get("address")));
      return view ? new Response(snapshotJson(view)) : problemResponse("not_found", "No task");
    }
    if (target.pathname === "/api/task/history") {
      if (failing.has("history")) return problemResponse("unavailable");
      return new Response(snapshotJson({ ...historyWindowAnswer(served.history[target.searchParams.get("task")!] ?? []), sourcePv: finishedPv }));
    }
    if (target.pathname === "/api/task/timeline") return new Response(snapshotJson(timelineAnswer(served,
      (target.searchParams.get("lanes") ?? "").split(",").filter(Boolean))));
    if (target.pathname === "/api/task/timeline-axis") return new Response(snapshotJson(timelineAxisAnswer(served,
      target.searchParams.get("lanes")!.split(","), target.searchParams.get("folded")!.split(",").filter(Boolean))));
    return problemResponse("unavailable");
  });
}
const indexNow = () => queryClient.getQueryData<ProjectedIndexDTO>(["index"]);
/** One whole index from serve, as its feed sends it, changed by `edit` (a person revision, a page version). */
async function send(value: ReturnType<typeof tree>, edit: (index: ProjectedIndexDTO) => ProjectedIndexDTO = index => index) {
  served = value;
  // As serve's live index: closed Tasks are on their pages, not in it.
  const whole = indexOf(value, rev);
  const index = edit({ ...whole, generation: "a", sourcePv: finishedPv as never, tasks: whole.tasks.filter(row => !isFinished(row.state)),
    requiredPv: { ...whole.requiredPv, page: { "finished:root": finishedPv as never } } });
  await act(async () => stream.onmessage({ id: `a:${rev++}`, event: "index", data: JSON.stringify(index) }));
}
const mount = () => render(<QueryClientProvider client={queryClient}><Workspace><Workbench /></Workspace><Toaster /></QueryClientProvider>);
const withDone = (extra: ReturnType<typeof dto>[] = []) => tree({ tasks: [dto({ id: "T1", title: "Task one" }),
  dto({ id: "T2", title: "Finished one", state: "done", userRequested: true }), ...extra],
  home: homeFixture([{ taskId: "T1", section: "doing" }, { taskId: "T2", section: "done" }, ...extra.map(task => ({ taskId: task.id, section: "done" as const }))]) });
async function start(value: ReturnType<typeof tree> = withDone()) {
  mount();
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(value);
  await screen.findByText("Task one");
}
const openDone = () => fireEvent.click(document.querySelector<HTMLButtonElement>('[data-section="done"] button')!);

for (const language of ['ja', 'en'] as const)
for (const target of ['task'] as const)
test(`${language}: failed ${target} URL lookup names its own read and retries only GET`, async () => {
  personalLanguage = language;
  await i18n.changeLanguage(language);
  failing.add('view');
  history.replaceState(null, '', `/?agent=1&${target}=T9`);
  mount();
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(withDone());
  const reason = language === 'ja' ? 'タスクを読み取れません' : 'Could not read the task';
  await screen.findByText(reason, { exact: false });
  const before = calls.filter(path => path.startsWith('GET /api/task/view')).length;
  fireEvent.click(screen.getByRole('button', { name: language === 'ja' ? '再試行' : 'Retry' }));
  await waitFor(() => expect(calls.filter(path => path.startsWith('GET /api/task/view')).length).toBeGreaterThan(before));
  await screen.findByText(reason, { exact: false });
  expect(calls.some(path => /\/api\/task\/(new|update)/.test(path))).toBe(false);
});

test("S1-c: a shown Done list retains rows without new freshness text until read again", async () => {
  await start();
  openDone();
  await waitFor(() => expect(document.querySelector('[data-row="T2"]')).not.toBeNull());
  expect(document.querySelector('[data-row="T2"]')!.hasAttribute("data-dated")).toBe(false);
  // T3 finishes: the index counts 2 and moves the page's version; serve cannot answer the page now.
  failing.add("finished"); finishedPv = 2;
  await send(withDone([dto({ id: "T3", title: "Finished two", state: "done", userRequested: true })]));
  await waitFor(() => expect(document.querySelector<HTMLElement>('[data-row="T2"]')?.dataset.dated).toBe("true"));
  expect(document.querySelector("[data-dated-list]")).toBeNull();
  // The heading says the server's count; the rows drawn are the earlier list's, marked so, and never current facts.
  expect(document.querySelector('[data-section="done"]')!.textContent).toContain("2");
  const row = document.querySelector<HTMLElement>('[data-row="T2"]')!;
  expect(row.dataset.dated).toBe("true");
  expect(row.querySelector("[data-unread]")).toBeNull();
  expect(document.querySelector('[data-row="T3"]')).toBeNull();
  expect(serverReadFacts(queryClient)!.tasks.some(each => each.id === "T2")).toBe(false);
  failing.delete("finished");
  await act(async () => { await queryClient.refetchQueries({ queryKey: ['task-finished'] }); });
  await waitFor(() => expect(document.querySelector('[data-row="T3"]')).not.toBeNull());
  expect(document.querySelector("[data-dated-list]")).toBeNull();
  expect(document.querySelector('[data-row="T2"]')!.hasAttribute("data-dated")).toBe(false);
  expect(serverReadFacts(queryClient)!.tasks.some(each => each.id === "T3")).toBe(true);
});

test("S1-c: out of reach, the dated note offers no retry; S1-b: a list this device never read says it is not saved, not a failure", async () => {
  await start();
  openDone();
  await waitFor(() => expect(document.querySelector('[data-row="T2"]')).not.toBeNull());
  unreachable = true; finishedPv = 2;
  await send(withDone([dto({ id: "T3", title: "Finished two", state: "done", userRequested: true })]));
  act(() => useConnection.setState({ offline: true, state: "reconnecting", failures: 1 }));
  expect(document.querySelector("[data-dated-list]")).toBeNull();
  // T1's detail was never read on this device: its reader says so in the content's place, not as a failure.
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  const absent = await waitFor(() => { const element = document.querySelector<HTMLElement>('[data-reading-column] [data-read-note="absent"]'); expect(element).not.toBeNull(); return element!; }, { timeout: 3000 });
  expect(absent.textContent).toBe("Not saved on this device. It loads when the connection is back.");
  expect(document.querySelector("[data-reading-column] [data-read-failure]")).toBeNull();
  // Nothing held is hidden: the note itself is seen.
  expect(document.querySelector<HTMLElement>("[data-reading-column]")!.dataset.heldHidden).toBeUndefined();
});

test("S2: a known change retains the same readable body through pending, 503 and offline until an adopted success", async () => {
  const value = withDone();
  value.history.T1 = historyFixture([{ id: "H-retained", kind: "report", title: "Original report", summary: "Old report body" }]);
  await start(value);
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  // A feed mounted afresh holds a placeholder first and draws its rows in a render after: take the feed once they land.
  const feed = await waitFor(() => { const element = document.querySelector<HTMLElement>("[data-report-feed]"); expect(element?.textContent).toContain("Original report"); return element!; });
  const column = document.querySelector<HTMLElement>("[data-reading-column]")!;
  // The task's own text is the Context page now; the reports' text is what this column retains.
  await waitFor(() => expect(feed.textContent).toContain("Old report body"));
  const body = feed.textContent;
  const area = document.querySelector<HTMLElement>('[data-reader-content]')!;
  area.scrollTop = 173; fireEvent.scroll(area);
  expect(canSendWrites(basisForRead("T1"))).toBe(true);
  failing.add("view");
  served = { ...served, tasks: served.tasks.map(task => task.id === "T1" ? { ...task, values: { notes: "Changed elsewhere" }, version: task.version + 1, hash: "e".repeat(64) } : task) };
  const changed = served.tasks.find(task => task.id === "T1")!;
  const patch = serverPatch(indexNow()!, [rowOf(changed, served)]);
  await act(async () => stream.onmessage({ id: `${patch.generation}:${patch.rev}`, event: "patch", data: JSON.stringify(patch) }));
  rev = patch.rev + 1;
  const query = readQuery(queryClient, resources.taskView('/fixture', 'T1').queryKey)!;
  await waitFor(() => expect(query.state.fetchStatus).toBe('idle'));
  const retained = () => {
    expect(document.querySelector("[data-report-feed]")).toBe(feed);
    expect(feed.textContent).toContain('Old report body');
    expect(feed.textContent).toContain('Original report');
    expect(feed.textContent).not.toContain('Changed elsewhere');
    expect(column.dataset.heldHidden).toBeUndefined();
    expect(column.hasAttribute("inert")).toBe(false);
    expect(column.className).not.toContain("invisible");
    expect(area.scrollTop).toBe(173);
    expect(taskReadState(queryClient, '/fixture', 'T1', true).assessment).toMatchObject({ state: 'obsolete', display: true, project: false, persist: false });
    expect(canSendWrites(basisForRead("T1"))).toBe(false);
  };
  retained(); expect(body).toContain('Old report body');
  let answer!: (response: Response) => void;
  const failed = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, options) => String(url).startsWith('/api/task/view')
    ? new Promise<Response>(resolve => { answer = resolve; }) : failed(url, options));
  let pending!: Promise<unknown>;
  await act(async () => { pending = query.fetch().catch(() => {}); });
  expect(query.state.fetchStatus).toBe('fetching'); retained();
  expect(document.querySelector('[data-reader-read-state] [data-read-failure]')).toBeNull();
  expect(document.querySelector('[data-reader-read-state] button')).toBeNull();
  await act(async () => { answer(problemResponse('unavailable')); await pending; }); retained();
  expect(document.querySelector('[data-reader-read-state] [data-read-failure]')).toBeNull();
  act(() => useConnection.setState({ offline: true })); retained();
  act(() => useConnection.setState({ offline: false }));
  vi.mocked(fetch).mockImplementation(failed); failing.delete("view");
  await act(async () => { await query.fetch(); });
  await waitFor(() => expect(taskReadState(queryClient, '/fixture', 'T1', true).assessment.state).toBe('current'));
  expect(document.querySelector("[data-report-feed]")).toBe(feed);
  expect(area.scrollTop).toBe(173);
  // The adopted success is what Context shows.
  act(() => useViewStore.getState().setReaderPane("about"));
  await waitFor(() => expect(document.querySelector('[data-task-about]')?.textContent).toContain('Changed elsewhere'));
});

test("S2: reports not confirmed to be the latest are shown as of the time serve sent them", async () => {
  await start(tree({ tasks: [dto({ id: "T1", title: "Task one" }), dto({ id: "T11", title: "Child", parentId: "T1" })],
    home: homeFixture([{ taskId: "T1", section: "doing" }]) }));
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  await waitFor(() => expect(document.querySelector("[data-report-feed]")).not.toBeNull());
  failing.add("history");
  // The child reports: its parent's History owes a read, which serve cannot answer now.
  await send({ ...served, tasks: served.tasks.map(task => task.id === "T11" ? { ...task, state: "waiting", version: task.version + 1 } : task) },
    index => ({ ...index, sourcePv: 5 as never, requiredPv: { ...index.requiredPv, history: { T1: 5 as never } } }));
  await waitFor(() => expect(queryClient.getQueryCache().find({ queryKey: ['task-history', '/fixture', 'T1'], exact: true })?.state.status).toBe('error'));
  expect(document.querySelector<HTMLElement>("[data-reading-column]")!.dataset.heldHidden).toBeUndefined();
  expect(canSendWrites(basisForRead('T1'))).toBe(true);
  expect(canSendWrites(basisForRead(['task-history', '/fixture', 'T1']))).toBe(false);
});

test("S3: settings read before stay in use when reading them again fails; one shared toast says so, not while out of reach", async () => {
  await start();
  await waitFor(() => expect(usePersonalSettings.getState().status).toBe("ready"));
  failing.add("settings");
  await send(served, index => ({ ...index, person: { ...index.person, settings: "person-2" } }));
  const notice = await screen.findByText("Could not reload your personal settings.");
  expect(notice.closest("[data-toast]")?.textContent).toContain("Using the previous settings.");
  expect(screen.getByText("Task one")).toBeTruthy();
  expect(document.querySelector("[data-workspace-notice]")).toBeNull();
  expect(document.querySelectorAll("[data-toast]")).toHaveLength(1);
  act(() => useConnection.setState({ offline: true, state: "reconnecting" }));
  await waitFor(() => expect(document.querySelector("[data-toast]")).toBeNull());
  act(() => useConnection.setState({ offline: false, state: "live" }));
  await screen.findByText("Could not reload your personal settings.");
  failing.delete("settings");
  fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
  await waitFor(() => expect(document.querySelector("[data-toast]")).toBeNull());
});

test("Reader admission: sibling completion removes a hidden closed page, but URL and Back still open the acquired body and History without current facts or writes", async () => {
  const value = withDone();
  value.tasks.find(task => task.id === "T2")!.values = { notes: "Previously acquired closed body" };
  value.history.T2 = recordHistory("T2", [logEntry({ id: "L2", kind: "reported", toState: "done", actor: { kind: "placement", placementId: "A1" },
    title: "Previously acquired History", description: "Actual saved report content" })]);
  const contents = async () => {
    await waitFor(() => { const feed = document.querySelector("[data-report-feed]"); expect(feed?.textContent).toContain("Previously acquired History"); });
    await screen.findByText("Actual saved report content");
    // The task's own text: its Context page.
    act(() => useViewStore.getState().setReaderPane("about"));
    await screen.findByText("Previously acquired closed body");
    act(() => useViewStore.getState().setReaderPane("task"));
  };
  await start(value);
  openDone();
  await waitFor(() => expect(document.querySelector('[data-row="T2"]')).not.toBeNull());
  act(() => useViewStore.getState().openTask("T2", { reader: true }));
  await contents();
  const acquiredAt = queryClient.getQueryCache().find({ queryKey: ["task", "/fixture", "T2"], exact: true })!.state.dataUpdatedAt;
  // Hide the closed list and leave the Reader: this is ordinary navigation, not a patched cache.
  openDone();
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  failing.add("finished"); unreachable = true; finishedPv = 2;
  await send({ ...value, tasks: [...value.tasks, dto({ id: "T3", title: "Another closed sibling", state: "done" })] });
  act(() => useConnection.setState({ offline: true, state: "reconnecting" }));
  const offlineCalls = calls.length;
  // The same navigation entrypoints that a shared URL and browser Back use.
  act(() => { history.pushState(null, "", "/?agent=1&task=T2"); fireEvent.popState(window); });
  await contents();
  expect(useViewStore.getState().selected).toBe("T2");
  // Acquired detail is not membership of the latest list or its visible time lanes.
  expect(displayReadFacts(queryClient)!.tasks.some(row => row.id === "T2")).toBe(false);
  expect(document.querySelector('[data-reader-awaiting]')).toBeNull();
  // A sibling's completion does not make T2's own view old (its required version did not move); offline, nothing is sent.
  expect(canSendWrites(basisForRead("T2"))).toBe(false);
  expect(calls.slice(offlineCalls).filter(call => call.startsWith("POST "))).toEqual([]);
  expect(queryClient.getQueryCache().find({ queryKey: ["task", "/fixture", "T2"], exact: true })!.state.dataUpdatedAt).toBe(acquiredAt);
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  act(() => { history.back(); });
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T2"));
  act(() => useViewStore.getState().setReaderPane("about"));
  expect(await screen.findByText("Previously acquired closed body")).toBeTruthy();
});

test('an unmatched acquired view with no held list supplies no displayed row or visible timeline IDs', async () => {
  // T3 finished at the top: Done holds something, so its heading is drawn to open it.
  const value = tree({ tasks: [dto({ id: 'T1', title: 'Task one' }), dto({ id: 'T2', parentId: 'T1', state: 'done' }), dto({ id: 'T3', state: 'done' })],
    home: homeFixture([{ taskId: 'T1', section: 'doing' }, { taskId: 'T3', section: 'done' }]) });
  await start(value);
  await act(async () => { await queryClient.fetchQuery(resources.taskView('/fixture', 'T2')); });
  const lanes = () => queryClient.getQueryCache().getAll().filter(query => query.isActive() && query.queryKey[0] === 'task-timeline')
    .flatMap(query => String(query.queryKey[query.queryKey[2] === 'axis' ? 4 : 3]).split(','));
  failing.add('finished');
  openDone();
  await waitFor(() => { expect(document.querySelector('[data-row="T2"]')).toBeNull(); expect(lanes()).not.toContain('T2'); });
  unreachable = true; finishedPv = 3;
  await send(value);
  act(() => useConnection.setState({ offline: true, state: 'reconnecting' }));
  await waitFor(() => {
    expect(displayReadFacts(queryClient)!.tasks.some(row => row.id === 'T2')).toBe(false);
    expect(document.querySelector('[data-row="T2"]')).toBeNull();
    const active = queryClient.getQueryCache().getAll().filter(query => query.isActive() && query.queryKey[0] === 'task-timeline');
    expect(active.length).toBeGreaterThan(0);
    for (const query of active) expect(String(query.queryKey[query.queryKey[2] === 'axis' ? 4 : 3]).split(',')).not.toContain('T2');
  });
});


test('F-D: a same-boot History refusal keeps its explanation when the network goes offline', async () => {
  await start(); act(() => useViewStore.getState().openTask('T1', { reader: true }));
  await waitFor(() => expect(document.querySelector('[data-report-feed]')?.getAttribute('data-history-ready')).toBe('true'));
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation((url, init) => String(url).includes('/api/task/history') ? Promise.resolve(problemResponse('forbidden', 'Retained original refusal')) : original(url, init));
  await act(async () => { await queryClient.fetchQuery({ ...resources.history('/fixture', 'T1'), staleTime: 0 }).catch(() => {}); });
  const failure = () => document.querySelector('[data-report-feed] [data-read-failure]');
  await waitFor(() => expect(failure()).not.toBeNull()); const explanation = failure()!.textContent;
  act(() => useConnection.setState({ offline: true, state: 'reconnecting', failures: 1 }));
  await waitFor(() => expect(failure()?.textContent).toBe(explanation));
  // And once the loss is shown as offline, which comes a little later (data/reach).
  await act(async () => { await new Promise(resolve => setTimeout(resolve, OFFLINE_SHOWN_AFTER_MS + 50)); });
  expect(failure()?.textContent).toBe(explanation);
  expect(document.querySelector('[data-report-feed] [data-read-note=absent]')).toBeNull();
});
