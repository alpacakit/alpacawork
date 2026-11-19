import { INDEX_HEARTBEAT_MS } from "@alpacawork/contract/control";
import { test, expect, vi, afterAll, afterEach, beforeAll, beforeEach } from "vitest";
// The feed may already be cached by another file in a shared worker.
vi.hoisted(() => vi.resetModules());
import { onlineManager, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ProjectedIndexDTO } from "@alpacawork/contract/control";
import { serverPatch } from "./receipt-fixture";
import { i18n, startI18n } from "@alpacawork/i18n";
import { ApiError } from "../src/data/client";
import { queryClient } from "../src/data/query-client";
import { SILENT_STREAM_MS, UNANSWERED_TRY_MS, useWorkspace } from "../src/data/feed";
import { canSendWrites, onBackInReach, useConnection } from "../src/data/connection";
import { useWriteDisabled } from "../src/data/queries";
import { ProgressLine } from "../src/features/chrome/ProgressLine";
import { useToasts } from "../src/lib/notify";
import { OFFLINE_SHOWN_AFTER_MS } from "../src/data/reach";
import { render } from "@testing-library/react";
import { dto, indexOf, PROJECT_TASK, tree } from "./fixtures";
import { ReadableStream as WebReadableStream, TransformStream as WebTransformStream } from "node:stream/web";

/**
 * The reconnection policy of the update feed. The index, and every change after it,
 * arrives on the stream (`/api/events`). Playwright only ever sees the
 * live state ("Receiving updates"); asking the real server to drop a stream, answer
 * with the wrong content type, or refuse a subscription five times in a row is
 * not something the visual baseline can arrange. `node --test` can load this
 * .ts but cannot render a hook.
 */

const { fetchEventSource } = vi.hoisted(() => ({ fetchEventSource: vi.fn() }));
vi.mock("@microsoft/fetch-event-source", () => ({ fetchEventSource }));

type Options = Parameters<typeof fetchEventSource>[1];

/** The index an `index` event carries. */
const snapshot: ProjectedIndexDTO = indexOf(tree());

beforeAll(() => {
  startI18n();
});
beforeEach(() => {
  onlineManager.setOnline(true);
  queryClient.clear();
  fetchEventSource.mockReset();
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});
afterAll(() => { vi.doUnmock("@microsoft/fetch-event-source"); vi.resetModules(); });

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

/** What one opening of the stream meets: the server's response, or a network failure. */
type Answer = Response | Error;
const eventStream = () => new Response("", { headers: { "content-type": "text/event-stream" } });
const html = () => new Response("HTML", { headers: { "content-type": "text/html" } });
type Subscription = {
  options: Options;
  /** An `index` (or `patch`) event, delivered as the library does: a throw from `onmessage` fails the subscription. */
  send: (data: string, event?: "index" | "patch") => void;
  /** The open stream fails (dropped, closed, unreadable), as the library reports it. */
  fail: (error: unknown) => void;
};

/**
 * `fetchEventSource`'s loop as far as the feed relies on it: open and hand the
 * response to `onopen`; on an error wait what `onerror` answers and open again;
 * a throw from `onerror` ends the subscription with that error.
 */
function mount(answer: () => Answer = eventStream) {
  const subscriptions: Subscription[] = [];
  let opens = 0;
  fetchEventSource.mockImplementation((url: string, options: Options) => {
    expect(url).toBe("/api/events");
    return new Promise<void>((_resolve, reject) => {
      const fail = (error: unknown) => {
        if (options.signal.aborted) return;
        try { setTimeout(() => void open(), options.onerror(error)); } catch (fatal) { reject(fatal); }
      };
      const open = async () => {
        if (options.signal.aborted) return;
        opens++;
        try {
          const response = answer();
          if (response instanceof Error) throw response;
          await options.onopen(response);
        } catch (error) { fail(error); }
      };
      subscriptions.push({
        options, fail,
        send: (data, event = "index") => { try { options.onmessage({ id: "", event, data }); } catch (error) { fail(error); } },
      });
      void open();
    });
  });
  const view = renderHook(() => useWorkspace(), { wrapper });
  return { view, current: () => subscriptions.at(-1), subscriptions: () => subscriptions.length, opens: () => opens };
}
const snapshotData = (value: ProjectedIndexDTO = snapshot) => JSON.stringify(value);
/** The patch after `rev - 1`: one row replaced. */
const delta = (rev: number, title = `Title ${rev}`): string => {
  const row = indexOf(tree({ tasks: [dto({ title })] })).tasks[0]!;
  return JSON.stringify({ ...serverPatch({ ...snapshot, rev: rev - 1, sourcePv: (rev - 1) as ProjectedIndexDTO["sourcePv"] }, [row]), rev });
};

