import { expect, test } from "vitest";
import type { Ball } from "@alpacawork/contract";
import { indexTasks, descendants, pathTo, childProgress, stateChoices, taskAtAddress, stateSince, withinProject, withinProjectFilter } from "../src/domain/tasks";
import { decideOf, isOther, isOtherAnswer, isStop, offeredChoices } from "../src/domain/questions";
import { stateLook } from "../src/components/ui/tone";
import { formatClock, formatLogTime } from "../src/domain/time";
import { at, dto, logEntry, project, rowOf, screenData, taskFixture, tree, userBall } from "./fixtures";

test("the current state begins at its transition, not a later body edit", () => {
  const task = rowOf(dto({ state: "waiting", log: [
    logEntry({ toState: "waiting", at: "2026-09-24T09:00:00Z" }),
    logEntry({ id: "L2", kind: "body_updated", at: "2026-09-24T10:00:00Z" }),
  ] }));
  expect(stateSince(task)).toBe("2026-09-24T09:00:00Z");
  expect(stateSince({ ...task, state: "doing" })).toBeNull();
});

test("a wait restored from a hold began with the report it paused", () => {
  const task = rowOf(dto({ state: "waiting", log: [
    logEntry({ kind: "reported", toState: "waiting", at: "2026-09-24T09:00:00Z" }),
    logEntry({ id: "L2", kind: "reported", toState: "held", at: "2026-09-24T10:00:00Z" }),
    logEntry({ id: "L3", kind: "reported", toState: "waiting", at: "2026-09-24T11:00:00Z" }),
  ] }));
  expect(stateSince(task)).toBe("2026-09-24T09:00:00Z");
  expect(stateSince({ ...task, state: "held", stateLog: task.stateLog.slice(0, 2) })).toBe("2026-09-24T10:00:00Z");
});

test("a URL names a Task by its flat ID; its folder names none", () => {
  const index = indexTasks(screenData(tree({ tasks: [
    dto({ id: "T1" }),
    dto({ id: "T11", parentId: "T1", path: "tasks/T11" }),
    dto({ id: "T111", parentId: "T11", path: "tasks/T111" }),
  ] })).tasks);
  const task = index.byId.get("T111")!;
  expect(taskAtAddress("T111", index)).toBe(task);
  expect(taskAtAddress("tasks/T111", index)).toBeUndefined();
  expect(taskAtAddress("T112", index)).toBeUndefined();
});

test("all roots sort numerically and paths cross only their ancestors", () => {
  const index = indexTasks(screenData(tree({ tasks: [
    dto({ id: "T10" }), dto({ id: "T2" }), dto(),
    dto({ id: "T110", parentId: "T1", state: "waiting" }),
    dto({ id: "T12", parentId: "T1", state: "done" }),
    dto({ id: "T11", parentId: "T1", state: "todo" }),
    dto({ id: "T121", parentId: "T12", state: "done" }),
  ] })).tasks);
  expect(index.roots.map((task) => task.id)).toEqual(["T1", "T2", "T10"]);
  expect(descendants("T1", index).map((task) => task.id)).toEqual(["T11", "T12", "T121", "T110"]);
  expect(pathTo("T121", index).map((task) => task.id)).toEqual(["T1", "T12", "T121"]);
});

test("a card's progress is the server's count of its children, never counted again from the children on screen", () => {
  const tasks = screenData(tree({ tasks: [
    dto(), dto({ id: "T11", parentId: "T1", state: "done" }),
    dto({ id: "T12", parentId: "T1", state: "stopped" }),
    dto({ id: "T13", parentId: "T1", state: "doing" }),
  ] })).tasks;
  const states = { todo: 0, doing: 4, error: 0, waiting: 0, held: 0, done: 2, stopped: 1 };
  // Stopped children are not in the total: done 2 of the 4 live and 2 done.
  expect(childProgress("T1", indexTasks(tasks, { T1: { live: 4, finished: 3, states, runningBelow: 0, below: 7 } }))).toEqual({ done: 2, total: 6 });
  // A task the projection lists no children of has none, whatever rows the screen holds.
  expect(childProgress("T1", indexTasks(tasks, {}))).toEqual({ done: 0, total: 0 });
  expect(childProgress("T1", indexTasks(tasks))).toEqual({ done: 0, total: 0 });
});

