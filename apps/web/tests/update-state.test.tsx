// What the update's presses send to the release Owner (its one-confirmation update API). A new update is
// confirmed once with its review's three values; an operation already started is resumed with the same three values;
// one that needs attention goes on only as the review resumes it; nothing is sent from a review that is not ready.
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { startI18n } from "@alpacawork/i18n";

const calls = vi.hoisted(() => ({ requests: [] as { path: string; data?: unknown; opId?: string; basis?: unknown }[],
  confirmFail: null as unknown, reviews: {} as Record<string, unknown>, reviewFail: null as unknown, status: { kind: "none" } as unknown,
  saves: [] as [string, unknown][], values: {} as Record<string, unknown> }));
vi.mock("../src/data/client", async (original) => {
  const real = await original<typeof import("../src/data/client")>();
  return { ...real, createApi: () => ({ request: async (path: string, _schema: unknown, _signal?: unknown, data?: unknown, opId?: string, basis?: unknown) => {
    calls.requests.push({ path, data, opId, basis });
    if (path === "update/status") return calls.status;
    if (path.startsWith("update/review")) { if (calls.reviewFail) throw calls.reviewFail; return calls.reviews[path]; }
    if (path === "update/confirm" && calls.confirmFail) throw calls.confirmFail;
    return { opId: (data as { opId: string }).opId, terminal: path === "update/cancel" ? "cancelled" : null };
  } }) };
});
vi.mock("../src/data/connection", async (original) => ({ ...await original<typeof import("../src/data/connection")>(), workspaceWriteBasis: () => ({ kind: "workspace" }) }));
vi.mock("../src/data/personal-settings", async (original) => ({ ...await original<typeof import("../src/data/personal-settings")>(),
  usePersonalSettings: { subscribe: () => () => undefined, getState: () => ({ root: "/fixture", status: "ready", fresh: true, values: calls.values,
    save: async (key: string, value: unknown) => { calls.saves.push([key, value]); return true; } }) } }));
const failures = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/lib/notify", async (original) => {
  const real = await original<typeof import("../src/lib/notify")>();
  return { ...real, notify: { ...real.notify, failure: (error: unknown) => { failures.push(error); } } };
});
import { approveStart, continueUpdate, postponeUpdate, pressUpdate, retryUpdate, updateStatusQuery, useUpdateLocal, useWaitingForUpdate } from "../src/features/update/update-state";
import { renderHook } from "@testing-library/react";
import { ApiError } from "../src/data/client";
import { queryClient } from "../src/data/query-client";
import { receiveFullIndex } from "../src/data/resources";
import { indexOf, tree } from "./fixtures";

beforeAll(() => startI18n());
const d = (c: string) => c.repeat(64);
const OP = "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", OTHER = "7d0c5f1e-0a8b-4a43-9a4d-6f1d2f0b9c22";
const ready = (extra: object = {}) => ({ kind: "ready", candidateId: "c1", version: "0.10.0", reviewDigest: d("a"), skills: ["alpacawork"], resume: null, ...extra });
const resume = { opId: OP, candidateId: "c1", reviewDigest: d("a") };
const available = { kind: "available", candidateId: "c1", version: "0.10.0", runs: 2, requiresNoRuns: false, changes: null, note: null } as const;
const failed = { kind: "failed", candidateId: "c1", version: "0.10.0", category: "other" } as const;
const attention = { kind: "attention", opId: OP, version: "0.10.0" } as const;
const confirmed = () => calls.requests.filter((each) => each.path === "update/confirm").map((each) => each.data);
beforeEach(() => {
  calls.requests = []; calls.saves = []; calls.values = {}; calls.reviewFail = null; calls.confirmFail = null; calls.status = { kind: "none" }; failures.length = 0;
  calls.reviews = { "update/review?candidateId=c1": ready(), "update/review": { kind: "unavailable" } };
  queryClient.clear(); receiveFullIndex(queryClient, indexOf(tree()));
  useUpdateLocal.setState({ confirm: null, sending: false });
});

test("the button reads the review first and opens the one confirmation; nothing is confirmed before the person says so", async () => {
  await pressUpdate(available);
  expect(confirmed()).toEqual([]);
  expect(useUpdateLocal.getState().confirm).toMatchObject({ candidateId: "c1", version: "0.10.0", runs: 2, reviewDigest: d("a") });
});

test("Update confirms that review's three values as a new operation, with the write basis; only the dialog saves the setting", async () => {
  await pressUpdate(available);
  await approveStart(useUpdateLocal.getState().confirm!, false);
  const [sent] = calls.requests.filter((each) => each.path === "update/confirm");
  expect(sent!.data).toEqual({ opId: expect.any(String), candidateId: "c1", reviewDigest: d("a") });
  expect((sent!.data as { opId: string }).opId).not.toBe(OP);
  expect(sent!.basis).toEqual({ kind: "workspace" });
  expect(calls.saves).toEqual([["update.confirm", false]]);
});

test("confirmation off: a new update starts at once from its review, the setting untouched", async () => {
  calls.values = { "update.confirm": false };
  await pressUpdate(available);
  expect(useUpdateLocal.getState().confirm).toBeNull();
  expect(confirmed()).toEqual([{ opId: expect.any(String), candidateId: "c1", reviewDigest: d("a") }]);
  expect(calls.saves).toEqual([]);
});