test("the stream is subscribed at once and its first index is the display", async () => {
  const { view, current } = mount();
  expect(fetchEventSource).toHaveBeenCalledOnce();
  await waitFor(() => expect(current()).toBeDefined());
  expect(view.result.current.data).toBeUndefined();
  expect(useConnection.getState().lastReceivedAt).toBeUndefined();
  expect(useConnection.getState().state).toBe("connecting");
  act(() => current()!.send(snapshotData()));
  expect(useConnection.getState().state).toBe("live");
  await waitFor(() => expect(view.result.current.data).toEqual(snapshot));
  expect(useConnection.getState().lastReceivedAt).toBeDefined();
});

test("a full index keeps an opened History visible while refreshing it", async () => {
  const key = ["task-history", snapshot.root, "T1"] as const;
  const held = { pages: [{ events: [], nextBefore: null }], pageParams: [null] };
  queryClient.setQueryData(key, held);
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  expect(queryClient.getQueryData(key)).toBe(held);
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
});

test("the workspace feed ignores connection message changes", async () => {
  let renders = 0;
  const view = renderHook(() => { renders++; return useWorkspace(); }, { wrapper });
  await waitFor(() => expect(fetchEventSource).toHaveBeenCalled());
  const before = renders;
  act(() => useConnection.setState({ message: () => "new message", state: "reconnecting" }));
  expect(renders).toBe(before);
  view.unmount();
});

test("a dropped stream keeps retrying every 30 seconds after the ladder and resets on a snapshot", async () => {
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  const options = () => current()!.options;
  const delays: unknown[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    act(() => { delays.push(options().onerror(new Error("stream dropped"))); });
    expect(useConnection.getState().state).toBe("reconnecting");
  }
  expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000]);
  expect(useConnection.getState().failures).toBe(8);
  act(() => options().onmessage({ id: "a:1", event: "index", data: snapshotData() }));
  expect(useConnection.getState().state).toBe("live");
  expect(useConnection.getState().failures).toBe(0);
  expect(useConnection.getState().lastReceivedAt).toBeDefined();
  act(() => { expect(options().onerror(new Error("dropped again"))).toBe(1000); });
});

