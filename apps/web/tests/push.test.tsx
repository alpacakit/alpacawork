import { test, beforeAll, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import { PushSection } from "../src/features/panels/PushSection";
import { SettingsDialog } from "../src/features/panels/SettingsDialog";
import { deviceLabel } from "../src/data/push";
import { queryClient } from "../src/data/query-client";
import { PROJECT_TASK, TestWorkspace, tree, viewsOf } from "./fixtures";
import { adapterCatalog, DEFAULT_LIMITS } from "@alpacawork/contract";

beforeAll(() => startI18n());
afterEach(() => { cleanup(); queryClient.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test("without a Service Worker or the Push API the section only explains", () => {
  render(<TestWorkspace><PushSection /></TestWorkspace>);
  expect(screen.getByText(/Not available here/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});

/** A browser with push: `navigator.serviceWorker`, `PushManager`, `Notification`. */
function pushBrowser(options: { permission?: NotificationPermission; subscribed?: boolean } = {}) {
  const endpoint = "https://fcm.googleapis.com/fcm/send/this-browser";
  let held = !!options.subscribed;
  const own = { endpoint, unsubscribe: vi.fn(async () => { held = false; return true; }), toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } }) };
  const pushManager = { getSubscription: vi.fn(async () => (held ? own : null)), subscribe: vi.fn(async () => { held = true; return own; }) };
  const registration = { pushManager };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(registration), addEventListener() {}, removeEventListener() {} } });
  vi.stubGlobal("PushManager", function PushManager() {});
  const requestPermission = vi.fn(async () => "granted" as NotificationPermission);
  vi.stubGlobal("Notification", { permission: options.permission ?? "default", requestPermission });
  const calls: { path: string; body?: unknown }[] = [];
  const devices: { id: string; label: string; endpoint: string; created_at: string }[] = options.subscribed
    ? [{ id: "1234567890abcdef", label: "Chrome · Android", endpoint, created_at: "2026-09-27T01:00:00Z" }]
    : [{ id: "fedcba0987654321", label: "Safari · Mac", endpoint: "https://web.push.apple.com/other", created_at: "2026-09-26T01:00:00Z" }];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = input.replace(/^\/api\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (path === "telemetry/status") return reply({ state: "blocked", blockedBy: "fixture", digest: null });
    if (path === "environment-file") return reply({ path: "/fixture-home/.config/alpacawork/env", state: "absent", applied: 0, skipped: [] });
    if (path === "notify/devices") return reply({ devices });
    if (path.split("?")[0] === "commands/config/get" || path === "commands/config/inspect") return reply({ hash: "c".repeat(64), limits: { ...DEFAULT_LIMITS }, agentsText: "agents: {}\n", agents: {}, catalog: adapterCatalog() });
    if (path === `task/view?task=${PROJECT_TASK}`) return reply(viewsOf(tree()).find((view) => view.task.id === PROJECT_TASK));
    if (path === "notify/key") return reply({ key: "B" + "A".repeat(86) });
    if (path === "notify/subscribe") { devices.push({ id: "1234567890abcdef", label: body.label, endpoint: body.subscription.endpoint, created_at: "2026-09-27T02:00:00Z" }); return reply({ id: "1234567890abcdef" }); }
    if (path === "notify/unsubscribe") { const index = devices.findIndex((device) => device.id === body.id); if (index >= 0) devices.splice(index, 1); return reply({ removed: index >= 0 }); }
    return new Response("{}", { status: 404 });
  }));
  return { own, pushManager, requestPermission, calls, devices };
}

test("subscribing asks permission, subscribes with the server key and registers this device", async () => {
  const browser = pushBrowser();
  render(<TestWorkspace><PushSection /></TestWorkspace>);
  expect(await screen.findByText("Safari · Mac", { exact: false })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Receive on this device" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop receiving on this device" })).toBeTruthy());
  expect(browser.requestPermission).toHaveBeenCalledOnce();
  expect(browser.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  const subscribe = browser.calls.find((call) => call.path === "notify/subscribe")!;
  expect(subscribe.body).toMatchObject({ subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/this-browser" } });
  expect(typeof (subscribe.body as { label: string }).label).toBe("string");
  expect(screen.getByText(/This device gets notifications/)).toBeTruthy();
  expect(screen.getAllByText(/this device/).length).toBeGreaterThan(0);
});

test("a blocked permission offers no button; stopping unsubscribes the browser and removes the device", async () => {
  pushBrowser({ permission: "denied" });
  const blocked = render(<TestWorkspace><PushSection /></TestWorkspace>);
  expect(await blocked.findByText(/Notifications are blocked/)).toBeTruthy();
  expect(blocked.queryByRole("button", { name: /Receive/ })).toBeNull();
  blocked.unmount(); queryClient.clear(); vi.unstubAllGlobals();
  const browser = pushBrowser({ permission: "granted", subscribed: true });
  render(<TestWorkspace><PushSection /></TestWorkspace>);
  fireEvent.click(await screen.findByRole("button", { name: "Stop receiving on this device" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Receive on this device" })).toBeTruthy());
  expect(browser.own.unsubscribe).toHaveBeenCalledOnce();
  expect(browser.calls.find((call) => call.path === "notify/unsubscribe")?.body).toEqual({ id: "1234567890abcdef" });
  expect(await screen.findByText("No device is registered.")).toBeTruthy();
});

test("a subscription serve no longer lists is offered again", async () => {
  const browser = pushBrowser({ permission: "granted", subscribed: true });
  browser.devices.splice(0);
  render(<TestWorkspace><PushSection /></TestWorkspace>);
  expect(await screen.findByRole("button", { name: "Receive on this device" })).toBeTruthy();
  expect(screen.getByText("No device is registered.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Receive on this device" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop receiving on this device" })).toBeTruthy());
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  expect(browser.calls.filter((call) => call.path === "notify/subscribe")).toHaveLength(1);
});

test("the device label names the browser and the platform", () => {
  expect(deviceLabel("Mozilla/5.0 (Linux; Android 16; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36")).toBe("Chrome · Android");
  expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15")).toBe("Safari · Mac");
  expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0")).toBe("Edge · Windows");
});


test("the notifications tab shows the existing subscription without disturbing the AI tab's draft", async () => {
  const browser = pushBrowser({ permission: "granted", subscribed: true });
  render(<TestWorkspace><SettingsDialog /></TestWorkspace>);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "AI" }), { button: 0, ctrlKey: false });
  fireEvent.change(await screen.findByLabelText("Max concurrent runs"), { target: { value: "5" } });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Notifications" }), { button: 0, ctrlKey: false });
  expect(await screen.findByRole("button", { name: "Stop receiving on this device" })).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "AI" }), { button: 0, ctrlKey: false });
  expect(within(document.querySelector<HTMLElement>("[data-settings-foot]")!).getByRole("button", { name: "Save" })).toBeTruthy();
  expect((screen.getByLabelText("Max concurrent runs") as HTMLInputElement).value).toBe("5");
  expect(browser.requestPermission).not.toHaveBeenCalled();
  expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  expect(browser.own.unsubscribe).not.toHaveBeenCalled();
  // Opening settings reads update and usage status and the environment file's too, never a write or subscription change.
  expect(browser.calls.every((call) => ["notify/devices", "commands/config/get", "commands/config/inspect", "update/status", "telemetry/status", "environment-file"].includes(call.path.split("?")[0]!))).toBe(true);
});
