import { serverPatch, serverView } from './receipt-fixture';
import { serverReadFacts, readerPresentation } from '../src/data/read-model';
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, beforeAll, beforeEach, afterEach, expect, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { startI18n, i18n } from "@alpacawork/i18n";
import { notify, useToasts } from "../src/lib/notify";
import { controlTreeSchema, type ProjectedIndexDTO, type ControlTreeDTO } from "@alpacawork/contract/control";
import { Reader } from "../src/features/reader/Reader";
import { useTitleKeys } from "../src/features/forms/title-keys";
import { DialogHost } from "../src/features/shell/DialogHost";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { intentKey, useWriteIntentStore } from "../src/data/write-intent";
import { useUndoOffers } from "../src/data/undo-offers";
import { indexKey, receivePatch } from "../src/data/resources";
import { useDialogStore } from "../src/state/dialog-store";
import { useViewStore, type ReaderPane } from "../src/state/view-store";
import { indexTasks } from "../src/domain/tasks";
import { parentChoices } from "../src/features/forms/MoveInputs";
import { ResponsibleSection } from "../src/features/forms/ResponsibleInputs";
import { openInput } from "../src/state/open-input";
import { headOf, TestWorkspace, dto, historyFixture, indexOf, screenData, tree, userBall, PROJECT_TASK, launchProfile } from "./fixtures";
import { problemResponse } from "./problem";

/**
 * The canonical wire examples (tests/fixtures/contract-examples),
 * used as they are: people on cards and in the map bar, the reader's panes,
 * and the request to the responsible person with its refusals.
 */
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "../../../tests/fixtures/contract-examples", name), "utf8"));
/** The canonical tree, in the fixture's project. */
const canonical = tree(controlTreeSchema.parse(fixture("tree.json")));
const request = fixture("request.json") as { input: unknown; receipt: unknown; rejection: unknown };

/** A tree with what the server projects of it, as a test gives it (fixtures' `tree`). */
type Given = NonNullable<Parameters<typeof tree>[0]>;
const fixtureScreen = (value: Given = canonical) => screenData(tree(value));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const requestAnswer = () => json({ task: headOf(canonical.tasks.find(task => task.id === "T1")!),
  outcome: { kind: "request_accepted", opId: (request.receipt as { requestId: string }).requestId, request: request.receipt } });
const posted = () => vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init!.body)) }));
function serve(onRequest: () => Response | Promise<Response>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const path = String(url);
    if (path === "/api/workspace/live") return json(indexOf(canonical));
    if (path === "/api/task/report" && init?.method === "POST") return onRequest();
    return problemResponse("not_found", "Unknown");
  });
}
function openReader(taskId: string, pane: ReaderPane | undefined = undefined, tree?: Given) {
  const selectedPane = pane ?? "task";
  useViewStore.setState({ selected: taskId, reader: { open: true, pane: selectedPane, returnTo: null } });
  const data = fixtureScreen(tree);
  return render(<TestWorkspace data={data}><Reader mode="docked" /></TestWorkspace>);
}
const composer = () => screen.getByRole("textbox", { name: "Request to codex(unknown)" });

beforeAll(() => startI18n());
beforeEach(() => {
  useConnection.setState({ offline: false }); useDialogStore.setState({ dialog: null }); useViewStore.setState(useViewStore.getInitialState());
  vi.spyOn(notify, "error").mockImplementation(() => "error");
  vi.spyOn(notify, "info").mockImplementation(() => "info");
});
afterEach(async () => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); for (const toast of useToasts.getState().toasts) notify.dismiss(toast.id); await i18n.changeLanguage("en"); });

async function reopenDecision(form: 'move' | 'responsible', taskId: string) {
  await waitFor(() => expect(['pending',undefined]).not.toContain(useWriteIntentStore.getState().entries[intentKey(canonical.root,form,taskId)]?.status));
  act(() => openInput({ form, taskId }));
}

