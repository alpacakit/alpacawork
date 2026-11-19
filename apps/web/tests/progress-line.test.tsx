import { test, beforeAll, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { ProgressLine, ReadingLine, OFFLINE_TOAST, READING_SHOWN_AFTER_MS, READING_HELD_MS } from "../src/features/chrome/ProgressLine";
import { WorkspaceNotice } from "../src/features/chrome/WorkspaceNotice";
import { useConnection } from "../src/data/connection";
import { OFFLINE_SHOWN_AFTER_MS } from "../src/data/reach";
import { useToasts } from "../src/lib/notify";
import { TestWorkspace, screenData } from "./fixtures";
import { queryClient } from "../src/data/query-client";

beforeAll(() => startI18n());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.dispatchEvent(new Event("visibilitychange"));
  vi.useRealTimers();
  useToasts.setState({ toasts: [] });
  useConnection.setState({ state: "live", offline: false, failures: 0 });
});

test("hiding retires the old connection toast; a new foreground failure is said again", () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mount();
  set("reconnecting", 1); wait(OFFLINE_SHOWN_AFTER_MS);
  expect(offlineToasts()).toHaveLength(1);
  act(() => { visibility.mockReturnValue("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
  expect(offlineToasts()).toHaveLength(0);
  wait(60_000);
  expect(offlineToasts()).toHaveLength(0);
  act(() => { useConnection.setState({ state: "connecting", failures: 0 }); visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
  wait(OFFLINE_SHOWN_AFTER_MS);
  expect(offlineToasts()).toHaveLength(0);
  set("reconnecting", 1); wait(OFFLINE_SHOWN_AFTER_MS);
  expect(offlineToasts()).toHaveLength(1);
  set("live");
  expect(offlineToasts()).toHaveLength(0);
});

const line = () => document.querySelector("[data-progress-line]")?.getAttribute("data-progress-line") ?? null;
const said = () => screen.getByRole("status").textContent;
const offlineToasts = () => useToasts.getState().toasts.filter(toast => toast.id === OFFLINE_TOAST);
/** `offline` as the feed sets it: not live. */
const set = (state: "connecting" | "live" | "reconnecting" | "stopped", failures = 0) =>
  act(() => useConnection.setState({ state, failures, offline: state !== "live" }));
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
// jsdom has no AnimationEvent, so React listens for the prefixed name.
const fillEnds = () => fireEvent(document.querySelector("[data-progress-line] > * > *")!, new Event("webkitAnimationEnd", { bubbles: true }));
const mount = () => render(<TestWorkspace data={screenData()}><ProgressLine /><WorkspaceNotice /></TestWorkspace>);

test("opening a subscription flows; out of reach stands still in grey after the grace and says so once; back fills it", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mount();
  expect(line()).toBeNull();
  // A new subscription (a reload, a pull to refresh) is loading however long it takes, never offline.
  set("connecting");
  wait(OFFLINE_SHOWN_AFTER_MS * 5);
  expect(line()).toBe("loading");
  expect(offlineToasts()).toHaveLength(0);
  // A failed try is still loading until it lasts the grace.
  set("reconnecting", 1);
  wait(OFFLINE_SHOWN_AFTER_MS - 1);
  expect(line()).toBe("loading");
  wait(1);
  expect(line()).toBe("offline");
  expect(offlineToasts()).toHaveLength(1);
  expect(offlineToasts()[0]).toMatchObject({ kind: "info", stays: false, text: i18n.t("translation:offline.toast") });
  // More failures, a stop and a try in between do not say it again.
  set("connecting", 2); set("reconnecting", 3); set("stopped", 5);
  wait(OFFLINE_SHOWN_AFTER_MS);
  expect(line()).toBe("offline");
  expect(useToasts.getState().toasts).toHaveLength(1);
  // No band, no note: nothing on screen is written about it but the toast.
  expect(document.querySelector("[data-workspace-notice]")).toBeNull();
  set("live");
  expect(line()).toBe("back");
  expect(offlineToasts()).toHaveLength(0);
  expect(said()).toBe(i18n.t("chrome:notice.back"));
  fillEnds();
  expect(line()).toBeNull();
  // Out of reach again is a new moment: it is said again.
  set("reconnecting", 1);
  wait(OFFLINE_SHOWN_AFTER_MS);
  expect(offlineToasts()).toHaveLength(1);
});

test("a blip shorter than the grace draws only the loading line and says nothing", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  mount();
  set("reconnecting", 1);
  wait(OFFLINE_SHOWN_AFTER_MS - 500);
  set("live");
  wait(OFFLINE_SHOWN_AFTER_MS);
  expect(line()).toBe("done");
  expect(useToasts.getState().toasts).toHaveLength(0);
  expect(said()).toBe("");
});

test("out of reach before anything was read still draws the grey line", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  useConnection.setState({ state: "connecting", offline: true, failures: 0, lastReceivedAt: undefined });
  mount();
  expect(line()).toBe("loading");
  set("reconnecting", 1);
  wait(OFFLINE_SHOWN_AFTER_MS);
  expect(line()).toBe("offline");
});

test("a status left from another workspace does not silence this workspace's offline notice", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  queryClient.clear();
  queryClient.setQueryData(["update-status", "/previous-workspace"], { kind: "applying", opId: "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", version: "0.10.0" });
  queryClient.setQueryData(["update-status", "/fixture"], { kind: "none" });
  mount();
  set("reconnecting", 1); wait(OFFLINE_SHOWN_AFTER_MS);
  expect(line()).toBe("offline");
  expect(offlineToasts()).toHaveLength(1);
});

