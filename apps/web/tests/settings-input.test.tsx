import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { SettingsBody } from "../src/features/panels/SettingsDialog";
import { useDialogStore } from "../src/state/dialog-store";
import { queryClient } from "../src/data/query-client";
import { screenData, TestWorkspace } from "./fixtures";

vi.mock("../src/data/mobile-access", () => ({ useMobileAccess: () => ({
  data: { status: "serving", publicUrl: null }, isPending: false, isError: false,
}) }));
beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); queryClient.clear(); });

let coarse = false;
let listeners: Set<() => void>;
beforeEach(() => {
  coarse = false;
  listeners = new Set();
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(pointer: coarse)" ? {
    ...original(query), get matches() { return coarse; },
    addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
    removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
  } as MediaQueryList : original(query));
});
const changePointer = (value: boolean) => act(() => { coarse = value; for (const listener of listeners) listener(); });
const active = () => screen.getByRole("tab", { selected: true }).textContent;

test("a remembered phone guide on coarse input opens Yours with no guide entry or body", () => {
  coarse = true;
  render(<TestWorkspace><SettingsBody initialTab="apps" /></TestWorkspace>);
  expect(screen.queryByRole("tab", { name: "App & phone" })).toBeNull();
  expect(document.querySelector("[data-app-guide]")).toBeNull();
  expect(active()).toBe("Personal");
  expect(useDialogStore.getState().settingsTab).toBe("personal");
});

test("changing the primary pointer replaces an open guide and does not resurrect it on PC or reopening", () => {
  const view = render(<TestWorkspace><SettingsBody initialTab="apps" /></TestWorkspace>);
  expect(document.querySelector("[data-app-guide]")).toBeTruthy();
  changePointer(true);
  expect(active()).toBe("Personal");
  expect(document.querySelector("[data-app-guide]")).toBeNull();
  changePointer(false);
  expect(screen.getByRole("tab", { name: "App & phone" })).toBeTruthy();
  expect(active()).toBe("Personal");
  expect(useDialogStore.getState().settingsTab).toBe("personal");
  view.unmount();
  expect(listeners.size).toBe(0);
  render(<TestWorkspace><SettingsBody initialTab={useDialogStore.getState().settingsTab} /></TestWorkspace>);
  expect(active()).toBe("Personal");
});

test("later tab requests follow availability and retain the server draft", () => {
  coarse = true;
  const data = screenData();
  const view = render(<TestWorkspace data={data}><SettingsBody initialTab="server" request={1} /></TestWorkspace>);
  const draft = document.querySelector('[role="tabpanel"][data-state="active"]');
  expect(active()).toBe("Server");
  view.rerender(<TestWorkspace data={data}><SettingsBody initialTab="apps" request={2} /></TestWorkspace>);
  expect(active()).toBe("Personal");
  expect(document.querySelector("[data-app-guide]")).toBeNull();
  expect(draft?.isConnected).toBe(true);
  changePointer(false);
  view.rerender(<TestWorkspace data={data}><SettingsBody initialTab="apps" request={3} /></TestWorkspace>);
  expect(active()).toBe("App & phone");
  expect(document.querySelector("[data-app-guide]")).toBeTruthy();
});

test("a change in input preserves another selected tab", () => {
  render(<TestWorkspace><SettingsBody initialTab="server" /></TestWorkspace>);
  changePointer(true);
  expect(active()).toBe("Server");
  changePointer(false);
  expect(active()).toBe("Server");
});
