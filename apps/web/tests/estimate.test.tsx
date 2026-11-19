import { expect, test } from "vitest";
import { estimateOf } from "../src/domain/estimate";
import { dto, logEntry, rowOf, run, tree } from "./fixtures";
import type { ControlTaskDTO, ControlTreeDTO } from "@alpacawork/contract/control";
import type { ControlRequestDTO, PlacementDTO } from "@alpacawork/contract/control";

const at = (minutes: number) => new Date(Date.UTC(2026, 8, 29, 0, minutes)).toISOString();
const event = (id: string, minutes: number, toState: "doing" | "waiting" | null, extra = {}) =>
  logEntry({ id, kind: "reported", at: at(minutes), title: id, actor: { kind: "human" },
    fromState: null, toState, ...extra });
const emptyPeople = tree();
/** The estimate of a task as its index row in `value` carries it. */
const estimateIn = (task: ControlTaskDTO, now: number, value: ControlTreeDTO) => estimateOf(rowOf(task, value), now);

test("no declaration keeps the existing card path", () => {
  expect(estimateIn(dto({ log: [event("L1", 0, "doing")] }), Date.parse(at(15)), emptyPeople)).toBeNull();
});

test("the last declared estimate follows log order and keeps repeated report identity", () => {
  const report = { ...event("L2", 0, null), estimateMinutes: 0 };
  const sentBack = { ...logEntry({ id: "L3", kind: "review_sent_back", at: at(2), actor: { kind: "human" } }),
    startsEstimateRound: true };
  const stateLog = [event("L1", 5, null, { estimateMinutes: 30 }), report, sentBack, report,
    event("L4", 3, null), { ...logEntry({ id: "L5", kind: "created", at: at(4) }), estimateMinutes: 60 }];
  expect(estimateOf({ stateLog }, Date.parse(at(10)))).toMatchObject({ minutes: 0, pending: true });
});

test("a declaration followed immediately by review wait uses no work time", () => {
  const task = dto({ state: "waiting", log: [
    event("L1", 0, "doing"), event("L2", 1, "waiting", { estimateMinutes: 30 }),
  ] });
  expect(estimateIn(task, Date.parse(at(51)), emptyPeople)).toMatchObject({
    remainingMinutes: 30, usedMinutes: 0,
  });
});

test("work time crosses the estimate and waiting time does not", () => {
  const task = dto({ state: "doing", log: [
    event("L1", 0, "doing", { estimateMinutes: 30 }),
    event("L2", 20, "waiting"), event("L3", 80, "doing"),
  ] });
  expect(estimateIn(task, Date.parse(at(98)), emptyPeople)).toMatchObject({
    remainingMinutes: -8, usedMinutes: 38,
  });
});

test("a new declaration replaces the estimate, and an instruction after it leaves it pending", () => {
  const task = dto({ state: "doing", log: [
    event("L1", 0, "doing", { estimateMinutes: 30 }),
    event("L2", 28, "waiting"),
    logEntry({ id: "L3", kind: "review_sent_back", at: at(70), title: "Redo", actor: { kind: "human" },
      fromState: "waiting", toState: "doing" }),
    event("L4", 72, null, { estimateMinutes: 20 }),
  ] });
  expect(estimateIn(task, Date.parse(at(77)), emptyPeople)).toMatchObject({
    minutes: 20, usedMinutes: 5, remainingMinutes: 15, pending: false,
  });
  const before = dto({ state: "doing", log: task.log.slice(0, 3) });
  expect(estimateIn(before, Date.parse(at(71)), emptyPeople)).toMatchObject({ pending: true });
});