test.each([
  ["a network failure", () => new TypeError("Failed to fetch")],
  ["503", () => new Response("", { status: 503 })],
] as const)("a stream that cannot be opened (%s) keeps retrying and recovers", async (_name, failure) => {
  vi.useFakeTimers();
  let recover = false;
  const { current, opens } = mount(() => recover ? eventStream() : failure());
  await act(async () => {});
  expect(useConnection.getState().lastReceivedAt).toBeUndefined();
  expect(useConnection.getState().state).toBe("reconnecting");
  for (const delay of [1000, 2000, 4000, 8000, 15000, 30000, 30000]) {
    const calls = opens();
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
    expect(opens()).toBe(calls);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(opens()).toBe(calls + 1);
  }
  recover = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  act(() => current()!.send(snapshotData()));
  expect(useConnection.getState().state).toBe("live");
  act(() => { expect(current()!.options.onerror(new Error("drop"))).toBe(1000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(useConnection.getState().lastReceivedAt).toBeDefined();
});

test.each(["manual", "online", "visible"])("%s reconnects immediately, cancels the old feed, and retries a failed opening", async (trigger) => {
  let failing = false;
  const { view, current, subscriptions, opens } = mount(() => failing ? new TypeError("Failed to fetch") : eventStream());
  await waitFor(() => expect(current()).toBeDefined());
  const old = current()!;
  act(() => old.send(snapshotData()));
  // Receipt publication is deferred; reconnect from an already published receipt.
  await waitFor(() => expect(useConnection.getState().lastReceivedAt).toBeDefined());
  const received = useConnection.getState().lastReceivedAt;
  act(() => old.options.onerror(new Error("offline")));
  failing = true;
  vi.useFakeTimers();
  await act(async () => {
    if (trigger === "manual") view.result.current.reconnect();
    if (trigger === "online") window.dispatchEvent(new Event("online"));
    if (trigger === "visible") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  expect(old.options.signal.aborted).toBe(true);
  expect(subscriptions()).toBe(2);
  expect(opens()).toBe(2);
  expect(useConnection.getState().state).toBe("reconnecting");
  expect(useConnection.getState().lastReceivedAt).toBe(received);
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(opens()).toBe(3);
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(subscriptions()).toBe(2);
  expect(opens()).toBe(3);
});

test("online establishes a new feed; a foreground visit validates even a live feed and hidden does not reconnect", async () => {
  const { current, subscriptions } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  act(() => {
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(subscriptions()).toBe(2);
  act(() => current()!.send(snapshotData()));
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(subscriptions()).toBe(3);
  act(() => current()!.options.onerror(new Error("offline")));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(subscriptions()).toBe(3);
});

test.each(["visibilitychange", "pageshow", "resume"])("%s starts a new foreground check without suspended failures or old receipts", async (event) => {
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  const old = current()!;
  act(() => old.send(snapshotData()));
  act(() => old.options.onerror(new Error("suspended stream")));
  expect(useConnection.getState().failures).toBe(1);
  let next: Options | undefined;
  fetchEventSource.mockImplementation((_url: string, options: Options) => { next = options; return new Promise<void>(() => {}); });
  const visible = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => {
    if (event === "pageshow") window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    else document.dispatchEvent(new Event(event));
  });
  expect(old.options.signal.aborted).toBe(true);
  expect(next).toBeDefined();
  expect(useConnection.getState()).toMatchObject({ state: "connecting", failures: 0, offline: true });
  // Even callbacks already queued by the old stream cannot certify or fail this foreground visit.
  await act(async () => { await old.options.onopen(eventStream()); old.send(snapshotData()); });
  expect(() => old.options.onerror(new Error("late failure"))).toThrow();
  expect(useConnection.getState()).toMatchObject({ state: "connecting", failures: 0, offline: true });
  await act(async () => { await next!.onopen(eventStream()); });
  expect(useConnection.getState()).toMatchObject({ state: "live", failures: 0, offline: false });
  visible.mockRestore();
});

test("returning samples native offline again even if its event was missed while suspended", async () => {
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(onlineManager.isOnline()).toBe(false);
  expect(useConnection.getState()).toMatchObject({ state: "reconnecting", offline: true, failures: 0 });
});

test.each([
  ["resume", "pageshow", "visibilitychange"],
  ["online", "visibilitychange", "resume"],
  ["visibilitychange", "online", "resume"],
])("foreground event burst %j resets the observation even when a new subscription is already scheduled", async (...events) => {
  const { current, view } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  expect(canSendWrites()).toBe(true);
  render(<ProgressLine />);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  const old = current()!;
  act(() => old.options.onerror(new Error("suspended stream")));
  act(() => onlineManager.setOnline(false));
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  let next: Options | undefined;
  fetchEventSource.mockImplementation((_url: string, options: Options) => { next = options; return new Promise<void>(() => {}); });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  const emit = (event: string) => event === "online" ? window.dispatchEvent(new Event(event)) : event === "pageshow"
    ? window.dispatchEvent(Object.assign(new Event(event), { persisted: true })) : document.dispatchEvent(new Event(event));
  act(() => { visibility.mockReturnValue("visible"); for (const event of events) emit(event); });
  expect(fetchEventSource.mock.calls).toHaveLength(2);
  expect(onlineManager.isOnline()).toBe(true);
  expect(next).toBeDefined();
  expect(useConnection.getState()).toMatchObject({ state: "connecting", failures: 0, offline: true });
  expect(canSendWrites()).toBe(false);
  await act(async () => { await old.options.onopen(eventStream()); old.send(snapshotData({ ...snapshot, root: "/stale", generation: "stale" })); });
  expect(() => old.options.onerror(new Error("late failure"))).toThrow();
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS + 1));
  expect(useConnection.getState()).toMatchObject({ state: "connecting", failures: 0, offline: true });
  expect(useToasts.getState().toasts.filter(toast => toast.id === "offline")).toHaveLength(0);
  expect(canSendWrites()).toBe(false);
  await act(async () => { await next!.onopen(eventStream()); });
  expect(canSendWrites()).toBe(true);
  view.unmount();
  const calls = fetchEventSource.mock.calls.length;
  act(() => { for (const event of events) emit(event); });
  expect(fetchEventSource.mock.calls).toHaveLength(calls);
  expect(next!.signal.aborted).toBe(true);
  expect(canSendWrites()).toBe(false);
});

test.each([
  ["refused (403)", () => new Response("", { status: 403 }), "workspace.streamUnavailable"],
  ["not an event stream", html, "workspace.invalidStream"],
] as const)("a permanent opening failure, %s, stops without retrying", async (_name, response, message) => {
  vi.useFakeTimers();
  const { opens } = mount(response);
  await act(async () => {});
  expect(useConnection.getState().state).toBe("stopped");
  expect(useConnection.getState().message()).toBe(i18n.t(message));
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(opens()).toBe(1);
});

test("format errors and retry messages follow a later language change", async () => {
  let failing = false;
  const { view, current } = mount(() => failing ? new TypeError("Failed to fetch") : eventStream());
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(JSON.stringify({ root: 1 })));
  await waitFor(() => expect(useConnection.getState().state).toBe("stopped"));
  expect(useConnection.getState().message()).toBe(i18n.t("workspace.invalidResponse"));
  await act(async () => { await i18n.changeLanguage("ja"); });
  expect(useConnection.getState().message()).toBe(i18n.t("workspace.invalidResponse"));
  failing = true;
  await act(async () => { view.result.current.reconnect(); });
  expect(useConnection.getState().state).toBe("reconnecting");
  expect(useConnection.getState().message()).toBe(i18n.t("workspace.reconnecting", { count: 1 }));
  await act(async () => { await i18n.changeLanguage("en"); });
  expect(useConnection.getState().message()).toBe(i18n.t("workspace.reconnecting", { count: 1 }));
});

test("a refused subscription is not retried, because retrying cannot fix it", async () => {
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  const onerror = current()!.options.onerror!;

  const rejected = new ApiError("Cannot confirm the update connection.", "forbidden");
  expect(() => onerror(rejected)).toThrow(rejected);

  const malformed = new ApiError("Unexpected format", "invalid_response");
  expect(() => onerror(malformed)).toThrow(malformed);
  const refused = await current()!.options.onopen(new Response(JSON.stringify({ error: {
    code: "forbidden", message: "No subscription", retry: "fix",
  } }), { status: 403 })).catch((error: unknown) => error) as ApiError;
  expect(refused).toBeInstanceOf(ApiError);
  expect(refused.code).toBe("forbidden");
  expect(refused.retry).toBe("fix");
  expect(() => onerror(refused)).toThrow(refused);
  const unreadable = await current()!.options.onopen(new Response("", { status: 403 })).catch((error: unknown) => error) as ApiError;
  expect(unreadable.retry).toBe("fix");
  expect(() => onerror(unreadable)).toThrow(unreadable);
});

test("a stream that is not an event stream stops the feed rather than showing stale tasks as live", async () => {
  const { view, current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  const onopen = current()!.options.onopen!;

  const refused = onopen(new Response("", { status: 200, headers: { "content-type": "text/html" } }));
  await expect(refused).rejects.toThrow(/The update stream has an unexpected format/);
  await act(async () => { current()!.fail(await refused.catch((error: unknown) => error)); });

  // The snapshot that did land stays readable; only the feed is stopped.
  expect(useConnection.getState().state).toBe("stopped");
  await waitFor(() => expect(view.result.current.data?.root).toBe(snapshot.root));
});

test("a patch that follows the held index replaces its rows and advances last received", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const { view, current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  await waitFor(() => expect(useConnection.getState().lastReceivedAt).toBe(1000));
  clock.mockReturnValue(2000);
  act(() => current()!.send(delta(snapshot.rev + 1), "patch"));
  await waitFor(() => expect(useConnection.getState().lastReceivedAt).toBe(2000));
  await waitFor(() => expect(view.result.current.data).toMatchObject({ rev: snapshot.rev + 1, tasks: [{ id: "T1", title: `Title ${snapshot.rev + 1}` }, { id: PROJECT_TASK }] }));
  expect(useConnection.getState().lastReceivedAt).toBe(2000);
});

test("a patch that does not follow subscribes again for the whole index, without resuming", async () => {
  const { view, current, subscriptions } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  const first = current()!;
  await act(async () => { first.send(delta(snapshot.rev + 2), "patch"); });
  await waitFor(() => expect(subscriptions()).toBe(2));
  expect(first.options.signal.aborted).toBe(false);
  expect(current()!.options.headers).toEqual({});
  expect(view.result.current.data).toEqual(snapshot);
});

test("a new subscription resumes after the held index; the first one asks for the whole index", async () => {
  const { view, current, subscriptions } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  expect(current()!.options.headers).toEqual({});
  act(() => current()!.send(snapshotData()));
  await act(async () => { view.result.current.reconnect(); });
  expect(subscriptions()).toBe(2);
  expect(current()!.options.headers).toEqual({ "last-event-id": `${snapshot.generation}:${snapshot.rev}` });
  // A resumed stream may send nothing: it is live once open.
  await waitFor(() => expect(useConnection.getState().state).toBe("live"));
});

test("a refresh subscribes again for the whole index, keeps the held one shown, and ends when it is in", async () => {
  const { current, subscriptions } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  let settled: boolean | undefined;
  await act(async () => { void useConnection.getState().refresh().then((ok) => { settled = ok; }); });
  expect(subscriptions()).toBe(2);
  expect(current()!.options.headers).toEqual({});
  await act(async () => { await Promise.resolve(); });
  expect(settled).toBeUndefined();
  act(() => current()!.send(snapshotData()));
  await waitFor(() => expect(settled).toBe(true));
  // The next reconnection resumes again.
  await act(async () => { useConnection.getState().reconnect(); });
  expect(current()!.options.headers).toEqual({ "last-event-id": `${snapshot.generation}:${snapshot.rev}` });
});

test("a refresh whose subscription fails says it failed", async () => {
  let fail = false;
  const { current } = mount(() => fail ? new Error("offline") : eventStream());
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  fail = true;
  let settled: boolean | undefined;
  await act(async () => { void useConnection.getState().refresh().then((ok) => { settled = ok; }); });
  await waitFor(() => expect(settled).toBe(false));
});

test("a refresh that cannot read again what is on screen says it failed, though the whole index came", async () => {
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  let reads = 0;
  renderHook(() => useQuery({ queryKey: ["refresh-shown"], queryFn: async () => { if (reads++ > 0) throw new Error("gone"); return 1; }, retry: false }), { wrapper });
  await waitFor(() => expect(queryClient.getQueryData(["refresh-shown"])).toBe(1));
  let settled: boolean | undefined;
  await act(async () => { void useConnection.getState().refresh().then((ok) => { settled = ok; }); });
  act(() => current()!.send(snapshotData()));
  await waitFor(() => expect(settled).toBe(false));
});

test("an index event that is not an index is invalid and stops the feed", async () => {
  const { view, current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(JSON.stringify({ ...snapshot, rev: "x" })));
  await waitFor(() => expect(useConnection.getState().state).toBe("stopped"));
  expect(useConnection.getState().message()).toBe(i18n.t("workspace.invalidResponse"));
  expect(view.result.current.data).toBeUndefined();
});

test("a malformed subscription stops with its last accepted display and manual reconnect aborts it", async () => {
  vi.useFakeTimers();
  const answers = [eventStream, html];
  const { view, current, subscriptions } = mount(() => (answers.shift() ?? eventStream)());
  await act(async () => {});
  const first = current()!;
  act(() => first.send(snapshotData()));
  expect(useConnection.getState().state).toBe("live");
  // The stream drops; the library opens it again and meets HTML.
  act(() => first.fail(new TypeError("network error")));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(useConnection.getState().state).toBe("stopped");
  expect(view.result.current.data?.root).toBe(snapshot.root);
  expect(useConnection.getState().offline).toBe(true);
  await act(async () => { view.result.current.reconnect(); });
  expect(subscriptions()).toBe(2);
  expect(first.options.signal.aborted).toBe(true);
});

test("a stream the library reopens after an event is live once open, even when nothing new has happened", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { current, opens } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  expect(useConnection.getState().state).toBe("live");
  act(() => current()!.fail(new TypeError("network error")));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(opens()).toBe(2);
  // The library reopened with its last event ID; the server had nothing new to send.
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(useConnection.getState().offline).toBe(false);
  expect(useConnection.getState().state).toBe("live");
});

test("a whole index replacing the held one makes the opened views and search old", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const { view, current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  const id = snapshot.tasks[0]!.id;
  const keys = [["task", snapshot.root, id], ["task-search", snapshot.root, "words"]];
  queryClient.setQueryData(keys[0]!, { task: { id }, requests: [], reply: null });
  queryClient.setQueryData(keys[1]!, { ids: [id] });
  // The server restarted (or no longer has the missed changes): the whole index, with this task changed.
  const changed = indexOf(tree({ tasks: [dto({ title: "Changed while away", hash: "c".repeat(64), version: 9 })] }));
  clock.mockReturnValue(2000);
  act(() => current()!.send(JSON.stringify({ ...changed, generation: "b" })));
  await waitFor(() => expect(view.result.current.data?.tasks[0]?.hash).toBe("c".repeat(64)));
  expect(queryClient.getQueryData(keys[0]!)).toBeUndefined();
  expect(queryClient.getQueryData(keys[1]!)).toBeUndefined();
});

/**
 * A stream nothing closed but nothing reaches (a phone that slept, a changed network, a proxy holding the old
 * connection). The library's own `fetch` is the one the feed hands it, so the server's heartbeat comments are read
 * through it as on the real stream.
 */
function mountStreaming() {
  const opened: { headers: Record<string, string>; beat: () => void; send: (data: string) => void }[] = [];
  const encoder = new TextEncoder();
  // A browser has the web streams; this test environment takes Node's.
  vi.stubGlobal("ReadableStream", WebReadableStream);
  vi.stubGlobal("TransformStream", WebTransformStream);
  // What the server writes on the stream opened last.
  let push!: (text: string) => void;
  vi.stubGlobal("fetch", vi.fn(async () => {
    const body = new ReadableStream<Uint8Array>({ start(stream) { push = (text) => stream.enqueue(encoder.encode(text)); } });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }));
  fetchEventSource.mockImplementation(async (_url: string, options: Options) => {
    // The library falls back to the global fetch when none is handed to it.
    const response = await (options.fetch ?? fetch)("/api/events", { signal: options.signal, headers: options.headers });
    const write = push;
    await options.onopen!(response);
    // The library reads the body until the stream ends; a comment never reaches onmessage.
    const reader = response.body!.getReader();
    void (async () => { while (!(await reader.read().catch(() => ({ done: true }))).done); })();
    opened.push({ headers: { ...options.headers } as Record<string, string>, beat: () => write(": collector heartbeat\n\n"),
      send: (data) => { write(`data: ${data}\n\n`); options.onmessage!({ id: "", event: "index", data, retry: undefined }); } });
    return new Promise<void>(() => {});
  });
  renderHook(() => useWorkspace(), { wrapper });
  return opened;
}

test("a stream that keeps its heartbeat stays; one silent past the limit is subscribed again, resuming the held index", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const opened = mountStreaming();
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  act(() => opened[0]!.send(snapshotData()));
  expect(useConnection.getState().state).toBe("live");
  for (let beat = 0; beat < 6; beat++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(INDEX_HEARTBEAT_MS); opened[0]!.beat(); });
  }
  expect(opened).toHaveLength(1);
  // Nothing more arrives, and nothing closes the stream.
  await act(async () => { await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS * 1.5); });
  await vi.waitFor(() => expect(opened).toHaveLength(2));
  expect(opened[1]!.headers["last-event-id"]).toBe(`${snapshot.generation}:${snapshot.rev}`);
  // A resumed stream is live once open, and the silent one was let go.
  expect(useConnection.getState().state).toBe("live");
});

