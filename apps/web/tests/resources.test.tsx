import { projectedIndexSchema } from '@alpacawork/contract/control';
import { serverView, serverPatch, jsonAnswer } from './receipt-fixture';
import { fixtureReceipt } from './read-fixtures';
import { assessRead } from '../src/data/resources';
import { afterEach, expect, test, vi } from "vitest";
import { InfiniteQueryObserver, QueryObserver, type InfiniteData } from "@tanstack/react-query";
import type { ControlTaskDTO, IndexPatchDTO, ProjectedIndexDTO, TaskProjectedPageDTO, TaskPageRowDTO, TaskProjectedViewDTO } from "@alpacawork/contract/control";
import { queryClient } from "../src/data/query-client";
import { applyIndexPatch, indexKey, receivePatch, resources, showWrittenTask } from "../src/data/resources";
import { headOf, at, dto, homeFixture, indexOf, logEntry, decideItem, questionFixture, rowOf, run, searchAnswer, served0, taskFixture, tree, userBall, viewsOf, PROJECT_TASK } from "./fixtures";
import { taskDetail } from "../src/data/queries";
import { displayReadFacts, readerPresentation } from '../src/data/read-model';
import { serverReadFacts } from '../src/data/read-model';
import { mapWorkspace } from "../src/data/map";
import { baselines } from "./fixtures";

afterEach(() => { queryClient.clear(); vi.restoreAllMocks(); });

const base = () => indexOf(tree({ tasks: [dto(), dto({ id: "T2", path: "tasks/T2", title: "Two" })], runs: [run("R1")] }));

test("a write answer preserves the server's own and descendant usage until the next feed row", () => {
  const task = dto();
  const usage = { runs: 1, runMs: 120_000, tokens: null, tokensUnknown: 1 };
  const usageBelow = { runs: 3, runMs: 420_000, tokens: { input: 10, cacheRead: 2, cacheWrite: 0, output: 3 }, tokensUnknown: 1 };
  const runsBelow: [string, number][] = [["R1", Date.parse(at)]];
  const snapshot = indexOf(tree({ tasks: [task], usage: { T1: { usage, usageBelow, runsBelow } } }));
  fixtureReceipt(indexKey, snapshot);
  showWrittenTask(queryClient, headOf({ ...task, title: "Changed", version: 2, hash: "b".repeat(64) }));
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)).toBe(snapshot);
  const row = displayReadFacts(queryClient)!.tasks.find(task => task.id === "T1")!;
  expect(row.title).toBe("Changed");
  expect(row.usage).toEqual(usage);
  expect(row.usageBelow).toEqual(usageBelow);
  expect(row.runsBelow).toEqual(runsBelow);
  const mapped = mapWorkspace({ ...snapshot, tasks: [row] }, baselines([task]));
  expect(mapped.tasks[0]?.usageBelow).toEqual(usageBelow);
  expect(mapped.tasks[0]?.runsBelow).toEqual(runsBelow);
});
/** A closed list's row of `task`, as a page or a search answers it. */
function pageRowOf(task: ControlTaskDTO): TaskPageRowDTO {
  const { stateLog, ball, question, ...fields } = rowOf(task);
  return { ...fields, ...(ball ? { ball } : {}), ...(question ? { question } : {}),
    stateMark: [...stateLog].reverse().find(entry => entry.toState !== null) ?? null, latestReport: null, childCounts: { live: 0, finished: 0 } };
}
const pageOf = (rows: TaskPageRowDTO[]) => ({ rows, total: rows.length, nextAfter: null, ...served0 });
/** A patch from `index` that changes nothing but raises the named resources' required versions. */
const raise = (index: ProjectedIndexDTO, requires: Parameters<typeof serverPatch>[2]) => serverPatch(index, [], requires);