test("a stopped Run appears in the report column, and review can still be drafted", async () => {
  serve(() => requestAnswer());
  const member = { ...canonical.placements[2]!, id: "P4", taskId: "T12", responsible: false, active: true, endedAt: null };
  const failed = { ...canonical.runs[0]!, id: "R4", taskId: "T12", placementId: "P4", state: "failed" as const,
    startedAt: "2026-09-29T00:02:00.000Z", endedAt: "2026-09-29T00:03:00.000Z" };
  const idle = canonical.placements.map((placement) => placement.id === "P2"
    ? { ...placement, runtime: { ...placement.runtime, displayState: "idle" as const, reason: null } } : placement);
  // The column draws T12's History as the server projects it: its review, then the member's Run that failed.
  openReader("T12", "task", { ...canonical, placements: [...idle, member], runs: [...canonical.runs, failed],
    balls: { T12: userBall("review", "L2", "2026-09-29T00:03:00.000Z", { aboutRunId: "R2" }) },
    history: { T12: historyFixture([{ id: "R4", kind: "error", taskId: "T12", at: "2026-09-29T00:03:00.000Z", title: "Run failed" },
      { id: "L2", kind: "review", taskId: "T12", at: "2026-09-29T00:05:00.000Z", state: "waiting", title: "Ready for review" }]) } });
  // A member's Run that failed is its own row.
  expect(document.querySelector('[data-report-key="run:R4:finished"] [data-row-name]')).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Words with the answer" })).toBeNull();
});

const placementOps = fixture("placement-operations.json") as { placeAgent: { input: unknown; receipt: unknown }; setResponsible: { receipt: unknown } };

/** The canonical tree once the responsible person's run R1 has ended: only then may they be replaced. */
const r1Ended = (value: ControlTreeDTO = canonical): ControlTreeDTO =>
  ({ ...value, runs: value.runs.map(run => run.id === "R1" ? { ...run, state: "succeeded" as const } : run) });

function sameModelMembers(count: number): ControlTreeDTO {
  const ids = ["P78736a37-test", "P0c0b3e72-test"].slice(0, count);
  return { ...canonical,
    placements: [...canonical.placements, ...ids.map((id, index) => ({ ...canonical.placements[2]!, id,
      agentId: `A-test-${index}`, active: true, endedAt: null }))],
    runs: [...canonical.runs, ...ids.map((id, index) => ({ ...canonical.runs[0]!, id: `R${index + 4}`,
      placementId: id, requestId: null, modelId: "gpt-6-sol", effort: "high" }))] };
}

