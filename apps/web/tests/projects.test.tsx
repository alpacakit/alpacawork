import { AppBar } from '../src/features/chrome/AppBar';
import { newProjectColor } from '../src/domain/project-mark';
import { beforeAll, beforeEach, afterEach, test, expect, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { i18n, startI18n } from "@alpacawork/i18n";
import { DEFAULT_LIMITS, DEFAULT_SCHEMA } from "@alpacawork/contract";
import { Workbench } from "../src/features/shell/Workbench";
import { DialogHost } from "../src/features/shell/DialogHost";
import { useDialogStore } from "../src/state/dialog-store";
import { useViewStore } from "../src/state/view-store";
import { useTimeView } from "../src/state/time-view";
import { useConnection } from "../src/data/connection";
import { queryClient } from "../src/data/query-client";
import { useWaiting } from "../src/features/reader/next-question";
import { headOf, TestWorkspace, homeFixture, indexOf, logEntry, narrowScreen, project, screenData, taskFixture, tree, userBall, viewsOf,
  type TaskFixture, fieldList } from "./fixtures";
import { QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import type { TaskProjectedPageDTO } from "@alpacawork/contract/control";
import { indexKey, resources, showWrittenTask, receiveFullIndex } from "../src/data/resources";
import { problemResponse } from "./problem";
import { ProjectDialog } from "../src/features/panels/ProjectDialog";
import { RowProjectTile } from "../src/features/tree/RowProjectTile";
/** `field get` as the server answers a project: the fields its Tasks use (the default ones here). */
const schemaOfTasks = (url: URL) => ({ task: url.searchParams.get("task"), from: null, fields: [...DEFAULT_SCHEMA], version: "v".repeat(64), schema: {} });

/**
 * The screen of every project: one list of every project's tasks, each named by its own ID; a project is a
 * project Task, one nested in another under it. The header's name narrows the list to a project's tree, its nested
 * projects' included (a menu with each project indented under its own, the numbers of its tree and ⌘ keys), a phone's
 * too, where a dot on the name tells Your turn waits outside the tree in view; what the detail counts (Remaining) is
 * what is in view. A project is made with its name and the project it is in, and its goal and guidance are its body.
 */
beforeAll(() => startI18n());
beforeEach(() => {
  queryClient.clear();
  useConnection.setState({ offline: false });
  useDialogStore.setState({ dialog: null });
  useViewStore.setState(useViewStore.getInitialState());
  history.replaceState(null, "", "/");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => new Response(JSON.stringify(
    String(input).includes("/api/task/timeline") ? { lanes: [], gone: [] } : {}), { headers: { "Content-Type": "application/json" } }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const LOOKED_AT = "2026-09-24T09:30:00Z";
/** A report asking the reader to review it. */
const waits = () => [logEntry(), logEntry({ id: "L2", kind: "reported", at: LOOKED_AT, title: "Look", toState: "waiting" })];
/** A question asked of the reader. */
const asks = () => [logEntry(), logEntry({ id: "L2", kind: "asked", askedTo: null, at: LOOKED_AT, title: "Look",
  description: "Which one?", actor: { kind: "placement", placementId: "P1" } })];
/** Three projects: alpacawork (P100) and Mobile rewrite (P200) at the top, Mobile web (P300) in Mobile rewrite. */
const PROJECTS = [project({ title: "alpacawork", body: "# alp" }), project({ id: "P200", title: "Mobile rewrite", body: "# mob" }),
  project({ id: "P300", parentId: "P200", title: "Mobile web", body: "# web" })];
/** The reader's turn on a report waiting for their review (L2), and on a question asked of them (L2). */
const review = userBall("review", "L2", LOOKED_AT, { aboutRunId: "R1" });
const question = userBall("question", "L2", LOOKED_AT, { questionId: "L2" });
/** Each task in its project as the server names it: Mobile rewrite's T3 and Mobile web's T4 are given theirs. */
const alpWaits = taskFixture({ id: "T1", title: "Alp waits", state: "waiting", log: waits(), ball: review });
const webWaits = taskFixture({ id: "T4", parentId: "P300", title: "Web waits", state: "waiting", log: waits(), ball: review, projectId: "P300" });
/** alpacawork: one wait and one task at work; Mobile rewrite: a question; Mobile web: a wait. */
const TASKS = [
  alpWaits,
  taskFixture({ id: "T2", title: "Alp works", state: "doing" }),
  taskFixture({ id: "T3", parentId: "P200", title: "Mob asks", state: "doing", log: asks(), ball: question, projectId: "P200" }),
  webWaits,
];
/** The home list the server sends of them: the turns in Your turn, T2 in Working. */
const HOME = homeFixture([{ taskId: "T2", section: "doing" },
  ...["T1", "T3", "T4"].map((taskId) => ({ taskId, section: "review" as const }))]);
/** The projects with `tasks`, listed as `home` says. */
const projectsTree = (tasks: TaskFixture[] = TASKS, home = HOME) => tree({ tasks: [...tasks, ...PROJECTS], home });
const mount = (value = projectsTree()) => render(<TestWorkspace data={screenData(value)}><Workbench /></TestWorkspace>);
const rowIds = () => [...document.querySelectorAll<HTMLElement>("li[data-row]")].map((row) => row.dataset.row).sort();

test("a task's project mark shows for a parent with a nested project, but not a single or absent project", () => {
  const { container } = render(<TestWorkspace data={screenData(projectsTree())}><RowProjectTile project="P300" /></TestWorkspace>);
  const mark = () => container.querySelector("[data-project-tile]");
  expect(mark()).not.toBeNull();
  act(() => useViewStore.getState().setProject("P200"));
  expect(mark()).not.toBeNull();
  act(() => useViewStore.getState().setProject("P300"));
  expect(mark()).toBeNull();
  act(() => useViewStore.getState().setProject("P404"));
  expect(mark()).toBeNull();
});

test("every project's tasks are one list, each named by its own ID alone", async () => {
  mount();
  await waitFor(() => expect(rowIds()).toEqual(["T1", "T2", "T3", "T4"]));
  const row = document.querySelector<HTMLElement>('li[data-row="T3"]')!;
  expect(row.textContent).toContain("T3");
  // A project Task is no row: the menu lists it.
  expect(document.querySelector('li[data-row="P200"]')).toBeNull();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(i18n.t("chrome:projects.all"));
});

test("with one project the header is the project's title", async () => {
  render(<TestWorkspace data={screenData(tree({ tasks: [alpWaits], home: homeFixture([{ taskId: "T1", section: "review" }]) }))}>
    <Workbench /></TestWorkspace>);
  await waitFor(() => expect(rowIds()).toEqual(["T1"]));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("default");
  expect(document.querySelector("[data-turn-elsewhere]")).toBeNull();
});

test("the header's name lists every project, a nested one indented under its own, with its tree's numbers and keys; choosing one narrows the list to its tree", async () => {
  mount();
  fireEvent.click(document.querySelector("[data-project-trigger]")!);
  const menu = await screen.findByRole("menu", { name: i18n.t("chrome:projects.menu") });
  const all = within(menu).getByRole("menuitemradio", { name: new RegExp(i18n.t("chrome:projects.all")) });
  expect(all.getAttribute("aria-checked")).toBe("true");
  // Orange is the tree's Your turn as the index counts it, every project's for All.
  expect(all.querySelector('[data-count="turn"]')!.textContent).toBe("3");
  const item = (id: string) => menu.querySelector<HTMLElement>(`[data-project-item="${id}"]`)!;
  // Each project follows the one it is in; its counts include nested projects, and its public P number follows its title.
  expect([...menu.querySelectorAll<HTMLElement>("[data-project-item]")].map((each) => each.dataset.projectItem))
    .toEqual(["all", "P100", "P200", "P300"]);
  // A nested project's title is indented by how deep it is; a top one's is not.
  const indent = (id: string) => item(id).querySelector<HTMLElement>("[dir=auto]")!.style.paddingInlineStart;
  expect(["P100", "P200", "P300"].map(indent)).toEqual(["", "", "1em"]);
  expect(item("P100").querySelector('[data-count="turn"]')!.textContent).toBe("1");
  expect(item("P200").textContent).toContain("Mobile rewrite P200");
  expect(item("P200").querySelector('[data-count="turn"]')!.textContent).toBe("2");
  expect(item("P300").querySelector('[data-count="turn"]')!.textContent).toBe("1");
  expect(item("P200").textContent).toMatch(/(⌘|Ctrl\+)2/);
  expect(item("P300").textContent).toMatch(/(⌘|Ctrl\+)3/);
  expect(within(menu).getByRole("menuitem", { name: i18n.t("chrome:projects.new") })).toBeTruthy();
  fireEvent.click(item("P200"));
  await waitFor(() => expect(rowIds()).toEqual(["T3", "T4"]));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mobile rewrite");
  await waitFor(() => expect(new URL(location.href).searchParams.get("project")).toBe("P200"));
});

test("a project whose parent project is archived (not listed) stands at the top, narrows to its own tree and opens as any other", async () => {
  // Mobile rewrite (P200) is archived: Mobile web (P300) still names it as its parent, which the index does not list.
  const value = tree({ tasks: [alpWaits, webWaits, PROJECTS[0]!, { ...PROJECTS[1]!, lifecycle: "archived" }, PROJECTS[2]!],
    home: homeFixture([{ taskId: "T1", section: "review" }, { taskId: "T4", section: "review" }]) });
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), "http://screen");
    const answer = url.pathname === "/api/task/view" ? viewsOf(value).find((view) => view.task.id === url.searchParams.get("task"))
      : url.pathname === "/api/commands/field/get" ? schemaOfTasks(url) : url.pathname === "/api/commands/field/list" ? fieldList()
      : url.pathname === "/api/task/timeline" ? { lanes: [], gone: [] }
      : { hash: "b".repeat(64), agentsText: "agents: {}\n", agents: {}, catalog: [], limits: { ...DEFAULT_LIMITS } };
    return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
  });
  mount(value);
  fireEvent.click(document.querySelector("[data-project-trigger]")!);
  const menu = await screen.findByRole("menu", { name: i18n.t("chrome:projects.menu") });
  const item = (id: string) => menu.querySelector<HTMLElement>(`[data-project-item="${id}"]`)!;
  expect([...menu.querySelectorAll<HTMLElement>("[data-project-item]")].map((each) => each.dataset.projectItem)).toEqual(["all", "P100", "P300"]);
  expect(item("P300").querySelector<HTMLElement>("[dir=auto]")!.style.paddingInlineStart).toBe("");
  fireEvent.click(item("P300"));
  // Its tree's tasks are the list's top level; another project's are not in it.
  await waitFor(() => expect(rowIds()).toEqual(["T4"]));
  act(() => useViewStore.getState().setProject("P100"));
  await waitFor(() => expect(rowIds()).toEqual(["T1"]));
  act(() => useViewStore.getState().setProject("P300"));
  await waitFor(() => expect(rowIds()).toEqual(["T4"]));
  cleanup();
  // Its settings open on its own goal.
  render(<TestWorkspace data={screenData(value)}><ProjectDialog project="P300" /></TestWorkspace>);
  await waitFor(() => expect((document.getElementById("project-policy") as HTMLTextAreaElement | null)?.value).toBe("# web"));
});

test("⌘ and a number narrow to that project; ⌘0 shows every project again", async () => {
  mount();
  await waitFor(() => expect(rowIds()).toHaveLength(4));
  fireEvent.keyDown(document, { key: "1", metaKey: true });
  await waitFor(() => expect(rowIds()).toEqual(["T1", "T2"]));
  fireEvent.keyDown(document, { key: "3", metaKey: true });
  await waitFor(() => expect(rowIds()).toEqual(["T4"]));
  fireEvent.keyDown(document, { key: "0", metaKey: true });
  await waitFor(() => expect(rowIds()).toHaveLength(4));
});

const choose = async (id: string) => {
  fireEvent.click(document.querySelector("[data-project-trigger]")!);
  fireEvent.click(await waitFor(() => document.querySelector<HTMLElement>(`[data-project-item="${id}"]`)!));
};
const dot = () => document.querySelector("h1 [data-turn-elsewhere]");

test("while one project is in view, Waiting for you outside its tree is a dot on the name; with every project in view there is none", async () => {
  const narrow = narrowScreen(true);
  try {
    mount();
    await waitFor(() => expect(rowIds()).toContain("T3"));
    expect(dot()).toBeNull();
    await choose("P100");
    await waitFor(() => expect(rowIds()).toEqual(["T1", "T2"]));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("alpacawork");
    // Mobile rewrite's tree waits: the dot says only that something waits, for the reader to find in the menu.
    expect(dot()).not.toBeNull();
    expect(document.querySelector("[data-project-trigger]")!.getAttribute("aria-description")).toBe(i18n.t("tree:home.turn"));
    await choose("all");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(i18n.t("chrome:projects.all")));
    expect(dot()).toBeNull();
  } finally { narrow.restore(); }
});

