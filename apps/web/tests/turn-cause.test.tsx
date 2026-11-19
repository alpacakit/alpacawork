import { cleanup, render } from "@testing-library/react";
import { beforeAll, expect, test } from "vitest";
import { i18n, startI18n } from "@alpacawork/i18n";
import type { ControlRunDTO } from "@alpacawork/contract/control";
import { failureCause, titleTurn, reasonedTurn } from "../src/domain/lead";
import { BriefLine } from "../src/features/reader/BriefLine";
import { TurnReason } from "../src/features/reader/TurnReason";
import { at, logEntry, run, screenData, taskFixture, TestWorkspace, tree, userBall } from "./fixtures";

beforeAll(() => startI18n());

const placement = { id: "P1", taskId: "T1", agentId: "A-P1", profileKey: "codex", responsible: true, active: true, revision: 1,
  startedAt: at, endedAt: null, headRunId: "R2",
  runtime: { displayState: "attention" as const, reason: "exit" as const, sourceRunIds: [], runningCount: 0, queuedCount: 0, since: null,
    lastOutputAt: null, activityKind: null, toolName: null } };
/** The error record a Run's end links on its Task (task-transition's link): it names the Run whose end failed it. */
const failedBy = (runId: string, extra: ReturnType<typeof logEntry>[] = []) => [logEntry({ id: "L1", userRequested: true }),
  logEntry({ id: `LEND${runId}`, kind: "linked", at: "2026-09-24T09:05:00Z", fromState: "doing", toState: "error", runId }), ...extra];
/** A user's Task failed by its owner's Run, as the index lists it with its Runs. */
function failedTask(runs: ControlRunDTO[], log = failedBy(runs.at(-1)!.id)) {
  const data = screenData(tree({ tasks: [taskFixture({ id: "T1", userRequested: true, state: "error", ball: userBall("failed", `LEND${runs.at(-1)!.id}`, at), log })],
    placements: [placement], runs }));
  return { data, task: data.tasks.find(each => each.id === "T1")! };
}
const failedRun = (id: string, overrides: Partial<ControlRunDTO> = {}) =>
  run(id, { state: "failed", reason: "exit", endedAt: "2026-09-24T09:04:00Z", ...overrides });

test("a failure the backend read a cause for says that cause where the failure is answered, its Retry and Stop kept", () => {
  for (const [cause, key] of [["model_capacity", "ui:run.cause.modelCapacity"], ["weekly_limit", "ui:run.cause.weeklyLimit"]] as const) {
    const { data, task } = failedTask([failedRun("R2", { errorCause: cause })]);
    expect(failureCause(task, data.people)).toBe(cause);
    const head = render(<TestWorkspace data={data}><TurnReason turn={reasonedTurn(task.ball)!} task={task} cause={failureCause(task, data.people)} /></TestWorkspace>);
    const reason = head.container.querySelector<HTMLElement>('[data-turn-reason="failed"]')!;
    expect(reason.dataset.turnCause).toBe(cause);
    expect(reason.firstChild?.textContent).toBe(i18n.t(key));
    expect(i18n.t(key)).not.toBe(i18n.t("ui:turn.reason.failed"));
    expect([...reason.querySelectorAll<HTMLElement>("[data-turn-action]")].map(button => button.dataset.turnAction)).toEqual(["retry", "stop"]);
    cleanup();
    // The list's brief of the same task says the same.
    const brief = render(<TestWorkspace data={data}><BriefLine task={task} people={data.people} /></TestWorkspace>);
    expect(brief.container.querySelector('[data-turn-reason="failed"]')?.textContent).toBe(i18n.t(key));
    cleanup();
  }
});

