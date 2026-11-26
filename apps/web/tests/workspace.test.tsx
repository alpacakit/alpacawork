import { Workbench } from "../src/features/shell/Workbench";
import { readQuery } from '../src/data/read-model';
import type { CoordinatorTurn } from '@alpacawork/contract/coordinator';
import { snapshotJson, conversationRevision, conversationSnapshot, SERVED } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { startRequiredReadSession } from '../src/data/resources';
import { timeoutClock } from "./timing";
import { readFileSync } from "node:fs";
import { Profiler } from "react";
import { join } from "node:path";
import { beforeAll, beforeEach, afterEach, afterAll, test, expect, vi } from "vitest";
// Load Workspace after this file's stream mock, even when another file loaded it first.
vi.hoisted(() => vi.resetModules());
import { render, screen, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { notifyManager, QueryClientProvider } from "@tanstack/react-query";
import { startI18n, i18n } from "@alpacawork/i18n";
import { Workspace } from "../src/data/Workspace";
import { queryClient } from "../src/data/query-client";
import { useConnection } from "../src/data/connection";
import { useReadStore } from "../src/state/read-store";
import { useViewStore } from "../src/state/view-store";
import { useDialogStore } from "../src/state/dialog-store";
import { notify, useToasts } from "../src/lib/notify";
import { Toaster } from "../src/components/ui/toaster";
import { readTaskIds, taskBaseline, type NoticeSaved } from "../src/data/notice-model";
import { defaultSettings } from "@alpacawork/contract";
import { useConversation } from "../src/features/coordinator/coordinator";
import { usePersonalSettings } from "../src/data/personal-settings";
import { intentKey, useWriteIntentStore } from "../src/data/write-intent";
import type { ControlTreeDTO } from "@alpacawork/contract/control";
import { dto, homeFixture, timelineAxisAnswer, timelineAnswer, indexOf, rowOf, logEntry, project, searchAnswer, tree, viewsOf, PROJECT_TASK } from "./fixtures";
import { DEFAULT_LIMITS } from "@alpacawork/contract";
import { problemResponse } from "./problem";

const { fetchEventSource } = vi.hoisted(() => ({ fetchEventSource: vi.fn() }));
vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource }));
type Stream = { onopen: (response: Response) => Promise<void>; onmessage: (event: { id: string; event: string; data: string }) => void; onerror: (error: unknown) => number };
let stream: Stream;
let stopRequired: (() => void) | undefined;
/** The tree the server holds: the last one sent, which also answers the reads beside the feed. */
let served: ControlTreeDTO = tree();
beforeAll(() => {
  // Cache subscribers live for the module, across visits with different clocks. Keep their
  // batches asynchronous without giving a test's discarded timeout ownership of that lifetime.
  notifyManager.setScheduler(queueMicrotask);
  return startI18n();
});
beforeEach(() => {
  // Each case starts a new visit without a navigation saved by an earlier case.
  localStorage.removeItem("alpacawork.navigation.v2");
  queryClient.clear();
  stopRequired?.(); stopRequired = startRequiredReadSession(queryClient);
  served = tree();
  useReadStore.setState(useReadStore.getInitialState(), true);
  usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  useWriteIntentStore.setState({ entries: {}, unavailable: false });
  useConnection.setState({ offline: false, lastReceivedAt: undefined });
  useViewStore.setState(useViewStore.getInitialState());
  useDialogStore.setState({ dialog: null });
  history.replaceState(null, "", "/");
  fetchEventSource.mockImplementation((_url, options) => { stream = options; return new Promise(() => {}); });
});
afterEach(() => { cleanup(); stopRequired?.(); vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(() => {
  notifyManager.setScheduler(callback => setTimeout(callback, 0));
  vi.doUnmock("@microsoft/fetch-event-source"); vi.resetModules();
});
const mount = () => render(<QueryClientProvider client={queryClient}><Workspace><Workbench /></Workspace><Toaster /></QueryClientProvider>);

test("saving personal settings does not commit the whole workspace", async () => {
  serveSettings();
  let commits = 0;
  render(<QueryClientProvider client={queryClient}>
    <Profiler id="workspace" onRender={() => { commits++; }}><Workspace><Workbench /></Workspace></Profiler>
  </QueryClientProvider>);
  await feed();
  await listed();
  await waitFor(() => expect(usePersonalSettings.getState().status).toBe("ready"));
  commits = 0;
  act(() => useWriteIntentStore.setState({ entries: { [intentKey("/fixture", "personal-setting:theme", null)]: {
    status: "pending", operationId: "op1", transport: "receipt", payload: { key: "theme", value: "dark", expectedRevision: "r1" },
    attempt: "attempt1", at: new Date().toISOString(),
  } } }));
  expect(commits).toBe(0);
});
/** What the server answers beside the feed: the person's settings and reads, the conversation, task views and searches. */
const serveSettings = () => {
  let notices: NoticeSaved | null = null;
  let revision = 0;
  const values = defaultSettings();
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    // The AI tab reads this PC's config.yaml: its limits and agents.
    if (path === "/api/commands/config/get") return new Response(snapshotJson({ hash: "c".repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: "agents: {}\n" }));
    const target = new URL(path, "http://screen");
    if (target.pathname === "/api/task/view") {
      const view = viewsOf(served).find((each) => each.task.id === target.searchParams.get("task"));
      return view ? new Response(snapshotJson(view)) : problemResponse("not_found", "No task");
    }
    // A search finds every task the server holds.
    if (target.pathname === "/api/task/search") return new Response(snapshotJson(searchAnswer(served.tasks.filter((task) => task.kind === "task").map((task) => task.id))));
    // The coordinator's input stands at the screen's foot from the start, so its conversation is read with the page.
    if (path === "/api/coordinator") return new Response(snapshotJson({ id: "conversation-1", nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] }));
    if (path === "/api/commands/settings/get") return new Response(snapshotJson({ values, revision: "person-1" }));
    if (path === "/api/person/notices") return new Response(snapshotJson({ state: notices, revision: revision ? String(revision) : null, ...(!notices ? { initialBaselines: Object.fromEntries(indexOf(served).tasks.map(row => [row.id, taskBaseline(row)])) } : {}) }));
    if (path === "/api/person/notices/save") {
      const input = JSON.parse(String(init?.body));
      if (input.expectedRevision !== (revision ? String(revision) : null))
        return problemResponse("conflict");
      notices = input.state; revision++;
      return new Response(snapshotJson({ state: notices, revision: String(revision) }));
    }
    if (target.pathname === "/api/task/timeline") return new Response(snapshotJson(timelineAnswer(served,
      (target.searchParams.get("lanes") ?? "").split(",").filter(Boolean))));
    if (String(url).startsWith('/api/task/timeline-axis?')) {
      const params = new URL(String(url), 'http://fixture/').searchParams;
      return new Response(snapshotJson(timelineAxisAnswer(served, params.get('lanes')!.split(','))));
    }
    return problemResponse("not_found", "Not found");
  });
};
/** An `index` event: the index the server makes of the tree, at stream position `id` (`generation:rev`). */
const send = async (value: ControlTreeDTO, id = "a:1", person?: { settings: string | null; notices: string | null; coordinator: import('@alpacawork/contract/control').ControlIndexDTO['person']['coordinator'] }) => {
  const [generation, rev] = id.split(":");
  served = value;
  await act(async () => stream.onmessage({ id, event: "index",
    data: JSON.stringify({ ...indexOf(value, Number(rev)), generation, ...(person ? { person } : {}) }) }));
};
/** What the server serves: Task one at work, which the home list lists under Working, never folded (`listed`). */
const listing = (overrides: Parameters<typeof tree>[0] = {}) => tree({ home: homeFixture([{ taskId: "T1", section: "doing" }]), ...overrides });
/** The stream opens and its first event is the snapshot. */
const feed = async (value = listing()) => {
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(value);
};
/** The stream's opening meets `status`, as the library reports it: `onerror` answers a delay or throws to end it. */
const refuseOpening = (status: number) => fetchEventSource.mockImplementation(async (_url, options: Stream) => {
  try { await options.onopen(new Response("", { status })); }
  catch (error) { options.onerror(error); return new Promise(() => {}); }
});

