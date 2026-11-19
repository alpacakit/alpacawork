import { announceConversation } from './conversation-fixture';
import { snapshotJson } from './conversation-fixture';
import { setConversationState } from './conversation-fixture';
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { opening, useConversationReading } from "../src/features/coordinator/read-boundary";
import { useConversation } from "../src/features/coordinator/coordinator";
import { useConnection } from "../src/data/connection";
import type { CoordinatorConversation, CoordinatorTurn } from "../src/data/coordinator";
import { readCoordinator, markCoordinatorSeen } from "../src/data/coordinator";
import { ApiError } from "../src/data/client";
import { screenData, tree } from "./fixtures";
import { queryClient } from "../src/data/query-client";

const at = "2026-10-21T10:00:00Z";
const turn = (id: string, extra: Partial<CoordinatorTurn> = {}): CoordinatorTurn => ({ id, at, ask: id, attachments: [],
  status: "succeeded", waiting: false, answer: "answer", answeredAt: at, seen: false, error: null, result: null, ...extra });
const snapshot = (turns = [turn("a"), turn("b"), turn("c")], id = "conversation"): CoordinatorConversation => ({ id, agent: null, warm: 'none' as const, busy: false, cancelled: [], turns });
const json = (value: unknown) => new Response(snapshotJson(value));
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const post = (ids: string[], id = "conversation") => json({ conversationId: id, seen: ids });
const seen = () => useConversation.getState().conversation!.turns.filter(turn => turn.seen).map(turn => turn.id);
const pending = () => [...useConversation.getState().pendingSeen];
beforeEach(() => {
  queryClient.clear();
  useConnection.setState(useConnection.getInitialState());
  screenData(tree());
  setConversationState(useConversation.getInitialState());
  setConversationState({ root: "fixture", conversation: snapshot() });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => { await flush(); vi.unstubAllGlobals(); setConversationState(useConversation.getInitialState()); });

test("offline observations retain their pending IDs without sending or confirming an ACK", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  useConnection.setState({ offline: true });
  useConversation.getState().observeSeen(["a"]);
  useConversation.getState().flushSeen(true); await flush();
  expect(fetcher).not.toHaveBeenCalled(); expect(seen()).toEqual([]); expect(pending()).toEqual(["a"]);
});

test("observations batch by Request ID, pending is not confirmed, and an ACK removes only its sent set", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(["a"]);
  useConversation.getState().observeSeen(["a", "b", "not-a-reply"]);
  await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ conversationId: "conversation", seen: ["a", "b"] });
  expect(seen()).toEqual([]);
  useConversation.getState().observeSeen(["c"]);
  first.resolve(post(["a", "b"]));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(pending()).toEqual(["c"]); expect(seen()).toEqual(["a", "b"]);
  second.resolve(post(["c"])); await waitFor(() => expect(pending()).toEqual([]));
  expect(useConversation.getState().read).toBe(true);
});

test("a read hole remains unread even if a later equal-timestamp reply was seen", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(post(["c"])));
  useConversation.getState().observeSeen(["c"]);
  await waitFor(() => expect(seen()).toEqual(["c"]));
  expect(useConversation.getState().read).toBe(false);
});

test("128 IDs per POST, one in flight, drains the remaining batch after success", async () => {
  setConversationState({ conversation: snapshot(Array.from({ length: 130 }, (_, n) => turn(String(n)))) });
  const first = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((_url, init) => {
    const body = JSON.parse(init.body); return fetcher.mock.calls.length === 1 ? first.promise : Promise.resolve(post(body.seen));
  });
  vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(Array.from({ length: 130 }, (_, n) => String(n))); await flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const batch = JSON.parse(fetcher.mock.calls[0]![1].body).seen;
  expect(batch).toHaveLength(128); first.resolve(post(batch));
  await waitFor(() => expect(useConversation.getState().read).toBe(true));
  expect(fetcher).toHaveBeenCalledTimes(2); expect(JSON.parse(fetcher.mock.calls[1]![1].body).seen).toHaveLength(2);
});

test("ACK before an older GET cannot revert confirmed seen", async () => {
  const get = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/read") ? Promise.resolve(post(["a"])) : get.promise));
  const reading = useConversation.getState().refresh();
  useConversation.getState().observeSeen(["a"]); await waitFor(() => expect(seen()).toEqual(["a"]));
  get.resolve(json(snapshot())); await reading;
  expect(seen()).toEqual(["a"]);
});