test("each resource has its own key under the workspace root", () => {
  expect(resources.taskView("/r", "T1").queryKey).toEqual(["task", "/r", "T1"]);
  expect(resources.taskSearch("/r", "words", null).queryKey).toEqual(["task-search", "/r", "words", null]);
  expect(resources.taskSearch("/r", "words", PROJECT_TASK).queryKey).toEqual(["task-search", "/r", "words", PROJECT_TASK]);
  expect(indexKey).toEqual(["index"]);
});

test("the time window key contains its inputs but not the live revision", () => {
  expect(resources.timeline("/r", null, ["T1"], [], "2026-10-13T00:00:00.000Z", "2026-10-13T01:00:00.000Z").queryKey)
    .toEqual(["task-timeline", "/r", "root", "T1", "",
    "2026-10-13T00:00:00.000Z", "2026-10-13T01:00:00.000Z"]);
});

test("the time window uses the same cache for the same visible IDs in another order", () => {
  const first = resources.timeline("/r", null, ["T2", "T1", "T2"], ["T2", "T1"], "from", "to");
  const second = resources.timeline("/r", null, ["T1", "T2"], ["T1", "T2"], "from", "to");
  expect(first.queryKey).toEqual(second.queryKey);
});

test("a text file is reused by revision and read again for a new revision", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("Text"));
  const first = resources.fileText("/r", "T1", "note.md", "v1");
  await queryClient.fetchQuery(first);
  await queryClient.fetchQuery(first);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await queryClient.fetchQuery(resources.fileText("/r", "T1", "note.md", "v2"));
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("raw file bytes are reused across encoding choices but reread for every identity change", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([0x96, 0xbc])));
  const first = resources.fileBytes("/r", "T1", "note.csv", "v1");
  expect(await queryClient.fetchQuery(first)).toEqual(new Uint8Array([0x96, 0xbc]));
  await queryClient.fetchQuery(first);
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (const [root, task, name, revision] of [["/r", "T1", "note.csv", "v2"], ["/r", "T2", "note.csv", "v1"],
    ["/s", "T1", "note.csv", "v1"], ["/r", "T1", "other.csv", "v1"]] as const)
    await queryClient.fetchQuery(resources.fileBytes(root, task, name, revision));
  expect(fetcher).toHaveBeenCalledTimes(5);
});

test("a receipt retains canonical page membership; only server reads move it", async () => {
  const index = indexOf(tree({ tasks: [dto()] }));
  fixtureReceipt(indexKey, index);
  const canonical = queryClient.getQueryData(indexKey);
  type Page = InfiniteData<TaskProjectedPageDTO, string | null>;
  const empty = (): Page => ({ pages: [pageOf([])], pageParams: [null] });
  const top = resources.finished(index.root, null).queryKey, below = resources.finished(index.root, "T7").queryKey;
  const shelved = resources.shelved(index.root, null).queryKey;
  const held = [top, below, shelved].map(key => { fixtureReceipt(key, empty()); return queryClient.getQueryData(key); });
  showWrittenTask(queryClient, headOf(dto({ state: "done", version: 2, hash: "b".repeat(64), title: "Just finished" })));
  expect(queryClient.getQueryData(indexKey)).toBe(canonical);
  for (const [i, key] of [top, below, shelved].entries()) {
    expect(queryClient.getQueryData(key)).toBe(held[i]);
    expect(queryClient.getQueryData<Page>(key)?.pages[0]).toMatchObject({ rows: [], total: 0 });
  }
  // The server has placed it on a shelved page; no receipt guesses that membership.
  const archived = dto({ lifecycle: "archived", version: 3, hash: "c".repeat(64), title: "Shelved" });
  const archivedValue = tree({ tasks: [archived] });
  const archivedRow = pageRowOf(archivedValue.tasks[0]!);
  fixtureReceipt(shelved, { ...empty(), pages: [{ ...empty().pages[0]!, rows: [archivedRow], total: 1 }] });
  const knownPage = queryClient.getQueryData(shelved);
  const finished = dto({ state: "done", version: 4, hash: "d".repeat(64), title: "Finished again" });
  showWrittenTask(queryClient, headOf(finished));
  expect(queryClient.getQueryData(indexKey)).toBe(canonical);
  expect(queryClient.getQueryData(shelved)).toBe(knownPage);
  expect(queryClient.getQueryData<Page>(top)?.pages[0]).toMatchObject({ rows: [], total: 0 });
  expect(displayReadFacts(queryClient)!.tasks.find(row => row.id === 'T1')?.title).toBe('Finished again');
  // A row older than what this screen wrote is no current fact (the version floor).
  expect(serverReadFacts(queryClient)!.tasks.map(each => each.id)).not.toContain("T1");
  // The normal page GET, once the server's patch says the page changed, selects the location and count.
  const row = pageRowOf(finished);
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonAnswer({ ...empty().pages[0]!, rows: [row], total: 1, sourcePv: 1 }));
  receivePatch(queryClient, raise(index, { page: ['finished:root'] }));
  await queryClient.fetchInfiniteQuery(resources.finished(index.root, null));
  expect(queryClient.getQueryData<Page>(top)?.pages[0]).toMatchObject({ rows: [{ id: 'T1', title: 'Finished again' }], total: 1 });
  expect(fetcher).toHaveBeenCalledOnce();
});