test("a project's own Waiting for you and another's work under way put no dot on its name", async () => {
  // Only alpacawork waits on the reader; Mobile rewrite has a task at work, which is not Your turn.
  mount(projectsTree([alpWaits, taskFixture({ id: "T3", parentId: "P200", title: "Mob works", state: "doing", projectId: "P200" })],
    homeFixture([{ taskId: "T3", section: "doing" }, { taskId: "T1", section: "review" }])));
  await waitFor(() => expect(rowIds()).toHaveLength(2));
  await choose("P100");
  await waitFor(() => expect(rowIds()).toEqual(["T1"]));
  expect(dot()).toBeNull();
  await choose("P200");
  await waitFor(() => expect(rowIds()).toEqual(["T3"]));
  expect(dot()).not.toBeNull();
});

test("a nested project's Waiting for you is in its parent's tree: no dot while the parent is in view", async () => {
  mount(projectsTree([webWaits], homeFixture([{ taskId: "T4", section: "review" }])));
  await waitFor(() => expect(rowIds()).toEqual(["T4"]));
  await choose("P200");
  await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Mobile rewrite"));
  expect(rowIds()).toEqual(["T4"]);
  expect(dot()).toBeNull();
  await choose("P100");
  await waitFor(() => expect(rowIds()).toEqual([]));
  expect(dot()).not.toBeNull();
});

