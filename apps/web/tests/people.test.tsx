import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { controlTreeSchema } from "@alpacawork/contract/control";
import { crewOf, indexPeople as indexRows } from "../src/domain/people";
import { stateSince } from "../src/domain/tasks";
import type { ControlTreeDTO } from "@alpacawork/contract/control";
import { indexOf, rowOf } from "./fixtures";

/** The canonical wire example, used as is. */
const tree = controlTreeSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../../tests/fixtures/contract-examples/tree.json"), "utf8")));
/** The people index of a whole tree, made from the index the server sends of it. */
const indexPeople = (value: ControlTreeDTO) => indexRows(indexOf(value));
const people = indexPeople(tree);

test("a run-only index update keeps untouched task crews and child rows", () => {
  const source = indexOf(tree);
  const first = indexRows(source);
  const next = indexRows({ ...source, rev: source.rev + 1,
    runs: [...source.runs, { ...source.runs[0]!, id: "R99" }] }, first);
  for (const [id, crew] of first.crews) expect(next.crews.get(id)).toBe(crew);
  for (const [id, children] of first.children) expect(next.children.get(id)).toBe(children);
  expect(next.runsByPlacement.get(source.runs[0]!.placementId)).not.toBe(first.runsByPlacement.get(source.runs[0]!.placementId));
  for (const [id, runs] of first.runsByPlacement) if (id !== source.runs[0]!.placementId)
    expect(next.runsByPlacement.get(id)).toBe(runs);
  const changed = indexRows({ ...source, placements: source.placements.map((placement, i) =>
    i === 0 ? { ...placement } : placement) }, next);
  if (source.placements[0]) expect(changed.crews.get(source.placements[0].taskId)).not.toBe(first.crews.get(source.placements[0].taskId));
});

test("the reader uses the backend's headRunId even when a newer Run is in the index", () => {
  const child = tree.placements.find((placement) => placement.id === "P2")!;
  const newer = { ...tree.runs.find((run) => run.id === "R2")!, id: "R9" as const };
  const index = indexPeople({ ...tree, runs: [...tree.runs, newer] });
  expect(index.placements.get(child.id)?.headRunId).toBe("R2");
});

test("task and placement indexes keep first key order and last duplicate values without dropping child rows", () => {
  const source = indexOf(tree);
  const task = { ...source.tasks[0]!, id: "T1", parentId: null };
  const child = { ...task, id: "T2", parentId: "T1" };
  const sibling = { ...task, id: "T3" };
  const duplicate = { ...task, parentId: "T2" };
  const placement = { ...source.placements[0]!, id: "P1", active: false };
  const other = { ...placement, id: "P2" };
  const last = { ...placement, taskId: "T2" };
  const input = { ...source, tasks: [task, child, sibling, duplicate], placements: [placement, other, last] };
  const first = indexRows(input), unchanged = indexRows(input, first);
  expect([...first.tasks.keys()]).toEqual(["T1", "T2", "T3"]);
  expect(first.tasks.get("T1")).toBe(duplicate);
  expect([...first.children.entries()]).toEqual([[null, [task, sibling]], ["T1", [child]], ["T2", [duplicate]]]);
  for (const [id, children] of first.children) expect(unchanged.children.get(id)).toBe(children);
  expect([...first.placements.keys()]).toEqual(["P1", "P2"]);
  expect(first.placements.get("P1")).toBe(last);
  expect(first.placements.get("P2")).toBe(other);
  expect(input.tasks).toEqual([task, child, sibling, duplicate]);
  expect(input.placements).toEqual([placement, other, last]);
  const empty = indexRows({ ...input, tasks: [], placements: [] }, first);
  expect([empty.tasks.size, empty.children.size, empty.placements.size]).toEqual([0, 0, 0]);
});

test("a task's crew is its responsible and members, never an ended placement", () => {
  const crew = crewOf("T1", people);
  expect(crew.responsible?.id).toBe("P1");
  expect(crew.members).toEqual([]);
});