test("opening a finished task supplies its responsible placement without enlarging the live index", () => {
  const person: ProjectedIndexDTO["placements"][number] = {
    id: "P1", taskId: "T1", agentId: "A1", profileKey: "codex", responsible: true, active: true,
    revision: 1, startedAt: "2026-09-24T09:00:00Z", endedAt: null, headRunId: null,
    runtime: { displayState: "idle", reason: null, sourceRunIds: [], runningCount: 0,
      queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null },
  };
  const value = tree({ tasks: [dto({ state: "done" })], placements: [person] });
  const index = { ...indexOf(value), tasks: [], placements: [] };
  expect(index.placements).toEqual([]);
  fixtureReceipt(indexKey, index);
  fixtureReceipt(resources.taskView(index.root, "T1").queryKey, viewsOf(value)[0]);
  expect(serverReadFacts(queryClient)!.placements).toEqual([person]);
});

test("a receipt displays its document and held files while the server index and question remain canonical", async () => {
  const value = tree();
  const index = indexOf(value);
  fixtureReceipt(indexKey, { ...index, tasks: index.tasks.map((row) => row.id === "T1" ? { ...row, question: "Which option?" } : row) });
  const file = { name: "a.md", size: 1, revision: "f".repeat(64), at: "2026-09-24T09:00:00Z" };
  const view: TaskProjectedViewDTO = { ...viewsOf(value)[0]!, task: { ...value.tasks[0]!, files: [file] } };
  fixtureReceipt(resources.taskView(value.root, "T1").queryKey, view);
  const written = dto({ hash: "e".repeat(64), state: "waiting", body: "Edited",
    log: [logEntry(), logEntry({ id: "L2", kind: "reported", toState: "waiting", title: "Done" })] });
  showWrittenTask(queryClient, headOf(written));
  const canonical = queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!;
  const row = canonical.tasks[0]!;
  expect(row).toMatchObject({ hash: index.tasks[0]!.hash, state: index.tasks[0]!.state, question: 'Which option?',
    notice: index.tasks[0]!.notice });
  const displayed = displayReadFacts(queryClient)!.tasks[0]!;
  expect(displayed).toMatchObject({ hash: written.hash, title: written.title, state: row.state,
    question: 'Which option?', notice: row.notice, stateLog: row.stateLog });
  const presentation = readerPresentation(queryClient, value.root, 'T1');
  expect(presentation).toMatchObject({ kind: 'written', document: { hash: written.hash, values: { notes: 'Edited' } }, earlier: { task: { files: [file] } } });
  expect(taskDetail(mapWorkspace(canonical, baselines(value.tasks)).tasks[0]!, queryClient.getQueryData(resources.taskView(value.root, 'T1').queryKey)!))
    .toMatchObject({ hash: written.hash, files: [file] });
  const created = dto({ id: "T9", path: "tasks/T9", title: "Created", version: 2, body: "Written document" });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer(serverView(tree({ tasks: [created] }), created.id)));
  const receipt = showWrittenTask(queryClient, headOf(created));
  projectedIndexSchema.parse(queryClient.getQueryData(indexKey));
  expect(serverReadFacts(queryClient)!.tasks.find(each => each.id === 'T1')?.hash).toBe(row.hash);
  expect(queryClient.getQueryData(indexKey)).toBe(canonical);
  await receipt;
  await queryClient.fetchQuery(resources.taskView(index.root, created.id));
  projectedIndexSchema.parse(queryClient.getQueryData(indexKey));
  // The list brings its row with its own patch; the opened view shows its document meanwhile.
  expect(queryClient.getQueryData<TaskProjectedViewDTO>(resources.taskView(index.root, created.id).queryKey)?.task.values?.notes).toBe(created.values?.notes);
});

