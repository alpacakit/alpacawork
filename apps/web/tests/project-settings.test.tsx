import { problemResponse } from './problem';
import { queryClient } from '../src/data/query-client';
import { receiveFullIndex } from '../src/data/resources';
import { test, expect, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { adapterCatalog, DEFAULT_LIMITS, DEFAULT_SCHEMA, PROJECT_SCHEMA } from "@alpacawork/contract";
import type { ControlTaskDTO } from "@alpacawork/contract/control";
import { ProjectDialog } from "../src/features/panels/ProjectDialog";
import { DialogHost } from "../src/features/shell/DialogHost";
import { ProjectMenu } from "../src/features/chrome/ProjectMenu";
import { Toaster } from "../src/components/ui/toaster";
import { intentKey, useWriteIntentStore } from "../src/data/write-intent";
import { useDialogStore } from "../src/state/dialog-store";
import { useViewStore } from "../src/state/view-store";
import { TestWorkspace, dto, fieldList, headOf, indexOf, project, screenData, tree, viewsOf, PROJECT_TASK } from "./fixtures";
import { setupForms, refusal, answer, written } from "./forms-fixture";

setupForms();

/**
 * A project's settings: the project dialog edits its Task's title, colour and values, saved with one task
 * update, and its code location on this PC, saved after it only when it changed. The settings dialog keeps this PC's
 * config.yaml and nothing of a project.
 */
const OPEN = "c".repeat(64), LATEST = "d".repeat(64), SAVED_1 = "1".repeat(64);
const COLOR = "#39659b";

/** The fixture's project Task with this goal (its body) at this hash. */
const goal = (body: string, hash: string, more: Partial<ControlTaskDTO> = {}): ControlTaskDTO => project({ body, hash, ...more });
/** The project's view as the server gives it: its own values (summary, policy), whatever its Tasks use. */
const goalView = (body: string, hash: string, more: Partial<ControlTaskDTO> = {}) => {
  const view = viewsOf(tree({ tasks: [dto(), goal(body, hash, more)] })).find((each) => each.task.id === PROJECT_TASK)!;
  return { ...view, values: { ...view.values, fields: [...PROJECT_SCHEMA], from: null } };
};
/** field get at the project: the fields its Tasks use. */
const tasksSchema = () => ({ task: PROJECT_TASK, from: null, fields: [...DEFAULT_SCHEMA], version: "v".repeat(64), schema: {} });
const serverSettings = (hash = OPEN) => ({ hash, agentsText: "agents: {}\n", agents: {}, catalog: adapterCatalog(), limits: { ...DEFAULT_LIMITS } });

const updateCalls = (fetcher: ReturnType<typeof vi.spyOn>) =>
  fetcher.mock.calls.filter(([url]: unknown[]) => String(url).includes("/api/commands/task/update"));
const updateBody = (fetcher: ReturnType<typeof vi.spyOn>, index = 0) => JSON.parse(String((updateCalls(fetcher)[index]?.[1] as RequestInit).body));
const configCalls = (fetcher: ReturnType<typeof vi.spyOn>) =>
  fetcher.mock.calls.filter(([url]: unknown[]) => String(url).includes("/api/commands/config/set"));

/** The dialog's save bar, at the end of its content. */
const save = () => within(document.querySelector<HTMLElement>("[data-project-save]")!).getByRole("button", { name: "Save" }) as HTMLButtonElement;
const body = () => document.getElementById("project-policy") as HTMLTextAreaElement;

function serve(updates: (Response | (() => Response))[], view = () => goalView("# Goal\n", OPEN)) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    if (String(url).includes("/api/commands/config/get")) return answer(serverSettings());
    if (String(url).includes("/api/commands/field/list")) return answer(fieldList());
    if (String(url).includes("/api/commands/field/get")) return answer(tasksSchema());
    if (String(url).includes("/api/task/view")) return answer(view());
    if (String(url).includes("/api/commands/task/update")) {
      const next = updates.length > 1 ? updates.shift()! : updates[0]!;
      return (typeof next === "function" ? next() : next).clone();
    }
    return refusal(404);
  });
}

const openProject = async () => {
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), goal("# Goal\n", OPEN)] }))}><ProjectDialog project={PROJECT_TASK} /><Toaster /></TestWorkspace>);
  await waitFor(() => expect(body()?.value).toBe("# Goal"));
};