test("a failure without a known cause, or a cause of another failure, keeps the general words", () => {
  const cases: [string, ControlRunDTO[], ReturnType<typeof logEntry>[] | undefined][] = [
    // The backend read no known cause (unknown words, no log, a stop or a time limit): no errorCause.
    ["unknown", [failedRun("R2")], undefined],
    // An older failure resolved by a later start in its conversation: its cause is not this failure's.
    ["resolved", [failedRun("R1", { errorCause: "model_capacity" }), failedRun("R2", { resumes: "R1", createdAt: "2026-09-24T09:01:00Z" })], undefined],
    // The Task failed by an end with no report: an earlier failure in another conversation is not why.
    ["no report", [failedRun("R1", { errorCause: "weekly_limit" }), run("R2", { createdAt: "2026-09-24T09:01:00Z" })], undefined],
    // A hold's return names no Run; the failure it restores is still R2's, which has no cause.
    ["held return", [failedRun("R1", { errorCause: "weekly_limit" }), failedRun("R2", { createdAt: "2026-09-24T09:01:00Z" })],
      failedBy("R2", [logEntry({ id: "Lh", kind: "reported", at: "2026-09-24T09:06:00Z", fromState: "error", toState: "held" }),
        logEntry({ id: "Lr", kind: "reported", at: "2026-09-24T09:07:00Z", fromState: "held", toState: "error" })])],
  ];
  for (const [name, runs, log] of cases) {
    const { data, task } = failedTask(runs, log);
    expect(failureCause(task, data.people), name).toBeNull();
    const head = render(<TestWorkspace data={data}><TurnReason turn={reasonedTurn(task.ball)!} task={task} cause={failureCause(task, data.people)} /></TestWorkspace>);
    const reason = head.container.querySelector<HTMLElement>('[data-turn-reason="failed"]')!;
    expect(reason.dataset.turnCause, name).toBeUndefined();
    expect(reason.firstChild?.textContent, name).toBe(i18n.t("ui:turn.reason.failed"));
    cleanup();
  }
});

test("a turn that is not a failure never says a failure's cause", () => {
  const capacity = failedRun("R2", { errorCause: "model_capacity" });
  for (const ball of [userBall("limit", "K1", at, { count: 2 }), userBall("unconfirmed", "U1", at), { holder: "owner" as const }]) {
    const data = screenData(tree({ tasks: [taskFixture({ id: "T1", userRequested: true, state: "doing", ball, log: failedBy("R2") })],
      placements: [placement], runs: [capacity] }));
    const task = data.tasks.find(each => each.id === "T1")!;
    expect(failureCause(task, data.people)).toBeNull();
    const brief = render(<TestWorkspace data={data}><BriefLine task={task} people={data.people} /></TestWorkspace>);
    expect(brief.container.textContent).not.toContain(i18n.t("ui:run.cause.modelCapacity"));
    cleanup();
  }
});

test("a failed task whose user's turn is a question still says its failure with Retry and Stop under the title", () => {
  const capacity = failedRun("R2", { errorCause: "model_capacity" });
  /** The server's ball: the question is the user's; it carries the failure only when the user decides it, and only while failed. */
  const asked = (failure: boolean) => userBall("question", "Q1", "2026-09-24T08:00:00Z",
    { questionId: "Q1", failure: failure ? { at: "2026-09-24T09:05:00Z", key: "LENDR2" } : null });
  const failedAsking = (actor: "user" | "parent", state: "error" | "doing" = "error") => screenData(tree({
    tasks: [taskFixture({ id: "T1", userRequested: actor === "user", state, ball: asked(actor === "user" && state === "error"), log: failedBy("R2") })],
    placements: [placement], runs: [capacity] }));
  const data = failedAsking("user");
  const task = data.tasks.find(each => each.id === "T1")!;
  // The ball stays the question; the reader's turn is the failure that put the Task in error.
  expect(reasonedTurn(task.ball)).toBeNull();
  expect(titleTurn(task)).toMatchObject({ holder: "user", reason: "failed", key: "LENDR2", at: "2026-09-24T09:05:00Z", questionId: null });
  expect(failureCause(task, data.people)).toBe("model_capacity");
  const head = render(<TestWorkspace data={data}><TurnReason turn={titleTurn(task)!} task={task} cause={failureCause(task, data.people)} /></TestWorkspace>);
  const reason = head.container.querySelector<HTMLElement>('[data-turn-reason="failed"]')!;
  expect(reason.firstChild?.textContent).toBe(i18n.t("ui:run.cause.modelCapacity"));
  expect([...reason.querySelectorAll<HTMLElement>("[data-turn-action]")].map(button => button.dataset.turnAction)).toEqual(["retry", "stop"]);
  cleanup();
  // The list's brief still says the question; a question on a task that is not failed says no failure.
  const brief = render(<TestWorkspace data={data}><BriefLine task={task} people={data.people} /></TestWorkspace>);
  expect(brief.container.querySelector('[data-turn-reason]')).toBeNull();
  cleanup();
  expect(titleTurn(failedAsking("user", "doing").tasks.find(each => each.id === "T1")!)).toBeNull();
  // A failure the parent decides is never offered to the user, though the user's question is open.
  const parents = failedAsking("parent");
  expect(titleTurn(parents.tasks.find(each => each.id === "T1")!)).toBeNull();
  expect(failureCause(parents.tasks.find(each => each.id === "T1")!, parents.people)).toBeNull();
});