test("a write answer older than a change the feed already showed does not replace the newer row", () => {
  const written = dto({ title: "Mine", version: 11, hash: "a".repeat(64) });
  const newer = dto({ title: "Agent's", version: 12, hash: "b".repeat(64) });
  const start = indexOf(tree({ tasks: [dto({ version: 10 })] }));
  fixtureReceipt(indexKey, start);
  // The feed's delta (an agent's v12) lands before the answer to the screen's own write (v11).
  const row = indexOf(tree({ tasks: [newer] })).tasks[0]!;
  receivePatch(queryClient, serverPatch(start, [row]));
  showWrittenTask(queryClient, headOf(written));
  const shown = queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!.tasks[0]!;
  // The server keeps v12 as published: no later patch would bring it back.
  expect([shown.version, shown.title]).toEqual([12, "Agent's"]);
});

test("an older write answer cannot replace a newer opened view", () => {
  const index = indexOf(tree({ tasks: [dto({ version: 10 })] }));
  fixtureReceipt(indexKey, index);
  const view = viewsOf(tree({ tasks: [dto({ version: 12, hash: "b".repeat(64), body: "Newer body" })] }))[0]!;
  fixtureReceipt(resources.taskView(index.root, "T1").queryKey, view);
  showWrittenTask(queryClient, headOf(dto({ version: 11, hash: "a".repeat(64), body: "Older body" })));
  expect(queryClient.getQueryData<TaskProjectedViewDTO>(resources.taskView(index.root, "T1").queryKey)?.task.values?.notes).toBe("Newer body");
});

test("an opened task carries the hash and version of the document it shows, so an edit is based on what is read", () => {
  const shownValue = tree({ tasks: [dto({ hash: "a".repeat(64), version: 3, body: "Read body" })] });
  const newerRow = mapWorkspace(indexOf(tree({ tasks: [dto({ hash: "b".repeat(64), version: 4 })] })), baselines()).tasks[0]!;
  const opened = taskDetail(newerRow, viewsOf(shownValue)[0]!);
  expect([opened.hash, opened.version, opened.values.values.notes]).toEqual(["a".repeat(64), 3, "Read body"]);
});

test("canonical Task GET follows standard observer cancellation and resumes on the same key", async () => {
  queryClient.clear();
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
    String(input).includes("/api/task/view") ? new Promise(() => {}) : Promise.resolve(new Response("{}")));
  const options = resources.taskView("/r", "T1");
  const views = () => fetcher.mock.calls.filter(([input]) => String(input).includes("/api/task/view")).length;
  const card = new QueryObserver(queryClient, options);
  const leave = card.subscribe(() => {});
  await vi.waitFor(() => expect(views()).toBe(1));
  leave();
  expect(queryClient.getQueryState(options.queryKey)?.fetchStatus).toBe('idle');
  // Signal consumption cancels an abandoned request; the next reader uses the same Query.
  const reader = new QueryObserver(queryClient, options);
  const stop = reader.subscribe(() => {});
  try {
    expect(views()).toBe(2);
    expect(queryClient.getQueryCache().findAll({ queryKey: options.queryKey, exact: true })).toHaveLength(1);
    expect(queryClient.getQueryState(options.queryKey)?.fetchStatus).toBe("fetching");
  } finally { stop(); queryClient.clear(); }
});

