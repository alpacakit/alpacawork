import { test, beforeAll, afterEach, expect, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import type { HostEpisodeMinutes, HostStatus } from "@alpacawork/contract";
import { api } from "../src/data/resources";
import { formatGigabytes, formatPercent, sparkShape } from "../src/domain/host";
import { HostTab } from "../src/features/panels/HostTab";
import { WorkspaceNotice } from "../src/features/chrome/WorkspaceNotice";
import { useConnection } from "../src/data/connection";
import { useDialogStore } from "../src/state/dialog-store";
import { TestWorkspace, screenData, tree } from "./fixtures";

beforeAll(() => startI18n());
afterEach(() => { cleanup(); vi.restoreAllMocks(); useDialogStore.getState().close(); });

const GB = 1024 ** 3;
const now = Date.now();
const run = (n: number, cpu: number, role: "owner" | "worker" = "owner") => ({ runId: `R${n}`, taskId: "T1", title: `Task ${n}`, model: "opus", role,
  cpu, memoryBytes: n * GB, processes: 3, heaviest: n === 1 ? { name: "vitest", count: 4 } : null });
const status: HostStatus = {
  supported: true, facts: { hostname: "workstation", os: "Ubuntu 24.04", cores: 52, memoryBytes: 125 * GB }, parallel: 12,
  sample: { at: now, cpu: 6.3, memory: { totalBytes: 125 * GB, availableBytes: 100 * GB, swapUsedBytes: 0 }, load: [5.2, 4.9, 4.5],
    disk: { freeBytes: 465 * GB, totalBytes: 915 * GB },
    runs: [run(1, 31), run(2, 0.4, "worker"), run(3, 0.02), run(4, 0.01), run(5, 0)],
    outside: { cpu: 1.9, memoryBytes: 25 * GB, names: ["chrome-headless", "Xorg"] } },
  history: [{ at: now - 20_000, cpu: 5, memoryFreePercent: 80 }, { at: now, cpu: 6.3, memoryFreePercent: 80 }],
  current: null,
  episodes: [{ id: 7, start: now - 3_600_000, end: now - 3_000_000, kinds: ["cpu"], peak: { cpu: 99.4, memoryFreePercent: 40, diskFreeBytes: 465 * GB },
    runs: [{ runId: "R1", taskId: "T1", title: "Task 1", model: "opus", role: "owner", cpuPeak: 46, memoryPeakBytes: 2.4 * GB, heaviest: "vitest ×4",
      firstSeen: now - 3_600_000, lastSeen: now - 3_000_000 }] }],
  limits: { cpu: 90, memoryFreePercent: 10, diskFreeBytes: 20 * GB }, error: null,
};

test("numbers keep small shares readable and lines break where a value is missing", () => {
  expect([formatPercent(null), formatPercent(0.01), formatPercent(0.42), formatPercent(31.4)]).toEqual(["—", "0%", "0.4%", "31%"]);
  expect([formatGigabytes(0.3 * GB), formatGigabytes(465.4 * GB)]).toEqual(["0.3 GB", "465 GB"]);
  const shape = sparkShape([{ at: 0, value: 95 }, { at: 10, value: null }, { at: 20, value: 50 }, { at: 30, value: 60 }],
    { from: 0, to: 30 }, 90, false, 30, 10, 10);
  expect(shape.paths).toHaveLength(2);
  expect(shape.bands).toHaveLength(1);
});

test("the tab shows this machine, the heaviest Runs with a way to their Task, and opens a past episode", async () => {
  const minutes: HostEpisodeMinutes = { from: now - 4_200_000, to: now - 2_400_000,
    minutes: [{ at: now - 3_600_000, cpuAverage: 95, cpuMax: 99, memoryFreeAverage: 40, memoryFreeMin: 39 }] };
  const request = vi.spyOn(api, "request").mockImplementation(async (path: string) => path === "host/status" ? status : minutes);
  render(<TestWorkspace data={screenData(tree())}><HostTab /></TestWorkspace>);
  expect(await screen.findByText(i18n.t("panels:host.calm"))).toBeTruthy();
  expect(screen.getByText(i18n.t("panels:host.facts", { hostname: "workstation", os: "Ubuntu 24.04", cores: 52, memory: "125 GB" }))).toBeTruthy();
  expect(screen.getByText(i18n.t("panels:host.cpuNote", { load: "5.2", cores: 52 }))).toBeTruthy();
  expect(screen.getByText("31% · 1.0 GB")).toBeTruthy();
  expect(screen.getByText("0.4% · 2.0 GB")).toBeTruthy();
  expect(screen.getByText(`opus · ${i18n.t("panels:host.worker")}`)).toBeTruthy();
  expect(screen.getByText(i18n.t("panels:host.outsideNames", { names: "chrome-headless · Xorg" }))).toBeTruthy();
  expect(screen.getByText(i18n.t("panels:host.moreRuns", { count: 2, cpu: "0%", memory: "9.0 GB" }))).toBeTruthy();

  const episode = screen.getByRole("button", { expanded: false });
  fireEvent.click(episode);
  await waitFor(() => expect(request).toHaveBeenCalledWith("host/episode?id=7", expect.anything(), expect.anything()));
  const detail = episode.parentElement!;
  expect(within(detail).getByText(i18n.t("panels:host.episodeRuns"))).toBeTruthy();
  expect(within(detail).getByText(`opus · vitest ×4 · ${i18n.t("panels:host.whole", { minutes: 10 })}`)).toBeTruthy();

  useDialogStore.getState().open("settings", { tab: "host" });
  fireEvent.click(screen.getByText("Task 1", { selector: "[data-host-run] span" }));
  expect(useDialogStore.getState().dialog).toBeNull();
});

test("the coordinator's Run is named in the screen's language, not by the title the server gave it", async () => {
  const coordinator = { ...run(1, 31), taskId: null, title: "Unlocalized coordinator title" };
  vi.spyOn(api, "request").mockResolvedValue({ ...status, sample: { ...status.sample!, runs: [coordinator] } });
  render(<TestWorkspace data={screenData(tree())}><HostTab /></TestWorkspace>);
  expect(await screen.findByText("Coordinator", { selector: "[data-host-run] span" })).toBeTruthy();
  expect(screen.queryByText("Unlocalized coordinator title")).toBeNull();
});

test.each(["darwin", "win32"])("an unmeasured %s machine says so instead of empty meters", async (platform) => {
  vi.spyOn(api, "request").mockResolvedValue({ supported: false, platform });
  render(<TestWorkspace data={screenData(tree())}><HostTab /></TestWorkspace>);
  expect(await screen.findByText(i18n.t("panels:host.unsupported", { platform }))).toBeTruthy();
});

test("a tight machine is the lowest notice and opens Host status", () => {
  useConnection.setState({ offline: false });
  const data = screenData(tree());
  data.info.host = { since: new Date(now - 12 * 60_000).toISOString(), kinds: ["cpu"], cpu: 98, memoryFreePercent: 40, diskFreeBytes: 400 * GB };
  const view = render(<TestWorkspace data={data}><WorkspaceNotice /></TestWorkspace>);
  expect(screen.getByText(i18n.t("chrome:notice.hostTight"))).toBeTruthy();
  expect(screen.getByText(`${i18n.t("chrome:notice.hostCpu", { value: "98%" })} · ${i18n.t("chrome:notice.hostMinutes", { count: 12 })}`)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("chrome:notice.hostOpen") }));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "host" });
  view.unmount();
  const readOnly = screenData(tree({ writable: false }));
  readOnly.info.host = data.info.host;
  render(<TestWorkspace data={readOnly}><WorkspaceNotice /></TestWorkspace>);
  expect(screen.queryByText(i18n.t("chrome:notice.hostTight"))).toBeNull();
});