/** The projected list: Task one (at work) is under Working, which is never folded. */
const listed = () => screen.findByText("Task one");

/** A shared link to a task the index does not hold: the URL names it by its ID, which the server resolves. */
const ADDRESS = "T999";
const addressRead = (url: unknown) => String(url).includes(`/api/task/view?task=${encodeURIComponent(ADDRESS)}`);
const searchCalls = (fetcher: ReturnType<typeof serveSettings>) => fetcher.mock.calls
  .filter(([url]) => String(url).startsWith("/api/task/search?"))
  .map(([url]) => new URL(String(url), "http://screen").searchParams.get("text"));

test("search entered before the first snapshot survives navigation startup", async () => {
  const fetcher = serveSettings();
  mount();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "T468" } });
  await waitFor(() => expect(useViewStore.getState().query).toBe("T468"));
  await feed();
  await waitFor(() => expect(searchCalls(fetcher)).toEqual(["t468"]));
  expect(input.value).toBe("T468");
  expect(new URL(location.href).searchParams.get("q")).toBe("T468");
});

test("search entered during startup wins over an initial URL query, then browser navigation restores the URL query", async () => {
  history.replaceState(null, "", "/?q=Old");
  const fetcher = serveSettings();
  mount();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "New" } });
  await waitFor(() => expect(useViewStore.getState().query).toBe("New"));
  await feed();
  await waitFor(() => expect(searchCalls(fetcher)).toContain("new"));
  expect(input.value).toBe("New");
  expect(new URL(location.href).searchParams.get("q")).toBe("New");
  history.replaceState(null, "", "/?q=Old");
  fireEvent.popState(window);
  await waitFor(() => expect(input.value).toBe("Old"));
  history.replaceState(null, "", "/?q=New");
  fireEvent.popState(window);
  await waitFor(() => expect(input.value).toBe("New"));
});

test("a search draft entered just before the first snapshot is not replaced by the initial URL", async () => {
  history.replaceState(null, "", "/?q=Old");
  const fetcher = serveSettings();
  mount();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "New" } });
  await feed();
  await waitFor(() => expect(searchCalls(fetcher)).toContain("new"));
  expect(input.value).toBe("New");
  expect(new URL(location.href).searchParams.get("q")).toBe("New");
});

test("clearing a startup search before the first snapshot removes the URL query", async () => {
  history.replaceState(null, "", "/?q=Old");
  const fetcher = serveSettings();
  mount();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "New" } });
  fireEvent.change(input, { target: { value: "" } });
  await feed();
  expect(input.value).toBe("");
  expect(useViewStore.getState().query).toBe("");
  expect(new URL(location.href).searchParams.get("q")).toBeNull();
  expect(searchCalls(fetcher)).toEqual([]);
});

test("searching while a shared task address resolves keeps the task link", async () => {
  history.replaceState(null, "", `/?task=${ADDRESS}&q=Old`);
  const fetcher = serveSettings();
  const original = fetcher.getMockImplementation()!;
  let release!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => addressRead(url)
    ? new Promise((resolve) => { release = resolve; }) : original(url, init));
  mount(); await feed();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => addressRead(url))).toBe(true));
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "New" } });
  // The search box's own wait, as for any search typed once the URL is shown.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(new URL(location.href).searchParams.get("task")).toBe(ADDRESS);
  expect(new URL(location.href).searchParams.get("q")).toBe("New");
  const late = tree({ tasks: [dto({ id: "T999", path: "tasks/T999" })] });
  await act(async () => release(new Response(snapshotJson(viewsOf(late)[0]!))));
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T999"));
  expect(input.value).toBe("New");
  expect(new URL(location.href).searchParams.get("task")).toBe(ADDRESS);
  expect(new URL(location.href).searchParams.get("q")).toBe("New");
});

test("search entered before the first snapshot survives repair of a pending shared task link", async () => {
  history.replaceState(null, "", `/?task=${ADDRESS}&q=Old`);
  const fetcher = serveSettings();
  const original = fetcher.getMockImplementation()!;
  let release!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => addressRead(url)
    ? new Promise((resolve) => { release = resolve; }) : original(url, init));
  mount();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "New" } });
  await feed();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => addressRead(url))).toBe(true));
  const late = tree({ tasks: [dto({ id: "T999", path: "tasks/T999" })] });
  await act(async () => release(new Response(snapshotJson(viewsOf(late)[0]!))));
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T999"));
  expect(input.value).toBe("New");
  expect(new URL(location.href).searchParams.get("q")).toBe("New");
});

test("opening another task replaces an unresolved shared task link", async () => {
  history.replaceState(null, "", `/?task=${ADDRESS}`);
  const fetcher = serveSettings();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => addressRead(url)
    ? new Promise(() => {}) : original(url, init));
  mount(); await feed();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => addressRead(url))).toBe(true));
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  await waitFor(() => expect(new URL(location.href).searchParams.get("task")).toBe("T1"));
});

test("a search typed while a Back link's task is looked up keeps that task in the URL", async () => {
  const fetcher = serveSettings();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => addressRead(url)
    ? new Promise(() => {}) : original(url, init));
  mount(); await feed();
  act(() => useViewStore.getState().openTask("T1", { reader: true }));
  await waitFor(() => expect(new URL(location.href).searchParams.get("task")).toBe("T1"));
  history.replaceState(null, "", `/?task=${ADDRESS}&q=Old`);
  fireEvent.popState(window);
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => addressRead(url))).toBe(true));
  fireEvent.change(screen.getAllByRole("searchbox")[0]!, { target: { value: "New" } });
  // The search box's own wait, then the search is written with the task still waited for.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(new URL(location.href).searchParams.get("q")).toBe("New");
  expect(new URL(location.href).searchParams.get("task")).toBe(ADDRESS);
});