test("a committed body write keeps optimistic text, but its open questions are only a complete server view's", async () => {
  // What a question asks is the copy fixed when it was asked (the view's questions), never read from a body.
  const asked = questionFixture({ id: "L2", title: "Storage location", decide: [decideItem("Storage location", [["Option1 Local", "text"]])] });
  const value = tree({ tasks: [dto()], questions: [asked] });
  const options = resources.taskView(value.root, "T1");
  fixtureReceipt(indexKey, indexOf(value));
  fixtureReceipt(options.queryKey, viewsOf(value)[0]);
  let release!: (response: Response) => void;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const observer = new QueryObserver(queryClient, options);
  const unsubscribe = observer.subscribe(() => {});
  const asks = () => { const read = observer.getCurrentResult().data; const view = read && ('kind' in read ? read.earlier : read); return view?.questions?.map(question => question.decide); };
  try {
    const written = dto({ body: "## 問い\n### 2 Publication destination\n#### Option1 Internal\ntext", version: 2, hash: "b".repeat(64) });
    showWrittenTask(queryClient, headOf(written));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(observer.getCurrentResult().isFetching).toBe(true);
    expect(observer.getCurrentResult().data?.task.values?.notes).toBe(written.values?.notes);
    expect(asks()).toEqual([asked.decide]);
    const later = questionFixture({ id: "L3", title: "Publication destination", decide: [decideItem("Publication destination", [["Option1 Internal", "text"]])] });
    release(new Response(JSON.stringify(viewsOf(tree({ tasks: [written], questions: [asked, later] }))[0])));
    await vi.waitFor(() => expect(asks()).toEqual([asked.decide, later.decide]));
    expect(observer.getCurrentResult().isStale).toBe(false);
  } finally { unsubscribe(); }
});

test("a receipt displays its title while state, ball and notice remain the server's", () => {
  const ball = userBall("review", "L2", at, { aboutRunId: "R1" });
  const log = [logEntry(), logEntry({ id: "L2", kind: "reported", fromState: "doing", toState: "waiting" })];
  const index = indexOf(tree({ tasks: [taskFixture({ state: "waiting", log, ball })] }));
  fixtureReceipt(indexKey, index);
  const canonical = queryClient.getQueryData(indexKey);
  const displayed = () => displayReadFacts(queryClient)!.tasks.find(each => each.id === 'T1')!;
  showWrittenTask(queryClient, headOf(dto({ state: "waiting", log, title: "Retitled", version: 2, hash: "b".repeat(64) })));
  expect([displayed().title, displayed().state, displayed().ball, displayed().notice.turnKey]).toEqual(["Retitled", 'waiting', ball, "L2"]);
  const held = dto({ state: "held", version: 3, hash: "c".repeat(64),
    log: [...log, logEntry({ id: "L3", kind: "reported", fromState: "waiting", toState: "held" })] });
  showWrittenTask(queryClient, headOf(held));
  expect(queryClient.getQueryData(indexKey)).toBe(canonical);
  expect([displayed().state, displayed().ball, displayed().notice.turnKey]).toEqual(['waiting', ball, 'L2']);
  expect(readerPresentation(queryClient, index.root, 'T1')).toMatchObject({ kind: 'written', document: { state: 'held' } });
  // A row older than what this screen wrote is no current fact until the server publishes the write.
  expect(serverReadFacts(queryClient)!.tasks.find(each => each.id === 'T1')).toBeUndefined();
  // A publication supplies the new state/ball/notice, even if the document is still waiting for its GET.
  const published = indexOf(tree({ tasks: [held] }), index.rev + 1);
  receivePatch(queryClient, serverPatch(index, published.tasks));
  expect([displayed().state, displayed().ball, displayed().notice.turnKey]).toEqual(['held', null, null]);
});

