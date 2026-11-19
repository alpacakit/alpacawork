import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("@/data/request-activity", () => ({ trackedFetch: vi.fn(async () => Response.json({})) }));
vi.mock("@/data/client", async (original) => ({ ...(await original<typeof import("@/data/client")>()), requireWriteAccess: () => {}, mutationHeaders: () => ({ 'X-Write-Test': 'presence' }) }));
vi.mock("@/data/connection", async (original) => ({ ...(await original<typeof import("@/data/connection")>()), canSendWrites: vi.fn(() => true) }));
const { trackedFetch } = await import("@/data/request-activity");
const { postPresence, usePresenceActivity } = await import("@/data/presence");
const { canSendWrites, useConnection } = await import("@/data/connection");
const epoch = Date.parse('2026-11-13T00:00:00Z');
const report = (index = -1) => JSON.parse(String(vi.mocked(trackedFetch).mock.calls.at(index)?.[1]?.body));
function visibility(value: 'hidden' | 'visible') {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
}
const input = () => act(() => document.dispatchEvent(new Event('pointerdown')));
function writes(allowed: boolean) {
  vi.mocked(canSendWrites).mockReturnValue(allowed);
  act(() => useConnection.setState({ state: allowed ? 'live' : 'connecting', fresh: allowed, writable: allowed, offline: !allowed }));
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(epoch); vi.mocked(trackedFetch).mockClear();
  vi.mocked(canSendWrites).mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

// Activity is what marks a day of use and holds back the person's notifications: an agent view sends none, pressed or not.
test("an agent checking the screen does not report the person as present", async () => {
  window.history.replaceState(null, "", "/?agent=1");
  const agent = renderHook(usePresenceActivity);
  document.dispatchEvent(new Event("pointerdown"));
  visibility('hidden');
  window.dispatchEvent(new Event('pagehide'));
  visibility('visible');
  writes(false); writes(true);
  await agent.result.current();
  await postPresence("");
  expect(trackedFetch).not.toHaveBeenCalled();
  agent.unmount();
  window.history.replaceState(null, "", "/");
  const person = renderHook(usePresenceActivity);
  document.dispatchEvent(new Event("pointerdown"));
  expect(trackedFetch).toHaveBeenCalledTimes(1);
  person.unmount();
});

test('loading is not a touch; input has an immediate report and a trailing report within 15 seconds', () => {
  renderHook(usePresenceActivity);
  expect(trackedFetch).not.toHaveBeenCalled();
  input();
  const first = report();
  expect(first).toMatchObject({ seq: 1, touchSeq: 1, touchedAgo: 0, hiddenAgo: null });
  act(() => vi.advanceTimersByTime(1_000)); input();
  act(() => vi.advanceTimersByTime(13_999));
  expect(trackedFetch).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1));
  expect(trackedFetch).toHaveBeenCalledTimes(2);
  expect(report()).toMatchObject({ screen: first.screen, seq: 2, touchSeq: 2, touchedAgo: 14_000 });
  act(() => vi.advanceTimersByTime(60_000));
  expect(trackedFetch).toHaveBeenCalledTimes(2);
});

test('hide flushes the pending touch with keepalive and mutation headers; pagehide preserves the leave time', () => {
  renderHook(usePresenceActivity); input();
  act(() => vi.advanceTimersByTime(2_000)); input();
  // Devices need not share a wall clock with serve (or keep the same wall clock while this page is open).
  vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
  act(() => vi.advanceTimersByTime(1_000)); visibility('hidden');
  expect(report()).toMatchObject({ touchSeq: 2, touchedAgo: 1_000, hiddenAgo: 0 });
  expect(vi.mocked(trackedFetch).mock.calls.at(-1)?.[1]).toMatchObject({ keepalive: true, headers: { 'X-Write-Test': 'presence' } });
  act(() => vi.advanceTimersByTime(1_000));
  act(() => window.dispatchEvent(new Event('pagehide')));
  expect(report()).toMatchObject({ touchSeq: 2, touchedAgo: 2_000, hiddenAgo: 1_000 });
  const count = vi.mocked(trackedFetch).mock.calls.length;
  input(); act(() => vi.advanceTimersByTime(60_000));
  expect(trackedFetch).toHaveBeenCalledTimes(count);
});

test('returning to the foreground and choosing present report touches immediately', async () => {
  const hook = renderHook(usePresenceActivity); input();
  act(() => vi.advanceTimersByTime(10_000)); visibility('hidden');
  act(() => vi.advanceTimersByTime(15_000)); visibility('visible');
  expect(report()).toMatchObject({ touchSeq: 2, touchedAgo: 0, hiddenAgo: null });
  act(() => vi.advanceTimersByTime(1_000));
  await act(() => hook.result.current());
  expect(report()).toMatchObject({ touchSeq: 3, touchedAgo: 0, hiddenAgo: null });
});

test('a failed report and refused return keep only current state until writes recover', async () => {
  vi.mocked(trackedFetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
  renderHook(usePresenceActivity);
  await act(async () => { input(); });
  const first = report();
  act(() => vi.advanceTimersByTime(1_000));
  await act(async () => { visibility('hidden'); });
  expect(report()).toMatchObject({ screen: first.screen, seq: 2, touchSeq: 1, touchedAgo: 1_000, hiddenAgo: 0 });
  writes(false);
  act(() => vi.advanceTimersByTime(1_000)); visibility('visible');
  const count = vi.mocked(trackedFetch).mock.calls.length;
  act(() => vi.advanceTimersByTime(3_000));
  expect(trackedFetch).toHaveBeenCalledTimes(count);
  await act(async () => { writes(true); });
  expect(trackedFetch).toHaveBeenCalledTimes(count + 1);
  expect(report()).toMatchObject({ screen: first.screen, seq: 3, touchSeq: 2, touchedAgo: 3_000, hiddenAgo: null });
});

test('a refused hide is reported with its age on recovery even if an older send completes meanwhile', async () => {
  let received!: (response: Response) => void;
  vi.mocked(trackedFetch).mockImplementationOnce(() => new Promise(resolve => { received = resolve; }));
  const hook = renderHook(usePresenceActivity); input();
  act(() => vi.advanceTimersByTime(1_000)); writes(false); input();
  act(() => vi.advanceTimersByTime(1_000)); visibility('hidden');
  expect(trackedFetch).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(2_000));
  await act(async () => { received(Response.json({})); });
  act(() => vi.advanceTimersByTime(3_000));
  await act(async () => { writes(true); });
  expect(trackedFetch).toHaveBeenCalledTimes(2);
  expect(report()).toMatchObject({ seq: 2, touchSeq: 2, touchedAgo: 6_000, hiddenAgo: 5_000 });
  expect(vi.mocked(trackedFetch).mock.calls.at(-1)?.[1]?.keepalive).toBe(true);
  writes(false); writes(true);
  act(() => vi.advanceTimersByTime(60_000));
  expect(trackedFetch).toHaveBeenCalledTimes(2);
  hook.unmount(); writes(false); writes(true);
  expect(trackedFetch).toHaveBeenCalledTimes(2);
});