test("Back to another search does not inherit an edit from a pending task link", async () => {
  history.replaceState(null, "", `/?task=${ADDRESS}&q=Old`);
  const fetcher = serveSettings();
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => addressRead(url)
    ? new Promise(() => {}) : original(url, init));
  mount(); await feed();
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => addressRead(url))).toBe(true));
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  fireEvent.change(input, { target: { value: "New" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(useViewStore.getState().query).toBe("New");
  history.replaceState(null, "", "/?task=T1&q=Other");
  fireEvent.popState(window);
  await waitFor(() => expect(input.value).toBe("Other"));
  expect(useViewStore.getState().query).toBe("Other");
  expect(new URL(location.href).searchParams.get("q")).toBe("Other");
});

test("search input stays immediate while the list, URL and request wait for the settled value", async () => {
  const fetcher = serveSettings();
  mount(); await feed(); await listed();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  const elapse = timeoutClock();
  for (const value of ["a", "al", "alp", "alpha"]) fireEvent.change(input, { target: { value } });
  expect(input.value).toBe("alpha");
  expect(useViewStore.getState().query).toBe("");
  expect(document.querySelector("[data-time-tree]")).toBeTruthy();
  expect(new URL(location.href).searchParams.get("q")).toBeNull();
  expect(searchCalls(fetcher)).toEqual([]);
  await elapse(149);
  expect(searchCalls(fetcher)).toEqual([]);
  await elapse(1);
  expect(searchCalls(fetcher)).toEqual(["alpha"]);
  expect(new URL(location.href).searchParams.get("q")).toBe("alpha");
});

test("search keeps the previous rows until the new result arrives", async () => {
  const fetcher = serveSettings();
  let release!: (response: Response) => void;
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((url, init) => String(url).includes("/api/task/search?text=other")
    ? new Promise((resolve) => { release = resolve; }) : original(url, init));
  mount(); await feed(); await listed();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  const elapse = timeoutClock();
  fireEvent.change(input, { target: { value: "Task" } });
  await elapse(150);
  expect(document.querySelector(`[data-result="T1"]`)).toBeTruthy();
  fireEvent.change(input, { target: { value: "Other" } });
  expect(document.querySelector(`[data-result="T1"]`)).toBeTruthy();
  await elapse(150);
  expect(searchCalls(fetcher)).toEqual(["task", "other"]);
  vi.useRealTimers();
  expect(document.querySelector(`[data-result="T1"]`)).toBeTruthy();
  await act(async () => release(new Response(snapshotJson(searchAnswer([])))));
  await waitFor(() => expect(document.querySelector(`[data-result="T1"]`)).toBeNull());
});

test("IME conversion does not search before composition ends", async () => {
  const fetcher = serveSettings();
  mount(); await feed(); await listed();
  const input = screen.getAllByRole("searchbox")[0]! as HTMLInputElement;
  const elapse = timeoutClock();
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: "けんさく" } });
  await elapse(180);
  expect(input.value).toBe("けんさく");
  expect(useViewStore.getState().query).toBe("");
  expect(searchCalls(fetcher)).toEqual([]);
  fireEvent.compositionEnd(input, { data: "検索" });
  fireEvent.change(input, { target: { value: "検索" } });
  await elapse(150);
  expect(searchCalls(fetcher)).toEqual(["検索"]);
});
/** The shapes drawn while the index is on its way: the app bar's project name and the list. */
const skeletons = () => screen.queryAllByRole("status", { name: i18n.t("ui:loading") }).map((element) => element.dataset.skeleton);
test.each(["pending", "retry", "stopped"])("before the first snapshot the %s state keeps the page frame", async (mode) => {
  const fetcher = serveSettings();
  if (mode !== "pending") refuseOpening(mode === "stopped" ? 403 : 503);
  mount();
  // The bars wait for nothing; the list's place is its skeleton whatever the feed meets. The line flows while it opens;
  // out of reach it stands still in grey and the bar's one mark says so, though nothing was read yet.
  const phase = { pending: "loading", retry: "offline", stopped: "offline" }[mode];
  await waitFor(() => expect(document.querySelector("[data-progress-line]")?.getAttribute("data-progress-line")).toBe(phase), { timeout: 4000 });
  expect(document.querySelectorAll("header [data-offline-mark]")).toHaveLength(mode === "pending" ? 0 : 1);
  await waitFor(() => expect(skeletons()).toEqual(["title", "time"]));
  expect(screen.queryByRole("alert")).toBeNull();
  // The settings are read for the workspace the first snapshot names, so until then the name's place is its skeleton.
  await waitFor(() => expect(skeletons()).toContain("title"));
  expect(screen.getAllByRole("searchbox")[0]!).toBeTruthy();
  // The coordinator's input stands at the foot once the workspace it writes to is read; nothing stands for it before.
  expect(document.querySelector("[data-coordinator-card]")).toBeNull();
  expect(document.querySelector("[data-time-tree]")).toBeNull();
  // No index is available yet, and there is no proven stream reachability.
  expect(useConnection.getState().offline).toBe(true);
});

/** The fixture's one project, titled `name`: the index lists it by its Task's title. */
const sendNamed = async (name: string) => {
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(listing({ tasks: [dto(), project({ title: name })] }));
};
const configReads = (fetcher: ReturnType<typeof serveSettings>) =>
  fetcher.mock.calls.filter(([url]) => new URL(String(url), "http://screen").pathname === "/api/commands/config/get").length;

// The bar does not read config.yaml for its name: it names the project the index lists. A config.yaml that
// cannot be read is no concern of the bar's: no retry beside the name, and the name is the index's.
test("settings that cannot be read leave the bar the index's project name, with no retry of its own", async () => {
  const fetcher = serveSettings();
  const respond = fetcher.getMockImplementation()!;
  // config.yaml cannot be read.
  fetcher.mockImplementation(async (url, init) => new URL(String(url), "http://screen").pathname === "/api/commands/config/get"
    ? problemResponse("read_failed", "Cannot read config.yaml") : respond(url, init));
  mount();
  await sendNamed("Alpaca screen");
  await listed();
  const bar = screen.getByRole("banner");
  const heading = within(bar).getByRole("heading");
  expect(heading.textContent).toBe("Alpaca screen");
  expect(heading.title).toBe("Alpaca screen");
  expect(within(bar).queryByText("alpacawork")).toBeNull();
  expect(within(bar).queryByRole("button", { name: i18n.t("retry") })).toBeNull();
  expect(configReads(fetcher)).toBe(0);
});

test("before the first snapshot, the offline mark's Reconnect after a refused opening brings the list", async () => {
  serveSettings();
  refuseOpening(403);
  mount();
  fireEvent.click(await waitFor(() => { const mark = document.querySelector<HTMLElement>("header [data-offline-mark]"); expect(mark).not.toBeNull(); return mark!; }, { timeout: 4000 }));
  const line = screen.getByRole("button", { name: i18n.t("chrome:notice.reconnect") });
  fetchEventSource.mockImplementation((_url, options) => { stream = options; return new Promise(() => {}); });
  const calls = fetchEventSource.mock.calls.length;
  fireEvent.click(line);
  await waitFor(() => expect(fetchEventSource.mock.calls.length).toBeGreaterThan(calls));
  await send(listing());
  await listed();
  expect(document.querySelector("[data-offline-mark]")).toBeNull();
});