test("an old immutable receipt cannot replace a completed Task's newer detail or page", () => {
  const old = dto({ state: "done", version: 2, hash: "b".repeat(64) });
  const newer = dto({ state: "done", version: 3, hash: "c".repeat(64), title: "Latest completed" });
  const treeRead = tree({ tasks: [newer] });
  const index = { ...indexOf(treeRead), tasks: [] };
  expect(index.tasks).toEqual([]);
  fixtureReceipt(indexKey, index);
  const view = viewsOf(treeRead)[0]!;
  fixtureReceipt(resources.taskView(index.root, newer.id).queryKey, view);
  showWrittenTask(queryClient, headOf(old));
  expect(queryClient.getQueryData<TaskProjectedViewDTO>(resources.taskView(index.root, newer.id).queryKey)?.task.hash).toBe(newer.hash);
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)).toBe(index);
  queryClient.removeQueries({ queryKey: resources.taskView(index.root, newer.id).queryKey });
  const page = { rows: [{ ...searchAnswer([newer.id]).rows[0]!, version: newer.version, hash: newer.hash, state: newer.state }],
    total: 1, nextAfter: null, ...served0 };
  fixtureReceipt(resources.finished(index.root, null).queryKey, { pages: [page], pageParams: [null] });
  showWrittenTask(queryClient, headOf(old));
  expect(queryClient.getQueryData<ProjectedIndexDTO>(indexKey)).toBe(index);
  const held = queryClient.getQueryData<{ pages: { rows: { hash: string; version: number }[] }[] }>(resources.finished(index.root, null).queryKey);
  expect(held?.pages[0]?.rows[0]?.hash).toBe(newer.hash);
  expect(held?.pages[0]?.rows[0]?.version).toBe(newer.version);
});


test("a patch replaces and removes rows, placements and Runs by ID, keeps the rest and takes the small fields it changes", () => {
  const index = base();
  const two = indexOf(tree({ tasks: [dto({ id: "T2", path: "tasks/T2", title: "Two again", hash: "b".repeat(64) })] })).tasks[0]!;
  const three = indexOf(tree({ tasks: [dto({ id: "T3", path: "tasks/T3" })] })).tasks[0]!;
  const patch = serverPatch(index, [two, three]);
  const next = applyIndexPatch(index, { ...patch, tasks: { upsert: [two, three], remove: ["T1"] },
    runs: { upsert: [run("R2")], remove: ["R1"] }, meta: { staleIds: ["T2"], writable: false } })!;
  expect(next.tasks.map((row) => [row.id, row.title])).toEqual([["T2", "Two again"], [PROJECT_TASK, "default"], ["T3", "Task one"]]);
  expect(next.runs.map((item) => item.id)).toEqual(["R2"]);
  expect(next).toMatchObject({ rev: index.rev + 1, generation: index.generation, sourcePv: patch.sourcePv, staleIds: ["T2"], writable: false });
  // What it does not change stays the same objects.
  expect(next.placements).toBe(index.placements);
  expect(next.counts.children).toBe(index.counts.children);
});

test("a patch places each changed home row after the row it names; a row it removes is gone", () => {
  const index = indexOf(tree({ tasks: [dto(), dto({ id: "T2", state: "waiting" }), dto({ id: "T3", state: "todo" })],
    home: homeFixture([{ taskId: "T1", section: "doing" }, { taskId: "T2", section: "review" }, { taskId: "T3", section: "todo" }]) }));
  const two = index.home.find((row) => row.taskId === "T2")!;
  // T1 comes to wait on the user, after T2; T3 is no longer listed.
  const [moved] = homeFixture([{ taskId: "T1", section: "review", summary: { done: 1, total: 2 } }]);
  const next = applyIndexPatch(index, { ...serverPatch(index, []), home: { upsert: [{ row: moved!, after: "T2" }], remove: ["T3"] } })!;
  expect(next.home).toEqual([two, moved]);
  expect(next.home[0]).toBe(two);
  expect(applyIndexPatch(next, { ...serverPatch(next, []), home: { upsert: [{ row: moved!, after: null }], remove: [] } })!.home).toEqual([moved, two]);
});

