import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { api } from "../src/data/resources";
import { queryClient } from "../src/data/query-client";
import { useViewStore } from "../src/state/view-store";
import { AutomationsFace } from "../src/features/automations/AutomationsFace";
import { AutomationWindow } from "../src/features/automations/AutomationWindow";
import { AutomationAttentionRows } from "../src/features/automations/AttentionRows";
import { automation, listOf, run, seedAutomations, seedOne, serverPreview, serverRun, serverSignal, version } from "./automation-fixture";
import { screenData, TestWorkspace, tree } from "./fixtures";

beforeAll(async () => { startI18n(); await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); queryClient.clear(); useViewStore.setState(useViewStore.getInitialState()); });
const text = (selector: string) => document.querySelector(selector)?.textContent ?? null;
const rows = (group: string) => [...document.querySelectorAll(`[data-automation-group="${group}"] [data-automation-row]`)].map(row => row.getAttribute("data-automation-row"));

// It failed, and a run skipped for another reason came after: the failure is said by the run that failed.
const failing = automation({ id: "A7", name: "Weekly fixes",
  attention: [{ kind: "failed", at: "2026-11-27T00:33:00.000Z", run: 4, reasonKind: "ai_unavailable", reasonText: null }],
  lastRun: run(5, { automationId: "A7", state: "skipped", reasonKind: "daily_limit", summary: null, at: "2026-11-27T00:40:00.000Z" }) });
const fine = automation({ id: "A2", name: "Morning" });
const draft = automation({ id: "A9", name: "Findings", enabled: false, everEnabled: false, live: null,
  latest: version({ review: { state: "fix", findings: [{ level: "note", file: "main.ts", line: 4, text: "Cut long text" }], summary: "", model: "sonnet", at: "2026-11-27T05:01:00.000Z", acknowledged: null } }) });

test("the table puts those asking for a look first, says a failure in red with why, and marks a draft by its name", () => {
  const data = screenData();
  seedAutomations(data, listOf([fine, failing, draft], { today: { ai: 16, outside: 2 } }));
  render(<TestWorkspace data={data}><AutomationsFace place={{ tab: "list" }} /></TestWorkspace>);
  expect([rows("attention"), rows("on"), rows("rest")]).toEqual([["A7"], ["A2"], ["A9"]]);
  expect(text('[data-automation-row="A7"] [data-automation-last]')).toMatch(/Failed · The AI to run it/);
  expect(document.querySelector('[data-automation-row="A7"] [data-automation-dot="failed"]')).not.toBeNull();
  expect(text('[data-automation-row="A9"] [data-automation-mark]')).toBe("Draft");
  expect(text("[data-automations-today]")).toBe("Today: AI 16 · out 2");
});

test("one pressed on the home opens in the reader's window over the home, never moving to the automations face", () => {
  const data = screenData();
  seedAutomations(data, listOf([fine, failing]));
  render(<TestWorkspace data={data}><AutomationAttentionRows width={{}} edge={false} /></TestWorkspace>);
  expect([...document.querySelectorAll("[data-home-automation]")].map(row => row.getAttribute("data-home-automation"))).toEqual(["A7"]);
  act(() => fireEvent.click(document.querySelector('[data-home-automation="A7"] button')!));
  expect([useViewStore.getState().automation, useViewStore.getState().automations]).toEqual([{ id: "A7", pane: "about" }, null]);
});

const unread = { state: "fix" as const, findings: [{ level: "must" as const, file: "main.ts", line: 9, text: "Counts done tasks too" }], summary: "", model: "sonnet", at: "2026-11-27T05:01:00.000Z", acknowledged: null };

const opened = (id: string) => { useViewStore.setState({ automation: { id, pane: "about" } }); };
const windowOn = (data: ReturnType<typeof screenData>, id: string) => {
  const one = (queryClient.getQueriesData<{ automations: ReturnType<typeof automation>[] }>({ queryKey: ["automations"] })[0]?.[1]?.automations ?? []).find(each => each.id === id);
  if (one) seedOne(data, one);
  return render(<TestWorkspace data={data}><AutomationWindow id={id} mode="docked" canDock={false} /></TestWorkspace>);
};

test("a draft whose AI review found something is turned on from its band, saying the person read it", async () => {
  const data = screenData();
  seedAutomations(data, listOf([draft]));
  const sent: { path: string; body?: unknown }[] = [];
  vi.spyOn(api, "request").mockImplementation(async (path: string, _schema: unknown, _signal: unknown, body?: unknown) => {
    sent.push({ path, body });

    return new Promise(() => {});
  });
  opened("A9");
  windowOn(data, "A9");
  expect(text("[data-automation-summary]")).toBe("Counts the waiting tasks and asks for one summary task");
  // The review in one line; opened, each finding.
  expect(text('[data-automation-band="before-on"] [data-automation-review]')).toMatch(/^1 finding/);
  fireEvent.click(document.querySelector("[data-automation-review-open]")!);
  expect(text('[data-automation-band="before-on"]')).toContain("Note: Cut long text");
  // No switch on a draft: it is turned on from the band.
  expect(document.querySelector("[data-automation-switch]")).toBeNull();
  fireEvent.click(document.querySelector("[data-automation-band-act]")!);
  await waitFor(() => expect(sent.find(call => call.path.includes("automation/enable"))?.body).toEqual({ automation: "A9", expectedHash: draft.hash, acknowledgeReview: true }));
});