test("asking for Host status while settings are open moves there and keeps the other tabs mounted", async () => {
  vi.spyOn(api, "request").mockImplementation(async (path: string) => path === "host/status" ? status : { error: "unused" });
  const { SettingsBody } = await import("../src/features/panels/SettingsDialog");
  const view = render(<TestWorkspace data={screenData(tree())}><SettingsBody initialTab="server" request={1} /></TestWorkspace>);
  expect(screen.getByRole("tab", { name: i18n.t("panels:settings.tabs.server") }).getAttribute("data-state")).toBe("active");
  view.rerender(<TestWorkspace data={screenData(tree())}><SettingsBody initialTab="host" request={2} /></TestWorkspace>);
  expect(screen.getByRole("tab", { name: i18n.t("panels:settings.tabs.host") }).getAttribute("data-state")).toBe("active");
  expect(document.querySelector('[role="tabpanel"][hidden]'), "the server draft stays mounted while hidden").toBeTruthy();
});

test("unavailable load, swap and process values are shown as gaps through the real tab", async () => {
  const missing: HostStatus = { ...status, sample: { ...status.sample!, load: null,
    memory: { ...status.sample!.memory, swapUsedBytes: null },
    runs: [{ ...run(1, 1), cpu: null, memoryBytes: null }],
    outside: { cpu: null, memoryBytes: null, names: [] } } };
  vi.spyOn(api, "request").mockResolvedValue(missing);
  render(<TestWorkspace data={screenData(tree())}><HostTab /></TestWorkspace>);
  expect(await screen.findByText(i18n.t("panels:host.cpuNote", { load: "—", cores: 52 }))).toBeTruthy();
  expect(screen.getByText(i18n.t("panels:host.memoryNote", { swap: "—", free: "100 GB" }))).toBeTruthy();
  expect(screen.getAllByText("— · —")).toHaveLength(2);
  expect(screen.queryByText("0% · 0.0 GB")).toBeNull();
});

test("adapter initialization failure shows its error without claiming the machine is keeping up", async () => {
  vi.spyOn(api, "request").mockResolvedValue({ ...status, facts: null, sample: null,
    error: { code: "unavailable", message: "resource initialization denied", retry: "check",
      reason: { kind: "host_failure", operation: "sample", cause: { kind: "unexpected_error", name: "Error", diagnostic: "resource initialization denied" } } } });
  render(<TestWorkspace data={screenData(tree())}><HostTab /></TestWorkspace>);
  expect(await screen.findByText(/resource initialization denied/)).toBeTruthy();
  expect(screen.queryByText(i18n.t("panels:host.calm"))).toBeNull();
  expect(screen.queryByText(/125 GB/)).toBeNull();
});