test("a task is in a project's part of the list by the project its row names, nested projects included", () => {
  const data = screenData(tree({ tasks: [dto({ id: "T1" }), project({ id: "P200", parentId: "P100", title: "nested" }),
    taskFixture({ id: "T5", parentId: "P200", projectId: "P200" })] }));
  const index = { byId: indexTasks(data.tasks).byId, projects: data.info.projects };
  expect(withinProject("T5", "P200", index)).toBe(true);
  expect(withinProject("T5", "P100", index)).toBe(true);
  expect(withinProject("T1", "P200", index)).toBe(false);
  expect(withinProject("T1", null, index)).toBe(true);
});

test("a list filter preserves project membership for shared projects and missing rows", () => {
  const index = { byId: new Map([
    ["T1", { projectId: "P200" }], ["T2", { projectId: "P200" }],
    ["T3", { projectId: "P300" }], ["T4", { projectId: "P300" }],
    ["T5", { projectId: "P400" }],
  ]), projects: [{ id: "P200", parentId: "P100" }, { id: "P300", parentId: null }] };
  const ids = ["T3", "T1", "missing", "T2", "T4", "T5"];
  for (const project of [null, "P100", "P200", "P300", "P400", "missing"]) {
    const includes = withinProjectFilter(project, index);
    expect(ids.filter(includes)).toEqual(ids.filter(id => withinProject(id, project, index)));
  }
});

/**
 * What the state form offers for a task as the server sends it (its state, its ball and the records that set its state):
 * the only list the form reads. Review OK while it awaits review (held too), Hold when the contract says it may be held,
 * Restore while held, Stop while unfinished.
 */
test("the state form offers what the user may ask the coordinator for, by the contract's review and hold rules", () => {
  const reported = logEntry({ id: "L2", kind: "reported", fromState: "doing", toState: "waiting" });
  const choices = (state: ReturnType<typeof dto>["state"], ball: Ball | null, log = [logEntry(), reported]) =>
    stateChoices(screenData(tree({ tasks: [taskFixture({ state, baseState: state === "held" && ball?.holder === "user" && ball.reason === "review" ? "waiting" : state === "held" ? "doing" : state, ball, log })] })).tasks[0]!);
  const review = userBall("review", "L2", at, { aboutRunId: "R1" });
  const question = userBall("question", "Q1", at, { questionId: "Q1" });
  expect(choices("waiting", review)).toEqual(["approve", "hold", "stop"]);
  // Held from its review: still awaiting it, and held.
  const heldReview = [logEntry(), reported, logEntry({ id: "L3", kind: "reported", fromState: "waiting", toState: "held" })];
  expect(choices("held", review, heldReview)).toEqual(["approve", "unhold", "stop"]);
  expect(choices("doing", question, [logEntry()])).toEqual(["hold", "stop"]);
  const heldQuestion = [logEntry(), logEntry({ id: "L3", kind: "reported", fromState: "doing", toState: "held" })];
  expect(choices("held", question, heldQuestion)).toEqual(["unhold", "stop"]);
  // Holding is independent of whose turn the task carries.
  expect(choices("doing", null, [logEntry()])).toEqual(["hold", "stop"]);
  expect(choices("doing", { holder: "parent", reason: "question" }, [logEntry()])).toEqual(["hold", "stop"]);
  expect(choices("todo", null, [logEntry()])).toEqual(["hold", "stop"]);
  expect(choices("done", null)).toEqual(["hold"]);
  expect(choices("stopped", null)).toEqual(["hold"]);
});