test("before the first snapshot a URL naming a task draws the detail panel's shape, and the list its rows", async () => {
  serveSettings();
  history.replaceState(null, "", "/?task=T1");
  mount();
  await waitFor(() => expect(document.querySelector('[data-skeleton="reader"]')).toBeTruthy());
  expect(document.querySelector('[data-skeleton="time"]')).toBeTruthy();
  expect(screen.queryByRole("complementary")).toBeNull();
  await feed();
  await waitFor(() => expect(document.querySelector("[data-skeleton]")).toBeNull());
  expect(screen.getByRole("complementary")).toBeTruthy();
});

/** T1 is unread while its served row differs from what the reader last read (the server checkpoint and reads). */
const unread = () => {
  const { checkpoint, reads } = useReadStore.getState();
  return !readTaskIds(served.tasks.map((task) => rowOf(task, served)), checkpoint, reads).has("T1");
};
const unreadMark = () => expect(unread()).toBe(true);
const allRead = () => waitFor(() => expect(unread()).toBe(false));

test("a failed initial read says the screen could not be shown and reads both again on retry", async () => {
  const fetcher = serveSettings();
  const respond = fetcher.getMockImplementation()!;
  let personal = 0, notices = 0;
  fetcher.mockImplementation(async (url, init) => {
    if (String(url) === "/api/commands/settings/get" && personal++ === 0 ||
        String(url) === "/api/person/notices" && notices++ === 0)
      return problemResponse("unavailable");
    return respond(url, init);
  });
  mount(); await feed();
  // serve's failure that asking again will not mend by itself: what happened, why, and the retry.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(i18n.t("panels:workspaceStop.failed"));
  expect(alert.textContent).toContain(i18n.t("panels:workspaceStop.failedHint"));
  expect(personal).toBe(1);
  expect(notices).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("retry") }));
  await listed();
  expect(personal).toBe(2);
  expect(notices).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("received changes, opening, and mark all use the server checkpoint", async () => {
  serveSettings();
  mount(); await feed(); await listed();
  const changed = dto({ state: "waiting", hash: "c".repeat(64) });
  await send(listing({ tasks: [changed] }), "a:2");
  await waitFor(unreadMark);
  fireEvent.click(document.querySelector<HTMLElement>(`[data-read="T1"]`)!);
  await allRead();
  const saved = await (await fetch("/api/person/notices")).json();
  expect(saved.state.reads["T1"]).toEqual(taskBaseline(rowOf(changed)));
  const reported = { ...changed, log: [...changed.log, logEntry({ id: "L2", kind: "reported", at: "2026-09-25T10:00:00Z", title: "Another report" })] };
  await send(listing({ tasks: [reported] }), "a:3");
  await waitFor(unreadMark);
  act(() => useViewStore.getState().setQuery("Task"));
  fireEvent.click(await screen.findByRole("button", { name: "Mark all read" }));
  act(() => useViewStore.getState().clearSearch());
  await allRead();
  expect((await (await fetch("/api/person/notices")).json()).state.reads).toEqual({});
});

test("a notice revision refreshes the server state while focus alone does not", async () => {
  const fetcher = serveSettings(); mount(); await feed(); await listed();
  const changed = dto({ state: "waiting" });
  await send(listing({ tasks: [changed] }), "a:2");
  await waitFor(unreadMark);
  const current = await (await fetch("/api/person/notices")).json();
  const saved = await (await fetch("/api/person/notices/save", { method: "POST", body: JSON.stringify({
    state: { ...current.state, reads: { T1: taskBaseline(rowOf(changed)) } }, expectedRevision: current.revision,
  }) })).json();
  const before = fetcher.mock.calls.filter(([url]) => String(url) === "/api/person/notices").length;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/person/notices")).toHaveLength(before);
  await send(listing({ tasks: [changed] }), "a:3", { settings: "person-1", notices: saved.revision, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } });
  await allRead();
  expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/person/notices")).toHaveLength(before + 1);
});

test("a personal settings revision reloads once and an unchanged revision does not", async () => {
  const fetcher = serveSettings();
  const respond = fetcher.getMockImplementation()!;
  let revision = 'person-1', theme = 'light';
  fetcher.mockImplementation((url, init) => String(url) === '/api/commands/settings/get'
    ? Promise.resolve(new Response(snapshotJson({ values: { ...defaultSettings(), theme }, revision })))
    : respond(url, init));
  mount();
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(listing(), 'a:1', { settings: revision, notices: null, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } });
  await listed();
  const calls = () => fetcher.mock.calls.filter(([url]) => String(url) === '/api/commands/settings/get').length;
  expect(calls()).toBe(1);
  revision = 'person-2'; theme = 'dark';
  await send(listing(), 'a:2', { settings: revision, notices: null, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } });
  await waitFor(() => expect(usePersonalSettings.getState().values.theme).toBe('dark'));
  expect(calls()).toBe(2);
  await send(listing(), 'a:3', { settings: revision, notices: null, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } });
  expect(calls()).toBe(2);
});

// This test observes two no-poll windows (1.7s + 1.5s), a retry and startup; 5s cannot contain its
// explicit observation budget under the full UTC suite's load. Keep the waits and give the case its own budget.
test("the coordinator's conversation is read when the index says it changed; not on a timer", async () => {
  const fetcher = serveSettings();
  const respond = fetcher.getMockImplementation()!;
  let failNext = false;
  fetcher.mockImplementation((url, init) => String(url) !== "/api/coordinator" ? respond(url, init)
    : failNext ? (failNext = false, Promise.reject(new TypeError("offline")))
    : Promise.resolve(new Response(snapshotJson({ id: "conversation-1", nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns: [] }))));
  const reads = () => fetcher.mock.calls.filter(([url]) => String(url) === "/api/coordinator").length;
  mount();
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(listing(), "a:1", { settings: null, notices: null, coordinator: { id: 'conversation-1', revision: '0'.repeat(64) } });
  await listed();
  // The input stands at the foot from the start, so each version the index announces is read, once, when it is said.
  const first = reads();
  await send(listing(), "a:2", { settings: null, notices: null, coordinator: { id: 'conversation-1', revision: '1'.repeat(64) } });
  await waitFor(() => expect(reads()).toBe(first + 1));
  await act(async () => { await useConversation.getState().refresh(); });
  expect(reads()).toBe(first + 2);
  await send(listing(), "a:3", { settings: null, notices: null, coordinator: { id: 'conversation-1', revision: '2'.repeat(64) } });
  await waitFor(() => expect(reads()).toBe(first + 3));
  await send(listing(), "a:4", { settings: null, notices: null, coordinator: { id: 'conversation-1', revision: '2'.repeat(64) } });
  await new Promise((done) => setTimeout(done, 1700));
  expect(reads()).toBe(first + 3);
  // A read of a newly announced version that fails is tried again without another announcement.
  failNext = true;
  await send(listing(), "a:5", { settings: null, notices: null, coordinator: { id: 'conversation-1', revision: '3'.repeat(64) } });
  await waitFor(() => expect(reads()).toBe(first + 4));
  await waitFor(() => expect(reads()).toBe(first + 5), { timeout: 3000 });
  await new Promise((done) => setTimeout(done, 1500));
  expect(reads()).toBe(first + 5);
  expect(useConversation.getState().error).toBeNull();
}, 15_000);