test("a phone's list reads the chronology only while it draws the time strips: not when narrowing without them", async () => {
  const narrow = narrowScreen(true);
  const timelineReads = () => vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => String(input).includes("/api/task/timeline")).length;
  try {
    useTimeView.setState({ strips: false });
    mount();
    await choose("P100");
    await waitFor(() => expect(rowIds()).toEqual(["T1", "T2"]));
    await choose("all");
    await waitFor(() => expect(rowIds()).toContain("T3"));
    expect(timelineReads()).toBe(0);
    act(() => useTimeView.setState({ strips: true }));
    await waitFor(() => expect(timelineReads()).toBeGreaterThan(0));
  } finally { narrow.restore(); useTimeView.setState({ strips: false }); }
});

test("what waits on the reader (remaining) is counted in view: every project's, or the one project's tree", async () => {
  const seen: number[] = [];
  function Left() { seen.push(useWaiting().length); return null; }
  render(<TestWorkspace data={screenData(projectsTree())}><Left /></TestWorkspace>);
  expect(seen.at(-1)).toBe(3);
  act(() => useViewStore.getState().setProject("P100"));
  expect(seen.at(-1)).toBe(1);
  act(() => useViewStore.getState().setProject("P200"));
  expect(seen.at(-1)).toBe(2);
});