test("a retitle or move after the wait keeps the row's time where the wait began (the backend's reading)", () => {
  const waiting = tree.tasks.find((task) => task.id === "T12")!;
  const edited = { ...waiting, log: [...waiting.log,
    { id: "L3", kind: "retitled" as const, at: "2026-09-29T00:06:00.000Z", title: null, description: null, actor: { kind: "human" as const }, fromState: null, toState: null },
    { id: "L4", kind: "moved" as const, at: "2026-09-29T00:07:00.000Z", title: null, description: null, actor: { kind: "human" as const }, fromState: null, toState: null }] };
  expect(stateSince(rowOf(edited))).toBe("2026-09-29T00:05:00.000Z");
});

test("Run indexes retain input order except placement request order and reuse unchanged lists", () => {
  const source = indexOf(tree), base = source.runs[0]!;
  const tenth = { ...base, id: "R10", taskId: "T1", placementId: "P1" };
  const second = { ...base, id: "R2", taskId: "T2", placementId: "P1" };
  const first = { ...base, id: "R1", taskId: "T1", placementId: "P2" };
  const input = { ...source, runs: [tenth, second, first] };
  const indexed = indexRows(input), unchanged = indexRows(input, indexed);
  expect([...indexed.runs.values()]).toEqual([tenth, second, first]);
  expect([...indexed.runsByTask.keys()]).toEqual(["T1", "T2"]);
  expect(indexed.runsByTask.get("T1")).toEqual([tenth, first]);
  expect(indexed.runsByPlacement.get("P1")).toEqual([second, tenth]);
  expect(indexed.runs.get("R10")).toBe(tenth);
  for (const [id, runs] of indexed.runsByTask) expect(unchanged.runsByTask.get(id)).toBe(runs);
  for (const [id, runs] of indexed.runsByPlacement) expect(unchanged.runsByPlacement.get(id)).toBe(runs);
  const empty = indexRows({ ...input, runs: [] }, indexed);
  expect([empty.runs.size, empty.runsByTask.size, empty.runsByPlacement.size]).toEqual([0, 0, 0]);
});

test("crews retain placement task order, active roles, member chronology and prior references", () => {
  const source = indexOf(tree), base = source.placements[0]!;
  const inactive = { ...base, id: "P0", taskId: "T2", active: false, responsible: true };
  const responsible = { ...base, id: "P1", taskId: "T1", active: true, responsible: true };
  const otherResponsible = { ...responsible, id: "P2" };
  const endedResponsible = { ...responsible, id: "P6", active: false };
  const endedMember = { ...endedResponsible, id: "P7", responsible: false };
  const later = { ...responsible, id: "P5", responsible: false, startedAt: "2026-09-30T01:00:00Z" };
  const earlier = { ...later, id: "P4", startedAt: "2026-09-30T00:00:00Z" };
  const sameTime = { ...earlier, id: "P3" };
  const input = { ...source, placements: [inactive, endedResponsible, endedMember, later, responsible, earlier, otherResponsible, sameTime] };
  const first = indexRows(input);
  expect([...first.crews.keys()]).toEqual(["T2", "T1"]);
  expect(first.crews.get("T2")).toEqual({ responsible: null, members: [] });
  expect(first.crews.get("T1")).toEqual({ responsible, members: [sameTime, earlier, later] });
  expect([...first.placements.values()]).toEqual(input.placements);
  const reordered = indexRows({ ...input,
    placements: [{ ...inactive }, responsible, sameTime, later, earlier, otherResponsible] }, first);
  for (const [id, crew] of first.crews) expect(reordered.crews.get(id)).toBe(crew);
  const ended = indexRows({ ...input, placements: input.placements.map(p => ({ ...p, active: false })) }, first);
  expect(ended.crews.get("T1")).toEqual({ responsible: null, members: [] });
  expect(ended.crews.get("T1")).not.toBe(first.crews.get("T1"));
  expect(ended.crews.get("T2")).toBe(first.crews.get("T2"));
  expect(first.crews.get("T1")).toEqual({ responsible, members: [sameTime, earlier, later] });
  const empty = indexRows({ ...input, placements: [] }, ended);
  expect(empty.crews.size).toBe(0);
  expect(empty.placements.size).toBe(0);
});