test("responsible choice distinguishes identical members but leaves a lone member unchanged", () => {
  const openChoices = (value: ControlTreeDTO) => {
    openReader("T1", "task", value);
    act(() => openInput({ form: "responsible", taskId: "T1" }));
    return [...document.querySelectorAll<HTMLElement>("[data-responsible-section] label")].map(label => label.textContent ?? "");
  };
  const choices = openChoices(r1Ended(sameModelMembers(2)));
  expect(choices.filter(label => label.includes("gpt-6-sol(high)"))).toEqual(expect.arrayContaining([
    expect.stringContaining("#7873"), expect.stringContaining("#0c0b")]));
  expect(choices.filter(label => label.includes("gpt-6-sol(high)"))).toHaveLength(2);
  expect(choices.filter(label => label.includes("gpt-6-sol(high)"))).toEqual(expect.arrayContaining([
    expect.stringMatching(/^#7873 · /), expect.stringMatching(/^#0c0b · /)]));
  cleanup(); queryClient.clear(); useDialogStore.setState({ dialog: null });
  const single = openChoices(r1Ended(sameModelMembers(1)));
  expect(single.find(label => label.includes("gpt-6-sol(high)"))).not.toContain("#");
});

test("a person decides who is responsible: a new person replaces the current one, checked against what is shown", async () => {
  serve(() => json({}));
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url) === "/api/agent/assign" && init?.method === "POST"
    ? json({ task: headOf(canonical.tasks.find(task => task.id === "T1")!), agent: placementOps.placeAgent.receipt }) : problemResponse("not_found", "Unknown"));
  const pressResponsible = (data: ReturnType<typeof fixtureScreen>) => {
    const task = data.tasks.find(task => task.id === "T1")!;
    function ResponsibleKey() {
      return <button data-responsible-key onKeyDown={useTitleKeys(task)}>{task.title}</button>;
    }
    const key = render(<TestWorkspace data={data}><ResponsibleKey /></TestWorkspace>);
    fireEvent.keyDown(document.querySelector("[data-responsible-key]")!, { key: "a" });
    key.unmount();
  };
  openReader("T1");
  pressResponsible(fixtureScreen());
  expect(useDialogStore.getState().dialog).toBeNull();
  cleanup(); queryClient.clear(); useDialogStore.setState({ dialog: null });
  openReader("T1", "task", r1Ended());
  act(() => openInput({ form: "responsible", taskId: "T1" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Launch profile" }), { target: { value: "claude" } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]!.url).toBe("/api/agent/assign");
  expect(posted()[0]!.body).toEqual({ task: "T1", role: "responsible", profile: "claude", selected: "{}",
    expectedTaskHash: "a".repeat(64), replace: "P1", expectedPlacementRevision: 1 });
  expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, "responsible", "T1")]?.payload)
    // The intent keeps the command as it is sent.
    .toEqual(posted()[0]!.body);
});

/** The configured Pi profile omits effort for fixed models. The Grok profile requires effort. */
const effortProfiles: ControlTreeDTO["profiles"] = [
  launchProfile("pi", { model: ["model-with-effort", "fixed-first", "fixed-second"], effort: ["high", "low", "medium"] }, ["effort"],
    { "fixed-first": ["effort"], "fixed-second": ["effort"] }),
  launchProfile("grok", { model: ["grok-4.7"], effort: ["high", "low", "medium", "xhigh"] })];
const options = (name: string) => [...(screen.getByRole("combobox", { name }) as HTMLSelectElement).options].map(option => option.value);
const shown = (name: string) => (screen.getByRole("combobox", { name }) as HTMLSelectElement).value;

test.each([
  ["grok", [["Effort", "xhigh"]], { model: "grok-4.7", effort: "xhigh" }],
  ["pi", [["Effort", "low"]], { model: "model-with-effort", effort: "low" }],
  // Changing to a fixed model takes its effort away: nothing to show, nothing sent.
  ["pi", [["Effort", "low"], ["Model", "fixed-first"]], { model: "fixed-first" }],
  ["pi", [["Model", "fixed-first"], ["Model", "model-with-effort"]], { model: "model-with-effort", effort: "high" }],
] as const)("a new responsible person of %s is placed with the model and effort chosen for them (%j)", async (profile, changes, selected) => {
  serve(() => json({}));
  vi.mocked(fetch).mockImplementation(async (url, init) => String(url) === "/api/agent/assign" && init?.method === "POST"
    ? json({ task: headOf(canonical.tasks.find(task => task.id === "T1")!), agent: placementOps.placeAgent.receipt }) : problemResponse("not_found", "Unknown"));
  openReader("T1", "task", { ...r1Ended(), profiles: effortProfiles });
  act(() => openInput({ form: "responsible", taskId: "T1" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Launch profile" }), { target: { value: "grok" } });
  expect(options("Model")).toEqual(["grok-4.7"]);
  expect(options("Effort")).toEqual(["high", "low", "medium", "xhigh"]);
  expect(shown("Effort")).toBe("high");
  fireEvent.change(screen.getByRole("combobox", { name: "Launch profile" }), { target: { value: "pi" } });
  expect(options("Model")).toEqual(["model-with-effort", "fixed-first", "fixed-second"]);
  // No "none" is added: only the written values.
  expect(options("Effort")).toEqual(["high", "low", "medium"]);
  expect(shown("Effort")).toBe("high");
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "fixed-second" } });
  expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "model-with-effort" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Launch profile" }), { target: { value: profile } });
  for (const [name, value] of changes) fireEvent.change(screen.getByRole("combobox", { name }), { target: { value } });
  expect(screen.queryByRole("combobox", { name: "Effort" }) === null).toBe(!("effort" in selected));
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]!.url).toBe("/api/agent/assign");
  expect(posted()[0]!.body).toEqual({ task: "T1", role: "responsible", profile, selected: JSON.stringify(selected),
    expectedTaskHash: "a".repeat(64), replace: "P1", expectedPlacementRevision: 1 });
});