test("startup uses ordinary task, search and theme URLs; scene has no product behavior", async () => {
  history.replaceState(null, "", "/?task=T1&scene=edit&q=Task&theme=dark");
  serveSettings();
  mount();
  await feed(listing({ tasks: [dto(), dto({ id: "T111", parentId: "T1", path: "tasks/T111", title: "Scene task" })] }));
  await screen.findByRole("complementary", { name: "Full text of the task" });
  expect(useViewStore.getState().selected).toBe("T1");
  expect(screen.queryByRole("textbox", { name: "本文" })).toBeNull();
  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(useViewStore.getState().query).toBe("Task");
});

test("a partial tree from a Run store awaiting explicit migration is shown read-only with its error", async () => {
  const preflight = JSON.parse(readFileSync(join(import.meta.dirname, "../../../tests/fixtures/contract-examples/read-preflight.json"), "utf8")) as {
    tree: Pick<ControlTreeDTO, "writable" | "errors">;
  };
  serveSettings();
  mount();
  // The Run store is unreadable, so no people or runs: only the tasks, not writable, with the reason.
  await feed(listing({ ...preflight.tree, placements: [], runs: [], requests: [] }));
  await listed();
  expect(screen.getByText(i18n.t("chrome:notice.unreadableOne", { path: ".alpacawork/alpacawork.sqlite" }))).toBeTruthy();
  // Not writable, the coordinator's input stands folded to its line, and the line does not bring it up.
  await waitFor(() => expect(document.querySelector<HTMLButtonElement>("[data-coordinator-write]")?.disabled).toBe(true));
  act(() => useDialogStore.getState().open("diagnostics"));
  expect(await screen.findByText(/The database needs an explicit migration. The existing database is kept/)).toBeTruthy();
});

test("a task the URL names, still being looked up: the reader stands waiting for it, says so when the lookup fails, asks again, and opens it in the same frame", async () => {
  history.replaceState(null, "", `/?task=${ADDRESS}`);
  const fetcher = serveSettings();
  const original = fetcher.getMockImplementation()!;
  let asked = 0;
  let found!: (response: Response) => void;
  fetcher.mockImplementation((url, init) => {
    if (!addressRead(url)) return original(url, init);
    asked++;
    return asked === 1 ? Promise.resolve(problemResponse("io_failure", "The server could not answer"))
      : new Promise((resolve) => { found = resolve; });
  });
  mount(); await feed();
  const frame = await waitFor(() => { const aside = document.querySelector<HTMLElement>("[data-reader-awaiting]"); expect(aside).toBeTruthy(); return aside!; });
  expect(frame.dataset.readerAwaiting).toBe(ADDRESS);
  expect(useViewStore.getState().selected).toBeNull();
  // The lookup failed: the URL stays, and the reader says so with a way to ask again.
  const retry = await screen.findByRole("button", { name: i18n.t("retry") });
  expect(new URL(location.href).searchParams.get("task")).toBe(ADDRESS);
  fireEvent.click(retry);
  await waitFor(() => expect(asked).toBe(2));
  const late = tree({ tasks: [dto({ id: "T999" })] });
  await act(async () => found(new Response(snapshotJson(viewsOf(late)[0]!))));
  await waitFor(() => expect(useViewStore.getState().selected).toBe("T999"));
  expect(document.querySelector("[data-reader-awaiting]")).toBeNull();
  expect(document.querySelector("[data-reader-task-id]")?.textContent).toContain("T999");
  expect(new URL(location.href).searchParams.get("task")).toBe(ADDRESS);
});

test("a phone's sheet stays the same sheet while the task a link names is looked up, and its × closes it", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes("700px"), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  try {
    const fetcher = serveSettings();
    const before = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) => addressRead(url) ? new Promise(() => {}) : before(url, init));
    mount(); await feed();
    act(() => useViewStore.getState().openTask("T1", { reader: true }));
    const sheet = await waitFor(() => { const frame = document.querySelector<HTMLElement>("[data-sheet]"); expect(frame).toBeTruthy(); return frame!; });
    act(() => { history.pushState(null, "", `/?task=${ADDRESS}`); fireEvent.popState(window); });
    await waitFor(() => expect(document.querySelector("[data-reader-awaiting]")).toBeTruthy());
    expect(document.querySelector("[data-sheet]")).toBe(sheet);
    fireEvent.click(within(document.querySelector<HTMLElement>("[data-reader-awaiting]")!).getByRole("button", { name: i18n.t("reader:readerHeader.close") }));
    await waitFor(() => expect(useViewStore.getState().reader.open).toBe(false));
  } finally { window.matchMedia = original; }
});

/** Each read of the coordinator's conversation waits for `answer()` (a promise this case settles), the rest as usual. */
let unsettled: { reject: () => void }[] = [];
const holdConversation = (failure: () => Response = () => problemResponse("busy")) => {
  // What an earlier case left waiting ends, so its read is not still under way here.
  unsettled.forEach(each => each.reject());
  const fetcher = serveSettings();
  const respond = fetcher.getMockImplementation()!;
  const held: { resolve: (turns?: CoordinatorTurn[]) => void; reject: () => void; serverFailure: () => void }[] = [];
  fetcher.mockImplementation((url, init) => String(url) !== "/api/coordinator" ? respond(url, init)
    : new Promise<Response>((resolve, reject) => held.push({
      resolve: (turns = []) => resolve(new Response(snapshotJson({ id: "conversation-1", nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns }))),
      reject: () => reject(new TypeError("offline")), serverFailure: () => resolve(failure()) })));
  // A visit of its own: no conversation read yet, nothing pressed.
  setConversationState({ root: "", conversation: null, error: null, wanted: false, open: false, expanded: false });
  unsettled = held;
  return { held, reads: () => fetcher.mock.calls.filter(([url]) => String(url) === "/api/coordinator").length };
};
const line = () => document.querySelector<HTMLButtonElement>("[data-coordinator-write]")!;
const drawn = async (version: string, turns?: CoordinatorTurn[]) => {
  mount();
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  await send(listing(), "a:1", { settings: null, notices: null, coordinator: { id: 'conversation-1', revision: turns ? conversationSnapshot({ id: 'conversation-1', nextLaunch: { agent: 'claude', values: {} }, ...SERVED, busy: false, admitted: {}, cancelled: [], turns }).revision : conversationRevision(version) } });
  await listed();
  await waitFor(() => expect(line()).toBeTruthy());
};

