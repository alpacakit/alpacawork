import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup,  fireEvent,  screen } from "@testing-library/react";
import { beforeAll, beforeEach, afterEach, vi } from "vitest";
import { startI18n, i18n } from "@alpacawork/i18n";
import { controlTreeSchema, type ControlTaskDTO } from "@alpacawork/contract/control";
import { useProbe } from "../src/features/tree/time-line";
import { useTimeView } from "../src/state/time-view";
import { useViewStore } from "../src/state/view-store";
import { queryClient } from "../src/data/query-client";
import { dto, homeFixture, logEntry, recordHistory, run, screenData, serveTimeline, taskFixture, tree, userBall } from "./fixtures";

export const canonical = controlTreeSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname,
  "../../../tests/fixtures/contract-examples/tree.json"), "utf8")));

export const minute = 60_000;

export const iso = (at: number) => new Date(at).toISOString();

// Keep T2's 40-minute estimate on the same day, while T6's one-day estimate is tomorrow.
export const now = Date.parse("2026-10-11T12:00:00+09:00");

/** A task's creation; `userRequested`: the user asked for it. */
export const created = (at: number, userRequested = false) =>
  logEntry({ id: "L1", kind: "created", at: iso(at), toState: "todo", userRequested });

export const report = (id: string, at: number, state: ControlTaskDTO["state"], estimateMinutes?: number) =>
  logEntry({ id, kind: "reported", at: iso(at), title: state === "waiting" ? "Please review" : "Reported the work",
    actor: { kind: "placement", placementId: "P1" }, fromState: "doing", toState: state,
    ...(estimateMinutes === undefined ? {} : { estimateMinutes }) });

/** A question P1 asked the user: it keeps the task's state, and its ID is the question's. */
export const asked = (id: string, at: number) =>
  logEntry({ id, kind: "asked", askedTo: null, at: iso(at), title: "Please decide", description: "Which one?",
    actor: { kind: "placement", placementId: "P1" } });

/**
 * The work the user asked for: T1 and its child T11 waiting on the user's review, T2, T3, T4 and T6 at work, T5 finished.
 * `parentResponsible`: an idle responsible on T1, who takes T11's review in: T11 is then no request of the user's,
 * waits on nobody's turn and is not listed.
 */
export function fixture({ parentResponsible = false } = {}) {
  const tasks = [
    taskFixture({ id: "T1", title: "Parent", userRequested: true, state: "waiting",
      log: [created(now - 90 * minute, true), report("L2", now - 30 * minute, "waiting")],
      ball: userBall("review", "L2", iso(now - 30 * minute), { aboutRunId: "R1" }) }),
    taskFixture({ id: "T11", parentId: "T1", title: "Child", userRequested: !parentResponsible, state: "waiting",
      log: [created(now - 80 * minute, !parentResponsible), report("L2", now - 20 * minute, "waiting")],
      ball: parentResponsible ? null : userBall("review", "L2", iso(now - 20 * minute), { aboutRunId: "R1" }) }),
    dto({ id: "T2", title: "With estimate", userRequested: true, state: "doing",
      log: [created(now - 30 * minute, true), report("L2", now - 20 * minute, "doing", 60)] }),
    dto({ id: "T3", title: "Without estimate", userRequested: true, state: "doing", log: [created(now - 20 * minute, true)] }),
    dto({ id: "T4", title: "Overdue", userRequested: true, state: "doing",
      log: [created(now - 100 * minute, true), report("L2", now - 90 * minute, "doing", 30)] }),
    dto({ id: "T5", title: "Finished", userRequested: true, state: "done",
      log: [created(now - 80 * minute, true), report("L2", now - 10 * minute, "done")] }),
    dto({ id: "T6", title: "Tomorrow's estimate", userRequested: true, state: "doing",
      log: [created(now - 10 * minute, true), report("L2", now - 5 * minute, "doing", 24 * 60)] }),
  ];
  // As the server lists them: Working latest moved first (each Run started together, so by number), Your turn oldest turn
  // first; T1's progress is its live child.
  const home = homeFixture([
    ...["T2", "T3", "T4", "T6"].map((taskId) => ({ taskId, section: "doing" as const })),
    { taskId: "T1", section: "review", summary: { done: 0, total: 1 } },
    ...(parentResponsible ? [] : [{ taskId: "T11", section: "review" as const }]),
    { taskId: "T5", section: "done" },
  ]);
  const placements = ["T2", "T3", "T4", "T6"].map((taskId, index) => ({ ...canonical.placements[0]!, id: `P${index + 10}`, taskId,
    runtime: { ...canonical.placements[0]!.runtime, sourceRunIds: [`R${index + 10}`], since: iso(now - 20 * minute) } }));
  const runs = placements.map((placement, index) => run(`R${index + 10}`, { taskId: placement.taskId,
    placementId: placement.id, state: "running", createdAt: iso(now - 20 * minute), startedAt: iso(now - 20 * minute), endedAt: null }));
  const above = parentResponsible ? [{ ...canonical.placements[0]!, id: "P1", taskId: "T1", headRunId: "R1",
    runtime: { ...canonical.placements[0]!.runtime, displayState: "idle" as const, runningCount: 0, sourceRunIds: [], since: null } }] : [];
  const parentRun = parentResponsible ? [run("R1", { taskId: "T1", placementId: "P1", state: "succeeded",
    createdAt: iso(now - 45 * minute), startedAt: iso(now - 45 * minute), endedAt: iso(now - 30 * minute) })] : [];
  return served(tree({ tasks, home, placements: [...above, ...placements], runs: [...parentRun, ...runs] }));
}

/**
 * `value`'s screen data, with the time view's reads answered (serveTimeline): each task's notes are its log's records
 * (recordHistory), unless the test stated its History.
 */
export function served(value: ReturnType<typeof tree>) {
  const history = Object.fromEntries(value.tasks.map((task) => [task.id, value.history[task.id] ?? recordHistory(task.id, task.log)]));
  const stated = { ...value, history };
  serveTimeline(stated);
  return screenData(stated);
}

/** Opens the section; one this device left open stays so. */
export const openGroup = (group: "finished") => {
  const head = screen.getByRole("button", { name: new RegExp(`^${i18n.t(`tree:home.${group}`)}\\s*\\d`) });
  if (head.getAttribute("aria-expanded") !== "true") fireEvent.click(head);
};

/** Register the same isolated starting state in every suite that uses this fixture. */
export function setupTimeView() {
  beforeAll(() => startI18n());
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await i18n.changeLanguage("en");
    localStorage.clear();
    window.history.replaceState({}, "", "/");
    useViewStore.setState({ ...useViewStore.getInitialState() });
    useTimeView.setState({ strips: false, viewMs: null, picked: null });
  });
  afterEach(() => { cleanup(); useProbe.getState().set(null); queryClient.clear(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });
}