test('undoing a responsible decision restores its chosen model and effort when the closed form reopens', async () => {
  window.__ALPACAWORK_WRITE_GRACE_MS__ = 5000;
  serve(() => json({}));
  openReader('T1', 'task', { ...r1Ended(), profiles: effortProfiles });
  act(() => openInput({ form: 'responsible', taskId: 'T1' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Launch profile' }), { target: { value: 'grok' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'xhigh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change' }));
  await waitFor(() => expect(useDialogStore.getState().dialog).toBeNull());
  await act(async () => { expect(await useUndoOffers.getState().offers[0]!.undo()).toBe('cancelled'); });
  act(() => openInput({ form: 'responsible', taskId: 'T1' }));
  expect(shown('Launch profile')).toBe('grok');
  expect(shown('Model')).toBe('grok-4.7');
  expect(shown('Effort')).toBe('xhigh');
  expect(posted()).toHaveLength(0);
});

test("a refused responsible decision reads the latest versions, keeps the profile, and only then sends again", async () => {
  const latestTree = { ...canonical,
    tasks: canonical.tasks.map(task => task.id === "T1" ? { ...task, hash: "c".repeat(64) } : task),
    placements: canonical.placements.map(person => person.id === "P1" ? { ...person, revision: 2 } : person) };
  let writes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "/api/workspace/live") return json(indexOf(latestTree, 2));
    if (String(url) === "/api/agent/assign" && init?.method === "POST")
      return ++writes === 1 ? problemResponse("conflict", "Changed")
        : json({ task: headOf(latestTree.tasks[0]!), agent: placementOps.placeAgent.receipt });
    return problemResponse("not_found", "Unknown");
  });
  const data = fixtureScreen();
  render(<TestWorkspace data={data}><ResponsibleSection task={data.tasks.find(task => task.id === "T1")!} /></TestWorkspace>);
  act(() => openInput({ form: "responsible", taskId: "T1" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Launch profile" }), { target: { value: "claude" } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await reopenDecision("responsible","T1");
  await waitFor(() => expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByRole("combobox", { name: "Launch profile" }) as HTMLSelectElement).value).toBe("claude");
  fireEvent.click(screen.getByRole("button", { name: "Read the latest" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Change" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("combobox", { name: "Launch profile" }) as HTMLSelectElement).value).toBe("claude");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[0]!.body.expectedTaskHash).toBe("a".repeat(64));
  expect(posted()[1]!.body).toMatchObject({ expectedTaskHash: "c".repeat(64), expectedPlacementRevision: 2, profile: "claude" });
});

test("an uncertain responsible decision checks the current placement before another send", async () => {
  const latest = { ...canonical,
    tasks: canonical.tasks.map(row => row.id === "T1" ? { ...row, hash: "c".repeat(64) } : row),
    placements: canonical.placements.map(person => person.id === "P1" ? { ...person, id: "P-new", profileKey: "claude" } : person) };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url) === "/api/agent/assign"
    ? problemResponse("save_unconfirmed") : String(url) === "/api/workspace/live"
      ? json(indexOf(latest, 2)) : problemResponse("not_found"));
  const data = fixtureScreen();
  render(<TestWorkspace data={data}><ResponsibleSection task={data.tasks.find(row => row.id === "T1")!} /></TestWorkspace>);
  act(() => openInput({ form: "responsible", taskId: "T1" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Launch profile" }), { target: { value: "claude" } });
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, "responsible", "T1")]?.status).toBe("unconfirmed"));
  await reopenDecision("responsible","T1");
  fireEvent.click(screen.getByRole("button", { name: "Read the latest" }));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, "responsible", "T1")]).toBeUndefined());
  expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/agent/assign")).toHaveLength(1);
});