test("a first read of the conversation answered after the screen is drawn is shown, and the line is pressed at once", async () => {
  const { held, reads } = holdConversation();
  await drawn("first-read-late");
  // Asked in the workspace it is answered in: the late answer is kept, without another read.
  expect(useConversation.getState().root).toBe("/fixture");
  expect(line().disabled).toBe(false);
  await waitFor(() => expect(line().dataset.coordinatorLoading).toBe("loading"));
  expect(document.querySelector("[data-coordinator-capsule] [role=status]")?.textContent).toContain("Loading the conversation");
  await act(async () => { held[0]!.resolve(); });
  await waitFor(() => expect(useConversation.getState().conversation?.id).toBe("conversation-1"));
  expect(reads()).toBe(1);
  expect(line().dataset.coordinatorLoading).toBeUndefined();
  expect(useConversation.getState().open).toBe(false);
});

test("pressed while the conversation is read, the input comes up once it is; Esc meanwhile takes the press back", async () => {
  const { held } = holdConversation();
  await drawn("first-read-wanted");
  fireEvent.click(line());
  await waitFor(() => expect(line().dataset.coordinatorLoading).toBe("wanted"));
  await act(async () => { held.forEach(each => each.resolve()); });
  await waitFor(() => expect(useConversation.getState().open).toBe(true));
  expect(useConversation.getState().wanted).toBe(false);
  cleanup();
  const again = holdConversation();
  await drawn("first-read-taken-back");
  fireEvent.click(line());
  await waitFor(() => expect(line().dataset.coordinatorLoading).toBe("wanted"));
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(useConversation.getState().wanted).toBe(false));
  await act(async () => { again.held.forEach(each => each.resolve()); });
  await waitFor(() => expect(useConversation.getState().conversation).not.toBeNull());
  expect(useConversation.getState().open).toBe(false);
});

const savedTurns: CoordinatorTurn[] = [{ id: 'saved-turn', at: '2026-10-26T00:00:00Z', ask: 'Saved question',
  attachments: [], status: 'succeeded', waiting: false, answer: 'Saved conversation answer', seen: true,
  answeredAt: '2026-10-26T00:00:01Z', error: null, result: null }];
const conversationQuery = () => readQuery(queryClient, ['coordinator', '/fixture'])!;
const readFailures = () => useToasts.getState().toasts.filter(toast => toast.id === 'coordinator-read');
const settledConversationFailure = async (saved: boolean, code = "network_error") => {
  await waitFor(() => expect(conversationQuery().state).toMatchObject({ status: 'error', fetchStatus: 'idle',
    error: expect.objectContaining({ code, ...(code === 'network_error' ? { cause: expect.any(TypeError) } : {}) }) }));
  expect(useConversation.getState().conversation === null).toBe(!saved);
  if (vi.isFakeTimers()) await act(async () => { await vi.advanceTimersByTimeAsync(0); });
};

test('acquired chat survives an actually failed refresh without notification', async () => {
  const { held, reads } = holdConversation();
  // Announce the server revision of the actual response, so this tests a current saved value.
  await drawn('failure-saved', savedTurns);
  await act(async () => { held[0]!.resolve(savedTurns); });
  await waitFor(() => expect(document.querySelector('[data-coordinator-pill]')?.textContent).toContain('Saved conversation answer'));
  const saved = conversationQuery().state.data;
  for (let attempt = 1; attempt <= 2; attempt++) {
    act(() => { void useConversation.getState().refresh(); });
    await waitFor(() => expect(reads()).toBe(attempt + 1));
    await act(async () => { held[attempt]!.reject(); });
    await settledConversationFailure(true);
    expect(conversationQuery().state.data).toBe(saved);
    expect(document.querySelector('[data-coordinator-pill]')?.textContent).toContain('Saved conversation answer');
    expect(readFailures()).toHaveLength(0);
  }
});

for (const hidden of [false, true]) test(`an unsaved server failure ends with its workspace, hidden=${hidden}`, async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { held, reads } = holdConversation();
  await drawn('failure-unsaved', []);
  for (let attempt = 0; attempt <= 5; attempt++) {
    await waitFor(() => expect(reads()).toBe(attempt + 1));
    await act(async () => { held[attempt]!.serverFailure(); });
    if (attempt < 5) await act(async () => { await vi.advanceTimersByTimeAsync(1_000 * 2 ** attempt); });
  }
  await settledConversationFailure(false, 'busy');
  await waitFor(() => expect(readFailures()).toHaveLength(1));
  if (hidden) act(() => notify.hide('coordinator-read'));
  act(() => useConversation.setState({ root: '/other' }));
  expect(useConversation.getState().error).toBeNull();
  expect(readFailures()).toHaveLength(0);
  act(() => useConnection.setState({ offline: true })); act(() => useConnection.setState({ offline: false }));
  expect(readFailures()).toHaveLength(0);
});

test('unsaved server failures keep backoff, Retry pending, hiding and successful opening', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { held, reads } = holdConversation();
  await drawn('first-read-failed', []);
  const rejectRead = async (first: number) => {
    for (let attempt = 0; attempt <= 5; attempt++) {
      await waitFor(() => expect(reads()).toBe(first + attempt + 1));
      await act(async () => { held[first + attempt]!.serverFailure(); });
      if (attempt < 5) await act(async () => { await vi.advanceTimersByTimeAsync(1_000 * 2 ** attempt); });
    }
    await settledConversationFailure(false, 'busy');
  };
  await act(async () => { held[0]!.serverFailure(); });
  await waitFor(() => expect(useConversation.getState().error).not.toBeNull());
  expect(conversationQuery().state.data).toBeUndefined();
  expect(useConversation.getState().trying).toBe(true);
  expect(line().dataset.coordinatorLoading).toBe('loading');
  expect(readFailures()).toHaveLength(0);
  for (let attempt = 1; attempt <= 5; attempt++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000 * 2 ** (attempt - 1)); });
    await waitFor(() => expect(reads()).toBe(attempt + 1));
    expect(line().getAttribute('aria-busy')).toBe('true');
    await act(async () => { held[attempt]!.serverFailure(); });
  }
  await settledConversationFailure(false, 'busy');
  await waitFor(() => expect(readFailures()).toHaveLength(1));
  expect(readFailures()[0]).toMatchObject({ kind: 'error', text: 'Could not load the conversation', action: { label: 'Retry' } });
  expect(line().dataset.coordinatorLoading).toBeUndefined();
  expect(document.querySelector('[data-coordinator-capsule] .text-error')).toBeNull();
  let first = reads();
  act(() => { void useConversation.getState().refresh(); });
  await waitFor(() => expect(reads()).toBe(first + 1));
  expect(readFailures()).toHaveLength(0);
  await rejectRead(first);
  await waitFor(() => expect(readFailures()).toHaveLength(1));
  act(() => useConnection.setState({ offline: true }));
  expect(readFailures()).toHaveLength(0);
  first = reads(); act(() => useConnection.setState({ offline: false }));
  await rejectRead(first);
  await waitFor(() => expect(readFailures()).toHaveLength(1));
  act(() => notify.hide('coordinator-read'));
  first = reads(); act(() => { void useConversation.getState().refresh(); });
  await rejectRead(first);
  expect(readFailures()).toHaveLength(0);
  first = reads(); act(() => useConversation.getState().retry());
  await rejectRead(first);
  await waitFor(() => expect(readFailures()).toHaveLength(1));
  first = reads(); act(() => readFailures()[0]!.action!.run());
  // The toast must still occupy its place in the very same click, before another paint.
  expect(readFailures()).toHaveLength(1);
  expect(readFailures()[0]).toMatchObject({ kind: 'pending', text: 'Loading the conversation…' });
  expect(readFailures()[0]!.action).toBeUndefined();
  await rejectRead(first);
  await waitFor(() => expect(readFailures()[0]).toMatchObject({ kind: 'error', action: { label: 'Retry' } }));
  expect(readFailures()).toHaveLength(1);
  first = reads(); act(() => readFailures()[0]!.action!.run()); act(() => notify.hide('coordinator-read'));
  await rejectRead(first);
  expect(readFailures()).toHaveLength(0);
  first = reads(); fireEvent.click(line());
  await waitFor(() => expect(line().dataset.coordinatorLoading).toBe('wanted'));
  expect(reads()).toBe(first + 1);
  await act(async () => { held[first]!.resolve(); });
  await waitFor(() => expect(useConversation.getState().open).toBe(true));
  expect(readFailures()).toHaveLength(0);
});