test("a new version waits beside the one running, what differs marked; dropping it puts back the one running", async () => {
  const live = version({ digest: "sha256:" + "1".repeat(64), docs: { run: { summary: "Asks when 1 or more wait", body: "", params: [], returns: null, throws: [] }, trigger: null } });
  const latest = version({ digest: "sha256:" + "2".repeat(64), docs: { run: { summary: "Asks when 3 or more wait", body: "", params: [], returns: null, throws: [] }, trigger: null } });
  const waiting = automation({ id: "A3", latest, live, awaitingEnable: true, attention: [{ kind: "awaiting_enable", at: "2026-11-27T07:10:00.000Z", run: null, reasonKind: null, reasonText: null }] });
  const data = screenData();
  seedAutomations(data, listOf([waiting]));
  const sent: { path: string; body?: unknown }[] = [];
  vi.spyOn(api, "request").mockImplementation(async (path: string, _schema: unknown, _signal: unknown, body?: unknown) => {
    sent.push({ path, body });

    return new Promise(() => {});
  });
  opened("A3");
  windowOn(data, "A3");
  expect([...document.querySelectorAll("[data-automation-differs]")].map(mark => mark.textContent)).toEqual(["1", "3"]);
  expect(text('[data-automation-band="awaiting"]')).toContain("you asked the coordinator “only from 3 on”");
  expect(text('[data-automation-band="awaiting"]')).toContain("Until you turn it on, the current version keeps running");
  // Saved by the coordinator with no words kept, it is said so, never as a sentence missing its maker.
  cleanup();
  const unworded = { ...waiting, latest: { ...latest, savedBy: { kind: "coordinator" as const, name: null, request: null } } };
  seedAutomations(data, listOf([unworded]));
  windowOn(data, "A3");
  expect(text('[data-automation-band="awaiting"]')).toMatch(/Made by the coordinator at \S/);
  fireEvent.click(document.querySelector("[data-automation-discard]")!);
  await waitFor(() => expect(sent.find(call => call.path.includes("automation/restore"))?.body).toEqual({ automation: "A3", expectedHash: waiting.hash, version: live.digest }));
});

test("trying runs trigger first, shows what run would do only when asked, and does it for real with what was shown", async () => {
  const data = screenData(tree());
  seedAutomations(data, listOf([fine]), { A2: [] });
  const sent: { path: string; body?: unknown }[] = [];
  vi.spyOn(api, "request").mockImplementation(async (path: string, _schema: unknown, _signal: unknown, body?: unknown) => {
    sent.push({ path, body });
    if (path.includes("automation/preview")) return { events: [serverSignal("s1", { service: "api" })], preview: (body as { run?: boolean }).run
      ? serverPreview("s1", "service is api", [{ name: "tasks.create", target: null, input: { title: "Check the API", ai: "worker" }, replaced: true, result: null, code: null, usage: null, outcome: "done" }], "asked")
      : serverPreview("s1", "service is api") };
    if (path.includes("automation/try")) return { automation: { id: "A2", project: "P1" }, run: serverRun(9, "trial") };
    return new Promise(() => {});
  });
  opened("A2");
  windowOn(data, "A2");
  fireEvent.click(document.querySelector("[data-automation-try]")!);
  await waitFor(() => expect(text("[data-automation-try-result]")).toContain("Let through: service is api"));
  // Only trigger was run: run was not asked for.
  expect(sent.filter(call => call.path.includes("automation/preview")).every(call => !(call.body as { run?: boolean }).run)).toBe(true);
  fireEvent.click(document.querySelector("[data-automation-try-run]")!);
  await waitFor(() => expect(text("[data-automation-try-result]")).toContain("Make task “Check the API” and ask"));
  fireEvent.click(document.querySelector("[data-automation-try-do]")!);
  await waitFor(() => expect(sent.find(call => call.path.includes("automation/try"))?.body).toEqual({ automation: "A2", previewHash: "p-s1-run" }));
  await waitFor(() => expect(useViewStore.getState().automation?.pane).toBe("log"));
});