const placement = (id: string, responsible: boolean): PlacementDTO => ({
  id, taskId: "T1", agentId: `A-${id}`, profileKey: "codex", responsible, active: true,
  revision: 1, startedAt: at(0), endedAt: null, headRunId: null,
  runtime: { displayState: "idle", reason: null, sourceRunIds: [], runningCount: 0,
    queuedCount: 0, since: null, lastOutputAt: null, activityKind: null, toolName: null },
});
const request = (id: string, placementId: string, recipientRole: "owner" | "worker"): ControlRequestDTO => ({
  id, taskId: "T1", placementId, runId: null, aboutRunId: null, purpose: "instruction",
  recipientRole,
  author: { kind: "placement", placementId: "P-owner" }, mode: "continue", body: "Work instruction",
  submittedAt: at(10), deliveryState: "waiting_for_run",
});

test("instructions to a member do not invalidate the responsible estimate", () => {
  const task = dto({ state: "doing", log: [
    event("L1", 0, "doing", { estimateMinutes: 30 }),
    logEntry({ id: "D-member", kind: "request_accepted", at: at(10), title: "Delegate planned work",
      actor: { kind: "placement", placementId: "P-owner" }, fromState: "doing", toState: null }),
  ] });
  const people = (tree({ tasks: [task], placements: [placement("P-owner", true), placement("P-member", false)],
    requests: [request("D-member", "P-member", "worker")] }));
  expect(estimateIn(task, Date.parse(at(12)), people)).toMatchObject({ pending: false, remainingMinutes: 18 });
  const revised = dto({ ...task, log: [...task.log, event("L3", 15, null, { estimateMinutes: 20 })] });
  expect(estimateIn(revised, Date.parse(at(16)), people)?.pending).toBe(false);
});

test("an instruction addressed to the responsible still requires a new estimate", () => {
  const task = dto({ state: "doing", log: [
    event("L1", 0, "doing", { estimateMinutes: 30 }),
    logEntry({ id: "D-owner", kind: "request_accepted", at: at(10), title: "Additional work",
      actor: { kind: "human" }, fromState: "doing", toState: null }),
  ] });
  const people = (tree({ tasks: [task], placements: [placement("P-owner", true), placement("P-member", false)],
    requests: [request("D-owner", "P-owner", "owner")] }));
  expect(estimateIn(task, Date.parse(at(12)), people)?.pending).toBe(true);
  const revised = dto({ ...task, log: [...task.log, event("L3", 15, null, { estimateMinutes: 20 })] });
  expect(estimateIn(revised, Date.parse(at(16)), people)?.pending).toBe(false);
});

test("promoting a member does not turn an earlier member request into an owner instruction", () => {
  const pendingTask = dto({ state: "doing", log: [
    event("L1", 0, "doing", { estimateMinutes: 30 }),
    logEntry({ id: "D-member", kind: "request_accepted", at: at(10), title: "Planned delegation",
      actor: { kind: "placement", placementId: "P-owner" }, fromState: "doing", toState: null }),
  ] });
  const incoming = { ...request("D-member", "P-member", "worker"), runId: "R2" };
  const acceptedRun = run("R2", { requestId: incoming.id, placementId: "P-member" });
  const before = (tree({ tasks: [pendingTask],
    placements: [placement("P-owner", true), placement("P-member", false)],
    requests: [incoming], runs: [acceptedRun] }));
  const endedOwner = { ...placement("P-owner", true), responsible: false, active: false,
    revision: 2, endedAt: at(25) };
  const after = (tree({ tasks: [pendingTask],
    placements: [endedOwner, { ...placement("P-member", false), responsible: true, revision: 2 }],
    requests: [incoming], runs: [acceptedRun] }));
  expect(estimateIn(pendingTask, Date.parse(at(12)), before)?.pending).toBe(false);
  expect(estimateIn(pendingTask, Date.parse(at(12)), after)?.pending).toBe(false);
  const revised = dto({ ...pendingTask, log: [...pendingTask.log,
    event("L3", 15, null, { estimateMinutes: 20, actor: { kind: "placement", placementId: "P-owner" } })] });
  expect(estimateIn(revised, Date.parse(at(16)), after)?.pending).toBe(false);
});