test('a conversation transport failure stays with the offline surface and rereads on recovery', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { held, reads } = holdConversation();
  await drawn('network-quiet', []);
  for (let attempt = 0; attempt <= 5; attempt++) {
    await waitFor(() => expect(reads()).toBe(attempt + 1));
    await act(async () => { held[attempt]!.reject(); });
    if (attempt < 5) await act(async () => { await vi.advanceTimersByTimeAsync(1_000 * 2 ** attempt); });
  }
  await settledConversationFailure(false);
  expect(readFailures()).toHaveLength(0);
  const first = reads();
  act(() => useConnection.setState({ offline: true }));
  act(() => useConnection.setState({ offline: false }));
  await waitFor(() => expect(reads()).toBeGreaterThan(first));
  await act(async () => { held[first]!.resolve(savedTurns); });
  await waitFor(() => expect(useConversation.getState().error).toBeNull());
  expect(readFailures()).toHaveLength(0);
});

/** Serves the first page with what it reads refused by `refusal` until `failing` is cleared. */
function refuseFirstReads(refusal: () => Response) {
  const fetcher = serveSettings(), respond = fetcher.getMockImplementation()!;
  const state = { failing: true };
  fetcher.mockImplementation(async (url, init) => state.failing && String(url) === '/api/commands/settings/get' ? refusal() : respond(url, init));
  return state;
}

test('a serve that does not answer yet is waited for without a retry button', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  await i18n.changeLanguage('en');
  const state = refuseFirstReads(() => problemResponse('busy'));
  mount(); await feed();
  await waitFor(() => expect(document.querySelector('[data-message-size="page"]')?.textContent).toContain(i18n.t('panels:workspaceStop.unreachable')));
  expect(screen.queryByRole('button', { name: i18n.t('retry') })).toBeNull();
  state.failing = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  await listed();
  expect(document.querySelector('[data-message-size="page"]')).toBeNull();
});

test('a page from another version than serve opens itself again once, then offers the reload', async () => {
  await i18n.changeLanguage('en');
  sessionStorage.removeItem('alpacawork:reloaded-for-version');
  refuseFirstReads(() => new Response(JSON.stringify({ error: { code: 'not_found', message: 'Unknown endpoint', retry: 'fix', reason: { kind: 'unknown_endpoint' } } }), { status: 404 }));
  mount(); await feed();
  await waitFor(() => expect(document.querySelector('[data-message-size="page"]')?.textContent).toContain(i18n.t('panels:workspaceStop.reloading')));
  expect(sessionStorage.getItem('alpacawork:reloaded-for-version')).not.toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  // The page opened again within the minute still does not match: it does not loop, it offers the one press.
  cleanup(); queryClient.clear(); stopRequired?.(); stopRequired = startRequiredReadSession(queryClient);
  useReadStore.setState(useReadStore.getInitialState(), true); usePersonalSettings.setState(usePersonalSettings.getInitialState(), true);
  mount(); await feed();
  expect(await screen.findByRole('button', { name: i18n.t('panels:update.reload') })).toBeTruthy();
  sessionStorage.removeItem('alpacawork:reloaded-for-version');
});

for (const lang of ['en', 'ja'] as const) test(`mark all read failure uses the adopted honest ${lang} notice`, async () => {
  const fetcher = serveSettings(), respond = fetcher.getMockImplementation()!;
  let failed = false;
  fetcher.mockImplementation(async (url, init) => failed && String(url) === '/api/person/notices/save' ? problemResponse('unavailable') : respond(url, init));
  mount(); await feed(); await listed();
  await send(listing({ tasks: [dto({ state: 'waiting', hash: 'c'.repeat(64) })] }), 'a:2');
  await waitFor(unreadMark);
  act(() => useViewStore.getState().setQuery('Task'));
  await screen.findByRole('button', { name: 'Mark all read' });
  await i18n.changeLanguage(lang);
  failed = true;
  const notice = vi.spyOn(notify, 'error');
  fireEvent.click(await screen.findByRole('button', { name: lang === 'en' ? 'Mark all read' : i18n.t('chrome:gathered.markAllRead') }));
  await waitFor(() => expect(notice).toHaveBeenCalledWith(lang === 'en' ? 'Could not mark as read. Reload to check.' : '既読にできませんでした。再読み込みして確認してください。', { id: 'read-failed' }));
  await unreadMark();
  await i18n.changeLanguage('en');
});

test('one actual native recovery joins required settings/notices reads and conversation refresh once', async () => {
  const fetcher = serveSettings(), respond = fetcher.getMockImplementation()!;
  const paths = ['/api/commands/settings/get', '/api/person/notices', '/api/coordinator'];
  let failed = false;
  fetcher.mockImplementation(async (url, init) => failed && paths.includes(String(url)) ? problemResponse('unavailable') : respond(url, init));
  mount(); await feed(); await listed();
  failed = true;
  await act(async () => {
    await queryClient.refetchQueries({ type: 'active', predicate: q => ['person-settings', 'person-notices'].includes(String(q.queryKey[0])) });
    await useConversation.getState().refresh();
  });
  expect(useConversation.getState().error).toBeTruthy();
  const old = stream;
  act(() => window.dispatchEvent(new Event('offline')));
  expect(useConnection.getState().offline).toBe(true);
  failed = false;
  const before = Object.fromEntries(paths.map(path => [path, fetcher.mock.calls.filter(([url]) => String(url) === path).length]));
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(stream).not.toBe(old));
  expect(useConnection.getState().offline).toBe(true);
  await act(async () => stream.onopen(new Response('', { headers: { 'content-type': 'text/event-stream' } })));
  await waitFor(() => expect(useConnection.getState().offline).toBe(false));
  await waitFor(() => expect(useConversation.getState().error).toBeNull());
  for (const path of paths) expect(fetcher.mock.calls.filter(([url]) => String(url) === path).length - before[path]!, path).toBe(1);
});