test("GET before ACK adds remote facts; an older snapshot losing the display race still contributes true", async () => {
  const older = deferred<Response>(), ack = deferred<Response>();
  let gets = 0;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url.endsWith("/read")) return ack.promise;
    return ++gets === 1 ? older.promise : Promise.resolve(json(snapshot()));
  }));
  const oldRead = useConversation.getState().refresh();
  useConversation.getState().observeSeen(["b"]); await flush();
  await useConversation.getState().refresh();
  older.resolve(json(snapshot([turn("a", { seen: true }), turn("b"), turn("c")]))); await oldRead;
  expect(seen()).toEqual(["a"]);
  ack.resolve(post(["b"])); await waitFor(() => expect(seen()).toEqual(["a", "b"]));
  await useConversation.getState().refresh(); expect(seen()).toEqual(["a", "b"]);
});

test("new completed answer for an earlier Request is unread despite all later Requests being seen", async () => {
  setConversationState({ conversation: snapshot([turn("a", { status: "running", answeredAt: null }), turn("b", { seen: true })]) });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(snapshot([turn("a"), turn("b", { seen: true })]))));
  await useConversation.getState().refresh(); expect(useConversation.getState().read).toBe(false);
  expect(useConversation.getState().conversation!.turns[0]!.seen).toBe(false);
});

test.each(["network", "unreadable", "bad-ack", "save-failure"])("%s retains pending without a retry loop; reconnection resumes", async kind => {
  let recovered = false;
  const fetcher = vi.fn().mockImplementation(() => {
    if (recovered) return Promise.resolve(post(["a"]));
    if (kind === "network") return Promise.reject(new TypeError("offline"));
    if (kind === "unreadable") return Promise.resolve(json({}));
    if (kind === "bad-ack") return Promise.resolve(post(["b"]));
    return Promise.resolve(new Response(snapshotJson({ error: { code: "unavailable", message: "save failed", retry: "later" } }), { status: 503 }));
  });
  vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(["a"]); await waitFor(() => expect(useConversation.getState().seenError).toBeTruthy());
  useConversation.getState().observeSeen(["a"]);
  await flush(); expect(fetcher).toHaveBeenCalledTimes(1); expect(pending()).toEqual(["a"]); expect(seen()).toEqual([]);
  recovered = true;
  useConnection.setState({ offline: true }); useConnection.setState({ offline: false });
  await waitFor(() => expect(seen()).toEqual(["a"])); expect(fetcher).toHaveBeenCalledTimes(2);
});

test("another human input and a new index version resume a transient failure, with no timer", async () => {
  let fail = true;
  const fetcher = vi.fn().mockImplementation((url, init) => url.endsWith("/read")
    ? fail ? Promise.reject(new Error("offline")) : Promise.resolve(post(JSON.parse(init.body).seen))
    : Promise.resolve(json(snapshot())));
  vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(["a"]); await waitFor(() => expect(useConversation.getState().seenError).toBeTruthy());
  fail = false; useConversation.getState().resumeSeen(); await waitFor(() => expect(seen()).toEqual(["a"]));
  fail = true; useConversation.getState().observeSeen(["b"]); await waitFor(() => expect(useConversation.getState().seenError).toBeTruthy());
  fail = false; announceConversation("readsync:recovered"); await waitFor(() => expect(seen()).toEqual(["a", "b"]));
});

test("domain rejection is classified and repeated input does not resend identical invalid IDs", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(snapshotJson({ error: { code: "invalid_input", message: "not completed", retry: "fix" } }), { status: 400 }));
  vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(["a"]); await waitFor(() => expect(useConversation.getState().seenError).toBeTruthy());
  useConversation.getState().resumeSeen(); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  expect(useConversation.getState().seenError).toBeInstanceOf(ApiError);
});

test.each(["conversation", "workspace", "workspace ABA"])("late ACK outside %s scope is discarded", async scope => {
  const ack = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn().mockReturnValue(ack.promise));
  useConversation.getState().observeSeen(["a"]); await flush();
  if (scope === "conversation") setConversationState({ conversation: snapshot([turn("a")], "new-conversation") });
  else { setConversationState({ root: "other", conversation: snapshot() }); if (scope === "workspace ABA") setConversationState({ root: "fixture", conversation: snapshot() }); }
  ack.resolve(post(["a"])); await flush();
  expect(seen()).toEqual([]); expect(pending()).toEqual([]);
});

test("pending keepalive uses the same transport and cannot overlap a normal request", async () => {
  const ack = deferred<Response>();
  const fetcher = vi.fn().mockReturnValue(ack.promise); vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(["a"]); useConversation.getState().flushSeen(true); await flush();
  expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]![1].keepalive).toBe(true);
  useConversation.getState().flushSeen(true); await flush(); expect(fetcher).toHaveBeenCalledTimes(1);
  ack.resolve(post(["a"])); await waitFor(() => expect(pending()).toEqual([]));
});