test("a responsible decision closes with a reason when the latest task is no longer active", async () => {
  const archived = { ...canonical,
    tasks: canonical.tasks.map(task => task.id === "T1" ? { ...task, lifecycle: "archived" as const } : task) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "/api/agent/assign" && init?.method === "POST") return problemResponse("conflict", "Changed");
    if (String(url) === "/api/workspace/live") return json(indexOf(archived, 2));
    return problemResponse("not_found", "Unknown");
  });
  const data = fixtureScreen();
  render(<TestWorkspace data={data}><ResponsibleSection task={data.tasks.find(task => task.id === "T1")!} /></TestWorkspace>);
  act(() => openInput({ form: "responsible", taskId: "T1" }));
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  await reopenDecision("responsible","T1");
  await screen.findByRole("button", { name: "Read the latest" });
  fireEvent.click(screen.getByRole("button", { name: "Read the latest" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Change" })).toBeNull());
  expect(vi.mocked(notify.error)).toHaveBeenCalledWith("This task is no longer available. This form was closed.");
});

test("a refused Run close offers a fresh read, then closes with a reason when the Run already ended", async () => {
  const ended = { ...canonical, runs: canonical.runs.map(run => run.id === "R1"
    ? { ...run, state: "succeeded" as const, endedAt: "2026-09-29T00:09:00.000Z" } : run) };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "/api/run/stop" && init?.method === "POST") return problemResponse("conflict", "Changed");
    if (String(url) === "/api/workspace/live") return json(indexOf(ended, 2));
    return problemResponse("not_found", "Unknown");
  });
  render(<TestWorkspace data={screenData(tree({ ...canonical, runs: canonical.runs.map(run => run.id === "R1" ? { ...run, state: "needs_review" as const } : run) }))}><DialogHost /></TestWorkspace>);
  act(() => useDialogStore.getState().openRun({ runId: "R1" }));
  fireEvent.click(screen.getByRole("button", { name: "Close run" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Close run" }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Read the latest" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Not a failure (nothing was refused): the Run ended meanwhile, said as information.
  expect(vi.mocked(notify.info)).toHaveBeenCalledWith("This run can no longer be closed. This form was closed.");
  expect(vi.mocked(notify.error)).not.toHaveBeenCalled();
  expect(posted()).toHaveLength(1);
});

test("a refused Run close can be sent again only after the latest Run is read", async () => {
  let writes = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url) === "/api/run/stop" && init?.method === "POST")
      return ++writes === 1 ? problemResponse("conflict", "Changed")
        : json({ cancelled: [], stop_requested: ["R1"] });
    if (String(url) === "/api/workspace/live") return json(indexOf(tree({ ...canonical, runs: canonical.runs.map(run => run.id === "R1" ? { ...run, state: "needs_review" as const } : run) }), 2));
    return problemResponse("not_found", "Unknown");
  });
  render(<TestWorkspace data={screenData(tree({ ...canonical, runs: canonical.runs.map(run => run.id === "R1" ? { ...run, state: "needs_review" as const } : run) }))}><DialogHost /></TestWorkspace>);
  act(() => useDialogStore.getState().openRun({ runId: "R1" }));
  fireEvent.click(screen.getByRole("button", { name: "Close run" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Close run" }) as HTMLButtonElement).disabled).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Read the latest" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Close run" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Close run" }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted().map(each => each.body)).toEqual([{ run: "R1" }, { run: "R1" }]);
  expect(posted().map(each => each.url)).toEqual(["/api/run/stop", "/api/run/stop"]);
});