// The feed stays live while an update holds the workspace; once it is put back, the refused reads are read again.
test("a workspace held by an update comes back by itself once it can be read again, even while the status still asks for the person", async () => {
  let maintenance = true;
  let status:any = {kind:"applying",opId:"4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11",version:"0.10.0"};
  const fetcher=serveSettings(), respond=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url,init) => {
    const path=String(url);
    if(path==="/api/update/status") return Response.json(status);
    if(maintenance && ["/api/commands/settings/get","/api/person/notices"].includes(path))
      return Response.json({error:{code:"unavailable",message:"maintenance",retry:"later",reason:{kind:"release_maintenance_incomplete"}}},{status:503});
    return respond(url,init);
  });
  mount(); await feed();
  await waitFor(()=>expect(usePersonalSettings.getState().status).toBe("error"));
  await waitFor(()=>expect(document.querySelector("[data-update-state]")?.textContent).toContain("0.10.0"));
  const before=fetcher.mock.calls.filter(([url])=>["/api/commands/settings/get","/api/person/notices"].includes(String(url))).length;
  // Put back, the release may still say it needs the person (no reason told): the page asks again by itself.
  maintenance=false;
  status={kind:"attention",opId:status.opId,version:"0.10.0"};
  await act(async()=>{queryClient.setQueryData(["update-status",""],status);queryClient.setQueryData(["update-status","/fixture"],status);});
  await new Promise(resolve=>setTimeout(resolve,10_500));
  const after=fetcher.mock.calls.filter(([url])=>["/api/commands/settings/get","/api/person/notices"].includes(String(url))).length;
  expect(after).toBeGreaterThan(before);
  await listed();
}, 30_000);

// The full held page outlives the conversation's normal read backoff.
const heldConversationR3 = async () => {
  vi.useFakeTimers({shouldAdvanceTime:true});
  const refused=()=>Response.json({error:{code:"unavailable",message:"maintenance",retry:"later",reason:{kind:"release_maintenance_incomplete"}}},{status:503});
  const conversation=holdConversation(refused);
  let maintenance=true;
  let status:any={kind:"applying",opId:"4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11",version:"0.10.0"};
  const fetcher=vi.mocked(globalThis.fetch),respond=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url,init)=>{
    const path=String(url);
    if(path==="/api/update/status")return Response.json(status);
    if(maintenance && ["/api/commands/settings/get","/api/person/notices"].includes(path))return refused();
    return respond(url,init);
  });
  mount();await feed();
  await waitFor(()=>expect(usePersonalSettings.getState().status).toBe("error"));
  for(let attempt=0;attempt<=5;attempt++){
    await waitFor(()=>expect(conversation.reads()).toBe(attempt+1));
    await act(async()=>{conversation.held[attempt]!.serverFailure();});
    if(attempt<5)await act(async()=>{await vi.advanceTimersByTimeAsync(1000*2**attempt);});
  }
  await settledConversationFailure(false,"unavailable");
  expect(useConnection.getState().state).toBe("live");
  return {...conversation, finish:async()=>{
    maintenance=false;
    status={kind:"failed",candidateId:"c1",version:"0.10.0"};
    await act(async()=>{queryClient.setQueryData(["update-status",""],status);queryClient.setQueryData(["update-status","/fixture"],status);});
  }};
};
test("the conversation refused while an update holds the workspace puts no retry notice over the held page",async()=>{
  await heldConversationR3();
  expect(readFailures()).toHaveLength(0);
});
test("once the update no longer holds the workspace, the conversation it refused is read again by itself",async()=>{
  const test=await heldConversationR3();
  const before=test.reads();
  await test.finish();
  await listed();
  await waitFor(()=>expect(test.reads()).toBeGreaterThan(before));
  await act(async()=>{test.held[before]!.resolve();});
  await waitFor(()=>expect(useConversation.getState().error).toBeNull());
});

test("a page already showing the workspace turns into the held page when its reads are refused for an update", async () => {
  let maintenance = false;
  const fetcher = serveSettings(), respond = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === "/api/update/status") return Response.json({ kind: "attention", opId: "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", version: "0.10.0" });
    if (maintenance && ["/api/commands/settings/get", "/api/person/notices"].includes(path))
      return Response.json({ error: { code: "unavailable", message: "maintenance", retry: "later", reason: { kind: "release_maintenance_incomplete" } } }, { status: 503 });
    return respond(url, init);
  });
  mount(); await feed(); await listed();
  await waitFor(() => expect(usePersonalSettings.getState().status).toBe("ready"));
  maintenance = true;
  await act(async () => { await queryClient.refetchQueries({ type: "active" }); });
  await waitFor(() => expect(queryClient.getQueryState(["person-settings", "/fixture"])?.status).toBe("error"));
  expect(document.querySelector("[data-update-state]"), "release refusal must show the full held page with Continue").not.toBeNull();
  expect(screen.queryByText("Task one")).toBeNull();
});

test("the held page still says what it waits for while the update status cannot be read", async () => {
  const fetcher = serveSettings(), respond = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === "/api/update/status") return problemResponse("unavailable", "status unreadable");
    if (["/api/commands/settings/get", "/api/person/notices"].includes(path))
      return Response.json({ error: { code: "unavailable", message: "maintenance", retry: "later", reason: { kind: "release_maintenance_incomplete" } } }, { status: 503 });
    return respond(url, init);
  });
  mount(); await feed();
  await waitFor(() => expect(usePersonalSettings.getState().status).toBe("error"));
  await waitFor(() => expect(document.querySelector("[data-version-line]")).not.toBeNull());
  expect(document.querySelector("[data-update-state]")?.textContent, "the held page must retain an explanation without status").not.toBe("");
});

test("a held page that showed earlier values reads the refused settings again and returns", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let maintenance = false;
  const fetcher = serveSettings(), respond = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === "/api/update/status") return Response.json({ kind: "attention", opId: "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", version: "0.10.0" });
    if (maintenance && ["/api/commands/settings/get", "/api/person/notices"].includes(path))
      return Response.json({ error: { code: "unavailable", message: "maintenance", retry: "later", reason: { kind: "release_maintenance_incomplete" } } }, { status: 503 });
    return respond(url, init);
  });
  mount(); await feed(); await listed();
  await waitFor(() => expect(usePersonalSettings.getState().status).toBe("ready"));
  maintenance = true;
  await act(async () => { await queryClient.refetchQueries({ type: "active" }); });
  await waitFor(() => expect(queryClient.getQueryState(["person-settings", "/fixture"])?.status).toBe("error"));
  const before = fetcher.mock.calls.filter(([url]) => String(url) === "/api/commands/settings/get").length;
  maintenance = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
  expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/commands/settings/get").length, "10-second retry must reach the server despite retained settings data").toBeGreaterThan(before);
  await listed();
  expect(document.querySelector("[data-version-line]")).toBeNull();
});