test("a retry resends the operation the release still holds with its same three values; no confirmation asked", async () => {
  calls.reviews["update/review?candidateId=c1"] = ready({ resume });
  await retryUpdate(failed);
  expect(useUpdateLocal.getState().confirm).toBeNull();
  expect(confirmed()).toEqual([resume]);
});

test("a retry with no operation held asks again, like a new update", async () => {
  await retryUpdate(failed);
  expect(confirmed()).toEqual([]);
  expect(useUpdateLocal.getState().confirm).toMatchObject({ candidateId: "c1", runs: 0 });
});

test("a review that is not ready confirms nothing and says it cannot start now", async () => {
  calls.reviews["update/review?candidateId=c1"] = { kind: "unavailable" };
  await pressUpdate(available);
  expect(confirmed()).toEqual([]);
  expect(useUpdateLocal.getState().confirm).toBeNull();
  expect((failures[0] as ApiError).retry).toBe("later");
});

test("needing attention: Continue resumes the operation the review names, with its same three values", async () => {
  calls.reviews["update/review"] = ready({ resume });
  await continueUpdate(attention);
  expect(confirmed()).toEqual([resume]);
});

test("needing attention, the review resumes nothing or another operation: nothing is sent, it says it cannot go on now", async () => {
  await continueUpdate(attention);
  calls.reviews["update/review"] = ready({ resume: { ...resume, opId: OTHER } });
  await continueUpdate(attention);
  expect(confirmed()).toEqual([]);
  expect(failures.map((each) => (each as ApiError).retry)).toEqual(["later", "later"]);
});

test("a confirmation read in another workspace is closed unsent: no setting saved, nothing sent", async () => {
  await pressUpdate(available);
  const shown = useUpdateLocal.getState().confirm!;
  receiveFullIndex(queryClient, { ...indexOf(tree()), root: "/other-workspace", generation: "other-generation" });
  await approveStart(shown, false);
  expect(confirmed()).toEqual([]);
  expect(calls.saves).toEqual([]);
  expect((failures[0] as ApiError).retry).toBe("reread");
});

test("reads cleared and rebuilt at the same workspace: an older confirmation is closed unsent", async () => {
  await pressUpdate(available);
  const shown = useUpdateLocal.getState().confirm!;
  queryClient.clear(); receiveFullIndex(queryClient, indexOf(tree()));
  await approveStart(shown, true);
  expect(confirmed()).toEqual([]);
  expect(calls.saves).toEqual([]);
});

test("the workspace changing while the review is read: no confirmation opens, nothing is sent", async () => {
  let resolve!: (value: unknown) => void;
  calls.reviews["update/review?candidateId=c1"] = new Promise((r) => { resolve = r; });
  const reading = pressUpdate(available);
  receiveFullIndex(queryClient, { ...indexOf(tree()), root: "/other-workspace", generation: "new-generation" });
  resolve(ready());
  await reading;
  expect(useUpdateLocal.getState().confirm).toBeNull();
  expect(confirmed()).toEqual([]);
});

test("a second press while the first is answered sends nothing more", async () => {
  calls.values = { "update.confirm": false };
  await Promise.all([pressUpdate(available), pressUpdate(available)]);
  expect(confirmed()).toHaveLength(1);
});

test("after a press the status is followed closely for a while, even while it still reads as before", async () => {
  const interval = () => (updateStatusQuery("/fixture").refetchInterval as (query: unknown) => number)({ state: { data: failed } });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 600_000); // past any press of an earlier test
    const before = interval();
    calls.reviews["update/review?candidateId=c1"] = ready({ resume });
    await retryUpdate(failed);
    expect([before, interval()]).toEqual([10 * 60_000, 3_000]);
    vi.setSystemTime(Date.now() + 61_000);
    expect(interval()).toBe(10 * 60_000);
  } finally { vi.useRealTimers(); }
});

test("while a page that only waits for the update is shown, a stopped update is read every 3 s; 30 s otherwise", async () => {
  const interval = () => (updateStatusQuery("/fixture").refetchInterval as (query: unknown) => number)({ state: { data: attention } });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 1_200_000);
    const before = interval();
    const page = renderHook(() => useWaitingForUpdate());
    const during = interval();
    page.unmount();
    expect([before, during, interval()]).toEqual([30_000, 3_000, 30_000]);
  } finally { vi.useRealTimers(); }
});

test("a version that switches only while no agent works is read every 30 s, also when none works now, so its button follows an agent that starts", () => {
  const interval = (data: object) => (updateStatusQuery("/fixture").refetchInterval as (query: unknown) => number)({ state: { data } });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 1_800_000);
    expect([interval({ ...available, runs: 0, requiresNoRuns: true }), interval({ ...available, runs: 2, requiresNoRuns: true }),
      interval({ ...available, runs: 0 })]).toEqual([30_000, 30_000, 10 * 60_000]);
  } finally { vi.useRealTimers(); }
});

test("postponing cancels the waiting operation with the write basis", async () => {
  await postponeUpdate(OP);
  expect(calls.requests).toEqual([expect.objectContaining({ path: "update/cancel", data: { opId: OP }, basis: expect.objectContaining({ kind: "workspace" }) })]);
});