test("changed home rows land where they belong in whatever order the patch lists them; an unknown predecessor is a gap", () => {
  const rows = homeFixture([{ taskId: "T1", section: "doing" }, { taskId: "T2", section: "doing" }, { taskId: "T3", section: "doing" },
    { taskId: "T4", section: "review" }, { taskId: "T5", section: "review" }]);
  const index = indexOf(tree({ tasks: ["T1", "T2", "T3", "T4", "T5"].map(id => dto({ id })), home: rows }));
  // T3, then T2, come to wait on the user: the first review row now follows T2, which the patch lists after it.
  const [three, two] = homeFixture([{ taskId: "T3", section: "review" }, { taskId: "T2", section: "review" }]);
  const next = applyIndexPatch(index, { ...serverPatch(index, []), home: { upsert: [{ row: index.home[3]!, after: "T2" },
    { row: three!, after: "T1" }, { row: two!, after: "T3" }], remove: [] } })!;
  expect(next.home.map(row => row.taskId)).toEqual(["T1", "T3", "T2", "T4", "T5"]);
  expect(applyIndexPatch(index, { ...serverPatch(index, []), home: { upsert: [{ row: three!, after: "T9" }], remove: [] } })).toBeNull();
});

test("a patch that does not follow the held index is not applied", () => {
  const index = base();
  fixtureReceipt(indexKey, index);
  expect(receivePatch(queryClient, { ...serverPatch(index, []), rev: index.rev + 2 })).toBeNull();
  expect(receivePatch(queryClient, { ...serverPatch(index, []), generation: "other" })).toBeNull();
  expect(queryClient.getQueryData(indexKey)).toBe(index);
  expect(receivePatch(queryClient, serverPatch(index, []))?.rev).toBe(index.rev + 1);
});

test("a patch reads again only what it made old, and each keeps what it shows while it is read", () => {
  const value = tree({ tasks: [dto(), dto({ id: "T2", path: "tasks/T2", title: "Two" })] });
  const index = indexOf(value);
  fixtureReceipt(indexKey, index);
  const window = { pages: [{ events: [], nextBefore: null }], pageParams: [null] };
  const timeline = (scope: string | null) => resources.timeline(index.root, scope, ["T1"], [], "from", "to").queryKey;
  const held = {
    view1: [resources.taskView(index.root, "T1").queryKey, viewsOf(value)[0]],
    view2: [resources.taskView(index.root, "T2").queryKey, viewsOf(value)[1]],
    history1: [resources.history(index.root, "T1").queryKey, window],
    history2: [resources.history(index.root, "T2").queryKey, { ...window }],
    search: [resources.taskSearch(index.root, "one", null).queryKey, { pages: [searchAnswer(["T1"])], pageParams: [null] }],
    page: [resources.finished(index.root, null).queryKey, { pages: [pageOf([])], pageParams: [null] }],
    timeline: [timeline(null), { pages: [{ rows: [], runs: [], belowRuns: {}, events: [], anchors: {}, placements: [], nextAfter: null, ...served0 }], pageParams: [null] }],
  } as const;
  const data = Object.fromEntries(Object.entries(held).map(([name, [key, value]]) => [name, fixtureReceipt(key, value)]));
  receivePatch(queryClient, raise(index, { view: ["T2"], history: ["T1"], search: ["root"], page: ["finished:root"], timeline: ["root"] }));
  const old = (name: keyof typeof held) => queryClient.getQueryState(held[name][0])?.isInvalidated;
  expect([old("view1"), old("view2"), old("history1"), old("history2"), old("search"), old("page"), old("timeline")])
    .toEqual([false, true, true, false, true, true, true]);
  for (const name of Object.keys(held) as (keyof typeof held)[]) expect(queryClient.getQueryData(held[name][0])).toBe(data[name]);
  // A patch that raises nothing they read leaves them all as they were.
  queryClient.clear();
  fixtureReceipt(indexKey, index);
  for (const [key, value] of Object.values(held)) fixtureReceipt(key, value);
  receivePatch(queryClient, raise(index, { view: ["T9"], history: ["T9"], search: ["P999"], page: ["finished:T9"], timeline: ["P999"] }));
  for (const name of Object.keys(held) as (keyof typeof held)[]) expect(old(name)).toBe(false);
});