test("a task opened from elsewhere that is not in the project in view widens the list to every project", async () => {
  mount();
  act(() => useViewStore.getState().setProject("P100"));
  await waitFor(() => expect(rowIds()).toEqual(["T1", "T2"]));
  act(() => useViewStore.getState().openTask("T3", { reader: true }));
  await waitFor(() => expect(rowIds()).toHaveLength(4));
  expect(useViewStore.getState().project).toBeNull();
});

test("narrowing closes what is open outside the project's tree, and keeps what is in it", async () => {
  mount();
  act(() => useViewStore.getState().openTask("T4", { reader: true }));
  act(() => useViewStore.getState().setProject("P200"));
  await waitFor(() => expect(rowIds()).toEqual(["T3", "T4"]));
  expect(useViewStore.getState().selected).toBe("T4");
  act(() => useViewStore.getState().setProject("P100"));
  await waitFor(() => expect(useViewStore.getState().reader.open).toBe(false));
  expect(useViewStore.getState().selected).toBeNull();
});

test("a written finished top-level task leaves its place to the server: no finished page of any project guesses its row", () => {
  const value = projectsTree([taskFixture({ id: "T1", title: "Alp", userRequested: true }),
    taskFixture({ id: "T3", parentId: "P200", title: "Mob", userRequested: true, projectId: "P200" }),
    taskFixture({ id: "T4", parentId: "P300", title: "Web", userRequested: true, projectId: "P300" })], []);
  queryClient.setQueryData(indexKey, indexOf(value));
  type Page = InfiniteData<TaskProjectedPageDTO, string | null>;
  const page: Page = { pages: [{ rows: [], total: 0, nextAfter: null, generation: "a", sourcePv: 0 as never }], pageParams: [null] };
  for (const scope of [null, "P100", "P200", "P300"]) queryClient.setQueryData(resources.finished(value.root, null, scope).queryKey, page);
  showWrittenTask(queryClient, headOf({ ...value.tasks.find((task) => task.id === "T4")!, state: "done", version: 2 }));
  const ids = (scope: string | null) => queryClient.getQueryData<Page>(
    resources.finished(value.root, null, scope).queryKey)!.pages[0]!.rows.map((row) => row.id);
  for (const scope of [null, "P100", "P200", "P300"]) {
    expect(ids(scope), String(scope)).toEqual([]);
  }
});

