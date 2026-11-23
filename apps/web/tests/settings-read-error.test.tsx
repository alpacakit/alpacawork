import { afterEach, beforeAll, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { ServerSettings } from "@alpacawork/contract";
import { SettingsBody } from "../src/features/panels/SettingsDialog";
import { resources } from "../src/data/resources";
import { queryClient } from "../src/data/query-client";
import { screenData, TestWorkspace } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); queryClient.clear(); });

test("a settings read error shows a way to load the repaired file", () => {
  const data = screenData();
  const key = resources.serverSettings("/fixture").queryKey;
  queryClient.setQueryData(key, { ...queryClient.getQueryData<ServerSettings>(key)!, hash: null, error: { code: "unavailable", retry: "check", message: "EACCES", reason: { kind: "system_error", code: "EACCES", diagnostic: "EACCES" } } });
  render(<TestWorkspace data={data}><SettingsBody initialTab="ai" /></TestWorkspace>);
  const ai = within(document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!);
  // The reason is said once, under the heading; the heading holds no placeholder left unfilled.
  expect(ai.getByText("Cannot read config.yaml. Fix it by hand.")).toBeTruthy();
  expect(ai.getByText(/Technical details: EACCES/)).toBeTruthy();
  expect(ai.getByRole("button", { name: "Retry" })).toBeTruthy();
  // The folder comes from the workspace, not config.yaml, so it is still shown: it says which file to fix.
  expect(ai.getByText("/fixture")).toBeTruthy();
  // General's Advanced options, which show the same draft, say the same in its place.
  expect(within(document.getElementById("server-advanced")!).getByText(/Cannot read config.yaml/)).toBeTruthy();
});