test("a switch under way in this workspace silences the offline notice", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  queryClient.clear();
  queryClient.setQueryData(["update-status", "/fixture"], { kind: "applying", opId: "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", version: "0.10.0" });
  mount();
  set("reconnecting", 1); wait(OFFLINE_SHOWN_AFTER_MS);
  expect(line()).toBe("offline");
  expect(offlineToasts()).toHaveLength(0);
});

test("an offline notice already shown ends once the switch is known to be under way", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  queryClient.clear();
  queryClient.setQueryData(["update-status", "/fixture"], { kind: "none" });
  mount();
  set("reconnecting", 1); wait(OFFLINE_SHOWN_AFTER_MS);
  expect(offlineToasts()).toHaveLength(1);
  act(() => { queryClient.setQueryData(["update-status", "/fixture"], { kind: "applying", opId: "4f9c2c1e-8a8b-4a43-9a4d-6f1d2f0b9c11", version: "0.10.0" }); });
  expect(offlineToasts()).toHaveLength(0);
});

test("a place's read again draws nothing while quick; a slow one shows, stays through slow reads that follow, then fades", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const reading = () => document.querySelector("[data-reading-line]")?.getAttribute("data-reading-line") ?? null;
  const view = render(<ReadingLine reading={false} />);
  const read = (on: boolean) => view.rerender(<ReadingLine reading={on} />);
  const quick = () => { read(true); wait(READING_SHOWN_AFTER_MS - 1); read(false); };
  // Reads as quick as a live update's, one after another: never a line.
  for (let at = 0; at < 5; at++) { quick(); wait(500); }
  expect(reading()).toBeNull();
  // A read that lasts: the line, and the next slow read soon after keeps it.
  read(true); wait(READING_SHOWN_AFTER_MS);
  expect(reading()).toBe("loading");
  // The next one starts just before the hold runs out: the line stays all through it, slow or not yet known.
  read(false); wait(READING_HELD_MS - 100); read(true);
  for (let at = 0; at < READING_SHOWN_AFTER_MS; at += 100) { wait(100); expect(reading()).toBe("loading"); }
  read(false);
  wait(READING_HELD_MS - 1);
  expect(reading()).toBe("loading");
  // Quick reads after it do not keep it: it fades on time, then goes.
  wait(1);
  expect(reading()).toBe("leaving");
  fireEvent(document.querySelector("[data-reading-line] > *")!, new Event("webkitAnimationEnd", { bubbles: true }));
  expect(reading()).toBeNull();
  // A quick read under way when the hold runs out keeps the line only until it ends.
  read(true); wait(READING_SHOWN_AFTER_MS); read(false);
  wait(READING_HELD_MS - 100); read(true); wait(200);
  expect(reading()).toBe("loading");
  read(false);
  expect(reading()).toBe("leaving");
});