test("the project in settings is chosen by its title and public ID; it cannot be changed while its goal (its body) holds unsaved words; saved, it can", async () => {
  const value = projectsTree();
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = new URL(String(input), "http://screen");
    const answer = url.pathname === "/api/task/view" ? viewsOf(value).find((view) => view.task.id === url.searchParams.get("task"))
      : url.pathname === "/api/commands/field/get" ? schemaOfTasks(url) : url.pathname === "/api/commands/field/list" ? fieldList()
      : { hash: "b".repeat(64), agentsText: "agents: {}\n", agents: {}, catalog: [], limits: { ...DEFAULT_LIMITS, run_minutes: 120 } };
    return new Response(JSON.stringify(answer), { headers: { "Content-Type": "application/json" } });
  });
  render(<TestWorkspace data={screenData(value)}><ProjectDialog project={null} /></TestWorkspace>);
  const goal = () => document.getElementById("project-policy") as HTMLTextAreaElement;
  const select = () => document.getElementById("project-settings-target") as HTMLSelectElement;
  await waitFor(() => expect(goal()?.value).toBe("# alp"));
  expect([...select().options].map((option) => [option.value, option.textContent]))
    .toEqual([["P100", "alpacawork P100"], ["P200", "Mobile rewrite P200"], ["P300", "\u00a0\u00a0Mobile web P300"]]);
  expect(select().disabled).toBe(false);
  fireEvent.change(goal(), { target: { value: "# unsaved" } });
  await waitFor(() => expect(select().disabled).toBe(true));
  // Back to what is saved: nothing is unsaved, the project can be changed.
  fireEvent.change(goal(), { target: { value: "# alp" } });
  await waitFor(() => expect(select().disabled).toBe(false));
});