test("a current member can take over as responsible", async () => {
  const member = { ...canonical.placements[2]!, id: "P4", active: true, endedAt: null, revision: 2 };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url) === "/api/agent/handover"
    ? json({ task: headOf(canonical.tasks.find(task => task.id === "T1")!), agent: placementOps.setResponsible.receipt }) : json({ run: "R1", files: [] }));
  openReader("T1", "task", r1Ended({ ...canonical, placements: [...canonical.placements, member] }));

  act(() => openInput({ form: "responsible", taskId: "T1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]!.body).toEqual({ task: "T1", agent: "P4", expectedTaskHash: "a".repeat(64), expectedPlacementRevision: 2 });
});

test("a task moves within its project: under its project Task, or any task but itself or one below it; no top is above the project", () => {
  const data = fixtureScreen();
  const index = indexTasks(data.tasks);
  expect(parentChoices(index.byId.get("T1")!, index)).toEqual([{ id: PROJECT_TASK, label: "default" }]);
  expect(parentChoices(index.byId.get("T12")!, index).map((choice) => choice.id)).toEqual([PROJECT_TASK, "T1"]);
});

test("an unfinished task is not offered a finished parent; a finished one is", () => {
  const index = indexTasks(screenData(tree({ tasks: [dto({ id: "T1", state: "doing" }), dto({ id: "T2", title: "Finished parent", state: "done" }),
    dto({ id: "T21", title: "Finished child", parentId: "T2", state: "done" }), dto({ id: "T3", state: "todo" }), dto({ id: "T4", state: "stopped" })] })).tasks);
  expect(parentChoices(index.byId.get("T3")!, index).map((choice) => choice.id)).toEqual([PROJECT_TASK, "T1"]);
  const finishedChoices = parentChoices(index.byId.get("T4")!, index);
  expect(finishedChoices.map((choice) => choice.id)).toEqual([PROJECT_TASK, "T1", "T2", "T21", "T3"]);
  expect(finishedChoices.find(choice => choice.id === "T21")?.label).toBe("Finished parent › Finished child");
});

test("a person moves a task under its project Task, checked against the hash on screen", async () => {
  const moved = { task: { ...canonical.tasks[1]!, parentId: PROJECT_TASK, version: canonical.tasks[1]!.version + 1, hash: 'c'.repeat(64) } };
  const latest = tree({ ...canonical, tasks: canonical.tasks.map(task => task.id === moved.task.id ? moved.task : task) });
  let releaseView!: (response: Response) => void;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url) === "/api/task/move" ? json({ task: headOf(moved.task) })
    : String(url).startsWith('/api/task/view') ? new Promise(resolve => { releaseView = resolve; }) : json({ run: "R2", files: [] }));
  queryClient.setQueryData(indexKey, indexOf(canonical));
  openReader("T12", "task");
  act(() => openInput({ form: "move", taskId: "T12" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "New parent" }), { target: { value: PROJECT_TASK } });
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  expect(posted()[0]).toEqual({ url: "/api/task/move", body: { task: "T12", parent: PROJECT_TASK, expectedTaskHash: "b".repeat(64) } });
  expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, "move", "T12")]?.payload)
    .toEqual(posted()[0]!.body);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, 'move', 'T12')]?.status).toBe('confirmed'));
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)?.tasks.find(task => task.id === 'T12')?.parentId).toBe('T1');
  expect(readerPresentation(queryClient, canonical.root, 'T12')).toMatchObject({ kind: 'written', document: { parentId: PROJECT_TASK } });
  expect(serverReadFacts(queryClient)?.tasks.find(task => task.id === 'T12')).toBeUndefined();
  await waitFor(() => expect(releaseView).toBeTypeOf('function'));
  await act(async () => releaseView(json(serverView(latest, 'T12'))));
  await waitFor(() => expect(readerPresentation(queryClient, canonical.root, 'T12')).toMatchObject({ kind: 'view', view: { task: { parentId: PROJECT_TASK } } }));
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)?.tasks.find(task => task.id === 'T12')?.parentId).toBe('T1');
  await act(async () => { receivePatch(queryClient, serverPatch(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!, indexOf(latest).tasks)); });
  await waitFor(() => expect(serverReadFacts(queryClient)?.tasks.find(task => task.id === 'T12')?.parentId).toBe(PROJECT_TASK));
  expect(posted()).toHaveLength(1);
});

test("an uncertain move checks the server parent before another send", async () => {
  const latest = { ...canonical, tasks: canonical.tasks.map(row => row.id === "T12"
    ? { ...row, parentId: PROJECT_TASK, hash: "c".repeat(64) } : row) };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async url => String(url) === "/api/task/move"
    ? problemResponse("save_unconfirmed") : String(url) === "/api/workspace/live"
      ? json(indexOf(latest, 2)) : problemResponse("not_found"));
  queryClient.setQueryData(indexKey, indexOf(canonical));
  openReader("T12", "task");
  act(() => openInput({ form: "move", taskId: "T12" }));
  fireEvent.change(await screen.findByRole("combobox", { name: "New parent" }), { target: { value: PROJECT_TASK } });
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, "move", "T12")]?.status).toBe("unconfirmed"));
  await reopenDecision("move","T12");
  fireEvent.click(screen.getByRole("button", { name: "Use the latest version and choose again" }));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey(canonical.root, "move", "T12")]).toBeUndefined());
  expect(screen.getByRole("combobox", { name: "New parent" })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => String(url) === "/api/task/move")).toHaveLength(1);
});

