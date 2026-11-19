import { act } from "@testing-library/react";
import { onTestFinished, vi } from "vitest";

/** Advance the IME's monotonic guard without waiting for wall time. */
export function compositionClock() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return (milliseconds: number) => { now += milliseconds; };
}

/** Control debounce/focus timers after async setup; leave Date and intervals alone. */
export function timeoutClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  onTestFinished(() => { vi.useRealTimers(); });
  return async (milliseconds: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
    // Effects committed by act may queue a query notification at the same instant.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
}