test("a silent stream is a failed try, and a try with no answer is one more for each heartbeat it waits, left to get it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const opened = mountStreaming();
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  act(() => opened[0]!.send(snapshotData()));
  expect(useConnection.getState().failures).toBe(0);
  // From now on the server does not answer, and nothing says so.
  vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
  await act(async () => { await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS + UNANSWERED_TRY_MS / 2); });
  expect(useConnection.getState().failures).toBe(1);
  expect(useConnection.getState().state).toBe("connecting");
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/events')).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(UNANSWERED_TRY_MS * 3); });
  expect(useConnection.getState().failures).toBeGreaterThanOrEqual(3);
  // The same try still waits for its answer.
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/events')).toHaveLength(2);
});

test("a page shown again checks its stream at once: a silent one is subscribed again before the next watch", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const opened = mountStreaming();
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  act(() => opened[0]!.send(snapshotData()));
  // A hidden page's timers barely run: time passes without the watch.
  vi.setSystemTime(Date.now() + SILENT_STREAM_MS + 1000);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await vi.waitFor(() => expect(opened).toHaveLength(2));
  expect(opened[1]!.headers["last-event-id"]).toBe(`${snapshot.generation}:${snapshot.rev}`);
});

// Native reachability is received through TanStack's real browser event listener.
// Late callbacks deliberately bypass the fetch library's abort filtering.
test('native offline dominates old open/index/patch, online waits for actual stream, one recovery then cleanup', async () => {
  const { view, current, subscriptions } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  const old = current()!;
  act(() => old.send(snapshotData()));
  expect(canSendWrites()).toBe(true);
  let recoveries = 0;
  const stop = onBackInReach(() => recoveries++);
  act(() => window.dispatchEvent(new Event('offline')));
  expect(onlineManager.isOnline()).toBe(false);
  expect(useConnection.getState().offline).toBe(true);
  expect(canSendWrites()).toBe(false);
  expect(old.options.signal.aborted).toBe(true);
  const send = vi.fn(async () => true);
  const mutation = queryClient.getMutationCache().build(queryClient, { mutationFn: send });
  await expect(mutation.execute(undefined)).rejects.toMatchObject({ code: 'write_unavailable', retry: 'later' });
  expect(mutation.state.isPaused).toBe(false); expect(send).not.toHaveBeenCalled();
  await act(async () => {
    await old.options.onopen(eventStream());
    old.send(delta(snapshot.rev + 1), 'patch');
    old.send(snapshotData({ ...snapshot, root: '/late', generation: 'late' }));
  });
  expect(queryClient.getQueryData(['index'])).toEqual(snapshot);
  expect(useConnection.getState().offline).toBe(true);
  expect(recoveries).toBe(0);
  // A new socket may be open with no reply yet; native online is no receipt.
  fetchEventSource.mockImplementation(() => new Promise(() => {}));
  act(() => window.dispatchEvent(new Event('online')));
  expect(useConnection.getState().offline).toBe(true);
  expect(canSendWrites()).toBe(false);
  const options = fetchEventSource.mock.calls.at(-1)![1];
  await act(async () => options.onopen(eventStream()));
  expect(useConnection.getState().offline).toBe(false);
  expect(canSendWrites()).toBe(true);
  expect(recoveries).toBe(1);
  await queryClient.resumePausedMutations(); expect(send).not.toHaveBeenCalled();
  act(() => options.onmessage({ event: 'index', data: snapshotData(), id: '' }));
  expect(recoveries).toBe(1);
  stop(); view.unmount();
  expect(useConnection.getState().offline).toBe(true);
  expect(canSendWrites()).toBe(false);
  const count = fetchEventSource.mock.calls.length;
  act(() => { window.dispatchEvent(new Event('offline')); window.dispatchEvent(new Event('online')); });
  expect(fetchEventSource.mock.calls).toHaveLength(count);
  expect(subscriptions()).toBe(1);
});
for (const restored of [false, true]) test('initial offline ' + (restored ? 'restored index' : 'no index') + ' cannot certify a write on native online or open', async () => {
  if (restored) queryClient.setQueryData(['index'], snapshot);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const { current } = mount();
  expect(fetchEventSource).not.toHaveBeenCalled();
  expect(useConnection.getState().offline).toBe(true);
  expect(canSendWrites()).toBe(false);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event('online')));
  expect(useConnection.getState().offline).toBe(true);
  expect(canSendWrites()).toBe(false);
  act(() => current()!.send(snapshotData()));
  expect(useConnection.getState().offline).toBe(false);
  expect(canSendWrites()).toBe(true);
});