test("a parent change made elsewhere is shown, a move against it is refused, the choice is kept and only an explicit re-base sends again", async () => {
  const conflict = { error: { code: "conflict", message: "Task changed; reload before retrying", retry: "reread", detail: { currentTaskHash: "c".repeat(64), currentPlacementRevision: null, currentHeadRunId: null, preserveDraft: true } } };
  let answer = () => json(conflict, 409);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => String(url) === "/api/task/move" ? answer() : json({ run: "R2", files: [] }));
  useViewStore.setState({ selected: "T12", reader: { open: true, pane: "task", returnTo: null } });
  const opened = fixtureScreen();
  const view = render(<TestWorkspace data={opened}><Reader mode="docked" /></TestWorkspace>);
  act(() => openInput({ form: "move", taskId: "T12" }));
  let select = await screen.findByRole("combobox", { name: "New parent" }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: PROJECT_TASK } });
  // Another writer moves T12 elsewhere: the tree now has a new hash and parent for it.
  const T3 = { ...canonical.tasks[0]!, id: "T3", title: "Other parent", hash: "d".repeat(64), log: canonical.tasks[0]!.log };
  const movedTree = { ...canonical, tasks: [...canonical.tasks.map((task) => task.id === "T12" ? { ...task, parentId: "T3", hash: "c".repeat(64) } : task), T3] };
  view.rerender(<TestWorkspace data={fixtureScreen(movedTree)}><Reader mode="docked" /></TestWorkspace>);
  expect(screen.getByText(/The parent changed elsewhere after this form opened \(then: Parent, now: Other parent\)/)).toBeTruthy();
  expect(select.value).toBe(PROJECT_TASK);
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(posted()).toHaveLength(1));
  // The move carries the version the form was opened on, so the server refuses it instead of overwriting.
  expect(posted()[0]!.body).toEqual({ task: "T12", parent: PROJECT_TASK, expectedTaskHash: "b".repeat(64) });
  await reopenDecision("move","T12");
  select = screen.getByRole("combobox", { name: "New parent" }) as HTMLSelectElement;
  expect(await screen.findByText(/Not moved: the task changed elsewhere/)).toBeTruthy();
  expect(select.value).toBe(PROJECT_TASK);
  expect((screen.getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(true);
  // The person adopts the latest version and sends the kept choice again.
  answer = () => json({ task: headOf({ ...movedTree.tasks.find((task) => task.id === "T12")!, parentId: PROJECT_TASK }) });
  fireEvent.click(screen.getByRole("button", { name: "Use the latest version and choose again" }));
  fireEvent.click(screen.getByRole("button", { name: "Move" }));
  await waitFor(() => expect(posted()).toHaveLength(2));
  expect(posted()[1]!.body).toEqual({ task: "T12", parent: PROJECT_TASK, expectedTaskHash: "c".repeat(64) });
});

test.each(['move','responsible'] as const)('a successful previous %s is a new opening using the current hash and defaults', async form => {
  const taskId = form==='move'?'T12':'T1', old = canonical.tasks.find(task=>task.id===taskId)!;
  const current = {...old,hash:'c'.repeat(64),version:old.version+1};
  const data = fixtureScreen({...canonical,tasks:canonical.tasks.map(task=>task.id===taskId?current:task)});
  data.seed();
  useWriteIntentStore.setState(state => ({ entries: { ...state.entries, [intentKey(canonical.root,form,taskId)]: {status:'confirmed',operationId:crypto.randomUUID(),transport:'receipt',
    payload:{task:taskId,expectedTaskHash:old.hash},draft:(form==='move'?{parent:PROJECT_TASK,openedParent:PROJECT_TASK}:{profile:'claude',agent:'new'}) as Record<string,string>,attempt:'previous',at:new Date().toISOString()} } }));
  const fetcher = vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Promise<Response>(()=>{}));
  openReader(taskId,'task',{...canonical,tasks:canonical.tasks.map(task=>task.id===taskId?current:task)});
  act(()=>openInput({form,taskId}));
  if(form==='move') {
    const select = screen.getByRole('combobox',{name:'New parent'}) as HTMLSelectElement;
    expect(select.value).toBe(current.parentId);
    fireEvent.change(select,{target:{value:PROJECT_TASK}});
  }
  fireEvent.click(screen.getByRole('button',{name:form==='move'?'Move':'Change'}));
  await waitFor(()=>expect(fetcher).toHaveBeenCalledOnce());
  expect(posted()[0]!.body.expectedTaskHash).toBe(current.hash);
});