test("the dialog's heading is the project's tile, name and ID; its fields go name, summary, colour, parent, code location, goal, extracts, then the save bar", async () => {
  serve([written(goal("# Goal\n", SAVED_1))]);
  await openProject();
  const heading = document.querySelector("[data-project-heading]")!;
  expect(heading.querySelector("[data-project-tile]")).toBeTruthy();
  // The project is read and shown by its public P-number, never by a T-number.
  expect(heading.textContent).toContain(PROJECT_TASK);
  expect(heading.textContent).not.toContain(PROJECT_TASK.replace(/^P/, "T"));
  expect(heading.querySelector("[data-copy]")!.getAttribute("aria-label")).toContain(PROJECT_TASK);
  const order = ["project-name", "project-summary", "project-color", "project-parent-shown", "project-location", "project-policy"]
    .map((id) => document.getElementById(id)!);
  for (let at = 1; at < order.length; at++)
    expect(order[at - 1]!.compareDocumentPosition(order[at]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(body().compareDocumentPosition(document.querySelector("[data-project-save]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.querySelector('#project-color [data-swatch="navy"]')!.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Color").id).toBe("project-color");
  // The fields listed are those the project's Tasks use; the project's own policy is not one of them.
  expect([...document.querySelectorAll<HTMLElement>("[data-schema-field]")].map((row) => row.dataset.schemaField)).toEqual([...DEFAULT_SCHEMA]);
});

test("name, colour, goal and extracts are saved with one task update; config.yaml is not written", async () => {
  const fetcher = serve([written(goal("# My goal\n", SAVED_1, { title: "Launch Room" }))]);
  await openProject();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Launch Room  " } });
  fireEvent.click(document.querySelector('#project-color [data-swatch="teal"]')!);
  fireEvent.change(body(), { target: { value: "# My goal\n" } });
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(1));
  expect(updateBody(fetcher)).toEqual({ task: PROJECT_TASK, title: "Launch Room", color: "#31c8c9", values: { project_policy: "# My goal\n" }, expectedTaskHash: OPEN });
  expect(configCalls(fetcher)).toHaveLength(0);
  await screen.findByText("Saved");
});

test("the summary is saved as a value of its own, cleared when emptied, and one too long is refused before it is sent", async () => {
  const summary = { values: { project_summary: "Monthly closing" } }, summarised = goal("# Goal\n", SAVED_1, summary);
  let saved = false;
  const fetcher = serve([() => { saved = true; return written(summarised); }, written(goal("# Goal\n", LATEST))],
    () => saved ? goalView("# Goal\n", SAVED_1, summary) : goalView("# Goal\n", OPEN));
  await openProject();
  const field = document.getElementById("project-summary") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: "x".repeat(131) } });
  fireEvent.click(save());
  await waitFor(() => expect(field.getAttribute("aria-invalid")).toBe("true"));
  expect(updateCalls(fetcher)).toHaveLength(0);
  fireEvent.change(field, { target: { value: "Monthly closing" } });
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(1));
  expect(updateBody(fetcher)).toEqual({ task: PROJECT_TASK, values: { project_summary: "Monthly closing" }, expectedTaskHash: OPEN });
  await screen.findByText("Saved");
  // The feed brings the saved Task; the next save is read against it.
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), summarised] })), rev: 2 });
  await queryClient.refetchQueries();
  fireEvent.change(field, { target: { value: " " } });
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(2));
  expect(updateBody(fetcher, 1)).toEqual({ task: PROJECT_TASK, values: { project_summary: null }, expectedTaskHash: SAVED_1 });
});

test("a blank name cannot be saved", async () => {
  const fetcher = serve([written(goal("# Goal\n", SAVED_1))]);
  await openProject();
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  fireEvent.change(name, { target: { value: " " } });
  fireEvent.click(save());
  await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
  expect(updateCalls(fetcher)).toHaveLength(0);
});