test("a live patch batch retains connection identity while its index and receipt still reach readers", async () => {
  const { current, view } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  await waitFor(() => expect(useConnection.getState().lastReceivedAt).toBeDefined());
  const live = useConnection.getState(), messages: unknown[] = [];
  const stop = useConnection.subscribe((next, before) => {
    if (["state", "message", "offline", "failures"].some((key) => !Object.is(next[key as keyof typeof next], before[key as keyof typeof before]))) messages.push(next);
  });
  try {
    act(() => {
      current()!.send(delta(snapshot.rev + 1, "First retained receipt"), "patch");
      current()!.send(delta(snapshot.rev + 2, "Latest retained receipt"), "patch");
    });
    expect(useConnection.getState()).toBe(live);
    expect(messages).toEqual([]);
    await waitFor(() => expect(view.result.current.data?.rev).toBe(snapshot.rev + 2));
    expect(view.result.current.data?.tasks[0]?.title).toBe("Latest retained receipt");
    await waitFor(() => expect(useConnection.getState().lastReceivedAt).toBeGreaterThanOrEqual(live.lastReceivedAt!));
    expect(useConnection.getState().message).toBe(live.message);
    expect(canSendWrites()).toBe(true);
  } finally { stop(); }
});

test("a live receipt resets suspended failures and keeps deferred message translation current", async () => {
  const { current } = mount();
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  await waitFor(() => expect(useConnection.getState().lastReceivedAt).toBeDefined());
  const message = useConnection.getState().message;
  act(() => useConnection.setState({ failures: 4 }));
  act(() => current()!.send(delta(snapshot.rev + 1), "patch"));
  expect(useConnection.getState()).toMatchObject({ state: "live", failures: 0, offline: false });
  expect(useConnection.getState().message).toBe(message);
  await i18n.changeLanguage("ja");
  expect(message()).toBe(i18n.t("workspace.live"));
  await i18n.changeLanguage("en");
  expect(message()).toBe(i18n.t("workspace.live"));
});