test("a state's look takes the question icon and your turn's colour from the ball; a wait is only ever a review", () => {
  const question = userBall("question", "Q1", at, { questionId: "Q1" });
  expect(stateLook("doing", question)).toEqual({ tone: "turn", icon: "question" });
  expect(stateLook("waiting", userBall("review", "L2", at, { aboutRunId: "R1" }))).toEqual({ tone: "turn", icon: "review" });
  expect(stateLook("doing", userBall("limit", "K1", at, { count: 2 }))).toEqual({ tone: "turn", icon: "doing" });
  // A wait that is not yours is a review all the same, said quietly; a held turn is set aside in grey.
  expect(stateLook("waiting", null)).toEqual({ tone: "quiet", icon: "review" });
  expect(stateLook("error", question)).toEqual({ tone: "error", icon: "error" });
  expect(stateLook("error", userBall("failed", "F1", at))).toEqual({ tone: "error", icon: "error" });
  expect(stateLook("held", question)).toEqual({ tone: "quiet", icon: "held" });
  // A question asked of the parent is not yours.
  expect(stateLook("doing", { holder: "parent", reason: "question" })).toEqual({ tone: "working", icon: "doing" });
});

test("a question's choices are its fixed items as written: numbered in order, answered by the first word of the name, with the recommendation, the note and what stopping means", () => {
  const decide = decideOf([
    { decide_question: "Presentation", decide_choices: [
      { decide_choice: "Option1 Keep", decide_choice_detail: "Description", decide_choice_recommended: "Reason" },
      { decide_choice: "Option2 Finish → Done" }],
    decide_note: "Shared conditions\nFinal guidance", decide_stop: "Nothing is kept" },
    { decide_question: "Anything else" }]);
  expect(decide).toEqual([
    { n: "1", ask: "Presentation", stop: "Nothing is kept", note: "Shared conditions\nFinal guidance", choices: [
      { name: "Option1 Keep", answer: "1-Option1", text: "Description", recommended: "Reason" },
      // Whatever a name says is the name: nothing in it is read as a mark.
      { name: "Option2 Finish → Done", answer: "1-Option2", text: "", recommended: null }] },
    { n: "2", ask: "Anything else", stop: null, note: "", choices: [] }]);
});

test("a question offers its choices, Stop only when it says what stopping means, and always Other, each answered by the app's own word", () => {
  const [first, second] = decideOf([
    { decide_question: "Presentation", decide_choices: [{ decide_choice: "Option1 Keep" }], decide_stop: "Nothing is kept" },
    { decide_question: "Anything else" }]);
  const names = { stop: "中止", other: "それ以外" };
  const offered = offeredChoices(first!, names);
  // The screen's names are the reader's language; the answers are the same in every language.
  expect(offered.map((choice) => [choice.name, choice.answer, choice.text])).toEqual([
    ["Option1 Keep", "1-Option1", ""], ["中止", "1-stop", "Nothing is kept"], ["それ以外", "1-other", ""]]);
  expect(offered.map((choice) => [isStop(first!, choice), isOther(first!, choice)])).toEqual([[false, false], [true, false], [false, true]]);
  // A question that does not say what stopping means offers no Stop; with no choices it is still answered by Other.
  expect(offeredChoices(second!, names).map((choice) => choice.answer)).toEqual(["2-other"]);
  // An answer is Stop or Other by its word under its own question's number.
  expect([isOtherAnswer({ n: "2", answer: "2-other" }), isOtherAnswer({ n: "1", answer: "2-other" }), isOtherAnswer({ n: "2", answer: "2-それ以外" })]).toEqual([true, false, false]);
});

test("clock and log times use local time and unknown timestamps stay empty", () => {
  const time = new Date(2026, 8, 25, 14, 12).toISOString();
  expect(formatClock(time)).toBe("14:12");
  expect(formatLogTime(time)).toBe("09/25 14:12");
  expect(formatClock("unknown")).toBe("");
  expect(formatLogTime("unknown")).toBe("");
});
