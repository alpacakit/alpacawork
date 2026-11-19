import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { useConnection } from "../src/data/connection";
import { OFFLINE_SHOWN_AFTER_MS, outOfReach, useOfflineShown } from "../src/data/reach";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.dispatchEvent(new Event("visibilitychange"));
  vi.useRealTimers();
  onlineManager.setOnline(true);
  useConnection.setState({ state: "live", offline: false, failures: 0 });
});

test("hidden failures never earn grace, and hiding cancels an already earned display", () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  useConnection.setState({ state: "live", offline: false, failures: 0 });
  render(<Probe />);
  act(() => useConnection.setState({ state: "reconnecting", offline: true, failures: 1 }));
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS));
  expect(shown()).toBe("true");
  act(() => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
  expect(shown()).toBe("false");
  act(() => { useConnection.setState({ failures: 2 }); vi.advanceTimersByTime(60_000); });
  expect(shown()).toBe("false");
  // The feed's new foreground check has not failed. A real failure after it still gets the ordinary grace.
  act(() => { useConnection.setState({ state: "connecting", failures: 0 }); visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS));
  expect(shown()).toBe("false");
  act(() => onlineManager.setOnline(false));
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS));
  expect(shown()).toBe("true");
});

// A subscription still opening is not out of reach, whatever opened it (a reload, a pull to refresh, a return).
test("only a failed try, a stopped feed or an offline browser is out of reach", () => {
  expect(outOfReach({ state: "live", failures: 0 }, true)).toBe(false);
  expect(outOfReach({ state: "connecting", failures: 0 }, true)).toBe(false);
  expect(outOfReach({ state: "connecting", failures: 1 }, true)).toBe(true);
  expect(outOfReach({ state: "reconnecting", failures: 1 }, true)).toBe(true);
  expect(outOfReach({ state: "stopped", failures: 0 }, true)).toBe(true);
  expect(outOfReach({ state: "reconnecting", failures: 0 }, false)).toBe(true);
  expect(outOfReach({ state: "live", failures: 0 }, false)).toBe(false);
});

function Probe() { return <i data-shown={String(useOfflineShown())} />; }
const shown = () => document.querySelector("i")!.dataset.shown;

test("a refresh's new subscription shows nothing however long its index takes; a failure shows after the grace", () => {
  vi.useFakeTimers();
  useConnection.setState({ state: "live", offline: false, failures: 0 });
  render(<Probe />);
  // What the feed sets when a pull to refresh (or a reload) opens a new subscription.
  act(() => useConnection.setState({ state: "connecting", offline: true }));
  act(() => vi.advanceTimersByTime(10_000));
  expect(shown()).toBe("false");
  act(() => useConnection.setState({ state: "reconnecting", failures: 1 }));
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS - 1));
  expect(shown()).toBe("false");
  act(() => vi.advanceTimersByTime(1));
  expect(shown()).toBe("true");
  act(() => useConnection.setState({ state: "live", offline: false, failures: 0 }));
  expect(shown()).toBe("false");
});

test("a browser that goes offline is shown after the same grace, before any try fails", () => {
  vi.useFakeTimers();
  render(<Probe />);
  act(() => { onlineManager.setOnline(false); useConnection.setState({ state: "reconnecting", offline: true }); });
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS));
  expect(shown()).toBe("true");
});

// A row drawn again while out of reach (a section folded and opened) must not count its own grace and
// tick in the working colour meanwhile: the screen's one fact is already shown.
test("what is drawn while the screen already says out of reach says it at once", () => {
  vi.useFakeTimers();
  render(<Probe />);
  act(() => useConnection.setState({ state: "reconnecting", offline: true, failures: 1 }));
  act(() => vi.advanceTimersByTime(OFFLINE_SHOWN_AFTER_MS));
  cleanup();
  render(<Probe />);
  expect(shown()).toBe("true");
});
