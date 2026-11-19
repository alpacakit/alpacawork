import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { startI18n } from "@alpacawork/i18n";
import type { ControlTaskDTO, IndexPatchDTO, ProjectedIndexDTO, TaskHistoryDTO } from "@alpacawork/contract/control";
import { historyCursor } from "@alpacawork/contract";
import { ReportFeed } from "../src/features/reader/ReportFeed";
import { indexKey, receivePatch, resources } from "../src/data/resources";
import { queryClient } from "../src/data/query-client";
import { dto, indexOf, logEntry, screenData, TestWorkspace, tree } from "./fixtures";

beforeAll(() => startI18n());
/** A report of T1 as History's event of it. */
const event = (entry: ControlTaskDTO["log"][number]): TaskHistoryDTO["events"][number] => ({ id: entry.id, kind: "comment",
  taskId: "T1", fromChild: false, at: entry.at, state: entry.toState, by: entry.actor.kind === "placement" ? null : entry.actor.kind,
  title: entry.title ?? "", summary: entry.description ?? "" });
afterEach(() => { cleanup(); queryClient.clear(); vi.restoreAllMocks(); });
const keyed = { upsert: {}, remove: [] };
/** The list's patch saying T1's History changed at version `pv`. */
function historyChanged(pv: number) {
  const index = queryClient.getQueryData<ProjectedIndexDTO>(indexKey)!;
  receivePatch(queryClient, { rev: index.rev + 1, generation: index.generation, sourcePv: pv as never,
    tasks: { upsert: [], remove: [] }, placements: { upsert: [], remove: [] }, runs: { upsert: [], remove: [] }, home: { upsert: [], remove: [] },
    counts: { closed: keyed, home: keyed, tasks: keyed, children: keyed },
    requiredPv: { view: keyed, history: { upsert: { T1: pv as never }, remove: [] }, page: keyed, timeline: keyed, search: keyed }, meta: {} } satisfies IndexPatchDTO);
}

test("the real report consumer keeps its older row and renders updates from both sides of a pending read once", async () => {
  queryClient.clear();
  const value = tree({ tasks: [dto({ log: [logEntry({ id: "Lolder", kind: "reported", title: "Lolder" })] })] });
  const data = screenData(value), index = indexOf(value);
  const record = (id: string, minute: number) => event(logEntry({ id, kind: "reported", title: id,
    at: `2026-09-24T09:0${minute}:00Z` }));
  /** The window from version `pv`: the given records, newest first. */
  const page = (pv: number, ...events: TaskHistoryDTO["events"]) => ({ generation: "a", sourcePv: pv, events, hasOlder: false,
    oldestKey: historyCursor(events.at(-1)!) });
  const calls: ((response: Response) => void)[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(resolve => calls.push(resolve)));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const initial = queryClient.refetchQueries({ queryKey: resources.history(index.root, "T1").queryKey, exact: true });
  await waitFor(() => expect(calls).toHaveLength(1));
  await act(async () => calls.shift()!(new Response(JSON.stringify(page(0, record("Lolder", 0))))));
  await initial;
  const row = (id: string) => document.querySelector(`[data-report-key="log:T1:${id}"]`);
  await waitFor(() => expect(row("Lolder")).not.toBeNull()); const older = row("Lolder");
  // Two changes while the first read is out: one read at a time, the second follows the first's answer.
  act(() => historyChanged(1)); await waitFor(() => expect(calls).toHaveLength(1)); act(() => historyChanged(2));
  await act(async () => calls[0]!(new Response(JSON.stringify(page(1, record("Lfirst", 1), record("Lolder", 0))))));
  await waitFor(() => expect(calls).toHaveLength(2));
  await act(async () => calls[1]!(new Response(JSON.stringify(page(2, record("Lsecond", 2), record("Lfirst", 1), record("Lolder", 0))))));
  await waitFor(() => expect(row("Lsecond")).not.toBeNull());
  expect(row("Lfirst")).not.toBeNull(); expect(row("Lolder")).toBe(older);
  for (const id of ["Lolder", "Lfirst", "Lsecond"])
    expect(document.querySelectorAll(`[data-report-key="log:T1:${id}"]`)).toHaveLength(1);
});

test("the real report consumer uses the window's order for same-time mixed kinds and IDs, and for a late record", async () => {
  const at = "2026-10-20T11:39:51.452Z";
  const records: TaskHistoryDTO["events"] = [
    { id: "aB", kind: "request", taskId: "T1", fromChild: false, at, state: null, by: "main", title: "Do this", summary: "Full instruction" },
    { id: "Z", kind: "comment", taskId: "T1", fromChild: false, at, state: null, by: "human", title: "Keep comment", summary: "" },
    { id: "a_", kind: "answer", taskId: "T1", fromChild: false, at, state: null, by: "human", title: "Keep answer", summary: "" },
    { id: "Ab", kind: "comment", taskId: "T1", fromChild: false, at, state: null, by: "human", title: "Mixed case", summary: "" },
    { id: "aA", kind: "question", taskId: "T2", fromChild: true, at, state: null, by: null, title: "Child question", summary: "", open: true },
  ];
  const value = tree({ tasks: [dto(), dto({ id: "T2", parentId: "T1" })] });
  const data = screenData(value), index = indexOf(value);
  const key = resources.history(index.root, "T1").queryKey;
  vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
  render(<TestWorkspace data={data}><ReportFeed task={data.tasks[0]!} people={data.people} onFollow={() => {}} /></TestWorkspace>);
  const rows = () => [...document.querySelectorAll("[data-report-key]")].map(row => row.getAttribute("data-report-key"));
  const window = { events: records, nextBefore: null };
  act(() => queryClient.setQueryData(key, { pages: [window], pageParams: [null] }));
  await waitFor(() => expect(rows()).toEqual(["log:T2:aA", "log:T1:a_", "request:aB", "log:T1:Z", "log:T1:Ab"]));
  const late = { ...records[1]!, id: "aZ", title: "Late supplement" };
  act(() => queryClient.setQueryData(key, { pages: [{ ...window, events: [late, ...records] }], pageParams: [null] }));
  await waitFor(() => expect(rows()).toEqual(["log:T2:aA", "log:T1:a_", "log:T1:aZ", "request:aB", "log:T1:Z", "log:T1:Ab"]));
});