test("a new version whose review is unread is turned on only after its findings are shown, saying they were read", async () => {
  const live = version({ digest: "sha256:" + "1".repeat(64) });
  const latest = version({ digest: "sha256:" + "2".repeat(64), review: unread });
  const waiting = automation({ id: "A3", latest, live, awaitingEnable: true, attention: [{ kind: "awaiting_enable", at: "2026-11-27T07:10:00.000Z", run: null, reasonKind: null, reasonText: null }] });
  const data = screenData();
  seedAutomations(data, listOf([waiting]));
  const sent: { path: string; body?: unknown }[] = [];
  vi.spyOn(api, "request").mockImplementation(async (path: string, _schema: unknown, _signal: unknown, body?: unknown) => {
    sent.push({ path, body });

    return new Promise(() => {});
  });
  opened("A3");
  windowOn(data, "A3");
  // Pressed twice, nothing is sent: the findings come first, and where the press was stands Cancel.
  fireEvent.click(document.querySelector('[data-automation-band="awaiting"] [data-automation-band-act]')!);
  expect(document.querySelector('[data-automation-band="before-on"] h3 + [data-automation-band-back]')).not.toBeNull();
  expect(sent.some(call => call.path.includes("automation/enable"))).toBe(false);
  expect(text('[data-automation-band="before-on"] [data-automation-review]')).toMatch(/^1 to fix/);
  fireEvent.click(document.querySelector("[data-automation-review-open]")!);
  expect(text('[data-automation-band="before-on"]')).toContain("Fix: Counts done tasks too");
  // Having read them, the person may go back to the band they came from (to drop the new version instead).
  fireEvent.click(document.querySelector("[data-automation-band-back]")!);
  expect(document.querySelector('[data-automation-band="awaiting"]')).not.toBeNull();
  fireEvent.click(document.querySelector('[data-automation-band="awaiting"] [data-automation-band-act]')!);
  fireEvent.click(document.querySelector('[data-automation-band="before-on"] [data-automation-band-act]')!);
  await waitFor(() => expect(sent.find(call => call.path.includes("automation/enable"))?.body).toEqual({ automation: "A3", expectedHash: waiting.hash, acknowledgeReview: true }));
});

test("while another event's showing is on its way, the last one's answer is not shown and nothing can be done from it", async () => {
  const data = screenData(tree());
  seedAutomations(data, listOf([fine]), { A2: [] });
  const events = [serverSignal("s1"), serverSignal("s2")];
  let answer: (value: unknown) => void = () => {};
  vi.spyOn(api, "request").mockImplementation(async (path: string, _schema: unknown, _signal: unknown, body?: unknown) => {
    if (path.includes("automation/preview")) return (body as { event?: string }).event === "s2" ? new Promise(resolve => { answer = resolve; })
      : { events, preview: serverPreview("s1", "passes s1") };
    return new Promise(() => {});
  });
  opened("A2");
  windowOn(data, "A2");
  fireEvent.click(document.querySelector("[data-automation-try]")!);
  await waitFor(() => expect(text("[data-automation-try-result]")).toContain("passes s1"));
  fireEvent.click(document.querySelector('[data-automation-try-event="s2"] input')!);
  await waitFor(() => expect(document.querySelector("[data-automation-try-result]")).toBeNull());
  expect(document.querySelector<HTMLButtonElement>("[data-automation-try-do]")!.disabled).toBe(true);
  act(() => answer({ events, preview: serverPreview("s2", "passes s2") }));
  await waitFor(() => expect(text("[data-automation-try-result]")).toContain("passes s2"));
  // Choosing to write what arrives shows nothing to do until it is sent.
  fireEvent.click(document.querySelector("[data-automation-try-write] input")!);
  await waitFor(() => expect(document.querySelector("[data-automation-try-result]")).toBeNull());
  expect(document.querySelector<HTMLButtonElement>("[data-automation-try-do]")!.disabled).toBe(true);
});

test("a draft that sends to a destination not entered yet says so and is turned on only once it is entered here", async () => {
  const sending = automation({ id: "A8", name: "To chat", enabled: false, everEnabled: false, live: null,
    latest: version({ facts: { ...version().facts, outside: [{ name: "chat", host: null, ready: false }] } }) });
  const data = screenData();
  seedAutomations(data, listOf([sending]));
  const sent: { path: string; body?: unknown }[] = [];
  vi.spyOn(api, "request").mockImplementation(async (path: string, _schema: unknown, _signal: unknown, body?: unknown) => {
    sent.push({ path, body });
    if (path.includes("automation/destination-list")) return { destinations: [] };
    return new Promise(() => {});
  });
  opened("A8");
  windowOn(data, "A8");
  const band = '[data-automation-band="before-on"]';
  expect(text(`${band} [data-automation-destination="chat"]`)).toContain("Not entered yet");
  expect(document.querySelector<HTMLButtonElement>(`${band} [data-automation-band-act]`)!.disabled).toBe(true);
  fireEvent.click(document.querySelector(`${band} [data-automation-destination-edit]`)!);
  fireEvent.change(document.querySelector(`${band} [data-automation-destination-url]`)!, { target: { value: "https://hooks.example.com/x" } });
  fireEvent.click(document.querySelector(`${band} [data-automation-destination-save]`)!);
  await waitFor(() => expect(sent.find(call => call.path.includes("automation/destination-set"))?.body).toEqual({ under: "P1", name: "chat", url: "https://hooks.example.com/x" }));
});