test("a new project is named and put in the project chosen (the one in view at first), made as a project Task, then shown", async () => {
  const made = project({ id: "P400", parentId: "P200", title: "Mobile tools" });
  const value = projectsTree();
  queryClient.setQueryData(indexKey, indexOf(value));
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input) !== "/api/commands/task/new" || init?.method !== "POST") return new Response("{}");
    // The feed lists the new project as the answer arrives.
    queryClient.setQueryData(indexKey, indexOf(tree({ tasks: [...value.tasks, made] })));
    return new Response(JSON.stringify({ task: headOf(made) }), { headers: { "Content-Type": "application/json" } });
  });
  act(() => useViewStore.getState().setProject("P200"));
  render(<TestWorkspace data={screenData(value)}><DialogHost /></TestWorkspace>);
  act(() => useDialogStore.getState().openProject());
  const parent = await waitFor(() => document.getElementById("project-parent") as HTMLSelectElement);
  // A project names no short name; it is put in a project, or none at the top.
  expect(document.getElementById("project-key")).toBeNull();
  expect([...parent.options].map((option) => option.value)).toEqual(["none", "P100", "P200", "P300"]);
  expect([...parent.options].slice(1).map((option) => option.textContent)).toEqual(["alpacawork P100", "Mobile rewrite P200", "  Mobile web P300"]);
  expect(parent.value).toBe("P200");
  fireEvent.change(document.getElementById("project-new-name")!, { target: { value: "Mobile tools" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("panels:project.create") }));
  await waitFor(() => expect(useViewStore.getState().project).toBe("P400"));
  const sent = vi.mocked(globalThis.fetch).mock.calls.filter(([input, init]) => String(input) === "/api/commands/task/new" && init?.method === "POST");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(String(sent[0]![1]!.body))).toEqual({ kind: "project", color: newProjectColor(PROJECTS.map(project => project.settings!.color)), parent: "P200", title: "Mobile tools" });
  expect(useDialogStore.getState().dialog).toBeNull();
});

/** Makes a project whose write is answered before the feed lists it, up to the moment the list would list it. */
async function madeBeforeListed() {
  const made = project({ id: "P400", parentId: null, title: "Mobile tools" });
  const value = projectsTree();
  queryClient.setQueryData(indexKey, indexOf(value));
  vi.mocked(globalThis.fetch).mockImplementation(async () => new Response(JSON.stringify({ task: headOf(made) }), { headers: { "Content-Type": "application/json" } }));
  render(<TestWorkspace data={screenData(value)}><DialogHost /></TestWorkspace>);
  act(() => useDialogStore.getState().openProject());
  await waitFor(() => expect(document.getElementById("project-new-name")).not.toBeNull());
  fireEvent.change(document.getElementById("project-new-name")!, { target: { value: "Mobile tools" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("panels:project.create") }));
  await waitFor(() => expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => String(input) === "/api/commands/task/new")).toBe(true));
  // The answer is taken in; the list has not heard of the project.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(useViewStore.getState().project).toBeNull();
  return () => act(() => { queryClient.setQueryData(indexKey, indexOf(tree({ tasks: [...value.tasks, made] }))); });
}

test("a new project is shown once it is listed, however late, while the person stays where they were", async () => {
  const listed = await madeBeforeListed();
  listed();
  await waitFor(() => expect(useViewStore.getState().project).toBe("P400"));
});

test.each([
  ["another project", () => useViewStore.getState().setProject("P100"), { project: "P100", selected: null }],
  ["a task", () => useViewStore.getState().select("T1"), { project: null, selected: "T1" }],
])("a new project listed after the person went to %s leaves them there", async (_, move, there) => {
  const listed = await madeBeforeListed();
  act(move);
  listed();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  const { project: shown, selected } = useViewStore.getState();
  expect({ project: shown, selected }).toEqual(there);
});

test('a loaded workspace with zero listed projects has a real name menu and Create, without project settings', async () => {
  const data = screenData(tree({tasks:[{...PROJECTS[0]!,lifecycle:'archived'}]}));
  expect(data.info.projects).toEqual([]);
  render(<TestWorkspace data={data}><AppBar /></TestWorkspace>);
  const trigger = document.querySelector('[data-project-trigger]')!;
  expect(trigger).not.toBeNull(); expect(trigger.textContent).toContain('All projects');
  fireEvent.click(trigger);
  expect(document.querySelector('[data-project-settings]')).toBeNull();
  fireEvent.click(document.querySelector('[data-project-new]')!);
  await waitFor(() => expect(useDialogStore.getState().dialog).toEqual({kind:'project'}));
});