test("reopening a detail uses its cached response until its required version rises", async () => {
  const value = tree();
  const index = indexOf(value);
  fixtureReceipt(indexKey, index);
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => jsonAnswer(viewsOf(value)[0]));
  const options = resources.taskView(value.root, "T1");
  await queryClient.fetchQuery(options);
  await queryClient.fetchQuery(options);
  expect(fetcher).toHaveBeenCalledTimes(1);
  receivePatch(queryClient, serverPatch(index, [{ ...index.tasks.find(row => row.id === "T1")!, hash: "b".repeat(64) }]));
  fetcher.mockImplementation(async () => jsonAnswer(viewsOf(value, 1)[0]));
  await queryClient.fetchQuery(options);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("a closed row removed by another writer cannot return from a held search or page", () => {
  const index = indexOf(tree({ tasks: [] }));
  fixtureReceipt(indexKey, index);
  const row = { ...searchAnswer(["T9"]).rows[0]!, state: "done" as const };
  const searchKey = resources.taskSearch(index.root, "T9", null).queryKey;
  const pageKey = resources.finished(index.root, null).queryKey;
  fixtureReceipt(searchKey, { pages: [{ ...searchAnswer(["T9"]), rows: [row] }], pageParams: [null] });
  fixtureReceipt(pageKey, { pages: [pageOf([row])], pageParams: [null] });
  // The project Task is a row of every index; T9 is a fact only from the held results.
  expect(serverReadFacts(queryClient)!.tasks.map((item) => item.id)).toEqual([PROJECT_TASK, "T9"]);
  receivePatch(queryClient, raise(index, { search: ["root"], page: ["finished:root"] }));
  expect(queryClient.getQueryData(pageKey)).toBeDefined();
  expect(serverReadFacts(queryClient)!.tasks.map((item) => item.id)).toEqual([PROJECT_TASK]);
  expect(assessRead(queryClient, queryClient.getQueryCache().find({ queryKey: pageKey, exact: true })!)).toMatchObject({ state: "obsolete", project: false });
});

test("an open finished page is read again when its version rises; a patch that does not raise it reads nothing", async () => {
  const index = base();
  fixtureReceipt(indexKey, index);
  let after = false;
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonAnswer({
    ...pageOf(searchAnswer(after ? ['T8', 'T7'] : ['T9']).rows.map(row => ({ ...row, state: 'done' as const }))), sourcePv: after ? 2 : 0 }));
  const observer = new InfiniteQueryObserver(queryClient, resources.finished(index.root, null));
  const stop = observer.subscribe(() => {});
  try {
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages[0]?.total).toBe(1));
    const same = receivePatch(queryClient, raise(index, { page: ['finished:T1'] }))!;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    after = true;
    receivePatch(queryClient, raise(same, { page: ['finished:root'] }));
    await vi.waitFor(() => expect(observer.getCurrentResult().data?.pages[0]?.total).toBe(2));
    expect(observer.getCurrentResult().data!.pages[0]!.rows.map(row => row.id)).toEqual(['T8', 'T7']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { stop(); observer.destroy(); }
});