test("a changed code location is saved before the Task's fields, both against the hash they were read with", async () => {
  // A location alone writes config.yaml only: the Task answers at the hash it had.
  const fetcher = serve([written(goal("# Goal\n", OPEN)), written(goal("# Goal\n", SAVED_1, { title: "Renamed" }))]);
  await openProject();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  const location = document.getElementById("project-location") as HTMLInputElement;
  fireEvent.change(location, { target: { value: "/work/app" } });
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(2));
  expect(updateBody(fetcher, 0)).toEqual({ task: PROJECT_TASK, cwd: "/work/app", expectedTaskHash: OPEN });
  expect(updateBody(fetcher, 1)).toEqual({ task: PROJECT_TASK, title: "Renamed", expectedTaskHash: OPEN });
});

test("a refused code location says so on its own field while the Task's fields are saved", async () => {
  let saved = false;
  const fetcher = serve([refusal(400), () => { saved = true; return written(goal("# Goal\n", SAVED_1, { title: "Renamed" })); }],
    () => saved ? goalView("# Goal\n", SAVED_1)! : goalView("# Goal\n", OPEN)!);
  await openProject();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  fireEvent.change(document.getElementById("project-location")!, { target: { value: "/work/app" } });
  fireEvent.click(save());
  await screen.findByText("The working folder was not saved. The other fields were.");
  expect(updateCalls(fetcher)).toHaveLength(2);
  expect(updateBody(fetcher, 1)).toEqual({ task: PROJECT_TASK, title: "Renamed", expectedTaskHash: OPEN });
  // Only the location is still unsaved: the next save sends it alone, against the hash the Task's write answered.
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), goal("# Goal\n", SAVED_1, { title: "Renamed" })] })), rev: 2 });
  await queryClient.refetchQueries();
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(3));
  expect(updateBody(fetcher, 2)).toEqual({ task: PROJECT_TASK, cwd: "/work/app", expectedTaskHash: SAVED_1 });
});

test("a goal changed elsewhere keeps the draft; Load the latest reads the project again", async () => {
  let latest = false;
  const fetcher = serve([refusal(409)], () => latest ? goalView("# Other\n", LATEST)! : goalView("# Goal\n", OPEN)!);
  await openProject();
  fireEvent.change(body(), { target: { value: "# My goal\n" } });
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(1));
  expect(body().value).toBe("# My goal\n");
  latest = true;
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), goal("# Other\n", LATEST)] })), rev: 2 });
  fireEvent.click(await screen.findByRole("button", { name: "Load the latest" }));
  await waitFor(() => expect(body().value).toBe("# Other"));
});

test("fields reordered elsewhere refuse the save; Load the latest shows the new order, not the one read before", async () => {
  let latest = false;
  const theirs = ["goal", "conclusion", "policy", "user_instructions", "remaining", "left_running", "conditions", "artifact", "pr", "decide", "notes"];
  const fetcher = serve([written(goal("# Goal\n", SAVED_1))], () => latest ? goalView("# Goal\n", LATEST) : goalView("# Goal\n", OPEN));
  fetcher.mockImplementation(async (url: unknown) => {
    if (String(url).includes("/api/commands/field/list")) return answer(fieldList());
    if (String(url).includes("/api/commands/field/get")) return answer(latest ? { ...tasksSchema(), from: PROJECT_TASK, fields: theirs } : tasksSchema());
    // Someone set the project's fields after the dialog read them: the hash it sends is old.
    if (String(url).includes("/api/commands/field/use")) return refusal(409);
    if (String(url).includes("/api/task/view")) return answer(latest ? goalView("# Goal\n", LATEST) : goalView("# Goal\n", OPEN));
    return refusal(404);
  });
  await openProject();
  const order = () => [...document.querySelectorAll<HTMLElement>("[data-schema-field]")].map(row => row.dataset.schemaField);
  expect(order()).toEqual([...DEFAULT_SCHEMA]);
  fireEvent.click(within(document.querySelector<HTMLElement>('[data-schema-field="forbidden"]')!).getByRole("button", { name: "Remove" }));
  fireEvent.click(save());
  await waitFor(() => expect(fetcher.mock.calls.some(([url]: unknown[]) => String(url).includes("/api/commands/field/use"))).toBe(true));
  latest = true;
  fireEvent.click(await screen.findByRole("button", { name: "Load the latest" }));
  await waitFor(() => expect(order()).toEqual(theirs));
});