test("the opening anchors the latest exchange from its fresh snapshot; later reads do not re-fold it", async () => {
  setConversationState({ conversation: snapshot([turn("a", { seen: true }), turn("b"), turn("c", { seen: true })]) });
  const fresh = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn(() => fresh.promise));
  useConversation.getState().setExpanded(true);
  expect(useConversation.getState().opening).toMatchObject({ latest: "c" });
  // The fresh snapshot chooses e, regardless of which earlier replies another device has read.
  const read = [turn("a", { seen: true }), turn("b", { seen: true }), turn("c", { seen: true }), turn("d"), turn("e")];
  fresh.resolve(json(snapshot(read)));
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: "e", settled: true }));
  // Settled: what later reads bring comes while it is open.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(snapshot([...read, turn("f"), turn("g")]))));
  await useConversation.getState().refresh();
  await waitFor(() => expect(useConversation.getState().conversation?.turns).toHaveLength(7));
  expect(useConversation.getState().opening).toMatchObject({ latest: "e" });
  useConversation.getState().setExpanded(false);
  expect(useConversation.getState().opening).toBeNull();
});
test("a failed opening fixes the local snapshot once; a late successful GET cannot move it", async () => {
  const late = deferred<Response>(); let reads = 0;
  vi.stubGlobal("fetch", vi.fn(() => ++reads === 1 ? late.promise : Promise.reject(new Error("offline"))));
  const before = useConversation.getState().refresh(); useConversation.getState().setExpanded(true);
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: "c" }));
  late.resolve(json(snapshot([turn("a", { seen: true }), turn("b", { seen: true }), turn("c")]))); await before;
  expect(useConversation.getState().opening).toMatchObject({ latest: "c" });
});

test("GET deadline and unreadable response use common API error classification", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({})); vi.stubGlobal("fetch", fetcher);
  await expect(readCoordinator()).rejects.toMatchObject({ code: "invalid_response", retry: "later" });
  expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  await expect(markCoordinatorSeen("conversation", ["a"])).rejects.toMatchObject({ code: "invalid_response", retry: "check" });
});

test("hidden while a POST is in flight sends its unsent observations with keepalive after that POST", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise); vi.stubGlobal("fetch", fetcher);
  useConversation.getState().observeSeen(["a"]); await flush();
  useConversation.getState().observeSeen(["b"]); useConversation.getState().flushSeen(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  first.resolve(post(["a"])); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1]![1].keepalive).toBe(true);
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).seen).toEqual(["b"]);
  second.resolve(post(["b"])); await waitFor(() => expect(pending()).toEqual([]));
});

test("confirmed IDs from the previous workspace do not leak through the same conversation ID in a new workspace", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(snapshot([turn("a", { seen: true })])))
    .mockImplementationOnce(() => Promise.resolve(json(snapshot([turn("a")])))));
  await useConversation.getState().refresh(); expect(seen()).toEqual(["a"]);
  setConversationState({ root: "another-workspace" }); await useConversation.getState().refresh();
  expect(seen()).toEqual([]); expect(useConversation.getState().read).toBe(false);
});

test("R1: an opening with no local conversation stays unready after failures, then is taken from the first one to arrive", async () => {
  setConversationState({ conversation: null });
  const fetcher = vi.fn().mockRejectedValue(new TypeError("offline")); vi.stubGlobal("fetch", fetcher);
  useConversation.getState().setExpanded(true);
  await waitFor(() => expect(useConversation.getState().trying).toBe(false));
  expect(useConversation.getState().error).toBeTruthy();
  expect(useConversation.getState().conversation).toBeNull(); expect(useConversation.getState().opening).toMatchObject({ settled: false });
  await useConversation.getState().refresh(); expect(useConversation.getState().opening).toMatchObject({ settled: false });
  fetcher.mockResolvedValue(json(snapshot([turn("a", { seen: true }), turn("b"), turn("c")])));
  await useConversation.getState().refresh();
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: "c" }));
  fetcher.mockResolvedValue(json(snapshot([turn("a", { seen: true }), turn("b", { seen: true }), turn("c")])));
  await useConversation.getState().refresh();
  expect(useConversation.getState().opening).toMatchObject({ latest: "c" });
});

test("R1: a recovery from a closed opening teaches the next opening but cannot settle it", async () => {
  setConversationState({ conversation: null });
  const oldRecovery = deferred<Response>(), fresh = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockReturnValueOnce(oldRecovery.promise).mockImplementation(() => fresh.promise.then(response => response.clone())));
  useConversation.getState().setExpanded(true); await flush();
  const old = useConversation.getState().refresh();
  useConversation.getState().setExpanded(false); useConversation.getState().setExpanded(true);
  oldRecovery.resolve(json(snapshot())); await old;
  expect(useConversation.getState().opening).toMatchObject({ settled: false });
  fresh.resolve(json(snapshot([turn("b"), turn("c")])));
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: "c", settled: true }));
});