test("live root and generation replacement reach the write gate after the existing read notification", async () => {
  const { current } = mount();
  const disabled = renderHook(() => useWriteDisabled(), { wrapper });
  await waitFor(() => expect(current()).toBeDefined());
  act(() => current()!.send(snapshotData()));
  await waitFor(() => expect(disabled.result.current).toBe(false));
  for (const [root, generation] of [[snapshot.root, "replacement-generation"], ["/other-live-root", "other-generation"]]) {
    act(() => current()!.send(snapshotData({ ...snapshot, root: root!, generation: generation!, rev: 1 })));
    expect(canSendWrites()).toBe(true);
    await waitFor(() => expect(disabled.result.current).toBe(false));
    expect(queryClient.getQueryData<ProjectedIndexDTO>(["index"])).toMatchObject({ root, generation });
    act(() => current()!.send(snapshotData({ ...snapshot, root: root!, generation: generation!, rev: 2, writable: false })));
    expect(canSendWrites()).toBe(false);
    await waitFor(() => expect(disabled.result.current).toBe(true));
    act(() => current()!.send(snapshotData({ ...snapshot, root: root!, generation: generation!, rev: 3, writable: true })));
    expect(canSendWrites()).toBe(true);
    await waitFor(() => expect(disabled.result.current).toBe(false));
  }
});