test("an unconfirmed save is checked by sending the same operation again", async () => {
  const fetcher = serve([refusal(503), written(goal("# My goal\n", SAVED_1))]);
  await openProject();
  fireEvent.change(body(), { target: { value: "# My goal\n" } });
  fireEvent.click(save());
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey("/fixture", "project-settings", PROJECT_TASK)]?.status).toBe("unconfirmed"));
  fireEvent.click(screen.getAllByRole("button", { name: "Load the latest" })[0]!);
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(2));
  const posts = updateCalls(fetcher);
  expect((posts[0]![1] as RequestInit).body).toBe((posts[1]![1] as RequestInit).body);
  expect(new Headers((posts[0]![1] as RequestInit).headers).get("X-Alpacawork-Op-Id"))
    .toBe(new Headers((posts[1]![1] as RequestInit).headers).get("X-Alpacawork-Op-Id"));
});

test("fields are moved and taken out in place, a system field cannot be, and their order is saved before the values", async () => {
  const fetcher = serve([written(goal("# Goal\n", SAVED_1))]);
  fetcher.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/api/commands/field/list")) return answer(fieldList());
    if (String(url).includes("/api/commands/field/get")) return answer(tasksSchema());
    if (String(url).includes("/api/commands/field/use")) return answer({ task: headOf(project({ hash: LATEST })) });
    if (String(url).includes("/api/task/view")) return answer(goalView("# Goal\n", OPEN));
    if (String(url).includes("/api/commands/task/update")) return written(goal("# Better\n", SAVED_1));
    return refusal(404);
  });
  await openProject();
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-schema-field="${id}"]`)!;
  expect(within(row("notes")).getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(within(row("goal")).getByRole("button", { name: "Down" }));
  fireEvent.click(within(row("forbidden")).getByRole("button", { name: "Remove" }));
  fireEvent.change(body(), { target: { value: "# Better" } });
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(1));
  const writes = fetcher.mock.calls.map(([url]: unknown[]) => String(url)).filter((url: string) => /field\/use|task\/update/.test(url));
  expect(writes.map((url: string) => url.replace(/^.*\/api\//, ""))).toEqual(["commands/field/use", "commands/task/update"]);
  const sent = JSON.parse(String((fetcher.mock.calls.find(([url]: unknown[]) => String(url).includes("/api/commands/field/use"))![1] as RequestInit).body));
  expect(sent).toEqual({ task: PROJECT_TASK, fields: ["policy", "goal", "user_instructions", "conclusion", "remaining", "left_running",
    "conditions", "artifact", "pr", "decide", "notes"], expectedTaskHash: OPEN });
  // The values are written against the hash the schema write answered.
  expect(updateBody(fetcher)).toEqual({ task: PROJECT_TASK, values: { project_policy: "# Better" }, expectedTaskHash: LATEST });
  // A new field's kind is one text or a list of them: a field group is not offered.
  fireEvent.click(screen.getByRole("button", { name: "Add a field" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Choose a field to add" }), { target: { value: "__new" } });
  const kinds = [...document.querySelector<HTMLSelectElement>("#field-def-new-kind")!.options].map(option => option.value);
  expect(kinds).toEqual(["text", "list"]);
  // One size is set; the words agents read and the most a write holds follow it as it changes.
  const size = () => document.querySelector("[data-field-size]")!.textContent;
  expect(size()).toContain("About 100 characters."); expect(size()).toContain("130 characters");
  fireEvent.change(document.querySelector("#field-def-new-chars")!, { target: { value: "60" } });
  expect(size()).toContain("“About 60 characters.”"); expect(size()).toContain("78 characters");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  // A shipped field reads in the screen's language (agents read the shipped English); only whether it is required changes.
  expect(row("goal").querySelector("button")!.textContent).toContain("Goal");
  fireEvent.click(within(row("goal")).getByRole("button", { expanded: false }));
  const editor = document.querySelector<HTMLElement>('[data-field-def="goal"]')!;
  expect(editor.textContent).toContain("This field comes with the app, so only whether it is required can be changed.");
  expect(document.querySelector<HTMLInputElement>("#field-def-goal-title")!.value).toBe("Goal");
  for (const input of editor.querySelectorAll<HTMLInputElement>("input, select, textarea")) expect(input.disabled, input.id).toBe(true);
  const required = document.querySelector<HTMLButtonElement>("#field-def-goal-required")!;
  expect(required.disabled).toBe(false);
  fireEvent.click(required);
  fireEvent.click(screen.getByRole("button", { name: "Save for every project" }));
  const fieldSet = await waitFor(() => { const call = fetcher.mock.calls.find(([url]: unknown[]) => String(url).includes("/api/commands/field/set")); expect(call).toBeTruthy(); return call!; });
  expect(JSON.parse(String((fieldSet[1] as RequestInit).body))).toMatchObject({ field: "goal", required: true });
  expect(JSON.parse(String((fieldSet[1] as RequestInit).body))).not.toHaveProperty("title");
});

test("settings have six tabs, AI holds nothing of a project, and the gear reopens the tab it was last on", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) =>
    String(url).includes("/api/commands/config/get") ? answer(serverSettings()) : refusal(404));
  render(<TestWorkspace data={screenData(tree())}><DialogHost /></TestWorkspace>);
  act(() => useDialogStore.getState().open("settings", { tab: "ai" }));
  const tabs = await screen.findAllByRole("tab");
  expect(tabs.map((tab) => tab.textContent)).toEqual(["AI", "Notifications", "Projects", "General", "App & phone", "Resources"]);
  await waitFor(() => expect(document.getElementById("server-limits")).toBeTruthy());
  expect(screen.queryByLabelText("Name")).toBeNull();
  expect(document.getElementById("project-policy")).toBeNull();
  act(() => useDialogStore.getState().close());
  act(() => useDialogStore.getState().open("settings"));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "ai" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "App & phone" }), { button: 0, ctrlKey: false });
  act(() => useDialogStore.getState().close());
  act(() => useDialogStore.getState().open("settings"));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "apps" });
});

test("a project opened from Settings' Projects goes back to that list with Back; × closes both; opened on its own it has no Back", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => refusal(404));
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), goal("# Goal\n", OPEN)] }))}><DialogHost /></TestWorkspace>);
  act(() => useDialogStore.getState().open("settings", { tab: "projects" }));
  fireEvent.click(await screen.findByRole("button", { name: /default/ }));
  await waitFor(() => expect(useDialogStore.getState().dialog).toEqual({ kind: "project", project: PROJECT_TASK }));
  fireEvent.click(await screen.findByRole("button", { name: "Back" }));
  expect(useDialogStore.getState().dialog).toMatchObject({ kind: "settings", tab: "projects" });
  expect(await screen.findByRole("tab", { name: "Projects", selected: true })).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: /default/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  act(() => useDialogStore.getState().openProject(PROJECT_TASK));
  await screen.findByRole("button", { name: "Close" });
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
});

test("the name menu opens the settings of the project in view, or Project settings while every project is", async () => {
  const value = tree({ tasks: [dto(), goal("# Goal\n", OPEN), project({ id: "P200", title: "Mobile rewrite", hash: OPEN })] });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => refusal(404));
  act(() => useViewStore.getState().setProject(PROJECT_TASK));
  const view = render(<TestWorkspace data={screenData(value)}><ProjectMenu /></TestWorkspace>);
  fireEvent.click(document.querySelector("[data-project-trigger]")!);
  fireEvent.click(await screen.findByRole("menuitem", { name: "default settings…" }));
  await waitFor(() => expect(useDialogStore.getState().dialog).toEqual({ kind: "project", project: PROJECT_TASK }));
  view.unmount();
  act(() => { useDialogStore.getState().close(); useViewStore.getState().setProject(null); });
  render(<TestWorkspace data={screenData(value)}><ProjectMenu /></TestWorkspace>);
  fireEvent.click(document.querySelector("[data-project-trigger]")!);
  fireEvent.click(await screen.findByRole("menuitem", { name: "Project settings…" }));
  await waitFor(() => expect(useDialogStore.getState().dialog).toEqual({ kind: "project", project: null }));
});

test("confirming a location save whose answer was lost keeps the Task's fields that were not sent", async () => {
  const fetcher = serve([refusal(503), written(goal("# Goal\n", OPEN))]);
  await openProject();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
  fireEvent.change(document.getElementById("project-location")!, { target: { value: "/work/app" } });
  fireEvent.click(save());
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey("/fixture", "project-location", PROJECT_TASK)]?.status).toBe("unconfirmed"));
  // The Task's fields wait while the location is unknown: nothing of them was sent.
  expect(updateCalls(fetcher)).toHaveLength(1);
  expect(updateBody(fetcher)).not.toHaveProperty("title");
  fireEvent.click(screen.getAllByRole("button", { name: "Load the latest" })[0]!);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[intentKey("/fixture", "project-location", PROJECT_TASK)]).toBeUndefined());
  expect(updateCalls(fetcher)).toHaveLength(2);
  expect(updateBody(fetcher, 1)).toEqual(updateBody(fetcher, 0));
  // The location is saved now; the name is still to be saved, and the next save sends it alone.
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Unsaved name");
  expect((document.getElementById("project-location") as HTMLInputElement).value).toBe("/work/app");
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(3));
  expect(updateBody(fetcher, 2)).toEqual({ task: PROJECT_TASK, title: "Unsaved name", expectedTaskHash: OPEN });
});

test("the fields hold still while a save is under way, and the next save starts from the hash it answered", async () => {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((answer) => { resolve = answer; });
  let saves = 0, saved = false;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    if (String(url).includes("/api/task/view")) return answer(saved ? viewsOf(tree({ tasks: [dto(), goal("# Goal\n", SAVED_1, { title: "Renamed" })] }))
      .find((view) => view.task.id === PROJECT_TASK) : goalView("# Goal\n", OPEN));
    if (String(url).includes("/api/commands/task/update")) return saves++ === 0 ? pending.then((response) => response.clone())
      : written(goal("# More\n", LATEST, { title: "Renamed" }));
    if (String(url).includes("/api/commands/field/list")) return answer(fieldList());
    if (String(url).includes("/api/commands/field/get")) return answer(tasksSchema());
    return refusal(404);
  });
  await openProject();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(1));
  expect(body().matches(":disabled")).toBe(true);
  expect(screen.getByLabelText("Name").matches(":disabled")).toBe(true);
  saved = true;
  resolve(written(goal("# Goal\n", SAVED_1, { title: "Renamed" })));
  await waitFor(() => expect(body().matches(":disabled")).toBe(false));
  await screen.findByText("Saved");
  // The feed brings the saved Task; the next save is read against it.
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), goal("# Goal\n", SAVED_1, { title: "Renamed" })] })), rev: 2 });
  await queryClient.refetchQueries();
  fireEvent.change(body(), { target: { value: "# More\n" } });
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(2));
  expect(updateBody(fetcher, 1)).toEqual({ task: PROJECT_TASK, values: { project_policy: "# More\n" }, expectedTaskHash: SAVED_1 });
});
test("a resent save that is refused reads the latest instead of keeping the draft", async () => {
  let latest = false;
  const fetcher = serve([refusal(503), refusal(409)], () => latest ? goalView("# Other\n", LATEST) : goalView("# Goal\n", OPEN));
  await openProject();
  fireEvent.change(body(), { target: { value: "# Mine\n" } });
  fireEvent.click(save());
  const key = intentKey("/fixture", "project-settings", PROJECT_TASK);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe("unconfirmed"));
  latest = true;
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), goal("# Other\n", LATEST)] })), rev: 2 });
  fireEvent.click(screen.getAllByRole("button", { name: "Load the latest" })[0]!);
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(2));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]).toBeUndefined());
  await waitFor(() => expect(body().value).toBe("# Other"));
});
test("confirming a lost Task save keeps the refused location as typed, and its next save uses the confirmed hash", async () => {
  let confirmed = false;
  const fetcher = serve([refusal(400), refusal(503), () => { confirmed = true; return written(goal("# New\n", SAVED_1)); }, written(goal("# New\n", SAVED_1))],
    () => confirmed ? goalView("# New\n", SAVED_1) : goalView("# Goal\n", OPEN));
  await openProject();
  fireEvent.change(body(), { target: { value: "# New\n" } });
  fireEvent.change(document.getElementById("project-location")!, { target: { value: "/work/app" } });
  fireEvent.click(save());
  const key = intentKey("/fixture", "project-settings", PROJECT_TASK);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe("unconfirmed"));
  expect(updateCalls(fetcher)).toHaveLength(2);
  expect(body().matches(":disabled")).toBe(true);
  fireEvent.click(screen.getAllByRole("button", { name: "Load the latest" })[0]!);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]).toBeUndefined());
  expect(body().value).toBe("# New\n");
  expect((document.getElementById("project-location") as HTMLInputElement).value).toBe("/work/app");
  const posts = updateCalls(fetcher);
  expect(new Headers((posts[1]![1] as RequestInit).headers).get("X-Alpacawork-Op-Id"))
    .toBe(new Headers((posts[2]![1] as RequestInit).headers).get("X-Alpacawork-Op-Id"));
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), goal("# New\n", SAVED_1)] })), rev: 2 });
  await queryClient.refetchQueries();
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(4));
  expect(updateBody(fetcher, 3)).toEqual({ task: PROJECT_TASK, cwd: "/work/app", expectedTaskHash: SAVED_1 });
});

test("a field read the server does not answer (a page older than the server) is said with a retry, not left loading", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: unknown) => {
    if (String(url).includes("/api/commands/field/get")) return new Response(JSON.stringify({ error: { code: "not_found", message: "Unknown endpoint",
      retry: "fix", reason: { kind: "unknown_endpoint" } } }), { status: 404 });
    if (String(url).includes("/api/commands/field/list")) return answer(fieldList());
    if (String(url).includes("/api/task/view")) return answer(goalView("# Goal\n", OPEN));
    return refusal(404);
  });
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), goal("# Goal\n", OPEN)] }))}><ProjectDialog project={PROJECT_TASK} /></TestWorkspace>);
  const failure = await screen.findByRole("alert");
  expect(within(failure).getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("the settings start from a read made as they open, not a view kept from before", async () => {
  // The screen still holds the project as it was (a reload keeps earlier views); serve has it renamed since.
  const fetcher = serve([written(goal("# Goal\n", LATEST, { title: "Renamed again" }))],
    () => goalView("# Goal\n", SAVED_1, { title: "Renamed" }));
  render(<TestWorkspace data={screenData(tree({ tasks: [dto(), goal("# Goal\n", OPEN)] }))}><ProjectDialog project={PROJECT_TASK} /><Toaster /></TestWorkspace>);
  await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Renamed"));
  // The live feed has the renamed project too.
  receiveFullIndex(queryClient, { ...indexOf(tree({ tasks: [dto(), goal("# Goal\n", SAVED_1, { title: "Renamed" })] })), rev: 2 });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed again" } });
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(1));
  expect(updateBody(fetcher)).toEqual({ task: PROJECT_TASK, title: "Renamed again", expectedTaskHash: SAVED_1 });
});

test.each(['project-settings', 'project-location'] as const)('Load latest retains a %s restore refusal and input rather than consuming it as a successful read', async operation => {
  const fetcher = serve([refusal(503), problemResponse('restore_changed'), written(goal('# My goal\n', SAVED_1))]);
  await openProject();
  const field = operation === 'project-settings' ? body() : document.getElementById('project-location') as HTMLInputElement;
  const typed = operation === 'project-settings' ? '# My goal\n' : '/work/new';
  fireEvent.change(field, { target: { value: typed } }); fireEvent.click(save());
  const key = intentKey('/fixture', operation, PROJECT_TASK);
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('unconfirmed'));
  const original = useWriteIntentStore.getState().entries[key]!;
  fireEvent.click(screen.getAllByRole('button', { name: 'Load the latest' })[0]!);
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(2));
  await waitFor(() => expect(useWriteIntentStore.getState().entries[key]?.status).toBe('refused'));
  expect(useWriteIntentStore.getState().entries[key]).toMatchObject({ operationId: original.operationId, payload: original.payload, failure: { code: 'restore_changed' } });
  expect(field.value).toBe(typed); await screen.findByText(/This earlier operation is no longer available after a recovery or update/);
  await waitFor(() => expect(save().disabled).toBe(false)); fireEvent.click(save());
  await waitFor(() => expect(updateCalls(fetcher)).toHaveLength(3));
  const calls = updateCalls(fetcher), first = new Headers(calls[0]![1]?.headers), checked = new Headers(calls[1]![1]?.headers);
  expect(calls[1]![1]?.body).toBe(calls[0]![1]?.body); expect([...checked]).toEqual([...first]);
  expect(new Headers(calls[2]![1]?.headers).get('X-Alpacawork-Op-Id')).not.toBe(original.operationId);
});