test("R1: a workspace ABA response cannot finish an opening while the current-scope recovery is pending", async () => {
  setConversationState({ conversation: null });
  const stale = deferred<Response>(), fresh = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise); vi.stubGlobal("fetch", fetcher);
  useConversation.getState().setExpanded(true);
  setConversationState({ root: "other" }); setConversationState({ root: "fixture" });
  stale.resolve(json(snapshot([turn("stale")]))); await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(useConversation.getState().opening).toMatchObject({ settled: false }); expect(useConversation.getState().conversation).toBeNull();
  fresh.resolve(json(snapshot([turn("fresh")])));
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: "fresh" }));
});

test("R1: a successfully loaded empty conversation is ready, distinct from having never loaded one", async () => {
  setConversationState({ conversation: null });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(snapshot([]))));
  useConversation.getState().setExpanded(true);
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: null, settled: true }));
});


test("a lost ABA read reports demand without replacing an already pending current GET", async () => {
  setConversationState({ conversation: null });
  const stale = deferred<Response>(), fresh = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValue(fresh.promise); vi.stubGlobal('fetch', fetcher);
  useConversation.getState().setExpanded(true);
  setConversationState({ root: 'other' }); setConversationState({ root: 'fixture' });
  useConversation.getState().follow(); // The new observer already owns the necessary demand.
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  stale.resolve(json(snapshot([turn('stale')]))); await flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(useConversation.getState().conversation).toBeNull(); expect(useConversation.getState().opening).toMatchObject({ settled: false });
  fresh.resolve(json(snapshot([turn('fresh')])));
  await waitFor(() => expect(useConversation.getState().opening).toMatchObject({ latest: 'fresh' }));
  await flush(); expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
});


test("the open conversation reads folded history beyond one transport batch and later arrivals", async () => {
  const turns = Array.from({ length: 260 }, (_, n) => turn(String(n)));
  turns.push(turn("still-running", { status: "running", answeredAt: null }));
  setConversationState({ conversation: snapshot(turns) });
  const first = deferred<Response>();
  const fetcher = vi.fn().mockImplementation((_url, init) => {
    const body = JSON.parse(init.body); return fetcher.mock.calls.length === 1 ? first.promise : Promise.resolve(post(body.seen));
  });
  vi.stubGlobal("fetch", fetcher);
  setConversationState({ expanded: true, opening: opening(turns) });
  function Reading() { useConversationReading(document, "fixture", "conversation"); return null; }
  const mounted = render(<Reading />); await flush();
  expect(pending()).toHaveLength(260); expect(seen()).toEqual([]);
  const after = [...turns.slice(0, -1), turn("still-running"), turn("arrived-after-click")];
  setConversationState({ conversation: snapshot(after) });
  first.resolve(post(JSON.parse(fetcher.mock.calls[0]![1].body).seen));
  await waitFor(() => expect(pending()).toEqual([]));
  expect(seen()).toEqual(after.map(turn => turn.id));
  mounted.unmount();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls.flatMap(call => JSON.parse(call[1].body).seen)).toEqual(seen());
});

test("an agent view never registers read observations", async () => {
  history.replaceState(null, "", "/?agent=1");
  try {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    useConversation.getState().observeSeen(["a"]); await flush();
    expect(fetcher).not.toHaveBeenCalled(); expect(pending()).toEqual([]); expect(seen()).toEqual([]);
  } finally { history.replaceState(null, "", "/"); }
});

// Confirming an ACK must not leave its replies neither pending nor seen for the reading rule to send again.
test("a reply read in the open conversation is sent once", async () => {
  const fetcher = vi.fn().mockImplementation((url: string, init: RequestInit) => url.endsWith("/read")
    ? Promise.resolve(post(JSON.parse(String(init.body)).seen)) : new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  setConversationState({ conversation: snapshot([turn("a", { seen: true })]) });
  await waitFor(() => expect(useConversation.getState().conversation?.turns).toHaveLength(1));
  setConversationState({ expanded: true, opening: opening([turn("a", { seen: true })]) });
  function Reading() { useConversationReading(document, "fixture", "conversation"); return null; }
  render(<Reading />);
  try {
    setConversationState({ conversation: snapshot([turn("a", { seen: true }), turn("b")]) });
    await waitFor(() => expect(seen()).toEqual(["a", "b"])); await flush();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/read")).map(([, init]) => JSON.parse(init.body).seen)).toEqual([["b"]]);
  } finally { cleanup(); }
});
